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
  type PullResult,
  type ListRemoteArticlesOptions,
} from './pull.js';
import { pushArticle, type PushResult, type PushOptions } from './push.js';
import { getWorkspaceStatus } from './status.js';
import { syncRemoteBylines } from './bylines.js';

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
  onProgress?: (progress: { current: number; total: number; item: PullResult }) => void;
}

export interface PullBatchResult {
  total: number;
  updated: number;
  skipped: number;
  deleted?: number;
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

    // Safety guard: Check if any pushed-out candidate has unpushed local changes
    const unpushedConflicts: UnpushedConflictItem[] = [];
    for (const candidate of candidatesToPrune) {
      const fullPath = path.join(options.workspaceRoot, candidate.localFilePath);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const currentHash = calculateHash(content);
          if (currentHash !== candidate.localHash) {
            unpushedConflicts.push({
              id: candidate.id,
              slug: candidate.slug,
              filePath: candidate.localFilePath,
            });
          }
        } catch {
          // If read fails, safely ignore
        }
      }
    }

    if (unpushedConflicts.length > 0) {
      const filesList = unpushedConflicts.map((i) => `  - ${i.filePath} (${i.slug})`).join('\n');
      const windowMsg = options.limit ? ` (currently: ${options.limit})` : '';
      const message =
        `Pull aborted: ${unpushedConflicts.length} article(s) outside the sync window have unpushed local edits!\n\n` +
        `The following article(s) would be pruned from local cache, but contain unpushed changes:\n${filesList}\n\n` +
        `💡 Why did this happen?\n` +
        `The modified article(s) are older than the workspace sync window${windowMsg}.\n\n` +
        `Recommended actions:\n` +
        `  1. Push local changes:   emit push <filePath>\n` +
        `  2. Adjust sync window:   update "postsSyncLimit" in .emit/config.json if a larger window is needed\n`;

      throw new SyncPruneConflictError(message, unpushedConflicts, options.limit);
    }
  }

  const results: PullResult[] = [];
  let updated = 0;
  let skipped = 0;

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
        fetchFn: options.fetchFn,
        bylineIdToSlug: bylineMaps.idToSlug,
        bylineSlugToId: bylineMaps.slugToId,
      });

      results.push(res);
      if (res.skipped) skipped++;
      else updated++;

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
      const fullPath = path.join(options.workspaceRoot, candidate.localFilePath);
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
        } catch {
          // ignore
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

  return {
    total: remoteList.length,
    updated,
    skipped,
    deleted,
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
}

/**
 * Orchestrates pushing all modified/untracked files in the workspace.
 * Excludes synced and invalid (YAML parse error) files so invalid files do not crash batch push.
 * Reusable across CLI and MCP servers.
 */
export async function pushAll(options: PushAllOptions): Promise<PushAllResult> {
  const status = getWorkspaceStatus(options.workspaceRoot, options.cache, options.collection);
  const toPush = status.items.filter(
    (i) => i.syncStatus === 'modified' || i.syncStatus === 'untracked',
  );

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
  };
}
