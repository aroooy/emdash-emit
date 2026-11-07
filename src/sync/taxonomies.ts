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
import yaml from 'js-yaml';
import { sanitizeTitleForFilename } from '../utils/frontmatter.js';

export interface TaxonomyTerm {
  id: string;
  name?: string;
  slug: string;
  label?: string;
  parentId?: string | null;
  count?: number;
  locale?: string;
}

import { ApiError } from '../client/error.js';
import { createAuthedFetch } from '../client/http.js';
import { unwrapEnvelope } from '../client/api.js';

export interface PullTaxonomiesOptions {
  workspaceRoot: string;
  origin: string;
  token: string;
  refreshToken?: string;
  fetchFn?: typeof fetch;
}

export interface PullTaxonomiesResult {
  categoriesCount: number;
  tagsCount: number;
  deletedCategoriesCount: number;
  deletedTagsCount: number;
  categoriesFailed?: boolean;
  tagsFailed?: boolean;
}

/**
 * Pulls categories and tags from EmDash API and saves them to local YAML files:
 * categories/<id>-<sanitizedLabel>.yaml
 * tags/<id>-<sanitizedLabel>.yaml
 */
export async function pullTaxonomies(
  options: PullTaxonomiesOptions,
): Promise<PullTaxonomiesResult> {
  const fetchFn = createAuthedFetch(options);

  const fetchTerms = async (taxName: 'category' | 'tag'): Promise<TaxonomyTerm[]> => {
    const url = new URL(`/_emdash/api/taxonomies/${taxName}/terms`, options.origin).toString();
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new ApiError({
        message: `Failed to fetch ${taxName} terms: ${res.statusText}`,
        code: 'TAXONOMY_FETCH_FAILED',
        status: res.status,
        endpoint: url,
        suggestion: 'Verify network connection and that the taxonomies API is enabled.',
      });
    }

    const json = await res.json();
    const data = unwrapEnvelope<Record<string, unknown>>(json);
    const rawTerms = (
      Array.isArray(data.terms) ? data.terms : Array.isArray(data) ? data : []
    ) as TaxonomyTerm[];
    return rawTerms;
  };

  const [categories, tags] = await Promise.all([
    fetchTerms('category').catch(() => null),
    fetchTerms('tag').catch(() => null),
  ]);

  const categoriesFailed = categories === null;
  const tagsFailed = tags === null;

  const categoriesDir = path.join(options.workspaceRoot, 'categories');
  const tagsDir = path.join(options.workspaceRoot, 'tags');

  let categoriesCount = 0;
  let deletedCategoriesCount = 0;

  // Save categories and prune deleted ones (only if fetch succeeded; preserve on failure)
  if (categories !== null) {
    fs.mkdirSync(categoriesDir, { recursive: true });
    categoriesCount = categories.length;
    const activeCategoryFileNames = new Set<string>();
    for (const cat of categories) {
      const label = cat.label || cat.slug;
      const sanitized = sanitizeTitleForFilename(label);
      const fileName = `${cat.id}-${sanitized}.yaml`;
      activeCategoryFileNames.add(fileName);
      const filePath = path.join(categoriesDir, fileName);

      const doc = {
        id: cat.id,
        name: label,
        slug: cat.slug,
        taxonomy: 'category',
        parentId: cat.parentId || null,
        count: cat.count ?? 0,
      };
      fs.writeFileSync(
        filePath,
        yaml.dump(doc, { indent: 2, quotingType: '"', forceQuotes: false }),
        'utf8',
      );
    }

    // Prune local category YAMLs not present on remote
    if (fs.existsSync(categoriesDir)) {
      for (const file of fs.readdirSync(categoriesDir)) {
        if (file.endsWith('.yaml') && !activeCategoryFileNames.has(file)) {
          try {
            fs.unlinkSync(path.join(categoriesDir, file));
            deletedCategoriesCount++;
          } catch {
            // Ignore unlink errors
          }
        }
      }
    }
  }

  let tagsCount = 0;
  let deletedTagsCount = 0;

  // Save tags and prune deleted ones (only if fetch succeeded; preserve on failure)
  if (tags !== null) {
    fs.mkdirSync(tagsDir, { recursive: true });
    tagsCount = tags.length;
    const activeTagFileNames = new Set<string>();
    for (const tag of tags) {
      const label = tag.label || tag.slug;
      const sanitized = sanitizeTitleForFilename(label);
      const fileName = `${tag.id}-${sanitized}.yaml`;
      activeTagFileNames.add(fileName);
      const filePath = path.join(tagsDir, fileName);

      const doc = {
        id: tag.id,
        name: label,
        slug: tag.slug,
        taxonomy: 'tag',
        parentId: tag.parentId || null,
        count: tag.count ?? 0,
      };
      fs.writeFileSync(
        filePath,
        yaml.dump(doc, { indent: 2, quotingType: '"', forceQuotes: false }),
        'utf8',
      );
    }

    // Prune local tag YAMLs not present on remote
    if (fs.existsSync(tagsDir)) {
      for (const file of fs.readdirSync(tagsDir)) {
        if (file.endsWith('.yaml') && !activeTagFileNames.has(file)) {
          try {
            fs.unlinkSync(path.join(tagsDir, file));
            deletedTagsCount++;
          } catch {
            // Ignore unlink errors
          }
        }
      }
    }
  }

  return {
    categoriesCount,
    tagsCount,
    deletedCategoriesCount,
    deletedTagsCount,
    categoriesFailed,
    tagsFailed,
  };
}

export interface LocalTaxonomyItem {
  id: string;
  slug: string;
  name: string;
  count?: number;
}

export interface LocalTaxonomiesSummary {
  categories: LocalTaxonomyItem[];
  tags: LocalTaxonomyItem[];
}

export interface FormatTaxonomiesHintOptions {
  maxTags?: number;
  maxCategories?: number;
}

export const DEFAULT_MAX_TAGS = 60;
export const DEFAULT_MAX_CATEGORIES = 50;

/**
 * Reads all taxonomy YAML files from a directory and returns typed items.
 * Single source of truth for reading local category and tag YAML files.
 */
export function readTaxonomyDir(dir: string): LocalTaxonomyItem[] {
  if (!fs.existsSync(dir)) return [];
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    const items: LocalTaxonomyItem[] = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        const data = yaml.load(content) as Record<string, unknown>;
        if (data && typeof data.id === 'string' && typeof data.slug === 'string') {
          items.push({
            id: data.id,
            slug: data.slug,
            name: typeof data.name === 'string' ? data.name : data.slug,
            count: typeof data.count === 'number' ? data.count : undefined,
          });
        }
      } catch {
        // Ignore malformed files
      }
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * Loads local taxonomy mapping between term ULID and slug from categories/ and tags/ directories.
 */
export function loadLocalTaxonomyMaps(workspaceRoot: string): {
  slugToId: { category: Record<string, string>; tag: Record<string, string> };
  idToSlug: { category: Record<string, string>; tag: Record<string, string> };
} {
  const catItems = readTaxonomyDir(path.join(workspaceRoot, 'categories'));
  const tagItems = readTaxonomyDir(path.join(workspaceRoot, 'tags'));

  // Sort items deterministically: highest count first, ties broken by newest ULID (descending).
  // Ensures the chosen mapping for duplicate slugs matches getLocalTaxonomiesSummary.
  const sortDeterministically = (items: LocalTaxonomyItem[]) =>
    [...items].sort((a, b) => {
      const countDiff = (b.count ?? 0) - (a.count ?? 0);
      if (countDiff !== 0) return countDiff;
      return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
    });

  const toMaps = (items: LocalTaxonomyItem[]) => {
    const slugToId: Record<string, string> = {};
    const idToSlug: Record<string, string> = {};
    for (const item of sortDeterministically(items)) {
      idToSlug[item.id] = item.slug;
      if (!slugToId[item.slug]) {
        slugToId[item.slug] = item.id;
      }
    }
    return { slugToId, idToSlug };
  };

  const catMap = toMaps(catItems);
  const tagMap = toMaps(tagItems);

  return {
    slugToId: {
      category: catMap.slugToId,
      tag: tagMap.slugToId,
    },
    idToSlug: {
      category: catMap.idToSlug,
      tag: tagMap.idToSlug,
    },
  };
}

/**
 * Loads local taxonomy candidate names (slugs) from categories/ and tags/ directories.
 */
export function loadLocalTaxonomyCandidates(workspaceRoot: string): {
  categories: string[];
  tags: string[];
} {
  return {
    categories: Array.from(
      new Set(readTaxonomyDir(path.join(workspaceRoot, 'categories')).map((c) => c.slug)),
    ),
    tags: Array.from(new Set(readTaxonomyDir(path.join(workspaceRoot, 'tags')).map((t) => t.slug))),
  };
}

/**
 * Reads local categories/ and tags/ YAML definitions and returns structured summary.
 * Tags are sorted by count descending (most used first), then by ULID descending (newest first).
 * Categories are sorted alphabetically by slug using deterministic ordinal comparison,
 * with ties broken by count descending and ULID descending.
 */
export function getLocalTaxonomiesSummary(workspaceRoot: string): LocalTaxonomiesSummary {
  const categoriesDir = path.join(workspaceRoot, 'categories');
  const tagsDir = path.join(workspaceRoot, 'tags');

  const dedupeBySlug = (items: LocalTaxonomyItem[]): LocalTaxonomyItem[] => {
    const seen = new Set<string>();
    const result: LocalTaxonomyItem[] = [];
    for (const item of items) {
      if (!seen.has(item.slug)) {
        seen.add(item.slug);
        result.push(item);
      }
    }
    return result;
  };

  const categories = dedupeBySlug(
    readTaxonomyDir(categoriesDir).sort((a, b) => {
      if (a.slug < b.slug) return -1;
      if (a.slug > b.slug) return 1;
      const countDiff = (b.count ?? 0) - (a.count ?? 0);
      if (countDiff !== 0) return countDiff;
      return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
    }),
  );
  // Sort tags: highest count (usage frequency) first; ties broken by newest ULID (descending)
  const tags = dedupeBySlug(
    readTaxonomyDir(tagsDir).sort((a, b) => {
      const countDiff = (b.count ?? 0) - (a.count ?? 0);
      if (countDiff !== 0) return countDiff;
      return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
    }),
  );

  return { categories, tags };
}

/**
 * Formats local categories and tags into a concise hint text for AI prompts and CLI outputs.
 * Omits redundant name in parenthesis if slug and name are identical (case-insensitive).
 */
export function formatTaxonomiesHint(
  summary: LocalTaxonomiesSummary,
  options?: FormatTaxonomiesHintOptions,
): string {
  const maxCategories = options?.maxCategories ?? DEFAULT_MAX_CATEGORIES;
  const maxTags = options?.maxTags ?? DEFAULT_MAX_TAGS;

  const formatItem = (item: LocalTaxonomyItem): string => {
    return item.slug.toLowerCase() === item.name.toLowerCase()
      ? item.slug
      : `${item.slug} (${item.name})`;
  };

  const sections: string[] = [];

  if (summary.categories.length > 0 && maxCategories > 0) {
    const visibleCats = summary.categories.slice(0, maxCategories);
    const catLines = visibleCats.map((c) => `  - ${formatItem(c)}`);
    const moreCats =
      summary.categories.length > maxCategories
        ? `\n  ...and ${summary.categories.length - maxCategories} more in categories/`
        : '';
    sections.push(`Available Categories:\n${catLines.join('\n')}${moreCats}`);
  }

  if (summary.tags.length > 0 && maxTags > 0) {
    const visibleTags = summary.tags.slice(0, maxTags);
    const tagStrings = visibleTags.map((t) => formatItem(t));
    const moreTags =
      summary.tags.length > maxTags ? ` (and ${summary.tags.length - maxTags} more in tags/)` : '';
    sections.push(`Available Tags:\n  - ${tagStrings.join(', ')}${moreTags}`);
  }

  return sections.join('\n\n');
}
