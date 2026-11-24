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

import { createAuthedFetch } from '../../client/http.js';
import { ApiError } from '../../client/error.js';
import { searchEndpoint } from '../../client/endpoints.js';
import { unwrapEnvelope, isSameRev, extractComparisonRev, extractRev } from '../../client/api.js';
import type { CacheDatabase } from '../../db/cache.js';
import { resolveSearchDateBoundaries } from '../../utils/search-date.js';
import { clampSearchLimit } from '../../utils/search-options.js';
import { findLocalFilesByUlid } from '../workspace/index.js';
import { searchLocalArticles } from './local.js';
import {
  type ArticleSearchHit,
  type ArticleSearchOptions,
  type ArticleSearchResult,
} from './types.js';

interface RawSearchItem {
  collection?: string;
  id?: string;
  slug?: string | null;
  locale?: string;
  title?: string;
  snippet?: string;
  score?: number;
  _rev?: string;
  version?: string;
}

function buildArticleSnapshotInfo(
  cache: CacheDatabase | undefined,
  collection: string,
): ArticleSearchResult['snapshot'] {
  const meta = cache?.getSnapshotMeta(collection) ?? null;
  if (!meta) return undefined;
  const ageDays = Math.max(0, Math.floor((Date.now() - meta.capturedAt) / 86_400_000));
  return {
    capturedAt: new Date(meta.capturedAt).toISOString(),
    ageDays: Number.isFinite(ageDays) ? ageDays : 0,
    stale: Number.isFinite(ageDays) ? ageDays >= 7 : false,
    articleCount: meta.articleCount,
  };
}

/**
 * Searches articles using Emit's two-mode model:
 *   - Default (`!options.live`): 0-HTTP exhaustive search across local `posts/` and `.emit/cache.db` snapshot.
 *   - Explicit `options.live`: queries EmDash's live FTS endpoint (`/_emdash/api/search`, keyword-only;
 *     rejects unsupported filters with `LIVE_SEARCH_UNSUPPORTED_FILTER`).
 */
export async function searchRemoteArticles(
  options: ArticleSearchOptions,
): Promise<ArticleSearchResult> {
  if (!options.live) {
    return searchLocalArticles(options);
  }

  const collection = options.collection || 'posts';
  const trimmedQuery = options.query?.trim();
  const normalizedQuery = trimmedQuery ? trimmedQuery.toLowerCase() : '';

  const { sinceBoundary, untilBoundary } = resolveSearchDateBoundaries({
    since: options.since,
    until: options.until,
  });

  const unsupportedFilters: string[] = [];
  if (options.tag?.trim()) unsupportedFilters.push('tag');
  if (options.category?.trim()) unsupportedFilters.push('category');
  if (options.status) unsupportedFilters.push('status');
  if (sinceBoundary !== null) unsupportedFilters.push('since');
  if (untilBoundary !== null) unsupportedFilters.push('until');

  if (!normalizedQuery || unsupportedFilters.length > 0) {
    const reason = !normalizedQuery
      ? 'Live FTS search requires a non-empty keyword query.'
      : `Live FTS search does not support filter(s): ${unsupportedFilters.join(', ')}.`;
    throw new ApiError({
      endpoint: '/_emdash/api/search',
      code: 'LIVE_SEARCH_UNSUPPORTED_FILTER',
      status: 400,
      message: reason,
      suggestion:
        'Omit --live / live to run default exhaustive search across the local workspace and snapshot index.',
    });
  }

  const limit = clampSearchLimit(options.limit);
  const fetchFn = createAuthedFetch(options);

  const searchUrl = new URL(searchEndpoint(options.origin));
  searchUrl.searchParams.set('q', trimmedQuery!);
  searchUrl.searchParams.set('collections', collection);
  searchUrl.searchParams.set('limit', String(limit));

  const res = await fetchFn(searchUrl.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new ApiError({
      endpoint: searchUrl.pathname,
      code: 'ARTICLE_SEARCH_FAILED',
      status: res.status,
      message: `Live FTS search failed with HTTP ${res.status}.`,
      suggestion:
        'Verify network connectivity and authentication, or omit --live / live to search the local workspace and snapshot index.',
    });
  }

  const json = (await res.json()) as Record<string, unknown>;
  const data = unwrapEnvelope<{ items?: RawSearchItem[]; nextCursor?: string }>(json);
  const rawItems = Array.isArray(data.items) ? data.items : [];

  const hits: ArticleSearchHit[] = [];
  for (const item of rawItems) {
    if (!item.id) continue;
    const localFiles = findLocalFilesByUlid(options.workspaceRoot, collection, item.id);
    const syncState = options.cache?.getSyncState(item.id);
    const isLocal = localFiles.length > 0 || Boolean(syncState);
    const localPath = localFiles[0] || syncState?.localFilePath || null;

    if (
      options.slug &&
      item.slug &&
      !item.slug.toLowerCase().includes(options.slug.toLowerCase())
    ) {
      continue;
    }

    const snap = options.cache?.getSnapshotArticle(item.id) ?? null;
    let enrichment: Partial<ArticleSearchHit> = {};
    if (snap) {
      let revVerified = false;
      if (item._rev || item.version) {
        const rawItemObj = item as unknown as Record<string, unknown>;
        const rawRev = extractRev(rawItemObj, '');
        const compRev = rawRev ? extractComparisonRev(rawItemObj, rawRev) : '';
        revVerified = Boolean(compRev && isSameRev(snap.comparisonRev, compRev));
      }
      enrichment = {
        status: snap.status,
        createdAt: snap.createdAt ?? undefined,
        publishedAt: snap.publishedAt,
        updatedAt: snap.updatedAt ?? undefined,
        enrichedFromSnapshot: true,
        ...(!revVerified ? { enrichmentStale: true } : {}),
      };
    }

    hits.push({
      id: item.id,
      slug: item.slug || null,
      title: item.title || 'Untitled',
      snippet: item.snippet,
      score: item.score,
      isLocal,
      localPath,
      ...enrichment,
      matchedOn: ['title'],
    });
  }

  const nextCursor = data.nextCursor;
  const finalHits = hits.slice(0, limit);
  const truncated = Boolean(nextCursor && hits.length >= limit);
  const walkComplete = !nextCursor;
  const snapshotInfo = buildArticleSnapshotInfo(options.cache, collection);
  const finalEnrichedCount = finalHits.filter((h) => h.enrichedFromSnapshot).length;

  return {
    hits: finalHits,
    searchMode: 'fts',
    scannedCount: hits.length,
    totalCount: null,
    walkComplete,
    truncated,
    normalizedQuery,
    taxonomyFetchCount: 0,
    taxonomyCacheHitCount: 0,
    ...(snapshotInfo ? { snapshot: snapshotInfo } : {}),
    ...(finalEnrichedCount > 0 ? { snapshotEnrichedCount: finalEnrichedCount } : {}),
  };
}
