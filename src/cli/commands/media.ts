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
  deleteMedia,
  pushMedia,
  searchLocalMirrorMedia,
} from '../../sync/media/index.js';
import { getLocalTaxonomiesSummary } from '../../sync/taxonomies.js';
import { buildSnapshotSearchFraming } from '../../presentation/article_report.js';
import {
  formatMediaDeleteReport,
  formatMediaSearchEmptyNotice,
  formatMediaSearchHeader,
  formatMediaSearchHit,
  formatMediaSearchUsageHint,
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
      'Search media across local workspace mirrors and .emit/cache.db snapshot (0-HTTP, exhaustive); omit the query to browse by recency',
    )
    .option('-l, --limit <number>', 'Max hits (default 20, max 50)')
    .option('--mirrored-only', 'Only assets Emit already mirrors (excludes snapshot-only records)')
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

        const ctx = resolveContext(options.profile, { optionalAuth: true });
        const mirrorIndex = collectLocalMirrorIndex(ctx.root, ctx.cache);

        const result = searchLocalMirrorMedia({
          query,
          since: options.since,
          until: options.until,
          limit,
          mirrorIndex,
          cache: ctx.cache,
          mirroredOnly: Boolean(options.mirroredOnly),
        });

        const rangeLabel = [
          options.since ? `since ${options.since}` : '',
          options.until ? `until ${options.until}` : '',
        ]
          .filter(Boolean)
          .join(' ');
        const subject = query ? `"${query}"` : rangeLabel || 'recency browse';

        console.log(formatMediaSearchHeader(result, { subject }));

        const emptyNotice = formatMediaSearchEmptyNotice(result);
        if (emptyNotice) {
          console.log(`\n${emptyNotice}`);
        } else {
          result.hits.forEach((hit, i) => {
            for (const line of formatMediaSearchHit(hit, i)) {
              console.log(line);
            }
          });
        }

        const framing = buildSnapshotSearchFraming({
          snapshot: result.snapshot,
          hitCount: result.hits.length,
          totalCount: result.totalCount,
          truncated: result.truncated,
          walkComplete: result.walkComplete,
          isLive: false,
          query,
          kind: 'media',
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

        if (result.hits.length > 0) {
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

export function registerPushMediaCommand(
  program: Command,
  resolveContext: CliContextResolver,
): void {
  program
    .command('push-media <targets...>')
    .description(
      'Upload local image file(s) to remote EmDash media library and/or sync alt/caption metadata from flags or local media/<stem>.yaml (Note: createdAt is server-assigned at upload time; Emit does not parse EXIF or sort uploads)',
    )
    .option(
      '--alt <text>',
      'Alt text to set on the remote media record(s) (pass "" to clear; omit to push alt from local media/<stem>.yaml)',
    )
    .option(
      '--caption <text>',
      'Caption text to set on the remote media record(s) (pass "" to clear; omit to push caption from local media/<stem>.yaml)',
    )
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(
      async (targets: string[], options: { alt?: string; caption?: string; profile?: string }) => {
        try {
          const ctx = resolveContext(options.profile);
          const result = await pushMedia({
            workspaceRoot: ctx.root,
            origin: ctx.origin,
            token: ctx.auth.token,
            refreshToken: ctx.auth.refreshToken,
            targets,
            alt: options.alt,
            caption: options.caption,
            cache: ctx.cache,
          });

          for (const item of result.items) {
            if (item.action === 'uploaded') {
              console.log(
                `✅ Uploaded ${item.target} -> ${item.filePath ?? item.storageKey ?? item.mediaId} (mediaId: ${item.mediaId}, storageKey: ${item.storageKey ?? 'n/a'})`,
              );
            } else if (item.action === 'deduplicated') {
              console.log(
                `♻️  Deduplicated ${item.target} -> ${item.filePath ?? item.storageKey ?? item.mediaId} (mediaId: ${item.mediaId}, storageKey: ${item.storageKey ?? 'n/a'})`,
              );
            } else {
              console.log(
                `✅ Updated metadata for ${item.target} (mediaId: ${item.mediaId}${item.storageKey ? `, storageKey: ${item.storageKey}` : ''}${item.yamlPath ? `, yaml: ${item.yamlPath}` : ''})`,
              );
            }
          }
        } catch (err) {
          reportActionFailure(err);
        }
      },
    );
}

export function registerDeleteMediaCommand(
  program: Command,
  resolveContext: CliContextResolver,
): void {
  program
    .command('delete-media <targets...>')
    .description(
      'Safely delete media asset(s) from remote EmDash and local media/ mirror (enforces Guard G20 reference protection and backs up local mirror to media/_trash/)',
    )
    .option('--dry-run', 'Preview deletion and local reference checks without deleting anything')
    .option(
      '--no-backup',
      'Skip moving local mirror files into media/_trash/ after remote deletion',
    )
    .option(
      '-c, --collection <collection>',
      'Target collection to scan for references (defaults to "posts")',
    )
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(
      async (
        targets: string[],
        options: {
          dryRun?: boolean;
          backup?: boolean;
          noBackup?: boolean;
          collection?: string;
          profile?: string;
        },
      ) => {
        try {
          const isDryRun = Boolean(options.dryRun);
          const ctx = resolveContext(options.profile, { optionalAuth: isDryRun });
          const noBackup = options.backup === false || Boolean(options.noBackup);
          const result = await deleteMedia({
            workspaceRoot: ctx.root,
            origin: ctx.origin,
            token: ctx.auth?.token,
            refreshToken: ctx.auth?.refreshToken,
            targets,
            collection: options.collection || ctx.config.defaultCollection,
            dryRun: isDryRun,
            noBackup,
            cache: ctx.cache,
          });

          console.log(formatMediaDeleteReport(result));
        } catch (err) {
          reportActionFailure(err);
        }
      },
    );
}
