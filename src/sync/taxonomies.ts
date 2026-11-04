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
    fetchTerms('category').catch(() => [] as TaxonomyTerm[]),
    fetchTerms('tag').catch(() => [] as TaxonomyTerm[]),
  ]);

  const categoriesDir = path.join(options.workspaceRoot, 'categories');
  const tagsDir = path.join(options.workspaceRoot, 'tags');

  fs.mkdirSync(categoriesDir, { recursive: true });
  fs.mkdirSync(tagsDir, { recursive: true });

  // Save categories and prune deleted ones
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
  let deletedCategoriesCount = 0;
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

  // Save tags and prune deleted ones
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
  let deletedTagsCount = 0;
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

  return {
    categoriesCount: categories.length,
    tagsCount: tags.length,
    deletedCategoriesCount,
    deletedTagsCount,
  };
}

/**
 * Loads local taxonomy mapping between term ULID and slug from categories/ and tags/ directories.
 */
export function loadLocalTaxonomyMaps(workspaceRoot: string): {
  slugToId: { category: Record<string, string>; tag: Record<string, string> };
  idToSlug: { category: Record<string, string>; tag: Record<string, string> };
} {
  const categoriesDir = path.join(workspaceRoot, 'categories');
  const tagsDir = path.join(workspaceRoot, 'tags');

  const readDirMap = (dir: string) => {
    const slugToId: Record<string, string> = {};
    const idToSlug: Record<string, string> = {};
    if (!fs.existsSync(dir)) return { slugToId, idToSlug };

    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(dir, file), 'utf8');
          const data = yaml.load(content) as Record<string, unknown>;
          if (data && typeof data.id === 'string' && typeof data.slug === 'string') {
            slugToId[data.slug] = data.id;
            idToSlug[data.id] = data.slug;
          }
        } catch {
          // Ignore malformed files
        }
      }
    } catch {
      // Ignore directory read errors
    }
    return { slugToId, idToSlug };
  };

  const catMap = readDirMap(categoriesDir);
  const tagMap = readDirMap(tagsDir);

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
 * Loads local taxonomy candidate names (slugs or labels) from categories/ and tags/ directories.
 */
export function loadLocalTaxonomyCandidates(workspaceRoot: string): {
  categories: string[];
  tags: string[];
} {
  const categoriesDir = path.join(workspaceRoot, 'categories');
  const tagsDir = path.join(workspaceRoot, 'tags');

  const readDirCandidates = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
      const candidates: string[] = [];
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(dir, file), 'utf8');
          const data = yaml.load(content) as Record<string, unknown>;
          if (data && typeof data.slug === 'string') {
            candidates.push(data.slug);
          }
        } catch {
          // Ignore malformed files
        }
      }
      return candidates;
    } catch {
      return [];
    }
  };

  return {
    categories: readDirCandidates(categoriesDir),
    tags: readDirCandidates(tagsDir),
  };
}
