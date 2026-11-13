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
import { ApiError } from '../../client/error.js';
import type { UploadMediaResult } from '../../client/media.js';
import { createBaseSnapshot, readBaselineFrontmatter } from '../../db/baseline.js';
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
import { updateConfigSyncedVersion } from '../../utils/config.js';
import { computeTaxonomyHash } from '../terms.js';
import { calculateHash } from '../workspace/index.js';
import type { DraftImageReference } from '../preflight.js';
import { finalizePromotedDraftImages } from './media_stage.js';
import { transitionContentStatus } from './transport.js';
import type { PushOptions, PushResult, ResolvedTaxonomyItem } from './types.js';
import type { TaxonomySyncFailure } from './taxonomy_plan.js';

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

  const serializedCanonical = serializeMarkdown(parsed.frontmatter, parsed.body, candidates);

  // [P6] Promote uploaded draft images from media/drafts/ into media/ and commit media_state.
  finalizePromotedDraftImages(draftImages, uploadedByAbsPath, options, warnings);

  const serializedContent = options.localMediaRefs
    ? localizeArticleMediaRefs(serializedCanonical, {
        workspaceRoot: options.workspaceRoot,
        articleRelPath: newRelPath,
        fs,
        preferLegacyRef: carriesDepthFreeMediaRef(rawContent),
      })
    : serializedCanonical;
  const newHash = calculateHash(serializedContent);

  // Transition status to published / draft if requested
  let finalRev = newRev;
  if (mode === 'create') {
    if (parsed.frontmatter.status === 'published' && options.allowPublish) {
      finalRev = await transitionContentStatus(
        collection,
        actualId,
        'published',
        newRev,
        parsed.frontmatter.publishedAt,
        options,
        fetchFn,
      );
    }
  } else {
    const previousStatus = syncState?.status || 'draft';
    if (parsed.frontmatter.status === 'published' && options.allowPublish) {
      finalRev = await transitionContentStatus(
        collection,
        actualId,
        'published',
        newRev,
        parsed.frontmatter.publishedAt,
        options,
        fetchFn,
      );
    } else if (parsed.frontmatter.status === 'draft' && previousStatus === 'published') {
      finalRev = await transitionContentStatus(
        collection,
        actualId,
        'draft',
        newRev,
        null,
        options,
        fetchFn,
      );
    }
  }

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

  // Update Base snapshot
  const savedFrontmatter: Frontmatter = { ...parsed.frontmatter };
  if (mode === 'update' && hasTaxFailures && baseFm?.taxonomies) {
    savedFrontmatter.taxonomies = { ...baseFm.taxonomies };
  }

  const finalTaxHash = hasTaxFailures
    ? mode === 'create'
      ? null
      : syncState?.remoteTaxonomyHash ||
        (baseFm?.taxonomies
          ? computeTaxonomyHash(baseFm.taxonomies.categories, baseFm.taxonomies.tags)
          : null)
    : computeTaxonomyHash(
        parsed.frontmatter.taxonomies?.categories,
        parsed.frontmatter.taxonomies?.tags,
      );

  options.cache.saveBaseSnapshot(
    createBaseSnapshot({
      id: actualId,
      rev: finalRev,
      bodyMarkdown: parsed.body,
      frontmatter: savedFrontmatter,
      hash: newHash,
    }),
  );

  // Update sync state
  if (mode === 'create') {
    options.cache.saveSyncState({
      id: actualId,
      localFilePath: newRelPath,
      localHash: newHash,
      remoteRev: finalRev,
      status: parsed.frontmatter.status,
      slug: parsed.frontmatter.slug,
      lastSyncedAt: Math.floor(Date.now() / 1000),
      conflictPending: 0,
      bodyConflictPending: 0,
      taxonomyConflictPending: 0,
      conflictCopyHash: null,
      conflictCopyPath: null,
      conflictAt: null,
      remoteTaxonomyHash: finalTaxHash,
      taxonomyApplyPending: hasTaxFailures ? 1 : 0,
    });
  } else {
    options.cache.saveSyncState({
      id: actualId,
      localFilePath: newRelPath,
      localHash: newHash,
      remoteRev: finalRev,
      status: parsed.frontmatter.status,
      slug: parsed.frontmatter.slug,
      lastSyncedAt: Math.floor(Date.now() / 1000),
      conflictPending: hasTaxFailures ? (syncState?.conflictPending ?? 0) : 0,
      bodyConflictPending: hasTaxFailures ? (syncState?.bodyConflictPending ?? 0) : 0,
      taxonomyConflictPending: hasTaxFailures ? (syncState?.taxonomyConflictPending ?? 0) : 0,
      conflictCopyHash: hasTaxFailures ? syncState?.conflictCopyHash : null,
      conflictCopyPath: hasTaxFailures ? syncState?.conflictCopyPath : null,
      conflictAt: hasTaxFailures ? syncState?.conflictAt : null,
      remoteTaxonomyHash: finalTaxHash,
      taxonomyApplyPending: hasTaxFailures ? 1 : 0,
    });
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
    warnings,
  };
}
