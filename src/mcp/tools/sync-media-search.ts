/*
 * Copyright (C) 2026 SPORT-SERVICE RS★R
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  collectLocalMirrorIndex,
  searchLocalMirrorMedia,
  searchRemoteMedia,
} from '../../sync/media/index.js';
import { getLocalTaxonomiesSummary } from '../../sync/taxonomies.js';
import { buildOfflineSearchFraming } from '../../presentation/article_report.js';
import type { ContextResolver } from '../context.js';
import { formatToolSuccess, withResolvedContext } from '../tool-errors.js';
import { formatMediaSearchWalkIncompleteNotice } from '../../presentation/media_report.js';

export function registerSyncMediaSearchTool(
  server: McpServer,
  resolveContext: ContextResolver,
): void {
  server.tool(
    'sync_media_search',
    'Search the remote EmDash media library by keyword (filename, alt text, caption, storageKey, or local mirror stem) and report whether Emit already mirrors each hit. Omit "query" to browse the newest assets, optionally narrowed with since/until ("today", "yesterday", YYYY-MM-DD). Set "offline:true" to search only this workspace media mirrors with zero network requests — that result covers local files ONLY and never proves an asset is absent remotely. Returns up to 20 items plus walk coverage fields to conserve LLM context. Use "mirroredOnly:true" when only locally available assets matter. Absence is only proven when walkComplete is true — never conclude an asset does not exist from a truncated walk, and never propose inserting a media record.',
    {
      query: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Literal keyword (case-insensitive substring). Regex is not supported. Omit to browse by recency.',
        ),
      limit: z.number().optional().describe('Max hits to return (default 20, capped at 50)'),
      maxScan: z
        .number()
        .optional()
        .describe('Records to read before stopping the walk (default 500; 0 = whole library)'),
      mirroredOnly: z
        .boolean()
        .optional()
        .describe('Restrict output to assets already mirrored locally'),
      offline: z
        .boolean()
        .optional()
        .describe(
          'Search only local media mirrors (media_state + media/*.yaml) with zero HTTP requests. Results describe the workspace, not the remote library.',
        ),
      since: z
        .string()
        .optional()
        .describe(
          'Only assets created on or after this date: "today", "yesterday", or YYYY-MM-DD (local time)',
        ),
      until: z
        .string()
        .optional()
        .describe('Only assets created on or before this date (same formats as since)'),
      suggestKeywords: z
        .boolean()
        .optional()
        .describe('Append top local tag slugs as extra search hints'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) =>
      withResolvedContext(resolveContext, args, async (ctx) => {
        const mirrorIndex = collectLocalMirrorIndex(ctx.root, ctx.cache);
        const result = args.offline
          ? searchLocalMirrorMedia({
              query: args.query,
              since: args.since,
              until: args.until,
              limit: args.limit,
              mirrorIndex,
              cache: ctx.cache,
              mirroredOnly: Boolean(args.mirroredOnly),
            })
          : await searchRemoteMedia({
              workspaceRoot: ctx.root,
              origin: ctx.origin,
              token: ctx.auth.token,
              refreshToken: ctx.auth.refreshToken,
              query: args.query,
              since: args.since,
              until: args.until,
              limit: args.limit,
              maxScan: args.maxScan,
              mirroredOnly: Boolean(args.mirroredOnly),
              mirrorIndex,
            });

        const note =
          formatMediaSearchWalkIncompleteNotice(result, { isMcp: true, limit: args.limit }) ??
          undefined;

        let tagHints: string[] | undefined = undefined;
        if (args.suggestKeywords) {
          try {
            const tax = getLocalTaxonomiesSummary(ctx.root);
            if (tax.tags.length > 0) {
              tagHints = tax.tags.slice(0, 10).map((t) => t.slug);
            }
          } catch {
            // Taxonomy reading failure is non-fatal
          }
        }

        const payload: Record<string, unknown> = {
          query: args.query ?? null,
          scannedCount: result.scannedCount,
          walkComplete: result.walkComplete,
          totalCount: result.totalCount,
          truncated: result.truncated,
          hits: result.hits,
        };
        if (args.since) payload.since = args.since;
        if (args.until) payload.until = args.until;
        // Offline framing must be machine-readable too: an agent deciding whether to re-upload an asset
        // reads this payload, so a local-only list must never look like the library's truth.
        if (args.offline) Object.assign(payload, buildOfflineSearchFraming(result.snapshot));
        if (note) payload.note = note;
        if (tagHints) payload.tagHints = tagHints;

        return formatToolSuccess(payload, ctx.meta);
      }),
  );
}
