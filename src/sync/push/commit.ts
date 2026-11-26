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
import { extractComparisonRev } from '../../client/api.js';
import { articleAdminEndpoint } from '../../client/endpoints.js';
import { ApiError } from '../../client/error.js';
import type { UploadMediaResult } from '../../client/media.js';
import { readBaselineFrontmatter } from '../../db/baseline.js';
import type { BaseSnapshot, SyncState } from '../../db/cache.js';
import {
  computeArticleRelativePath,
  extractDatePrefixFromPath,
  serializeMarkdown,
  type Frontmatter,
  type ParsedMarkdown,
  type TaxonomyCandidates,
} from '../../utils/frontmatter.js';
import { carriesDepthFreeMediaRef, localizeArticleMediaRefs } from '../../utils/media-body-refs.js';
import { hasUncommittedDraftRevision } from '../../utils/draft-revision.js';
import { updateConfigSyncedVersion } from '../../utils/config.js';
import { computeTaxonomyHash } from '../terms.js';
import { commitArticleSnapshot } from '../workspace/index.js';
import type { DraftImageReference } from '../preflight.js';
import { finalizePromotedDraftImages } from './media_stage.js';
import { transitionContentStatus } from './transport.js';
import type { PushOptions, PushResult, ResolvedTaxonomyItem } from './types.js';
import type { TaxonomySyncFailure } from './taxonomy_plan.js';

export interface PendingFlagsResult {
  conflictPending: number;
  bodyConflictPending: number;
  taxonomyConflictPending: number;
  conflictCopyHash: string | null;
  conflictCopyPath: string | null;
  conflictAt: number | null;
  taxonomyApplyPending: number;
  remoteTaxonomyHash: string | null;
}

/**
 * Computes sync state pending flags and conflict/taxonomy hashes symmetrically.
 */
export function pendingFlagsFor(params: {
  mode: 'create' | 'update' | 'conflict';
  syncState?: SyncState | null;
  hasTaxFailures?: boolean;
  hasBodyConflict?: boolean;
  isTaxonomyConflict?: boolean;
  conflictedHash?: string | null;
  quarantineRelPath?: string | null;
  remoteTaxonomyHash?: string | null;
}): PendingFlagsResult {
  const {
    mode,
    syncState,
    hasTaxFailures,
    hasBodyConflict,
    isTaxonomyConflict,
    conflictedHash,
    quarantineRelPath,
    remoteTaxonomyHash,
  } = params;

  if (mode === 'create') {
    return {
      conflictPending: 0,
      bodyConflictPending: 0,
      taxonomyConflictPending: 0,
      conflictCopyHash: null,
      conflictCopyPath: null,
      conflictAt: null,
      taxonomyApplyPending: hasTaxFailures ? 1 : 0,
      remoteTaxonomyHash: hasTaxFailures ? null : (remoteTaxonomyHash ?? null),
    };
  }

  if (mode === 'conflict') {
    const isTax = isTaxonomyConflict ? 1 : 0;
    const isBody = hasBodyConflict ? 1 : 0;
    const hasAnyConflict = isTax === 1 || isBody === 1;
    return {
      conflictPending: 1,
      bodyConflictPending: isBody,
      taxonomyConflictPending: isTax,
      conflictCopyHash: hasAnyConflict ? (conflictedHash ?? null) : null,
      conflictCopyPath: hasAnyConflict ? (quarantineRelPath ?? null) : null,
      conflictAt: hasAnyConflict && quarantineRelPath ? Math.floor(Date.now() / 1000) : null,
      taxonomyApplyPending: 0,
      remoteTaxonomyHash: remoteTaxonomyHash ?? null,
    };
  }

  // update mode
  if (hasTaxFailures) {
    return {
      conflictPending: syncState?.conflictPending ?? 0,
      bodyConflictPending: syncState?.bodyConflictPending ?? 0,
      taxonomyConflictPending: syncState?.taxonomyConflictPending ?? 0,
      conflictCopyHash: syncState?.conflictCopyHash ?? null,
      conflictCopyPath: syncState?.conflictCopyPath ?? null,
      conflictAt: syncState?.conflictAt ?? null,
      taxonomyApplyPending: 1,
      remoteTaxonomyHash: remoteTaxonomyHash ?? null,
    };
  }

  return {
    conflictPending: 0,
    bodyConflictPending: 0,
    taxonomyConflictPending: 0,
    conflictCopyHash: null,
    conflictCopyPath: null,
    conflictAt: null,
    taxonomyApplyPending: 0,
    remoteTaxonomyHash: remoteTaxonomyHash ?? null,
  };
}

export interface CommitPostPushParams {
  mode: 'create' | 'update';
  actualId: string;
  originalId: string;
  originalRelPath: string;
  fullPath: string;
  newRev: string;
  parsed: ParsedMarkdown;
  rawContent: string;
  draftImages: DraftImageReference[];
  uploadedByAbsPath: Map<string, UploadMediaResult>;
  candidates: TaxonomyCandidates;
  taxFailures: TaxonomySyncFailure[];
  resolvedTaxonomies: {
    categories?: ResolvedTaxonomyItem[];
    tags?: ResolvedTaxonomyItem[];
    [taxonomy: string]: ResolvedTaxonomyItem[] | undefined;
  };
  options: PushOptions;
  fetchFn: typeof fetch;
  warnings: string[];
  syncState?: SyncState | null;
  baseSnapshot?: BaseSnapshot | null;
  createdItemCreatedAt?: string | null;
  updatedRawItem?: unknown;
}

/**
 * Commits article push results: promotes draft media, serializes local markdown,
 * transitions status if needed, updates base snapshots and sync state, and handles file moving.
 */
export async function commitPostPush(params: CommitPostPushParams): Promise<PushResult> {
  const {
    mode,
    actualId,
    originalId,
    originalRelPath,
    fullPath,
    newRev,
    parsed,
    rawContent,
    draftImages,
    uploadedByAbsPath,
    candidates,
    taxFailures,
    resolvedTaxonomies,
    options,
    fetchFn,
    warnings,
    syncState,
    baseSnapshot,
    createdItemCreatedAt,
  } = params;

  const hasTaxFailures = taxFailures.length > 0;
  const collection = parsed.frontmatter.collection;

  const currentPrefix = extractDatePrefixFromPath(fullPath);
  let dateInput: string | Date | null = null;
  if (mode === 'create') {
    dateInput = parsed.frontmatter.publishedAt || currentPrefix || createdItemCreatedAt || null;
  } else {
    const existingSync = options.cache.getSyncState(parsed.frontmatter.id);
    dateInput =
      parsed.frontmatter.publishedAt ||
      currentPrefix ||
      (existingSync?.lastSyncedAt ? new Date(existingSync.lastSyncedAt * 1000) : null);
  }

  const newRelPath = computeArticleRelativePath(
    parsed.frontmatter.collection,
    parsed.frontmatter.status,
    actualId,
    parsed.frontmatter.title || parsed.frontmatter.slug,
    dateInput,
  );
  const newFullPath = path.join(options.workspaceRoot, newRelPath);

  // [P6] Promote uploaded draft images from media/drafts/ into media/ and commit media_state.
  finalizePromotedDraftImages(draftImages, uploadedByAbsPath, options, warnings);

  // Transition status to published / draft if requested
  let finalRev = newRev;
  let finalRawItem = params.updatedRawItem;
  const hadRemoteDraft =
    mode !== 'create' && Boolean(syncState?.remoteRev && syncState.remoteRev.includes('@draft:'));

  if (mode === 'create') {
    if (parsed.frontmatter.status === 'published' && options.allowPublish) {
      const transitionRes = await transitionContentStatus(
        collection,
        actualId,
        'published',
        newRev,
        parsed.frontmatter.publishedAt,
        options,
        fetchFn,
      );
      finalRev = transitionRes.rev;
      finalRawItem = transitionRes.rawJson ?? finalRawItem;
    }
  } else {
    const previousStatus = syncState?.status || 'draft';

    if (parsed.frontmatter.status === 'published' && options.allowPublish) {
      const transitionRes = await transitionContentStatus(
        collection,
        actualId,
        'published',
        newRev,
        parsed.frontmatter.publishedAt,
        options,
        fetchFn,
      );
      finalRev = transitionRes.rev;
      finalRawItem = transitionRes.rawJson ?? finalRawItem;
      if (hadRemoteDraft) {
        warnings.push(
          'Published article with uncommitted remote draft was published live to the web (--allow-publish).',
        );
      }
    } else if (parsed.frontmatter.status === 'draft' && previousStatus === 'published') {
      const transitionRes = await transitionContentStatus(
        collection,
        actualId,
        'draft',
        newRev,
        null,
        options,
        fetchFn,
      );
      finalRev = transitionRes.rev;
      finalRawItem = transitionRes.rawJson ?? finalRawItem;
    }
  }

  // Track 2 (Comparison Key): Save composite comparison key in sync_state for reliable fast-path change detection
  const comparisonRev = extractComparisonRev(
    finalRawItem ?? { version: finalRev, status: parsed.frontmatter.status },
    finalRev,
  );
  const hasDraft = hasUncommittedDraftRevision({
    status: parsed.frontmatter.status,
    remoteRev: comparisonRev,
  });

  if (parsed.frontmatter.status === 'published' && !options.allowPublish && hasDraft) {
    warnings.push(
      'Changes were staged as a draft on EmDash (live version unchanged). Use --allow-publish to publish live.',
    );
    if (hadRemoteDraft) {
      warnings.push(
        'Existing uncommitted remote draft was overwritten by this push (previous draft revision replaced).',
      );
    }
  }

  const serializedCanonical = serializeMarkdown(parsed.frontmatter, parsed.body, candidates, {
    hasDraftRevision: hasDraft,
  });

  const serializedContent = options.localMediaRefs
    ? localizeArticleMediaRefs(serializedCanonical, {
        workspaceRoot: options.workspaceRoot,
        articleRelPath: newRelPath,
        fs,
        preferLegacyRef: carriesDepthFreeMediaRef(rawContent),
      })
    : serializedCanonical;

  // File write & cleanup
  if (mode === 'create') {
    fs.mkdirSync(path.dirname(newFullPath), { recursive: true });
    fs.writeFileSync(newFullPath, serializedContent, 'utf8');

    if (fullPath !== newFullPath && fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
      } catch (unlinkErr: unknown) {
        warnings.push(
          `Failed to remove provisional file at ${fullPath}: ${(unlinkErr as Error).message}.`,
        );
      }
    }
  } else {
    if (fullPath !== newFullPath) {
      fs.mkdirSync(path.dirname(newFullPath), { recursive: true });
      fs.writeFileSync(newFullPath, serializedContent, 'utf8');
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
        } catch (unlinkErr: unknown) {
          warnings.push(
            `Failed to remove old file at ${fullPath} after path transition: ${(unlinkErr as Error).message}. Please remove it manually to prevent duplicates.`,
          );
        }
      }
    } else {
      fs.writeFileSync(fullPath, serializedContent, 'utf8');
    }
  }

  const baseFm = readBaselineFrontmatter(baseSnapshot);

  // Update Base snapshot:
  // Invariant (Layer A & B Separation):
  // - Disk (Layer B): `serializeMarkdown(parsed.frontmatter, parsed.body, candidates)` outputs decoded
  //   taxonomy terms (e.g. `    - 未分類`) to workspace markdown files.
  // - Snapshot (Layer A): `savedFrontmatter` stored in `base_snapshots.frontmatter_yaml` strictly retains
  //   canonical slugs (e.g. `["%e6%9c%aa%e5%88%86%e9%a1%9e"]`).
  // Because `canonicalizeFrontmatterTaxonomies` already canonicalized `parsed.frontmatter.taxonomies`
  // in-place prior to payload creation and preflight, `parsed.frontmatter.taxonomies` holds canonical slugs.
  const savedFrontmatter: Frontmatter = { ...parsed.frontmatter };
  if (mode === 'update' && hasTaxFailures && baseFm?.taxonomies) {
    savedFrontmatter.taxonomies = { ...baseFm.taxonomies };
  }

  const calculatedTaxHash = computeTaxonomyHash(
    parsed.frontmatter.taxonomies?.categories,
    parsed.frontmatter.taxonomies?.tags,
  );

  const fallbackTaxHash =
    mode === 'update'
      ? syncState?.remoteTaxonomyHash ||
        (baseFm?.taxonomies
          ? computeTaxonomyHash(baseFm.taxonomies.categories, baseFm.taxonomies.tags)
          : null)
      : null;

  const targetRemoteTaxHash = hasTaxFailures ? fallbackTaxHash : calculatedTaxHash;

  const flags = pendingFlagsFor({
    mode,
    syncState,
    hasTaxFailures,
    remoteTaxonomyHash: targetRemoteTaxHash,
  });

  commitArticleSnapshot(options.cache, options.workspaceRoot, {
    id: actualId,
    relPath: newRelPath,
    diskContent: serializedContent,
    canonicalContent: serializedCanonical,
    frontmatter: savedFrontmatter,
    bodyMarkdown: parsed.body,
    revForTransport: finalRev,
    revForComparison: comparisonRev,
    flags,
    skipDiskWrite: true,
  });

  if (mode === 'update') {
    updateConfigSyncedVersion(options.workspaceRoot);
  }

  if (hasTaxFailures) {
    throw new ApiError({
      endpoint: taxFailures[0].endpoint,
      code: 'TAXONOMY_UPDATE_FAILED',
      status: taxFailures[0].status || 400,
      message: `Failed to update ${taxFailures.map((f) => f.taxonomy).join(', ')} terms on remote: ${taxFailures.map((f) => f.error).join('; ')}`,
      suggestion:
        'Run "emit pull-taxonomies" to update local definitions, verify taxonomy permissions, and retry push.',
    });
  }

  return {
    success: true,
    id: actualId,
    rev: finalRev,
    filePath: newRelPath,
    ...(actualId !== originalId ? { previousId: originalId } : {}),
    ...(originalRelPath !== newRelPath ? { previousFilePath: originalRelPath } : {}),
    ...(Object.keys(resolvedTaxonomies).length > 0 ? { resolvedTaxonomies } : {}),
    conflict: false,
    hasDraftRevision: hasDraft,
    adminUrl: articleAdminEndpoint(options.origin, collection, actualId),
    warnings,
  };
}
