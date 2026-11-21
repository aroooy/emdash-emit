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
import matter from 'gray-matter';
import { readTaxonomyDir } from '../taxonomies.js';
import { parseMarkdown } from '../../utils/frontmatter.js';
import { parseSearchDateBoundary, DAY_MS } from '../../utils/search-date.js';
import {
  taxonomyTermFilterAliases,
  taxonomyTermMatchesFilter,
  type TaxonomyTermAliases,
} from '../../utils/taxonomy-term-match.js';
import { ApiError } from '../../client/error.js';
import {
  inArticleDateRange,
  matchesArticleKeyword,
  parseArticleDates,
  resolveArticleDateField,
} from './query.js';
import {
  ARTICLE_SEARCH_DEFAULT_LIMIT,
  ARTICLE_SEARCH_MAX_LIMIT,
  type ArticleSearchHit,
  type ArticleSearchOptions,
  type ArticleSearchResult,
} from './types.js';

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Reads local taxonomy definitions (`categories/` or `tags/` YAML) so a filter typed in one spelling can
 * resolve the others. A missing directory simply yields no definitions — matching then falls back to the
 * filter's own raw and decoded spellings, which still covers ASCII terms and already-decoded frontmatter.
 *
 * `readTaxonomyDir()` is the single source of truth for these files across the repository (it also decodes
 * legacy percent-encoded slugs into `slug` while preserving the raw value in `canonicalSlug`), so both the
 * local and remote search paths share one reader rather than re-implementing YAML parsing.
 */
export function readTaxonomyAliases(
  workspaceRoot: string,
  dirName: 'categories' | 'tags',
): TaxonomyTermAliases[] {
  return readTaxonomyDir(path.join(workspaceRoot, dirName)).map((item) => ({
    slug: item.slug,
    canonicalSlug: item.canonicalSlug,
    name: item.name,
  }));
}

/**
 * Searches local markdown articles in the workspace without any network communication.
 * Scans `posts/draft/` and `posts/published/`.
 * `posts/conflicts/` is excluded by default; when `includeConflicts` is true, hits are flagged quarantined.
 */
export function searchLocalArticles(options: ArticleSearchOptions): ArticleSearchResult {
  const collection = options.collection || 'posts';
  const root = options.workspaceRoot;

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
  const normalizedSlug = options.slug?.trim().toLowerCase();
  const normalizedTag = options.tag?.trim().toLowerCase();
  const normalizedCategory = options.category?.trim().toLowerCase();

  // A taxonomy filter typed in decoded spelling (`カメラレビュー`) must still match a frontmatter that
  // carries the canonical percent-encoded slug, and vice versa. Local definitions bridge the two spellings
  // when they exist; without them both raw and decoded forms of the filter are still tried.
  const categoryDefinitions = normalizedCategory
    ? readTaxonomyAliases(options.workspaceRoot, 'categories')
    : [];
  const tagDefinitions = normalizedTag ? readTaxonomyAliases(options.workspaceRoot, 'tags') : [];
  const categoryFilterAliases = normalizedCategory
    ? taxonomyTermFilterAliases(normalizedCategory, categoryDefinitions).map((alias) =>
        alias.toLowerCase(),
      )
    : [];
  const tagFilterAliases = normalizedTag
    ? taxonomyTermFilterAliases(normalizedTag, tagDefinitions).map((alias) => alias.toLowerCase())
    : [];

  const rawLimit = options.limit ?? ARTICLE_SEARCH_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(rawLimit, ARTICLE_SEARCH_MAX_LIMIT));

  const statusDirs: Array<{ dirName: string; defaultStatus: string; isConflict: boolean }> = [
    { dirName: 'published', defaultStatus: 'published', isConflict: false },
    { dirName: 'draft', defaultStatus: 'draft', isConflict: false },
  ];

  if (options.includeConflicts) {
    statusDirs.push({ dirName: 'conflicts', defaultStatus: 'draft', isConflict: true });
  }

  const hits: ArticleSearchHit[] = [];
  let scannedCount = 0;

  for (const { dirName, defaultStatus, isConflict } of statusDirs) {
    const dirPath = path.join(root, collection, dirName);
    if (!fs.existsSync(dirPath)) continue;

    let entries: string[];
    try {
      entries = fs.readdirSync(dirPath);
    } catch {
      continue;
    }

    for (const file of entries) {
      if (!file.endsWith('.md')) continue;
      if (file.endsWith('.deleted.md')) continue;

      scannedCount++;
      const fullPath = path.join(dirPath, file);
      const relPath = path.posix.join(collection, dirName, file);

      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf8');
      } catch {
        continue;
      }

      let fm: Record<string, unknown> = {};
      let bodyText = '';
      try {
        const parsed = parseMarkdown(content);
        fm = (parsed.frontmatter || {}) as Record<string, unknown>;
        bodyText = parsed.body;
      } catch {
        try {
          const raw = matter(content);
          fm = (raw.data || {}) as Record<string, unknown>;
          bodyText = raw.content;
        } catch {
          continue;
        }
      }

      const articleId = String(fm.id || '').trim();
      const articleSlug = String(fm.slug || '').trim();
      const articleTitle = String(fm.title || file.replace(/\.md$/, '')).trim();
      const articleStatus = String(fm.status || defaultStatus)
        .trim()
        .toLowerCase();

      // Status filter
      if (options.status && articleStatus !== options.status.toLowerCase()) {
        continue;
      }

      // Slug filter
      if (normalizedSlug) {
        if (!articleSlug.toLowerCase().includes(normalizedSlug)) {
          continue;
        }
      }

      // Date range filter
      const dates = parseArticleDates({
        ...fm,
        createdAt: fm.createdAt,
        publishedAt: fm.publishedAt,
      });
      const dateToCompare = resolveArticleDateField(dates, articleStatus, options.dateField);
      if (!inArticleDateRange(dateToCompare, sinceBoundary, untilBoundary)) {
        continue;
      }

      // Taxonomy filters — terms live under the frontmatter's `taxonomies:` map, never at the top level.
      const frontmatterTaxonomies = (
        fm.taxonomies && typeof fm.taxonomies === 'object' ? fm.taxonomies : {}
      ) as Record<string, unknown>;
      const categories = toArray(frontmatterTaxonomies.categories).map((c) =>
        String(c).toLowerCase(),
      );
      if (
        normalizedCategory &&
        !categories.some((c) => taxonomyTermMatchesFilter(c, categoryFilterAliases))
      ) {
        continue;
      }

      const tags = toArray(frontmatterTaxonomies.tags).map((t) => String(t).toLowerCase());
      if (normalizedTag && !tags.some((t) => taxonomyTermMatchesFilter(t, tagFilterAliases))) {
        continue;
      }

      // Keyword match
      const matchedOn: Array<
        'title' | 'slug' | 'excerpt' | 'body' | 'tag' | 'category' | 'recency'
      > = [];

      if (normalizedQuery) {
        const textMatches = matchesArticleKeyword(
          {
            title: articleTitle,
            slug: articleSlug,
            excerpt: typeof fm.excerpt === 'string' ? fm.excerpt : undefined,
            body: bodyText,
          },
          normalizedQuery,
        );
        matchedOn.push(...textMatches);

        const queryTermAliases = taxonomyTermFilterAliases(normalizedQuery);
        if (categories.some((c) => taxonomyTermMatchesFilter(c, queryTermAliases))) {
          matchedOn.push('category');
        }
        if (tags.some((t) => taxonomyTermMatchesFilter(t, queryTermAliases))) {
          matchedOn.push('tag');
        }

        if (matchedOn.length === 0) {
          continue;
        }
      } else {
        matchedOn.push('recency');
      }

      hits.push({
        id: articleId,
        slug: articleSlug || null,
        title: articleTitle,
        status: articleStatus,
        createdAt: dates.createdAt,
        publishedAt: dates.publishedAt,
        updatedAt: dates.updatedAt,
        isLocal: true,
        localPath: relPath,
        quarantined: isConflict,
        matchedOn,
      });
    }
  }

  // Sort newest first by dateToCompare
  hits.sort((a, b) => {
    const da = a.publishedAt || a.createdAt || '';
    const db = b.publishedAt || b.createdAt || '';
    return db.localeCompare(da);
  });

  const truncated = hits.length > limit;
  const slicedHits = hits.slice(0, limit);

  return {
    hits: slicedHits,
    searchMode: 'scan',
    scannedCount,
    totalCount: hits.length,
    walkComplete: true,
    truncated,
    normalizedQuery,
    taxonomyFetchCount: 0,
  };
}
