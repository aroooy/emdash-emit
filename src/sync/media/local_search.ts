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
import { resolveSearchDateBoundaries } from '../../utils/search-date.js';
import {
  MEDIA_SEARCH_MAX_LIMIT,
  type LocalMirrorIndex,
  type MediaSearchHit,
  type MediaSearchResult,
} from './types.js';

/** Default hits returned when the caller names no limit — mirrors the remote walk's default. */
const LOCAL_MEDIA_SEARCH_DEFAULT_LIMIT = 20;

/**
 * Offline search over the mirrors this workspace already holds.
 *
 * Built entirely from a `LocalMirrorIndex` — `media_state` plus `media/*.yaml` companions, collected by
 * `collectLocalMirrorIndex` in `companions.ts` — so it issues zero HTTP requests and works on a plane. That
 * scope is also its limit, and the result says so: an asset that exists only remotely is absent here without
 * being absent in the CMS, which is why callers must frame the output as local-only (Layer 3 renders the
 * header) rather than let an agent read it as the library's truth.
 */
export function searchLocalMirrorMedia(options: {
  query?: string;
  since?: string;
  until?: string;
  limit?: number;
  mirrorIndex: LocalMirrorIndex;
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

  const rawLimit = options.limit ?? LOCAL_MEDIA_SEARCH_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(rawLimit, MEDIA_SEARCH_MAX_LIMIT));

  const index = options.mirrorIndex;
  const hits: MediaSearchHit[] = [];
  let matchCount = 0;

  for (const entry of index.values()) {
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

  // Every mirrored asset was examined, so coverage of the local set is complete. What is NOT complete is
  // knowledge of the remote library, and `source: 'local_mirrors'` on the consumer side is what says so.
  return {
    hits,
    scannedCount: index.size,
    walkComplete: true,
    totalCount: index.size,
    truncated: matchCount > hits.length,
    normalizedQuery,
  };
}
