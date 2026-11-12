import path from 'node:path';
import { unwrapEnvelope } from '../../client/api.js';
import { ApiError } from '../../client/error.js';
import { createAuthedFetch } from '../../client/http.js';
import { storageKeyToMarkdownRef } from '../../utils/naming.js';
import {
  MEDIA_LIST_PAGE_SIZE,
  type EmDashMediaItem,
  type LocalMirrorIndex,
  type MediaSearchHit,
  type MediaSearchResult,
  type RemoteStorageKeyIndex,
} from './types.js';

export const MEDIA_SEARCH_DEFAULT_LIMIT = 20;
export const MEDIA_SEARCH_MAX_LIMIT = 50;
/** Default scan ceiling. `maxScan: 0` means unlimited (a complete walk). */
export const MEDIA_SEARCH_DEFAULT_MAX_SCAN = 500;

export interface SearchRemoteMediaOptions {
  workspaceRoot: string;
  origin: string;
  token: string;
  refreshToken?: string;
  /** Literal, case-insensitive substring match. Regex is never compiled from user input. */
  query: string;
  /** Max hits to return (default 20, clamped to 50). */
  limit?: number;
  /** Max records to read before stopping the walk (default 500; 0 = unlimited). */
  maxScan?: number;
  /** Restrict output to assets Emit already mirrors. The walk still covers the whole library. */
  mirroredOnly?: boolean;
  /** Decoration built by M2. When omitted, every hit reports mirrored: false. */
  mirrorIndex?: LocalMirrorIndex;
  fetchFn?: typeof fetch;
}

/**
 * Fetches a single page from EmDash media list endpoint.
 * Shared by collectRemoteStorageKeys and searchRemoteMedia to guarantee identical pagination behavior.
 */
async function fetchMediaListPage(options: {
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
  const url = new URL('/_emdash/api/media', options.origin);
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
 * Searches the remote EmDash media library by keyword across filename, alt text, caption,
 * storageKey, and mirrorStem.
 *
 * Adheres strictly to the 3 principles:
 * 1. Does not send `q` to the server; walks and filters client-side.
 * 2. Matches are literal substring comparisons (case-insensitive, no regex).
 * 3. Epistemic completeness: Reports scannedCount and walkComplete.
 */
export async function searchRemoteMedia(
  options: SearchRemoteMediaOptions,
): Promise<MediaSearchResult> {
  const trimmed = options.query?.trim();
  if (!trimmed) {
    throw new ApiError({
      message: 'A non-empty search query is required.',
      code: 'MEDIA_SEARCH_QUERY_REQUIRED',
      status: 400,
      suggestion: 'Provide a search keyword (filename, alt text, caption, or storageKey).',
    });
  }
  const normalizedQuery = trimmed.toLowerCase();

  const rawLimit = options.limit ?? MEDIA_SEARCH_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(rawLimit, MEDIA_SEARCH_MAX_LIMIT));
  const maxScan =
    options.maxScan === 0
      ? Infinity
      : typeof options.maxScan === 'number' && options.maxScan > 0
        ? options.maxScan
        : MEDIA_SEARCH_DEFAULT_MAX_SCAN;

  const fetchFn = createAuthedFetch(options);
  const batchSize = MEDIA_LIST_PAGE_SIZE;
  const hits: MediaSearchHit[] = [];
  let scanned = 0;
  let cursor: string | undefined = undefined;
  let totalCount: number | null = null;
  let walkComplete = false;
  let matchCount = 0;

  for (;;) {
    const remaining = maxScan - scanned;
    if (remaining <= 0) {
      break;
    }
    const currentBatch = Math.min(remaining, batchSize);
    const page = await fetchMediaListPage({
      origin: options.origin,
      token: options.token,
      limit: currentBatch,
      cursor,
      fetchFn,
    });

    if (page.totalCount !== null) {
      totalCount = page.totalCount;
    }

    for (const item of page.rawItems) {
      scanned++;
      const storageKey = item.storageKey || null;
      const mirrorEntry =
        storageKey && options.mirrorIndex ? options.mirrorIndex.get(storageKey) : undefined;
      const mirrored = Boolean(mirrorEntry);

      if (options.mirroredOnly && !mirrored) {
        continue;
      }

      const effectiveAlt = item.alt || mirrorEntry?.alt || null;
      const effectiveCaption = item.caption || mirrorEntry?.caption || null;

      const matchedOn: Array<'filename' | 'alt' | 'caption' | 'storageKey' | 'mirrorStem'> = [];
      if (item.filename && item.filename.toLowerCase().includes(normalizedQuery)) {
        matchedOn.push('filename');
      }
      if (effectiveAlt && effectiveAlt.toLowerCase().includes(normalizedQuery)) {
        matchedOn.push('alt');
      }
      if (effectiveCaption && effectiveCaption.toLowerCase().includes(normalizedQuery)) {
        matchedOn.push('caption');
      }
      if (storageKey && storageKey.toLowerCase().includes(normalizedQuery)) {
        matchedOn.push('storageKey');
      }
      if (storageKey) {
        const ref = storageKeyToMarkdownRef(storageKey);
        const stem = ref ? ref.toLowerCase() : '';
        const localStem = mirrorEntry?.localPath
          ? path
              .basename(mirrorEntry.localPath)
              .replace(/\.[^.]+$/, '')
              .toLowerCase()
          : '';
        if (
          (stem && stem.includes(normalizedQuery)) ||
          (localStem && localStem.includes(normalizedQuery))
        ) {
          if (!matchedOn.includes('mirrorStem') && !matchedOn.includes('storageKey')) {
            matchedOn.push('mirrorStem');
          }
        }
      }

      if (matchedOn.length > 0) {
        matchCount++;
        if (hits.length < limit) {
          hits.push({
            mediaId: item.id.toUpperCase(),
            storageKey,
            filename: item.filename || null,
            mimeType: item.mimeType || null,
            size: typeof item.size === 'number' ? item.size : null,
            alt: effectiveAlt,
            caption: effectiveCaption,
            createdAt: item.createdAt,
            mirrored,
            localPath: mirrorEntry?.localPath ?? null,
            matchedOn,
          });
        }
      }
    }

    if (page.rawItems.length === 0 || !page.nextCursor) {
      walkComplete = true;
      break;
    }
    cursor = page.nextCursor;
  }

  const truncated = matchCount > hits.length;

  return {
    hits,
    scannedCount: scanned,
    walkComplete,
    totalCount,
    truncated,
    normalizedQuery,
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
