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
import { createAuthedFetch } from '../../client/http.js';
import { DEFAULT_CONFIG } from '../../utils/config.js';
import { collectArticleStorageKeys } from './body_scan.js';
import { collectLocalMediaMirrorCandidates } from './companions.js';
import { syncSingleMediaItem } from './mirror_item.js';
import { mediaMirrorNames, mediaRecordIdForStem } from './naming_mirror.js';
import { collectPruneProtectionSets } from './prune_protect.js';
import { mirrorReferencedAssetsFromIndex, pullArticleMedia } from './pull_article.js';
import {
  collectRemoteStorageKeys,
  fetchMediaListPage,
  findUnmirroredStorageKeys,
} from './remote_index.js';
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

    // Walk metadata via collectRemoteStorageKeys (walks library to index records by storageKey). Targeted
    // keys are addressed directly, so the walk is bounded: a key outside the window is never asserted absent
    // (`complete === false` keeps per-record lookups honest) and stays in the verified/orphan evaluation.
    const remoteIndex = await collectRemoteStorageKeys({
      workspaceRoot: options.workspaceRoot,
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      maxItems: options.limit ?? DEFAULT_CONFIG.mediaSyncLimit,
      fetchFn,
    });

    const mirrorResult = await mirrorReferencedAssetsFromIndex(options.storageKeys, remoteIndex, {
      workspaceRoot: options.workspaceRoot,
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      downloadFiles,
      fetchFn,
      cache: options.cache,
    });

    return {
      total: mirrorResult.downloaded + mirrorResult.skipped,
      downloaded: mirrorResult.downloaded,
      skipped: mirrorResult.skipped,
      // A targeted pull that mirrored nothing still has to say what it found: keys confirmed by local mirror
      // metadata are healthy but were not (re)downloaded, and keys nothing could resolve are orphans.
      verifiedStorageKeys:
        mirrorResult.verifiedStorageKeys.length > 0 ? mirrorResult.verifiedStorageKeys : undefined,
      orphanStorageKeys:
        mirrorResult.orphanStorageKeys.length > 0 ? mirrorResult.orphanStorageKeys : undefined,
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
      limit: options.limit,
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
  // Companion YAMLs are confirmed storageKey sources, including the ones written before Emit persisted the
  // field, whose `url:` still names the key. They belong in the resolution index so a body reference to an
  // asset this run's window never reached is still recognized as local — but they must never enter the walk's
  // own key set or the census treats every existing mirror as accounted for and reports no absence at all.
  const companionStorageKeys = new Set<string>();
  for (const candidate of collectLocalMediaMirrorCandidates(mediaDir).values()) {
    if (candidate.storageKey) companionStorageKeys.add(candidate.storageKey);
  }

  // Metadata for the coverage report and the storageKey census. `pullMedia` already walks the library
  // cursor-by-cursor, so it owns the index instead of paying for a second one.
  const remoteIndex: RemoteStorageKeyIndex = {
    storageKeys: new Set<string>(),
    mediaIdsByStorageKey: new Map<string, string>(),
    recordsByStorageKey: new Map<string, EmDashMediaItem>(),
    recordsById: new Map<string, EmDashMediaItem>(),
    totalCount: null,
    complete: false,
    scannedCount: 0,
  };

  const activeMediaBaseNames = new Set<string>();
  // Only records the remote walk actually reports may authorise a mirror to stay, and only those same keys
  // may satisfy the census below. Seeding either from a local scan instead would make every existing mirror
  // self-exempt: pruning would delete nothing that mattered and the census would report no absence at all.
  const activeMediaIds = new Set<string>();

  let totalProcessed = 0;
  let downloadedCount = 0;
  let skippedCount = 0;
  let cursor: string | undefined = undefined;

  while (totalProcessed < targetTotal) {
    const remaining = targetTotal - totalProcessed;
    const currentBatch = Math.min(remaining, batchSize);

    const page = await fetchMediaListPage({
      origin: options.origin,
      token: options.token,
      limit: currentBatch,
      cursor,
      fetchFn,
    });

    if (page.totalCount !== null) {
      remoteIndex.totalCount = page.totalCount;
    }
    const rawItems = page.rawItems;

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
        remoteIndex.storageKeys.add(item.storageKey);
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

    if (!page.nextCursor) {
      remoteIndex.complete = true;
      break;
    }
    cursor = page.nextCursor;
  }

  // Pruning logic for media: delete local mirrors whose companion names a record this walk proved absent.
  // Two gates guard every unlink (v0.1.42):
  //   1. Completeness — the walk must have reached the end of the library. A bounded walk cannot tell a
  //      remotely deleted record from one sitting just past the window, so it proves nothing and deletes
  //      nothing; the caller is told via `pruneSkippedReason` instead (rendered in Layer 3).
  //   2. Reference protection — an asset some workspace article still points at is never deleted, even when
  //      the walk window never reached its record. Deleting a writing asset over a knowledge gap is exactly
  //      what the local-first principle forbids.
  let deletedCount = 0;
  let pruneSkippedReason: 'incomplete_walk' | undefined = undefined;
  const pruneRequested = options.all ? true : options.prune !== false;
  if (pruneRequested && !remoteIndex.complete) {
    pruneSkippedReason = 'incomplete_walk';
  }
  if (pruneRequested && remoteIndex.complete && fs.existsSync(mediaDir)) {
    const protection = collectPruneProtectionSets(
      options.workspaceRoot,
      options.collection || 'posts',
    );
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
      // Stem-space protection: the body URL carries an R2 storageKey, so it is normalized to a mirror stem
      // before comparison. A collision-suffixed mirror (`<stem>--<mediaId>`) falls through here and is
      // rescued by the companion-id comparison below.
      if (
        protection.protectedStems.has(stem) ||
        protection.protectedStems.has(stem.replace(/^\d{8}_/, ''))
      ) {
        continue;
      }
      const companionId = mediaRecordIdForStem(mediaDir, stem);
      if (!companionId) continue;
      // Id-space protection: `featuredImage` and body ULIDs name the D1 record, which is what the
      // companion's `id:` carries — the two spaces are compared only through these two channels.
      if (protection.protectedRecordIds.has(companionId)) continue;
      if (!activeMediaIds.has(companionId)) {
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
      // Two distinct sources of confirmation, and only these two: a key the complete remote walk reported,
      // or a key a local companion records as mirrored. A reference neither names is what the census reports.
      referencedUnmirroredStorageKeys = findUnmirroredStorageKeys(
        referenced,
        companionStorageKeys,
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
    pruneSkippedReason,
  };
}
