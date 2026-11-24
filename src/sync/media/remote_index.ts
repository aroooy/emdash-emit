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

import { unwrapEnvelope } from '../../client/api.js';
import { ApiError } from '../../client/error.js';
import { createAuthedFetch } from '../../client/http.js';
import { mediaListEndpoint } from '../../client/endpoints.js';
import { MEDIA_LIST_PAGE_SIZE, type EmDashMediaItem, type RemoteStorageKeyIndex } from './types.js';

/**
 * Fetches a single page from EmDash media list endpoint.
 * Shared by collectRemoteStorageKeys and pullMedia to guarantee identical pagination behavior.
 */
export async function fetchMediaListPage(options: {
  origin: string;
  token: string;
  limit: number;
  cursor?: string;
  fetchFn: typeof fetch;
}): Promise<{
  rawItems: EmDashMediaItem[];
  nextCursor?: string;
  totalCount: number | null;
}> {
  const url = new URL(mediaListEndpoint(options.origin));
  url.searchParams.set('limit', String(options.limit));
  if (options.cursor) url.searchParams.set('cursor', options.cursor);

  const res = await options.fetchFn(url.toString(), {
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new ApiError({
      message: `Failed to list media: ${res.statusText}`,
      code: 'MEDIA_LIST_FAILED',
      status: res.status,
      endpoint: url.toString(),
      suggestion: 'Verify network connection and token permissions.',
    });
  }

  const data = unwrapEnvelope<Record<string, unknown>>(await res.json());
  const totalCount = typeof data.totalCount === 'number' ? data.totalCount : null;
  const rawItems = (
    Array.isArray(data.items) ? data.items : Array.isArray(data.data) ? data.data : []
  ) as EmDashMediaItem[];
  const nextCursor =
    typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : undefined;

  return { rawItems, nextCursor, totalCount };
}

export async function collectRemoteStorageKeys(options: {
  workspaceRoot: string;
  origin: string;
  token: string;
  refreshToken?: string;
  /** Stop after this many records. Defaults to unlimited, which is the whole library. */
  maxItems?: number;
  fetchFn?: typeof fetch;
}): Promise<RemoteStorageKeyIndex> {
  const fetchFn = createAuthedFetch(options);
  const batchSize = MEDIA_LIST_PAGE_SIZE;
  const maxItems = options.maxItems ?? Infinity;

  const storageKeys = new Set<string>();
  const mediaIdsByStorageKey = new Map<string, string>();
  const recordsByStorageKey = new Map<string, EmDashMediaItem>();
  const recordsById = new Map<string, EmDashMediaItem>();
  let totalCount: number | null = null;
  let scanned = 0;
  let complete = false;
  let cursor: string | undefined = undefined;

  for (;;) {
    const remaining = maxItems - scanned;
    if (remaining <= 0) break;
    const currentBatch = Math.min(remaining, batchSize);

    const page = await fetchMediaListPage({
      origin: options.origin,
      token: options.token,
      limit: currentBatch,
      cursor,
      fetchFn,
    });

    if (page.totalCount !== null) totalCount = page.totalCount;

    for (const item of page.rawItems) {
      scanned++;
      if (item.id) recordsById.set(item.id.toUpperCase(), item);
      if (typeof item.storageKey === 'string' && item.storageKey) {
        storageKeys.add(item.storageKey);
        // First record wins a repeated key, so reporting a match stays deterministic.
        if (item.id && !mediaIdsByStorageKey.has(item.storageKey)) {
          mediaIdsByStorageKey.set(item.storageKey, item.id);
        }
        if (!recordsByStorageKey.has(item.storageKey)) {
          recordsByStorageKey.set(item.storageKey, item);
        }
      }
    }

    if (page.rawItems.length === 0 || !page.nextCursor) {
      complete = true;
      break;
    }
    cursor = page.nextCursor;
  }

  return {
    storageKeys,
    mediaIdsByStorageKey,
    recordsByStorageKey,
    recordsById,
    totalCount,
    complete,
    scannedCount: scanned,
  };
}

/**
 * Reports body storageKeys that no local mirror names and that a full remote library walk does not
 * contain. A key is only listed when the walk was complete: an early stop proves nothing about the
 * rest of the library, so an incomplete walk yields nothing. Even a confirmed absence is reported as a
 * lookup result rather than as a missing record — Emit mirrors records and never repairs server data.
 */
export function findUnmirroredStorageKeys(
  referenced: Iterable<string>,
  localMirrorKeys: Iterable<string>,
  remoteIndex: RemoteStorageKeyIndex,
): string[] {
  if (!remoteIndex.complete) return [];
  const mirrored = new Set(localMirrorKeys);
  const unresolved = new Set<string>();
  for (const key of referenced) {
    if (mirrored.has(key) || remoteIndex.storageKeys.has(key)) continue;
    unresolved.add(key);
  }
  return Array.from(unresolved).sort();
}
