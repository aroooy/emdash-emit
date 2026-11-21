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
import {
  collectLocalMirrorIndex,
  searchLocalMirrorMedia,
  searchRemoteMedia,
} from '../../sync/media/index.js';
import { getLocalTaxonomiesSummary } from '../../sync/taxonomies.js';
import {
  formatMediaSearchEmptyNotice,
  formatMediaSearchHeader,
  formatMediaSearchHit,
  formatMediaSearchUsageHint,
  formatMediaSearchWalkIncompleteNotice,
  formatTagSearchHints,
} from '../../presentation/media_report.js';
import type { CliContextResolver } from '../context.js';
import { reportActionFailure } from '../report-failure.js';

export function registerMediaSearchCommand(
  program: Command,
  resolveContext: CliContextResolver,
): void {
  program
    .command('media-search [query]')
    .description(
      'Search the remote EmDash media library by keyword (filename, alt, caption, storageKey); omit the query to browse by recency',
    )
    .option('-l, --limit <number>', 'Max hits (default 20, max 50)')
    .option(
      '--max-scan <number>',
      'Records to read before stopping (default 500; 0 = whole library)',
    )
    .option('--mirrored-only', 'Only assets Emit already mirrors')
    .option(
      '--offline',
      'Search only this workspace media mirrors — no network requests. Results cover local files only.',
    )
    .option(
      '--since <date>',
      'Only assets created on or after this date: today, yesterday, or YYYY-MM-DD (local time)',
    )
    .option('--until <date>', 'Only assets created on or before this date (same formats)')
    .option('--suggest-keywords', 'Append the top local tag slugs as search hints')
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (query: string | undefined, options) => {
      try {
        const limit = options.limit ? parseInt(options.limit, 10) : undefined;
        const maxScan = options.maxScan !== undefined ? parseInt(options.maxScan, 10) : undefined;

        // The mirror index is needed by both paths, and in offline mode it is the only source of truth.
        const ctx = resolveContext(options.profile);
        const mirrorIndex = collectLocalMirrorIndex(ctx.root, ctx.cache);

        const result = options.offline
          ? searchLocalMirrorMedia({
              query,
              since: options.since,
              until: options.until,
              limit,
              mirrorIndex,
            })
          : await searchRemoteMedia({
              workspaceRoot: ctx.root,
              origin: ctx.origin,
              token: ctx.auth.token,
              refreshToken: ctx.auth.refreshToken,
              query,
              since: options.since,
              until: options.until,
              limit,
              maxScan,
              mirroredOnly: Boolean(options.mirroredOnly),
              mirrorIndex,
            });

        const rangeLabel = [
          options.since ? `since ${options.since}` : '',
          options.until ? `until ${options.until}` : '',
        ]
          .filter(Boolean)
          .join(' ');
        const subject = query ? `"${query}"` : rangeLabel || 'recency browse';

        console.log(
          formatMediaSearchHeader(result, { subject, offline: Boolean(options.offline) }),
        );

        const emptyNotice = formatMediaSearchEmptyNotice(result, {
          offline: Boolean(options.offline),
        });
        if (emptyNotice) {
          console.log(`\n${emptyNotice}`);
        } else {
          result.hits.forEach((hit, i) => {
            for (const line of formatMediaSearchHit(hit, i)) {
              console.log(line);
            }
          });
        }

        if (!options.offline) {
          const walkNotice = formatMediaSearchWalkIncompleteNotice(result, {
            isMcp: false,
            limit,
          });
          if (walkNotice) {
            const lines = walkNotice.split('\n');
            console.log(`\n${lines[0]}`);
            for (const line of lines.slice(1)) {
              console.log(line);
            }
          }
        }

        if (result.hits.length > 0 && !options.offline) {
          const usageLines = formatMediaSearchUsageHint().split('\n');
          console.log(`\n${usageLines[0]}`);
          for (const line of usageLines.slice(1)) {
            console.log(line);
          }
        }

        if (options.suggestKeywords) {
          try {
            const tax = getLocalTaxonomiesSummary(ctx.root);
            const tagHint = formatTagSearchHints(tax.tags);
            if (tagHint) {
              console.log(`\n${tagHint}`);
            }
          } catch {
            // Taxonomy reading failure is non-fatal for search
          }
        }
      } catch (err) {
        reportActionFailure(err);
      }
    });
}
