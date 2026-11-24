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

import type { Command } from 'commander';
import { searchRemoteArticles } from '../../sync/article_search/index.js';
import {
  buildSnapshotSearchFraming,
  formatArticleSearchEmptyNotice,
  formatArticleSearchHeader,
  formatArticleSearchHit,
} from '../../presentation/article_report.js';
import type { CliContextResolver } from '../context.js';
import { reportActionFailure } from '../report-failure.js';

export function registerArticleSearchCommand(
  program: Command,
  resolveContext: CliContextResolver,
): void {
  program
    .command('article-search [query]')
    .description(
      'Search articles across the local workspace + .emit/cache.db snapshot (0-HTTP, exhaustive), or use --live for keyword-only remote FTS',
    )
    .option('-t, --tag <slug>', 'Filter by tag slug')
    .option('-c, --category <slug>', 'Filter by category slug')
    .option('--status <status>', 'Filter by article status: "draft" or "published"')
    .option('--slug <slug>', 'Filter by article slug')
    .option(
      '--since <date>',
      'Only articles on or after this date: "today", "yesterday", or YYYY-MM-DD (local time)',
    )
    .option('--until <date>', 'Only articles on or before this date (same formats as --since)')
    .option(
      '--date-field <field>',
      'Date field to compare against: "publishedAt", "updatedAt", or "createdAt" (default: publishedAt for published, createdAt for draft)',
    )
    .option(
      '--live',
      'Query remote EmDash FTS endpoint directly (keyword-only; tag/category/date/status filters are rejected)',
    )
    .option('-l, --limit <number>', 'Max hits to return (default 20, max 50)')
    .option(
      '--include-conflicts',
      'Include quarantined rescue copies from posts/conflicts/ in search results',
    )
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (query: string | undefined, options) => {
      try {
        const limit = options.limit ? parseInt(options.limit, 10) : undefined;
        const isLive = Boolean(options.live);

        const ctx = resolveContext(options.profile, { optionalAuth: !isLive });

        const result = await searchRemoteArticles({
          query,
          tag: options.tag,
          category: options.category,
          status: options.status,
          slug: options.slug,
          since: options.since,
          until: options.until,
          dateField: options.dateField,
          live: isLive,
          limit,
          includeConflicts: Boolean(options.includeConflicts),
          workspaceRoot: ctx.root,
          origin: ctx.origin,
          token: ctx.auth.token,
          cache: ctx.cache,
        });

        console.log(
          formatArticleSearchHeader(result, {
            live: isLive,
            query,
            since: options.since,
            until: options.until,
            tag: options.tag,
            category: options.category,
            slug: options.slug,
          }),
        );

        if (result.hits.length === 0) {
          console.log(`\n${formatArticleSearchEmptyNotice(result, isLive)}`);
        } else {
          console.log('');
          result.hits.forEach((hit, i) => {
            console.log(formatArticleSearchHit(hit, i));
          });
        }

        const framing = buildSnapshotSearchFraming({
          snapshot: result.snapshot,
          hitCount: result.hits.length,
          totalCount: result.totalCount,
          truncated: result.truncated,
          walkComplete: result.walkComplete,
          isLive,
          query,
          kind: 'article',
          isMcp: false,
        });

        if (framing.truncatedHint) {
          console.log(`\nℹ️ ${framing.truncatedHint}`);
        }
        if (framing.userNotice) {
          console.log(`\n⚠️ ${framing.userNotice}`);
        }
        if (framing.recommendedAction) {
          console.log(`💡 ${framing.recommendedAction}`);
        }
      } catch (err) {
        reportActionFailure(err);
      }
    });
}
