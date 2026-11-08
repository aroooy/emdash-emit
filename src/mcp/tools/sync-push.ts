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
import { pushArticle } from '../../sync/push.js';
import { formatToolError } from '../tool-errors.js';

export function registerSyncPushTool(server: McpServer, resolveContext: ContextResolver): void {
  server.tool(
    'sync_push',
    'Push local Markdown article modifications or new articles to remote EmDash CMS. Automatically uploads standalone draft images in media/drafts/<file>, rewrites body URLs to /_emdash/api/media/file/<storageKey>, and promotes files to media/. Performs 3-way merge to protect remote edits. Requires allowPublish=true when transitioning status from draft to published. If conflict markers are inserted, resolve them locally before re-pushing. Paths under posts/conflicts/ are preserved rescue copies and are refused with QUARANTINED_COPY_NOT_PUSHABLE: merge their content into the canonical article first.',
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

        const transitionLines: string[] = [];
        if (res.previousId) {
          transitionLines.push(
            `🆔 Server assigned canonical ULID: '${res.previousId}' -> '${res.id}'.`,
          );
        }
        if (res.previousFilePath) {
          transitionLines.push(
            `📄 Local file renamed: "${res.previousFilePath}" -> "${res.filePath}" (use the new path for subsequent edits/pushes).`,
          );
        }

        const allWarnings = [
          ...(ctx.originWarning ? [ctx.originWarning] : []),
          ...(res.warnings || []),
        ];
        const warningLines =
          allWarnings.length > 0 ? ['', '⚠️ Warnings:', ...allWarnings.map((w) => `  - ${w}`)] : [];

        return {
          content: [
            {
              type: 'text',
              text: [
                `✅ Successfully pushed '${res.id}' to remote (${res.filePath}, rev: ${res.rev}).`,
                ...transitionLines,
                ...warningLines,
              ].join('\n'),
            },
          ],
        };
      } catch (err: unknown) {
        return formatToolError(err);
      }
    },
  );
}
