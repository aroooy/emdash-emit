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
import { persistLocalMediaRefs, DEFAULT_CONFIG } from '../../utils/config.js';
import { ApiError } from '../../client/error.js';
import type { CliContextResolver } from '../context.js';

/** Prints the unresolved media warning when a pull could not resolve body storageKeys locally. */
function reportOrphanStorageKeys(orphanStorageKeys: string[] | undefined): void {
  const warning = formatOrphanMediaWarning(orphanStorageKeys);
  if (warning) console.warn(warning);
}

export function formatPullWindowLabel(status: string | undefined, limit: number): string {
  return status === 'all' ? `${limit}/status` : `${limit}`;
}

/**
 * Reports body image references that neither a remote media record nor confirmed local mirror metadata
 * could resolve. Emit only knows that *its* lookups failed; it never claims the D1 record is absent,
 * because `GET /_emdash/api/media/{id}` keys on the primary key while the body URL carries the R2
 * storageKey, so a real record can 404 here. The advice is therefore "verify before you write": inspect
 * the media library by storageKey (or the migration mapping) and only then register anything, since a
 * blind INSERT risks a duplicate registration. Emit mirrors records and never repairs server data.
 */
export function formatOrphanMediaWarning(orphanStorageKeys: string[] | undefined): string {
  if (!orphanStorageKeys || orphanStorageKeys.length === 0) return '';
  const keyList = orphanStorageKeys.join(', ');
  return (
    `⚠️ [UNRESOLVED_MEDIA_ASSET] ${orphanStorageKeys.length} storageKey(s) referenced in article bodies ` +
    `could not be matched to a media record or a local mirror and were not downloaded: ${keyList}. ` +
    `These keys are R2 storage keys, not media record ids — GET /_emdash/api/media/{id} searches the ` +
    `primary key, so a 404 here does not prove the record is missing. The library's own storageKeys are ` +
    `reachable from Emit: run "emit doctor --check-media-library" (or "emit pull-media --all" for complete backup) to index ` +
    `every record the server reports, which resolves these keys without any server-side query. Verify by ` +
    `storageKey before registering anything: a blind INSERT can create a duplicate. Emit mirrors records ` +
    `and never repairs server data.`
  );
}

/**
 * Renders the coverage line for a library-wide media pull: how many records the server reports, how
 * many this run walked, and any referenced key that even a complete walk could not match.
 */
export function formatMediaCoverageLine(res: {
  total: number;
  remoteTotalCount?: number | null;
  referencedUnmirroredStorageKeys?: string[];
}): string {
  const parts: string[] = [];
  const remoteTotal = res.remoteTotalCount;
  if (typeof remoteTotal === 'number' && remoteTotal > 0) {
    parts.push(
      `remote library holds ${remoteTotal} record(s), of which this run walked ${res.total}`,
    );
  }
  const unmirrored = res.referencedUnmirroredStorageKeys;
  if (unmirrored && unmirrored.length > 0) {
    parts.push(
      `⚠️ [UNREFERENCED_REMOTE_MEDIA] ${unmirrored.length} body storageKey(s) match no record in the complete remote library and no local mirror: ${unmirrored.join(', ')}. This is a lookup result, not proof that a record is absent — verify by storageKey (after the complete library walk above) before registering anything, because a blind INSERT can duplicate an existing record.`,
    );
  }
  return parts.length > 0 ? `\n${parts.join('\n')}` : '';
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
    .action(async (id, options) => {
      const ctx = resolveContext(options.profile);
      const collection = options.collection || ctx.config.defaultCollection;
      const postsOnly = options.postsOnly === true;
      const includeMedia = options.media === true;

      // `--local-media-refs` is a workspace preference, not a per-run switch: remember it so every later
      // pull and push keeps the same spelling without having to repeat the flag. `--no-local-media-refs` clears
      // that preference again, because commander defaults the paired option to true and only an explicit negation
      // means the user asked to go back to canonical URLs.
      const localMediaRefs =
        options.localMediaRefs === false
          ? false
          : options.localMediaRefs === true
            ? true
            : ctx.config.localMediaRefs;
      if (options.localMediaRefs === true && ctx.config.localMediaRefs !== true) {
        persistLocalMediaRefs(ctx.root, true);
      } else if (options.localMediaRefs === false && ctx.config.localMediaRefs === true) {
        persistLocalMediaRefs(ctx.root, false);
      }

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
            // Local-first media mirroring is default-ON for a batch pull. `--posts-only` skips it entirely;
            // the full-library walk stays on the dedicated `emit pull-media --all` command below.
            mediaSync: !postsOnly,
            onProgress: ({ current, total, item }) => {
              if (item.deleted) {
                console.log(`  [${current}/${total}] 🗑️  Pruned ${item.slug} -> ${item.filePath}`);
              } else if (item.healed) {
                console.log(
                  `  [${current}/${total}] 🛠️  Repaired frontmatter syntax for ${item.slug} (${item.filePath}, local body preserved). Push the file to apply changes to the server.`,
                );
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
          if (!options.postsOnly) {
            await pullTaxonomies({
              workspaceRoot: ctx.root,
              origin: ctx.origin,
              token: ctx.auth.token,
              refreshToken: ctx.auth.refreshToken,
            }).catch(() => null);
          }
          const res = await pullArticle(collection, id, {
            workspaceRoot: ctx.root,
            cache: ctx.cache,
            origin: ctx.origin,
            token: ctx.auth.token,
            refreshToken: ctx.auth.refreshToken,
            force: options.force,
            localMediaRefs,
          });
          if (res.deleted) {
            console.log(`🗑️ Remote article was deleted. Pruned local file: ${res.filePath}`);
          } else if (res.healed) {
            console.log(
              `🛠️ Repaired frontmatter syntax for ${res.slug} (${res.filePath}; unpushed local body was strictly preserved).`,
            );
            console.log(
              `   Push the file to apply changes to the server: "emit push ${res.filePath}"`,
            );
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
          const keys = options.storageKey as string[];
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
        if (error instanceof ApiError) {
          console.error(`\n${error.toActionableString()}`);
          process.exit(1);
        }
        throw error;
      }
    });
}
