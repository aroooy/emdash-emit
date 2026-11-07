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
import { pullArticle } from '../../sync/pull.js';
import { pullBatch, SyncPruneConflictError } from '../../sync/orchestrator.js';
import {
  pullTaxonomies,
  getLocalTaxonomiesSummary,
  formatTaxonomiesHint,
} from '../../sync/taxonomies.js';
import { pullMedia } from '../../sync/media.js';
import type { CliContextResolver } from '../context.js';

export function registerPullCommands(program: Command, resolveContext: CliContextResolver): void {
  // emit pull [id]
  program
    .command('pull [id]')
    .description(
      'Pull articles and taxonomies from remote EmDash into workspace (or specific article by ID)',
    )
    .option('-c, --collection <collection>', 'Collection name (defaults to "posts")')
    .option('-s, --status <status>', 'Filter by status: "all", "draft", or "published"', 'all')
    .option('--no-prune', 'Do not prune local articles outside the sync window')
    .option(
      '--concurrency <number>',
      'Number of parallel article processing tasks (default: 8 or config)',
    )
    .option('--force', 'Force overwrite local files and bypass differential skip')
    .option('--posts-only', 'Skip automatic taxonomy (categories/tags) sync. Pull articles only.')
    .option('--media', 'Also pull media assets and metadata into media/ directory.')
    .option(
      '--metadata-only',
      'With --media: download only metadata YAML, skip binary file downloads.',
    )
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (id, options) => {
      const ctx = resolveContext(options.profile);
      const collection = options.collection || ctx.config.defaultCollection;
      const postsOnly = options.postsOnly === true;
      const includeMedia = options.media === true;

      try {
        if (!id) {
          // Batch mode: taxonomies + articles (+ media if --media)

          // 1. Pull taxonomies (unless --posts-only)
          if (!postsOnly) {
            console.log('Syncing categories and tags...');
            const taxResult = await pullTaxonomies({
              workspaceRoot: ctx.root,
              origin: ctx.origin,
              token: ctx.auth.token,
              refreshToken: ctx.auth.refreshToken,
            });
            const taxPrunedCat = taxResult.deletedCategoriesCount
              ? `, ${taxResult.deletedCategoriesCount} categories pruned`
              : '';
            const taxPrunedTag = taxResult.deletedTagsCount
              ? `, ${taxResult.deletedTagsCount} tags pruned`
              : '';
            console.log(
              `  ✅ Taxonomies: ${taxResult.categoriesCount} categories, ${taxResult.tagsCount} tags${taxPrunedCat}${taxPrunedTag}`,
            );
          }

          const taxSummary = getLocalTaxonomiesSummary(ctx.root);
          const taxHint = formatTaxonomiesHint(taxSummary, { maxTags: 30 });
          if (taxHint) {
            console.log(`\n${taxHint}\n`);
          }

          // 2. Pull articles (batch)
          const limit = ctx.config.postsSyncLimit || ctx.config.syncLimit || 100;

          const concurrency = options.concurrency
            ? parseInt(options.concurrency, 10)
            : ctx.config.concurrency || 8;

          console.log(
            `Fetching articles from remote (${collection}, status: ${options.status}, window: ${limit}, concurrency: ${concurrency})...`,
          );
          const batchResult = await pullBatch({
            collection,
            workspaceRoot: ctx.root,
            cache: ctx.cache,
            origin: ctx.origin,
            token: ctx.auth.token,
            refreshToken: ctx.auth.refreshToken,
            limit,
            status: options.status,
            force: options.force,
            concurrency,
            prune: options.prune,
            onProgress: ({ current, total, item }) => {
              if (item.deleted) {
                console.log(`  [${current}/${total}] 🗑️  Pruned ${item.slug} -> ${item.filePath}`);
              } else if (!item.skipped) {
                console.log(`  [${current}/${total}] ✅ Pulled ${item.slug} -> ${item.filePath}`);
              } else if (current % 50 === 0 || current === total) {
                process.stdout.write(`  [${current}/${total}] Synced...\r`);
              }
            },
          });

          if (batchResult.total === 0 && (!batchResult.deleted || batchResult.deleted === 0)) {
            console.log('No remote articles found.');
            return;
          }

          const deletedMsg = batchResult.deleted ? `, ${batchResult.deleted} pruned` : '';
          console.log(
            `\n🎉 Articles: ${batchResult.total} total (${batchResult.updated} updated, ${batchResult.skipped} skipped/up-to-date${deletedMsg})`,
          );

          // 3. Pull media (if --media)
          if (includeMedia) {
            const mediaLimit = ctx.config.mediaSyncLimit || 300;
            const downloadFiles = options.metadataOnly !== true;
            console.log(
              `\nPulling media from remote (limit: ${mediaLimit}${downloadFiles ? '' : ', metadata only'})...`,
            );
            const mediaResult = await pullMedia({
              workspaceRoot: ctx.root,
              origin: ctx.origin,
              token: ctx.auth.token,
              refreshToken: ctx.auth.refreshToken,
              limit: mediaLimit,
              downloadFiles,
            });
            console.log(
              `  ✅ Media: ${mediaResult.total} items (${mediaResult.downloaded} downloaded, ${mediaResult.skipped} up-to-date)`,
            );
          }
        } else {
          // Single article mode: articles only (no taxonomy/media overhead)
          const res = await pullArticle(collection, id, {
            workspaceRoot: ctx.root,
            cache: ctx.cache,
            origin: ctx.origin,
            token: ctx.auth.token,
            refreshToken: ctx.auth.refreshToken,
            force: options.force,
          });
          if (res.deleted) {
            console.log(`🗑️ Remote article was deleted. Pruned local file: ${res.filePath}`);
          } else if (res.skipped) {
            console.log(`ℹ️ Article ${res.slug} is already up-to-date (${res.filePath})`);
          } else {
            console.log(`✅ Pulled ${res.slug} -> ${res.filePath}`);
          }
        }
      } catch (error) {
        if (error instanceof SyncPruneConflictError) {
          console.error(`\n❌ ${error.message}`);
          process.exit(1);
        }
        throw error;
      }
    });

  // emit pull-taxonomies (standalone; taxonomies are also pulled automatically by emit pull)
  program
    .command('pull-taxonomies')
    .description(
      'Pull remote categories and tags into local categories/ and tags/ YAML definitions (also pulled automatically by emit pull)',
    )
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (options) => {
      const ctx = resolveContext(options.profile);
      console.log('Pulling categories and tags from remote...');
      const res = await pullTaxonomies({
        workspaceRoot: ctx.root,
        origin: ctx.origin,
        token: ctx.auth.token,
        refreshToken: ctx.auth.refreshToken,
      });
      const prunedCatMsg = res.deletedCategoriesCount
        ? `, ${res.deletedCategoriesCount} categories pruned`
        : '';
      const prunedTagMsg = res.deletedTagsCount ? `, ${res.deletedTagsCount} tags pruned` : '';
      console.log(
        `✅ Successfully synced taxonomies: ${res.categoriesCount} categories, ${res.tagsCount} tags${prunedCatMsg}${prunedTagMsg}.`,
      );
      const taxSummary = getLocalTaxonomiesSummary(ctx.root);
      const taxHint = formatTaxonomiesHint(taxSummary, { maxTags: 60 });
      if (taxHint) {
        console.log(`\n${taxHint}`);
      }
    });

  // emit pull-media
  program
    .command('pull-media')
    .description('Pull remote media files and metadata YAML into local media/ directory')
    .option('-l, --limit <number>', 'Maximum media items to fetch (default: 300 or config)')
    .option('--all', 'Fetch ALL media files from remote')
    .option('--prune', 'Prune local media files that no longer exist on remote')
    .option('--metadata-only', 'Do not download binary files, only metadata YAML')
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (options) => {
      const ctx = resolveContext(options.profile);
      const limit = options.all
        ? undefined
        : options.limit
          ? parseInt(options.limit, 10)
          : ctx.config.mediaSyncLimit || 300;

      console.log(`Pulling media from remote (${options.all ? 'all' : `limit: ${limit}`})...`);
      const res = await pullMedia({
        workspaceRoot: ctx.root,
        origin: ctx.origin,
        token: ctx.auth.token,
        refreshToken: ctx.auth.refreshToken,
        limit,
        all: options.all,
        prune: options.prune,
        downloadFiles: !options.metadataOnly,
      });

      const deletedMsg = res.deleted ? `, ${res.deleted} pruned` : '';
      console.log(
        `✅ Media sync complete: ${res.total} total items (${res.downloaded} downloaded, ${res.skipped} skipped/up-to-date${deletedMsg}).`,
      );
    });
}
