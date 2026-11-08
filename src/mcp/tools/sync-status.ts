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

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContextResolver, ServerContext } from '../context.js';
import {
  getWorkspaceStatus,
  filterStatusItems,
  type WorkspaceStatusResult,
} from '../../sync/status.js';
import { formatToolError } from '../tool-errors.js';

const MAX_ACTION_REQUIRED = 30;
const MAX_RECENT_SYNCED = 5;

export function registerSyncStatusTool(server: McpServer, resolveContext: ContextResolver): void {
  server.tool(
    'sync_status',
    'Inspect local workspace sync status with articles sorted newest-first. Returns a summary-first payload (concise summary, up to 30 action-required articles, and 5 recent synced articles) to conserve LLM context. Use "search" or "slugFilter" to find specific articles across the full workspace.',
    {
      collection: z
        .string()
        .optional()
        .describe('Collection name to inspect (defaults to "posts")'),
      search: z
        .string()
        .optional()
        .describe('Search query matching article title, slug, ID, or file path'),
      slugFilter: z.string().optional().describe('Filter articles by exact or partial slug'),
      status: z
        .enum(['draft', 'published'])
        .optional()
        .describe('Filter by article publication status (draft or published)'),
      syncStatus: z
        .enum(['synced', 'modified', 'untracked', 'invalid'])
        .optional()
        .describe('Filter by synchronization state'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) => {
      // Resolve context inside the guard too: workspace/profile resolution can throw
      // AmbiguousProfileError or "Not inside an Emit workspace", and agents need those
      // formatted the same way as every other tool failure.
      let ctx: ServerContext;
      try {
        ctx = resolveContext(args.profile);
      } catch (error) {
        return formatToolError(error);
      }
      const collection = args.collection || ctx.config.defaultCollection;
      let status: WorkspaceStatusResult;
      try {
        status = getWorkspaceStatus(ctx.root, ctx.cache, collection);
      } catch (error) {
        return formatToolError(error);
      }

      const isFiltered = Boolean(args.search || args.slugFilter || args.status || args.syncStatus);
      const filteredList = isFiltered
        ? filterStatusItems(status.items, {
            search: args.search,
            slugFilter: args.slugFilter,
            status: args.status,
            syncStatus: args.syncStatus,
          })
        : null;

      // Extract action-required items (modified, invalid, untracked)
      // Cap invalid items at 10 to prevent verbose error stack traces from blowing the token budget
      const MAX_INVALID_MCP_ITEMS = 10;
      let invalidSeen = 0;
      const cappedActionItems = status.items.filter((item) => {
        if (item.syncStatus === 'synced') return false;
        if (item.syncStatus === 'invalid') {
          invalidSeen++;
          return invalidSeen <= MAX_INVALID_MCP_ITEMS;
        }
        return true;
      });
      const invalidTruncated = Math.max(0, status.summary.invalid - MAX_INVALID_MCP_ITEMS);

      const actionRequired = cappedActionItems.slice(0, MAX_ACTION_REQUIRED);
      const rawActionRequiredCount = status.items.filter((i) => i.syncStatus !== 'synced').length;
      const actionRequiredTruncated =
        rawActionRequiredCount > MAX_ACTION_REQUIRED || invalidTruncated > 0;

      // Extract recent synced articles
      const allSynced = status.items.filter((item) => item.syncStatus === 'synced');
      const recentArticles = allSynced.slice(0, MAX_RECENT_SYNCED);
      const recentArticlesTruncated = allSynced.length > MAX_RECENT_SYNCED;

      const uncachedInvalid = status.items.filter(
        (item) => item.syncStatus === 'invalid' && item.cached === false,
      );
      const exampleUncachedId =
        uncachedInvalid.find((i) => i.id && i.id !== 'unknown')?.id || '<ULID>';

      const responsePayload = {
        summary: status.summary,
        actionRequired,
        actionRequiredTruncated,
        recentArticles,
        recentArticlesTruncated,
        total: status.summary.total,
        searchQuery: args.search || args.slugFilter || null,
        ...(isFiltered ? { filteredArticles: filteredList } : {}),
        // Fallback for callers expecting .items:
        items: isFiltered ? filteredList : [...actionRequired, ...recentArticles],
        ...(ctx.originWarning ? { warnings: [ctx.originWarning] } : {}),
        ...(invalidTruncated > 0
          ? {
              invalidTruncated,
              invalidNote: `...and ${invalidTruncated} more invalid frontmatter file(s) omitted to conserve context.`,
            }
          : {}),
        ...(actionRequiredTruncated && invalidTruncated === 0
          ? {
              actionRequiredNote: `...and ${rawActionRequiredCount - MAX_ACTION_REQUIRED} more action-required item(s) omitted. Use search or slugFilter to narrow down.`,
            }
          : {}),
        ...(status.summary.invalid > 0
          ? {
              repairHint:
                uncachedInvalid.length > 0
                  ? `Run sync_pull to automatically repair cached invalid frontmatter (local body is strictly preserved). For ${uncachedInvalid.length} uncached file(s) outside the sliding window, run sync_pull with id: "${exampleUncachedId}" (or "emit pull ${exampleUncachedId}" in CLI).`
                  : 'Run sync_pull (or "emit pull" in CLI) to automatically re-serialize and repair frontmatter syntax (local body is strictly preserved).',
            }
          : {}),
        ...(status.summary.conflicts > 0
          ? {
              conflictsNote: `${status.summary.conflicts} preserved local copy(ies) exist in ${collection}/conflicts/ because a pull found content that diverged from the last synced baseline. Review each copy, merge valuable content manually, then delete it. Preserved copies are never pushed or pruned automatically, and sync_push refuses a posts/conflicts/ path with QUARANTINED_COPY_NOT_PUSHABLE.`,
            }
          : {}),
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(responsePayload, null, 2),
          },
        ],
      };
    },
  );
}
