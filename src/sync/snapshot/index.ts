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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { extractComparisonRev, isSameRev, unwrapEnvelope } from '../../client/api.js';
import { articleContentEndpoint, mediaFileEndpoint } from '../../client/endpoints.js';
import { createAuthedFetch } from '../../client/http.js';
import {
  extractBylinesFromRaw,
  extractFeaturedImageFromRaw,
  extractLocaleFromRaw,
  extractSeoFromRaw,
} from '../../client/mapper.js';
import { portableTextToMarkdown, type PortableTextBlock } from '../../client/portable-text.js';
import { readBaselineFrontmatter } from '../../db/baseline.js';
import type {
  CacheDatabase,
  SnapshotArticleRecord,
  SnapshotBodySource,
  SnapshotMediaRecord,
} from '../../db/cache.js';
import { loadConfig } from '../../utils/config.js';
import {
  DEFAULT_SNAPSHOT_MEDIA_LIMIT,
  DEFAULT_SNAPSHOT_MEDIA_MAX_BYTES,
  mediaCacheDir,
  toMediaCacheFileName,
} from '../../utils/media-cache.js';
import { resolveSnapshotMediaOption } from '../../utils/media-ref-precedence.js';
import { resolveConcurrency } from '../../utils/sync-limit-precedence.js';
import {
  collectArticleStorageKeys,
  collectLocalMirrorIndex,
  collectWorkspaceArticleStorageKeys,
  fetchMediaListPage,
} from '../media/index.js';
import { listRemoteArticles } from '../pull/index.js';
import {
  canonicalizeTaxonomiesForBaseline,
  loadLocalTaxonomyMaps,
  pullTaxonomies,
} from '../taxonomies.js';
import { fetchAssignedTaxonomies } from '../terms.js';
import { syncRemoteBylines } from '../bylines.js';
import type {
  SnapshotCaptureOptions,
  SnapshotCaptureResult,
  SnapshotClearResult,
  SnapshotPruneCacheResult,
  SnapshotStatusResult,
} from './types.js';

export type {
  SnapshotCaptureOptions,
  SnapshotCaptureResult,
  SnapshotStatusResult,
  SnapshotClearResult,
  SnapshotPruneCacheResult,
};

const MEDIA_SNAPSHOT_BATCH_SIZE = 100;

function extractBodyMarkdownFromRaw(rawObj: Record<string, unknown>): string {
  const data = (rawObj.data && typeof rawObj.data === 'object' ? rawObj.data : {}) as Record<
    string,
    unknown
  >;
  const content = data.content;
  if (Array.isArray(content)) {
    return portableTextToMarkdown(content as PortableTextBlock[]);
  }
  if (typeof content === 'string') {
    return content;
  }
  return '';
}

function extractIsoField(rawObj: Record<string, unknown>, key: string): string | null {
  const val = rawObj[key];
  return typeof val === 'string' && val.trim() ? val : null;
}

/**
 * Captures a point-in-time metadata & verified-body snapshot of the entire remote EmDash library
 * (taxonomies, articles, and media metadata) into `.emit/cache.db` (Schema v6) without modifying
 * any workspace Markdown or media files on disk.
 */
export async function captureWorkspaceSnapshot(
  options: SnapshotCaptureOptions,
): Promise<SnapshotCaptureResult> {
  const startedAt = Date.now();
  const collection = options.collection || 'posts';
  const fetchFn = createAuthedFetch({
    origin: options.origin,
    token: options.token,
    refreshToken: options.refreshToken,
    fetchFn: options.fetchFn,
  });

  const config = loadConfig(options.workspaceRoot);
  const concurrency = Math.max(1, resolveConcurrency(config, { concurrency: options.concurrency }));

  // Stage 1: Refresh taxonomy definitions (categories/ & tags/) so alias resolution stays current
  let categoriesSynced = 0;
  let tagsSynced = 0;
  let taxonomyWarning: string | undefined;
  try {
    const taxRes = await pullTaxonomies({
      workspaceRoot: options.workspaceRoot,
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      fetchFn,
    });
    categoriesSynced = taxRes.categoriesCount;
    tagsSynced = taxRes.tagsCount;
    if (taxRes.categoriesFailed || taxRes.tagsFailed) {
      const failed = [
        taxRes.categoriesFailed ? 'categories' : null,
        taxRes.tagsFailed ? 'tags' : null,
      ].filter(Boolean);
      taxonomyWarning = `Failed to sync remote taxonomy definitions (${failed.join(', ')}); kept existing local definitions.`;
    }
  } catch (err: unknown) {
    taxonomyWarning = err instanceof Error ? err.message : String(err);
  }

  const localTaxonomyMaps = loadLocalTaxonomyMaps(options.workspaceRoot);

  // Also refresh bylines table in cache.db (1 GET, non-fatal fallback to cached maps)
  let bylineIdToSlug: Record<string, string> = {};
  try {
    const bylineMaps = await syncRemoteBylines({
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      cache: options.cache,
      fetchFn,
    });
    bylineIdToSlug = bylineMaps.idToSlug;
  } catch {
    bylineIdToSlug = options.cache.getBylineMaps().idToSlug;
  }

  // Stage 2: Walk all remote articles (published + draft)
  const remoteItems = await listRemoteArticles(collection, {
    origin: options.origin,
    token: options.token,
    refreshToken: options.refreshToken,
    status: 'all',
    all: true,
    fetchFn,
  });

  const prevSnapshotMap = new Map<string, SnapshotArticleRecord>();
  for (const row of options.cache.listSnapshotArticles(collection)) {
    prevSnapshotMap.set(row.id, row);
  }

  let taxonomyFetchedCount = 0;
  let taxonomyReusedCount = 0;
  let articleSingleGetCount = 0;
  const articleRecords: SnapshotArticleRecord[] = new Array(remoteItems.length);
  const capturedAt = Date.now();

  let cursorIndex = 0;
  const workerCount = Math.min(concurrency, Math.max(1, remoteItems.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const idx = cursorIndex++;
      if (idx >= remoteItems.length) break;

      const item = remoteItems[idx]!;
      const rawObj = item.rawItem;
      const rawData = (rawObj.data && typeof rawObj.data === 'object' ? rawObj.data : {}) as Record<
        string,
        unknown
      >;
      const comparisonRev = extractComparisonRev(rawObj, item._rev);
      const isDraft = item.status.toLowerCase() !== 'published';
      const hasDraftRevision = Boolean(rawObj.draftRevisionId);
      const needsSingleGetForBody = isDraft || hasDraftRevision;

      const syncState = options.cache.getSyncState(item.id);
      const baseSnapshot = syncState ? options.cache.getBaseSnapshot(item.id) : null;
      const prevSnapshot = prevSnapshotMap.get(item.id);

      const syncStateClean =
        Boolean(syncState) &&
        syncState!.deletePending !== 1 &&
        syncState!.bodyConflictPending !== 1 &&
        syncState!.taxonomyApplyPending !== 1 &&
        syncState!.taxonomyConflictPending !== 1 &&
        isSameRev(syncState!.remoteRev, comparisonRev);

      const baseFm = syncStateClean && baseSnapshot ? readBaselineFrontmatter(baseSnapshot) : null;

      // (a) Resolve verified bodyMarkdown, bodySource & v7 metadata columns (A-1: Draft Selective Single GET Invariant)
      let bodyMarkdown = '';
      let bodySource: SnapshotBodySource = 'list-live';
      let featuredImage: string | null = extractFeaturedImageFromRaw(rawObj) ?? null;
      let seoJson = JSON.stringify(extractSeoFromRaw(rawObj) ?? {});
      let locale = extractLocaleFromRaw(rawObj);
      let bylinesJson = JSON.stringify(extractBylinesFromRaw(rawObj, bylineIdToSlug));

      if (!needsSingleGetForBody) {
        bodyMarkdown = extractBodyMarkdownFromRaw(rawObj);
        bodySource = 'list-live';
      } else if (syncStateClean && baseSnapshot) {
        bodyMarkdown = baseSnapshot.bodyMarkdown;
        bodySource = 'single-get';
        if (baseFm) {
          featuredImage = baseFm.featuredImage ?? null;
          seoJson = JSON.stringify(baseFm.seo ?? {});
          locale = baseFm.locale || locale;
          bylinesJson = JSON.stringify(baseFm.bylines ?? []);
        }
      } else if (
        prevSnapshot &&
        prevSnapshot.locale !== null &&
        prevSnapshot.locale !== undefined &&
        isSameRev(prevSnapshot.comparisonRev, comparisonRev) &&
        prevSnapshot.bodySource === 'single-get'
      ) {
        bodyMarkdown = prevSnapshot.bodyMarkdown;
        bodySource = 'single-get';
        featuredImage = prevSnapshot.featuredImage ?? null;
        seoJson = prevSnapshot.seoJson ?? '{}';
        locale = prevSnapshot.locale;
        bylinesJson = prevSnapshot.bylinesJson ?? '[]';
      } else {
        try {
          articleSingleGetCount++;
          const detailRes = await fetchFn(
            articleContentEndpoint(options.origin, collection, item.id),
            {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${options.token}`,
                Accept: 'application/json',
              },
            },
          );
          if (detailRes.ok) {
            const detailJson = unwrapEnvelope<Record<string, unknown>>(await detailRes.json());
            bodyMarkdown = extractBodyMarkdownFromRaw(detailJson);
            bodySource = 'single-get';
            featuredImage = extractFeaturedImageFromRaw(detailJson) ?? null;
            seoJson = JSON.stringify(extractSeoFromRaw(detailJson) ?? {});
            locale = extractLocaleFromRaw(detailJson);
            bylinesJson = JSON.stringify(extractBylinesFromRaw(detailJson, bylineIdToSlug));
          } else {
            bodyMarkdown = extractBodyMarkdownFromRaw(rawObj);
            bodySource = 'list-stale';
          }
        } catch {
          bodyMarkdown = extractBodyMarkdownFromRaw(rawObj);
          bodySource = 'list-stale';
        }
      }

      // (b) Resolve taxonomies (0-GET reuse when comparisonRev matches and verified; R-2)
      let categories: string[] = [];
      let tags: string[] = [];
      let taxonomyVerified = 1;

      const baseHasTax =
        baseFm?.taxonomies &&
        typeof baseFm.taxonomies === 'object' &&
        (Array.isArray(baseFm.taxonomies.categories) || Array.isArray(baseFm.taxonomies.tags));

      if (baseHasTax && baseFm) {
        const canonical = canonicalizeTaxonomiesForBaseline(
          {
            categories: Array.isArray(baseFm.taxonomies?.categories)
              ? baseFm.taxonomies.categories.map(String)
              : [],
            tags: Array.isArray(baseFm.taxonomies?.tags) ? baseFm.taxonomies.tags.map(String) : [],
          },
          localTaxonomyMaps,
        );
        categories = canonical.categories;
        tags = canonical.tags;
        taxonomyVerified = 1;
        taxonomyReusedCount++;
      } else if (
        prevSnapshot &&
        isSameRev(prevSnapshot.comparisonRev, comparisonRev) &&
        prevSnapshot.taxonomyVerified === 1 &&
        prevSnapshot.bodySource !== 'list-stale'
      ) {
        const parsedCats = JSON.parse(prevSnapshot.categoriesJson) as string[];
        const parsedTags = JSON.parse(prevSnapshot.tagsJson) as string[];
        const canonical = canonicalizeTaxonomiesForBaseline(
          { categories: parsedCats, tags: parsedTags },
          localTaxonomyMaps,
        );
        categories = canonical.categories;
        tags = canonical.tags;
        taxonomyVerified = 1;
        taxonomyReusedCount++;
      } else {
        taxonomyFetchedCount++;
        const fetched = await fetchAssignedTaxonomies({
          origin: options.origin,
          token: options.token,
          collection,
          id: item.id,
          fetchFn,
        });
        const canonical = canonicalizeTaxonomiesForBaseline(
          {
            categories: fetched.categories ?? [],
            tags: fetched.tags ?? [],
          },
          localTaxonomyMaps,
        );
        categories = canonical.categories;
        tags = canonical.tags;
        taxonomyVerified = fetched.categories !== null && fetched.tags !== null ? 1 : 0;
      }

      const excerptVal = rawData.excerpt ?? rawObj.excerpt;
      const excerpt = typeof excerptVal === 'string' && excerptVal.trim() ? excerptVal : null;

      articleRecords[idx] = {
        id: item.id,
        collection,
        slug: item.slug,
        title: item.title,
        status: item.status,
        createdAt: extractIsoField(rawObj, 'createdAt'),
        updatedAt: extractIsoField(rawObj, 'updatedAt'),
        publishedAt: extractIsoField(rawObj, 'publishedAt'),
        comparisonRev,
        excerpt,
        bodyMarkdown,
        bodySource,
        categoriesJson: JSON.stringify(categories),
        tagsJson: JSON.stringify(tags),
        taxonomyVerified,
        featuredImage,
        seoJson,
        locale,
        bylinesJson,
        capturedAt,
      };
    }
  });
  await Promise.all(workers);

  const articleWriteRes = options.cache.upsertSnapshotArticlesBatch({
    collection,
    records: articleRecords,
    walkComplete: true,
  });

  // Stage 3: Walk all remote media metadata (0 binary downloads)
  const mediaRecords: SnapshotMediaRecord[] = [];
  let mediaCursor: string | undefined = undefined;
  for (;;) {
    const page = await fetchMediaListPage({
      origin: options.origin,
      token: options.token,
      limit: MEDIA_SNAPSHOT_BATCH_SIZE,
      cursor: mediaCursor,
      fetchFn,
    });

    for (const m of page.rawItems) {
      if (!m.id) continue;
      mediaRecords.push({
        mediaId: m.id.toUpperCase(),
        storageKey: m.storageKey || null,
        filename: m.filename || null,
        mimeType: m.mimeType || null,
        size: typeof m.size === 'number' ? m.size : null,
        alt: m.alt || null,
        caption: m.caption || null,
        createdAt: m.createdAt || null,
        capturedAt,
      });
    }

    if (!page.nextCursor || page.rawItems.length === 0) {
      break;
    }
    mediaCursor = page.nextCursor;
  }

  const mediaWriteRes = options.cache.upsertSnapshotMediaBatch({
    records: mediaRecords,
    walkComplete: true,
  });

  // Stage 3b: Opt-in offline media binary cache into `media/_cache/` (budgeted, 0-GET skip)
  let mediaCached = 0;
  let mediaCacheSkipped = 0;
  let mediaCacheBytes = 0;
  let mediaCacheBudgetHit = false;
  let mediaCacheTotalCandidates = 0;

  const includeMedia = resolveSnapshotMediaOption(options.includeMedia, config);
  if (includeMedia) {
    const budgetLimit = Math.max(
      0,
      options.mediaCacheLimit ?? config.snapshotMediaLimit ?? DEFAULT_SNAPSHOT_MEDIA_LIMIT,
    );
    const budgetMaxBytes = Math.max(
      0,
      options.mediaCacheMaxBytes ??
        config.snapshotMediaMaxBytes ??
        DEFAULT_SNAPSHOT_MEDIA_MAX_BYTES,
    );
    const cacheDir = mediaCacheDir(path.join(options.workspaceRoot, 'media'));
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheGitignore = path.join(cacheDir, '.gitignore');
    if (!fs.existsSync(cacheGitignore)) {
      fs.writeFileSync(cacheGitignore, '*\n', 'utf8');
    }

    const mirrorIndex = collectLocalMirrorIndex(options.workspaceRoot, options.cache);
    const allMedia = options.cache.listSnapshotMedia();
    const candidates: Array<{
      rec: SnapshotMediaRecord;
      fileName: string;
      cacheRelPath: string;
      cacheAbsPath: string;
    }> = [];

    for (const rec of allMedia) {
      if (!rec.storageKey) continue;
      const fileName = toMediaCacheFileName(rec.storageKey);
      if (!fileName) continue;
      if (mirrorIndex.has(rec.storageKey)) {
        mediaCacheSkipped++;
        continue;
      }
      const cacheRelPath = path.posix.join('media', '_cache', fileName);
      const cacheAbsPath = path.join(options.workspaceRoot, cacheRelPath);
      if (rec.cachedAt && fs.existsSync(cacheAbsPath)) {
        mediaCacheSkipped++;
        continue;
      }
      candidates.push({ rec, fileName, cacheRelPath, cacheAbsPath });
    }

    mediaCacheTotalCandidates = candidates.length;

    const toDownload: typeof candidates = [];
    let plannedBytes = 0;
    for (const cand of candidates) {
      const estSize = typeof cand.rec.size === 'number' && cand.rec.size > 0 ? cand.rec.size : 0;
      if (
        toDownload.length >= budgetLimit ||
        (estSize > 0 && plannedBytes + estSize > budgetMaxBytes)
      ) {
        mediaCacheBudgetHit = true;
        break;
      }
      toDownload.push(cand);
      plannedBytes += estSize;
    }

    let dlCursor = 0;
    const dlWorkers = Array.from(
      { length: Math.min(concurrency, Math.max(1, toDownload.length)) },
      async () => {
        for (;;) {
          const i = dlCursor++;
          if (i >= toDownload.length) break;
          const { rec, fileName, cacheRelPath, cacheAbsPath } = toDownload[i]!;
          const tmpPath = path.join(cacheDir, `.tmp-${fileName}-${process.pid}-${i}`);
          try {
            const res = await fetchFn(mediaFileEndpoint(options.origin, rec.storageKey!), {
              method: 'GET',
              headers: { Authorization: `Bearer ${options.token}` },
            });
            if (!res.ok) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            if (typeof rec.size === 'number' && rec.size >= 0 && buf.byteLength !== rec.size) {
              continue;
            }
            fs.writeFileSync(tmpPath, buf);
            fs.renameSync(tmpPath, cacheAbsPath);
            const contentHash = `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
            options.cache.markMediaCached(rec.mediaId, {
              cachedAt: Date.now(),
              cachePath: cacheRelPath,
              contentHash,
            });
            mediaCached++;
            mediaCacheBytes += buf.byteLength;
          } catch {
            try {
              if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
            } catch {
              // ignore cleanup failure
            }
          }
        }
      },
    );
    await Promise.all(dlWorkers);
  }

  // Stage 4: Commit snapshot_meta timestamp after both article & media walks succeed
  const finalCapturedAt = Date.now();
  const durationMs = Math.max(0, finalCapturedAt - startedAt);
  options.cache.saveSnapshotMeta({
    collection,
    capturedAt: finalCapturedAt,
    articleCount: articleRecords.length,
    mediaCount: mediaRecords.length,
    taxonomyFetchedCount,
    taxonomyReusedCount,
    articleSingleGetCount,
    durationMs,
  });

  return {
    collection,
    capturedAt: finalCapturedAt,
    articleCount: articleRecords.length,
    articlesPruned: articleWriteRes.pruned,
    mediaCount: mediaRecords.length,
    mediaPruned: mediaWriteRes.pruned,
    mediaCached,
    mediaCacheSkipped,
    mediaCacheBytes,
    mediaCacheBudgetHit,
    mediaCacheTotalCandidates,
    taxonomyFetchedCount,
    taxonomyReusedCount,
    articleSingleGetCount,
    categoriesSynced,
    tagsSynced,
    taxonomyWarning,
    durationMs,
  };
}

/**
 * Reads the current snapshot metadata status from `.emit/cache.db` (0 HTTP requests).
 */
export function getWorkspaceSnapshotStatus(
  cache: CacheDatabase,
  collection = 'posts',
  workspaceRoot?: string,
): SnapshotStatusResult {
  const meta = cache.getSnapshotMeta(collection);
  if (!workspaceRoot) {
    return { collection, meta };
  }

  let cachedCount = 0;
  let totalBytes = 0;
  for (const row of cache.listCachedSnapshotMedia()) {
    if (!row.cachePath) continue;
    const cacheAbs = path.join(workspaceRoot, row.cachePath);
    if (!fs.existsSync(cacheAbs)) continue;
    try {
      const stat = fs.statSync(cacheAbs);
      if (stat.isFile()) {
        cachedCount++;
        totalBytes += stat.size;
      }
    } catch {
      // ignore unreadable cache file
    }
  }

  return {
    collection,
    meta,
    mediaCache: { cachedCount, totalBytes },
  };
}

/**
 * Clears all snapshot catalog records from `.emit/cache.db` (0 HTTP requests) and,
 * when the last `snapshot_meta` row is cleared, unlinks unreferenced `media/_cache/` files.
 */
export function clearWorkspaceSnapshot(
  cache: CacheDatabase,
  collection = 'posts',
  workspaceRoot?: string,
): SnapshotClearResult {
  // ★C2: Collect referenced storageKeys BEFORE clearSnapshot() deletes snapshot_articles!
  const cachedRows = workspaceRoot ? cache.listCachedSnapshotMedia() : [];
  const referencedKeys = new Set<string>();
  let willClearAllMedia = false;

  if (workspaceRoot) {
    const totalMeta = cache.countSnapshotMeta();
    const hasTargetMeta = Boolean(cache.getSnapshotMeta(collection));
    willClearAllMedia = totalMeta === 0 || (hasTargetMeta && totalMeta <= 1);

    if (willClearAllMedia) {
      for (const key of collectWorkspaceArticleStorageKeys(workspaceRoot, collection)) {
        referencedKeys.add(key);
      }
      for (const art of cache.listSnapshotArticles(collection)) {
        for (const desc of collectArticleStorageKeys(art.bodyMarkdown)) {
          referencedKeys.add(desc.storageKey);
        }
      }
    }
  }

  const res = cache.clearSnapshot(collection);

  let cacheFilesDeleted = 0;
  let cacheFilesPreserved = 0;
  if (workspaceRoot && willClearAllMedia) {
    for (const row of cachedRows) {
      if (!row.cachePath) continue;
      const absPath = path.join(workspaceRoot, row.cachePath);
      if (row.storageKey && referencedKeys.has(row.storageKey)) {
        cacheFilesPreserved++;
        continue;
      }
      if (fs.existsSync(absPath)) {
        try {
          fs.unlinkSync(absPath);
          cacheFilesDeleted++;
        } catch {
          // ignore unlink error
        }
      }
    }
  }

  return {
    collection,
    ...res,
    cacheFilesDeleted,
    cacheFilesPreserved,
  };
}

/**
 * Deletes orphaned files in `media/_cache/` that are no longer referenced by any
 * `snapshot_media` manifest entry.
 */
export function pruneOrphanMediaCache(
  cache: CacheDatabase,
  workspaceRoot: string,
): SnapshotPruneCacheResult {
  const cacheDir = mediaCacheDir(path.join(workspaceRoot, 'media'));
  if (!fs.existsSync(cacheDir)) {
    return { deletedFiles: 0, preservedFiles: 0 };
  }

  const validFileNames = new Set<string>();
  for (const row of cache.listCachedSnapshotMedia()) {
    if (row.cachePath) {
      validFileNames.add(path.posix.basename(row.cachePath));
    }
  }

  let deletedFiles = 0;
  let preservedFiles = 0;
  for (const entry of fs.readdirSync(cacheDir)) {
    if (entry === '.gitignore' || entry.startsWith('.')) continue;
    const full = path.join(cacheDir, entry);
    try {
      if (!fs.statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    if (validFileNames.has(entry)) {
      preservedFiles++;
    } else {
      try {
        fs.unlinkSync(full);
        deletedFiles++;
      } catch {
        // ignore
      }
    }
  }

  return { deletedFiles, preservedFiles };
}
