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
  serializeMarkdown,
  type Frontmatter,
  type TaxonomyCandidates,
} from '../utils/frontmatter.js';
import { loadLocalTaxonomyCandidates } from './taxonomies.js';
import type { CacheDatabase } from '../db/cache.js';

export interface DuplicateSlugInfo {
  slug: string;
  existingId: string;
  existingFilePath: string;
  existingStatus: string;
  source: 'workspace' | 'cache' | 'remote';
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

/**
 * Searches local workspace files and cache.db to detect duplicate slug before article creation.
 */
export function findLocalDuplicateSlug(
  workspaceRoot: string,
  collection: string,
  slug: string,
  cache?: CacheDatabase,
): DuplicateSlugInfo | null {
  const normalizedSlug = slug.trim().toLowerCase();

  // 1. Check CacheDatabase entries and sync_state (indexed lookups)
  if (cache) {
    const syncState = cache.getSyncStateBySlug(normalizedSlug);
    if (syncState) {
      return {
        slug: normalizedSlug,
        existingId: syncState.id,
        existingFilePath: syncState.localFilePath,
        existingStatus: syncState.status,
        source: 'cache',
      };
    }

    const entry = cache.getEntryBySlug(normalizedSlug, collection);
    if (entry) {
      return {
        slug: normalizedSlug,
        existingId: entry.id,
        existingFilePath: `${collection}/${entry.status}/${entry.slug}.md`,
        existingStatus: entry.status,
        source: 'cache',
      };
    }
  }

  // 2. Check local workspace files in <collection>/draft/ and <collection>/published/
  const collectionDir = path.join(workspaceRoot, collection);
  if (fs.existsSync(collectionDir)) {
    const subdirs = ['draft', 'published'];
    for (const sub of subdirs) {
      const subDir = path.join(collectionDir, sub);
      if (!fs.existsSync(subDir)) continue;

      const files = fs.readdirSync(subDir).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const fullPath = path.join(subDir, file);
        try {
          const raw = fs.readFileSync(fullPath, 'utf8');
          const parsed = parseMarkdown(raw);
          if (parsed.frontmatter.slug && parsed.frontmatter.slug.toLowerCase() === normalizedSlug) {
            return {
              slug: normalizedSlug,
              existingId: parsed.frontmatter.id,
              existingFilePath: path.join(collection, sub, file),
              existingStatus: parsed.frontmatter.status || sub,
              source: 'workspace',
            };
          }
        } catch {
          // Check filename heuristic if frontmatter parse fails
          const withoutExt = file.replace(/\.md$/i, '');
          if (
            withoutExt.toLowerCase().endsWith(`-${normalizedSlug}`) ||
            withoutExt.toLowerCase() === normalizedSlug
          ) {
            return {
              slug: normalizedSlug,
              existingId: 'unknown',
              existingFilePath: path.join(collection, sub, file),
              existingStatus: sub,
              source: 'workspace',
            };
          }
        }
      }
    }
  }

  return null;
}

/**
 * Best-effort remote API search for existing slug.
 * Skips safely on network error, 404, or unsupported endpoints.
 */
export async function checkRemoteDuplicateSlug(options: {
  origin: string;
  token: string;
  collection: string;
  slug: string;
  fetchFn?: typeof fetch;
}): Promise<DuplicateSlugInfo | null> {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const normalizedSlug = options.slug.trim().toLowerCase();
  try {
    const url = new URL(`/_emdash/api/content/${options.collection}`, options.origin);
    url.searchParams.set('slug', normalizedSlug);
    url.searchParams.set('limit', '5');

    const res = await fetchFn(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { items?: Array<Record<string, unknown>> };
    if (Array.isArray(data.items)) {
      const match = data.items.find(
        (item) => String(item.slug || '').toLowerCase() === normalizedSlug,
      );
      if (match && match.id) {
        return {
          slug: normalizedSlug,
          existingId: String(match.id),
          existingFilePath: `${options.collection}/${String(match.status || 'draft')}/${normalizedSlug}.md`,
          existingStatus: String(match.status || 'draft'),
          source: 'remote',
        };
      }
    }
  } catch {
    // Best effort - ignore remote errors
  }

  return null;
}

export interface CreateArticleOptions {
  workspaceRoot: string;
  slug: string;
  title?: string;
  collection?: string;
  locale?: string;
  byline?: string;
  cache?: CacheDatabase;
  candidates?: TaxonomyCandidates;
}

export interface CreateArticleResult {
  id: string;
  slug: string;
  filePath: string;
  fullPath: string;
}

/**
 * Creates a brand-new article scaffold in <collection>/draft/<ulid>-<slug>.md.
 * Assigns a client-side ULID immediately to guarantee ID/filename consistency (G2).
 */
export function createArticleScaffold(options: CreateArticleOptions): CreateArticleResult {
  const collection = options.collection || 'posts';
  const slug = options.slug.trim().toLowerCase();

  // Guard against duplicate slug across workspace files and cache.db
  const existingDup = findLocalDuplicateSlug(
    options.workspaceRoot,
    collection,
    slug,
    options.cache,
  );
  if (existingDup) {
    throw new DuplicateSlugError(existingDup);
  }

  const id = ulid();
  const title = options.title || slug;
  const locale = options.locale || 'ja';

  let initialBylines: string[] = [];
  if (options.byline) {
    initialBylines = [options.byline];
  } else if (options.cache) {
    const cached = options.cache.getBylines().filter((b) => !b.isGuest);
    if (cached.length > 0 && cached[0].slug) {
      initialBylines = [cached[0].slug];
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
    taxonomies: {
      categories: [],
      tags: [],
    },
    bylines: initialBylines,
  };

  const initialBody = 'Write article body content here...\n';
  const candidates = options.candidates || loadLocalTaxonomyCandidates(options.workspaceRoot);
  const markdownContent = serializeMarkdown(frontmatter, initialBody, candidates);

  const relPath = computeArticleRelativePath(collection, 'draft', id, title || slug, new Date());
  const fullPath = path.join(options.workspaceRoot, relPath);

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, markdownContent, 'utf8');

  return {
    id,
    slug,
    filePath: relPath,
    fullPath,
  };
}
