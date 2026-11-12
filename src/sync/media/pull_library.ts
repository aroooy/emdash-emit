import fs from 'node:fs';
import path from 'node:path';
import { unwrapEnvelope } from '../../client/api.js';
import { ApiError } from '../../client/error.js';
import { createAuthedFetch } from '../../client/http.js';
import { DEFAULT_CONFIG } from '../../utils/config.js';
import { collectArticleStorageKeys } from './body_scan.js';
import { collectLocalMediaMirrorCandidates } from './companions.js';
import { syncSingleMediaItem } from './mirror_item.js';
import { mediaMirrorNames, mediaRecordIdForStem } from './naming_mirror.js';
import { pullArticleMedia } from './pull_article.js';
import { collectRemoteStorageKeys, findUnmirroredStorageKeys } from './remote_index.js';
import {
  MEDIA_LIST_PAGE_SIZE,
  type EmDashMediaItem,
  type PullMediaOptions,
  type PullMediaResult,
  type RemoteStorageKeyIndex,
} from './types.js';

/**
 * Pulls media metadata and files from EmDash API into media/ directory with cursor pagination.
 * media/<markdownRef>.yaml
 * media/<markdownRef>.<ext>
 *
 * `markdownRef` is the sanitized storageKey basename (`storageKeyToMarkdownRef`), never the record id, so the
 * mirror on disk shares one stem with the body URL that references it; the original `filename` survives only
 * inside the companion YAML. See `mediaMirrorNames()` for the full naming and collision rule.
 */
export async function pullMedia(options: PullMediaOptions): Promise<PullMediaResult> {
  if (options.storageKeys && options.storageKeys.length > 0) {
    const fetchFn = createAuthedFetch(options);
    const mediaDir = path.join(options.workspaceRoot, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    const downloadFiles = options.downloadFiles !== false;

    // Walk metadata via collectRemoteStorageKeys (walks library to index records by storageKey)
    const remoteIndex = await collectRemoteStorageKeys({
      workspaceRoot: options.workspaceRoot,
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      fetchFn,
    });

    let totalProcessed = 0;
    let downloadedCount = 0;
    let skippedCount = 0;
    const orphanStorageKeys: string[] = [];

    for (const key of options.storageKeys) {
      const item = remoteIndex.recordsByStorageKey.get(key);
      if (!item) {
        orphanStorageKeys.push(key);
        continue;
      }

      totalProcessed++;
      const result = await syncSingleMediaItem({
        item,
        mediaDir,
        origin: options.origin,
        token: options.token,
        downloadFiles,
        fetchFn,
        cache: options.cache,
      });

      if (result.downloaded) downloadedCount++;
      else if (result.skipped) skippedCount++;
    }

    return {
      total: totalProcessed,
      downloaded: downloadedCount,
      skipped: skippedCount,
      orphanStorageKeys: orphanStorageKeys.length > 0 ? orphanStorageKeys : undefined,
      remoteTotalCount: remoteIndex.complete
        ? (remoteIndex.totalCount ?? remoteIndex.scannedCount)
        : remoteIndex.totalCount,
    };
  }

  if (options.article) {
    return pullArticleMedia({
      workspaceRoot: options.workspaceRoot,
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      article: options.article,
      collection: options.collection,
      downloadFiles: options.downloadFiles,
      fetchFn: options.fetchFn,
      cache: options.cache,
    });
  }

  const fetchFn = createAuthedFetch(options);
  const targetTotal = options.all ? Infinity : (options.limit ?? DEFAULT_CONFIG.mediaSyncLimit);
  const downloadFiles = options.downloadFiles !== false;
  const batchSize = MEDIA_LIST_PAGE_SIZE;

  const mediaDir = path.join(options.workspaceRoot, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  // Every mirrored companion is a confirmed storageKey source, including the ones written before Emit
  // persisted the field, whose `url:` still names the key. Seeding from disk means `--prune` never
  // deletes an asset that this run's media window simply did not reach.
  const activeStorageKeys = new Set<string>();
  for (const candidate of collectLocalMediaMirrorCandidates(mediaDir).values()) {
    if (candidate.storageKey) activeStorageKeys.add(candidate.storageKey);
  }

  // Metadata for the coverage report and the storageKey census. `pullMedia` already walks the library
  // cursor-by-cursor, so it owns the index instead of paying for a second one.
  const remoteIndex: RemoteStorageKeyIndex = {
    storageKeys: activeStorageKeys,
    mediaIdsByStorageKey: new Map<string, string>(),
    recordsByStorageKey: new Map<string, EmDashMediaItem>(),
    recordsById: new Map<string, EmDashMediaItem>(),
    totalCount: null,
    complete: false,
    scannedCount: 0,
  };

  const activeMediaBaseNames = new Set<string>();
  // Only records the remote walk actually reports may authorise a mirror to stay. Seeding this from local
  // companions instead would make every existing file self-exempt and prune nothing at all.
  const activeMediaIds = new Set<string>();

  let totalProcessed = 0;
  let downloadedCount = 0;
  let skippedCount = 0;
  let cursor: string | undefined = undefined;

  while (totalProcessed < targetTotal) {
    const remaining = targetTotal - totalProcessed;
    const currentBatch = Math.min(remaining, batchSize);

    const url = new URL(`/_emdash/api/media`, options.origin);
    url.searchParams.set('limit', String(currentBatch));
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const res = await fetchFn(url.toString(), {
      method: 'GET',
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

    const json = await res.json();
    const data = unwrapEnvelope<Record<string, unknown>>(json);
    if (typeof data.totalCount === 'number') remoteIndex.totalCount = data.totalCount;
    const rawItems = (
      Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : []
    ) as EmDashMediaItem[];

    if (rawItems.length === 0) {
      // An empty page ends the listing regardless of any cursor the server echoes back.
      remoteIndex.complete = true;
      break;
    }

    for (const item of rawItems) {
      const names = mediaMirrorNames(item);
      activeMediaBaseNames.add(names.markdownRef);
      for (const legacy of names.legacyBaseNames) {
        activeMediaBaseNames.add(legacy);
      }
      activeMediaIds.add(item.id);
      if (item.storageKey) {
        activeStorageKeys.add(item.storageKey);
        remoteIndex.mediaIdsByStorageKey.set(item.storageKey, item.id);
      }

      const result = await syncSingleMediaItem({
        item,
        mediaDir,
        origin: options.origin,
        token: options.token,
        downloadFiles,
        fetchFn,
        cache: options.cache,
      });

      if (result.downloaded) downloadedCount++;
      else if (result.skipped) skippedCount++;

      totalProcessed++;
      remoteIndex.scannedCount++;
      if (totalProcessed >= targetTotal) {
        break;
      }
    }

    if (!data.nextCursor || typeof data.nextCursor !== 'string') {
      remoteIndex.complete = true;
      break;
    }
    cursor = data.nextCursor;
  }

  // Pruning logic for media: if --prune or --all is enabled, delete local media not present on remote
  let deletedCount = 0;
  if ((options.prune || options.all) && fs.existsSync(mediaDir)) {
    const files = fs.readdirSync(mediaDir);
    for (const file of files) {
      // Leftover `legacy_*` mirrors from the removed file-route fallback are never matched by the
      // mediaId pattern below, so they survive pruning and must be deleted by hand.
      if (file.startsWith('legacy_')) continue;
      // A mirror is identified with its companion YAML: the stem names the storageKey, and the record id
      // lives inside the companion. Only a file Emit can attribute to a record may be pruned — an
      // unattributable migrated name is kept, because deleting an asset over a guess is unrecoverable.
      const stem = file.replace(/\.[^.]+$/, '');
      if (activeMediaBaseNames.has(stem) || activeMediaBaseNames.has(stem.replace(/^\d{8}_/, ''))) {
        continue;
      }
      const companionId = mediaRecordIdForStem(mediaDir, stem);
      if (companionId && !activeMediaIds.has(companionId)) {
        try {
          fs.unlinkSync(path.join(mediaDir, file));
          deletedCount++;
        } catch {
          // Ignore unlink errors
        }
      }
    }
  }

  // A library-wide walk is exhaustive, so it doubles as the storageKey census: every article reference
  // that neither a local companion nor any remote record names is reported. The list endpoint exposes no
  // storageKey filter, which is why the census requires the full walk `--all` already performs.
  let referencedUnmirroredStorageKeys: string[] | undefined = undefined;
  if (options.all) {
    const referenced = new Set<string>();
    for (const status of ['draft', 'published']) {
      const statusDir = path.join(options.workspaceRoot, options.collection || 'posts', status);
      if (!fs.existsSync(statusDir)) continue;
      for (const file of fs.readdirSync(statusDir)) {
        if (!file.endsWith('.md')) continue;
        try {
          const content = fs.readFileSync(path.join(statusDir, file), 'utf8');
          for (const descriptor of collectArticleStorageKeys(content)) {
            referenced.add(descriptor.storageKey);
          }
        } catch {
          // An unreadable article contributes nothing to the census.
        }
      }
    }
    if (referenced.size > 0) {
      referencedUnmirroredStorageKeys = findUnmirroredStorageKeys(
        referenced,
        activeStorageKeys,
        remoteIndex,
      );
    }
  }

  return {
    total: totalProcessed,
    downloaded: downloadedCount,
    skipped: skippedCount,
    deleted: deletedCount,
    remoteTotalCount: remoteIndex.complete
      ? (remoteIndex.totalCount ?? remoteIndex.scannedCount)
      : remoteIndex.totalCount,
    referencedUnmirroredStorageKeys,
  };
}
