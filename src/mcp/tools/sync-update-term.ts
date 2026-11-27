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
import { updateTaxonomyTerm } from '../../sync/taxonomies.js';
import { formatToolSuccess, withResolvedContext } from '../tool-errors.js';

export function registerSyncUpdateTermTool(
  server: McpServer,
  resolveContext: ContextResolver,
): void {
  server.tool(
    'sync_update_term',
    'Update an existing category or tag term on EmDash (or an offline staged draft under drafts/). Refreshes local taxonomy YAML mirrors after remote update and warns if any local articles still reference an old slug.',
    {
      taxonomy: z.enum(['category', 'tag']).describe('Target taxonomy ("category" or "tag")'),
      target: z
        .string()
        .min(1)
        .describe('Target term identifier: 26-char ULID, local YAML path, or slug'),
      name: z.string().optional().describe('New human-readable display name (label)'),
      slug: z.string().optional().describe('New URL slug for the term'),
      parent: z
        .string()
        .optional()
        .describe('New parent category slug or 26-char ULID (categories only)'),
      clearParent: z
        .boolean()
        .optional()
        .describe('Set true to detach from parent category (sets parentId to null)'),
      description: z.string().optional().describe('New term description'),
      locale: z
        .string()
        .optional()
        .describe('Locale selector to disambiguate translations sharing the same slug'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) =>
      withResolvedContext(resolveContext, args, async (ctx) => {
        const res = await updateTaxonomyTerm({
          workspaceRoot: ctx.root,
          origin: ctx.origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
          defaultLocale: ctx.config.defaultLocale,
          taxonomy: args.taxonomy,
          target: args.target,
          locale: args.locale,
          name: args.name,
          slug: args.slug,
          parent: args.parent,
          clearParent: args.clearParent,
          description: args.description,
        });

        return formatToolSuccess(
          {
            ...res,
            message: `Updated ${res.isDraft ? 'staged draft ' : ''}${res.taxonomy} term "${res.slug}" (${res.locale}).`,
          },
          ctx.meta,
        );
      }),
  );
}
