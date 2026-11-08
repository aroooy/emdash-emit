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
import crypto from 'node:crypto';
import type { CacheDatabase } from '../db/cache.js';
import { apiResponseToLocal, type MapperOptions } from '../client/mapper.js';
import { ApiError } from '../client/error.js';
import { authenticatedFetch, createAuthedFetch } from '../client/http.js';
import { unwrapEnvelope, extractRev } from '../client/api.js';
import {
  computeArticleRelativePath,
  extractDatePrefixFromPath,
  parseMarkdown,
  serializeMarkdown,
  type TaxonomyCandidates,
} from '../utils/frontmatter.js';
import { extractUlidFromFilename } from '../utils/naming.js';
import { loadLocalTaxonomyCandidates } from './taxonomies.js';
import { syncRemoteBylines } from './bylines.js';

export interface PullOptions extends MapperOptions {
  workspaceRoot: string;
  cache: CacheDatabase;
  origin: string;
  token: string;
  refreshToken?: string;
  fetchFn?: typeof fetch;
  candidates?: TaxonomyCandidates;
  rawItem?: Record<string, unknown>;
  force?: boolean;
}

export interface PullResult {
  id: string;
  slug: string;
  status: string;
  filePath: string;
  updated: boolean;
  skipped?: boolean;
  deleted?: boolean;
  title?: string;
  /** True when the local file has unpushed edits and Emit kept them instead of applying remote changes. */
  localEditsPreserved?: boolean;
  /** Local copies that diverged from the last synced baseline and were preserved in `<collection>/conflicts/`. */
  quarantined?: QuarantinedLocalCopy[];
}

/**
 * A local Markdown copy whose content differed from Emit's last synced baseline and was
 * therefore preserved under `<collection>/conflicts/` before the canonical file was written.
 * Quarantined copies are informational only: they are not tracked, pushed, or pruned.
 */
export interface QuarantinedLocalCopy {
  /** Relative path of the local file that would have been overwritten or removed. */
  sourceFilePath: string;
  /** Relative path of the preserved copy inside `<collection>/conflicts/`. */
  quarantineFilePath: string;
  /** Why the copy was preserved: no cache baseline existed, or content diverged from it. */
  reason: 'no-cache-baseline' | 'diverged-from-baseline';
}

/** Subdirectory (under a collection) reserved for preserved divergent local copies. */
export const CONFLICTS_SUBDIR = 'conflicts';

/**
 * Human/agent readable notice describing preserved local copies.
 * Returns an empty string when nothing was preserved.
 */
export function formatQuarantineNotice(quarantined?: QuarantinedLocalCopy[]): string {
  if (!quarantined || quarantined.length === 0) return '';
  const lines = [
    `🩹 ${quarantined.length} divergent local copy(ies) preserved under ${CONFLICTS_SUBDIR}/ before being overwritten:`,
    ...quarantined.map((q) => `  - ${q.sourceFilePath} -> ${q.quarantineFilePath} (${q.reason})`),
    '  Review each rescue copy, merge any valuable content into the canonical article, then delete it.',
    '  Preserved copies are never pushed or pruned.',
  ];
  return lines.join('\n');
}

export interface RemoteArticleItem {
  id: string;
  slug: string;
  status: string;
  title: string;
  _rev: string;
  rawItem: Record<string, unknown>;
}

export interface ListRemoteArticlesOptions {
  origin: string;
  token: string;
  refreshToken?: string;
  limit?: number;
  all?: boolean;
  status?: 'draft' | 'published' | 'all';
  batchSize?: number;
  fetchFn?: typeof fetch;
}

/**
 * Calculates SHA-256 hash of a string.
 */
export function calculateHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Finds all existing Markdown files in `<collection>/{draft,published}/` whose filename
 * contains the given 26-character ULID. Used to preserve date prefixes and clean up
 * stale duplicate files when pulling an uncached article.
 */
export function findLocalFilesByUlid(
  workspaceRoot: string,
  collection: string,
  id: string,
): string[] {
  const matches: string[] = [];
  for (const sub of ['draft', 'published']) {
    const subDir = path.join(workspaceRoot, collection, sub);
    if (!fs.existsSync(subDir)) continue;
    try {
      for (const file of fs.readdirSync(subDir)) {
        if (!file.endsWith('.md')) continue;
        if (extractUlidFromFilename(file) === id) {
          matches.push(path.join(collection, sub, file));
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }
  return matches;
}

/**
 * Preserves a local Markdown copy verbatim under `<collection>/conflicts/` before Emit
 * overwrites or removes the original path. Used to guarantee that no divergent local
 * content (e.g. an uncached file written by another tool or an older serializer) is
 * silently discarded during a pull.
 * Returns the relative path of the preserved copy, or null when preservation failed.
 */
export function quarantineLocalCopy(
  workspaceRoot: string,
  collection: string,
  sourceRelPath: string,
  content: string,
): string | null {
  const conflictsDir = path.join(workspaceRoot, collection, CONFLICTS_SUBDIR);
  const baseName = path.basename(sourceRelPath).replace(/\.md$/i, '');
  let quarantineRel = path.join(collection, CONFLICTS_SUBDIR, `${baseName}.conflict.md`);

  try {
    fs.mkdirSync(conflictsDir, { recursive: true });
    let suffix = 2;
    while (fs.existsSync(path.join(workspaceRoot, quarantineRel))) {
      quarantineRel = path.join(collection, CONFLICTS_SUBDIR, `${baseName}.conflict-${suffix}.md`);
      suffix += 1;
      if (suffix > 100) return null;
    }
    fs.writeFileSync(path.join(workspaceRoot, quarantineRel), content, 'utf8');
    return quarantineRel;
  } catch {
    return null;
  }
}

/**
 * Discovers local files for this article that are about to be overwritten or unlinked, and
 * preserves every copy whose content does not match the last synced baseline hash or the
 * content Emit is about to write.
 */
function quarantineDivergentLocalCopies(
  options: PullOptions,
  collection: string,
  localRelPaths: Set<string>,
  baselineHash: string | undefined,
  canonicalContent: string,
): QuarantinedLocalCopy[] {
  const quarantined: QuarantinedLocalCopy[] = [];

  for (const localRel of localRelPaths) {
    const localFull = path.resolve(options.workspaceRoot, localRel);
    if (!fs.existsSync(localFull)) continue;

    let localContent: string;
    try {
      localContent = fs.readFileSync(localFull, 'utf8');
    } catch {
      continue;
    }

    // Already identical to what is about to be written: nothing to preserve.
    if (localContent === canonicalContent) continue;
    // Identical to the last synced state: carries no information worth preserving.
    if (baselineHash && calculateHash(localContent) === baselineHash) continue;

    const quarantineRel = quarantineLocalCopy(
      options.workspaceRoot,
      collection,
      localRel,
      localContent,
    );
    if (quarantineRel) {
      quarantined.push({
        sourceFilePath: localRel,
        quarantineFilePath: quarantineRel,
        reason: baselineHash ? 'diverged-from-baseline' : 'no-cache-baseline',
      });
    }
  }

  return quarantined;
}

/**
 * Discovers the server's maximum allowed limit for content list queries from /_emdash/api/openapi.json.
 * Defaults to 100 if openapi.json cannot be fetched or parsed.
 */
export async function getRemoteMaxBatchLimit(options: {
  origin: string;
  token?: string;
  fetchFn?: typeof fetch;
}): Promise<number> {
  const fetchFn = options.fetchFn || fetch;
  try {
    const url = new URL('/_emdash/api/openapi.json', options.origin).toString();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    const res = await fetchFn(url, { headers });
    if (!res.ok) return 100;

    const json = (await res.json()) as Record<string, unknown>;
    const paths = (json.paths || {}) as Record<string, Record<string, unknown>>;
    const getEndpoint =
      paths['/_emdash/api/content/{collection}']?.get || paths['/content/{collection}']?.get;

    if (getEndpoint && Array.isArray((getEndpoint as Record<string, unknown>).parameters)) {
      const params = (getEndpoint as Record<string, unknown>).parameters as Array<
        Record<string, unknown>
      >;
      const limitParam = params.find((p) => p.name === 'limit');
      const schema = (limitParam?.schema || {}) as Record<string, unknown>;
      if (typeof schema.maximum === 'number' && schema.maximum > 0) {
        return schema.maximum;
      }
    }
  } catch {
    // Ignore network or parse error, fallback to safe 100
  }
  return 100;
}

/**
 * Fetches articles for a specific status ('draft' or 'published') using cursor pagination.
 */
async function fetchStatusArticles(
  collection: string,
  status: 'draft' | 'published',
  options: ListRemoteArticlesOptions,
  serverMaxLimit: number,
): Promise<RemoteArticleItem[]> {
  const fetchFn = createAuthedFetch(options);
  const targetTotal = options.all ? Infinity : (options.limit ?? 100);

  const items: RemoteArticleItem[] = [];
  let cursor: string | undefined = undefined;
  let batchLimit = serverMaxLimit;

  while (items.length < targetTotal) {
    const remaining = targetTotal - items.length;
    const currentBatch = Math.min(remaining, batchLimit);

    const url = new URL(`/_emdash/api/content/${collection}`, options.origin);
    url.searchParams.set('status', status);
    url.searchParams.set('limit', String(currentBatch));
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

    // Adaptive fallback if server responds with validation error on limit
    if (!res.ok && res.status === 400) {
      try {
        const errJson = (await res.clone().json()) as Record<string, unknown>;
        const errMsg = JSON.stringify(errJson);
        const match = errMsg.match(/expected number to be <=(\d+)/);
        if (match && Number(match[1]) < batchLimit) {
          batchLimit = Number(match[1]);
          url.searchParams.set('limit', String(Math.min(remaining, batchLimit)));
          res = await fetchFn(url.toString(), {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${options.token}`,
              Accept: 'application/json',
            },
          });
        }
      } catch {
        // Continue to normal error handling below
      }
    }

    if (!res.ok) {
      throw new ApiError({
        message: `Failed to list remote articles (${status}): ${res.statusText}`,
        code: 'ARTICLE_LIST_FAILED',
        status: res.status,
        endpoint: url.toString(),
        suggestion: 'Verify network connection, permissions, or try lowering the limit.',
      });
    }

    const json = await res.json();
    const data = unwrapEnvelope<Record<string, unknown>>(json);
    const rawItems = (
      Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : []
    ) as Array<Record<string, unknown>>;

    if (rawItems.length === 0) {
      break;
    }

    for (const raw of rawItems) {
      const rawData = (raw.data || {}) as Record<string, unknown>;
      const rev = extractRev(raw, '1');
      items.push({
        id: String(raw.id),
        slug: String(raw.slug || ''),
        status: String(raw.status || status),
        title: String(rawData.title || raw.title || 'Untitled'),
        _rev: rev,
        rawItem: raw,
      });

      if (items.length >= targetTotal) {
        break;
      }
    }

    if (!data.nextCursor || typeof data.nextCursor !== 'string') {
      break;
    }
    cursor = data.nextCursor;
  }

  return items;
}

/**
 * Lists articles from EmDash API with cursor pagination and dynamic batch size detection.
 * When status is not specified or 'all', fetches up to `limit` published articles AND
 * up to `limit` draft articles in parallel, ensuring drafts and published posts are both covered.
 */
export async function listRemoteArticles(
  collection: string,
  options: ListRemoteArticlesOptions,
): Promise<RemoteArticleItem[]> {
  const serverMaxLimit = options.batchSize || (await getRemoteMaxBatchLimit(options));

  // If a specific status is explicitly requested
  if (options.status === 'draft' || options.status === 'published') {
    return fetchStatusArticles(collection, options.status, options, serverMaxLimit);
  }

  // Default: Fetch both published (up to limit) and draft (up to limit) in parallel
  const [draftItems, publishedItems] = await Promise.all([
    fetchStatusArticles(collection, 'draft', options, serverMaxLimit),
    fetchStatusArticles(collection, 'published', options, serverMaxLimit),
  ]);

  return [...draftItems, ...publishedItems];
}

/**
 * Pulls a content item from EmDash and updates local files and cache.
 * Implements Differential Skip: if remote _rev matches cached rev and local file is untouched,
 * skips disk write and AST conversion.
 */
export async function pullArticle(
  collection: string,
  id: string,
  options: PullOptions,
): Promise<PullResult> {
  const fetchFn = createAuthedFetch(options);
  let rawItem = options.rawItem;

  // 1. Fast-path check: If rawItem is provided and not forced, check rev & local hash
  if (rawItem && !options.force) {
    const existingSync = options.cache.getSyncState(id);
    const remoteRev = String(rawItem._rev || rawItem.rev || rawItem.version || '1');

    if (existingSync && existingSync.remoteRev === remoteRev) {
      const fullExistingPath = path.join(options.workspaceRoot, existingSync.localFilePath);
      if (fs.existsSync(fullExistingPath)) {
        try {
          const currentDiskContent = fs.readFileSync(fullExistingPath, 'utf8');
          const currentDiskHash = calculateHash(currentDiskContent);

          // Check if file path matches current naming standard
          const existingPrefix = extractDatePrefixFromPath(existingSync.localFilePath);
          const rawData = (rawItem.data || {}) as Record<string, unknown>;
          const rawTitle = String(rawData.title || rawItem.title || rawItem.slug || '');
          const articleDate =
            (rawItem.publishedAt as string) ||
            existingPrefix ||
            (rawItem.createdAt as string) ||
            null;
          const expectedRelPath = computeArticleRelativePath(
            collection,
            String(rawItem.status || 'draft'),
            id,
            rawTitle,
            articleDate,
          );

          // If path matches and contents are unchanged, safely skip (only if local frontmatter is valid YAML;
          // if an older serializer wrote unquoted %-prefixed slugs that fail parseMarkdown, fall through to self-heal)
          if (existingSync.localFilePath === expectedRelPath) {
            if (currentDiskHash === existingSync.localHash) {
              parseMarkdown(currentDiskContent);
              return {
                id,
                slug: existingSync.slug,
                status: existingSync.status,
                filePath: existingSync.localFilePath,
                updated: false,
                skipped: true,
                title: rawTitle,
              };
            }

            // Local file has unpushed edits -> protect local edits
            return {
              id,
              slug: existingSync.slug,
              status: existingSync.status,
              filePath: existingSync.localFilePath,
              updated: false,
              skipped: true,
              localEditsPreserved: true,
              title: rawTitle,
            };
          }
        } catch {
          // If read fails, proceed to normal write
        }
      }
    }
  }

  // 2. Fetch raw item if not passed in options
  if (!rawItem) {
    const url = new URL(`/_emdash/api/content/${collection}/${id}`, options.origin).toString();
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      if (res.status === 404) {
        // Remote article was deleted (404)
        const existingSync = options.cache.getSyncState(id);
        if (existingSync) {
          const fullPath = path.join(options.workspaceRoot, existingSync.localFilePath);
          if (fs.existsSync(fullPath)) {
            const diskContent = fs.readFileSync(fullPath, 'utf8');
            const diskHash = calculateHash(diskContent);
            // Only delete if local file has no unpushed edits
            if (diskHash === existingSync.localHash) {
              try {
                fs.unlinkSync(fullPath);
              } catch {
                // Ignore unlink error
              }
              options.cache.deleteEntry(id);
              return {
                id,
                slug: existingSync.slug,
                status: existingSync.status,
                filePath: existingSync.localFilePath,
                updated: false,
                deleted: true,
              };
            }
          }
        }
      }

      throw new ApiError({
        message: `Failed to pull article ${collection}/${id}: ${res.statusText}`,
        code: 'ARTICLE_PULL_FAILED',
        status: res.status,
        endpoint: url,
        suggestion: `Verify that article '${id}' exists in collection '${collection}'.`,
      });
    }

    rawItem = (await res.json()) as Record<string, unknown>;
  }

  // Ensure byline ID-to-slug mapping is loaded
  let bylineIdToSlug = options.bylineIdToSlug;
  if (!bylineIdToSlug) {
    const cachedMaps = options.cache.getBylineMaps();
    if (Object.keys(cachedMaps.idToSlug).length > 0) {
      bylineIdToSlug = cachedMaps.idToSlug;
    } else {
      const freshMaps = await syncRemoteBylines({
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        cache: options.cache,
        fetchFn: options.fetchFn,
      }).catch(() => ({ slugToId: {}, idToSlug: {} }));
      bylineIdToSlug = freshMaps.idToSlug;
    }
  }

  const effectiveOptions: PullOptions = {
    ...options,
    bylineIdToSlug,
  };

  const { frontmatter, body, rev } = apiResponseToLocal(rawItem, effectiveOptions);

  // Fetch remote taxonomy assignments (category & tag)
  const fetchAssignedTerms = async (taxonomy: 'category' | 'tag'): Promise<string[] | null> => {
    try {
      const termsUrl = new URL(
        `/_emdash/api/content/${collection}/${id}/terms/${taxonomy}`,
        options.origin,
      ).toString();
      const termsRes = await fetchFn(termsUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: 'application/json',
        },
      });
      if (!termsRes.ok) return null;
      const termsJson = (await termsRes.json()) as {
        data?: { terms?: Array<{ slug?: string; id?: string }> };
      };
      const assigned = termsJson.data?.terms || [];
      return assigned.map((t) => t.slug || t.id).filter((s): s is string => Boolean(s));
    } catch {
      return null;
    }
  };

  const [categoriesTerms, tagsTerms] = await Promise.all([
    fetchAssignedTerms('category'),
    fetchAssignedTerms('tag'),
  ]);

  if (categoriesTerms !== null || tagsTerms !== null) {
    if (!frontmatter.taxonomies) {
      frontmatter.taxonomies = {};
    }
    if (categoriesTerms !== null) {
      frontmatter.taxonomies.categories = categoriesTerms;
    }
    if (tagsTerms !== null) {
      frontmatter.taxonomies.tags = tagsTerms;
    }
  }

  // Format full Markdown
  const markdownContent = serializeMarkdown(frontmatter, body);
  const contentHash = calculateHash(markdownContent);

  // Determine standard relative file path: <collection>/<status>/<yyyyMMdd>_<ulid>-<title>.md
  const existingSync = options.cache.getSyncState(frontmatter.id);
  const existingDiskMatches = findLocalFilesByUlid(
    options.workspaceRoot,
    frontmatter.collection,
    frontmatter.id,
  );
  const preferredDiskMatch =
    existingDiskMatches.find((p) =>
      p.startsWith(`${frontmatter.collection}/${frontmatter.status}/`),
    ) ?? existingDiskMatches[0];
  const existingPrefix = existingSync?.localFilePath
    ? extractDatePrefixFromPath(existingSync.localFilePath)
    : preferredDiskMatch
      ? extractDatePrefixFromPath(preferredDiskMatch)
      : null;

  const dateInput =
    frontmatter.publishedAt ||
    existingPrefix ||
    (rawItem.createdAt as string) ||
    (rawItem.updatedAt as string) ||
    null;

  const relPath = computeArticleRelativePath(
    frontmatter.collection,
    frontmatter.status,
    frontmatter.id,
    frontmatter.title || frontmatter.slug,
    dateInput,
  );
  const fullFilePath = path.join(options.workspaceRoot, relPath);

  // Path tracking: Remove any previous file(s) for this ULID at a different path
  // BEFORE writing fullFilePath so case-insensitive filesystems (e.g. macOS APFS)
  // do not unlink the newly written file when only casing differs.
  const staleRelPaths = new Set<string>(existingDiskMatches);
  if (existingSync?.localFilePath) {
    staleRelPaths.add(existingSync.localFilePath);
  }
  const canonicalResolved = path.resolve(fullFilePath);

  // Data safety: preserve every local copy whose content diverges from the last synced
  // baseline (or has no cache baseline at all) before it is overwritten or unlinked.
  const quarantined = quarantineDivergentLocalCopies(
    options,
    frontmatter.collection,
    staleRelPaths,
    existingSync?.localHash,
    markdownContent,
  );

  for (const staleRel of staleRelPaths) {
    const staleFull = path.resolve(options.workspaceRoot, staleRel);
    if (staleFull !== canonicalResolved && fs.existsSync(staleFull)) {
      try {
        fs.unlinkSync(staleFull);
      } catch {
        // Ignore removal failure
      }
    }
  }

  // Ensure parent directory exists and write file
  fs.mkdirSync(path.dirname(fullFilePath), { recursive: true });
  fs.writeFileSync(fullFilePath, markdownContent, 'utf8');

  // Update Base snapshot in cache
  options.cache.saveBaseSnapshot({
    id: frontmatter.id,
    rev,
    bodyMarkdown: body,
    frontmatterYaml: JSON.stringify(frontmatter),
    hash: contentHash,
    savedAt: Math.floor(Date.now() / 1000),
  });

  // Update sync state
  options.cache.saveSyncState({
    id: frontmatter.id,
    localFilePath: relPath,
    localHash: contentHash,
    remoteRev: rev,
    status: frontmatter.status,
    slug: frontmatter.slug,
    lastSyncedAt: Math.floor(Date.now() / 1000),
  });

  // Update entries cache
  options.cache.saveEntry({
    id: frontmatter.id,
    collection: frontmatter.collection,
    slug: frontmatter.slug,
    status: frontmatter.status,
    title: frontmatter.title,
    rev,
    publishedAt: frontmatter.publishedAt,
    rawJson: JSON.stringify(rawItem),
    updatedAt: Math.floor(Date.now() / 1000),
  });

  return {
    id: frontmatter.id,
    slug: frontmatter.slug,
    status: frontmatter.status,
    filePath: relPath,
    updated: true,
    title: frontmatter.title,
    quarantined: quarantined.length > 0 ? quarantined : undefined,
  };
}
