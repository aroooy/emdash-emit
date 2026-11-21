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
import { searchRemoteArticles } from '../../sync/article_search/index.js';
import { buildOfflineArticleSearchFraming } from '../../presentation/article_report.js';
import type { ContextResolver } from '../context.js';
import { formatToolSuccess, withResolvedContext } from '../tool-errors.js';

export function registerSyncArticleSearchTool(
  server: McpServer,
  resolveContext: ContextResolver,
): void {
  server.tool(
    'sync_article_search',
    'Search past articles on remote EmDash (or local workspace with offline:true) by keyword, date range (since/until: "today", "yesterday", YYYY-MM-DD), status (draft/published), slug, category, or tag. Returns up to 20 hits by default with their ULID, title, status, and local tracking state. Use this to locate past articles outside the 30-post sync window before running sync_pull(id: "..."). Omit "query" to browse recent articles. When offline:true is set, queries only local markdown files with zero HTTP requests. Absence is only proven when walkComplete is true.',
    {
      query: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Search keyword (matched on title, slug, excerpt, body). Omit to browse by recency.',
        ),
      tag: z
        .string()
        .optional()
        .describe('Filter by tag slug (requires taxonomy term lookup, maxScan defaults to 50)'),
      category: z
        .string()
        .optional()
        .describe(
          'Filter by category slug (requires taxonomy term lookup, maxScan defaults to 50)',
        ),
      status: z
        .enum(['draft', 'published'])
        .optional()
        .describe('Filter by status: "draft" or "published"'),
      slug: z.string().optional().describe('Filter by article slug substring'),
      since: z
        .string()
        .optional()
        .describe(
          'Only articles created/published on or after this date: "today", "yesterday", or YYYY-MM-DD (local time)',
        ),
      until: z
        .string()
        .optional()
        .describe('Only articles created/published on or before this date (same formats as since)'),
      dateField: z
        .enum(['publishedAt', 'updatedAt', 'createdAt'])
        .optional()
        .describe(
          'Date field for comparison (default: publishedAt for published, createdAt for draft)',
        ),
      offline: z
        .boolean()
        .optional()
        .describe(
          'Search only local Markdown files in posts/ — zero network requests. Results describe workspace only and never prove remote absence.',
        ),
      limit: z.number().optional().describe('Max hits to return (default 20, max 50)'),
      maxScan: z
        .number()
        .optional()
        .describe(
          'Articles to read before stopping (default 300, 50 with taxonomy filters; 0 = whole library)',
        ),
      includeConflicts: z
        .boolean()
        .optional()
        .describe('Include quarantined rescue copies from posts/conflicts/ in results'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) =>
      withResolvedContext(resolveContext, args, async (ctx) => {
        const result = await searchRemoteArticles({
          query: args.query,
          tag: args.tag,
          category: args.category,
          status: args.status,
          slug: args.slug,
          since: args.since,
          until: args.until,
          dateField: args.dateField,
          offline: Boolean(args.offline),
          limit: args.limit,
          maxScan: args.maxScan,
          includeConflicts: Boolean(args.includeConflicts),
          workspaceRoot: ctx.root,
          origin: ctx.origin,
          token: ctx.auth.token,
          cache: ctx.cache,
        });

        let note: string | undefined = undefined;
        if (!result.walkComplete && !args.offline) {
          note = `[WALK_INCOMPLETE] read ${result.scannedCount} article(s) and stopped at maxScan; absence is not proven. Narrow the query or raise maxScan (0 walks the whole library).`;
        }

        const payload: Record<string, unknown> = {
          query: args.query ?? null,
          searchMode: result.searchMode,
          scannedCount: result.scannedCount,
          walkComplete: result.walkComplete,
          totalCount: result.totalCount,
          truncated: result.truncated,
          hits: result.hits,
        };
        if (result.taxonomyFetchCount > 0) payload.taxonomyFetchCount = result.taxonomyFetchCount;
        if (result.fallbackReason) payload.fallbackReason = result.fallbackReason;
        if (args.since) payload.since = args.since;
        if (args.until) payload.until = args.until;
        if (args.tag) payload.tag = args.tag;
        if (args.category) payload.category = args.category;
        if (args.status) payload.status = args.status;
        if (args.offline) Object.assign(payload, buildOfflineArticleSearchFraming());
        if (note) payload.note = note;

        return formatToolSuccess(payload, ctx.meta);
      }),
  );
}
