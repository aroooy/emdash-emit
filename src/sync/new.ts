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
import { ulid } from 'ulidx';
import {
  computeArticleRelativePath,
  parseMarkdown,
  parseMarkdownLenient,
  serializeMarkdown,
  type Frontmatter,
  type TaxonomyCandidates,
} from '../utils/frontmatter.js';
import { normalizeTaxonomyKey } from '../utils/taxonomy-key.js';
import { loadLocalTaxonomyCandidates, loadLocalTaxonomyTerms } from './taxonomies.js';
import { CANONICAL_ULID_REGEX, isCanonicalUlid } from '../utils/ulid.js';
import { iterWorkspaceArticles } from './workspace/index.js';
import type { CacheDatabase } from '../db/cache.js';

export interface DuplicateSlugInfo {
  slug: string;
  existingId: string;
  existingFilePath: string;
  existingStatus: string;
  source: 'workspace' | 'cache';
}

export class DuplicateSlugError extends Error {
  public readonly code = 'DUPLICATE_SLUG_CONFLICT';
  public readonly slug: string;
  public readonly existingId: string;
  public readonly existingFilePath: string;
  public readonly existingStatus: string;
  public readonly suggestion: string;

  constructor(details: DuplicateSlugInfo) {
    const lines = [
      `❌ Conflict: An article with slug '${details.slug}' already exists!`,
      `   Existing Article: ${details.existingFilePath} (ID: ${details.existingId})`,
      `   💡 Suggestion: Edit the existing file, or pick a unique slug.`,
    ];
    super(lines.join('\n'));
    this.name = 'DuplicateSlugError';
    this.slug = details.slug;
    this.existingId = details.existingId;
    this.existingFilePath = details.existingFilePath;
    this.existingStatus = details.existingStatus;
    this.suggestion = 'Edit the existing file, or pick a unique slug.';
  }
}

function resolveCachedArticleLocale(
  workspaceRoot: string,
  relPath: string | undefined,
  id: string,
  cache?: CacheDatabase,
  rawJson?: string,
): string | null {
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      const dataObj = parsed.data as Record<string, unknown> | undefined;
      const itemObj = (dataObj?.item as Record<string, unknown> | undefined) ?? dataObj ?? parsed;
      if (typeof itemObj.locale === 'string' && itemObj.locale.trim()) {
        return itemObj.locale.trim();
      }
    } catch {
      // ignore
    }
  }
  if (cache) {
    const base = cache.getBaseSnapshot(id);
    if (base?.frontmatterYaml) {
      try {
        const fm = JSON.parse(base.frontmatterYaml) as Record<string, unknown>;
        if (typeof fm.locale === 'string' && fm.locale.trim()) {
          return fm.locale.trim();
        }
      } catch {
        // ignore
      }
    }
  }
  if (relPath) {
    const fullPath = path.isAbsolute(relPath) ? relPath : path.join(workspaceRoot, relPath);
    if (fs.existsSync(fullPath)) {
      try {
        const parsed = parseMarkdownLenient(fs.readFileSync(fullPath, 'utf8'));
        if (parsed?.frontmatter.locale) {
          return parsed.frontmatter.locale;
        }
      } catch {
        // ignore
      }
    }
  }
  return null;
}

/**
 * Searches local workspace files and cache.db to detect duplicate (collection, locale, slug) before article creation.
 */
export function findLocalDuplicateSlug(
  workspaceRoot: string,
  collection: string,
  slug: string,
  cache?: CacheDatabase,
  locale?: string,
): DuplicateSlugInfo | null {
  const normalizedSlug = slug.trim().toLowerCase();
  const normalizedTargetLocale = locale ? locale.trim().toLowerCase() : null;

  // 1. Check CacheDatabase entries and sync_state (multi-row lookup for multi-locale support)
  if (cache) {
    const syncStates = cache.getSyncStatesBySlug(normalizedSlug);
    for (const syncState of syncStates) {
      const firstSegment = syncState.localFilePath.split(/[\\/]/)[0];
      if (firstSegment && firstSegment !== collection) {
        continue;
      }
      if (normalizedTargetLocale) {
        const existingLocale = resolveCachedArticleLocale(
          workspaceRoot,
          syncState.localFilePath,
          syncState.id,
          cache,
        );
        if (existingLocale && existingLocale.toLowerCase() !== normalizedTargetLocale) {
          continue;
        }
      }
      return {
        slug: normalizedSlug,
        existingId: syncState.id,
        existingFilePath: syncState.localFilePath,
        existingStatus: syncState.status,
        source: 'cache',
      };
    }

    const entries = cache.getEntriesBySlug(normalizedSlug, collection);
    for (const entry of entries) {
      if (normalizedTargetLocale) {
        const existingLocale = resolveCachedArticleLocale(
          workspaceRoot,
          undefined,
          entry.id,
          cache,
          entry.rawJson,
        );
        if (existingLocale && existingLocale.toLowerCase() !== normalizedTargetLocale) {
          continue;
        }
      }
      return {
        slug: normalizedSlug,
        existingId: entry.id,
        existingFilePath: `${collection}/${entry.status}/${entry.slug}.md`,
        existingStatus: entry.status,
        source: 'cache',
      };
    }
  }

  // 2. Check local workspace files in <collection>/<locale>/{draft,published}/
  for (const entry of iterWorkspaceArticles(workspaceRoot, collection, {
    statuses: ['draft', 'published'],
  })) {
    try {
      const raw = fs.readFileSync(entry.fullPath, 'utf8');
      const parsed = parseMarkdownLenient(raw) ?? parseMarkdown(raw);
      if (parsed.frontmatter.slug && parsed.frontmatter.slug.toLowerCase() === normalizedSlug) {
        const entryLocale = parsed.frontmatter.locale || entry.locale;
        if (
          normalizedTargetLocale &&
          entryLocale &&
          entryLocale.toLowerCase() !== normalizedTargetLocale
        ) {
          continue;
        }
        return {
          slug: normalizedSlug,
          existingId: parsed.frontmatter.id,
          existingFilePath: entry.relPath,
          existingStatus: parsed.frontmatter.status || entry.status,
          source: 'workspace',
        };
      }
    } catch {
      // Check filename heuristic if frontmatter parse fails
      if (
        normalizedTargetLocale &&
        entry.locale &&
        entry.locale.toLowerCase() !== normalizedTargetLocale
      ) {
        continue;
      }
      const withoutExt = entry.fileName.replace(/\.md$/i, '');
      if (
        withoutExt.toLowerCase().endsWith(`-${normalizedSlug}`) ||
        withoutExt.toLowerCase() === normalizedSlug
      ) {
        return {
          slug: normalizedSlug,
          existingId: 'unknown',
          existingFilePath: entry.relPath,
          existingStatus: entry.status,
          source: 'workspace',
        };
      }
    }
  }

  return null;
}

interface ResolvedTranslationSource {
  id: string;
  slug: string;
  locale: string;
  translationGroup?: string;
  featuredImage?: string | null;
  bylines: string[];
  taxonomies: {
    categories: string[];
    tags: string[];
  };
}

function resolveTranslationSource(
  workspaceRoot: string,
  collection: string,
  target: string,
  cache?: CacheDatabase,
): ResolvedTranslationSource {
  const trimmed = target.trim();
  const isUlid = isCanonicalUlid(trimmed);

  const tryReadFromPath = (relOrAbsPath: string): ResolvedTranslationSource | null => {
    const full = path.isAbsolute(relOrAbsPath)
      ? relOrAbsPath
      : path.join(workspaceRoot, relOrAbsPath);
    if (!fs.existsSync(full)) return null;
    const parsed = parseMarkdownLenient(fs.readFileSync(full, 'utf8'));
    if (!parsed) return null;
    return {
      id: parsed.frontmatter.id,
      slug: parsed.frontmatter.slug,
      locale: parsed.frontmatter.locale || 'ja',
      translationGroup: parsed.frontmatter.translationGroup,
      featuredImage: parsed.frontmatter.featuredImage,
      bylines: parsed.frontmatter.bylines ?? [],
      taxonomies: {
        categories: parsed.frontmatter.taxonomies?.categories ?? [],
        tags: parsed.frontmatter.taxonomies?.tags ?? [],
      },
    };
  };

  if (!isUlid) {
    const fromPath = tryReadFromPath(trimmed);
    if (fromPath) return fromPath;
  } else {
    const normalizedId = trimmed.toUpperCase();
    const syncState = cache?.getSyncState(normalizedId);
    if (syncState) {
      const fromTracked = tryReadFromPath(syncState.localFilePath);
      if (fromTracked) return fromTracked;
    }
    const base = cache?.getBaseSnapshot(normalizedId);
    if (base?.frontmatterYaml) {
      try {
        const fm = JSON.parse(base.frontmatterYaml) as Partial<Frontmatter>;
        if (fm.id && fm.slug) {
          return {
            id: fm.id,
            slug: fm.slug,
            locale: fm.locale || 'ja',
            translationGroup: fm.translationGroup,
            featuredImage: fm.featuredImage,
            bylines: Array.isArray(fm.bylines) ? fm.bylines : [],
            taxonomies: {
              categories: Array.isArray(fm.taxonomies?.categories) ? fm.taxonomies.categories : [],
              tags: Array.isArray(fm.taxonomies?.tags) ? fm.taxonomies.tags : [],
            },
          };
        }
      } catch {
        // fall through to disk scan
      }
    }
    for (const entry of iterWorkspaceArticles(workspaceRoot, collection, {
      statuses: ['draft', 'published'],
    })) {
      if (entry.fileName.toUpperCase().includes(normalizedId)) {
        const found = tryReadFromPath(entry.relPath);
        if (found && found.id.toUpperCase() === normalizedId) return found;
      }
    }
  }

  throw new Error(
    `Source article for --translation-of not found: "${target}". Run "emit pull ${isUlid ? trimmed : '<id>'}" first so the source article exists locally.`,
  );
}

export interface CreateArticleOptions {
  workspaceRoot: string;
  slug?: string;
  title?: string;
  collection?: string;
  locale?: string;
  translationOf?: string;
  inheritTaxonomies?: boolean;
  noTaxonomies?: boolean;
  byline?: string;
  cache?: CacheDatabase;
  candidates?: TaxonomyCandidates;
  categories?: string[] | string;
  tags?: string[] | string;
  description?: string;
  featuredImage?: string;
}

export interface CreateArticleResult {
  id: string;
  slug: string;
  filePath: string;
  fullPath: string;
  warnings: string[];
  assigned: {
    categories: string[];
    tags: string[];
    featuredImage?: string;
    description?: string;
  };
}

function normalizeStringList(input?: string[] | string): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .flatMap((item) => item.split(','))
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Creates a brand-new article scaffold in <collection>/draft/<ulid>-<slug>.md.
 * Assigns a client-side ULID immediately to guarantee ID/filename consistency (G2).
 */
export function createArticleScaffold(options: CreateArticleOptions): CreateArticleResult {
  const collection = options.collection || 'posts';
  const locale = options.locale || 'ja';
  const warnings: string[] = [];

  let translationSource: ResolvedTranslationSource | undefined;
  if (options.translationOf) {
    translationSource = resolveTranslationSource(
      options.workspaceRoot,
      collection,
      options.translationOf,
      options.cache,
    );
    if (translationSource.locale.toLowerCase() === locale.toLowerCase()) {
      throw new Error(
        `Cannot create a "${locale}" translation of "${translationSource.id}" because the source article already has locale "${translationSource.locale}". Specify a different --locale.`,
      );
    }
  }

  const rawSlug = options.slug?.trim() || translationSource?.slug?.trim();
  if (!rawSlug) {
    throw new Error('Slug is required unless --translation-of is specified.');
  }
  const slug = rawSlug.toLowerCase();

  // Guard against duplicate (collection, locale, slug) across workspace files and cache.db
  const existingDup = findLocalDuplicateSlug(
    options.workspaceRoot,
    collection,
    slug,
    options.cache,
    locale,
  );
  if (existingDup) {
    throw new DuplicateSlugError(existingDup);
  }

  const id = ulid();
  const title = options.title || slug;

  let initialBylines: string[] = [];
  if (options.byline) {
    initialBylines = [options.byline];
  } else if (translationSource && translationSource.bylines.length > 0) {
    initialBylines = [...translationSource.bylines];
  } else if (options.cache) {
    const cached = options.cache.getBylines().filter((b) => !b.isGuest);
    if (cached.length > 0 && cached[0].slug) {
      initialBylines = [cached[0].slug];
    }
  }

  let normalizedCategories = normalizeStringList(options.categories);
  let normalizedTags = normalizeStringList(options.tags);

  if (translationSource && !options.noTaxonomies) {
    if (options.inheritTaxonomies) {
      if (normalizedCategories.length === 0) {
        normalizedCategories = [...translationSource.taxonomies.categories];
      }
      if (normalizedTags.length === 0) {
        normalizedTags = [...translationSource.taxonomies.tags];
      }
    } else if (
      (normalizedCategories.length === 0 && translationSource.taxonomies.categories.length > 0) ||
      (normalizedTags.length === 0 && translationSource.taxonomies.tags.length > 0)
    ) {
      const localTerms = loadLocalTaxonomyTerms(options.workspaceRoot);
      const targetLocaleLower = locale.toLowerCase();
      const sourceLocaleLower = translationSource.locale.toLowerCase();

      const autoMapSlugs = (sourceSlugs: string[], taxonomy: 'category' | 'tag'): string[] => {
        const mapped: string[] = [];
        for (const srcSlug of sourceSlugs) {
          const srcKey = normalizeTaxonomyKey(srcSlug).toLowerCase();
          const matchingSourceTerms = localTerms.filter(
            (t) =>
              t.taxonomy === taxonomy &&
              (normalizeTaxonomyKey(t.slug).toLowerCase() === srcKey ||
                (t.canonicalSlug &&
                  normalizeTaxonomyKey(t.canonicalSlug).toLowerCase() === srcKey)),
          );
          const srcTerm =
            matchingSourceTerms.find((t) => t.locale?.toLowerCase() === sourceLocaleLower) ??
            matchingSourceTerms[0];

          let targetTerm = srcTerm?.translationGroup
            ? localTerms.find(
                (t) =>
                  t.taxonomy === taxonomy &&
                  t.translationGroup === srcTerm.translationGroup &&
                  t.locale?.toLowerCase() === targetLocaleLower,
              )
            : undefined;

          if (!targetTerm) {
            targetTerm = localTerms.find(
              (t) =>
                t.taxonomy === taxonomy &&
                t.locale?.toLowerCase() === targetLocaleLower &&
                (normalizeTaxonomyKey(t.slug).toLowerCase() === srcKey ||
                  (t.canonicalSlug &&
                    normalizeTaxonomyKey(t.canonicalSlug).toLowerCase() === srcKey)),
            );
          }

          if (targetTerm) {
            mapped.push(targetTerm.slug);
          } else {
            warnings.push(
              `Skipped ${taxonomy} "${srcSlug}" (no matching term found for locale "${locale}" via translationGroup or slug).`,
            );
          }
        }
        return Array.from(new Set(mapped));
      };

      if (normalizedCategories.length === 0 && translationSource.taxonomies.categories.length > 0) {
        normalizedCategories = autoMapSlugs(translationSource.taxonomies.categories, 'category');
      }
      if (normalizedTags.length === 0 && translationSource.taxonomies.tags.length > 0) {
        normalizedTags = autoMapSlugs(translationSource.taxonomies.tags, 'tag');
      }
    }
  }

  let initialFeaturedImage: string | undefined;
  const featuredImageInput = options.featuredImage ?? translationSource?.featuredImage ?? undefined;
  if (featuredImageInput) {
    const trimmed = featuredImageInput.trim();
    if (trimmed) {
      initialFeaturedImage = CANONICAL_ULID_REGEX.test(trimmed) ? trimmed.toUpperCase() : trimmed;
    }
  }

  let initialSeo: Frontmatter['seo'];
  if (options.description) {
    const trimmedDesc = options.description.trim();
    if (trimmedDesc) {
      initialSeo = {
        description: trimmedDesc,
      };
    }
  }

  const candidates = options.candidates || loadLocalTaxonomyCandidates(options.workspaceRoot);
  const candidateCategories = candidates.categories ?? [];
  const candidateTags = candidates.tags ?? [];

  const isKnownTerm = (
    term: string,
    canonicalList: string[],
    slugToNameMap?: Record<string, string>,
  ): boolean => {
    if (canonicalList.includes(term)) return true;
    const tNorm = normalizeTaxonomyKey(term).toLowerCase();
    if (canonicalList.some((c) => normalizeTaxonomyKey(c).toLowerCase() === tNorm)) {
      return true;
    }
    if (slugToNameMap) {
      for (const [k, v] of Object.entries(slugToNameMap)) {
        if (normalizeTaxonomyKey(k).toLowerCase() === tNorm) return true;
        if (v && v.normalize('NFC').toLowerCase() === tNorm) return true;
      }
    }
    return false;
  };

  // Epistemic check: Only audit terms if local definitions exist
  if (candidateCategories.length > 0) {
    for (const cat of normalizedCategories) {
      if (!isKnownTerm(cat, candidateCategories, candidates.slugToName?.category)) {
        warnings.push(
          `Unknown category slug '${cat}' (not found in local categories/<locale>/*.yaml definitions).`,
        );
      }
    }
  }

  if (candidateTags.length > 0) {
    for (const tag of normalizedTags) {
      if (!isKnownTerm(tag, candidateTags, candidates.slugToName?.tag)) {
        warnings.push(
          `Unknown tag slug '${tag}' (not found in local tags/<locale>/*.yaml definitions).`,
        );
      }
    }
  }

  const frontmatter: Frontmatter = {
    id,
    slug,
    title,
    collection,
    status: 'draft',
    publishedAt: null,
    locale,
    ...(translationSource ? { translationOf: translationSource.id } : {}),
    ...(translationSource?.translationGroup
      ? { translationGroup: translationSource.translationGroup }
      : {}),
    taxonomies: {
      categories: normalizedCategories,
      tags: normalizedTags,
    },
    bylines: initialBylines,
    ...(initialFeaturedImage ? { featuredImage: initialFeaturedImage } : {}),
    ...(initialSeo ? { seo: initialSeo } : {}),
  };

  const initialBody = 'Write article body content here...\n';
  const markdownContent = serializeMarkdown(frontmatter, initialBody, candidates);

  const relPath = computeArticleRelativePath(
    collection,
    'draft',
    id,
    title || slug,
    new Date(),
    locale,
  );
  const fullPath = path.join(options.workspaceRoot, relPath);

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, markdownContent, 'utf8');

  return {
    id,
    slug,
    filePath: relPath,
    fullPath,
    warnings,
    assigned: {
      categories: normalizedCategories,
      tags: normalizedTags,
      ...(initialFeaturedImage ? { featuredImage: initialFeaturedImage } : {}),
      ...(initialSeo?.description ? { description: initialSeo.description } : {}),
    },
  };
}
