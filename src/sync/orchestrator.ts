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

import fs from 'node:fs';
import path from 'node:path';
import type { CacheDatabase, SyncState } from '../db/cache.js';
import {
  listRemoteArticles,
  pullArticle,
  createMediaMirrorSession,
  type PullResult,
  type ListRemoteArticlesOptions,
} from './pull/index.js';
import { findLocalFilesByUlid } from './workspace/index.js';
import { pushArticle, type PushResult, type PushOptions } from './push/index.js';
import { getWorkspaceStatus, selectPushCandidates } from './status.js';
import { isLocalFileUnmodified } from './baseline-reconstruction.js';
import { syncRemoteBylines } from './bylines.js';
import {
  loadLocalTaxonomyCandidates,
  pullTaxonomies,
  type PullTaxonomiesResult,
} from './taxonomies.js';
import { pullMedia, type PullMediaResult } from './media/index.js';
import { updateConfigSyncedVersion } from '../utils/config.js';
import {
  resolveConcurrency,
  resolveMediaSyncLimit,
  resolvePostsSyncLimit,
} from '../utils/sync-limit-precedence.js';

export interface UnpushedConflictItem {
  id: string;
  slug: string;
  filePath: string;
}

export class SyncPruneConflictError extends Error {
  public conflictItems: UnpushedConflictItem[];
  public limit?: number;

  constructor(message: string, conflictItems: UnpushedConflictItem[], limit?: number) {
    super(message);
    this.name = 'SyncPruneConflictError';
    this.conflictItems = conflictItems;
    this.limit = limit;
  }
}

export type OrchestratorTaxonomiesResult = PullTaxonomiesResult & { error?: string };

export interface PullBatchOptions extends ListRemoteArticlesOptions {
  workspaceRoot: string;
  cache: CacheDatabase;
  collection: string;
  force?: boolean;
  concurrency?: number;
  prune?: boolean;
  /** Write mirrored body images as article-relative `../../media/<storageKey>` references. Passed to every article pull. */
  localMediaRefs?: boolean;
  /**
   * Local-first media mirroring is default-ON for a batch pull: after articles land on disk, Emit walks the
   * remote media library once (JSON only), then downloads binaries for exactly the storageKeys those article
   * bodies reference. Pass `false` to skip the walk and every binary download — this is what `--posts-only`
   * uses. The full-library `emit pull-media --all` path stays a separate command, unaffected by this flag.
   */
  mediaSync?: boolean;
  /** Bounds the shared library walk used to resolve referenced assets (default `mediaSyncLimit`). */
  mediaSyncLimit?: number;
  /** When true, skips taxonomy synchronization before article batch pull. */
  postsOnly?: boolean;
  onTaxonomySync?: (result: OrchestratorTaxonomiesResult) => void;
  onProgress?: (progress: { current: number; total: number; item: PullResult }) => void;
}

export interface PullBatchResult {
  total: number;
  updated: number;
  skipped: number;
  deleted?: number;
  /** Articles whose unpushed local edits were kept instead of applying remote changes. */
  preserved?: number;
  /** Window-out prune candidates kept on disk because they (or a ULID-sharing duplicate) have unpushed local edits. */
  pruneSkipped?: UnpushedConflictItem[];
  /** Effective sliding window limit resolved for this batch pull. */
  windowLimit?: number;
  /** Total number of divergent local copies preserved under `<collection>/conflicts/`. */
  quarantined?: number;
  /**
   * Local-first media mirror stage result: the lightweight library walk plus the binaries downloaded for
   * exactly the storageKeys referenced by pulled article bodies. Absent when `mediaSync` was disabled.
   */
  media?: {
    walkedCount: number;
    remoteTotalCount: number | null;
    complete: boolean;
    downloaded: number;
    skipped: number;
    mirroredStorageKeys: string[];
    verifiedStorageKeys: string[];
    orphanStorageKeys: string[];
  };
  items: PullResult[];
  taxonomies?: OrchestratorTaxonomiesResult;
}

export interface PullSingleArticleOptions {
  collection: string;
  targetId: string;
  workspaceRoot: string;
  cache: CacheDatabase;
  origin: string;
  token: string;
  refreshToken?: string;
  force?: boolean;
  postsOnly?: boolean;
  localMediaRefs?: boolean;
  mediaSync?: boolean;
  includeMedia?: boolean;
  metadataOnly?: boolean;
  mediaSyncLimit?: number;
  fetchFn?: typeof fetch;
}

export interface PullSingleArticleResult {
  article: PullResult;
  taxonomies?: OrchestratorTaxonomiesResult;
  libraryMedia?: PullMediaResult;
}

/**
 * Orchestrates single article pull including optional taxonomy sync and media library sync.
 * Reusable across CLI and MCP servers to ensure consistent single-article workflow.
 */
export async function pullSingleArticle(
  options: PullSingleArticleOptions,
): Promise<PullSingleArticleResult> {
  let taxonomiesResult: OrchestratorTaxonomiesResult | undefined = undefined;

  if (!options.postsOnly) {
    try {
      const taxRes = await pullTaxonomies({
        workspaceRoot: options.workspaceRoot,
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        fetchFn: options.fetchFn,
      });
      if (taxRes.categoriesFailed || taxRes.tagsFailed) {
        taxonomiesResult = taxRes;
      }
    } catch (err) {
      taxonomiesResult = {
        categoriesCount: 0,
        tagsCount: 0,
        deletedCategoriesCount: 0,
        deletedTagsCount: 0,
        error: (err as Error).message,
      };
    }
  }

  const taxonomiesFailed = Boolean(
    taxonomiesResult?.categoriesFailed || taxonomiesResult?.tagsFailed || taxonomiesResult?.error,
  );
  const canPruneTaxonomies = !options.postsOnly && !taxonomiesFailed;

  // R-2 (v0.1.37): media walk bound resolved through the shared Layer 0 helper (see pullBatch).
  const mediaSyncLimit = resolveMediaSyncLimit({}, { mediaSyncLimit: options.mediaSyncLimit });

  const article = await pullArticle(options.collection, options.targetId, {
    workspaceRoot: options.workspaceRoot,
    cache: options.cache,
    origin: options.origin,
    token: options.token,
    refreshToken: options.refreshToken,
    force: options.force,
    localMediaRefs: options.localMediaRefs,
    mediaSync: options.mediaSync,
    mediaSyncLimit,
    fetchFn: options.fetchFn,
    canPruneTaxonomies,
  });

  let libraryMedia: PullMediaResult | undefined = undefined;
  if (options.includeMedia) {
    libraryMedia = await pullMedia({
      workspaceRoot: options.workspaceRoot,
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      limit: mediaSyncLimit,
      downloadFiles: options.metadataOnly !== true,
      cache: options.cache,
      fetchFn: options.fetchFn,
    });
  }

  return { article, taxonomies: taxonomiesResult, libraryMedia };
}

/**
 * Orchestrates batch pulling of articles for a collection.
 * Reusable across CLI and MCP servers to ensure consistent behavior.
 */
export async function pullBatch(options: PullBatchOptions): Promise<PullBatchResult> {
  // R-2 (v0.1.37): the batch window is resolved through the shared Layer 0 precedence helper so
  // CLI, MCP, and this orchestrator can never drift apart. `options.all` intentionally keeps an
  // unbounded window: transport receives undefined limit with all:true below, while pruning
  // diagnostics (windowLimit / formatPruneSkippedArticlesNotice) report the DEFAULT_CONFIG fallback that a
  // non-all run would use — matching listRemoteArticles' own ?? 100 transport fallback is out
  // of scope here; only the presentation value changes.
  const limit = resolvePostsSyncLimit({}, { postsSyncLimit: options.limit });
  const mediaSyncLimit = resolveMediaSyncLimit({}, { mediaSyncLimit: options.mediaSyncLimit });
  // Synchronize remote taxonomies safely unless postsOnly
  let taxonomiesResult: OrchestratorTaxonomiesResult | undefined = undefined;

  if (!options.postsOnly) {
    try {
      const taxRes = await pullTaxonomies({
        workspaceRoot: options.workspaceRoot,
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        fetchFn: options.fetchFn,
      });
      taxonomiesResult = taxRes;
    } catch (err) {
      taxonomiesResult = {
        categoriesCount: 0,
        tagsCount: 0,
        deletedCategoriesCount: 0,
        deletedTagsCount: 0,
        error: (err as Error).message,
      };
    }
    if (options.onTaxonomySync && taxonomiesResult) {
      options.onTaxonomySync(taxonomiesResult);
    }
  }

  const taxonomiesFailed = Boolean(
    taxonomiesResult?.categoriesFailed || taxonomiesResult?.tagsFailed || taxonomiesResult?.error,
  );
  const canPruneTaxonomies = !options.postsOnly && !taxonomiesFailed;

  // Synchronize remote bylines into local SQLite cache before pulling articles
  const bylineMaps = await syncRemoteBylines({
    origin: options.origin,
    token: options.token,
    refreshToken: options.refreshToken,
    cache: options.cache,
    fetchFn: options.fetchFn,
  }).catch(() => options.cache.getBylineMaps());

  const candidates = loadLocalTaxonomyCandidates(options.workspaceRoot);

  const mediaSession =
    options.mediaSync !== false
      ? createMediaMirrorSession({
          workspaceRoot: options.workspaceRoot,
          origin: options.origin,
          token: options.token,
          refreshToken: options.refreshToken,
          cache: options.cache,
          fetchFn: options.fetchFn,
          downloadFiles: true,
          isSharedSession: true,
          limit: mediaSyncLimit,
        })
      : undefined;

  const remoteList = await listRemoteArticles(options.collection, {
    origin: options.origin,
    token: options.token,
    refreshToken: options.refreshToken,
    limit: options.all ? undefined : limit,
    all: options.all,
    status: options.status,
    fetchFn: options.fetchFn,
  });

  const shouldPrune = options.prune !== false;
  let candidatesToPrune: SyncState[] = [];
  const pruneSkippedArticles: UnpushedConflictItem[] = [];

  if (shouldPrune) {
    const remoteIdSet = new Set(remoteList.map((r) => r.id));
    const allLocalSyncs = options.cache.getAllSyncStates();
    const collectionEntries = options.cache.listEntries(options.collection);
    const collectionEntryIds = new Set(collectionEntries.map((e) => e.id));
    const targetStatus = options.status || 'all';

    for (const syncState of allLocalSyncs) {
      const belongsToCollection =
        collectionEntryIds.has(syncState.id) ||
        syncState.localFilePath.startsWith(options.collection + path.sep) ||
        syncState.localFilePath.startsWith(options.collection + '/');

      if (!belongsToCollection) continue;

      if (targetStatus !== 'all' && syncState.status !== targetStatus) {
        continue;
      }

      if (!remoteIdSet.has(syncState.id)) {
        candidatesToPrune.push(syncState);
      }
    }

    // Safety guard: Check if any pushed-out candidate (or duplicate file sharing its ULID) has unpushed local changes
    const unpushedConflicts: UnpushedConflictItem[] = [];
    for (const candidate of candidatesToPrune) {
      const candidatePaths = new Set<string>([
        candidate.localFilePath,
        ...findLocalFilesByUlid(options.workspaceRoot, options.collection, candidate.id),
      ]);
      for (const relPath of candidatePaths) {
        const fullPath = path.join(options.workspaceRoot, relPath);
        if (fs.existsSync(fullPath)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            if (
              !isLocalFileUnmodified({
                workspaceRoot: options.workspaceRoot,
                cache: options.cache,
                id: candidate.id,
                relPath,
                localContent: content,
                syncState: candidate,
                candidates,
                healOnSpellingMatch: false,
              })
            ) {
              unpushedConflicts.push({
                id: candidate.id,
                slug: candidate.slug,
                filePath: relPath,
              });
            }
          } catch {
            // If read fails, safely ignore
          }
        }
      }
    }

    if (unpushedConflicts.length > 0) {
      const skippedUlids = new Set(unpushedConflicts.map((i) => i.id));
      candidatesToPrune = candidatesToPrune.filter((c) => !skippedUlids.has(c.id));

      const seenFiles = new Set<string>();
      for (const item of unpushedConflicts) {
        if (!seenFiles.has(item.filePath)) {
          seenFiles.add(item.filePath);
          pruneSkippedArticles.push(item);
        }
      }
    }
  }

  const results: PullResult[] = [];
  let updated = 0;
  let skipped = 0;
  let preserved = 0;
  let quarantined = 0;

  const concurrency = resolveConcurrency({}, { concurrency: options.concurrency });
  let index = 0;

  const worker = async () => {
    while (index < remoteList.length) {
      const currentIndex = index++;
      const item = remoteList[currentIndex];
      const res = await pullArticle(options.collection, item.id, {
        workspaceRoot: options.workspaceRoot,
        cache: options.cache,
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        rawItem: item.rawItem,
        force: options.force,
        localMediaRefs: options.localMediaRefs,
        fetchFn: options.fetchFn,
        bylineIdToSlug: bylineMaps.idToSlug,
        bylineSlugToId: bylineMaps.slugToId,
        candidates,
        mediaSync: options.mediaSync,
        mediaSession,
        canPruneTaxonomies,
      });

      results.push(res);
      if (res.skipped) skipped++;
      else updated++;
      if (res.localEditsPreserved) preserved++;
      if (res.quarantined) quarantined += res.quarantined.length;

      if (options.onProgress) {
        options.onProgress({
          current: results.length,
          total: remoteList.length + candidatesToPrune.length,
          item: res,
        });
      }
    }
  };

  const pool = Array.from({ length: Math.min(concurrency, remoteList.length) }, () => worker());
  await Promise.all(pool);

  // Prune local cached entries that are outside the sync window (or remote-deleted)
  let deleted = 0;
  if (shouldPrune) {
    for (const candidate of candidatesToPrune) {
      const pathsToRemove = new Set<string>([
        candidate.localFilePath,
        ...findLocalFilesByUlid(options.workspaceRoot, options.collection, candidate.id),
      ]);
      for (const relToRemove of pathsToRemove) {
        const fullPath = path.join(options.workspaceRoot, relToRemove);
        if (fs.existsSync(fullPath)) {
          try {
            fs.unlinkSync(fullPath);
          } catch {
            // ignore
          }
        }
      }
      options.cache.deleteEntry(candidate.id);
      deleted++;

      const deletedResult: PullResult = {
        id: candidate.id,
        slug: candidate.slug,
        status: candidate.status,
        filePath: candidate.localFilePath,
        updated: false,
        deleted: true,
      };
      results.push(deletedResult);

      if (options.onProgress) {
        options.onProgress({
          current: results.length,
          total: remoteList.length + candidatesToPrune.length,
          item: deletedResult,
        });
      }
    }
  }

  // Local-first media mirror stage: mediaSession mirrors referenced assets during each pullArticle
  // and aggregates deduplicated results. If mediaSync is enabled, finalize batch media summary.
  let mediaResult: PullBatchResult['media'];
  if (mediaSession && results.some((r) => !r.deleted)) {
    mediaResult = await mediaSession.finalizeBatchMediaResult();
  }

  updateConfigSyncedVersion(options.workspaceRoot);

  return {
    total: remoteList.length,
    updated,
    skipped,
    deleted,
    preserved,
    pruneSkipped: pruneSkippedArticles.length > 0 ? pruneSkippedArticles : undefined,
    windowLimit: limit,
    quarantined,
    media: mediaResult,
    items: results,
    taxonomies: taxonomiesResult,
  };
}

export interface PushAllOptions extends Omit<PushOptions, 'rawItem'> {
  workspaceRoot: string;
  cache: CacheDatabase;
  collection?: string;
}

export interface PushAllResult {
  total: number;
  pushed: number;
  skipped: number;
  invalid: number;
  results: PushResult[];
  skippedItems?: Array<{
    slug: string;
    filePath: string;
    reason: 'conflict_pending' | 'delete_pending' | 'taxonomy_apply_pending';
  }>;
}

/**
 * Orchestrates pushing all modified/untracked files in the workspace.
 * Excludes synced, conflict_pending, delete_pending, taxonomy_apply_pending, and invalid (YAML parse error) files.
 * Reusable across CLI and MCP servers.
 */
export async function pushAll(options: PushAllOptions): Promise<PushAllResult> {
  const status = getWorkspaceStatus(options.workspaceRoot, options.cache, options.collection);
  const { toPush, skipped: skippedItems } = selectPushCandidates(status);

  const results: PushResult[] = [];
  let pushed = 0;

  for (const item of toPush) {
    const res = await pushArticle(item.filePath, {
      workspaceRoot: options.workspaceRoot,
      cache: options.cache,
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      allowPublish: options.allowPublish,
      allowModifiedOpaqueBlocks: options.allowModifiedOpaqueBlocks,
      fetchFn: options.fetchFn,
      // Batch push must honor the same setting single push does, or a workspace that spells mirrored images as
      // local references gets every one of them rewritten to canonical URLs on disk.
      localMediaRefs: options.localMediaRefs,
    });
    results.push(res);
    pushed++;
  }

  return {
    total: toPush.length,
    pushed,
    skipped: status.items.length - toPush.length,
    invalid: status.summary.invalid,
    results,
    ...(skippedItems.length > 0 ? { skippedItems } : {}),
  };
}
