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
import { unwrapEnvelope } from '../../client/api.js';
import { ApiError } from '../../client/error.js';
import { createAuthedFetch } from '../../client/http.js';
import { extractMediaUlid } from '../../client/mapper.js';
import { articleContentEndpoint, mediaDetailEndpoint } from '../../client/endpoints.js';
import type { CacheDatabase } from '../../db/cache.js';
import { DEFAULT_CONFIG } from '../../utils/config.js';
import { parseMarkdown } from '../../utils/frontmatter.js';
import { iterWorkspaceArticles } from '../workspace/index.js';
import { collectArticleReferencedMediaIds, collectArticleStorageKeys } from './body_scan.js';
import { collectLocalMediaMirrorCandidates } from './companions.js';
import { syncSingleMediaItem } from './mirror_item.js';
import { collectRemoteStorageKeys } from './remote_index.js';
import type {
  EmDashMediaItem,
  MirroredAssetResult,
  OrphanMediaDescriptor,
  PullMediaResult,
  RemoteStorageKeyIndex,
} from './types.js';

/**
 * Pulls media referenced by a specific article (by ULID or file path).
 */
export async function pullArticleMedia(options: {
  workspaceRoot: string;
  origin: string;
  token: string;
  refreshToken?: string;
  article: string;
  collection?: string;
  /** Bounds the library walk used to resolve body storageKeys (default `mediaSyncLimit`). */
  limit?: number;
  downloadFiles?: boolean;
  fetchFn?: typeof fetch;
  cache?: CacheDatabase;
}): Promise<PullMediaResult> {
  const fetchFn = createAuthedFetch(options);
  const collection = options.collection || 'posts';
  const downloadFiles = options.downloadFiles !== false;
  const mediaDir = path.join(options.workspaceRoot, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  let articleId = options.article;
  let articleContent: string | null = null;

  // 1. Try resolving as direct file path
  const directPath = path.isAbsolute(options.article)
    ? options.article
    : path.resolve(options.workspaceRoot, options.article);

  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    articleContent = fs.readFileSync(directPath, 'utf8');
    try {
      const parsed = parseMarkdown(articleContent);
      articleId = parsed.frontmatter.id || articleId;
    } catch {
      // Keep articleId as fallback
    }
  } else {
    // 2. Try finding file in <collection>/<locale>/{draft,published}/
    for (const entry of iterWorkspaceArticles(options.workspaceRoot, collection, {
      statuses: ['draft', 'published'],
    })) {
      if (entry.fileName.includes(options.article)) {
        articleContent = fs.readFileSync(entry.fullPath, 'utf8');
        try {
          const parsed = parseMarkdown(articleContent);
          articleId = parsed.frontmatter.id || articleId;
        } catch {
          // fallback
        }
        break;
      }
    }
  }

  // 3. If still absent locally, fetch remote article content from EmDash API
  if (!articleContent) {
    const url = new URL(articleContentEndpoint(options.origin, collection, options.article));
    const res = await fetchFn(url.toString(), {
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new ApiError({
        message: `Failed to fetch remote article for media resolution: ${res.statusText}`,
        code: 'ARTICLE_NOT_FOUND',
        status: res.status,
        endpoint: url.toString(),
        suggestion: `Verify that article '${options.article}' exists in collection '${collection}' on remote.`,
      });
    }

    const json = await res.json();
    const data = unwrapEnvelope<Record<string, unknown>>(json);
    const item = (data.item || data) as Record<string, unknown>;
    articleId = (item.id as string) || options.article;

    // Build a content string from the remote representation so references can be collected even when
    // no local file exists yet.
    const remoteFi = item.featured_image || item.featuredImage;
    const fiId = extractMediaUlid(remoteFi);
    const fiPart = fiId ? `featuredImage: ${fiId}\n` : '';
    const bodyPart =
      typeof item.content === 'string'
        ? item.content
        : JSON.stringify(item.content || item.body || '');
    articleContent = `---\n${fiPart}---\n${bodyPart}`;
  }

  const mediaIds = collectArticleReferencedMediaIds(articleContent);
  // Body storageKeys are the only handle available when a migrated body bakes the R2 `storageKey`
  // instead of the D1 record id. They must never be fed to `GET /_emdash/api/media/{id}` as if they
  // were ids: that lookup keys on the primary key, so it returns 404 for a record that does exist.
  const storageKeyDescriptors = collectArticleStorageKeys(articleContent);
  const descriptorsByKey = new Map<string, OrphanMediaDescriptor>();
  for (const descriptor of storageKeyDescriptors) {
    descriptorsByKey.set(descriptor.storageKey, descriptor);
  }
  const allKeys = Array.from(descriptorsByKey.keys()).sort();

  if (mediaIds.length === 0 && allKeys.length === 0) {
    return {
      total: 0,
      downloaded: 0,
      skipped: 0,
      failed: 0,
      articleId,
      mediaIds: [],
      orphanStorageKeys: [],
    };
  }

  let downloadedCount = 0;
  let skippedCount = 0;
  // A body ULID that no canonical lookup resolves is the normal shape of a migrated corpus: the URL
  // carries an R2 storageKey, not a media id. Only a reference that also survives every storageKey
  // check is a problem, so a failed id lookup alone is never reported as `failed`.
  let unresolvedIdCount = 0;
  const recoveredStorageKeys = new Set<string>();
  // Ids whose canonical lookup succeeded. A body key sharing one of these ULIDs is a confirmed match:
  // the record exists, it simply carries a storageKey that differs from the one baked into the body.
  const resolvedRecordIds = new Set<string>();

  // If storageKeys are present in the body, fetch the remote index to resolve them loss-free. The walk is
  // bounded by `limit` (default `mediaSyncLimit`, or unlimited for `--all`) exactly like the library pass, so a
  // fleet-scale library never turns one article's media pull into an unbounded scan. A key that falls outside
  // the window is never asserted absent: it stays in `verifiedStorageKeys`/`orphanStorageKeys` evaluation, and
  // `complete === false` keeps every per-record lookup available downstream.
  let remoteIndex: RemoteStorageKeyIndex | null = null;
  if (allKeys.length > 0) {
    try {
      remoteIndex = await collectRemoteStorageKeys({
        workspaceRoot: options.workspaceRoot,
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        maxItems: options.limit ?? DEFAULT_CONFIG.mediaSyncLimit,
        fetchFn,
      });
    } catch {}
  }

  // 1. Resolve body storageKeys using mirrorReferencedAssetsFromIndex if remoteIndex is available
  let mirrorResult: MirroredAssetResult | null = null;
  if (remoteIndex && allKeys.length > 0) {
    mirrorResult = await mirrorReferencedAssetsFromIndex(allKeys, remoteIndex, {
      workspaceRoot: options.workspaceRoot,
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      downloadFiles,
      fetchFn,
      cache: options.cache,
    });
    downloadedCount += mirrorResult.downloaded;
    skippedCount += mirrorResult.skipped;
    for (const key of mirrorResult.mirroredStorageKeys) {
      recoveredStorageKeys.add(key);
    }
  }

  // 2. Canonical path: resolve each referenced media record id and mirror it normally.
  for (const mId of mediaIds) {
    let covered = false;
    for (const recKey of recoveredStorageKeys) {
      if (recKey.toUpperCase().includes(mId.toUpperCase())) {
        covered = true;
        break;
      }
    }
    if (covered) {
      resolvedRecordIds.add(mId.toUpperCase());
      continue;
    }

    try {
      let item: EmDashMediaItem | undefined = remoteIndex?.recordsById.get(mId.toUpperCase());
      if (!item) {
        const mediaUrl = new URL(mediaDetailEndpoint(options.origin, mId));
        const res = await fetchFn(mediaUrl.toString(), {
          headers: {
            Authorization: `Bearer ${options.token}`,
            Accept: 'application/json',
          },
        });

        if (!res.ok) {
          unresolvedIdCount++;
          continue;
        }

        const json = await res.json();
        const envelope = unwrapEnvelope<Record<string, unknown>>(json);
        item = (envelope.item || envelope) as EmDashMediaItem;
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
      resolvedRecordIds.add(mId.toUpperCase());
      if (item.storageKey) recoveredStorageKeys.add(item.storageKey);
    } catch {
      unresolvedIdCount++;
    }
  }

  // 3. Unresolved storageKeys: evaluate verified vs orphan
  const mirrorCandidates = collectLocalMediaMirrorCandidates(mediaDir);
  const verifiedStorageKeys: string[] = mirrorResult ? [...mirrorResult.verifiedStorageKeys] : [];
  const orphanStorageKeys: string[] = mirrorResult ? [...mirrorResult.orphanStorageKeys] : [];

  for (const key of allKeys) {
    if (recoveredStorageKeys.has(key)) continue;
    if (verifiedStorageKeys.includes(key) || orphanStorageKeys.includes(key)) continue;
    const ulids = (key.match(/[0-9A-HJ-NP-Z]{26}/gi) ?? []).map((u) => u.toUpperCase());
    const confirmed =
      (remoteIndex && remoteIndex.storageKeys.has(key)) ||
      ulids.some((ulid) => resolvedRecordIds.has(ulid) || mirrorCandidates.has(ulid));
    if (confirmed) {
      verifiedStorageKeys.push(key);
      continue;
    }
    orphanStorageKeys.push(key);
  }

  return {
    total: mediaIds.length + verifiedStorageKeys.length + orphanStorageKeys.length,
    downloaded: downloadedCount,
    skipped: skippedCount,
    failed: orphanStorageKeys.length,
    unresolvedIds: unresolvedIdCount,
    articleId,
    mediaIds,
    verifiedStorageKeys,
    orphanStorageKeys,
  };
}

/**
 * Mirrors only the assets a batch of pulled articles actually references, reusing the records the lightweight
 * index walk already fetched instead of paying for a per-asset `GET /_emdash/api/media/{id}`.
 *
 * This is the mirror half of the default-ON local-first pull: the walk phase builds `RemoteStorageKeyIndex`
 * (JSON only, no binaries), and this phase downloads the binary + companion YAML for exactly the storageKeys
 * found in article bodies. A key the walk did not report is NOT proof of a missing record — the record can
 * exist under a different primary key while the body carries an R2 storageKey — so it is re-checked against
 * confirmed evidence only (a walked record resolved under that exact ULID, or local mirror metadata) and what
 * still fails is reported as `orphanStorageKeys`. Emit never fetches such an asset and never registers one.
 */
export async function mirrorReferencedAssetsFromIndex(
  referencedStorageKeys: Iterable<string>,
  index: RemoteStorageKeyIndex,
  options: {
    workspaceRoot: string;
    origin: string;
    token: string;
    refreshToken?: string;
    downloadFiles?: boolean;
    fetchFn?: typeof fetch;
    cache?: CacheDatabase;
  },
): Promise<MirroredAssetResult> {
  const fetchFn = createAuthedFetch(options);
  const downloadFiles = options.downloadFiles !== false;
  const mediaDir = path.join(options.workspaceRoot, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const mirroredStorageKeys = new Set<string>();
  let downloadedCount = 0;
  let skippedCount = 0;

  // Walk every referenced key once. A key resolves to a walked record either directly (the walk reported
  // that exact storageKey) or through a ULID the walk resolved under that record id — the migrated-corpus
  // case where the body URL bakes an R2 storageKey that differs from the record's own primary key.
  const referenced = [...referencedStorageKeys];
  const mirrorCandidates = collectLocalMediaMirrorCandidates(mediaDir);
  const verifiedStorageKeys: string[] = [];
  const orphanStorageKeys: string[] = [];

  for (const key of referenced) {
    let item: EmDashMediaItem | undefined = index.recordsByStorageKey.get(key);
    if (!item) {
      // The body key may itself be a record id the walk stored under `recordsById`, or share a ULID with a
      // walked record. Reuse that record rather than re-fetching it.
      const ulids = (key.match(/[0-9A-HJ-NP-Z]{26}/gi) ?? []).map((u) => u.toUpperCase());
      for (const ulid of ulids) {
        const byId = index.recordsById.get(ulid);
        if (byId) {
          item = byId;
          break;
        }
      }
    }

    if (item) {
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
      if (item.storageKey) mirroredStorageKeys.add(item.storageKey);
      mirroredStorageKeys.add(key);
      continue;
    }

    // No walked record owns this key. Only two things count as evidence it is healthy: a local mirror
    // companion already names the ULID, or the walk stored a matching storageKey. A bare body reference is
    // never self-confirming — that is precisely the case to report rather than assume healthy.
    const ulids = (key.match(/[0-9A-HJ-NP-Z]{26}/gi) ?? []).map((u) => u.toUpperCase());
    const confirmed =
      index.storageKeys.has(key) ||
      ulids.some((ulid) => index.recordsById.has(ulid) || mirrorCandidates.has(ulid));
    if (confirmed) {
      verifiedStorageKeys.push(key);
    } else {
      orphanStorageKeys.push(key);
    }
  }

  return {
    mirroredStorageKeys,
    downloaded: downloadedCount,
    skipped: skippedCount,
    verifiedStorageKeys,
    orphanStorageKeys,
  };
}
