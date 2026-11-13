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
import type { CacheDatabase, SyncState } from '../db/cache.js';
import { createBaseSnapshot } from '../db/baseline.js';
import { apiResponseToLocal, type MapperOptions } from '../client/mapper.js';
import { ApiError } from '../client/error.js';
import { authenticatedFetch, createAuthedFetch } from '../client/http.js';
import { unwrapEnvelope, unwrapItem, extractRev, normalizeRev } from '../client/api.js';
import { articleContentEndpoint, openApiEndpoint } from '../client/endpoints.js';
import {
  computeArticleRelativePath,
  extractDatePrefixFromPath,
  parseMarkdown,
  serializeMarkdown,
  lenientRepairMarkdownFrontmatter,
  type TaxonomyCandidates,
} from '../utils/frontmatter.js';
import { extractUlidFromFilename } from '../utils/naming.js';
import {
  isLocalMediaRef,
  localizeArticleMediaRefs,
  carriesDepthFreeMediaRef,
  shouldPreferLegacyRef,
} from '../utils/media-body-refs.js';
import {
  CONFLICTS_SUBDIR,
  calculateHash,
  findLocalFilesByUlid,
  isQuarantinedRelativePath,
  quarantineLocalCopy,
  resolveCanonicalArticlePath,
} from './workspace/index.js';

export {
  CONFLICTS_SUBDIR,
  calculateHash,
  findLocalFilesByUlid,
  isQuarantinedRelativePath,
  quarantineLocalCopy,
  resolveCanonicalArticlePath,
  carriesDepthFreeMediaRef,
  shouldPreferLegacyRef,
};
import { loadLocalTaxonomyCandidates } from './taxonomies.js';
import { syncRemoteBylines } from './bylines.js';
import { updateConfigSyncedVersion } from '../utils/config.js';
import { fetchAssignedTerms as fetchAssignedTermsShared, computeTaxonomyHash } from './terms.js';

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
  /**
   * Write mirrored body images into the local file as article-relative `../../media/<storageKey>` references,
   * at the depth derived from the article's own path.
   * The cache baseline always keeps the canonical remote URL, so this only changes the disk spelling and an
   * editor preview can render the image from the mirror. Push restores the canonical form before any payload.
   */
  localMediaRefs?: boolean;
}

export interface PullResult {
  id: string;
  slug: string;
  status: string;
  filePath: string;
  updated: boolean;
  skipped?: boolean;
  deleted?: boolean;
  orphan?: boolean;
  title?: string;
  /** True when the local file has unpushed edits and Emit kept them instead of applying remote changes. */
  localEditsPreserved?: boolean;
  /** True when frontmatter syntax was non-destructively healed while preserving unpushed local body content. */
  healed?: boolean;
  /** True if frontmatter meaning or keys/values were altered during heal (false for syntax-only repair). */
  meaningChanged?: boolean;
  /** Local copies that diverged from the last synced baseline and were preserved in `<collection>/conflicts/`. */
  quarantined?: QuarantinedLocalCopy[];
  quarantineFilePath?: string;
  suggestion?: string;
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
    `  Preserved copies are never pushed or pruned; pushing a rescue copy directly is refused (QUARANTINED_COPY_NOT_PUSHABLE).`,
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
 * Preserves a local Markdown copy verbatim under `<collection>/conflicts/` before Emit
 * overwrites or removes the original path. Used to guarantee that no divergent local
 * content (e.g. an uncached file written by another tool or an older serializer) is
 * silently discarded during a pull.
 * Returns the relative path of the preserved copy, or null when preservation failed.
 */
/**
 * Resolves the canonical article title from remote data symmetrically across
 * fast-path and full-pull (EMIT-005 / v0.1.14 backlog §1).
 */
export function extractCanonicalRemoteTitle(
  rawObj: Record<string, unknown>,
  fallbackSlug?: string,
): string {
  const item = unwrapItem<Record<string, unknown>>(rawObj);
  const data = ((item.data || {}) as Record<string, unknown>) || {};
  const rawTitle = String(data.title || item.title || '').trim();
  if (rawTitle) return rawTitle;
  const rawSlug = String(item.slug || fallbackSlug || '').trim();
  if (rawSlug) return rawSlug;
  return 'Untitled';
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
  existingCopyHash?: string | null,
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
      {
        isForce: Boolean(options.force),
        existingCopyHash,
      },
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
    const url = openApiEndpoint(options.origin);
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

    const url = new URL(articleContentEndpoint(options.origin, collection));
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

  // Helper to fetch assigned terms for a taxonomy ('category' | 'tag')
  const fetchAssignedTerms = (taxonomy: 'category' | 'tag'): Promise<string[] | null> =>
    fetchAssignedTermsShared({
      origin: options.origin,
      token: options.token,
      collection,
      id,
      taxonomy,
      fetchFn,
    });

  // Helper to resolve byline ID-to-slug mapping
  let bylineIdToSlug = options.bylineIdToSlug;
  const getBylineIdToSlug = async (): Promise<Record<string, string>> => {
    if (bylineIdToSlug) return bylineIdToSlug;
    const cachedMaps = options.cache.getBylineMaps();
    if (Object.keys(cachedMaps.idToSlug).length > 0) {
      bylineIdToSlug = cachedMaps.idToSlug;
      return bylineIdToSlug;
    }
    const freshMaps = await syncRemoteBylines({
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      cache: options.cache,
      fetchFn: options.fetchFn,
    }).catch(() => ({ slugToId: {}, idToSlug: {} }));
    bylineIdToSlug = freshMaps.idToSlug;
    return bylineIdToSlug;
  };

  // Helper to resolve taxonomy candidates for frontmatter inline comments
  let candidates = options.candidates;
  const getTaxonomyCandidates = (): TaxonomyCandidates | undefined => {
    if (candidates) return candidates;
    candidates = loadLocalTaxonomyCandidates(options.workspaceRoot);
    return candidates;
  };

  /**
   * Applies the workspace's local-media-ref spelling to a serialized document. `sync_state.local_hash` always
   * records the exact bytes on disk, so every comparison against a tracked file must run through this same
   * transform: reconstructing the canonical form from a remote response and then localizing it keeps the
   * fast-path skip honest whether or not `localMediaRefs` is enabled.
   *
   * `articleRelPath` decides the depth of the resulting reference — an article spells its mirror relative to its
   * own directory so a Markdown preview resolves it offline. Pass `preferLegacyRef` only when reproducing bytes
   * for a file that already sits on disk in the depth-free form, so an untouched article is never re-spelled
   * into a phantom edit; a write that overwrites the file instead targets the article-relative form.
   */
  const localizeDiskMarkdown = (
    canonicalContent: string,
    articleRelPath?: string,
    preferLegacyRef?: boolean,
  ): string =>
    options.localMediaRefs
      ? localizeArticleMediaRefs(canonicalContent, {
          workspaceRoot: options.workspaceRoot,
          articleRelPath: articleRelPath ?? existingFilePathForDepth(),
          fs,
          preferLegacyRef,
        })
      : canonicalContent;

  /** The path a tracked article currently sits at, used when the caller has not resolved a new one yet. */
  const existingFilePathForDepth = (): string => {
    const tracked = options.cache.getSyncState(id)?.localFilePath;
    if (tracked) return tracked;
    const onDisk = findLocalFilesByUlid(options.workspaceRoot, collection, id)[0];
    return onDisk ?? `${collection}/draft/${id}.md`;
  };

  // Helper to test fast-path (unmodified skip or non-destructive frontmatter heal)
  const tryFastPathOrHeal = async (item: Record<string, unknown>): Promise<PullResult | null> => {
    if (options.force) return null;
    const existingSync = options.cache.getSyncState(id);
    const rawObj = (item.rawItem || item) as Record<string, unknown>;
    const rawRevCandidate = String(item._rev || item.rev || item.version || rawObj._rev || '');
    const remoteRev = extractRev(rawObj, rawRevCandidate);

    if (
      !existingSync ||
      !remoteRev ||
      normalizeRev(existingSync.remoteRev) !== normalizeRev(remoteRev)
    ) {
      return null;
    }

    const fullExistingPath = path.join(options.workspaceRoot, existingSync.localFilePath);
    if (!fs.existsSync(fullExistingPath)) {
      return null;
    }

    try {
      const currentDiskContent = fs.readFileSync(fullExistingPath, 'utf8');
      // `sync_state.local_hash` always tracks the exact bytes on disk, so a workspace that spells mirrored
      // images as local references must be compared against the same spelling — not against the canonical
      // remote form. Reconstructing the expected disk content keeps the fast-path skip honest under both
      // settings and prevents a phantom "modified" for an article nothing changed.
      const currentDiskHash = calculateHash(currentDiskContent);

      // Check if file path matches current naming standard
      const existingPrefix = extractDatePrefixFromPath(existingSync.localFilePath);
      const fallbackSlug = String(item.slug || existingSync.slug || '');
      const rawTitle = extractCanonicalRemoteTitle(rawObj, fallbackSlug);
      const targetStatus = String(rawObj.status || item.status || 'draft');
      const expectedRelPath = resolveCanonicalArticlePath(
        collection,
        targetStatus,
        id,
        rawTitle,
        {
          publishedAt: (rawObj.publishedAt as string) || (item.publishedAt as string) || null,
          createdAt: (rawObj.createdAt as string) || (item.createdAt as string) || null,
          updatedAt: (rawObj.updatedAt as string) || (item.updatedAt as string) || null,
        },
        existingPrefix,
      );

      // If path matches and contents are unchanged, safely skip (only if local frontmatter is valid YAML)
      if (existingSync.localFilePath === expectedRelPath) {
        // A workspace built before article-relative refs carries the depth-free `media/<storageKey>` spelling,
        // and its tracked hash records exactly those bytes. Repairing the spelling here — rather than falling
        // through to a full remote re-pull — keeps the skip honest: the content is untouched, only the reference
        // form advances, and the file re-tracks against its own repaired hash so nothing reports a phantom edit.
        if (
          options.localMediaRefs &&
          currentDiskHash === existingSync.localHash &&
          carriesDepthFreeMediaRef(currentDiskContent)
        ) {
          const respelled = localizeArticleMediaRefs(currentDiskContent, {
            workspaceRoot: options.workspaceRoot,
            articleRelPath: existingSync.localFilePath,
            fs,
          });
          if (respelled !== currentDiskContent) {
            try {
              parseMarkdown(respelled);
              fs.writeFileSync(fullExistingPath, respelled, 'utf8');
              options.cache.saveSyncState({
                ...existingSync,
                localHash: calculateHash(respelled),
                lastSyncedAt: Math.floor(Date.now() / 1000),
              });
              return {
                id,
                slug: existingSync.slug,
                status: existingSync.status,
                filePath: existingSync.localFilePath,
                updated: true,
                healed: true,
                meaningChanged: false,
                title: rawTitle,
              };
            } catch {
              // Re-spelling broke the parse (it should not): fall through to the normal paths untouched.
            }
          }
        }

        if (currentDiskHash === existingSync.localHash) {
          try {
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
          } catch {
            // Disk content is byte-identical to the cached baseline but its frontmatter no longer parses.
            // Legacy serialization left unquoted %-prefixed (percent-encoded) taxonomy slugs, which js-yaml
            // rejects as a directive indicator: such files stay hash-matched forever and would be skipped by
            // every pull, so status reports them invalid while pull does nothing. Heal them in place with the
            // syntax-only lenient repair instead of falling through to a full remote re-pull.
            const repaired = lenientRepairMarkdownFrontmatter(currentDiskContent);
            if (repaired !== null) {
              fs.writeFileSync(fullExistingPath, repaired, 'utf8');
              const parsedRepaired = parseMarkdown(repaired);
              const repairedHash = calculateHash(repaired);

              // Re-track the repaired file against its own repaired hash so it reads as synced. The
              // remote baseline stays untouched: healing only re-quotes frontmatter syntax, never values.
              const healedAt = Math.floor(Date.now() / 1000);
              options.cache.saveSyncState({
                ...existingSync,
                localFilePath: existingSync.localFilePath,
                localHash: repairedHash,
                remoteRev,
                status: parsedRepaired.frontmatter.status,
                slug: parsedRepaired.frontmatter.slug,
                lastSyncedAt: healedAt,
              });

              return {
                id,
                slug: parsedRepaired.frontmatter.slug,
                status: parsedRepaired.frontmatter.status,
                filePath: existingSync.localFilePath,
                updated: true,
                healed: true,
                meaningChanged: false,
                title: rawTitle,
              };
            }
            // Not healable locally: fall through to the full remote pull, which re-serializes canonical
            // frontmatter from the API response and quarantines any body that diverged from the baseline.
          }
        }

        // Local file has unpushed edits. Check if frontmatter parses cleanly.
        try {
          parseMarkdown(currentDiskContent);
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
        } catch {
          // Local frontmatter is invalid. Attempt non-destructive lenient frontmatter repair.
          const repaired = lenientRepairMarkdownFrontmatter(currentDiskContent);
          if (repaired !== null) {
            fs.writeFileSync(fullExistingPath, repaired, 'utf8');
            const parsedRepaired = parseMarkdown(repaired);

            const resolvedBylineMap = await getBylineIdToSlug();
            const effectiveOptions: PullOptions = {
              ...options,
              bylineIdToSlug: resolvedBylineMap,
            };
            const remoteLocal = apiResponseToLocal(rawObj, effectiveOptions);
            const [categoriesTerms, tagsTerms] = await Promise.all([
              fetchAssignedTerms('category'),
              fetchAssignedTerms('tag'),
            ]);

            if (categoriesTerms !== null || tagsTerms !== null) {
              if (!remoteLocal.frontmatter.taxonomies) {
                remoteLocal.frontmatter.taxonomies = {};
              }
              if (categoriesTerms !== null) {
                remoteLocal.frontmatter.taxonomies.categories = categoriesTerms;
              }
              if (tagsTerms !== null) {
                remoteLocal.frontmatter.taxonomies.tags = tagsTerms;
              }
            }

            const remoteCanonMarkdown = serializeMarkdown(
              remoteLocal.frontmatter,
              remoteLocal.body,
              getTaxonomyCandidates(),
            );
            const remoteCanonHash = calculateHash(remoteCanonMarkdown);
            // The repaired file on disk carries the workspace's local-media-ref spelling, so the tracked hash
            // must be the hash of that spelling. The baseline keeps the canonical form untouched.
            const remoteDiskHash = calculateHash(
              localizeDiskMarkdown(remoteCanonMarkdown, existingSync.localFilePath, true),
            );

            const existingBase = options.cache.getBaseSnapshot(id);
            if (!(categoriesTerms === null && tagsTerms === null && existingBase)) {
              options.cache.saveBaseSnapshot(
                createBaseSnapshot({
                  id,
                  rev: remoteRev,
                  bodyMarkdown: remoteLocal.body,
                  frontmatter: remoteLocal.frontmatter,
                  hash: remoteCanonHash,
                }),
              );
            }

            options.cache.saveSyncState({
              id,
              localFilePath: existingSync.localFilePath,
              localHash: remoteDiskHash,
              remoteRev,
              status: parsedRepaired.frontmatter.status,
              slug: parsedRepaired.frontmatter.slug,
              lastSyncedAt: Math.floor(Date.now() / 1000),
              remoteTaxonomyHash: computeTaxonomyHash(
                remoteLocal.frontmatter.taxonomies?.categories,
                remoteLocal.frontmatter.taxonomies?.tags,
              ),
              taxonomyApplyPending: 0,
              conflictPending: existingSync.conflictPending,
              bodyConflictPending: existingSync.bodyConflictPending,
              taxonomyConflictPending: existingSync.taxonomyConflictPending,
              conflictCopyPath: existingSync.conflictCopyPath,
              conflictCopyHash: existingSync.conflictCopyHash,
              conflictAt: existingSync.conflictAt,
            });

            return {
              id,
              slug: parsedRepaired.frontmatter.slug,
              status: parsedRepaired.frontmatter.status,
              filePath: existingSync.localFilePath,
              updated: true,
              healed: true,
              meaningChanged: false,
              title: rawTitle,
            };
          }
        }
      }
    } catch {
      // If error, fall through to full pull
    }

    return null;
  };

  // 1. Fast-path check: If rawItem is provided in options, test fast-path / heal
  if (rawItem) {
    const fastResult = await tryFastPathOrHeal(rawItem);
    if (fastResult) return fastResult;
  }

  // 2. Fetch raw item if not passed in options
  if (!rawItem) {
    const url = articleContentEndpoint(options.origin, collection, id);
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      if (res.status === 404 || res.status === 410) {
        // Remote article was deleted (404/410)
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
            } else if (options.force) {
              const quarantineRel = quarantineLocalCopy(
                options.workspaceRoot,
                collection,
                existingSync.localFilePath,
                diskContent,
                { isForce: true },
              );
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
                quarantined: quarantineRel
                  ? [
                      {
                        sourceFilePath: existingSync.localFilePath,
                        quarantineFilePath: quarantineRel,
                        reason: 'diverged-from-baseline',
                      },
                    ]
                  : undefined,
                quarantineFilePath: quarantineRel ?? undefined,
              };
            } else {
              // Local file has unpushed edits: preserve as orphan!
              return {
                id,
                slug: existingSync.slug,
                status: existingSync.status,
                filePath: existingSync.localFilePath,
                updated: false,
                orphan: true,
                localEditsPreserved: true,
                suggestion:
                  'Pass --force to preserve your edits under posts/conflicts/ and remove tracking.',
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

    // Step 2b (D5): Test fast-path / non-destructive heal for single-article pull as well!
    const singleHealResult = await tryFastPathOrHeal(rawItem);
    if (singleHealResult) return singleHealResult;
  }

  // Ensure byline ID-to-slug mapping is loaded
  const resolvedBylineMap = await getBylineIdToSlug();
  const effectiveOptions: PullOptions = {
    ...options,
    bylineIdToSlug: resolvedBylineMap,
  };

  const { frontmatter, body, rev } = apiResponseToLocal(rawItem, effectiveOptions);

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

  // Format full Markdown. `canonicalMarkdown` is the remote form and is what every cache hash and every
  // base snapshot records; `markdownContent` is what lands on disk, which may spell mirrored images as local
  // references when `localMediaRefs` is enabled. Keeping the two apart is what lets an editor preview render a
  // mirror while the baseline stays byte-identical to a remote pull.
  const canonicalMarkdown = serializeMarkdown(frontmatter, body, getTaxonomyCandidates());
  const contentHash = calculateHash(canonicalMarkdown);

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

  const canonicalTitle = rawItem
    ? extractCanonicalRemoteTitle(rawItem, frontmatter.slug)
    : frontmatter.title || frontmatter.slug;

  const relPath = resolveCanonicalArticlePath(
    frontmatter.collection,
    frontmatter.status,
    frontmatter.id,
    canonicalTitle,
    {
      publishedAt: (frontmatter.publishedAt as string) || (rawItem?.publishedAt as string) || null,
      createdAt: (rawItem?.createdAt as string) || null,
      updatedAt: (rawItem?.updatedAt as string) || null,
    },
    existingPrefix,
  );

  // Localizing needs the depth of the path the article is about to occupy, so it runs after `relPath` is
  // resolved. A file that already sits on disk in the depth-free legacy spelling keeps that spelling; a fresh
  // write (or an article moving between `draft/` and `published/`) gets the article-relative form its preview
  // can resolve.
  const markdownContent = localizeDiskMarkdown(
    canonicalMarkdown,
    relPath,
    shouldPreferLegacyRef(options.workspaceRoot, existingDiskMatches),
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
    existingSync?.conflictCopyHash,
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
  options.cache.saveBaseSnapshot(
    createBaseSnapshot({
      id: frontmatter.id,
      rev,
      bodyMarkdown: body,
      frontmatter,
      hash: contentHash,
    }),
  );

  // Update sync state with explicit conflict pending preservation
  let conflictInfo: Partial<SyncState> = {};
  // Take the most recently quarantined divergent copy: `quarantineDivergentLocalCopies` walks
  // every stale path for this ULID, so find() would point conflict metadata at an arbitrary
  // (often already-superseded) rescue file when a canonical path change coincides with edits.
  const divergedQuarantines = !options.force
    ? (quarantined ?? []).filter((q) => q.reason === 'diverged-from-baseline')
    : [];
  const divergedQuarantine = divergedQuarantines[divergedQuarantines.length - 1];

  if (divergedQuarantine) {
    // Preserve the most recently written divergent copy so conflict metadata always points at
    // an existing rescue file, even when several stale paths were quarantined in one pull.
    const qFull = path.join(options.workspaceRoot, divergedQuarantine.quarantineFilePath);
    let qHash: string | null = null;
    if (fs.existsSync(qFull)) {
      qHash = calculateHash(fs.readFileSync(qFull, 'utf8'));
    }
    conflictInfo = {
      conflictPending: 1,
      bodyConflictPending: 1,
      taxonomyConflictPending: existingSync?.taxonomyConflictPending ?? 0,
      conflictCopyPath: divergedQuarantine.quarantineFilePath,
      conflictCopyHash: qHash,
      conflictAt: Math.floor(Date.now() / 1000),
    };
  } else if (!options.force && existingSync?.conflictCopyPath) {
    // Keep existing conflict state if conflict copy still exists on disk
    const existingFull = path.join(options.workspaceRoot, existingSync.conflictCopyPath);
    if (fs.existsSync(existingFull)) {
      conflictInfo = {
        conflictPending: existingSync.conflictPending,
        bodyConflictPending: existingSync.bodyConflictPending,
        taxonomyConflictPending: existingSync.taxonomyConflictPending,
        conflictCopyPath: existingSync.conflictCopyPath,
        conflictCopyHash: existingSync.conflictCopyHash,
        conflictAt: existingSync.conflictAt,
      };
    } else {
      // Conflict copy was removed, clear body conflict while keeping taxonomy conflict
      const taxPending = existingSync.taxonomyConflictPending ?? 0;
      conflictInfo = {
        conflictPending: taxPending,
        bodyConflictPending: 0,
        taxonomyConflictPending: taxPending,
        conflictCopyPath: null,
        conflictCopyHash: null,
        conflictAt: null,
      };
    }
  } else if (options.force) {
    conflictInfo = {
      conflictPending: 0,
      bodyConflictPending: 0,
      taxonomyConflictPending: 0,
      conflictCopyPath: null,
      conflictCopyHash: null,
      conflictAt: null,
    };
  } else {
    const taxPending = existingSync?.taxonomyConflictPending ?? 0;
    conflictInfo = {
      conflictPending: taxPending,
      bodyConflictPending: 0,
      taxonomyConflictPending: taxPending,
      conflictCopyPath: null,
      conflictCopyHash: null,
      conflictAt: null,
    };
  }

  options.cache.saveSyncState({
    id: frontmatter.id,
    localFilePath: relPath,
    localHash: calculateHash(markdownContent),
    remoteRev: rev,
    status: frontmatter.status,
    slug: frontmatter.slug,
    lastSyncedAt: Math.floor(Date.now() / 1000),
    remoteTaxonomyHash: computeTaxonomyHash(
      frontmatter.taxonomies?.categories,
      frontmatter.taxonomies?.tags,
    ),
    taxonomyApplyPending: 0,
    ...conflictInfo,
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

  updateConfigSyncedVersion(options.workspaceRoot);

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
