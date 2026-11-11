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
  calculateHash,
  carriesDepthFreeMediaRef,
  findLocalFilesByUlid,
  type PullResult,
  type ListRemoteArticlesOptions,
} from './pull.js';
import { pushArticle, type PushResult, type PushOptions } from './push.js';
import { getWorkspaceStatus } from './status.js';
import { syncRemoteBylines } from './bylines.js';
import { updateConfigSyncedVersion } from '../utils/config.js';
import {
  collectRemoteStorageKeys,
  mirrorReferencedAssetsFromIndex,
  collectArticleStorageKeys,
  type RemoteStorageKeyIndex,
  type MirroredAssetResult,
} from './media.js';
import { localizeArticleMediaRefs } from '../utils/media-body-refs.js';

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
  onProgress?: (progress: { current: number; total: number; item: PullResult }) => void;
}

export interface PullBatchResult {
  total: number;
  updated: number;
  skipped: number;
  deleted?: number;
  /** Articles whose unpushed local edits were kept instead of applying remote changes. */
  preserved?: number;
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
}

/**
 * Orchestrates batch pulling of articles for a collection.
 * Reusable across CLI and MCP servers to ensure consistent behavior.
 */
export async function pullBatch(options: PullBatchOptions): Promise<PullBatchResult> {
  // Synchronize remote bylines into local SQLite cache before pulling articles
  const bylineMaps = await syncRemoteBylines({
    origin: options.origin,
    token: options.token,
    refreshToken: options.refreshToken,
    cache: options.cache,
    fetchFn: options.fetchFn,
  }).catch(() => options.cache.getBylineMaps());

  const remoteList = await listRemoteArticles(options.collection, {
    origin: options.origin,
    token: options.token,
    refreshToken: options.refreshToken,
    limit: options.limit,
    all: options.all,
    status: options.status,
    fetchFn: options.fetchFn,
  });

  const shouldPrune = options.prune !== false;
  const candidatesToPrune: SyncState[] = [];

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
            const currentHash = calculateHash(content);
            if (currentHash !== candidate.localHash) {
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
      const affectedArticles = new Set(unpushedConflicts.map((i) => i.id)).size;
      const filesList = unpushedConflicts.map((i) => `  - ${i.filePath} (${i.slug})`).join('\n');
      const windowMsg = options.limit ? ` (currently: ${options.limit})` : '';
      const message =
        `Pull aborted: ${unpushedConflicts.length} file(s) belonging to ${affectedArticles} article(s) outside the sync window have unpushed local edits!\n\n` +
        `The following file(s) would be pruned from local cache, but contain unpushed changes` +
        ` (both the canonical file and any duplicate copy sharing its ULID are inspected):\n${filesList}\n\n` +
        `💡 Why did this happen?\n` +
        `The modified article(s) are older than the workspace sync window${windowMsg}.\n\n` +
        `Recommended actions:\n` +
        `  1. Push local changes:   emit push <filePath>\n` +
        `  2. Adjust sync window:   update "postsSyncLimit" in .emit/config.json if a larger window is needed\n` +
        `  3. Keep them for now:    emit pull --no-prune (skips window pruning; local files stay untouched)\n`;

      throw new SyncPruneConflictError(message, unpushedConflicts, options.limit);
    }
  }

  const results: PullResult[] = [];
  let updated = 0;
  let skipped = 0;
  let preserved = 0;
  let quarantined = 0;

  const concurrency = options.concurrency || 8;
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

  // Local-first media mirror stage (default ON). Articles are already on disk in canonical form, so their
  // bodies carry the exact storageKeys EmDash baked into them. Emit walks the remote library once — JSON
  // only, no binaries — then downloads binaries for exactly those referenced keys, reusing each walked
  // record instead of paying a per-asset `GET /_emdash/api/media/{id}`. Only assets an article actually
  // references are downloaded; the rest of the library is left to `emit pull-media --all`.
  let mediaResult: PullBatchResult['media'];
  if (options.mediaSync !== false && results.some((r) => !r.deleted)) {
    const index = await collectRemoteStorageKeys({
      workspaceRoot: options.workspaceRoot,
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      fetchFn: options.fetchFn,
    });

    const referencedKeys = new Set<string>();
    for (const res of results) {
      if (res.deleted || !res.filePath) continue;
      const fullPath = path.join(options.workspaceRoot, res.filePath);
      if (!fs.existsSync(fullPath)) continue;
      for (const descriptor of collectArticleStorageKeys(fs.readFileSync(fullPath, 'utf8'))) {
        referencedKeys.add(descriptor.storageKey);
      }
    }

    const mirrored: MirroredAssetResult = await mirrorReferencedAssetsFromIndex(
      referencedKeys,
      index,
      {
        workspaceRoot: options.workspaceRoot,
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        fetchFn: options.fetchFn,
        cache: options.cache,
      },
    );

    // Binaries now exist under `media/`, so re-apply the local-ref spelling to every article that mirrors
    // images. pullArticle wrote them canonical because no mirror existed yet; this pass resolves them to
    // article-relative references only when the mirror is actually present, keeping disk and preview in step
    // without ever touching the baseline hash (which stays canonical). Each file is localized at the depth of
    // its own path, so an article written by a legacy workspace keeps the spelling its bytes already carry.
    if (options.localMediaRefs) {
      for (const res of results) {
        if (res.deleted || !res.filePath) continue;
        const fullPath = path.join(options.workspaceRoot, res.filePath);
        if (!fs.existsSync(fullPath)) continue;
        const current = fs.readFileSync(fullPath, 'utf8');
        const localized = localizeArticleMediaRefs(current, {
          workspaceRoot: options.workspaceRoot,
          articleRelPath: res.filePath,
          fs,
          preferLegacyRef: carriesDepthFreeMediaRef(current),
        });
        if (localized === current) continue;
        fs.writeFileSync(fullPath, localized, 'utf8');
        // The pass rewrote the bytes on disk, so the tracked hash must follow them. `sync_state.local_hash`
        // records exactly what the file carries, and a re-spelled article whose hash still describes the
        // canonical form it held moments ago reports itself as an edit nobody made — every status pass would
        // call it modified while diff shows nothing. Only a tracked article needs re-tracking: an untracked
        // one has no baseline to stay honest with. Values are untouched; only the recorded hash advances.
        const tracked = options.cache.getSyncState(res.id);
        if (tracked) {
          options.cache.saveSyncState({ ...tracked, localHash: calculateHash(localized) });
        }
      }
    }

    mediaResult = {
      walkedCount: index.scannedCount,
      remoteTotalCount: index.totalCount,
      complete: index.complete,
      downloaded: mirrored.downloaded,
      skipped: mirrored.skipped,
      mirroredStorageKeys: [...mirrored.mirroredStorageKeys],
      verifiedStorageKeys: mirrored.verifiedStorageKeys,
      orphanStorageKeys: mirrored.orphanStorageKeys,
    };
  }

  updateConfigSyncedVersion(options.workspaceRoot);

  return {
    total: remoteList.length,
    updated,
    skipped,
    deleted,
    preserved,
    quarantined,
    media: mediaResult,
    items: results,
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
  const eligibleItems = status.items.filter(
    (i) => i.syncStatus === 'modified' || i.syncStatus === 'untracked',
  );

  const skippedItems: Array<{
    slug: string;
    filePath: string;
    reason: 'conflict_pending' | 'delete_pending' | 'taxonomy_apply_pending';
  }> = [];
  const toPush = eligibleItems.filter((i) => {
    if (i.deletePending) {
      skippedItems.push({ slug: i.slug, filePath: i.filePath, reason: 'delete_pending' });
      return false;
    }
    if (i.conflictPending) {
      skippedItems.push({ slug: i.slug, filePath: i.filePath, reason: 'conflict_pending' });
      return false;
    }
    if (i.taxonomyApplyPending) {
      skippedItems.push({ slug: i.slug, filePath: i.filePath, reason: 'taxonomy_apply_pending' });
      return false;
    }
    return true;
  });

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
