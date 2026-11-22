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

import { extractComparisonRev, isSameRev, unwrapEnvelope } from '../../client/api.js';
import { articleContentEndpoint } from '../../client/endpoints.js';
import { createAuthedFetch } from '../../client/http.js';
import { portableTextToMarkdown, type PortableTextBlock } from '../../client/portable-text.js';
import { readBaselineFrontmatter } from '../../db/baseline.js';
import type {
  CacheDatabase,
  SnapshotArticleRecord,
  SnapshotBodySource,
  SnapshotMediaRecord,
} from '../../db/cache.js';
import { loadConfig } from '../../utils/config.js';
import { resolveConcurrency } from '../../utils/sync-limit-precedence.js';
import { fetchMediaListPage } from '../media/index.js';
import { listRemoteArticles } from '../pull/index.js';
import {
  canonicalizeTaxonomiesForBaseline,
  loadLocalTaxonomyMaps,
  pullTaxonomies,
} from '../taxonomies.js';
import { fetchAssignedTaxonomies } from '../terms.js';
import type {
  SnapshotCaptureOptions,
  SnapshotCaptureResult,
  SnapshotClearResult,
  SnapshotStatusResult,
} from './types.js';

export type {
  SnapshotCaptureOptions,
  SnapshotCaptureResult,
  SnapshotStatusResult,
  SnapshotClearResult,
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

      // (a) Resolve verified bodyMarkdown & bodySource (A-1: Draft Selective Single GET Invariant)
      let bodyMarkdown = '';
      let bodySource: SnapshotBodySource = 'list-live';

      if (!needsSingleGetForBody) {
        bodyMarkdown = extractBodyMarkdownFromRaw(rawObj);
        bodySource = 'list-live';
      } else if (syncStateClean && baseSnapshot) {
        bodyMarkdown = baseSnapshot.bodyMarkdown;
        bodySource = 'single-get';
      } else if (
        prevSnapshot &&
        isSameRev(prevSnapshot.comparisonRev, comparisonRev) &&
        prevSnapshot.bodySource === 'single-get'
      ) {
        bodyMarkdown = prevSnapshot.bodyMarkdown;
        bodySource = 'single-get';
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

      const baseFm = syncStateClean && baseSnapshot ? readBaselineFrontmatter(baseSnapshot) : null;
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
): SnapshotStatusResult {
  return {
    collection,
    meta: cache.getSnapshotMeta(collection),
  };
}

/**
 * Clears all snapshot catalog records from `.emit/cache.db` (0 HTTP requests).
 */
export function clearWorkspaceSnapshot(
  cache: CacheDatabase,
  collection = 'posts',
): SnapshotClearResult {
  const res = cache.clearSnapshot(collection);
  return {
    collection,
    ...res,
  };
}
