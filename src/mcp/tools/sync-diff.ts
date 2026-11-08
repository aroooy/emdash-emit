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
import { inspectArticleDiff, type ArticleDiffInspection } from '../../sync/diff.js';
import { formatToolError } from '../tool-errors.js';

export function registerSyncDiffTool(server: McpServer, resolveContext: ContextResolver): void {
  server.tool(
    'sync_diff',
    'Display line-by-line differences between local article edits and the baseline snapshot/remote version before pushing. Useful for reviewing changes or diagnosing unpushed modifications.',
    {
      filePath: z
        .string()
        .optional()
        .describe(
          'Relative path to the markdown file to inspect (e.g. "posts/draft/20261103_01...-my-article.md")',
        ),
      id: z.string().optional().describe('Article ID (ULID) to inspect'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) => {
      let ctx: ServerContext;
      try {
        ctx = resolveContext(args.profile);
      } catch (error) {
        return formatToolError(error);
      }
      let inspection: ArticleDiffInspection;
      try {
        inspection = inspectArticleDiff({
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          filePath: args.filePath,
          id: args.id,
        });
      } catch (error) {
        return formatToolError(error, ctx.meta);
      }

      const metaSuffix = `\n\n_meta: ${JSON.stringify(ctx.meta)}`;

      return {
        content: [
          {
            type: 'text',
            text: `${inspection.formattedOutput}${metaSuffix}`,
          },
        ],
      };
    },
  );
}
