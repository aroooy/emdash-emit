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

import type { CacheDatabase, SnapshotMetaRecord } from '../../db/cache.js';

export interface SnapshotCaptureOptions {
  workspaceRoot: string;
  cache: CacheDatabase;
  origin: string;
  token: string;
  refreshToken?: string;
  collection?: string;
  concurrency?: number;
  includeMedia?: boolean;
  mediaCacheLimit?: number;
  mediaCacheMaxBytes?: number;
  fetchFn?: typeof fetch;
}

export interface SnapshotCaptureResult {
  collection: string;
  capturedAt: number;
  articleCount: number;
  articlesPruned: number;
  mediaCount: number;
  mediaPruned: number;
  mediaCached: number;
  mediaCacheSkipped: number;
  mediaCacheBytes: number;
  mediaCacheBudgetHit: boolean;
  mediaCacheTotalCandidates: number;
  taxonomyFetchedCount: number;
  taxonomyReusedCount: number;
  articleSingleGetCount: number;
  categoriesSynced: number;
  tagsSynced: number;
  taxonomyWarning?: string;
  durationMs: number;
}

export interface SnapshotMediaCacheStatus {
  cachedCount: number;
  totalBytes: number;
}

export interface SnapshotStatusResult {
  collection: string;
  meta: SnapshotMetaRecord | null;
  mediaCache?: SnapshotMediaCacheStatus;
}

export interface SnapshotClearResult {
  collection: string;
  articlesCleared: number;
  mediaCleared: number;
  cacheFilesDeleted: number;
  cacheFilesPreserved: number;
}

export interface SnapshotPruneCacheResult {
  deletedFiles: number;
  preservedFiles: number;
}
