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
import type { ContextResolver } from '../context.js';
import { getWorkspaceStatus, type WorkspaceStatusResult } from '../../sync/status.js';
import { formatToolError } from '../tool-errors.js';

const MAX_INVALID_MCP_ITEMS = 10;

export function registerSyncStatusTool(server: McpServer, resolveContext: ContextResolver): void {
  server.tool(
    'sync_status',
    'Inspect local workspace sync status. Returns all tracked articles sorted newest-first (descending by date), with relative file paths (e.g. posts/published/YYYYMMDD_<id>-<title>.md), publication status (draft/published), and modification state (synced/modified/untracked/invalid). ALWAYS use this tool first to locate local files instead of querying remote APIs.',
    {
      collection: z
        .string()
        .optional()
        .describe('Collection name to inspect (defaults to "posts")'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) => {
      const ctx = resolveContext(args.profile);
      const collection = args.collection || ctx.config.defaultCollection;
      let status: WorkspaceStatusResult;
      try {
        status = getWorkspaceStatus(ctx.root, ctx.cache, collection);
      } catch (error) {
        return formatToolError(error);
      }

      // Cap invalid items in MCP output to prevent context window flooding when many files are broken
      let invalidSeen = 0;
      const filteredItems = status.items.filter((item) => {
        if (item.syncStatus !== 'invalid') return true;
        invalidSeen++;
        return invalidSeen <= MAX_INVALID_MCP_ITEMS;
      });
      const invalidTruncated = Math.max(0, status.summary.invalid - MAX_INVALID_MCP_ITEMS);

      const uncachedInvalid = status.items.filter(
        (item) => item.syncStatus === 'invalid' && item.cached === false,
      );
      const exampleUncachedId =
        uncachedInvalid.find((i) => i.id && i.id !== 'unknown')?.id || '<ULID>';

      const responsePayload = {
        items: filteredItems,
        summary: status.summary,
        ...(ctx.originWarning ? { warnings: [ctx.originWarning] } : {}),
        ...(invalidTruncated > 0
          ? {
              invalidTruncated,
              invalidNote: `...and ${invalidTruncated} more invalid frontmatter file(s) omitted to conserve context.`,
            }
          : {}),
        ...(status.summary.invalid > 0
          ? {
              repairHint:
                uncachedInvalid.length > 0
                  ? `Run sync_pull to automatically repair cached invalid frontmatter files. For ${uncachedInvalid.length} uncached file(s) outside the sliding window, run sync_pull with id: "${exampleUncachedId}" (or "emit pull ${exampleUncachedId}" in CLI).`
                  : 'Run sync_pull (or "emit pull" in CLI) to automatically re-serialize and repair unquoted %-prefixed frontmatter files.',
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
