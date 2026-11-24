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
  captureWorkspaceSnapshot,
  clearWorkspaceSnapshot,
  getWorkspaceSnapshotStatus,
  pruneOrphanMediaCache,
} from '../../sync/snapshot/index.js';
import { formatMediaCacheSummary } from '../../presentation/media_report.js';
import type { ContextResolver } from '../context.js';
import { formatToolSuccess, withResolvedContext } from '../tool-errors.js';

export function registerSyncSnapshotTool(server: McpServer, resolveContext: ContextResolver): void {
  server.tool(
    'sync_snapshot',
    'Capture, inspect, clear, or prune-cache for the full-library metadata snapshot (articles, media, taxonomies) in cache.db. Enables exhaustive 0-HTTP search, 0-GET taxonomy filtering, and opt-in offline media caching (includeMedia: true).',
    {
      action: z
        .enum(['capture', 'status', 'clear', 'prune-cache'])
        .optional()
        .describe('Action to perform: "capture" (default), "status", "clear", or "prune-cache"'),
      collection: z.string().optional().describe('Target collection (defaults to "posts")'),
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Max concurrent remote fetches when capturing'),
      includeMedia: z
        .boolean()
        .optional()
        .describe(
          'Opt-in: also download media binaries into media/_cache/ for offline --from-snapshot restore (never mutates .emit/config.json)',
        ),
      mediaCacheLimit: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Max media binaries to cache per capture (default 200)'),
      mediaCacheMaxBytes: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Max bytes to cache per capture (default 536870912 / 512 MiB)'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) =>
      withResolvedContext(resolveContext, args, async (ctx) => {
        const action = args.action ?? 'capture';
        const collection = args.collection || ctx.config.defaultCollection;

        if (action === 'prune-cache') {
          const pruned = pruneOrphanMediaCache(ctx.cache, ctx.root);
          return formatToolSuccess({ action: 'prune-cache', ...pruned }, ctx.meta);
        }

        if (action === 'clear') {
          const cleared = clearWorkspaceSnapshot(ctx.cache, collection, ctx.root);
          return formatToolSuccess({ action: 'clear', ...cleared }, ctx.meta);
        }

        if (action === 'status') {
          const status = getWorkspaceSnapshotStatus(ctx.cache, collection);
          const ageDays = status.meta
            ? Math.max(0, Math.floor((Date.now() - status.meta.capturedAt) / 86_400_000))
            : null;
          return formatToolSuccess(
            {
              action: 'status',
              collection: status.collection,
              meta: status.meta
                ? {
                    ...status.meta,
                    capturedAtIso: new Date(status.meta.capturedAt).toISOString(),
                    ageDays,
                    stale: ageDays !== null && ageDays >= 7,
                  }
                : null,
            },
            ctx.meta,
          );
        }

        const result = await captureWorkspaceSnapshot({
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          origin: ctx.origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
          collection,
          concurrency: args.concurrency,
          includeMedia: args.includeMedia,
          mediaCacheLimit: args.mediaCacheLimit,
          mediaCacheMaxBytes: args.mediaCacheMaxBytes,
        });

        return formatToolSuccess(
          {
            action: 'capture',
            ...result,
            mediaCacheSummary: formatMediaCacheSummary(result),
            capturedAtIso: new Date(result.capturedAt).toISOString(),
          },
          ctx.meta,
        );
      }),
  );
}
