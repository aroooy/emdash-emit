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
import { ApiError } from '../../client/error.js';
import { pushArticle, PushValidationError } from '../../sync/push.js';

export function registerSyncPushTool(server: McpServer, resolveContext: ContextResolver): void {
  server.tool(
    'sync_push',
    'Push local Markdown article modifications or new articles to remote EmDash CMS. Automatically uploads standalone draft images in media/drafts/<file>, rewrites body URLs to /_emdash/api/media/file/<storageKey>, and promotes files to media/. Performs 3-way merge to protect remote edits. Requires allowPublish=true when transitioning status from draft to published. If conflict markers are inserted, resolve them locally before re-pushing.',
    {
      filePath: z
        .string()
        .describe(
          'Target markdown file path relative to workspace root (e.g. "posts/draft/20261103_01...-my-article.md")',
        ),
      allowPublish: z
        .boolean()
        .optional()
        .describe('Explicit confirmation required to change status from draft to published'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) => {
      const ctx = resolveContext(args.profile);
      const origin = ctx.origin;

      try {
        const res = await pushArticle(args.filePath, {
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
          allowPublish: args.allowPublish,
        });

        if (res.conflict) {
          return {
            content: [
              {
                type: 'text',
                text: [
                  '⚠️ Conflict detected and could not be resolved automatically.',
                  `Conflict markers (<<<<<<< LOCAL ... ======= ... >>>>>>> REMOTE) have been inserted into "${res.filePath}".`,
                  'Please resolve the conflicting lines in the file and retry sync_push.',
                ].join('\n'),
              },
            ],
          };
        }

        const warningLines =
          res.warnings && res.warnings.length > 0
            ? ['', '⚠️ Warnings:', ...res.warnings.map((w) => `  - ${w}`)]
            : [];

        return {
          content: [
            {
              type: 'text',
              text: [
                `✅ Successfully pushed '${res.id}' to remote (${res.filePath}, rev: ${res.rev}).`,
                ...warningLines,
              ].join('\n'),
            },
          ],
        };
      } catch (err: unknown) {
        if (err instanceof PushValidationError) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    error: 'PREFLIGHT_VALIDATION_FAILED',
                    message: err.message,
                    errors: err.errors,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        if (err instanceof ApiError) {
          return {
            content: [
              {
                type: 'text',
                text: err.toActionableString(),
              },
            ],
          };
        }
        throw err;
      }
    },
  );
}
