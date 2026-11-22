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
  captureWorkspaceSnapshot,
  clearWorkspaceSnapshot,
  getWorkspaceSnapshotStatus,
} from '../../sync/snapshot/index.js';
import { formatSnapshotAge, formatSnapshotTimestamp } from '../../presentation/article_report.js';
import type { CliContextResolver } from '../context.js';
import { reportActionFailure } from '../report-failure.js';

export function registerSnapshotCommand(
  program: Command,
  resolveContext: CliContextResolver,
): void {
  program
    .command('snapshot')
    .description(
      'Capture a full-library metadata snapshot (articles, media, taxonomies) into cache.db for offline search & 0-GET taxonomy filtering',
    )
    .option('-c, --collection <collection>', 'Collection to snapshot (default: posts)')
    .option('--status', 'Show current snapshot freshness and counts without contacting remote')
    .option('--clear', 'Clear cached snapshot tables from cache.db')
    .option('--concurrency <number>', 'Max concurrent remote fetches (default from config)')
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (options) => {
      try {
        const ctx = resolveContext(options.profile);
        const collection = options.collection || ctx.config.defaultCollection;

        if (options.clear) {
          const cleared = clearWorkspaceSnapshot(ctx.cache, collection);
          console.log(
            `🗑️  Cleared snapshot for "${cleared.collection}" (${cleared.articlesCleared} article(s), ${cleared.mediaCleared} media record(s)).`,
          );
          return;
        }

        if (options.status) {
          const status = getWorkspaceSnapshotStatus(ctx.cache, collection);
          if (!status.meta) {
            console.log(
              `📸 Snapshot (${collection}): none (run "emit snapshot" to cache full remote metadata).`,
            );
            return;
          }
          const iso = new Date(status.meta.capturedAt).toISOString();
          const ageMs = Date.now() - status.meta.capturedAt;
          const staleNote =
            ageMs >= 7 * 86_400_000 ? ' ⚠️ [STALE_SNAPSHOT: >7d old — run "emit snapshot"]' : '';
          console.log(
            `📸 Snapshot (${collection}): ${formatSnapshotTimestamp(iso)} (${formatSnapshotAge(iso)}) · ` +
              `${status.meta.articleCount} article(s) · ${status.meta.mediaCount} media record(s)${staleNote}`,
          );
          return;
        }

        const concurrency =
          options.concurrency !== undefined ? parseInt(options.concurrency, 10) : undefined;
        const result = await captureWorkspaceSnapshot({
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          origin: ctx.origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
          collection,
          concurrency: Number.isFinite(concurrency) ? concurrency : undefined,
        });

        const iso = new Date(result.capturedAt).toISOString();
        console.log(
          `📸 Snapshot captured (${result.collection}) @ ${formatSnapshotTimestamp(iso)} (${result.durationMs}ms):\n` +
            `   • Articles: ${result.articleCount} cached (${result.articlesPruned} pruned, ${result.articleSingleGetCount} single-GET(s))\n` +
            `   • Media:    ${result.mediaCount} cached (${result.mediaPruned} pruned)\n` +
            `   • Terms:    ${result.categoriesSynced} categories, ${result.tagsSynced} tags ` +
            `(article terms: ${result.taxonomyFetchedCount} fetched, ${result.taxonomyReusedCount} reused)`,
        );
        if (result.taxonomyWarning) {
          console.log(`⚠️ ${result.taxonomyWarning}`);
        }
      } catch (err) {
        reportActionFailure(err);
      }
    });
}
