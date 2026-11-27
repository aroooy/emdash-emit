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
import { createLocalDraftTerm } from '../../sync/taxonomies.js';
import { formatToolSuccess, withResolvedContext } from '../tool-errors.js';

export function registerSyncNewTermTool(server: McpServer, resolveContext: ContextResolver): void {
  server.tool(
    'sync_new_term',
    'Stage a new category or tag term completely offline under categories/drafts/<locale>/ or tags/drafts/<locale>/. Staged terms are protected from sync_pull pruning, pass Guard G4 validation immediately, and are automatically created on EmDash and promoted on sync_push.',
    {
      taxonomy: z.enum(['category', 'tag']).describe('Target taxonomy ("category" or "tag")'),
      slug: z.string().min(1).describe('URL slug for the new term'),
      name: z
        .string()
        .optional()
        .describe('Human-readable display name (defaults to decoded slug)'),
      locale: z
        .string()
        .optional()
        .describe('Term locale (defaults to workspace defaultLocale, e.g. "ja")'),
      parent: z
        .string()
        .optional()
        .describe('Parent category slug or 26-char ULID (for hierarchical categories)'),
      translationOf: z
        .string()
        .optional()
        .describe('Source term 26-char ULID to link this term as a translation'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) =>
      withResolvedContext(resolveContext, args, (ctx) => {
        const res = createLocalDraftTerm({
          workspaceRoot: ctx.root,
          taxonomy: args.taxonomy,
          slug: args.slug,
          name: args.name,
          locale: args.locale || ctx.config.defaultLocale,
          parent: args.parent,
          translationOf: args.translationOf,
        });

        return formatToolSuccess(
          {
            ...res,
            message: `Staged offline ${res.taxonomy} term "${res.slug}" (${res.locale}) at ${res.filePath}. Reference it in article frontmatter and run sync_push when online to create and promote it automatically.`,
          },
          ctx.meta,
        );
      }),
  );
}
