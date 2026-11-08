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
import { listConflicts, diffConflict, resolveConflict } from '../../sync/conflicts.js';
import { formatToolError, formatToolSuccess } from '../tool-errors.js';

export function registerSyncConflictsTool(
  server: McpServer,
  resolveContext: ContextResolver,
): void {
  server.tool(
    'sync_conflicts',
    'Manage quarantined sync conflict copies (.conflict.md) and deletion rescue backups (.deleted.md) in posts/conflicts/. Actions: "list" (view quarantined files and types), "diff" (inspect line-by-line differences against canonical live article), and "resolve" (strategy "accept-local" to restore/replace canonical article, or "accept-canonical" to discard quarantined copy).',
    {
      action: z
        .enum(['list', 'diff', 'resolve'])
        .describe('Operation to perform: "list", "diff", or "resolve"'),
      filePath: z
        .string()
        .optional()
        .describe(
          'Target conflict file path or filename in posts/conflicts/ (required for diff and resolve)',
        ),
      strategy: z
        .enum(['accept-local', 'accept-canonical'])
        .optional()
        .describe(
          'Resolution strategy for action="resolve": "accept-local" (restore/apply quarantined copy) or "accept-canonical" (discard quarantined copy)',
        ),
      force: z
        .boolean()
        .optional()
        .describe('Force overwrite canonical article even if it has unpushed local modifications'),
      collection: z
        .string()
        .optional()
        .describe('Collection containing conflicts (defaults to "posts")'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) => {
      let ctx: ServerContext;
      try {
        ctx = resolveContext(args.profile);
      } catch (error) {
        return formatToolError(error);
      }

      const collection = args.collection || ctx.config.defaultCollection || 'posts';

      try {
        if (args.action === 'list') {
          const items = listConflicts(ctx.root, collection);
          return formatToolSuccess(
            {
              conflicts: items,
              count: items.length,
              collection,
            },
            ctx.meta,
          );
        }

        if (args.action === 'diff') {
          if (!args.filePath) {
            return formatToolError(
              new Error('action="diff" requires "filePath" parameter.'),
              ctx.meta,
            );
          }
          const diffResult = diffConflict({
            workspaceRoot: ctx.root,
            filePath: args.filePath,
            collection,
          });
          return formatToolSuccess(diffResult as unknown as Record<string, unknown>, ctx.meta);
        }

        if (args.action === 'resolve') {
          if (!args.filePath) {
            return formatToolError(
              new Error('action="resolve" requires "filePath" parameter.'),
              ctx.meta,
            );
          }
          if (!args.strategy) {
            return formatToolError(
              new Error(
                'action="resolve" requires "strategy" parameter ("accept-local" or "accept-canonical").',
              ),
              ctx.meta,
            );
          }

          const res = resolveConflict({
            workspaceRoot: ctx.root,
            cache: ctx.cache,
            filePath: args.filePath,
            strategy: args.strategy,
            force: args.force,
            collection,
          });
          return formatToolSuccess(res as unknown as Record<string, unknown>, ctx.meta);
        }

        return formatToolError(
          new Error(`Unknown action "${args.action}". Must be "list", "diff", or "resolve".`),
          ctx.meta,
        );
      } catch (err) {
        return formatToolError(err, ctx.meta);
      }
    },
  );
}
