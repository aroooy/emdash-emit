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
import { createArticleScaffold, DuplicateSlugError } from '../../sync/new.js';
import { getLocalTaxonomiesSummary, formatTaxonomiesHint } from '../../sync/taxonomies.js';
import { formatToolError } from '../tool-errors.js';

export function registerSyncNewTool(server: McpServer, resolveContext: ContextResolver): void {
  server.tool(
    'sync_new',
    'Create a new article draft scaffold in posts/draft/ with standardized frontmatter (ULID, slug, title, default bylines). Returns the created relative file path and available categories/tags hints (sorted by usage) so you can edit the Markdown file directly before pushing.',
    {
      slug: z.string().describe('URL slug for the new article'),
      title: z.string().optional().describe('Article title'),
      collection: z
        .string()
        .optional()
        .describe('Target collection (defaults to "posts" or config)'),
      locale: z.string().optional().describe('Article locale (defaults to "ja")'),
      byline: z
        .string()
        .optional()
        .describe('Author byline slug (defaults to first cached non-guest author by slug)'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) => {
      let ctx: ServerContext;
      try {
        ctx = resolveContext(args.profile);
      } catch (error) {
        return formatToolError(error);
      }

      try {
        const collection = args.collection || ctx.config.defaultCollection;

        const res = createArticleScaffold({
          slug: args.slug,
          workspaceRoot: ctx.root,
          collection,
          title: args.title,
          locale: args.locale || ctx.config.defaultLocale,
          byline: args.byline,
          cache: ctx.cache,
        });

        const taxSummary = getLocalTaxonomiesSummary(ctx.root);
        const taxHint = formatTaxonomiesHint(taxSummary, { maxTags: 60 });
        const hintBlock = taxHint ? `\n\n${taxHint}` : '';

        const metaSuffix = `\n\n_meta: ${JSON.stringify(ctx.meta)}`;

        return {
          content: [
            {
              type: 'text',
              text: `✅ Created new draft article '${args.slug}' (ID: ${res.id}) at ${res.filePath}.${hintBlock}\n\nYou can now edit the file directly and sync it with sync_push.${metaSuffix}`,
            },
          ],
        };
      } catch (error) {
        // Slug validation, byline resolution, and taxonomy hint reads all fail here.
        return formatToolError(error, ctx?.meta);
      }
    },
  );
}
