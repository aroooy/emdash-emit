import { unwrapEnvelope } from '../../client/api.js';
import { ApiError } from '../../client/error.js';
import { createAuthedFetch } from '../../client/http.js';
import { MEDIA_LIST_PAGE_SIZE, type EmDashMediaItem, type RemoteStorageKeyIndex } from './types.js';

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

    const url = new URL('/_emdash/api/media', options.origin);
    url.searchParams.set('limit', String(currentBatch));
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetchFn(url.toString(), {
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
    if (typeof data.totalCount === 'number') totalCount = data.totalCount;
    const rawItems = (
      Array.isArray(data.items) ? data.items : Array.isArray(data.data) ? data.data : []
    ) as EmDashMediaItem[];

    for (const item of rawItems) {
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

    if (rawItems.length === 0 || typeof data.nextCursor !== 'string' || !data.nextCursor) {
      complete = true;
      break;
    }
    cursor = data.nextCursor;
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
