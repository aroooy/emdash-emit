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
import { pullArticle, formatQuarantineNotice } from '../../sync/pull.js';
import { pullBatch, SyncPruneConflictError } from '../../sync/orchestrator.js';
import {
  pullTaxonomies,
  getLocalTaxonomiesSummary,
  formatTaxonomiesHint,
} from '../../sync/taxonomies.js';
import { pullMedia } from '../../sync/media.js';
import { ApiError } from '../../client/error.js';
import type { CliContextResolver } from '../context.js';

export function formatPullWindowLabel(status: string | undefined, limit: number): string {
  return status === 'all' ? `${limit}/status` : `${limit}`;
}

export function formatPullStatusBreakdown(
  status: string | undefined,
  items: Array<{ deleted?: boolean; status?: string }>,
): string {
  if (status !== 'all') return '';
  const publishedCount = items.filter((i) => !i.deleted && i.status === 'published').length;
  const draftCount = items.filter((i) => !i.deleted && i.status === 'draft').length;
  return ` [${publishedCount} published, ${draftCount} draft]`;
}

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
            if (taxResult.categoriesFailed) {
              console.warn(
                '  ⚠️  Failed to fetch remote categories: preserved existing local definitions.',
              );
            }
            if (taxResult.tagsFailed) {
              console.warn(
                '  ⚠️  Failed to fetch remote tags: preserved existing local definitions.',
              );
            }
            if (!taxResult.categoriesFailed || !taxResult.tagsFailed) {
              console.log(
                `  ✅ Taxonomies: ${taxResult.categoriesCount} categories, ${taxResult.tagsCount} tags${taxPrunedCat}${taxPrunedTag}`,
              );
            }
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

          const windowLabel = formatPullWindowLabel(options.status, limit);
          console.log(
            `Fetching articles from remote (${collection}, status: ${options.status}, window: ${windowLabel}, concurrency: ${concurrency})...`,
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
              } else if (item.localEditsPreserved) {
                console.log(
                  `\n  [${current}/${total}] 🛡️  Kept local edits for ${item.slug} (${item.filePath})`,
                );
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
          const statusBreakdown = formatPullStatusBreakdown(options.status, batchResult.items);
          console.log(
            `\n🎉 Articles: ${batchResult.total} total${statusBreakdown} (${batchResult.updated} updated, ${batchResult.skipped} skipped/up-to-date${deletedMsg})`,
          );

          if (batchResult.preserved && batchResult.preserved > 0) {
            console.log(
              `🛡️  ${batchResult.preserved} article(s) had unpushed local edits: Emit kept your local version (remote changes were NOT applied). ` +
                `Push them with "emit push <filePath>", or re-run with --force to accept the remote version.`,
            );
          }

          for (const item of batchResult.items) {
            const notice = formatQuarantineNotice(item.quarantined);
            if (notice) console.log(`\n${notice}`);
          }

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
          } else if (res.localEditsPreserved) {
            console.log(
              `🛡️ Kept your local edits for ${res.slug} (${res.filePath}); remote changes were NOT applied.`,
            );
            console.log(
              `   Push them with "emit push ${res.filePath}", or re-run with --force to accept the remote version.`,
            );
          } else if (res.skipped) {
            console.log(`ℹ️ Article ${res.slug} is already up-to-date (${res.filePath})`);
          } else {
            console.log(`✅ Pulled ${res.slug} -> ${res.filePath}`);
          }

          const quarantineNotice = formatQuarantineNotice(res.quarantined);
          if (quarantineNotice) console.log(`\n${quarantineNotice}`);
        }
      } catch (error) {
        if (error instanceof SyncPruneConflictError) {
          console.error(`\n❌ ${error.message}`);
          process.exit(1);
        }
        if (error instanceof ApiError) {
          console.error(`\n${error.toActionableString()}`);
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
      try {
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
        if (res.categoriesFailed) {
          console.warn(
            '⚠️  Failed to fetch remote categories: preserved existing local definitions.',
          );
        }
        if (res.tagsFailed) {
          console.warn('⚠️  Failed to fetch remote tags: preserved existing local definitions.');
        }
        if (!res.categoriesFailed || !res.tagsFailed) {
          console.log(
            `✅ Successfully synced taxonomies: ${res.categoriesCount} categories, ${res.tagsCount} tags${prunedCatMsg}${prunedTagMsg}.`,
          );
        }
        const taxSummary = getLocalTaxonomiesSummary(ctx.root);
        const taxHint = formatTaxonomiesHint(taxSummary, { maxTags: 60 });
        if (taxHint) {
          console.log(`\n${taxHint}`);
        }
        if (res.categoriesFailed && res.tagsFailed) {
          process.exit(1);
        }
      } catch (error) {
        if (error instanceof ApiError) {
          console.error(`\n${error.toActionableString()}`);
          process.exit(1);
        }
        throw error;
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

      try {
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
      } catch (error) {
        if (error instanceof ApiError) {
          console.error(`\n${error.toActionableString()}`);
          process.exit(1);
        }
        throw error;
      }
    });
}
