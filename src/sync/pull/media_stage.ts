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
import crypto from 'node:crypto';
import yaml from 'js-yaml';
import { createAuthedFetch } from '../../client/http.js';
import { unwrapEnvelope } from '../../client/api.js';
import { mediaDetailEndpoint } from '../../client/endpoints.js';
import { extractMediaUlid } from '../../client/mapper.js';
import type { CacheDatabase } from '../../db/cache.js';
import { DEFAULT_CONFIG } from '../../utils/config.js';
import {
  toMediaRecordId,
  asMediaRecordId,
  toStorageKey,
  asStorageKey,
} from '../../utils/media-id.js';
import { MEDIA_FILE_ROUTE_PREFIX } from '../../utils/media-refs.js';
import { toMediaCacheFileName } from '../../utils/media-cache.js';
import { storageKeyToMarkdownRef } from '../../utils/naming.js';
import {
  collectArticleStorageKeys,
  collectLocalMirrorIndex,
  collectRemoteStorageKeys,
  collectLocalMediaMirrorCandidates,
  syncSingleMediaItem,
  mediaRecordIdForStem,
  MEDIA_BINARY_EXTENSIONS,
  type EmDashMediaItem,
  type LocalMediaMirrorCandidate,
  type RemoteStorageKeyIndex,
} from '../media/index.js';
import type { MediaMirrorSession, PullArticleMediaSummary, PullOptions } from './types.js';

export interface MediaMirrorSessionOptions {
  workspaceRoot: string;
  origin: string;
  token: string;
  refreshToken?: string;
  cache?: CacheDatabase;
  fetchFn?: typeof fetch;
  downloadFiles?: boolean;
  isSharedSession?: boolean;
  /** Bounds the shared library walk. Defaults to `mediaSyncLimit`; `all: true` removes the bound. */
  limit?: number;
  all?: boolean;
}

interface AssetMirrorOutcome {
  downloaded: boolean;
  skipped: boolean;
  failed: boolean;
  storageKey?: string;
}

function computeFileSha256(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Finds a local binary file matching a storageKey, using media_state workspacePath if available,
 * or searching media/ directory for markdownRef.<ext>.
 */
function findLocalBinaryForStorageKey(
  mediaDir: string,
  storageKey: string,
  cache?: CacheDatabase,
  workspaceRoot?: string,
): { binaryPath: string; stem: string } | null {
  if (cache && workspaceRoot) {
    const state = cache.getMediaStateByStorageKey(storageKey);
    if (state?.workspacePath) {
      const full = path.join(workspaceRoot, state.workspacePath);
      if (fs.existsSync(full)) {
        const ext = path.extname(state.workspacePath);
        const stem = path.basename(state.markdownRef || state.workspacePath, ext);
        return { binaryPath: full, stem };
      }
    }
  }

  if (!fs.existsSync(mediaDir)) return null;

  const ref = storageKeyToMarkdownRef(storageKey) || storageKey;
  const ext = path.extname(storageKey);
  if (ext) {
    const candidate = path.join(mediaDir, `${ref}${ext}`);
    if (fs.existsSync(candidate)) return { binaryPath: candidate, stem: ref };
  }

  for (const bExt of MEDIA_BINARY_EXTENSIONS) {
    const candidate = path.join(mediaDir, `${ref}${bExt}`);
    if (fs.existsSync(candidate)) return { binaryPath: candidate, stem: ref };
  }

  for (const file of fs.readdirSync(mediaDir)) {
    if (file.endsWith('.yaml') || file.startsWith('legacy_')) continue;
    const fileStem = file.replace(/\.[^.]+$/, '');
    if (fileStem === ref) {
      return { binaryPath: path.join(mediaDir, file), stem: ref };
    }
  }

  return null;
}

/**
 * Finds a local binary matching a mediaId ULID (used for featuredImage).
 */
function findLocalBinaryForMediaId(
  mediaDir: string,
  mediaId: string,
  cache?: CacheDatabase,
  workspaceRoot?: string,
): { binaryPath: string; stem: string; storageKey?: string } | null {
  const wanted = mediaId.toUpperCase();
  if (cache && workspaceRoot) {
    const state = cache.getMediaStateByMediaId(wanted);
    if (state?.workspacePath) {
      const full = path.join(workspaceRoot, state.workspacePath);
      if (fs.existsSync(full)) {
        const ext = path.extname(state.workspacePath);
        const stem = path.basename(state.markdownRef || state.workspacePath, ext);
        return { binaryPath: full, stem, storageKey: state.storageKey || undefined };
      }
    }
  }

  if (!fs.existsSync(mediaDir)) return null;

  for (const file of fs.readdirSync(mediaDir)) {
    if (!file.endsWith('.yaml') || file.startsWith('legacy_')) continue;
    const stem = file.replace(/\.yaml$/, '');
    if (mediaRecordIdForStem(mediaDir, stem) === wanted) {
      for (const ext of MEDIA_BINARY_EXTENSIONS) {
        const candidate = path.join(mediaDir, `${stem}${ext}`);
        if (fs.existsSync(candidate)) {
          return { binaryPath: candidate, stem };
        }
      }
    }
  }

  return null;
}

export class MediaMirrorSessionImpl implements MediaMirrorSession {
  private readonly options: MediaMirrorSessionOptions;
  private readonly mediaDir: string;
  private readonly isSharedSession: boolean;
  private remoteIndexPromise: Promise<RemoteStorageKeyIndex> | null = null;
  private localCandidatesMap: Map<string, LocalMediaMirrorCandidate> | null = null;
  private readonly inFlightAssets = new Map<string, Promise<AssetMirrorOutcome>>();

  // Aggregate session statistics (for pullBatch)
  private readonly sessionMirroredStorageKeys = new Set<string>();
  private readonly sessionVerifiedStorageKeys = new Set<string>();
  private readonly sessionOrphanStorageKeys = new Set<string>();
  private sessionDownloaded = 0;
  private sessionSkipped = 0;

  constructor(options: MediaMirrorSessionOptions) {
    this.options = options;
    this.mediaDir = path.join(options.workspaceRoot, 'media');
    this.isSharedSession = options.isSharedSession === true;
  }

  /**
   * The shared library walk, bounded by `maxItems` (default `mediaSyncLimit`, unlimited for `--all`) exactly
   * like the library pass. A batch pull against a fleet-scale library must never pay for an unbounded scan on
   * behalf of a handful of articles; a key that lands outside the window is reported as unresolved rather than
   * asserted absent, and `complete === false` keeps every per-record lookup available downstream.
   */
  public getRemoteIndex(): Promise<RemoteStorageKeyIndex> {
    if (!this.remoteIndexPromise) {
      this.remoteIndexPromise = collectRemoteStorageKeys({
        workspaceRoot: this.options.workspaceRoot,
        origin: this.options.origin,
        token: this.options.token,
        refreshToken: this.options.refreshToken,
        maxItems:
          this.options.all === true || typeof this.options.limit === 'number'
            ? this.options.limit
            : DEFAULT_CONFIG.mediaSyncLimit,
        fetchFn: this.options.fetchFn,
      });
    }
    return this.remoteIndexPromise;
  }

  public getLocalCandidates(): Map<string, LocalMediaMirrorCandidate> {
    if (!this.localCandidatesMap) {
      this.localCandidatesMap = collectLocalMediaMirrorCandidates(this.mediaDir);
    }
    return this.localCandidatesMap;
  }

  /**
   * Mirrors media referenced by an article (both body storageKeys and frontmatter featuredImage).
   */
  public async mirrorArticleReferencedMedia(params: {
    canonicalMarkdown: string;
    featuredImage?: string | null;
  }): Promise<PullArticleMediaSummary | undefined> {
    const { canonicalMarkdown, featuredImage } = params;

    // Step 1: Extract references
    const bodyDescriptors = collectArticleStorageKeys(canonicalMarkdown);
    const bodyStorageKeys = Array.from(new Set(bodyDescriptors.map((d) => d.storageKey)));
    const featuredUlid = featuredImage ? extractMediaUlid(featuredImage) : null;
    const featuredMediaId = featuredUlid ? featuredUlid.toUpperCase() : null;

    if (bodyStorageKeys.length === 0 && !featuredMediaId) {
      return undefined;
    }

    const { workspaceRoot, origin, token, cache, downloadFiles } = this.options;
    const fetchFn = createAuthedFetch(this.options);
    const shouldDownload = downloadFiles !== false;

    // Step 2: 0-HTTP short-circuit inspection (when no remote index is needed yet)
    // Check if all referenced assets are fully mirrored locally.
    const isAssetFullyMirrored = (
      keyOrId: string,
      isFeatured: boolean,
    ): {
      fullyMirrored: boolean;
      binaryPath?: string;
      stem?: string;
      mediaId?: string;
      storageKey?: string;
    } => {
      if (isFeatured) {
        const found = findLocalBinaryForMediaId(this.mediaDir, keyOrId, cache, workspaceRoot);
        if (!found) return { fullyMirrored: false };
        const yamlPath = path.join(this.mediaDir, `${found.stem}.yaml`);
        let doc: Record<string, unknown> | null = null;
        if (fs.existsSync(yamlPath)) {
          try {
            doc = yaml.load(fs.readFileSync(yamlPath, 'utf8')) as Record<string, unknown> | null;
          } catch {}
        }
        if (typeof doc?.size === 'number') {
          try {
            if (fs.statSync(found.binaryPath).size !== doc.size) return { fullyMirrored: false };
          } catch {
            return { fullyMirrored: false };
          }
        }
        const state = cache?.getMediaStateByMediaId(keyOrId);
        const companionUlid = mediaRecordIdForStem(this.mediaDir, found.stem);
        if (!state && !companionUlid) return { fullyMirrored: false };
        const resolvedMediaId = state?.mediaId || companionUlid!;
        const resolvedStorageKey =
          found.storageKey ||
          state?.storageKey ||
          (typeof doc?.storageKey === 'string' ? doc.storageKey : undefined);
        return {
          fullyMirrored: true,
          binaryPath: found.binaryPath,
          stem: found.stem,
          mediaId: resolvedMediaId,
          storageKey: resolvedStorageKey,
        };
      } else {
        const found = findLocalBinaryForStorageKey(this.mediaDir, keyOrId, cache, workspaceRoot);
        if (!found) return { fullyMirrored: false };
        const yamlPath = path.join(this.mediaDir, `${found.stem}.yaml`);
        let doc: Record<string, unknown> | null = null;
        if (fs.existsSync(yamlPath)) {
          try {
            doc = yaml.load(fs.readFileSync(yamlPath, 'utf8')) as Record<string, unknown> | null;
          } catch {}
        }
        if (typeof doc?.size === 'number') {
          try {
            if (fs.statSync(found.binaryPath).size !== doc.size) return { fullyMirrored: false };
          } catch {
            return { fullyMirrored: false };
          }
        }
        const state = cache?.getMediaStateByStorageKey(keyOrId);
        const companionUlid = mediaRecordIdForStem(this.mediaDir, found.stem);
        if (!state && !companionUlid) return { fullyMirrored: false };
        const resolvedMediaId = state?.mediaId || companionUlid!;
        return {
          fullyMirrored: true,
          binaryPath: found.binaryPath,
          stem: found.stem,
          mediaId: resolvedMediaId,
          storageKey: keyOrId,
        };
      }
    };

    const bodyCheck: Array<{
      key: string;
      fullyMirrored: boolean;
      binaryPath?: string;
      stem?: string;
      mediaId?: string;
      storageKey?: string;
    }> = bodyStorageKeys.map((k) => ({
      key: k,
      ...isAssetFullyMirrored(k, false),
    }));
    const featuredCheck = featuredMediaId
      ? { id: featuredMediaId, ...isAssetFullyMirrored(featuredMediaId, true) }
      : null;

    const allFullyMirrored =
      bodyCheck.every((b) => b.fullyMirrored) && (!featuredCheck || featuredCheck.fullyMirrored);

    if (allFullyMirrored) {
      // 0-HTTP short-circuit: all referenced assets already exist locally.
      // Upsert media_state for any entries missing localContentHash or unrecorded in DB.
      if (cache) {
        const allItems = [...bodyCheck];
        if (featuredCheck) {
          allItems.push({
            key: featuredCheck.id,
            fullyMirrored: true,
            binaryPath: featuredCheck.binaryPath,
            stem: featuredCheck.stem,
            mediaId: featuredCheck.mediaId,
            storageKey: featuredCheck.storageKey,
          });
        }

        for (const item of allItems) {
          if (!item.binaryPath || !item.stem || !item.mediaId) continue;
          const targetKey = item.storageKey || item.key;
          const brandedStorageKey = toStorageKey(targetKey) ?? asStorageKey(targetKey);
          const existingState = cache.getMediaStateByStorageKey(brandedStorageKey);
          let currentContentHash = existingState?.localContentHash;

          if (!existingState || !currentContentHash) {
            try {
              currentContentHash = computeFileSha256(item.binaryPath);
            } catch {
              continue;
            }
          }

          const confirmedMediaId = existingState?.mediaId || item.mediaId;
          const ext = path.extname(item.binaryPath);
          cache.saveMediaState({
            localHash: `media-record:${confirmedMediaId}`,
            localContentHash: currentContentHash,
            mediaId: toMediaRecordId(confirmedMediaId) ?? asMediaRecordId(confirmedMediaId),
            storageKey: brandedStorageKey,
            url: `${MEDIA_FILE_ROUTE_PREFIX}${targetKey}`,
            workspacePath: path.posix.join('media', `${item.stem}${ext}`),
            markdownRef: path.posix.join('media', item.stem),
            status: 'ready',
            remoteRecordRef: `media-record:${confirmedMediaId}`,
          });
        }
      }

      const totalCount = bodyStorageKeys.length + (featuredMediaId ? 1 : 0);
      for (const k of bodyStorageKeys) {
        this.sessionVerifiedStorageKeys.add(k);
      }
      this.sessionSkipped += totalCount;

      return {
        total: totalCount,
        downloaded: 0,
        skipped: totalCount,
        mirroredStorageKeys: [],
        verifiedStorageKeys: [...bodyStorageKeys],
        orphanStorageKeys: [],
      };
    }

    // Step 3: Remote resolution with in-flight deduplication and fallback handling
    fs.mkdirSync(this.mediaDir, { recursive: true });

    let downloadedCount = 0;
    let skippedCount = 0;
    const articleMirrored = new Set<string>();
    const articleVerified = new Set<string>();
    const articleOrphans = new Set<string>();
    let unresolvedFeaturedImageId: string | undefined = undefined;
    let mediaFetchFailed = false;

    // Helper to mirror an asset through in-flight deduplication
    const runOrJoinInFlight = (
      assetKey: string,
      operation: () => Promise<AssetMirrorOutcome>,
    ): Promise<AssetMirrorOutcome> => {
      let inflight = this.inFlightAssets.get(assetKey);
      if (!inflight) {
        inflight = operation().then((outcome) => {
          if (outcome.downloaded) {
            this.sessionDownloaded++;
          } else if (outcome.skipped) {
            this.sessionSkipped++;
          }
          return outcome;
        });
        this.inFlightAssets.set(assetKey, inflight);
      }
      return inflight;
    };

    // Case B: Single-article pull (not shared session) with no body storageKeys and only featuredImage is missing
    if (!this.isSharedSession && bodyStorageKeys.length === 0 && featuredMediaId) {
      const outcome = await runOrJoinInFlight(`featured:${featuredMediaId}`, async () => {
        try {
          const detailUrl = mediaDetailEndpoint(origin, featuredMediaId);
          const res = await fetchFn(detailUrl, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          });
          if (!res.ok) {
            return { downloaded: false, skipped: false, failed: true };
          }
          const json = await res.json();
          const envelope = unwrapEnvelope<Record<string, unknown>>(json);
          const item = (envelope.item || envelope) as EmDashMediaItem;
          const syncRes = await syncSingleMediaItem({
            item,
            mediaDir: this.mediaDir,
            origin,
            token,
            downloadFiles: shouldDownload,
            fetchFn,
            cache,
          });
          return {
            downloaded: syncRes.downloaded,
            skipped: syncRes.skipped,
            failed: false,
            storageKey: item.storageKey,
          };
        } catch {
          return { downloaded: false, skipped: false, failed: true };
        }
      });

      if (outcome.downloaded) {
        downloadedCount++;
      } else if (outcome.skipped) {
        skippedCount++;
      }

      if (outcome.failed) {
        mediaFetchFailed = true;
        // Non-destructive fallback check: if binary already exists locally, don't mark as unresolved
        const localCheck = isAssetFullyMirrored(featuredMediaId, true);
        if (!localCheck.fullyMirrored) {
          unresolvedFeaturedImageId = featuredMediaId;
        }
      } else if (outcome.storageKey) {
        articleMirrored.add(outcome.storageKey);
        this.sessionMirroredStorageKeys.add(outcome.storageKey);
      }

      return {
        total: 1,
        downloaded: downloadedCount,
        skipped: skippedCount,
        mirroredStorageKeys: Array.from(articleMirrored),
        verifiedStorageKeys: [],
        orphanStorageKeys: [],
        unresolvedFeaturedImageId,
        mediaFetchFailed: mediaFetchFailed ? true : undefined,
      };
    }

    // Case A: Body storageKeys present (or shared batch session)
    let remoteIndex: RemoteStorageKeyIndex | null = null;
    try {
      remoteIndex = await this.getRemoteIndex();
    } catch {
      mediaFetchFailed = true;
    }

    const localCandidates = this.getLocalCandidates();

    // 1. Process body storageKeys
    for (const key of bodyStorageKeys) {
      const outcome = await runOrJoinInFlight(`storageKey:${key}`, async () => {
        let item: EmDashMediaItem | undefined = remoteIndex?.recordsByStorageKey.get(key);
        if (!item && remoteIndex) {
          const ulids = (key.match(/[0-9A-HJ-NP-Z]{26}/gi) ?? []).map((u) => u.toUpperCase());
          for (const ulid of ulids) {
            const byId = remoteIndex.recordsById.get(ulid);
            if (byId) {
              item = byId;
              break;
            }
          }
        }

        if (item) {
          try {
            const syncRes = await syncSingleMediaItem({
              item,
              mediaDir: this.mediaDir,
              origin,
              token,
              downloadFiles: shouldDownload,
              fetchFn,
              cache,
            });
            return {
              downloaded: syncRes.downloaded,
              skipped: syncRes.skipped,
              failed: false,
              storageKey: item.storageKey || key,
            };
          } catch {
            return { downloaded: false, skipped: false, failed: true, storageKey: key };
          }
        }

        return { downloaded: false, skipped: false, failed: true, storageKey: key };
      });

      if (outcome.downloaded) {
        downloadedCount++;
      } else if (outcome.skipped) {
        skippedCount++;
      }

      if (!outcome.failed) {
        if (outcome.storageKey) {
          articleMirrored.add(outcome.storageKey);
          this.sessionMirroredStorageKeys.add(outcome.storageKey);
        }
        articleMirrored.add(key);
        this.sessionMirroredStorageKeys.add(key);
      } else {
        // Fallback evaluation: does local binary exist or is it confirmed in candidates/index?
        const ulids = (key.match(/[0-9A-HJ-NP-Z]{26}/gi) ?? []).map((u) => u.toUpperCase());
        const hasBinary =
          findLocalBinaryForStorageKey(this.mediaDir, key, cache, workspaceRoot) !== null;
        const confirmed =
          hasBinary ||
          (remoteIndex && remoteIndex.storageKeys.has(key)) ||
          ulids.some((u) => remoteIndex?.recordsById.has(u) || localCandidates.has(u));

        if (confirmed) {
          articleVerified.add(key);
          this.sessionVerifiedStorageKeys.add(key);
        } else {
          articleOrphans.add(key);
          this.sessionOrphanStorageKeys.add(key);
          mediaFetchFailed = true;
        }
      }
    }

    // 2. Process featuredImage if present
    if (featuredMediaId) {
      const outcome = await runOrJoinInFlight(`featured:${featuredMediaId}`, async () => {
        let item = remoteIndex?.recordsById.get(featuredMediaId);
        // Only attempt individual GET if the full remote walk didn't already exhaustively cover the library
        if (!item && (!remoteIndex || !remoteIndex.complete)) {
          try {
            const detailUrl = mediaDetailEndpoint(origin, featuredMediaId);
            const res = await fetchFn(detailUrl, {
              headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            });
            if (res.ok) {
              const json = await res.json();
              const envelope = unwrapEnvelope<Record<string, unknown>>(json);
              item = (envelope.item || envelope) as EmDashMediaItem;
            }
          } catch {}
        }

        if (item) {
          try {
            const syncRes = await syncSingleMediaItem({
              item,
              mediaDir: this.mediaDir,
              origin,
              token,
              downloadFiles: shouldDownload,
              fetchFn,
              cache,
            });
            return {
              downloaded: syncRes.downloaded,
              skipped: syncRes.skipped,
              failed: false,
              storageKey: item.storageKey,
            };
          } catch {
            return { downloaded: false, skipped: false, failed: true };
          }
        }

        return { downloaded: false, skipped: false, failed: true };
      });

      if (outcome.downloaded) {
        downloadedCount++;
      } else if (outcome.skipped) {
        skippedCount++;
      }

      if (outcome.failed) {
        const localCheck = isAssetFullyMirrored(featuredMediaId, true);
        if (!localCheck.fullyMirrored) {
          unresolvedFeaturedImageId = featuredMediaId;
          mediaFetchFailed = true;
        }
      } else if (outcome.storageKey) {
        articleMirrored.add(outcome.storageKey);
        this.sessionMirroredStorageKeys.add(outcome.storageKey);
      }
    }

    const totalProcessed = bodyStorageKeys.length + (featuredMediaId ? 1 : 0);

    return {
      total: totalProcessed,
      downloaded: downloadedCount,
      skipped: skippedCount,
      mirroredStorageKeys: Array.from(articleMirrored),
      verifiedStorageKeys: Array.from(articleVerified),
      orphanStorageKeys: Array.from(articleOrphans),
      unresolvedFeaturedImageId,
      mediaFetchFailed: mediaFetchFailed ? true : undefined,
    };
  }

  /**
   * Finalizes media statistics for pullBatch.
   */
  public async finalizeBatchMediaResult(): Promise<{
    walkedCount: number;
    remoteTotalCount: number | null;
    complete: boolean;
    downloaded: number;
    skipped: number;
    mirroredStorageKeys: string[];
    verifiedStorageKeys: string[];
    orphanStorageKeys: string[];
  }> {
    const remoteIndex = await this.getRemoteIndex();
    return {
      walkedCount: remoteIndex.scannedCount,
      remoteTotalCount: remoteIndex.totalCount,
      complete: remoteIndex.complete,
      downloaded: this.sessionDownloaded,
      skipped: this.sessionSkipped,
      mirroredStorageKeys: Array.from(this.sessionMirroredStorageKeys),
      verifiedStorageKeys: Array.from(this.sessionVerifiedStorageKeys),
      orphanStorageKeys: Array.from(this.sessionOrphanStorageKeys),
    };
  }
}

/**
 * Creates a shared MediaMirrorSession.
 */
export function createMediaMirrorSession(options: MediaMirrorSessionOptions): MediaMirrorSession {
  return new MediaMirrorSessionImpl(options);
}

/**
 * Convenience helper to mirror referenced media for a single article.
 */
export async function mirrorArticleReferencedMedia(
  options: PullOptions,
  canonicalMarkdown: string,
  featuredImage?: string | null,
): Promise<PullArticleMediaSummary | undefined> {
  const session =
    options.mediaSession ??
    createMediaMirrorSession({
      workspaceRoot: options.workspaceRoot,
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      cache: options.cache,
      fetchFn: options.fetchFn,
      downloadFiles: true,
      limit: options.mediaSyncLimit,
    });

  return session.mirrorArticleReferencedMedia({
    canonicalMarkdown,
    featuredImage,
  });
}

export interface RestoreSnapshotMediaResult {
  referencedCount: number;
  restored: number;
  skipped: number;
  missing: number;
  corruptKeys: string[];
  warnings: string[];
}

/**
 * Materializes media assets referenced by a snapshot-restored article from `media/_cache/`
 * into workspace `media/` with 0 HTTP requests. Uses `linkSync` -> `COPYFILE_FICLONE` -> `copyFileSync`
 * fallback chain, verifies `size` against `snapshot_media`, synthesizes companion `.yaml`
 * (`id:` = D1 mediaId), and updates `media_state`.
 */
export function restoreSnapshotReferencedMedia(options: {
  workspaceRoot: string;
  cache: CacheDatabase;
  canonicalMarkdown: string;
  featuredImage?: string | null;
}): RestoreSnapshotMediaResult {
  const { workspaceRoot, cache, canonicalMarkdown, featuredImage } = options;
  const mediaDir = path.join(workspaceRoot, 'media');
  const bodyDescriptors = collectArticleStorageKeys(canonicalMarkdown);
  const storageKeys = new Set<string>(bodyDescriptors.map((d) => d.storageKey));

  let restored = 0;
  let skipped = 0;
  let missing = 0;
  const corruptKeys: string[] = [];
  const warnings: string[] = [];

  const featuredUlid = featuredImage ? extractMediaUlid(featuredImage) : null;
  if (featuredUlid) {
    const featuredSnap = cache.getSnapshotMediaById(featuredUlid);
    if (featuredSnap?.storageKey) {
      storageKeys.add(featuredSnap.storageKey);
    } else {
      const existingFeatured = findLocalBinaryForMediaId(
        mediaDir,
        featuredUlid,
        cache,
        workspaceRoot,
      );
      if (existingFeatured) {
        skipped++;
      } else {
        missing++;
      }
    }
  }

  const referencedCount =
    storageKeys.size +
    (featuredUlid && !cache.getSnapshotMediaById(featuredUlid)?.storageKey ? 1 : 0);
  if (referencedCount === 0) {
    return {
      referencedCount: 0,
      restored: 0,
      skipped: 0,
      missing: 0,
      corruptKeys: [],
      warnings: [],
    };
  }

  const mirrorIndex = collectLocalMirrorIndex(workspaceRoot, cache);

  for (const storageKey of storageKeys) {
    if (mirrorIndex.has(storageKey)) {
      skipped++;
      continue;
    }

    const cacheFileName = toMediaCacheFileName(storageKey);
    if (!cacheFileName) {
      missing++;
      continue;
    }

    const snapRow = cache.getSnapshotMediaByStorageKey(storageKey);
    const cacheRelPath = snapRow?.cachePath || path.posix.join('media', '_cache', cacheFileName);
    const cacheAbsPath = path.join(workspaceRoot, cacheRelPath);

    if (!snapRow || !snapRow.cachedAt || !fs.existsSync(cacheAbsPath)) {
      missing++;
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cacheAbsPath);
    } catch {
      missing++;
      continue;
    }

    if (typeof snapRow.size === 'number' && snapRow.size >= 0 && stat.size !== snapRow.size) {
      corruptKeys.push(storageKey);
      missing++;
      warnings.push(
        `[MEDIA_CACHE_CORRUPT key=${storageKey}] expected=${snapRow.size} actual=${stat.size}`,
      );
      continue;
    }

    const stem = storageKeyToMarkdownRef(storageKey);
    if (!stem) {
      missing++;
      continue;
    }

    const ext = path.posix.extname(cacheFileName) || '.jpg';
    const mirrorRelPath = path.posix.join('media', `${stem}${ext}`);
    const mirrorAbsPath = path.join(workspaceRoot, mirrorRelPath);
    const companionAbsPath = path.join(workspaceRoot, 'media', `${stem}.yaml`);

    fs.mkdirSync(mediaDir, { recursive: true });

    if (!fs.existsSync(mirrorAbsPath)) {
      try {
        fs.linkSync(cacheAbsPath, mirrorAbsPath);
      } catch {
        try {
          fs.copyFileSync(cacheAbsPath, mirrorAbsPath, fs.constants.COPYFILE_FICLONE);
        } catch {
          fs.copyFileSync(cacheAbsPath, mirrorAbsPath);
        }
      }
    }

    if (!fs.existsSync(companionAbsPath)) {
      const companionDoc: Record<string, unknown> = {
        id: snapRow.mediaId,
        storageKey,
        filename: snapRow.filename || cacheFileName,
        ...(snapRow.mimeType ? { mimeType: snapRow.mimeType } : {}),
        size: snapRow.size ?? stat.size,
        ...(snapRow.alt ? { alt: snapRow.alt } : {}),
        ...(snapRow.caption ? { caption: snapRow.caption } : {}),
        url: `/_emdash/api/media/file/${storageKey}`,
        status: 'ready',
      };
      fs.writeFileSync(companionAbsPath, yaml.dump(companionDoc), 'utf8');
    }

    cache.saveMediaState({
      mediaId: asMediaRecordId(snapRow.mediaId),
      storageKey: asStorageKey(storageKey),
      url: `/_emdash/api/media/file/${storageKey}`,
      workspacePath: mirrorRelPath,
      markdownRef: stem,
      status: 'ready',
      localContentHash: snapRow.contentHash ?? null,
      uploadedAt: Math.floor(Date.now() / 1000),
    });

    restored++;
  }

  return {
    referencedCount,
    restored,
    skipped,
    missing,
    corruptKeys,
    warnings,
  };
}
