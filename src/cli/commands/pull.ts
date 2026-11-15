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

import path from 'node:path';
import type { Command } from 'commander';
import { formatQuarantineNotice } from '../../sync/pull.js';
import { pullBatch, pullSingleArticle } from '../../sync/orchestrator.js';
import { resolveArticleTarget } from '../../sync/diff.js';
import { ApiError } from '../../client/error.js';
import {
  pullTaxonomies,
  getLocalTaxonomiesSummary,
  formatTaxonomiesHint,
  type PullTaxonomiesResult,
} from '../../sync/taxonomies.js';
import { pullMedia } from '../../sync/media.js';
import { DEFAULT_CONFIG } from '../../utils/config.js';
import { toStorageKey, type StorageKey } from '../../utils/media-id.js';
import { isCanonicalUlid } from '../../utils/ulid.js';
import {
  resolveAndPersistLocalMediaRefs,
  resolveExplicitBooleanOption,
  type CliContextResolver,
} from '../context.js';
import { reportActionFailure } from '../report-failure.js';
import {
  formatOrphanMediaWarning,
  formatMediaCoverageLine,
  formatPrunedTaxonomiesNotice,
} from '../../presentation/article_report.js';

export { formatOrphanMediaWarning, formatMediaCoverageLine, formatPrunedTaxonomiesNotice };

/** Prints the unresolved media warning when a pull could not resolve body storageKeys locally. */
function reportOrphanStorageKeys(orphanStorageKeys: string[] | undefined): void {
  const warning = formatOrphanMediaWarning(orphanStorageKeys);
  if (warning) console.warn(warning);
}

export function formatPullWindowLabel(status: string | undefined, limit: number): string {
  return status === 'all' ? `${limit}/status` : `${limit}`;
}

/**
 * Renders the per-article media summary. A migrated corpus bakes R2 storageKeys into body URLs, so the
 * ids collected from those URLs mostly resolve to nothing; that is reported as expected resolution data,
 * never as a failure. Only a reference no id lookup and no storageKey check could match is a failure.
 */
export function formatArticleMediaSummary(res: {
  articleId?: string;
  total: number;
  downloaded: number;
  skipped: number;
  failed?: number;
  unresolvedIds?: number;
  verifiedStorageKeys?: string[];
}): string {
  const parts = [`${res.downloaded} downloaded`, `${res.skipped} skipped/up-to-date`];
  if (res.failed) parts.push(`${res.failed} unresolved`);
  const mirrored =
    res.verifiedStorageKeys?.length ?? res.total - (res.failed ?? 0) - res.downloaded - res.skipped;
  if (mirrored > 0) parts.push(`${mirrored} verified/mirrored`);
  const body = parts.join(', ');
  const note =
    res.unresolvedIds && !res.failed
      ? ` (${res.unresolvedIds} body ULID(s) are R2 storageKeys, not media record ids, so no id lookup was expected to match)`
      : '';
  return `✅ Media sync for article '${res.articleId || ''}' complete: ${res.total} referenced item(s) (${body}).${note}`;
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

function printTaxonomySyncSummary(
  res: PullTaxonomiesResult,
  indent = '',
  successLabel = 'Taxonomies:',
  suffix = '',
): void {
  const prunedCat = res.deletedCategoriesCount
    ? `, ${res.deletedCategoriesCount} categories pruned`
    : '';
  const prunedTag = res.deletedTagsCount ? `, ${res.deletedTagsCount} tags pruned` : '';
  if (res.categoriesFailed) {
    console.warn(
      `${indent}⚠️  Failed to fetch remote categories: preserved existing local definitions.`,
    );
  }
  if (res.tagsFailed) {
    console.warn(`${indent}⚠️  Failed to fetch remote tags: preserved existing local definitions.`);
  }
  if (!res.categoriesFailed || !res.tagsFailed) {
    console.log(
      `${indent}✅ ${successLabel} ${res.categoriesCount} categories, ${res.tagsCount} tags${prunedCat}${prunedTag}${suffix}`,
    );
  }
}

export function registerPullCommands(program: Command, resolveContext: CliContextResolver): void {
  // emit pull [target]
  program
    .command('pull [target]')
    .description(
      'Pull articles and taxonomies from remote EmDash into workspace (or specific article by ID or file path)',
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
    .option('--no-media', 'Skip automatic on-demand media mirroring')
    .option(
      '--media',
      'Additionally pull the FULL remote media library into media/ (not just assets referenced by pulled articles). Local-first mirroring of referenced assets is already default-ON.',
    )
    .option(
      '--metadata-only',
      'With --media: download only metadata YAML, skip binary file downloads.',
    )
    .option(
      '--local-media-refs',
      'Write mirrored body images as article-relative "../../media/<storageKey>" references so Markdown preview resolves them locally. Remembered in .emit/config.json.',
    )
    .option(
      '--no-local-media-refs',
      'Disable a remembered local-media-ref preference and store canonical EmDash URLs on disk again.',
    )
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (target, options, command) => {
      const ctx = resolveContext(options.profile);
      const collection = options.collection || ctx.config.defaultCollection;
      const postsOnly = options.postsOnly === true;

      // Distinguish explicit --no-media vs --media.
      // Note: options.media is intentionally unreferenced; resolveExplicitBooleanOption(command, 'media')
      // is the single source of truth to avoid Commander's synthetic boolean defaults on --no-* options.
      const explicitMedia = resolveExplicitBooleanOption(command, 'media');
      let mediaSync = !postsOnly;
      let includeMedia = false;
      if (explicitMedia === false) {
        mediaSync = false;
        includeMedia = false;
      } else if (explicitMedia === true) {
        mediaSync = !postsOnly;
        includeMedia = true;
      }

      const localMediaRefs = resolveAndPersistLocalMediaRefs(ctx, options.localMediaRefs);

      try {
        let targetId: string | undefined = undefined;
        if (target) {
          const isUlid = isCanonicalUlid(target.trim());
          const isPathLike =
            !isUlid &&
            (target.includes('/') || target.includes(path.sep) || target.endsWith('.md'));
          const resolved = resolveArticleTarget({
            workspaceRoot: ctx.root,
            filePath: isPathLike ? target : undefined,
            id: !isPathLike ? target.trim() : undefined,
            cache: ctx.cache,
          });
          if (!resolved.id) {
            throw new ApiError({
              message: `Could not resolve article target: "${target}"`,
              code: 'ARTICLE_TARGET_UNRESOLVED',
              status: 400,
              suggestion: `Verify that target "${target}" is a valid 26-character ULID or a path to an existing article file.`,
            });
          }
          targetId = resolved.id;
        }

        if (!targetId) {
          // Batch mode: taxonomies + articles (+ media if --media)
          if (!postsOnly) {
            console.log('Syncing categories and tags...');
          }

          // Pull articles and taxonomies via orchestrator facade
          const limit =
            ctx.config.postsSyncLimit || ctx.config.syncLimit || DEFAULT_CONFIG.postsSyncLimit;

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
            localMediaRefs,
            concurrency,
            prune: options.prune,
            postsOnly,
            onTaxonomySync: (taxResult) => {
              printTaxonomySyncSummary(taxResult, '  ', 'Taxonomies:');
              const taxSummary = getLocalTaxonomiesSummary(ctx.root);
              const taxHint = formatTaxonomiesHint(taxSummary, { maxTags: 30 });
              if (taxHint) {
                console.log(`\n${taxHint}\n`);
              }
            },
            // Local-first media mirroring is default-ON for a batch pull. `--posts-only` skips it entirely;
            // the full-library walk stays on the dedicated `emit pull-media --all` command below. The shared
            // walk is bounded by `mediaSyncLimit`, so a fleet-scale library never costs an unbounded scan.
            mediaSync: !postsOnly,
            mediaSyncLimit: ctx.config.mediaSyncLimit || DEFAULT_CONFIG.mediaSyncLimit,
            onProgress: ({ current, total, item }) => {
              if (item.deleted) {
                console.log(`  [${current}/${total}] 🗑️  Pruned ${item.slug} -> ${item.filePath}`);
              } else if (item.healed) {
                if (item.prunedTaxonomies) {
                  const notice = formatPrunedTaxonomiesNotice(item.prunedTaxonomies);
                  console.log(
                    `  [${current}/${total}] ${notice ?? `🛠️  Repaired frontmatter for ${item.slug}`}`,
                  );
                } else {
                  console.log(
                    `  [${current}/${total}] 🛠️  Repaired frontmatter syntax for ${item.slug} (${item.filePath}, local body preserved). Push the file to apply changes to the server.`,
                  );
                }
              } else if (item.localEditsPreserved) {
                console.log(
                  `\n  [${current}/${total}] 🛡️  Kept local edits for ${item.slug} (${item.filePath}; remote changes NOT applied)`,
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

          // Local-first media mirror summary. The walk is JSON-only; only assets referenced by pulled
          // article bodies were downloaded. Report the coverage honestly and never claim a record is absent.
          if (batchResult.media) {
            const m = batchResult.media;
            const totalLabel =
              typeof m.remoteTotalCount === 'number' && m.remoteTotalCount > 0
                ? `${m.walkedCount}/${m.remoteTotalCount}`
                : `${m.walkedCount}${m.complete ? '' : '+'}`;
            console.log(
              `\n🖼️  Media (local-first): walked ${totalLabel} record(s), mirrored ${m.mirroredStorageKeys.length} referenced asset(s) (${m.downloaded} downloaded, ${m.skipped} up-to-date).`,
            );
            if (m.orphanStorageKeys.length > 0) {
              reportOrphanStorageKeys(m.orphanStorageKeys);
            }
          }

          // 3. Pull media (if --media)
          if (includeMedia) {
            const mediaLimit = ctx.config.mediaSyncLimit || DEFAULT_CONFIG.mediaSyncLimit;
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
              cache: ctx.cache,
            });
            console.log(
              `  ✅ Media: ${mediaResult.total} items (${mediaResult.downloaded} downloaded, ${mediaResult.skipped} up-to-date)`,
            );
          }
        } else {
          // Single article mode: pull article and synchronize taxonomies (unless --posts-only)
          if (includeMedia) {
            console.log('Pulling media library assets...');
          }

          const singlePull = await pullSingleArticle({
            collection,
            targetId,
            workspaceRoot: ctx.root,
            cache: ctx.cache,
            origin: ctx.origin,
            token: ctx.auth.token,
            refreshToken: ctx.auth.refreshToken,
            force: options.force,
            postsOnly,
            localMediaRefs,
            mediaSync,
            includeMedia,
            metadataOnly: options.metadataOnly === true,
            mediaSyncLimit: ctx.config.mediaSyncLimit || DEFAULT_CONFIG.mediaSyncLimit,
          });

          if (singlePull.taxonomies) {
            if (singlePull.taxonomies.error) {
              console.warn(`⚠️ Warning: Failed to sync taxonomies: ${singlePull.taxonomies.error}`);
            } else if (singlePull.taxonomies.categoriesFailed || singlePull.taxonomies.tagsFailed) {
              console.warn(
                '⚠️ Warning: Failed to sync some remote taxonomies (preserved existing local definitions).',
              );
            }
          }

          const res = singlePull.article;
          if (res.deleted) {
            console.log(`🗑️ Remote article was deleted. Pruned local file: ${res.filePath}`);
          } else if (res.healed) {
            if (res.prunedTaxonomies) {
              const notice = formatPrunedTaxonomiesNotice(res.prunedTaxonomies);
              console.log(notice ?? `🛠️ Repaired frontmatter for ${res.slug}`);
              console.log(
                `   Push the file to apply changes to the server: "emit push ${res.filePath}"`,
              );
            } else {
              console.log(
                `🛠️ Repaired frontmatter syntax for ${res.slug} (${res.filePath}; unpushed local body was strictly preserved).`,
              );
              console.log(
                `   Push the file to apply changes to the server: "emit push ${res.filePath}"`,
              );
            }
          } else if (res.localEditsPreserved) {
            console.log(
              `🛡️ Kept 1 local edit(s); 1 remote change(s) NOT applied (${res.filePath}).`,
            );
            console.log(
              `   Push them with "emit push ${res.filePath}", or re-run with --force to accept remote.`,
            );
          } else if (res.skipped) {
            console.log(`ℹ️ Article ${res.slug} is already up-to-date (${res.filePath})`);
          } else {
            console.log(`✅ Pulled ${res.slug} -> ${res.filePath}`);
          }

          if (res.media && res.media.total > 0) {
            console.log(
              `  ✅ Media: ${res.media.total} item(s) (${res.media.downloaded} downloaded, ${res.media.skipped} up-to-date)`,
            );
            const orphanWarning = formatOrphanMediaWarning(res.media.orphanStorageKeys);
            if (orphanWarning) {
              console.log(`\n${orphanWarning}`);
            }
          }

          if (singlePull.libraryMedia) {
            console.log(
              `  ✅ Media library: ${singlePull.libraryMedia.total} items (${singlePull.libraryMedia.downloaded} downloaded, ${singlePull.libraryMedia.skipped} up-to-date)`,
            );
          }

          const quarantineNotice = formatQuarantineNotice(res.quarantined);
          if (quarantineNotice) console.log(`\n${quarantineNotice}`);
        }
      } catch (error) {
        reportActionFailure(error);
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
        printTaxonomySyncSummary(res, '', 'Successfully synced taxonomies:', '.');
        const taxSummary = getLocalTaxonomiesSummary(ctx.root);
        const taxHint = formatTaxonomiesHint(taxSummary, { maxTags: 60 });
        if (taxHint) {
          console.log(`\n${taxHint}`);
        }
        if (res.categoriesFailed && res.tagsFailed) {
          process.exit(1);
        }
      } catch (error) {
        reportActionFailure(error);
      }
    });

  // emit pull-media
  program
    .command('pull-media')
    .description('Pull remote media files and metadata YAML into local media/ directory')
    .option(
      '-a, --article <id-or-path>',
      'Target specific article ID (ULID) or Markdown file path to pull only referenced media',
    )
    .option(
      '-c, --collection <collection>',
      'Collection name when using --article (defaults to "posts")',
    )
    .option('-l, --limit <number>', 'Maximum media items to fetch (default: 300 or config)')
    .option(
      '--storage-key <key>',
      'Target specific storageKey to mirror (can be specified multiple times)',
      (val: string, prev: string[] = []) => [...prev, val],
    )
    .option(
      '--all',
      'Fetch ALL media files from remote (maintenance only — routine workflows do not need this)',
    )
    .option(
      '--prune',
      'Prune local media whose companion .yaml names a deleted remote record (files without a companion are left untouched)',
    )
    .option('--metadata-only', 'Do not download binary files, only metadata YAML')
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (options) => {
      if (options.storageKey && options.storageKey.length > 0) {
        if (options.article || options.all) {
          console.error('❌ Error: --storage-key cannot be combined with --article or --all.');
          process.exit(1);
        }
      }

      const ctx = resolveContext(options.profile);
      const limit = options.all
        ? undefined
        : options.limit
          ? parseInt(options.limit, 10)
          : ctx.config.mediaSyncLimit || DEFAULT_CONFIG.mediaSyncLimit;

      try {
        if (options.storageKey && options.storageKey.length > 0) {
          const keys: StorageKey[] = [];
          for (const raw of options.storageKey as string[]) {
            const parsed = toStorageKey(raw);
            if (!parsed) {
              console.error(`❌ Error: Invalid storageKey format: "${raw}"`);
              process.exit(1);
            }
            keys.push(parsed);
          }
          console.log(`Pulling ${keys.length} targeted media asset(s)...`);
          const res = await pullMedia({
            workspaceRoot: ctx.root,
            origin: ctx.origin,
            token: ctx.auth.token,
            refreshToken: ctx.auth.refreshToken,
            storageKeys: keys,
            downloadFiles: !options.metadataOnly,
            cache: ctx.cache,
          });

          if (res.total === 0 && res.orphanStorageKeys && res.orphanStorageKeys.length > 0) {
            console.error(
              `❌ Error: Could not resolve targeted storageKey(s) on remote: ${res.orphanStorageKeys.join(', ')}`,
            );
            reportOrphanStorageKeys(res.orphanStorageKeys);
            process.exit(1);
          }

          // Nothing was (re)downloaded and nothing failed either: the walk left the key outside its window, or
          // local mirror metadata already confirms it. Report that instead of claiming a successful sync.
          if (res.total === 0) {
            const reason =
              res.verifiedStorageKeys && res.verifiedStorageKeys.length > 0
                ? 'confirmed by local mirror metadata already in media/'
                : 'not found within the bounded library walk';
            console.log(
              `ℹ️ Targeted storageKey(s) not downloaded: ${keys.join(', ')} (${reason}). Run "emit pull-media --all" (or a larger --limit) for a complete library pass.`,
            );
            return;
          }

          console.log(
            `✅ Media sync complete: ${res.total} total items (${res.downloaded} downloaded, ${res.skipped} skipped/up-to-date).`,
          );
          reportOrphanStorageKeys(res.orphanStorageKeys);
          return;
        }

        if (options.article) {
          console.log(`Pulling media referenced by article '${options.article}'...`);
          const res = await pullMedia({
            workspaceRoot: ctx.root,
            origin: ctx.origin,
            token: ctx.auth.token,
            refreshToken: ctx.auth.refreshToken,
            article: options.article,
            collection: options.collection || ctx.config.defaultCollection,
            downloadFiles: !options.metadataOnly,
            cache: ctx.cache,
          });

          console.log(
            formatArticleMediaSummary({ ...res, articleId: res.articleId || options.article }),
          );
          reportOrphanStorageKeys(res.orphanStorageKeys);
          return;
        }

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
          cache: ctx.cache,
        });

        const deletedMsg = res.deleted ? `, ${res.deleted} pruned` : '';
        console.log(
          `✅ Media sync complete: ${res.total} total items (${res.downloaded} downloaded, ${res.skipped} skipped/up-to-date${deletedMsg}).${formatMediaCoverageLine(res)}`,
        );
      } catch (error) {
        reportActionFailure(error);
      }
    });
}
