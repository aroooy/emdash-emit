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
import { createArticleScaffold } from '../../sync/new.js';

export function registerSyncNewTool(server: McpServer, resolveContext: ContextResolver): void {
  server.tool(
    'sync_new',
    {
      slug: z.string().describe('URL slug for the new article'),
      title: z.string().optional().describe('Article title'),
      collection: z
        .string()
        .optional()
        .describe('Target collection (defaults to "posts" or config)'),
      locale: z.string().optional().describe('Article locale (defaults to "ja")'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) => {
      const ctx = resolveContext(args.profile);
      const collection = args.collection || ctx.config.defaultCollection;
      const res = createArticleScaffold({
        slug: args.slug,
        workspaceRoot: ctx.root,
        collection,
        title: args.title,
        locale: args.locale || ctx.config.defaultLocale,
      });

      return {
        content: [
          {
            type: 'text',
            text: `✅ Created new draft article '${args.slug}' (ID: ${res.id}) at ${res.filePath}.\nYou can now edit the file and sync it with sync_push.`,
          },
        ],
      };
    },
  );
}
