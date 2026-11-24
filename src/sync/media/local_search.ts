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
import { ApiError } from '../../client/error.js';
import type { CacheDatabase } from '../../db/cache.js';
import { resolveSearchDateBoundaries } from '../../utils/search-date.js';
import { clampSearchLimit } from '../../utils/search-options.js';
import { storageKeyToMarkdownRef } from '../../utils/naming.js';
import type {
  LocalMirrorIndex,
  MediaSearchHit,
  MediaSearchResult,
  MediaSearchSnapshotInfo,
} from './types.js';

/**
 * Offline search over the mirrors this workspace already holds (plus the cached metadata
 * snapshot in `cache.db`, when present and `mirroredOnly` is not set).
 *
 * Issues zero HTTP requests and works on a plane. Coverage is still bounded to local mirrors
 * and the cached snapshot timestamp, so callers must frame the output as local-only rather than
 * live library truth.
 */
export function searchLocalMirrorMedia(options: {
  query?: string;
  since?: string;
  until?: string;
  limit?: number;
  mirrorIndex: LocalMirrorIndex;
  cache?: CacheDatabase;
  mirroredOnly?: boolean;
}): MediaSearchResult {
  const { sinceBoundary, untilBoundary } = resolveSearchDateBoundaries({
    since: options.since,
    until: options.until,
  });

  const trimmed = options.query?.trim();
  if (trimmed !== undefined && !trimmed && sinceBoundary === null && untilBoundary === null) {
    throw new ApiError({
      message: 'A non-empty search query is required.',
      code: 'MEDIA_SEARCH_QUERY_REQUIRED',
      status: 400,
      suggestion: 'Provide a search keyword (filename, alt text, caption, or storageKey).',
    });
  }
  const normalizedQuery = trimmed ? trimmed.toLowerCase() : '';

  const limit = clampSearchLimit(options.limit);

  const index = options.mirrorIndex;
  const hits: MediaSearchHit[] = [];
  let matchCount = 0;
  const seenMediaIds = new Set<string>();
  const seenStorageKeys = new Set<string>();

  for (const entry of index.values()) {
    seenMediaIds.add(entry.mediaId);
    seenStorageKeys.add(entry.storageKey);

    // Mirrors carry no reliable creation stamp unless the companion recorded one; an unknown stamp cannot be
    // placed inside a requested range, so a date-narrowed search skips it rather than guessing.
    if (sinceBoundary !== null || untilBoundary !== null) {
      if (!entry.createdAt) continue;
      const instant = Date.parse(entry.createdAt);
      if (!Number.isFinite(instant)) continue;
      if (sinceBoundary !== null && instant < sinceBoundary) continue;
      if (untilBoundary !== null && instant >= untilBoundary) continue;
    }

    const stem = entry.localPath ? path.basename(entry.localPath).replace(/\.[^.]+$/, '') : '';
    const matchedOn: Array<'filename' | 'alt' | 'caption' | 'storageKey' | 'mirrorStem'> = [];
    if (!normalizedQuery) {
      matchedOn.push('mirrorStem');
    }
    if (entry.filename && entry.filename.toLowerCase().includes(normalizedQuery)) {
      matchedOn.push('filename');
    }
    if (entry.alt && entry.alt.toLowerCase().includes(normalizedQuery)) {
      matchedOn.push('alt');
    }
    if (entry.caption && entry.caption.toLowerCase().includes(normalizedQuery)) {
      matchedOn.push('caption');
    }
    if (entry.storageKey.toLowerCase().includes(normalizedQuery)) {
      matchedOn.push('storageKey');
    }
    if (stem && stem.toLowerCase().includes(normalizedQuery) && !matchedOn.includes('storageKey')) {
      matchedOn.push('mirrorStem');
    }
    if (matchedOn.length === 0) continue;

    matchCount++;
    if (hits.length >= limit) continue;

    hits.push({
      mediaId: entry.mediaId,
      storageKey: entry.storageKey,
      filename: entry.filename,
      mimeType: null,
      size: null,
      alt: entry.alt,
      caption: entry.caption,
      createdAt: entry.createdAt ?? undefined,
      mirrored: true,
      localPath: entry.localPath,
      matchedOn,
    });
  }

  let snapshotInfo: MediaSearchSnapshotInfo | undefined;
  let snapshotOnlyCount = 0;

  // EmDash's media library is site-wide (collection-independent), so read the latest snapshot meta
  // regardless of which collection captured it.
  const snapshotMeta = options.cache?.getLatestSnapshotMeta() ?? null;
  if (snapshotMeta && !options.mirroredOnly && options.cache) {
    const ageDays = Math.max(0, Math.floor((Date.now() - snapshotMeta.capturedAt) / 86_400_000));
    snapshotInfo = {
      capturedAt: new Date(snapshotMeta.capturedAt).toISOString(),
      ageDays: Number.isFinite(ageDays) ? ageDays : 0,
      stale: Number.isFinite(ageDays) ? ageDays >= 7 : false,
      mediaCount: snapshotMeta.mediaCount,
    };

    const snapshotRows = options.cache.listSnapshotMedia();
    for (const row of snapshotRows) {
      if (seenMediaIds.has(row.mediaId)) continue;
      if (row.storageKey && seenStorageKeys.has(row.storageKey)) continue;
      snapshotOnlyCount++;

      if (sinceBoundary !== null || untilBoundary !== null) {
        if (!row.createdAt) continue;
        const instant = Date.parse(row.createdAt);
        if (!Number.isFinite(instant)) continue;
        if (sinceBoundary !== null && instant < sinceBoundary) continue;
        if (untilBoundary !== null && instant >= untilBoundary) continue;
      }

      const stem = row.storageKey ? storageKeyToMarkdownRef(row.storageKey) : '';
      const matchedOn: Array<'filename' | 'alt' | 'caption' | 'storageKey' | 'mirrorStem'> = [];
      if (!normalizedQuery) {
        matchedOn.push(row.storageKey ? 'storageKey' : 'filename');
      } else {
        if (row.filename && row.filename.toLowerCase().includes(normalizedQuery)) {
          matchedOn.push('filename');
        }
        if (row.alt && row.alt.toLowerCase().includes(normalizedQuery)) {
          matchedOn.push('alt');
        }
        if (row.caption && row.caption.toLowerCase().includes(normalizedQuery)) {
          matchedOn.push('caption');
        }
        if (row.storageKey && row.storageKey.toLowerCase().includes(normalizedQuery)) {
          matchedOn.push('storageKey');
        }
        if (
          stem &&
          stem.toLowerCase().includes(normalizedQuery) &&
          !matchedOn.includes('storageKey')
        ) {
          matchedOn.push('mirrorStem');
        }
      }
      if (matchedOn.length === 0) continue;

      matchCount++;
      if (hits.length >= limit) continue;

      hits.push({
        mediaId: row.mediaId,
        storageKey: row.storageKey ?? null,
        filename: row.filename ?? null,
        mimeType: row.mimeType ?? null,
        size: row.size ?? null,
        alt: row.alt ?? null,
        caption: row.caption ?? null,
        createdAt: row.createdAt ?? undefined,
        mirrored: false,
        localPath: null,
        fromSnapshot: true,
        ...(row.cachedAt ? { cached: true } : {}),
        matchedOn,
      });
    }
  }

  const totalLocalCount = index.size + snapshotOnlyCount;

  // Every mirrored asset (and cached snapshot row, when present) was examined, so coverage of the local set is
  // complete. What is NOT complete is live remote truth, and `source` / `snapshot` on the consumer side says so.
  return {
    hits,
    scannedCount: totalLocalCount,
    walkComplete: true,
    totalCount: totalLocalCount,
    truncated: matchCount > hits.length,
    normalizedQuery,
    ...(snapshotInfo ? { snapshot: snapshotInfo } : {}),
  };
}
