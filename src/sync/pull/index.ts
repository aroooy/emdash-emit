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
import type { SyncState } from '../../db/cache.js';
import { apiResponseToLocal } from '../../client/mapper.js';
import { ApiError } from '../../client/error.js';
import { createAuthedFetch } from '../../client/http.js';
import { extractRev, extractComparisonRev, isSameRev } from '../../client/api.js';
import { articleContentEndpoint } from '../../client/endpoints.js';
import {
  extractDatePrefixFromPath,
  serializeMarkdown,
  type TaxonomyCandidates,
} from '../../utils/frontmatter.js';
import { hasUncommittedDraftRevision } from '../../utils/draft-revision.js';
import {
  localizeArticleMediaRefs,
  carriesDepthFreeMediaRef,
  shouldPreferLegacyRef,
} from '../../utils/media-body-refs.js';
import {
  CONFLICTS_SUBDIR,
  calculateHash,
  commitArticleSnapshot,
  findLocalFilesByUlid,
  isQuarantinedRelativePath,
  quarantineLocalCopy,
  resolveCanonicalArticlePath,
} from '../workspace/index.js';
import { loadLocalTaxonomyCandidates } from '../taxonomies.js';
import { syncRemoteBylines, extractRemoteBylineIds } from '../bylines.js';
import { updateConfigSyncedVersion } from '../../utils/config.js';
import { fetchAssignedTerms as fetchAssignedTermsShared, computeTaxonomyHash } from '../terms.js';
import { extractCanonicalRemoteTitle, getRemoteMaxBatchLimit, listRemoteArticles } from './list.js';
import {
  formatQuarantineNotice,
  handleRemoteDeletedArticle,
  quarantineDivergentLocalCopies,
} from './quarantine.js';
import { tryFastPathOrHeal } from './fast_path.js';
import { mirrorArticleReferencedMedia, createMediaMirrorSession } from './media_stage.js';
import type {
  FastPathContext,
  ListRemoteArticlesOptions,
  MediaMirrorSession,
  PullArticleMediaSummary,
  PullOptions,
  PullResult,
  QuarantinedLocalCopy,
  RemoteArticleItem,
} from './types.js';

export {
  CONFLICTS_SUBDIR,
  calculateHash,
  findLocalFilesByUlid,
  isQuarantinedRelativePath,
  quarantineLocalCopy,
  resolveCanonicalArticlePath,
  carriesDepthFreeMediaRef,
  shouldPreferLegacyRef,
  extractCanonicalRemoteTitle,
  getRemoteMaxBatchLimit,
  listRemoteArticles,
  formatQuarantineNotice,
  mirrorArticleReferencedMedia,
  createMediaMirrorSession,
};

export type {
  FastPathContext,
  ListRemoteArticlesOptions,
  MediaMirrorSession,
  PullArticleMediaSummary,
  PullOptions,
  PullResult,
  QuarantinedLocalCopy,
  RemoteArticleItem,
};

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
    const remoteBylineIds = rawItem ? extractRemoteBylineIds(rawItem) : [];
    const hasUnknownByline =
      Object.keys(cachedMaps.idToSlug).length === 0 ||
      remoteBylineIds.some((ref) => !cachedMaps.idToSlug[ref] && !cachedMaps.slugToId[ref]);
    if (!hasUnknownByline) {
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

  /** The path a tracked article currently sits at, used when the caller has not resolved a new one yet. */
  const existingFilePathForDepth = (): string => {
    const tracked = options.cache.getSyncState(id)?.localFilePath;
    if (tracked) return tracked;
    const onDisk = findLocalFilesByUlid(options.workspaceRoot, collection, id)[0];
    return onDisk ?? `${collection}/draft/${id}.md`;
  };

  /**
   * Applies the workspace's local-media-ref spelling to a serialized document. `sync_state.local_hash` always
   * records the exact bytes on disk, so every comparison against a tracked file must run through this same
   * transform: reconstructing the canonical form from a remote response and then localizing it keeps the
   * fast-path skip honest whether or not `localMediaRefs` is enabled.
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

  const fastPathCtx: FastPathContext = {
    collection,
    id,
    options,
    fetchAssignedTerms,
    getBylineIdToSlug,
    getTaxonomyCandidates,
    localizeDiskMarkdown,
  };

  // 1. Fast-path check: If rawItem is provided in options, test fast-path / heal
  if (rawItem) {
    const fastResult = await tryFastPathOrHeal(fastPathCtx, rawItem);
    if (fastResult) {
      updateConfigSyncedVersion(options.workspaceRoot);
      return fastResult;
    }

    // Fast-path missed: remote content changed or local repair required.
    // EmDash list API returns stale creation-time posts.data for drafts, and liveData for published articles.
    // When a published article has unpublished draft changes (draftRevisionId exists), list API does NOT expand
    // the draft body (it returns only liveData).
    // Therefore, if this is an existing tracked article whose remote draft revision has advanced, we must discard
    // the stale list rawItem so Step 2 fetches the full canonical item via single GET!
    const rawObj = rawItem as Record<string, unknown>;
    const hasDraftRevision = Boolean(rawObj.draftRevisionId);
    const isDraft = String(rawObj.status || 'draft') !== 'published';
    const needsFullDraftFetch = isDraft || hasDraftRevision;

    const existingSync = options.cache.getSyncState(id);
    const rawRevCandidate = String(
      rawItem._rev || rawItem.rev || rawItem.version || rawObj._rev || '',
    );
    const remoteRev = extractRev(rawObj, rawRevCandidate);
    const remoteComparisonRev = extractComparisonRev(rawObj, remoteRev);
    const remoteChanged = !existingSync || !isSameRev(existingSync.remoteRev, remoteComparisonRev);

    if (needsFullDraftFetch && existingSync && remoteChanged) {
      rawItem = undefined;
    }
  }

  // 2. Fetch raw item if not passed in options (or discarded above for draft updates)
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
        const deletedResult = handleRemoteDeletedArticle(
          collection,
          id,
          options,
          getTaxonomyCandidates(),
        );
        if (deletedResult) return deletedResult;
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
    const singleHealResult = await tryFastPathOrHeal(fastPathCtx, rawItem);
    if (singleHealResult) {
      updateConfigSyncedVersion(options.workspaceRoot);
      return singleHealResult;
    }
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
  // references when `localMediaRefs` is enabled.
  const comparisonRev = extractComparisonRev(rawItem, rev);
  const hasDraft = hasUncommittedDraftRevision({
    status: frontmatter.status,
    remoteRev: comparisonRev,
  });
  const canonicalMarkdown = serializeMarkdown(frontmatter, body, getTaxonomyCandidates(), {
    hasDraftRevision: hasDraft,
  });

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

  let mediaSummary: PullArticleMediaSummary | undefined = undefined;
  if (options.mediaSync !== false) {
    mediaSummary = await mirrorArticleReferencedMedia(
      options,
      canonicalMarkdown,
      frontmatter.featuredImage,
    );
  }

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
    existingSync,
    getTaxonomyCandidates(),
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

  // Update sync state with explicit conflict pending preservation
  let conflictInfo: Partial<SyncState> = {};
  const divergedQuarantines = !options.force
    ? (quarantined ?? []).filter((q) => q.reason === 'diverged-from-baseline')
    : [];
  const divergedQuarantine = divergedQuarantines[divergedQuarantines.length - 1];

  if (divergedQuarantine) {
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

  // Commit canonical Markdown and sync state via commitArticleSnapshot
  commitArticleSnapshot(options.cache, options.workspaceRoot, {
    id: frontmatter.id,
    relPath,
    diskContent: markdownContent,
    canonicalContent: canonicalMarkdown,
    frontmatter,
    bodyMarkdown: body,
    revForTransport: rev,
    revForComparison: comparisonRev,
    flags: {
      remoteTaxonomyHash: computeTaxonomyHash(
        frontmatter.taxonomies?.categories,
        frontmatter.taxonomies?.tags,
      ),
      taxonomyApplyPending: 0,
      ...conflictInfo,
    },
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
    media: mediaSummary,
  };
}
