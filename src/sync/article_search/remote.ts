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
import { ApiError } from '../../client/error.js';
import { createAuthedFetch } from '../../client/http.js';
import { articleContentEndpoint, searchEndpoint } from '../../client/endpoints.js';
import { unwrapEnvelope, isSameRev, extractComparisonRev, extractRev } from '../../client/api.js';
import { readBaselineFrontmatter } from '../../db/baseline.js';
import { parseSearchDateBoundary, DAY_MS } from '../../utils/search-date.js';
import {
  taxonomyTermFilterAliases,
  taxonomyTermMatchesFilter,
} from '../../utils/taxonomy-term-match.js';
import { findLocalFilesByUlid } from '../workspace/index.js';
import { fetchAssignedTerms } from '../terms.js';
import { loadLocalTaxonomyMaps, canonicalizeTaxonomiesForBaseline } from '../taxonomies.js';
import { isLocalFileUnmodified } from '../baseline-reconstruction.js';
import {
  inArticleDateRange,
  matchesArticleKeyword,
  parseArticleDates,
  resolveArticleDateField,
} from './query.js';
import { searchLocalArticles, readTaxonomyAliases } from './local.js';
import {
  ARTICLE_SEARCH_DEFAULT_LIMIT,
  ARTICLE_SEARCH_DEFAULT_MAX_SCAN,
  ARTICLE_SEARCH_MAX_LIMIT,
  ARTICLE_SEARCH_TAXONOMY_MAX_SCAN,
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
}

interface RawSearchResponse {
  items?: RawSearchItem[];
  nextCursor?: string;
}

/**
 * Searches remote articles in EmDash.
 * Follows the single decision rule:
 *   1. offline: true -> local markdown scan
 *   2. tag / category given -> scan path
 *   3. since / until given -> scan path
 *   4. query given -> FTS path (with fallback to scan on HTTP error or short queries)
 *   5. no query -> scan path (recency browse)
 */
export async function searchRemoteArticles(
  options: ArticleSearchOptions,
): Promise<ArticleSearchResult> {
  if (options.offline) {
    return searchLocalArticles(options);
  }

  const collection = options.collection || 'posts';
  const fetchFn = createAuthedFetch(options);

  let sinceBoundary: number | null = null;
  let untilBoundary: number | null = null;

  if (options.since !== undefined && options.since.trim()) {
    const parsed = parseSearchDateBoundary(options.since);
    if (!parsed?.since) {
      throw new ApiError({
        message: `Invalid date boundary: "${options.since}". Use "today", "yesterday", or YYYY-MM-DD.`,
        code: 'DATE_BOUNDARY_INVALID',
        status: 400,
        suggestion: 'Pass a calendar date such as 2026-11-01, or the keyword today / yesterday.',
      });
    }
    sinceBoundary = parsed.since;
  }

  if (options.until !== undefined && options.until.trim()) {
    const parsed = parseSearchDateBoundary(options.until);
    if (!parsed?.since) {
      throw new ApiError({
        message: `Invalid date boundary: "${options.until}". Use "today", "yesterday", or YYYY-MM-DD.`,
        code: 'DATE_BOUNDARY_INVALID',
        status: 400,
        suggestion: 'Pass a calendar date such as 2026-11-01, or the keyword today / yesterday.',
      });
    }
    untilBoundary = parsed.since + DAY_MS;
  }

  const trimmedQuery = options.query?.trim();
  const normalizedQuery = trimmedQuery ? trimmedQuery.toLowerCase() : '';
  const hasTaxonomyFilter = Boolean(options.tag?.trim() || options.category?.trim());
  const hasDateFilter = Boolean(sinceBoundary !== null || untilBoundary !== null);

  const rawLimit = options.limit ?? ARTICLE_SEARCH_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(rawLimit, ARTICLE_SEARCH_MAX_LIMIT));

  // Determine path:
  const mustUseScan = hasTaxonomyFilter || hasDateFilter || !normalizedQuery;

  if (!mustUseScan && normalizedQuery) {
    // Attempt FTS path first
    try {
      const searchUrl = new URL(searchEndpoint(options.origin));
      searchUrl.searchParams.set('q', trimmedQuery!);
      searchUrl.searchParams.set('collections', collection);
      searchUrl.searchParams.set('limit', String(limit));
      if (options.status) {
        searchUrl.searchParams.set('status', options.status);
      }

      const res = await fetchFn(searchUrl.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: 'application/json',
        },
      });

      if (res.ok) {
        const json = (await res.json()) as Record<string, unknown>;
        const data = unwrapEnvelope<RawSearchResponse>(json);
        const rawItems = Array.isArray(data.items) ? data.items : [];

        // Check M6: if query length is < 3 and FTS returned 0 hits,
        // trigram tokenization may have missed Japanese words. Fall back to scan path!
        if (rawItems.length === 0 && trimmedQuery!.length < 3) {
          return executeScanSearch({
            options,
            collection,
            fetchFn,
            limit,
            sinceBoundary,
            untilBoundary,
            normalizedQuery,
            fallbackReason:
              'Short query length (< 3 characters) fell back to scan for trigram completeness',
          });
        }

        const hits: ArticleSearchHit[] = [];
        for (const item of rawItems) {
          if (!item.id) continue;
          const localFiles = findLocalFilesByUlid(options.workspaceRoot, collection, item.id);
          const syncState = options.cache?.getSyncState(item.id);
          const isLocal = localFiles.length > 0 || Boolean(syncState);
          const localPath = localFiles[0] || syncState?.localFilePath || null;

          // Slug filter if specified
          if (
            options.slug &&
            item.slug &&
            !item.slug.toLowerCase().includes(options.slug.toLowerCase())
          ) {
            continue;
          }

          hits.push({
            id: item.id,
            slug: item.slug || null,
            title: item.title || 'Untitled',
            snippet: item.snippet,
            score: item.score,
            isLocal,
            localPath,
            matchedOn: ['title'],
          });
        }

        const nextCursor = data.nextCursor;
        const truncated = Boolean(nextCursor && hits.length >= limit);
        const walkComplete = !nextCursor;

        return {
          hits: hits.slice(0, limit),
          searchMode: 'fts',
          scannedCount: hits.length,
          totalCount: null,
          walkComplete,
          truncated,
          normalizedQuery,
          taxonomyFetchCount: 0,
          taxonomyCacheHitCount: 0,
        };
      }

      // If FTS returns HTTP error (404/5xx), fall back to scan path
      return executeScanSearch({
        options,
        collection,
        fetchFn,
        limit,
        sinceBoundary,
        untilBoundary,
        normalizedQuery,
        fallbackReason: `HTTP ${res.status} from /search endpoint`,
      });
    } catch (err: unknown) {
      // Network or parse error from search endpoint -> fall back to scan
      const reason = err instanceof Error ? err.message : String(err);
      return executeScanSearch({
        options,
        collection,
        fetchFn,
        limit,
        sinceBoundary,
        untilBoundary,
        normalizedQuery,
        fallbackReason: `Network error from /search: ${reason}`,
      });
    }
  }

  // Scan path
  return executeScanSearch({
    options,
    collection,
    fetchFn,
    limit,
    sinceBoundary,
    untilBoundary,
    normalizedQuery,
  });
}

interface ExecuteScanParams {
  options: ArticleSearchOptions;
  collection: string;
  fetchFn: typeof fetch;
  limit: number;
  sinceBoundary: number | null;
  untilBoundary: number | null;
  normalizedQuery: string;
  fallbackReason?: string;
}

async function executeScanSearch(params: ExecuteScanParams): Promise<ArticleSearchResult> {
  const {
    options,
    collection,
    fetchFn,
    limit,
    sinceBoundary,
    untilBoundary,
    normalizedQuery,
    fallbackReason,
  } = params;

  const hasTaxonomyFilter = Boolean(options.tag?.trim() || options.category?.trim());
  const defaultMaxScan = hasTaxonomyFilter
    ? ARTICLE_SEARCH_TAXONOMY_MAX_SCAN
    : ARTICLE_SEARCH_DEFAULT_MAX_SCAN;

  const maxScan =
    options.maxScan === 0
      ? Infinity
      : typeof options.maxScan === 'number' && options.maxScan > 0
        ? options.maxScan
        : defaultMaxScan;

  const normalizedSlug = options.slug?.trim().toLowerCase();
  const normalizedTag = options.tag?.trim().toLowerCase();
  const normalizedCategory = options.category?.trim().toLowerCase();

  // Remote assigned terms come back as canonical (often percent-encoded) slugs while a filter is usually
  // typed decoded, so both sides must be expanded through the local definitions before comparison.
  const categoryFilterAliases = normalizedCategory
    ? taxonomyTermFilterAliases(
        normalizedCategory,
        readTaxonomyAliases(options.workspaceRoot, 'categories'),
      ).map((alias) => alias.toLowerCase())
    : [];
  const tagFilterAliases = normalizedTag
    ? taxonomyTermFilterAliases(
        normalizedTag,
        readTaxonomyAliases(options.workspaceRoot, 'tags'),
      ).map((alias) => alias.toLowerCase())
    : [];

  const statusesToFetch: Array<'published' | 'draft'> = options.status
    ? [options.status]
    : ['published', 'draft'];

  const hits: ArticleSearchHit[] = [];
  let scannedCount = 0;
  let taxonomyFetchCount = 0;
  let taxonomyCacheHitCount = 0;
  let allSeriesComplete = true;
  let hitLimitReached = false;

  const localTaxonomyMaps = hasTaxonomyFilter ? loadLocalTaxonomyMaps(options.workspaceRoot) : null;

  const isCreatedAtSort = options.dateField === 'createdAt' || !options.dateField;

  for (const status of statusesToFetch) {
    if (scannedCount >= maxScan || hitLimitReached) {
      allSeriesComplete = false;
      break;
    }

    let cursor: string | undefined = undefined;
    let seriesReachedSince = false;

    for (;;) {
      const remainingScan = maxScan - scannedCount;
      if (remainingScan <= 0 || hitLimitReached) {
        allSeriesComplete = false;
        break;
      }

      const batchLimit = Math.min(remainingScan, 100);
      const url = new URL(articleContentEndpoint(options.origin, collection));
      url.searchParams.set('status', status);
      url.searchParams.set('limit', String(batchLimit));
      if (cursor) {
        url.searchParams.set('cursor', cursor);
      }

      let res = await fetchFn(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        allSeriesComplete = false;
        break;
      }

      const json = (await res.json()) as Record<string, unknown>;
      const envelope = unwrapEnvelope<{
        items?: Array<Record<string, unknown>>;
        nextCursor?: string;
      }>(json);
      const rawItems = Array.isArray(envelope.items) ? envelope.items : [];

      if (rawItems.length === 0) {
        break;
      }

      for (const item of rawItems) {
        scannedCount++;
        const itemId = String(item.id || '').trim();
        const itemSlug = String(item.slug || '').trim();
        const data = (item.data && typeof item.data === 'object' ? item.data : {}) as Record<
          string,
          unknown
        >;
        const itemTitle = String(data.title || item.title || itemSlug || 'Untitled').trim();
        const itemStatus = String(item.status || status)
          .trim()
          .toLowerCase();

        // Dates
        const dates = parseArticleDates(item);
        const dateToCompare = resolveArticleDateField(dates, itemStatus, options.dateField);

        // Early-exit check: evaluated independently per series (T2-6) only when sorting by createdAt
        if (isCreatedAtSort && sinceBoundary !== null && dates.createdAt) {
          const createdInstant = Date.parse(dates.createdAt);
          if (Number.isFinite(createdInstant) && createdInstant < sinceBoundary) {
            seriesReachedSince = true;
            break;
          }
        }

        // Date range check
        if (!inArticleDateRange(dateToCompare, sinceBoundary, untilBoundary)) {
          continue;
        }

        // Slug check
        if (normalizedSlug && !itemSlug.toLowerCase().includes(normalizedSlug)) {
          continue;
        }

        // Keyword check
        const matchedOn: Array<
          'title' | 'slug' | 'excerpt' | 'body' | 'tag' | 'category' | 'recency'
        > = [];

        if (normalizedQuery) {
          const textMatches = matchesArticleKeyword(
            {
              title: itemTitle,
              slug: itemSlug,
              excerpt: typeof data.excerpt === 'string' ? data.excerpt : undefined,
            },
            normalizedQuery,
          );
          matchedOn.push(...textMatches);

          if (matchedOn.length === 0 && !hasTaxonomyFilter) {
            continue;
          }
        } else {
          matchedOn.push('recency');
        }

        // Taxonomy check
        if (hasTaxonomyFilter) {
          // Bounded by limit: only fetch terms if hits haven't reached limit
          if (hits.length < limit) {
            let usedFastPath = false;
            let matchesCategory = !normalizedCategory;
            let matchesTag = !normalizedTag;

            // Fast-path: if article has up-to-date baseline snapshot with matching rev, no pending changes,
            // and the local disk file is clean (not modified), avoiding masking unpushed local edits
            if (options.cache) {
              const syncState = options.cache.getSyncState(itemId);
              if (
                syncState &&
                syncState.deletePending !== 1 &&
                syncState.bodyConflictPending !== 1 &&
                syncState.taxonomyApplyPending !== 1 &&
                syncState.taxonomyConflictPending !== 1
              ) {
                const rawRevCandidate = String(item._rev || item.rev || item.version || '');
                const remoteRev = extractRev(item, rawRevCandidate || '1');
                const comparisonRev = extractComparisonRev(item, remoteRev);
                if (comparisonRev && isSameRev(syncState.remoteRev, comparisonRev)) {
                  const fullPath = syncState.localFilePath
                    ? path.join(options.workspaceRoot, syncState.localFilePath)
                    : null;
                  let isDiskUnmodified = false;
                  if (fullPath && fs.existsSync(fullPath)) {
                    try {
                      const diskContent = fs.readFileSync(fullPath, 'utf8');
                      isDiskUnmodified = isLocalFileUnmodified({
                        workspaceRoot: options.workspaceRoot,
                        cache: options.cache,
                        id: itemId,
                        relPath: syncState.localFilePath,
                        localContent: diskContent,
                        syncState,
                        // Article search is a read-only inspection command: it must never heal
                        // `sync_state.local_hash` as a side effect. The healing edge belongs to
                        // status / diff / doctor / delete only. It therefore verifies disk parity
                        // with healOnSpellingMatch: false, allowing fast-path evaluation without mutating the cache.
                        healOnSpellingMatch: false,
                      });
                    } catch {
                      isDiskUnmodified = false;
                    }
                  }

                  if (isDiskUnmodified) {
                    const baseSnapshot = options.cache.getBaseSnapshot(itemId);
                    if (baseSnapshot) {
                      const fm = readBaselineFrontmatter(baseSnapshot);
                      const hasRecordedTaxonomies =
                        fm &&
                        fm.taxonomies &&
                        typeof fm.taxonomies === 'object' &&
                        (Array.isArray(fm.taxonomies.categories) ||
                          Array.isArray(fm.taxonomies.tags));
                      if (hasRecordedTaxonomies) {
                        usedFastPath = true;
                        taxonomyCacheHitCount++;

                        const rawCategories = Array.isArray(fm.taxonomies.categories)
                          ? fm.taxonomies.categories.map(String)
                          : [];
                        const rawTags = Array.isArray(fm.taxonomies.tags)
                          ? fm.taxonomies.tags.map(String)
                          : [];

                        const canonical = localTaxonomyMaps
                          ? canonicalizeTaxonomiesForBaseline(
                              { categories: rawCategories, tags: rawTags },
                              localTaxonomyMaps,
                            )
                          : { categories: rawCategories, tags: rawTags };

                        if (normalizedCategory) {
                          const cats = canonical.categories || [];
                          if (
                            cats.some((c) =>
                              taxonomyTermMatchesFilter(c.toLowerCase(), categoryFilterAliases),
                            )
                          ) {
                            matchesCategory = true;
                            matchedOn.push('category');
                          }
                        }

                        if (normalizedTag) {
                          const tgs = canonical.tags || [];
                          if (
                            tgs.some((t) =>
                              taxonomyTermMatchesFilter(t.toLowerCase(), tagFilterAliases),
                            )
                          ) {
                            matchesTag = true;
                            matchedOn.push('tag');
                          }
                        }
                      }
                    }
                  }
                }
              }
            }

            if (!usedFastPath) {
              if (normalizedCategory && options.token) {
                taxonomyFetchCount++;
                const catTerms = await fetchAssignedTerms({
                  origin: options.origin,
                  token: options.token,
                  collection,
                  id: itemId,
                  taxonomy: 'category',
                  fetchFn,
                });
                if (
                  catTerms &&
                  catTerms.some((c) =>
                    taxonomyTermMatchesFilter(c.toLowerCase(), categoryFilterAliases),
                  )
                ) {
                  matchesCategory = true;
                  matchedOn.push('category');
                }
              }

              if (normalizedTag && options.token) {
                taxonomyFetchCount++;
                const tagTerms = await fetchAssignedTerms({
                  origin: options.origin,
                  token: options.token,
                  collection,
                  id: itemId,
                  taxonomy: 'tag',
                  fetchFn,
                });
                if (
                  tagTerms &&
                  tagTerms.some((t) => taxonomyTermMatchesFilter(t.toLowerCase(), tagFilterAliases))
                ) {
                  matchesTag = true;
                  matchedOn.push('tag');
                }
              }
            }

            if (!matchesCategory || !matchesTag) {
              continue;
            }
          } else {
            // Already hit limit
            hitLimitReached = true;
            break;
          }
        }

        // Local check
        const localFiles = findLocalFilesByUlid(options.workspaceRoot, collection, itemId);
        const syncState = options.cache?.getSyncState(itemId);
        const isLocal = localFiles.length > 0 || Boolean(syncState);
        const localPath = localFiles[0] || syncState?.localFilePath || null;

        hits.push({
          id: itemId,
          slug: itemSlug || null,
          title: itemTitle,
          status: itemStatus,
          createdAt: dates.createdAt,
          publishedAt: dates.publishedAt,
          updatedAt: dates.updatedAt,
          isLocal,
          localPath,
          matchedOn,
        });

        if (hits.length >= limit) {
          hitLimitReached = true;
          break;
        }
      }

      if (seriesReachedSince || !envelope.nextCursor || hitLimitReached) {
        cursor = undefined;
        break;
      }
      cursor = envelope.nextCursor;
    }
  }

  const truncated = hitLimitReached || hits.length > limit;
  const walkComplete = allSeriesComplete && !hitLimitReached;

  return {
    hits: hits.slice(0, limit),
    searchMode: 'scan',
    scannedCount,
    totalCount: null,
    walkComplete,
    truncated,
    normalizedQuery,
    taxonomyFetchCount,
    taxonomyCacheHitCount,
    fallbackReason,
  };
}
