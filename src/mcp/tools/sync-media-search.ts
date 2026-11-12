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
import { collectLocalMirrorIndex, searchRemoteMedia } from '../../sync/media.js';
import { getLocalTaxonomiesSummary } from '../../sync/taxonomies.js';
import type { ContextResolver, ServerContext } from '../context.js';
import { formatToolError, formatToolSuccess } from '../tool-errors.js';

export function registerSyncMediaSearchTool(
  server: McpServer,
  resolveContext: ContextResolver,
): void {
  server.tool(
    'sync_media_search',
    'Search the remote EmDash media library by keyword (filename, alt text, caption, storageKey, or local mirror stem) and report whether Emit already mirrors each hit. Returns up to 20 items plus walk coverage fields to conserve LLM context. Use "mirroredOnly:true" when only locally available assets matter. Absence is only proven when walkComplete is true — never conclude an asset does not exist from a truncated walk, and never propose inserting a media record.',
    {
      query: z
        .string()
        .min(1)
        .describe('Literal keyword (case-insensitive substring). Regex is not supported.'),
      limit: z.number().optional().describe('Max hits to return (default 20, capped at 50)'),
      maxScan: z
        .number()
        .optional()
        .describe('Records to read before stopping the walk (default 500; 0 = whole library)'),
      mirroredOnly: z
        .boolean()
        .optional()
        .describe('Restrict output to assets already mirrored locally'),
      suggestKeywords: z
        .boolean()
        .optional()
        .describe('Append top local tag slugs as extra search hints'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) => {
      let ctx: ServerContext;
      try {
        ctx = resolveContext(args.profile);
      } catch (error) {
        return formatToolError(error);
      }

      try {
        const mirrorIndex = collectLocalMirrorIndex(ctx.root, ctx.cache);
        const result = await searchRemoteMedia({
          workspaceRoot: ctx.root,
          origin: ctx.origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
          query: args.query,
          limit: args.limit,
          maxScan: args.maxScan,
          mirroredOnly: Boolean(args.mirroredOnly),
          mirrorIndex,
        });

        let note: string | undefined = undefined;
        if (!result.walkComplete) {
          note = `[WALK_INCOMPLETE] read ${result.scannedCount} record(s) and stopped at maxScan; absence is not proven. Narrow the query or raise maxScan (0 walks the whole library).`;
        }

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
          query: args.query,
          scannedCount: result.scannedCount,
          walkComplete: result.walkComplete,
          totalCount: result.totalCount,
          truncated: result.truncated,
          hits: result.hits,
        };
        if (note) payload.note = note;
        if (tagHints) payload.tagHints = tagHints;

        return formatToolSuccess(payload, ctx.meta);
      } catch (err) {
        return formatToolError(err, ctx.meta);
      }
    },
  );
}
