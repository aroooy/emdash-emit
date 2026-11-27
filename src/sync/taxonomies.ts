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
  parseMarkdownLenient,
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
  description?: string | null;
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
import { taxonomiesTermsEndpoint, taxonomyTermEndpoint } from '../client/endpoints.js';

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
  description?: string | null;
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
  if (typeof doc.description === 'string' && doc.description) {
    lines.push(`description: ${formatYamlScalar(doc.description)}`);
  }
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
      ...(typeof item.description === 'string' && item.description
        ? { description: item.description }
        : {}),
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
  description?: string | null;
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
          const description =
            typeof data.description === 'string' && data.description ? data.description : undefined;

          items.push({
            id: data.id,
            slug,
            canonicalSlug,
            name: typeof data.name === 'string' ? data.name : slug,
            parentId: typeof data.parentId === 'string' ? data.parentId : null,
            ...(description ? { description } : {}),
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

export interface TaxonomyMapsPair {
  slugToId: { category: Record<string, string>; tag: Record<string, string> };
  idToSlug: { category: Record<string, string>; tag: Record<string, string> };
}

export interface LocalTaxonomyMaps extends TaxonomyMapsPair {
  byLocale: Record<string, TaxonomyMapsPair>;
}

/**
 * Loads local taxonomy mapping between term ULID and slug from categories/ and tags/ directories.
 * Includes `byLocale` so multi-language workspaces with identical slugs across locales resolve
 * without cross-locale shadowing while keeping top-level `slugToId`/`idToSlug` backwards-compatible.
 */
export function loadLocalTaxonomyMaps(workspaceRoot: string): LocalTaxonomyMaps {
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

  // Build per-locale maps so identical slugs across locales (e.g. ja vs en) never shadow each other
  const locales = new Set<string>();
  const groupByLocale = (items: LocalTaxonomyItem[]) => {
    const grouped = new Map<string, LocalTaxonomyItem[]>();
    for (const item of items) {
      const loc = (item.locale || '').trim().toLowerCase();
      if (!loc) continue;
      locales.add(loc);
      const list = grouped.get(loc);
      if (list) {
        list.push(item);
      } else {
        grouped.set(loc, [item]);
      }
    }
    return grouped;
  };

  const catByLocale = groupByLocale(catItems);
  const tagByLocale = groupByLocale(tagItems);
  const byLocale: Record<string, TaxonomyMapsPair> = {};
  for (const loc of locales) {
    const cMap = toMaps(catByLocale.get(loc) || []);
    const tMap = toMaps(tagByLocale.get(loc) || []);
    byLocale[loc] = {
      slugToId: { category: cMap.slugToId, tag: tMap.slugToId },
      idToSlug: { category: cMap.idToSlug, tag: tMap.idToSlug },
    };
  }

  return {
    slugToId: {
      category: catMap.slugToId,
      tag: tagMap.slugToId,
    },
    idToSlug: {
      category: catMap.idToSlug,
      tag: tagMap.idToSlug,
    },
    byLocale,
  };
}

/**
 * Resolves a term ULID for a given taxonomy kind and term input (slug/alias),
 * preferring the article's locale map before falling back to the global map.
 */
export function resolveTermIdForLocale(
  taxonomyMaps: ReturnType<typeof loadLocalTaxonomyMaps>,
  kind: 'category' | 'tag',
  term: string,
  locale?: string,
): string | undefined {
  const safeLocale = locale?.trim().toLowerCase();
  if (safeLocale && taxonomyMaps.byLocale?.[safeLocale]) {
    const localeHit = taxonomyMaps.byLocale[safeLocale]!.slugToId[kind]?.[term];
    if (localeHit) return localeHit;
  }
  return taxonomyMaps.slugToId[kind]?.[term];
}

/**
 * Resolves a canonical slug for a given term ULID, preferring the article's locale map
 * before falling back to the global map.
 */
export function resolveCanonicalSlugForLocale(
  taxonomyMaps: ReturnType<typeof loadLocalTaxonomyMaps>,
  kind: 'category' | 'tag',
  termId: string,
  locale?: string,
): string | undefined {
  const safeLocale = locale?.trim().toLowerCase();
  if (safeLocale && taxonomyMaps.byLocale?.[safeLocale]) {
    const localeHit = taxonomyMaps.byLocale[safeLocale]!.idToSlug[kind]?.[termId];
    if (localeHit) return localeHit;
  }
  return taxonomyMaps.idToSlug[kind]?.[termId];
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
  description?: string;
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
    ...(typeof options.description === 'string' && options.description
      ? { description: options.description }
      : {}),
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
    ...(typeof raw.description === 'string' && raw.description
      ? { description: raw.description }
      : typeof options.description === 'string' && options.description
        ? { description: options.description }
        : {}),
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
    ...(typeof params.serverTerm.description === 'string' && params.serverTerm.description
      ? { description: params.serverTerm.description }
      : {}),
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

export interface UpdateTaxonomyTermOptions {
  workspaceRoot: string;
  origin: string;
  token: string;
  refreshToken?: string;
  fetchFn?: typeof fetch;
  defaultLocale?: string;
  taxonomy: 'category' | 'tag';
  target: string;
  locale?: string;
  name?: string;
  slug?: string;
  parent?: string;
  clearParent?: boolean;
  description?: string;
}

export interface UpdateTaxonomyTermResult {
  id: string;
  taxonomy: 'category' | 'tag';
  slug: string;
  canonicalSlug: string;
  name: string;
  locale: string;
  parentId: string | null;
  description?: string;
  isDraft: boolean;
  filePath?: string;
  warnings: string[];
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

function resolveLocalTermTarget(params: {
  workspaceRoot: string;
  taxonomy: 'category' | 'tag';
  target: string;
  locale?: string;
}): LocalTaxonomyTermEntry {
  const allTerms = loadLocalTaxonomyTerms(params.workspaceRoot).filter(
    (t) => t.taxonomy === params.taxonomy,
  );
  const rawTarget = params.target.trim();
  const safeLocale = params.locale?.trim().toLowerCase();

  // 1. Direct YAML file path
  if (rawTarget.endsWith('.yaml') || rawTarget.includes('/') || rawTarget.includes('\\')) {
    const absTarget = path.resolve(params.workspaceRoot, rawTarget);
    const byPath = allTerms.find((t) => t.filePath && path.resolve(t.filePath) === absTarget);
    if (!byPath) {
      throw new Error(
        `No ${params.taxonomy} term found at path "${rawTarget}". Run "emit pull" to refresh local taxonomy definitions.`,
      );
    }
    return byPath;
  }

  // 2. 26-char ULID
  if (ULID_PATTERN.test(rawTarget)) {
    const upper = rawTarget.toUpperCase();
    const byId = allTerms.find((t) => t.id.toUpperCase() === upper);
    if (!byId) {
      throw new Error(
        `No ${params.taxonomy} term found with ID "${rawTarget}". Run "emit pull" to refresh local taxonomy definitions.`,
      );
    }
    return byId;
  }

  // 3. Slug (decoded or percent-encoded, normalized with G4 axis)
  const targetNorm = normalizeTaxonomyKey(tryDecodeTaxonomyTerm(rawTarget)).toLowerCase();
  const targetRawNorm = normalizeTaxonomyKey(rawTarget).toLowerCase();
  const matches = allTerms.filter((t) => {
    if (safeLocale && (t.locale || '').toLowerCase() !== safeLocale) {
      return false;
    }
    return aliasesOf(t).some((alias) => {
      const n = normalizeTaxonomyKey(alias).toLowerCase();
      return n === targetNorm || n === targetRawNorm;
    });
  });

  if (matches.length === 0) {
    throw new Error(
      `No ${params.taxonomy} term found matching "${rawTarget}"${safeLocale ? ` in locale "${safeLocale}"` : ''}. Run "emit pull" or check ${params.taxonomy === 'category' ? 'categories/' : 'tags/'}.`,
    );
  }
  if (matches.length > 1) {
    const locales = matches.map((m) => m.locale || 'unknown').join(', ');
    throw new Error(
      `Multiple ${params.taxonomy} terms match slug "${rawTarget}" across locales (${locales}). Specify --locale <locale> or pass the 26-char ULID / YAML path.`,
    );
  }
  return matches[0]!;
}

function findPostsReferencingTermSlug(params: {
  workspaceRoot: string;
  taxonomy: 'category' | 'tag';
  oldAliases: string[];
}): string[] {
  const postsRoot = path.join(params.workspaceRoot, 'posts');
  if (!fs.existsSync(postsRoot)) return [];

  const targetKeys = new Set(params.oldAliases.map((a) => normalizeTaxonomyKey(a).toLowerCase()));
  const matchedPaths: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      try {
        const raw = fs.readFileSync(fullPath, 'utf8');
        const parsed = parseMarkdownLenient(raw);
        if (!parsed) continue;
        const list =
          params.taxonomy === 'category'
            ? parsed.frontmatter.taxonomies?.categories
            : parsed.frontmatter.taxonomies?.tags;
        if (!Array.isArray(list) || list.length === 0) continue;

        const hasRef = list.some((entrySlug) => {
          const rawNorm = normalizeTaxonomyKey(String(entrySlug)).toLowerCase();
          const decodedNorm = normalizeTaxonomyKey(
            tryDecodeTaxonomyTerm(String(entrySlug)),
          ).toLowerCase();
          return targetKeys.has(rawNorm) || targetKeys.has(decodedNorm);
        });
        if (hasRef) {
          matchedPaths.push(path.relative(params.workspaceRoot, fullPath).replace(/\\/g, '/'));
        }
      } catch {
        // Ignore unreadable markdown files
      }
    }
  };

  walk(postsRoot);
  return matchedPaths.sort();
}

/**
 * Updates an existing category or tag term (or an offline staged draft term under `drafts/`).
 * Remote updates use `PUT /_emdash/api/taxonomies/{taxonomy}/terms/{termSlug}` and refresh
 * the local taxonomy mirror via `pullTaxonomies()`.
 */
export async function updateTaxonomyTerm(
  options: UpdateTaxonomyTermOptions,
): Promise<UpdateTaxonomyTermResult> {
  const hasName = typeof options.name === 'string' && options.name.trim().length > 0;
  const hasSlug = typeof options.slug === 'string' && options.slug.trim().length > 0;
  const hasParent = typeof options.parent === 'string' && options.parent.trim().length > 0;
  const hasClearParent = options.clearParent === true;
  const hasDescription = typeof options.description === 'string';

  if (!hasName && !hasSlug && !hasParent && !hasClearParent && !hasDescription) {
    throw new Error(
      'Specify at least one field to update (--name, --slug, --parent, --clear-parent, or --description).',
    );
  }
  if (hasParent && hasClearParent) {
    throw new Error('Cannot specify both --parent and --clear-parent.');
  }
  if (options.taxonomy === 'tag' && (hasParent || hasClearParent)) {
    throw new Error('Tags do not support parent hierarchies (--parent / --clear-parent).');
  }

  const targetTerm = resolveLocalTermTarget({
    workspaceRoot: options.workspaceRoot,
    taxonomy: options.taxonomy,
    target: options.target,
    locale: options.locale,
  });
  const termLocale = (targetTerm.locale || options.locale || options.defaultLocale || 'ja')
    .trim()
    .toLowerCase();

  // Resolve parent category ULID if --parent was provided
  let nextParentId: string | null | undefined = undefined;
  if (hasClearParent) {
    nextParentId = null;
  } else if (hasParent) {
    const rawParent = options.parent!.trim();
    const allCats = loadLocalTaxonomyTerms(options.workspaceRoot).filter(
      (t) => t.taxonomy === 'category',
    );
    if (ULID_PATTERN.test(rawParent)) {
      const upper = rawParent.toUpperCase();
      const found = allCats.find((c) => c.id.toUpperCase() === upper);
      if (!found) {
        throw new Error(`Parent category ULID "${rawParent}" was not found locally.`);
      }
      nextParentId = found.id;
    } else {
      const pNorm = normalizeTaxonomyKey(tryDecodeTaxonomyTerm(rawParent)).toLowerCase();
      const pRawNorm = normalizeTaxonomyKey(rawParent).toLowerCase();
      const found =
        allCats.find(
          (c) =>
            (c.locale || '').toLowerCase() === termLocale &&
            aliasesOf(c).some((a) => {
              const n = normalizeTaxonomyKey(a).toLowerCase();
              return n === pNorm || n === pRawNorm;
            }),
        ) ||
        allCats.find((c) =>
          aliasesOf(c).some((a) => {
            const n = normalizeTaxonomyKey(a).toLowerCase();
            return n === pNorm || n === pRawNorm;
          }),
        );
      if (!found) {
        throw new Error(`Parent category "${rawParent}" was not found locally.`);
      }
      nextParentId = found.id;
    }
    if (nextParentId === targetTerm.id) {
      throw new Error('A category cannot be its own parent.');
    }
  }

  // Fail-fast local duplicate slug check before mutating
  let nextRawSlug: string | undefined;
  let nextDecodedSlug: string | undefined;
  let slugChanged = false;
  if (hasSlug) {
    nextRawSlug = options.slug!.trim();
    nextDecodedSlug = tryDecodeTaxonomyTerm(nextRawSlug);
    const oldAliasesNorm = new Set(
      aliasesOf(targetTerm).map((a) => normalizeTaxonomyKey(a).toLowerCase()),
    );
    const newNorm = normalizeTaxonomyKey(nextDecodedSlug).toLowerCase();
    const newRawNorm = normalizeTaxonomyKey(nextRawSlug).toLowerCase();
    slugChanged = !oldAliasesNorm.has(newNorm) && !oldAliasesNorm.has(newRawNorm);

    if (slugChanged) {
      const sameTaxonomyTerms = loadLocalTaxonomyTerms(options.workspaceRoot).filter(
        (t) =>
          t.taxonomy === options.taxonomy &&
          t.id !== targetTerm.id &&
          (!t.locale || t.locale.toLowerCase() === termLocale),
      );
      for (const existing of sameTaxonomyTerms) {
        const hit = aliasesOf(existing).some((a) => {
          const n = normalizeTaxonomyKey(a).toLowerCase();
          return n === newNorm || n === newRawNorm;
        });
        if (hit) {
          throw new Error(
            `[DUPLICATE_TERM_SLUG] ${options.taxonomy} term "${nextRawSlug}" already exists for locale "${termLocale}" (id: ${existing.id}${existing.isDraft ? ', draft' : ''}).`,
          );
        }
      }
    }
  }

  const warnings: string[] = [];
  const oldAliases = aliasesOf(targetTerm);

  // Branch A: Offline staged draft term under drafts/ -> update draft YAML in-place
  if (targetTerm.isDraft) {
    const dirName = options.taxonomy === 'category' ? 'categories' : 'tags';
    const nextName = hasName ? options.name!.trim() : targetTerm.name;
    const finalRawSlug = nextRawSlug ?? targetTerm.canonicalSlug ?? targetTerm.slug;
    const finalDecodedSlug = nextDecodedSlug ?? targetTerm.slug;
    const finalParentId = nextParentId !== undefined ? nextParentId : (targetTerm.parentId ?? null);
    const finalDescription = hasDescription
      ? options.description!
      : (targetTerm.description ?? undefined);

    const fileName = `${targetTerm.id}-${sanitizeTitleForFilename(nextName)}.yaml`;
    const draftDir = path.join(options.workspaceRoot, dirName, 'drafts', termLocale);
    fs.mkdirSync(draftDir, { recursive: true });
    const nextFullPath = path.join(draftDir, fileName);

    const doc = {
      id: targetTerm.id,
      name: nextName,
      slug: finalDecodedSlug,
      ...(finalDecodedSlug !== finalRawSlug ? { canonicalSlug: finalRawSlug } : {}),
      taxonomy: options.taxonomy,
      parentId: finalParentId,
      ...(typeof finalDescription === 'string' && finalDescription
        ? { description: finalDescription }
        : {}),
      count: targetTerm.count ?? 0,
      locale: termLocale,
      ...(targetTerm.translationOf ? { translationOf: targetTerm.translationOf } : {}),
    };
    fs.writeFileSync(nextFullPath, serializeTaxonomyYaml(doc), 'utf8');
    if (
      targetTerm.filePath &&
      path.resolve(targetTerm.filePath) !== path.resolve(nextFullPath) &&
      fs.existsSync(targetTerm.filePath)
    ) {
      fs.unlinkSync(targetTerm.filePath);
    }

    if (slugChanged) {
      const refs = findPostsReferencingTermSlug({
        workspaceRoot: options.workspaceRoot,
        taxonomy: options.taxonomy,
        oldAliases,
      });
      if (refs.length > 0) {
        warnings.push(
          `${refs.length} local article(s) still reference the old slug "${targetTerm.slug}": ${refs.join(', ')}. Update their frontmatter to "${finalDecodedSlug}" before running "emit push".`,
        );
      }
    }

    return {
      id: targetTerm.id,
      taxonomy: options.taxonomy,
      slug: finalDecodedSlug,
      canonicalSlug: finalRawSlug,
      name: nextName,
      locale: termLocale,
      parentId: finalParentId,
      ...(finalDescription ? { description: finalDescription } : {}),
      isDraft: true,
      filePath: `${dirName}/drafts/${termLocale}/${fileName}`,
      warnings,
    };
  }

  // Branch B: Remote synced term -> PUT /_emdash/api/taxonomies/{taxonomy}/terms/{termSlug}
  const fetchFn = createAuthedFetch(options);
  const url = taxonomyTermEndpoint(
    options.origin,
    options.taxonomy,
    targetTerm.canonicalSlug || targetTerm.slug,
    targetTerm.locale || options.locale,
  );
  const body: Record<string, unknown> = {
    ...(hasName ? { label: options.name!.trim() } : {}),
    ...(hasSlug ? { slug: nextRawSlug } : {}),
    ...(nextParentId !== undefined ? { parentId: nextParentId } : {}),
    ...(hasDescription ? { description: options.description } : {}),
  };

  const res = await fetchFn(url, {
    method: 'PUT',
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
      message: `Failed to update remote ${options.taxonomy} term "${targetTerm.slug}": ${errText || res.statusText}`,
      code: 'TAXONOMY_UPDATE_FAILED',
      status: res.status,
      endpoint: url,
      suggestion:
        res.status === 409
          ? 'Another term with the target slug already exists on remote. Choose a different slug or run "emit pull" to inspect.'
          : 'Verify network connectivity, taxonomy permissions, and target term existence.',
    });
  }

  const json = await res.json();
  const data = unwrapEnvelope<Record<string, unknown>>(json);
  const raw = (data.term ?? data.item ?? data) as Record<string, unknown>;
  const serverRawSlug =
    typeof raw.slug === 'string' && raw.slug.trim()
      ? raw.slug.trim()
      : (nextRawSlug ?? targetTerm.canonicalSlug ?? targetTerm.slug);
  const serverDecodedSlug = tryDecodeTaxonomyTerm(serverRawSlug);
  const serverName =
    typeof raw.label === 'string' && raw.label.trim()
      ? raw.label.trim()
      : hasName
        ? options.name!.trim()
        : targetTerm.name;
  const serverParentId =
    raw.parentId === null
      ? null
      : typeof raw.parentId === 'string'
        ? raw.parentId
        : nextParentId !== undefined
          ? nextParentId
          : (targetTerm.parentId ?? null);
  const serverDescription =
    typeof raw.description === 'string'
      ? raw.description
      : hasDescription
        ? options.description
        : (targetTerm.description ?? undefined);
  const serverLocale =
    typeof raw.locale === 'string' && raw.locale.trim()
      ? raw.locale.trim().toLowerCase()
      : termLocale;

  try {
    await pullTaxonomies({
      workspaceRoot: options.workspaceRoot,
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      fetchFn: options.fetchFn,
      defaultLocale: options.defaultLocale,
    });
  } catch {
    warnings.push(
      'Remote term was updated, but refreshing local taxonomy mirrors failed. Run "emit pull" to sync local YAML files.',
    );
  }

  if (slugChanged) {
    const refs = findPostsReferencingTermSlug({
      workspaceRoot: options.workspaceRoot,
      taxonomy: options.taxonomy,
      oldAliases,
    });
    if (refs.length > 0) {
      warnings.push(
        `${refs.length} local article(s) still reference the old slug "${targetTerm.slug}": ${refs.join(', ')}. EmDash cascades term slug renames on existing remote posts, so unedited articles can be synced with "emit pull"; for articles with unpushed local edits, update their frontmatter to "${serverDecodedSlug}" before running "emit push".`,
      );
    }
  }

  const refreshed = loadLocalTaxonomyTerms(options.workspaceRoot).find(
    (t) => t.taxonomy === options.taxonomy && t.id === targetTerm.id,
  );

  return {
    id: targetTerm.id,
    taxonomy: options.taxonomy,
    slug: serverDecodedSlug,
    canonicalSlug: serverRawSlug,
    name: serverName,
    locale: serverLocale,
    parentId: serverParentId,
    ...(serverDescription ? { description: serverDescription } : {}),
    isDraft: false,
    ...(refreshed?.filePath
      ? { filePath: path.relative(options.workspaceRoot, refreshed.filePath).replace(/\\/g, '/') }
      : {}),
    warnings,
  };
}
