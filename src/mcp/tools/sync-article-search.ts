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
import { buildSnapshotSearchFraming } from '../../presentation/article_report.js';
import type { ContextResolver } from '../context.js';
import { formatToolSuccess, withResolvedContext } from '../tool-errors.js';

export function registerSyncArticleSearchTool(
  server: McpServer,
  resolveContext: ContextResolver,
): void {
  server.tool(
    'sync_article_search',
    'Search articles exhaustively across the local workspace and .emit/cache.db snapshot (0-HTTP, supports keyword, tag, category, status, slug, and since/until date filters), or set live:true for keyword-only remote FTS (trigram index; queries < 3 chars may miss). Returns up to 20 hits by default with ULID, title, status, and local tracking state for targeted sync_pull(id: "..."). Omit "query" to browse recent articles. Guidance: if snapshotStatus is "missing" or "stale", explain coverage/freshness to the user and offer sync_snapshot(action: "capture") (or live:true for keyword-only queries). If hits is empty and absenceGuaranteed is false, do NOT assert the article does not exist.',
    {
      query: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Search keyword (matched on title, slug, excerpt, body). Omit to browse by recency (default mode only).',
        ),
      tag: z.string().optional().describe('Filter by tag slug (default mode only)'),
      category: z.string().optional().describe('Filter by category slug (default mode only)'),
      status: z
        .enum(['draft', 'published'])
        .optional()
        .describe('Filter by status: "draft" or "published" (default mode only)'),
      slug: z.string().optional().describe('Filter by article slug substring'),
      since: z
        .string()
        .optional()
        .describe(
          'Only articles created/published on or after this date: "today", "yesterday", or YYYY-MM-DD (local time; default mode only)',
        ),
      until: z
        .string()
        .optional()
        .describe(
          'Only articles created/published on or before this date (same formats as since; default mode only)',
        ),
      dateField: z
        .enum(['publishedAt', 'updatedAt', 'createdAt'])
        .optional()
        .describe(
          'Date field for comparison (default: publishedAt for published, createdAt for draft)',
        ),
      live: z
        .boolean()
        .optional()
        .describe(
          'Query remote EmDash FTS endpoint directly (keyword-only; rejects tag/category/date/status filters; trigram queries < 3 chars may miss)',
        ),
      limit: z.number().optional().describe('Max hits to return (default 20, max 50)'),
      includeConflicts: z
        .boolean()
        .optional()
        .describe('Include quarantined rescue copies from posts/conflicts/ in results'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) =>
      withResolvedContext(resolveContext, args, async (ctx) => {
        const isLive = Boolean(args.live);
        const result = await searchRemoteArticles({
          query: args.query,
          tag: args.tag,
          category: args.category,
          status: args.status,
          slug: args.slug,
          since: args.since,
          until: args.until,
          dateField: args.dateField,
          live: isLive,
          limit: args.limit,
          includeConflicts: Boolean(args.includeConflicts),
          workspaceRoot: ctx.root,
          origin: ctx.origin,
          token: ctx.auth.token,
          cache: ctx.cache,
        });

        const framing = buildSnapshotSearchFraming({
          snapshot: result.snapshot,
          hitCount: result.hits.length,
          totalCount: result.totalCount,
          truncated: result.truncated,
          walkComplete: result.walkComplete,
          isLive,
          query: args.query,
          kind: 'article',
          isMcp: true,
        });

        const payload: Record<string, unknown> = {
          query: args.query ?? null,
          searchMode: result.searchMode,
          scannedCount: result.scannedCount,
          walkComplete: result.walkComplete,
          totalCount: result.totalCount,
          truncated: result.truncated,
          hits: result.hits,
          ...framing,
        };
        if (result.snapshot) payload.snapshot = result.snapshot;
        if (typeof result.snapshotEnrichedCount === 'number') {
          payload.snapshotEnrichedCount = result.snapshotEnrichedCount;
        }
        if (args.since) payload.since = args.since;
        if (args.until) payload.until = args.until;
        if (args.tag) payload.tag = args.tag;
        if (args.category) payload.category = args.category;
        if (args.status) payload.status = args.status;

        return formatToolSuccess(payload, ctx.meta);
      }),
  );
}
