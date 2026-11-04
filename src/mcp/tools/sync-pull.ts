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
import path from 'node:path';
import fs from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContextResolver } from '../context.js';
import { pullArticle } from '../../sync/pull.js';
import { pullBatch, SyncPruneConflictError } from '../../sync/orchestrator.js';
import { pullTaxonomies } from '../../sync/taxonomies.js';
import { pullMedia } from '../../sync/media.js';
import { extractUlidFromFilename } from '../../utils/naming.js';

export function registerSyncPullTools(server: McpServer, resolveContext: ContextResolver): void {
  // sync_pull: Pull remote article(s)
  server.tool(
    'sync_pull',
    {
      collection: z.string().optional().describe('Collection name to pull (defaults to "posts")'),
      id: z.string().optional().describe('Specific article ID to pull'),
      filePath: z
        .string()
        .optional()
        .describe('Specific article file path (relative to workspace root) to pull'),
      status: z
        .enum(['all', 'draft', 'published'])
        .optional()
        .describe('Filter articles by status (batch mode, defaults to "all")'),
      force: z
        .boolean()
        .optional()
        .describe('Force overwrite local files and bypass differential hash checking'),
      noPrune: z
        .boolean()
        .optional()
        .describe(
          'Escape hatch: do not prune local articles outside the sync window (not needed for routine use)',
        ),
      prune: z
        .boolean()
        .optional()
        .describe('Explicitly control whether to prune articles outside the sync window'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) => {
      const ctx = resolveContext(args.profile);
      const collection = args.collection || ctx.config.defaultCollection;
      const origin = ctx.origin;

      let targetId = args.id;
      if (!targetId && args.filePath) {
        const full = path.join(ctx.root, args.filePath);
        if (fs.existsSync(full)) {
          const ulid = extractUlidFromFilename(full);
          if (ulid) targetId = ulid;
        }
      }

      if (targetId) {
        const res = await pullArticle(collection, targetId, {
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
          force: args.force,
        });

        return {
          content: [
            {
              type: 'text',
              text: res.skipped
                ? `ℹ️ Article '${res.slug}' is already up-to-date at ${res.filePath}.`
                : `✅ Successfully pulled article '${res.slug}' to ${res.filePath}.`,
            },
          ],
        };
      }

      // Batch sync mode: Uses configured sliding window limit
      const limit = ctx.config.postsSyncLimit || ctx.config.syncLimit || 100;
      const shouldPrune = args.prune !== undefined ? args.prune : args.noPrune ? false : undefined;

      try {
        const batchResult = await pullBatch({
          collection,
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
          limit,
          status: args.status,
          force: args.force,
          prune: shouldPrune,
        });

        const deletedMsg = batchResult.deleted ? `, ${batchResult.deleted} pruned` : '';
        return {
          content: [
            {
              type: 'text',
              text: `✅ Synced ${batchResult.total} articles (${batchResult.updated} updated, ${batchResult.skipped} up-to-date/skipped${deletedMsg}).`,
            },
          ],
        };
      } catch (error) {
        if (error instanceof SyncPruneConflictError) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `❌ ${error.message}`,
              },
            ],
          };
        }
        throw error;
      }
    },
  );

  // sync_pull_taxonomies
  server.tool(
    'sync_pull_taxonomies',
    {
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) => {
      const ctx = resolveContext(args.profile);
      const res = await pullTaxonomies({
        workspaceRoot: ctx.root,
        origin: ctx.origin,
        token: ctx.auth.token,
        refreshToken: ctx.auth.refreshToken,
      });

      return {
        content: [
          {
            type: 'text',
            text: `✅ Successfully pulled taxonomies (${res.categoriesCount} categories, ${res.tagsCount} tags) into categories/ and tags/.`,
          },
        ],
      };
    },
  );

  // sync_pull_media
  server.tool(
    'sync_pull_media',
    {
      limit: z
        .number()
        .optional()
        .describe('Maximum number of media items to pull (defaults to 300)'),
      all: z.boolean().optional().describe('Pull ALL media items from remote (defaults to false)'),
      downloadFiles: z.boolean().optional().describe('Download binary files (defaults to true)'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) => {
      const ctx = resolveContext(args.profile);
      const res = await pullMedia({
        workspaceRoot: ctx.root,
        origin: ctx.origin,
        token: ctx.auth.token,
        refreshToken: ctx.auth.refreshToken,
        limit: args.limit || ctx.config.mediaSyncLimit || 300,
        all: args.all,
        downloadFiles: args.downloadFiles,
      });

      return {
        content: [
          {
            type: 'text',
            text: `✅ Successfully pulled media: ${res.total} items (${res.downloaded} downloaded, ${res.skipped} skipped/up-to-date).`,
          },
        ],
      };
    },
  );
}
