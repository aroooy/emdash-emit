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
import { ulid } from 'ulidx';
import {
  formatYamlScalar,
  sanitizeTitleForFilename,
  tryDecodeTaxonomyTerm,
  type TaxonomyCandidates,
} from '../utils/frontmatter.js';
import {
  aliasesOf,
  canonicalSlugOf,
  isKnownTaxonomyTerm,
  normalizeTaxonomyKey,
  type PrunedTaxonomiesDetail,
  type TaxonomyLookupMaps,
} from '../utils/taxonomy-key.js';

export type { PrunedTaxonomiesDetail, TaxonomyLookupMaps };

export interface TaxonomyTerm {
  id: string;
  name?: string;
  slug: string;
  label?: string;
  parentId?: string | null;
  count?: number;
  locale?: string;
  translationGroup?: string;
  translation_group?: string;
  translationGroupId?: string;
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
  defaultLocale?: string;
}

export interface PullTaxonomiesResult {
  categoriesCount: number;
  tagsCount: number;
  deletedCategoriesCount: number;
  deletedTagsCount: number;
  categoriesFailed?: boolean;
  tagsFailed?: boolean;
  warnings?: string[];
}

/**
 * Serializes a category or tag definition to YAML.
 * Emits decoded slug on disk and keeps raw percent-encoded slug as canonicalSlug when they differ.
 * Uses formatYamlScalar to prevent type coercion of reserved words or numeric strings,
 * and ensures 1-line scalar output to prevent js-yaml folded blocks (> -).
 */
function serializeTaxonomyYaml(doc: {
  id: string;
  name: string;
  slug: string;
  canonicalSlug?: string;
  taxonomy: 'category' | 'tag';
  parentId: string | null;
  count: number;
  locale?: string;
  translationGroup?: string;
  translationOf?: string;
}): string {
  const lines: string[] = [
    `id: ${formatYamlScalar(doc.id)}`,
    `name: ${formatYamlScalar(doc.name)}`,
    `slug: ${formatYamlScalar(doc.slug)}`,
  ];
  if (doc.canonicalSlug && doc.canonicalSlug !== doc.slug) {
    lines.push(`canonicalSlug: ${formatYamlScalar(doc.canonicalSlug)}`);
  }
  lines.push(`taxonomy: ${formatYamlScalar(doc.taxonomy)}`);
  lines.push(`parentId: ${doc.parentId ? formatYamlScalar(doc.parentId) : 'null'}`);
  lines.push(`count: ${doc.count}`);
  if (doc.locale) {
    lines.push(`locale: ${formatYamlScalar(doc.locale)}`);
  }
  if (doc.translationGroup) {
    lines.push(`translationGroup: ${formatYamlScalar(doc.translationGroup)}`);
  }
  if (doc.translationOf) {
    lines.push(`translationOf: ${formatYamlScalar(doc.translationOf)}`);
  }
  return lines.join('\n') + '\n';
}

function writeAndPruneTaxonomyDir(params: {
  dir: string;
  items: TaxonomyTerm[];
  taxonomy: 'category' | 'tag';
  defaultLocale?: string;
}): { count: number; deletedCount: number; fallbackLocaleCount: number } {
  fs.mkdirSync(params.dir, { recursive: true });
  const fallbackDefault = params.defaultLocale?.trim().toLowerCase() || 'ja';
  const activeRelPaths = new Set<string>();
  let fallbackLocaleCount = 0;

  for (const item of params.items) {
    const label = item.label || item.slug;
    const sanitized = sanitizeTitleForFilename(label);
    const fileName = `${item.id}-${sanitized}.yaml`;

    const rawSlug = item.slug;
    const decodedSlug = tryDecodeTaxonomyTerm(rawSlug);
    const rawLocale =
      typeof item.locale === 'string' && item.locale.trim()
        ? item.locale.trim().toLowerCase()
        : undefined;
    if (!rawLocale) {
      fallbackLocaleCount++;
    }
    const termLocale = rawLocale || fallbackDefault;
    const relPath = `${termLocale}/${fileName}`;
    activeRelPaths.add(relPath);

    const localeDir = path.join(params.dir, termLocale);
    fs.mkdirSync(localeDir, { recursive: true });
    const filePath = path.join(localeDir, fileName);

    const rawGroup = item.translationGroup ?? item.translation_group ?? item.translationGroupId;
    const translationGroup =
      typeof rawGroup === 'string' && rawGroup.trim() ? rawGroup.trim() : undefined;

    const doc = {
      id: item.id,
      name: label,
      slug: decodedSlug,
      ...(decodedSlug !== rawSlug ? { canonicalSlug: rawSlug } : {}),
      taxonomy: params.taxonomy,
      parentId: item.parentId || null,
      count: item.count ?? 0,
      locale: termLocale,
      ...(translationGroup ? { translationGroup } : {}),
    };
    fs.writeFileSync(filePath, serializeTaxonomyYaml(doc), 'utf8');
  }

  let deletedCount = 0;
  if (fs.existsSync(params.dir)) {
    for (const entry of fs.readdirSync(params.dir, { withFileTypes: true })) {
      const fullEntry = path.join(params.dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.yaml')) {
        // Prune legacy flat YAML files directly under categories/ or tags/
        try {
          fs.unlinkSync(fullEntry);
          deletedCount++;
        } catch {
          // Ignore unlink errors
        }
      } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'drafts') {
        const subFiles = fs.readdirSync(fullEntry);
        for (const file of subFiles) {
          if (file.endsWith('.yaml') && !activeRelPaths.has(`${entry.name}/${file}`)) {
            try {
              fs.unlinkSync(path.join(fullEntry, file));
              deletedCount++;
            } catch {
              // Ignore unlink errors
            }
          }
        }
        try {
          if (fs.readdirSync(fullEntry).length === 0) {
            fs.rmdirSync(fullEntry);
          }
        } catch {
          // Ignore rmdir errors
        }
      }
    }
  }

  return { count: params.items.length, deletedCount, fallbackLocaleCount };
}

/**
 * Pulls categories and tags from EmDash API and saves them to local YAML files:
 * categories/<locale>/<id>-<sanitizedLabel>.yaml
 * tags/<locale>/<id>-<sanitizedLabel>.yaml
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
  const warnings: string[] = [];

  // Save categories and prune deleted ones (only if fetch succeeded; preserve on failure)
  if (categories !== null) {
    const res = writeAndPruneTaxonomyDir({
      dir: categoriesDir,
      items: categories,
      taxonomy: 'category',
      defaultLocale: options.defaultLocale,
    });
    categoriesCount = res.count;
    deletedCategoriesCount = res.deletedCount;
    if (res.fallbackLocaleCount > 0) {
      const fallback = options.defaultLocale?.trim().toLowerCase() || 'ja';
      warnings.push(
        `${res.fallbackLocaleCount} category term(s) omitted "locale" in remote response; defaulted to "${fallback}".`,
      );
    }
  }

  let tagsCount = 0;
  let deletedTagsCount = 0;

  // Save tags and prune deleted ones (only if fetch succeeded; preserve on failure)
  if (tags !== null) {
    const res = writeAndPruneTaxonomyDir({
      dir: tagsDir,
      items: tags,
      taxonomy: 'tag',
      defaultLocale: options.defaultLocale,
    });
    tagsCount = res.count;
    deletedTagsCount = res.deletedCount;
    if (res.fallbackLocaleCount > 0) {
      const fallback = options.defaultLocale?.trim().toLowerCase() || 'ja';
      warnings.push(
        `${res.fallbackLocaleCount} tag term(s) omitted "locale" in remote response; defaulted to "${fallback}".`,
      );
    }
  }

  return {
    categoriesCount,
    tagsCount,
    deletedCategoriesCount,
    deletedTagsCount,
    categoriesFailed,
    tagsFailed,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export interface LocalTaxonomyItem {
  id: string;
  /** Human-readable decoded slug for disk and prompts (e.g. 'ローカルガイド' or 'camera') */
  slug: string;
  /**
   * Raw server canonical slug for Layer A transport/hashes (e.g. '%e3%83...' or 'camera').
   * Optional in interface to preserve compatibility with hand-authored fixtures,
   * but guaranteed to be populated by readTaxonomyDir() (defaults to slug when omitted).
   */
  canonicalSlug?: string;
  name: string;
  parentId?: string | null;
  count?: number;
  locale?: string;
  translationGroup?: string;
  /** Create-only source term ID when staged offline as a translation via `emit new-term --translation-of`. */
  translationOf?: string;
  /** True when loaded from `<taxonomy>/drafts/<locale>/*.yaml` (pending remote creation on push). */
  isDraft?: boolean;
  /** Absolute disk path of the YAML file (populated by `readTaxonomyDir`). */
  filePath?: string;
}

export interface LocalTaxonomyTermEntry extends LocalTaxonomyItem {
  taxonomy: 'category' | 'tag';
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
 * Reads all taxonomy YAML files from `<dir>/<locale>/*.yaml` (and transparently from
 * `<dir>/*.yaml` for read-only test fixture compatibility, which are pruned on the next
 * successful `pullTaxonomies()` sync) and returns typed items.
 * Single source of truth for reading local category and tag YAML files.
 */
export function readTaxonomyDir(dir: string): LocalTaxonomyItem[] {
  if (!fs.existsSync(dir)) return [];
  try {
    const yamlTargets: Array<{ fullPath: string; dirLocale?: string; isDraft: boolean }> = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.yaml')) {
        yamlTargets.push({ fullPath: path.join(dir, entry.name), isDraft: false });
      } else if (entry.isDirectory() && entry.name === 'drafts') {
        const draftsRoot = path.join(dir, 'drafts');
        for (const dEntry of fs.readdirSync(draftsRoot, { withFileTypes: true })) {
          if (dEntry.isFile() && dEntry.name.endsWith('.yaml')) {
            yamlTargets.push({ fullPath: path.join(draftsRoot, dEntry.name), isDraft: true });
          } else if (dEntry.isDirectory() && !dEntry.name.startsWith('.')) {
            const draftLocaleDir = path.join(draftsRoot, dEntry.name);
            for (const subFile of fs.readdirSync(draftLocaleDir)) {
              if (subFile.endsWith('.yaml')) {
                yamlTargets.push({
                  fullPath: path.join(draftLocaleDir, subFile),
                  dirLocale: dEntry.name,
                  isDraft: true,
                });
              }
            }
          }
        }
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const subDir = path.join(dir, entry.name);
        for (const subFile of fs.readdirSync(subDir)) {
          if (subFile.endsWith('.yaml')) {
            yamlTargets.push({
              fullPath: path.join(subDir, subFile),
              dirLocale: entry.name,
              isDraft: false,
            });
          }
        }
      }
    }

    const items: LocalTaxonomyItem[] = [];
    for (const { fullPath, dirLocale, isDraft } of yamlTargets) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const data = yaml.load(content) as Record<string, unknown>;
        if (data && typeof data.id === 'string' && typeof data.slug === 'string') {
          const rawSlug = String(data.slug).trim();
          if (!rawSlug) continue;

          const rawCanonical =
            typeof data.canonicalSlug === 'string' && data.canonicalSlug.trim()
              ? data.canonicalSlug.trim()
              : undefined;

          let slug: string;
          let canonicalSlug: string;

          if (rawCanonical && rawSlug) {
            // New format (v0.1.26): canonicalSlug is explicit
            slug = rawSlug;
            canonicalSlug = rawCanonical;
          } else if (rawSlug.includes('%')) {
            // Legacy format (v0.1.25): slug is percent-encoded
            const decoded = tryDecodeTaxonomyTerm(rawSlug);
            slug = decoded;
            canonicalSlug = rawSlug;
          } else {
            // Standard ASCII slug
            slug = rawSlug;
            canonicalSlug = rawSlug;
          }

          const locale =
            typeof data.locale === 'string' && data.locale.trim() ? data.locale.trim() : dirLocale;
          const rawGroup =
            data.translationGroup ?? data.translation_group ?? data.translationGroupId;
          const translationGroup =
            typeof rawGroup === 'string' && rawGroup.trim() ? rawGroup.trim() : undefined;
          const translationOf =
            typeof data.translationOf === 'string' && data.translationOf.trim()
              ? data.translationOf.trim()
              : undefined;

          items.push({
            id: data.id,
            slug,
            canonicalSlug,
            name: typeof data.name === 'string' ? data.name : slug,
            parentId: typeof data.parentId === 'string' ? data.parentId : null,
            count: typeof data.count === 'number' ? data.count : undefined,
            ...(locale ? { locale } : {}),
            ...(translationGroup ? { translationGroup } : {}),
            ...(translationOf ? { translationOf } : {}),
            ...(isDraft ? { isDraft: true } : {}),
            filePath: fullPath,
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
 * Deterministic collision winner ordering: highest count first, ties broken by newest ULID (descending).
 * Shared between Layer A (`loadLocalTaxonomyMaps`) and Layer B (`getLocalTaxonomiesSummary`)
 * so duplicate canonical/decoded slugs always resolve to the identical winner term ID.
 */
export function compareTaxonomyTermDeterministically(
  a: { id: string; count?: number },
  b: { id: string; count?: number },
): number {
  const countDiff = (b.count ?? 0) - (a.count ?? 0);
  if (countDiff !== 0) return countDiff;
  return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
}

/**
 * Loads all local taxonomy terms from categories/ and tags/ with their taxonomy kind,
 * locale, and translationGroup metadata preserved.
 */
export function loadLocalTaxonomyTerms(workspaceRoot: string): LocalTaxonomyTermEntry[] {
  const categories = readTaxonomyDir(path.join(workspaceRoot, 'categories')).map((item) => ({
    ...item,
    taxonomy: 'category' as const,
  }));
  const tags = readTaxonomyDir(path.join(workspaceRoot, 'tags')).map((item) => ({
    ...item,
    taxonomy: 'tag' as const,
  }));
  return [...categories, ...tags];
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

  const sortDeterministically = (items: LocalTaxonomyItem[]) =>
    [...items].sort(compareTaxonomyTermDeterministically);

  const toMaps = (items: LocalTaxonomyItem[]) => {
    const slugToId: Record<string, string> = {};
    const idToSlug: Record<string, string> = {};
    const sorted = sortDeterministically(items);

    // Phase 1: Register canonical slugs first (Track 1 / Layer A truth)
    for (const item of sorted) {
      const canonical = canonicalSlugOf(item);
      idToSlug[item.id] = canonical;
      if (!slugToId[canonical]) {
        slugToId[canonical] = item.id;
      }
    }

    // Phase 2: Collect candidate aliases (decoded slug and human-readable name)
    // Only register an alias if it does not collide with ANY canonical slug and maps uniquely to 1 term ID.
    const aliasToIds = new Map<string, Set<string>>();
    const recordAliasCandidate = (alias: string | undefined, id: string) => {
      if (!alias || !alias.trim()) return;
      const normalized = alias.trim().normalize('NFC');
      let set = aliasToIds.get(normalized);
      if (!set) {
        set = new Set<string>();
        aliasToIds.set(normalized, set);
      }
      set.add(id);
    };

    for (const item of sorted) {
      recordAliasCandidate(item.name, item.id);
      const canonical = canonicalSlugOf(item);
      const isCanonicalOwner = slugToId[canonical] === item.id;
      if (isCanonicalOwner && item.slug && item.slug !== canonical) {
        recordAliasCandidate(item.slug, item.id);
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
      if (c.name && c.slug) {
        catMap[c.slug] = c.name;
        const decoded = tryDecodeTaxonomyTerm(c.slug);
        if (decoded !== c.slug) {
          catMap[decoded] = c.name;
        }
        if (c.canonicalSlug && c.canonicalSlug !== c.slug) {
          catMap[c.canonicalSlug] = c.name;
        }
      }
    }
    const tagMap: Record<string, string> = {};
    for (const t of summary.tags) {
      if (t.name && t.slug) {
        tagMap[t.slug] = t.name;
        const decoded = tryDecodeTaxonomyTerm(t.slug);
        if (decoded !== t.slug) {
          tagMap[decoded] = t.name;
        }
        if (t.canonicalSlug && t.canonicalSlug !== t.slug) {
          tagMap[t.canonicalSlug] = t.name;
        }
      }
    }
    return {
      categories: Array.from(new Set(summary.categories.flatMap((c) => aliasesOf(c)))),
      tags: Array.from(new Set(summary.tags.flatMap((t) => aliasesOf(t)))),
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
 * Sorts taxonomy terms deterministically and deduplicates by slug, keeping the winner term.
 * Mode 'slug-grouped' orders by slug ASC first (used for categories display).
 * Mode 'frequency' orders by highest count first, newest ULID break (used for tags display).
 */
export function dedupeTermsBySlug(
  items: LocalTaxonomyItem[],
  mode: 'slug-grouped' | 'frequency' = 'frequency',
): LocalTaxonomyItem[] {
  const sorted = [...items].sort((a, b) => {
    if (mode === 'slug-grouped') {
      if (a.slug < b.slug) return -1;
      if (a.slug > b.slug) return 1;
    }
    return compareTaxonomyTermDeterministically(a, b);
  });

  const seen = new Set<string>();
  const result: LocalTaxonomyItem[] = [];
  for (const item of sorted) {
    if (!seen.has(item.slug)) {
      seen.add(item.slug);
      result.push(item);
    }
  }
  return result;
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

  // Primary sort key `slug` asc orders distinct categories for display; within identical `slug` groups
  // (`a.slug === b.slug`), `compareTaxonomyTermDeterministically` decides the winner kept by `dedupeTermsBySlug`,
  // guaranteeing 100% winner parity with `loadLocalTaxonomyMaps`.
  const categories = dedupeTermsBySlug(readTaxonomyDir(categoriesDir), 'slug-grouped');
  // Sort tags: highest count (usage frequency) first; ties broken by newest ULID (descending)
  const tags = dedupeTermsBySlug(readTaxonomyDir(tagsDir), 'frequency');

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
    const decodedSlug = tryDecodeTaxonomyTerm(item.slug);
    const formattedSlug = formatYamlScalar(decodedSlug);
    return decodedSlug.trim().toLowerCase() === item.name.trim().toLowerCase()
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

/**
 * Checks whether frontmatter contains taxonomy terms that no longer exist in local definitions.
 */
export function carriesPrunedTaxonomies(
  taxonomies: Record<string, string[]> | undefined,
  maps: TaxonomyLookupMaps,
): boolean {
  if (!taxonomies) return false;

  for (const [taxName, terms] of Object.entries(taxonomies)) {
    if (
      taxName !== 'category' &&
      taxName !== 'tag' &&
      taxName !== 'categories' &&
      taxName !== 'tags'
    ) {
      continue;
    }
    const kind = taxName === 'categories' || taxName === 'category' ? 'category' : 'tag';
    if (!Array.isArray(terms)) continue;
    for (const term of terms) {
      if (!isKnownTaxonomyTerm(term, kind, maps)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Filters out pruned taxonomy terms, preserving valid terms.
 * If all terms in a taxonomy are pruned, keeps an explicit empty array [] so remote cleanup can execute.
 */
export function pruneNonexistentTaxonomies(
  taxonomies: Record<string, string[]> | undefined,
  maps: TaxonomyLookupMaps,
): {
  prunedTaxonomies: Record<string, string[]>;
  removedTerms: PrunedTaxonomiesDetail;
} {
  const prunedTaxonomies: Record<string, string[]> = {};
  const removedTerms: PrunedTaxonomiesDetail = {};
  if (!taxonomies) return { prunedTaxonomies, removedTerms };

  for (const [key, terms] of Object.entries(taxonomies)) {
    if (!Array.isArray(terms)) continue;
    const kind =
      key === 'categories' || key === 'category'
        ? 'category'
        : key === 'tags' || key === 'tag'
          ? 'tag'
          : null;
    if (!kind) {
      prunedTaxonomies[key] = [...terms];
      continue;
    }
    const retained: string[] = [];
    const removed: string[] = [];
    for (const term of terms) {
      if (isKnownTaxonomyTerm(term, kind, maps)) {
        retained.push(term);
      } else {
        removed.push(term);
      }
    }
    prunedTaxonomies[key] = retained;
    if (removed.length > 0) {
      if (kind === 'category') {
        removedTerms.categories = [...(removedTerms.categories ?? []), ...removed];
      } else {
        removedTerms.tags = [...(removedTerms.tags ?? []), ...removed];
      }
    }
  }
  return { prunedTaxonomies, removedTerms };
}

/**
 * Normalizes taxonomies for Layer A (base_snapshots.frontmatter_yaml).
 * CRITICAL: Preserves ULID inputs verbatim (protecting loser terms in slug collisions),
 * and resolves slug/name inputs to canonical slugs.
 */
export function canonicalizeTaxonomiesForBaseline(
  taxonomies: Record<string, string[]>,
  maps: TaxonomyLookupMaps,
): Record<string, string[]> {
  const canon: Record<string, string[]> = {};
  for (const [key, terms] of Object.entries(taxonomies)) {
    const kind =
      key === 'categories' || key === 'category'
        ? 'category'
        : key === 'tags' || key === 'tag'
          ? 'tag'
          : null;
    if (!kind) {
      canon[key] = [...terms];
      continue;
    }
    canon[key] = terms.map((term) => {
      // If already a valid ULID, keep ULID verbatim (prevents silent replacement of loser term)
      if (maps.idToSlug[kind]?.[term]) return term;
      const id = maps.slugToId[kind]?.[term];
      if (id && maps.idToSlug[kind]?.[id]) {
        return maps.idToSlug[kind][id];
      }
      return term;
    });
  }
  return canon;
}

export interface CreateLocalDraftTermOptions {
  workspaceRoot: string;
  taxonomy: 'category' | 'tag';
  slug: string;
  name?: string;
  locale: string;
  parent?: string;
  translationOf?: string;
}

export interface CreateLocalDraftTermResult {
  id: string;
  slug: string;
  canonicalSlug: string;
  name: string;
  taxonomy: 'category' | 'tag';
  locale: string;
  parentId: string | null;
  translationOf?: string;
  filePath: string;
  fullPath: string;
}

/**
 * Stages a new category or tag term offline under `<taxonomyDir>/drafts/<locale>/<id>-<name>.yaml`.
 * Protected from `pullTaxonomies()` pruning and automatically created & promoted on `emit push`.
 */
export function createLocalDraftTerm(
  options: CreateLocalDraftTermOptions,
): CreateLocalDraftTermResult {
  const rawSlug = options.slug.trim();
  if (!rawSlug) {
    throw new Error('Term slug cannot be empty.');
  }
  const safeLocale = options.locale.trim().toLowerCase();
  if (!safeLocale) {
    throw new Error('Term locale cannot be empty.');
  }

  const decodedSlug = tryDecodeTaxonomyTerm(rawSlug);
  const label = (options.name?.trim() || decodedSlug).trim();
  const dirName = options.taxonomy === 'category' ? 'categories' : 'tags';
  const taxRoot = path.join(options.workspaceRoot, dirName);

  // Duplicate check aligned with G4 normalization (same taxonomy + locale + slug/canonicalSlug)
  const existing = readTaxonomyDir(taxRoot);
  const targetKeys = new Set([
    normalizeTaxonomyKey(rawSlug).toLowerCase(),
    normalizeTaxonomyKey(decodedSlug).toLowerCase(),
  ]);
  for (const item of existing) {
    if (item.locale && item.locale.toLowerCase() !== safeLocale) continue;
    const itemKeys = new Set([
      normalizeTaxonomyKey(canonicalSlugOf(item)).toLowerCase(),
      ...aliasesOf(item).map((a) => normalizeTaxonomyKey(a).toLowerCase()),
    ]);
    for (const tk of targetKeys) {
      if (itemKeys.has(tk)) {
        throw new Error(
          `[DUPLICATE_TERM_SLUG] ${options.taxonomy} term "${rawSlug}" already exists for locale "${safeLocale}" (id: ${item.id}${item.isDraft ? ', draft' : ''}).`,
        );
      }
    }
  }

  // Optional parent resolution (categories)
  let parentId: string | null = null;
  if (options.parent?.trim()) {
    const parentQuery = options.parent.trim();
    const parentNorm = normalizeTaxonomyKey(parentQuery).toLowerCase();
    const match =
      existing.find((i) => i.id.toUpperCase() === parentQuery.toUpperCase()) ??
      existing.find(
        (i) =>
          (!i.locale || i.locale.toLowerCase() === safeLocale) &&
          (normalizeTaxonomyKey(canonicalSlugOf(i)).toLowerCase() === parentNorm ||
            normalizeTaxonomyKey(i.slug).toLowerCase() === parentNorm),
      );
    if (!match) {
      throw new Error(
        `Parent ${options.taxonomy} "${parentQuery}" not found in local ${dirName}/ definitions.`,
      );
    }
    parentId = match.id;
  }

  const id = ulid();
  const sanitized = sanitizeTitleForFilename(label);
  const fileName = `${id}-${sanitized}.yaml`;
  const relPath = `${dirName}/drafts/${safeLocale}/${fileName}`;
  const fullPath = path.join(options.workspaceRoot, relPath);

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const doc = {
    id,
    name: label,
    slug: decodedSlug,
    ...(decodedSlug !== rawSlug ? { canonicalSlug: rawSlug } : {}),
    taxonomy: options.taxonomy,
    parentId,
    count: 0,
    locale: safeLocale,
    ...(options.translationOf?.trim() ? { translationOf: options.translationOf.trim() } : {}),
  };
  fs.writeFileSync(fullPath, serializeTaxonomyYaml(doc), 'utf8');

  return {
    id,
    slug: decodedSlug,
    canonicalSlug: rawSlug,
    name: label,
    taxonomy: options.taxonomy,
    locale: safeLocale,
    parentId,
    ...(options.translationOf?.trim() ? { translationOf: options.translationOf.trim() } : {}),
    filePath: relPath,
    fullPath,
  };
}

export interface CreateRemoteTaxonomyTermOptions {
  origin: string;
  token: string;
  refreshToken?: string;
  fetchFn?: typeof fetch;
  taxonomy: 'category' | 'tag';
  label: string;
  slug: string;
  locale: string;
  parentId?: string | null;
  translationOf?: string;
}

/**
 * Creates a taxonomy term on remote EmDash via `POST /_emdash/api/taxonomies/{taxonomy}/terms`.
 * Verifies returned slug parity to prevent silent G4 mismatches on subsequent pushes.
 */
export async function createRemoteTaxonomyTerm(
  options: CreateRemoteTaxonomyTermOptions,
): Promise<TaxonomyTerm> {
  const fetchFn = createAuthedFetch(options);
  const url = taxonomiesTermsEndpoint(options.origin, options.taxonomy);
  const body: Record<string, unknown> = {
    label: options.label,
    slug: options.slug,
    locale: options.locale,
    ...(options.parentId ? { parentId: options.parentId } : {}),
    ...(options.translationOf ? { translationOf: options.translationOf } : {}),
  };

  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new ApiError({
      message: `Failed to create remote ${options.taxonomy} term "${options.slug}": ${errText || res.statusText}`,
      code: 'TAXONOMY_CREATE_FAILED',
      status: res.status,
      endpoint: url,
      suggestion:
        res.status === 409
          ? 'This term may already exist on remote. Run "emit pull" to refresh local taxonomy definitions and remove the duplicate draft YAML.'
          : 'Verify network connectivity and taxonomy permissions, then retry "emit push" (the local draft term was preserved).',
    });
  }

  const json = await res.json();
  const data = unwrapEnvelope<Record<string, unknown>>(json);
  const raw = (data.term ?? data.item ?? data) as Record<string, unknown>;
  const serverId = typeof raw.id === 'string' ? raw.id.trim() : '';
  const serverSlug = typeof raw.slug === 'string' ? raw.slug.trim() : options.slug;

  if (!serverId) {
    throw new ApiError({
      message: `Remote ${options.taxonomy} creation for "${options.slug}" did not return a valid term ID.`,
      code: 'TAXONOMY_CREATE_FAILED',
      status: res.status,
      endpoint: url,
      suggestion: 'Run "emit pull" to inspect remote taxonomy definitions.',
    });
  }

  // Verify returned slug parity (prevents silent server normalization breaking local G4 matching)
  const expectedNorm = new Set([
    normalizeTaxonomyKey(options.slug).toLowerCase(),
    normalizeTaxonomyKey(tryDecodeTaxonomyTerm(options.slug)).toLowerCase(),
  ]);
  const returnedNorm = normalizeTaxonomyKey(tryDecodeTaxonomyTerm(serverSlug)).toLowerCase();
  const returnedRawNorm = normalizeTaxonomyKey(serverSlug).toLowerCase();
  if (!expectedNorm.has(returnedNorm) && !expectedNorm.has(returnedRawNorm)) {
    throw new ApiError({
      message: `Remote ${options.taxonomy} creation returned slug "${serverSlug}" which differs from requested "${options.slug}". Aborting promotion to avoid G4 mismatch.`,
      code: 'TAXONOMY_SLUG_MISMATCH',
      status: res.status,
      endpoint: url,
      suggestion: `Run "emit pull" to inspect the created term "${serverSlug}", update article frontmatter to match, and remove the local draft YAML.`,
    });
  }

  const rawGroup = raw.translationGroup ?? raw.translation_group ?? raw.translationGroupId;
  return {
    id: serverId,
    slug: serverSlug,
    label: typeof raw.label === 'string' ? raw.label : options.label,
    parentId: typeof raw.parentId === 'string' ? raw.parentId : (options.parentId ?? null),
    count: typeof raw.count === 'number' ? raw.count : 0,
    locale:
      typeof raw.locale === 'string' && raw.locale.trim() ? raw.locale.trim() : options.locale,
    ...(typeof rawGroup === 'string' && rawGroup.trim()
      ? { translationGroup: rawGroup.trim() }
      : {}),
  };
}

/**
 * Promotes a staged draft taxonomy YAML file into its canonical `<taxonomyDir>/<locale>/<serverId>-<label>.yaml`
 * location and removes the temporary draft file (cleaning up empty draft locale directories).
 */
export function promoteLocalDraftTerm(params: {
  workspaceRoot: string;
  taxonomy: 'category' | 'tag';
  draftFilePath: string;
  serverTerm: TaxonomyTerm;
  fallbackLocale?: string;
}): { canonicalFilePath: string } {
  const dirName = params.taxonomy === 'category' ? 'categories' : 'tags';
  const termLocale =
    params.serverTerm.locale?.trim().toLowerCase() ||
    params.fallbackLocale?.trim().toLowerCase() ||
    'ja';
  const label = params.serverTerm.label || params.serverTerm.slug;
  const sanitized = sanitizeTitleForFilename(label);
  const fileName = `${params.serverTerm.id}-${sanitized}.yaml`;
  const targetDir = path.join(params.workspaceRoot, dirName, termLocale);
  fs.mkdirSync(targetDir, { recursive: true });
  const targetFullPath = path.join(targetDir, fileName);

  const rawSlug = params.serverTerm.slug;
  const decodedSlug = tryDecodeTaxonomyTerm(rawSlug);
  const doc = {
    id: params.serverTerm.id,
    name: label,
    slug: decodedSlug,
    ...(decodedSlug !== rawSlug ? { canonicalSlug: rawSlug } : {}),
    taxonomy: params.taxonomy,
    parentId: params.serverTerm.parentId ?? null,
    count: params.serverTerm.count ?? 0,
    locale: termLocale,
    ...(params.serverTerm.translationGroup
      ? { translationGroup: params.serverTerm.translationGroup }
      : {}),
  };
  fs.writeFileSync(targetFullPath, serializeTaxonomyYaml(doc), 'utf8');

  if (params.draftFilePath && fs.existsSync(params.draftFilePath)) {
    try {
      fs.unlinkSync(params.draftFilePath);
      const draftParent = path.dirname(params.draftFilePath);
      if (fs.existsSync(draftParent) && fs.readdirSync(draftParent).length === 0) {
        fs.rmdirSync(draftParent);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  return { canonicalFilePath: `${dirName}/${termLocale}/${fileName}` };
}
