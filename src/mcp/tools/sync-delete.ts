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
import { deleteArticle } from '../../sync/delete.js';
import { formatToolError, formatToolSuccess } from '../tool-errors.js';

export function registerSyncDeleteTool(server: McpServer, resolveContext: ContextResolver): void {
  server.tool(
    'sync_delete',
    'Safely delete an article from both the local workspace and remote EmDash server. Enforces strict safety guards: rejects deletion if unpushed local modifications exist, requires "allowDeletePublished: true" to delete published articles, saves an automatic rescue backup to posts/conflicts/<file>.deleted.md, and preserves referenced media files in media/.',
    {
      filePath: z
        .string()
        .optional()
        .describe(
          'Workspace-relative file path to delete (e.g. posts/draft/20261108_01M6...-my-slug.md)',
        ),
      id: z.string().optional().describe('Article ULID to delete'),
      allowDeletePublished: z
        .boolean()
        .optional()
        .describe('Explicit confirmation required to delete a published live article'),
      discardLocalEdits: z
        .boolean()
        .optional()
        .describe('Confirm deleting article even if local unpushed modifications exist'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Preview deletion metadata, line count, and referenced media without deleting'),
      collection: z
        .string()
        .optional()
        .describe('Collection name containing the article (defaults to "posts")'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) => {
      let ctx: ServerContext;
      try {
        ctx = resolveContext(args.profile);
      } catch (error) {
        return formatToolError(error);
      }

      if (!args.filePath && !args.id) {
        return formatToolError(
          new Error('Please specify either "filePath" or "id" of the article to delete.'),
        );
      }

      try {
        const collection = args.collection || ctx.config.defaultCollection;
        const result = await deleteArticle({
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          filePath: args.filePath,
          id: args.id,
          collection,
          allowDeletePublished: args.allowDeletePublished,
          discardLocalEdits: args.discardLocalEdits,
          dryRun: args.dryRun,
          origin: ctx.origin,
          token: ctx.auth?.token,
          refreshToken: ctx.auth?.refreshToken,
        });

        return formatToolSuccess(result as unknown as Record<string, unknown>, ctx.meta);
      } catch (error) {
        return formatToolError(error, ctx.meta);
      }
    },
  );
}
