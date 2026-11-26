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
import type { CacheDatabase, SyncState } from '../db/cache.js';
import {
  listRemoteArticles,
  pullArticle,
  createMediaMirrorSession,
  type PullResult,
  type ListRemoteArticlesOptions,
} from './pull/index.js';
import {
  findLocalFilesByUlid,
  quarantineLocalCopy,
  commitArticleSnapshot,
  resolveCanonicalArticlePath,
} from './workspace/index.js';
import { pushArticle, type PushResult, type PushOptions } from './push/index.js';
import { getWorkspaceStatus, selectPushCandidates } from './status.js';
import { isLocalFileUnmodified } from './baseline-reconstruction.js';
import { resolveArticleTarget } from './diff.js';
import { syncRemoteBylines } from './bylines.js';
import {
  loadLocalTaxonomyCandidates,
  pullTaxonomies,
  type PullTaxonomiesResult,
} from './taxonomies.js';
import { pullMedia, type PullMediaResult } from './media/index.js';
import { updateConfigSyncedVersion } from '../utils/config.js';
import { createAuthedFetch } from '../client/http.js';
import {
  articleAdminEndpoint,
  articleContentEndpoint,
  articleDiscardDraftEndpoint,
  articlePreviewUrlEndpoint,
  articleStatusTransitionEndpoint,
} from '../client/endpoints.js';
import { ApiError } from '../client/error.js';
import { acquireLock, releaseLock } from '../client/lock.js';
import { extractComparisonRev, extractRev, isSameRev, unwrapItem } from '../client/api.js';
import { parseMarkdown, serializeMarkdown, type Frontmatter } from '../utils/frontmatter.js';
import { extractDatePrefixFromPath } from '../utils/naming.js';
import { isCanonicalUlid } from '../utils/ulid.js';
import {
  carriesDepthFreeMediaRef,
  localizeArticleMediaRefs,
  scanArticleMediaReferences,
} from '../utils/media-body-refs.js';
import {
  resolveConcurrency,
  resolveMediaSyncLimit,
  resolvePostsSyncLimit,
} from '../utils/sync-limit-precedence.js';

export interface UnpushedConflictItem {
  id: string;
  slug: string;
  filePath: string;
}

export class SyncPruneConflictError extends Error {
  public conflictItems: UnpushedConflictItem[];
  public limit?: number;

  constructor(message: string, conflictItems: UnpushedConflictItem[], limit?: number) {
    super(message);
    this.name = 'SyncPruneConflictError';
    this.conflictItems = conflictItems;
    this.limit = limit;
  }
}

export type OrchestratorTaxonomiesResult = PullTaxonomiesResult & { error?: string };

export interface PullBatchOptions extends ListRemoteArticlesOptions {
  workspaceRoot: string;
  cache: CacheDatabase;
  collection: string;
  force?: boolean;
  concurrency?: number;
  prune?: boolean;
  /** Write mirrored body images as article-relative `../../media/<storageKey>` references. Passed to every article pull. */
  localMediaRefs?: boolean;
  /**
   * Local-first media mirroring is default-ON for a batch pull: after articles land on disk, Emit walks the
   * remote media library once (JSON only), then downloads binaries for exactly the storageKeys those article
   * bodies reference. Pass `false` to skip the walk and every binary download — this is what `--posts-only`
   * uses. The full-library `emit pull-media --all` path stays a separate command, unaffected by this flag.
   */
  mediaSync?: boolean;
  /** Bounds the shared library walk used to resolve referenced assets (default `mediaSyncLimit`). */
  mediaSyncLimit?: number;
  /** When true, skips taxonomy synchronization before article batch pull. */
  postsOnly?: boolean;
  onTaxonomySync?: (result: OrchestratorTaxonomiesResult) => void;
  onProgress?: (progress: { current: number; total: number; item: PullResult }) => void;
}

export interface PullBatchResult {
  total: number;
  updated: number;
  skipped: number;
  deleted?: number;
  /** Articles whose unpushed local edits were kept instead of applying remote changes. */
  preserved?: number;
  /** Window-out prune candidates kept on disk because they (or a ULID-sharing duplicate) have unpushed local edits. */
  pruneSkipped?: UnpushedConflictItem[];
  /** Effective sliding window limit resolved for this batch pull. */
  windowLimit?: number;
  /** Total number of divergent local copies preserved under `<collection>/conflicts/`. */
  quarantined?: number;
  /**
   * Local-first media mirror stage result: the lightweight library walk plus the binaries downloaded for
   * exactly the storageKeys referenced by pulled article bodies. Absent when `mediaSync` was disabled.
   */
  media?: {
    walkedCount: number;
    remoteTotalCount: number | null;
    complete: boolean;
    downloaded: number;
    skipped: number;
    mirroredStorageKeys: string[];
    verifiedStorageKeys: string[];
    orphanStorageKeys: string[];
  };
  items: PullResult[];
  taxonomies?: OrchestratorTaxonomiesResult;
}

export interface PullSingleArticleOptions {
  collection: string;
  targetId: string;
  workspaceRoot: string;
  cache: CacheDatabase;
  origin: string;
  token: string;
  refreshToken?: string;
  force?: boolean;
  postsOnly?: boolean;
  localMediaRefs?: boolean;
  mediaSync?: boolean;
  includeMedia?: boolean;
  metadataOnly?: boolean;
  mediaSyncLimit?: number;
  fetchFn?: typeof fetch;
}

export interface PullSingleArticleResult {
  article: PullResult;
  taxonomies?: OrchestratorTaxonomiesResult;
  libraryMedia?: PullMediaResult;
}

/**
 * Orchestrates single article pull including optional taxonomy sync and media library sync.
 * Reusable across CLI and MCP servers to ensure consistent single-article workflow.
 */
export async function pullSingleArticle(
  options: PullSingleArticleOptions,
): Promise<PullSingleArticleResult> {
  let taxonomiesResult: OrchestratorTaxonomiesResult | undefined = undefined;

  if (!options.postsOnly) {
    try {
      const taxRes = await pullTaxonomies({
        workspaceRoot: options.workspaceRoot,
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        fetchFn: options.fetchFn,
      });
      if (taxRes.categoriesFailed || taxRes.tagsFailed) {
        taxonomiesResult = taxRes;
      }
    } catch (err) {
      taxonomiesResult = {
        categoriesCount: 0,
        tagsCount: 0,
        deletedCategoriesCount: 0,
        deletedTagsCount: 0,
        error: (err as Error).message,
      };
    }
  }

  const taxonomiesFailed = Boolean(
    taxonomiesResult?.categoriesFailed || taxonomiesResult?.tagsFailed || taxonomiesResult?.error,
  );
  const canPruneTaxonomies = !options.postsOnly && !taxonomiesFailed;

  // R-2 (v0.1.37): media walk bound resolved through the shared Layer 0 helper (see pullBatch).
  const mediaSyncLimit = resolveMediaSyncLimit({}, { mediaSyncLimit: options.mediaSyncLimit });

  const article = await pullArticle(options.collection, options.targetId, {
    workspaceRoot: options.workspaceRoot,
    cache: options.cache,
    origin: options.origin,
    token: options.token,
    refreshToken: options.refreshToken,
    force: options.force,
    localMediaRefs: options.localMediaRefs,
    mediaSync: options.mediaSync,
    mediaSyncLimit,
    fetchFn: options.fetchFn,
    canPruneTaxonomies,
  });

  let libraryMedia: PullMediaResult | undefined = undefined;
  if (options.includeMedia) {
    libraryMedia = await pullMedia({
      workspaceRoot: options.workspaceRoot,
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      limit: mediaSyncLimit,
      downloadFiles: options.metadataOnly !== true,
      cache: options.cache,
      fetchFn: options.fetchFn,
    });
  }

  return { article, taxonomies: taxonomiesResult, libraryMedia };
}

/**
 * Orchestrates batch pulling of articles for a collection.
 * Reusable across CLI and MCP servers to ensure consistent behavior.
 */
export async function pullBatch(options: PullBatchOptions): Promise<PullBatchResult> {
  // R-2 (v0.1.37): the batch window is resolved through the shared Layer 0 precedence helper so
  // CLI, MCP, and this orchestrator can never drift apart. `options.all` intentionally keeps an
  // unbounded window: transport receives undefined limit with all:true below, while pruning
  // diagnostics (windowLimit / formatPruneSkippedArticlesNotice) report the DEFAULT_CONFIG fallback that a
  // non-all run would use — matching listRemoteArticles' own ?? 100 transport fallback is out
  // of scope here; only the presentation value changes.
  const limit = resolvePostsSyncLimit({}, { postsSyncLimit: options.limit });
  const mediaSyncLimit = resolveMediaSyncLimit({}, { mediaSyncLimit: options.mediaSyncLimit });
  // Synchronize remote taxonomies safely unless postsOnly
  let taxonomiesResult: OrchestratorTaxonomiesResult | undefined = undefined;

  if (!options.postsOnly) {
    try {
      const taxRes = await pullTaxonomies({
        workspaceRoot: options.workspaceRoot,
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        fetchFn: options.fetchFn,
      });
      taxonomiesResult = taxRes;
    } catch (err) {
      taxonomiesResult = {
        categoriesCount: 0,
        tagsCount: 0,
        deletedCategoriesCount: 0,
        deletedTagsCount: 0,
        error: (err as Error).message,
      };
    }
    if (options.onTaxonomySync && taxonomiesResult) {
      options.onTaxonomySync(taxonomiesResult);
    }
  }

  const taxonomiesFailed = Boolean(
    taxonomiesResult?.categoriesFailed || taxonomiesResult?.tagsFailed || taxonomiesResult?.error,
  );
  const canPruneTaxonomies = !options.postsOnly && !taxonomiesFailed;

  // Synchronize remote bylines into local SQLite cache before pulling articles
  const bylineMaps = await syncRemoteBylines({
    origin: options.origin,
    token: options.token,
    refreshToken: options.refreshToken,
    cache: options.cache,
    fetchFn: options.fetchFn,
  }).catch(() => options.cache.getBylineMaps());

  const candidates = loadLocalTaxonomyCandidates(options.workspaceRoot);

  const mediaSession =
    options.mediaSync !== false
      ? createMediaMirrorSession({
          workspaceRoot: options.workspaceRoot,
          origin: options.origin,
          token: options.token,
          refreshToken: options.refreshToken,
          cache: options.cache,
          fetchFn: options.fetchFn,
          downloadFiles: true,
          isSharedSession: true,
          limit: mediaSyncLimit,
        })
      : undefined;

  const remoteList = await listRemoteArticles(options.collection, {
    origin: options.origin,
    token: options.token,
    refreshToken: options.refreshToken,
    limit: options.all ? undefined : limit,
    all: options.all,
    status: options.status,
    fetchFn: options.fetchFn,
  });

  const shouldPrune = options.prune !== false;
  let candidatesToPrune: SyncState[] = [];
  const pruneSkippedArticles: UnpushedConflictItem[] = [];

  if (shouldPrune) {
    const remoteIdSet = new Set(remoteList.map((r) => r.id));
    const allLocalSyncs = options.cache.getAllSyncStates();
    const collectionEntries = options.cache.listEntries(options.collection);
    const collectionEntryIds = new Set(collectionEntries.map((e) => e.id));
    const targetStatus = options.status || 'all';

    for (const syncState of allLocalSyncs) {
      const belongsToCollection =
        collectionEntryIds.has(syncState.id) ||
        syncState.localFilePath.startsWith(options.collection + path.sep) ||
        syncState.localFilePath.startsWith(options.collection + '/');

      if (!belongsToCollection) continue;

      if (targetStatus !== 'all' && syncState.status !== targetStatus) {
        continue;
      }

      if (!remoteIdSet.has(syncState.id)) {
        candidatesToPrune.push(syncState);
      }
    }

    // Safety guard: Check if any pushed-out candidate (or duplicate file sharing its ULID) has unpushed local changes
    const unpushedConflicts: UnpushedConflictItem[] = [];
    for (const candidate of candidatesToPrune) {
      const candidatePaths = new Set<string>([
        candidate.localFilePath,
        ...findLocalFilesByUlid(options.workspaceRoot, options.collection, candidate.id),
      ]);
      for (const relPath of candidatePaths) {
        const fullPath = path.join(options.workspaceRoot, relPath);
        if (fs.existsSync(fullPath)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            if (
              !isLocalFileUnmodified({
                workspaceRoot: options.workspaceRoot,
                cache: options.cache,
                id: candidate.id,
                relPath,
                localContent: content,
                syncState: candidate,
                candidates,
                healOnSpellingMatch: false,
              })
            ) {
              unpushedConflicts.push({
                id: candidate.id,
                slug: candidate.slug,
                filePath: relPath,
              });
            }
          } catch {
            // If read fails, safely ignore
          }
        }
      }
    }

    if (unpushedConflicts.length > 0) {
      const skippedUlids = new Set(unpushedConflicts.map((i) => i.id));
      candidatesToPrune = candidatesToPrune.filter((c) => !skippedUlids.has(c.id));

      const seenFiles = new Set<string>();
      for (const item of unpushedConflicts) {
        if (!seenFiles.has(item.filePath)) {
          seenFiles.add(item.filePath);
          pruneSkippedArticles.push(item);
        }
      }
    }
  }

  const results: PullResult[] = [];
  let updated = 0;
  let skipped = 0;
  let preserved = 0;
  let quarantined = 0;

  const concurrency = resolveConcurrency({}, { concurrency: options.concurrency });
  let index = 0;

  const worker = async () => {
    while (index < remoteList.length) {
      const currentIndex = index++;
      const item = remoteList[currentIndex];
      const res = await pullArticle(options.collection, item.id, {
        workspaceRoot: options.workspaceRoot,
        cache: options.cache,
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        rawItem: item.rawItem,
        force: options.force,
        localMediaRefs: options.localMediaRefs,
        fetchFn: options.fetchFn,
        bylineIdToSlug: bylineMaps.idToSlug,
        bylineSlugToId: bylineMaps.slugToId,
        candidates,
        mediaSync: options.mediaSync,
        mediaSession,
        canPruneTaxonomies,
      });

      results.push(res);
      if (res.skipped) skipped++;
      else updated++;
      if (res.localEditsPreserved) preserved++;
      if (res.quarantined) quarantined += res.quarantined.length;

      if (options.onProgress) {
        options.onProgress({
          current: results.length,
          total: remoteList.length + candidatesToPrune.length,
          item: res,
        });
      }
    }
  };

  const pool = Array.from({ length: Math.min(concurrency, remoteList.length) }, () => worker());
  await Promise.all(pool);

  // Prune local cached entries that are outside the sync window (or remote-deleted)
  let deleted = 0;
  if (shouldPrune) {
    for (const candidate of candidatesToPrune) {
      const pathsToRemove = new Set<string>([
        candidate.localFilePath,
        ...findLocalFilesByUlid(options.workspaceRoot, options.collection, candidate.id),
      ]);
      for (const relToRemove of pathsToRemove) {
        const fullPath = path.join(options.workspaceRoot, relToRemove);
        if (fs.existsSync(fullPath)) {
          try {
            fs.unlinkSync(fullPath);
          } catch {
            // ignore
          }
        }
      }
      options.cache.deleteEntry(candidate.id);
      deleted++;

      const deletedResult: PullResult = {
        id: candidate.id,
        slug: candidate.slug,
        status: candidate.status,
        filePath: candidate.localFilePath,
        updated: false,
        deleted: true,
      };
      results.push(deletedResult);

      if (options.onProgress) {
        options.onProgress({
          current: results.length,
          total: remoteList.length + candidatesToPrune.length,
          item: deletedResult,
        });
      }
    }
  }

  // Local-first media mirror stage: mediaSession mirrors referenced assets during each pullArticle
  // and aggregates deduplicated results. If mediaSync is enabled, finalize batch media summary.
  let mediaResult: PullBatchResult['media'];
  if (mediaSession && results.some((r) => !r.deleted)) {
    mediaResult = await mediaSession.finalizeBatchMediaResult();
  }

  updateConfigSyncedVersion(options.workspaceRoot);

  return {
    total: remoteList.length,
    updated,
    skipped,
    deleted,
    preserved,
    pruneSkipped: pruneSkippedArticles.length > 0 ? pruneSkippedArticles : undefined,
    windowLimit: limit,
    quarantined,
    media: mediaResult,
    items: results,
    taxonomies: taxonomiesResult,
  };
}

export interface PushAllOptions extends Omit<PushOptions, 'rawItem'> {
  workspaceRoot: string;
  cache: CacheDatabase;
  collection?: string;
}

export interface PushAllResult {
  total: number;
  pushed: number;
  skipped: number;
  invalid: number;
  results: PushResult[];
  skippedItems?: Array<{
    slug: string;
    filePath: string;
    reason: 'conflict_pending' | 'delete_pending' | 'taxonomy_apply_pending';
  }>;
}

/**
 * Orchestrates pushing all modified/untracked files in the workspace.
 * Excludes synced, conflict_pending, delete_pending, taxonomy_apply_pending, and invalid (YAML parse error) files.
 * Reusable across CLI and MCP servers.
 */
export async function pushAll(options: PushAllOptions): Promise<PushAllResult> {
  const status = getWorkspaceStatus(options.workspaceRoot, options.cache, options.collection);
  const { toPush, skipped: skippedItems } = selectPushCandidates(status);

  const results: PushResult[] = [];
  let pushed = 0;

  for (const item of toPush) {
    const res = await pushArticle(item.filePath, {
      workspaceRoot: options.workspaceRoot,
      cache: options.cache,
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      allowPublish: options.allowPublish,
      allowModifiedOpaqueBlocks: options.allowModifiedOpaqueBlocks,
      fetchFn: options.fetchFn,
      // Batch push must honor the same setting single push does, or a workspace that spells mirrored images as
      // local references gets every one of them rewritten to canonical URLs on disk.
      localMediaRefs: options.localMediaRefs,
    });
    results.push(res);
    pushed++;
  }

  return {
    total: toPush.length,
    pushed,
    skipped: status.items.length - toPush.length,
    invalid: status.summary.invalid,
    results,
    ...(skippedItems.length > 0 ? { skippedItems } : {}),
  };
}

export interface PreviewArticleOptions {
  workspaceRoot: string;
  cache: CacheDatabase;
  origin: string;
  token?: string;
  refreshToken?: string;
  collection?: string;
  fetchFn?: typeof fetch;
  /** Whether to query EmDash preview-url endpoint (defaults to true when token is provided). */
  fetchPreviewUrl?: boolean;
}

export interface PreviewArticleResult {
  id: string;
  collection: string;
  filePath: string;
  adminUrl: string;
  previewUrl?: string;
  url: string;
}

export interface PublishArticleOptions {
  workspaceRoot: string;
  cache: CacheDatabase;
  origin: string;
  token: string;
  refreshToken?: string;
  collection?: string;
  localMediaRefs?: boolean;
  fetchFn?: typeof fetch;
}

export interface PublishArticleResult {
  success: boolean;
  alreadyPublished: boolean;
  id: string;
  filePath: string;
  previousFilePath?: string;
  rev: string;
  adminUrl: string;
}

export interface DiscardDraftOptions {
  workspaceRoot: string;
  cache: CacheDatabase;
  origin: string;
  token: string;
  refreshToken?: string;
  collection?: string;
  localMediaRefs?: boolean;
  force?: boolean;
  fetchFn?: typeof fetch;
}

export interface DiscardDraftResult {
  success: boolean;
  noDraftPending: boolean;
  id: string;
  filePath: string;
  rescueFilePath?: string;
  rev: string;
  adminUrl: string;
}

function resolveLifecycleTarget(
  workspaceRoot: string,
  cache: CacheDatabase,
  target: string,
  collection = 'posts',
): { id: string; relPath: string; fullPath: string; parsed: ReturnType<typeof parseMarkdown> } {
  const trimmed = target.trim();
  const isUlid = isCanonicalUlid(trimmed);
  const resolved = resolveArticleTarget({
    workspaceRoot,
    cache,
    filePath: isUlid ? undefined : trimmed,
    id: isUlid ? trimmed : undefined,
  });

  const resolvedFilePath =
    resolved.filePath ??
    (isUlid ? findLocalFilesByUlid(workspaceRoot, collection, trimmed)[0] : undefined);

  if (!resolvedFilePath) {
    throw new Error(
      `Could not resolve article target: "${target}". Run "emit status" to list workspace articles.`,
    );
  }

  const fullPath = path.isAbsolute(resolvedFilePath)
    ? resolvedFilePath
    : path.join(workspaceRoot, resolvedFilePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Target file not found: ${resolvedFilePath}`);
  }

  const relPath = path.relative(workspaceRoot, fullPath);
  const rawContent = fs.readFileSync(fullPath, 'utf8');
  const parsed = parseMarkdown(rawContent, relPath);
  return { id: parsed.frontmatter.id, relPath, fullPath, parsed };
}

/**
 * Resolves the Admin URL (and optional signed preview URL) for a local article.
 */
export async function previewArticle(
  target: string,
  options: PreviewArticleOptions,
): Promise<PreviewArticleResult> {
  const { id, relPath, parsed } = resolveLifecycleTarget(
    options.workspaceRoot,
    options.cache,
    target,
  );
  const collection = parsed.frontmatter.collection || options.collection || 'posts';
  const adminUrl = articleAdminEndpoint(options.origin, collection, id);
  let previewUrl: string | undefined;

  if (options.fetchPreviewUrl !== false && options.token) {
    try {
      const fetchFn = createAuthedFetch({
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        fetchFn: options.fetchFn,
      });
      const res = await fetchFn(articlePreviewUrlEndpoint(options.origin, collection, id), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: 'application/json',
        },
      });
      if (res.ok) {
        const json = (await res.json()) as Record<string, unknown>;
        const data = (json.data as Record<string, unknown> | undefined) ?? json;
        const rawUrl =
          typeof data.url === 'string'
            ? data.url
            : typeof data.previewUrl === 'string'
              ? data.previewUrl
              : undefined;
        if (rawUrl) {
          previewUrl = new URL(rawUrl, options.origin).toString();
        }
      }
    } catch {
      // Preview endpoint may not exist on older EmDash servers; fall back cleanly to adminUrl
    }
  }

  return {
    id,
    collection,
    filePath: relPath,
    adminUrl,
    ...(previewUrl ? { previewUrl } : {}),
    url: previewUrl ?? adminUrl,
  };
}

/**
 * Promotes a staged remote draft (or draft article) to live published status without re-uploading content.
 * Enforces local unmodified guard, pending-flag guards, and Guard G22 (remote change detection).
 */
export async function publishArticle(
  target: string,
  options: PublishArticleOptions,
): Promise<PublishArticleResult> {
  const { id, relPath, fullPath, parsed } = resolveLifecycleTarget(
    options.workspaceRoot,
    options.cache,
    target,
  );
  const collection = parsed.frontmatter.collection || options.collection || 'posts';
  const syncState = options.cache.getSyncState(id);
  const baseSnapshot = options.cache.getBaseSnapshot(id);
  const rawContent = fs.readFileSync(fullPath, 'utf8');
  const adminUrl = articleAdminEndpoint(options.origin, collection, id);

  // Guard 1: Pending state checks (conflict, G15 deletePending, G16 taxConflict, G17 taxApply)
  if (syncState?.deletePending === 1) {
    throw new ApiError({
      endpoint: `/_emdash/api/content/${collection}/${id}`,
      code: 'DELETE_PENDING_ARTICLE',
      status: 409,
      message: `Article ${id} (${relPath}) is marked as delete-pending.`,
      suggestion: `Run "emit push ${relPath} --revive" or "emit pull" to resolve deletion state first.`,
    });
  }
  if (syncState?.conflictPending === 1 || syncState?.taxonomyConflictPending === 1) {
    const isTaxOnly =
      syncState?.taxonomyConflictPending === 1 && (syncState?.bodyConflictPending ?? 0) === 0;
    throw new ApiError({
      endpoint: `/_emdash/api/content/${collection}/${id}`,
      code: isTaxOnly ? 'TAXONOMY_CONFLICT_PENDING' : 'UNPUSHED_CHANGES_PROTECTION',
      status: 409,
      message: `Article ${id} (${relPath}) has unresolved sync conflicts.`,
      suggestion: `Resolve conflicts first or run "emit push ${relPath} --allow-publish".`,
    });
  }
  if (syncState?.taxonomyApplyPending === 1) {
    throw new ApiError({
      endpoint: `/_emdash/api/content/${collection}/${id}`,
      code: 'TAXONOMY_APPLY_PENDING',
      status: 409,
      message: `Article ${id} (${relPath}) has pending remote taxonomy updates.`,
      suggestion: 'Run "emit pull" to synchronize local taxonomy definitions before publishing.',
    });
  }

  // Guard 2: Local must be unmodified and free of un-uploaded media/drafts/ references
  const hasLocalDraftMedia =
    (typeof parsed.frontmatter.featuredImage === 'string' &&
      parsed.frontmatter.featuredImage.includes('media/drafts/')) ||
    scanArticleMediaReferences(parsed.body).some((ref) => ref.includes('media/drafts/'));

  const isClean =
    !hasLocalDraftMedia &&
    isLocalFileUnmodified({
      workspaceRoot: options.workspaceRoot,
      cache: options.cache,
      id,
      relPath,
      localContent: rawContent,
      syncState,
    });

  if (!isClean) {
    throw new ApiError({
      endpoint: `/_emdash/api/content/${collection}/${id}/publish`,
      code: 'UNPUSHED_CHANGES_PROTECTION',
      status: 409,
      message: `Article ${id} (${relPath}) has unpushed local modifications.`,
      suggestion: `To upload and publish your latest local changes, run: "emit push ${relPath} --allow-publish"`,
    });
  }

  const fetchFn = createAuthedFetch(options);
  const getRes = await fetchFn(articleContentEndpoint(options.origin, collection, id), {
    headers: { Authorization: `Bearer ${options.token}` },
  });
  if (!getRes.ok) {
    throw new ApiError({
      endpoint: `/_emdash/api/content/${collection}/${id}`,
      code: 'PUBLISH_FAILED',
      status: getRes.status,
      message: `Failed to fetch remote article ${id} before publish (${getRes.status}).`,
    });
  }

  const rawItem = unwrapItem<Record<string, unknown>>(await getRes.json());
  const revForTransport = extractRev(rawItem);
  const remoteComparisonRev = extractComparisonRev(rawItem, revForTransport);

  // Guard G22: Remote draft diverged since last sync
  if (syncState?.remoteRev && !isSameRev(syncState.remoteRev, remoteComparisonRev)) {
    throw new ApiError({
      endpoint: `/_emdash/api/content/${collection}/${id}/publish`,
      code: 'REMOTE_CHANGED_BEFORE_PUBLISH',
      status: 409,
      message: `Remote draft for ${id} (${relPath}) changed since your last sync.`,
      suggestion: `Run "emit pull ${id}" to inspect the latest remote draft, then run "emit publish ${relPath}".`,
    });
  }

  const alreadyLiveNoDraft = rawItem.status === 'published' && !rawItem.draftRevisionId;
  if (alreadyLiveNoDraft) {
    return {
      success: true,
      alreadyPublished: true,
      id,
      filePath: relPath,
      rev: revForTransport,
      adminUrl,
    };
  }

  await acquireLock(collection, id, {
    origin: options.origin,
    token: options.token,
    fetchFn,
  });

  let finalRev = revForTransport;
  let finalRawItem = rawItem;
  try {
    const publishEndpoint = articleStatusTransitionEndpoint(
      options.origin,
      collection,
      id,
      'publish',
    );
    const publishBody: Record<string, unknown> = { _rev: revForTransport };
    if (parsed.frontmatter.publishedAt) {
      publishBody.publishedAt = parsed.frontmatter.publishedAt;
    }
    const publishRes = await fetchFn(publishEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(publishBody),
    });
    if (!publishRes.ok) {
      const errText = await publishRes.text();
      throw new ApiError({
        endpoint: publishEndpoint,
        code: 'PUBLISH_FAILED',
        status: publishRes.status,
        message: `Failed to publish ${id}: ${errText || publishRes.statusText}`,
      });
    }
    const publishJson = unwrapItem<Record<string, unknown>>(await publishRes.json());
    finalRev = extractRev(publishJson, revForTransport);
    finalRawItem = publishJson;

    // Re-fetch via GET so Track 2 comparisonRev (${version}@live:${liveRevisionId}) is always
    // derived from the full canonical item even if /publish returns a minimal envelope.
    const postPublishGet = await fetchFn(articleContentEndpoint(options.origin, collection, id), {
      headers: { Authorization: `Bearer ${options.token}` },
    });
    if (postPublishGet.ok) {
      const refetched = unwrapItem<Record<string, unknown>>(await postPublishGet.json());
      finalRawItem = refetched;
      finalRev = extractRev(refetched, finalRev);
    }
  } finally {
    await releaseLock(collection, id, {
      origin: options.origin,
      token: options.token,
      fetchFn,
    });
  }

  const comparisonRev = extractComparisonRev(finalRawItem, finalRev);
  const publishedAt =
    typeof finalRawItem.publishedAt === 'string'
      ? finalRawItem.publishedAt
      : parsed.frontmatter.publishedAt || new Date().toISOString();

  const updatedFrontmatter: Frontmatter = {
    ...parsed.frontmatter,
    status: 'published',
    publishedAt,
  };
  const savedFrontmatter: Frontmatter = {
    ...updatedFrontmatter,
    ...(baseSnapshot
      ? {
          taxonomies:
            JSON.parse(baseSnapshot.frontmatterYaml || '{}').taxonomies ??
            updatedFrontmatter.taxonomies,
        }
      : {}),
  };

  const existingPrefix = extractDatePrefixFromPath(relPath);
  const newRelPath = resolveCanonicalArticlePath(
    collection,
    'published',
    id,
    updatedFrontmatter.title || updatedFrontmatter.slug || id,
    {
      publishedAt,
      createdAt: typeof finalRawItem.createdAt === 'string' ? finalRawItem.createdAt : null,
      updatedAt: typeof finalRawItem.updatedAt === 'string' ? finalRawItem.updatedAt : null,
    },
    existingPrefix,
  );
  const newFullPath = path.join(options.workspaceRoot, newRelPath);

  const candidates = loadLocalTaxonomyCandidates(options.workspaceRoot);
  const serializedCanonical = serializeMarkdown(savedFrontmatter, parsed.body, candidates, {
    hasDraftRevision: false,
  });
  const serializedContent = options.localMediaRefs
    ? localizeArticleMediaRefs(serializedCanonical, {
        workspaceRoot: options.workspaceRoot,
        articleRelPath: newRelPath,
        fs,
        preferLegacyRef: carriesDepthFreeMediaRef(rawContent),
      })
    : serializedCanonical;

  commitArticleSnapshot(options.cache, options.workspaceRoot, {
    id,
    relPath: newRelPath,
    diskContent: serializedContent,
    canonicalContent: serializedCanonical,
    frontmatter: savedFrontmatter,
    bodyMarkdown: parsed.body,
    revForTransport: finalRev,
    revForComparison: comparisonRev,
  });

  if (path.resolve(fullPath) !== path.resolve(newFullPath) && fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
  updateConfigSyncedVersion(options.workspaceRoot);

  return {
    success: true,
    alreadyPublished: false,
    id,
    filePath: newRelPath,
    ...(relPath !== newRelPath ? { previousFilePath: relPath } : {}),
    rev: finalRev,
    adminUrl,
  };
}

/**
 * Discards an unpublished remote draft revision on a published article and re-pulls the live version.
 * Enforces Guard G21 (draft-only articles forbidden) and local unpushed modification protection.
 */
export async function discardDraftArticle(
  target: string,
  options: DiscardDraftOptions,
): Promise<DiscardDraftResult> {
  const { id, relPath, fullPath, parsed } = resolveLifecycleTarget(
    options.workspaceRoot,
    options.cache,
    target,
  );
  const collection = parsed.frontmatter.collection || options.collection || 'posts';
  const syncState = options.cache.getSyncState(id);
  const rawContent = fs.readFileSync(fullPath, 'utf8');
  const adminUrl = articleAdminEndpoint(options.origin, collection, id);

  const isClean = isLocalFileUnmodified({
    workspaceRoot: options.workspaceRoot,
    cache: options.cache,
    id,
    relPath,
    localContent: rawContent,
    syncState,
  });

  if (!isClean && !options.force) {
    throw new ApiError({
      endpoint: `/_emdash/api/content/${collection}/${id}/discard-draft`,
      code: 'UNPUSHED_CHANGES_PROTECTION',
      status: 409,
      message: `Article ${id} (${relPath}) has unpushed local modifications.`,
      suggestion: `Push changes first or pass --force to quarantine local edits and discard the remote draft.`,
    });
  }

  const fetchFn = createAuthedFetch(options);
  const getRes = await fetchFn(articleContentEndpoint(options.origin, collection, id), {
    headers: { Authorization: `Bearer ${options.token}` },
  });
  if (!getRes.ok) {
    throw new ApiError({
      endpoint: `/_emdash/api/content/${collection}/${id}`,
      code: 'DISCARD_DRAFT_FAILED',
      status: getRes.status,
      message: `Failed to fetch remote article ${id} before discarding draft (${getRes.status}).`,
    });
  }

  const rawItem = unwrapItem<Record<string, unknown>>(await getRes.json());
  const revForTransport = extractRev(rawItem);

  // Guard G21: Only published articles can discard a staged draft
  if (rawItem.status !== 'published') {
    throw new ApiError({
      endpoint: `/_emdash/api/content/${collection}/${id}/discard-draft`,
      code: 'DRAFT_ONLY_DISCARD_FORBIDDEN',
      status: 400,
      message: `Article ${id} (${relPath}) has status "${String(rawItem.status)}" with no published live version.`,
      suggestion: `Use "emit delete ${relPath}" to delete a draft-only article.`,
    });
  }

  if (!rawItem.draftRevisionId) {
    return {
      success: true,
      noDraftPending: true,
      id,
      filePath: relPath,
      rev: revForTransport,
      adminUrl,
    };
  }

  let rescueFilePath: string | undefined;
  if (!isClean && options.force) {
    rescueFilePath =
      quarantineLocalCopy(options.workspaceRoot, collection, relPath, rawContent, {
        isForce: true,
      }) ?? undefined;
  }

  await acquireLock(collection, id, {
    origin: options.origin,
    token: options.token,
    fetchFn,
  });

  try {
    const discardRes = await fetchFn(articleDiscardDraftEndpoint(options.origin, collection, id), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ _rev: revForTransport }),
    });
    if (!discardRes.ok) {
      const errText = await discardRes.text();
      throw new ApiError({
        endpoint: `/_emdash/api/content/${collection}/${id}/discard-draft`,
        code: 'DISCARD_DRAFT_FAILED',
        status: discardRes.status,
        message: `Failed to discard remote draft for ${id}: ${errText || discardRes.statusText}`,
      });
    }
  } finally {
    await releaseLock(collection, id, {
      origin: options.origin,
      token: options.token,
      fetchFn,
    });
  }

  try {
    const pullRes = await pullArticle(collection, id, {
      workspaceRoot: options.workspaceRoot,
      cache: options.cache,
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      localMediaRefs: options.localMediaRefs,
      force: true,
      fetchFn,
    });
    return {
      success: true,
      noDraftPending: false,
      id,
      filePath: pullRes.filePath,
      ...(rescueFilePath ? { rescueFilePath } : {}),
      rev: options.cache.getSyncState(id)?.remoteRev ?? revForTransport,
      adminUrl,
    };
  } catch (pullErr: unknown) {
    const msg = pullErr instanceof Error ? pullErr.message : String(pullErr);
    throw new ApiError({
      endpoint: `/_emdash/api/content/${collection}/${id}`,
      code: 'DISCARD_DRAFT_FAILED',
      status: 500,
      message: `Remote draft for ${id} was discarded, but re-pulling the live version failed: ${msg}`,
      suggestion: `Remote draft is already discarded. Check network connectivity and run "emit pull ${id}" to sync your local file.`,
    });
  }
}
