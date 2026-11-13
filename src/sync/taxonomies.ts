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
import {
  formatYamlScalar,
  sanitizeTitleForFilename,
  type TaxonomyCandidates,
} from '../utils/frontmatter.js';

export interface TaxonomyTerm {
  id: string;
  name?: string;
  slug: string;
  label?: string;
  parentId?: string | null;
  count?: number;
  locale?: string;
  children?: TaxonomyTerm[];
}

/**
 * Recursively flattens hierarchical taxonomy terms (parent terms with nested children)
 * preserving parentId for each child.
 */
export function flattenTaxonomyTerms(
  rawTerms: TaxonomyTerm[],
  inheritedParentId: string | null = null,
  visited: Set<string> = new Set<string>(),
  depth = 0,
): TaxonomyTerm[] {
  if (depth > 32) return [];
  const result: TaxonomyTerm[] = [];
  for (const term of rawTerms) {
    if (!term || !term.id) continue;
    if (visited.has(term.id)) continue;
    visited.add(term.id);

    const parentId = term.parentId || inheritedParentId || null;
    const { children, ...rest } = term;
    result.push({
      ...rest,
      parentId,
    });
    if (Array.isArray(children) && children.length > 0) {
      result.push(...flattenTaxonomyTerms(children, term.id, visited, depth + 1));
    }
  }
  return result;
}

import { ApiError } from '../client/error.js';
import { createAuthedFetch } from '../client/http.js';
import { unwrapEnvelope } from '../client/api.js';
import { taxonomiesTermsEndpoint } from '../client/endpoints.js';

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
    const url = taxonomiesTermsEndpoint(options.origin, taxName);
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
    return flattenTaxonomyTerms(rawTerms);
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
  parentId?: string | null;
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
            parentId: typeof data.parentId === 'string' ? data.parentId : null,
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
    const sorted = sortDeterministically(items);

    // 1. Register canonical slugs first
    for (const item of sorted) {
      idToSlug[item.id] = item.slug;
      if (!slugToId[item.slug]) {
        slugToId[item.slug] = item.id;
      }
    }

    // 2. Collect candidate aliases (decoded percent-encoded slug and human-readable name)
    // Only register an alias if it does not collide with any canonical slug and maps uniquely to 1 term ID.
    const aliasToIds = new Map<string, Set<string>>();
    const recordAliasCandidate = (alias: string | undefined, id: string) => {
      if (!alias || !alias.trim()) return;
      const trimmed = alias.trim();
      let set = aliasToIds.get(trimmed);
      if (!set) {
        set = new Set<string>();
        aliasToIds.set(trimmed, set);
      }
      set.add(id);
    };

    for (const item of sorted) {
      recordAliasCandidate(item.name, item.id);
      if (item.slug.includes('%')) {
        try {
          const decoded = decodeURIComponent(item.slug);
          recordAliasCandidate(decoded, item.id);
        } catch {
          // Ignore malformed percent-encoding (URIError)
        }
      }
    }

    for (const [alias, ids] of aliasToIds.entries()) {
      if (!slugToId[alias] && ids.size === 1) {
        const [uniqueId] = ids;
        slugToId[alias] = uniqueId;
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
 * Loads local taxonomy candidate names (slugs and slug-to-name mapping) from categories/ and tags/ directories.
 * Single source of truth for taxonomy candidate resolution across pull, push, and diff.
 */
export function loadLocalTaxonomyCandidates(workspaceRoot: string): TaxonomyCandidates {
  try {
    const summary = getLocalTaxonomiesSummary(workspaceRoot);
    const catMap: Record<string, string> = {};
    for (const c of summary.categories) {
      if (c.name && c.slug) catMap[c.slug] = c.name;
    }
    const tagMap: Record<string, string> = {};
    for (const t of summary.tags) {
      if (t.name && t.slug) tagMap[t.slug] = t.name;
    }
    return {
      categories: Array.from(new Set(summary.categories.map((c) => c.slug))),
      tags: Array.from(new Set(summary.tags.map((t) => t.slug))),
      slugToName: {
        category: catMap,
        tag: tagMap,
      },
    };
  } catch {
    return {
      categories: [],
      tags: [],
      slugToName: { category: {}, tag: {} },
    };
  }
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
    const formattedSlug = formatYamlScalar(item.slug);
    return item.slug.toLowerCase() === item.name.toLowerCase()
      ? formattedSlug
      : `${formattedSlug} (${item.name})`;
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

/**
 * Calculates Levenshtein distance between two strings using dynamic programming.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prevRow = new Array<number>(n + 1);
  let currRow = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) {
    prevRow[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    const aChar = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const bChar = b.charCodeAt(j - 1);
      const cost = aChar === bChar ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1] + 1, // insertion
        prevRow[j] + 1, // deletion
        prevRow[j - 1] + cost, // substitution
      );
    }
    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }

  return prevRow[n];
}

/**
 * Searches local taxonomy items for the closest candidates to an unrecognized input term,
 * prioritizing exact prefixes, substrings, and edit distance.
 * Returns formatted suggestions (e.g. `未分類 -> "%e6%9c%aa%e5%88%86%e9%a1%9e"` or `"diary"`).
 */
export function findClosestTaxonomySuggestions(
  input: string,
  items: LocalTaxonomyItem[],
  maxSuggestions = 3,
): string[] {
  const lowerInput = input.trim().toLowerCase();

  const scored = items.map((item) => {
    const rawName = (item.name || '').trim();
    const lowerName = rawName.toLowerCase();
    const lowerSlug = item.slug.toLowerCase();

    let bestDist = Math.min(
      levenshteinDistance(lowerInput, lowerSlug),
      lowerName ? levenshteinDistance(lowerInput, lowerName) : Infinity,
    );

    // Boost if prefix or substring match
    if (lowerName.startsWith(lowerInput) || lowerSlug.startsWith(lowerInput)) {
      bestDist -= 3;
    } else if (lowerName.includes(lowerInput) || lowerSlug.includes(lowerInput)) {
      bestDist -= 1.5;
    }

    let display: string;
    if (rawName && lowerName !== lowerSlug) {
      display = `${rawName} -> ${formatYamlScalar(item.slug)}`;
    } else {
      display = formatYamlScalar(item.slug);
    }

    return { display, dist: bestDist };
  });

  scored.sort((a, b) => a.dist - b.dist);

  // Deduplicate displays while maintaining top ranking
  const uniqueDisplays: string[] = [];
  const seen = new Set<string>();
  for (const s of scored) {
    if (!seen.has(s.display)) {
      seen.add(s.display);
      uniqueDisplays.push(s.display);
      if (uniqueDisplays.length >= maxSuggestions) break;
    }
  }

  return uniqueDisplays;
}
