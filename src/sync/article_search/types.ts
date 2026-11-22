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

import type { CacheDatabase } from '../../db/cache.js';
import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT } from '../../utils/search-options.js';

export const ARTICLE_SEARCH_DEFAULT_LIMIT = SEARCH_DEFAULT_LIMIT;
export const ARTICLE_SEARCH_MAX_LIMIT = SEARCH_MAX_LIMIT;
export const ARTICLE_SEARCH_DEFAULT_MAX_SCAN = 300;
export const ARTICLE_SEARCH_TAXONOMY_MAX_SCAN = 50;

export interface ArticleSearchSnapshotInfo {
  capturedAt: string;
  ageDays: number;
  stale: boolean;
  articleCount: number;
}

export interface ArticleSearchHit {
  id: string;
  slug: string | null;
  title: string;
  status?: string;
  snippet?: string;
  createdAt?: string;
  publishedAt?: string | null;
  updatedAt?: string;
  isLocal: boolean;
  localPath: string | null;
  quarantined?: boolean;
  fromSnapshot?: boolean;
  bodyUnverified?: boolean;
  score?: number;
  matchedOn: Array<'title' | 'slug' | 'excerpt' | 'body' | 'tag' | 'category' | 'recency'>;
}

export interface ArticleSearchResult {
  hits: ArticleSearchHit[];
  searchMode: 'fts' | 'scan';
  scannedCount: number;
  totalCount: number | null;
  walkComplete: boolean;
  truncated: boolean;
  normalizedQuery: string;
  taxonomyFetchCount: number;
  taxonomyCacheHitCount: number;
  fallbackReason?: string;
  snapshot?: ArticleSearchSnapshotInfo;
}

export interface ArticleSearchOptions {
  query?: string;
  tag?: string;
  category?: string;
  status?: 'draft' | 'published';
  slug?: string;
  since?: string;
  until?: string;
  dateField?: 'publishedAt' | 'updatedAt' | 'createdAt';
  offline?: boolean;
  limit?: number;
  maxScan?: number;
  collection?: string;
  origin: string;
  token?: string;
  fetchFn?: typeof fetch;
  workspaceRoot: string;
  cache?: CacheDatabase;
  includeConflicts?: boolean;
}
