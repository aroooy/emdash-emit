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
import { extractRev, unwrapItem } from '../../client/api.js';
import { ApiError } from '../../client/error.js';
import { createAuthedFetch } from '../../client/http.js';
import { withEntryLock } from '../../client/lock.js';
import { localToApiPayload } from '../../client/mapper.js';
import { parseMarkdown, type TaxonomyCandidates } from '../../utils/frontmatter.js';
import { syncRemoteBylines } from '../bylines.js';
import { loadLocalTaxonomyCandidates, loadLocalTaxonomyMaps } from '../taxonomies.js';
import {
  PushValidationError,
  assertNotQuarantinedCopy,
  checkDeletePendingGuard,
  checkTaxonomyApplyGuard,
  checkTaxonomyConflictGuard,
} from './guards.js';
import { executePreflightStage } from './preflight_stage.js';
import { canonicalizeFrontmatterTaxonomies, syncArticleTaxonomies } from './taxonomy_plan.js';
import { preserveOrResolveFeaturedImage, uploadAndRewriteDraftImages } from './media_stage.js';
import { auditRemoteTaxonomies } from './tax_audit.js';
import { resolveConflictAndMerge } from './merge_stage.js';
import { commitPostPush } from './commit.js';
import { throwRemoteArticleDeleted } from './transport.js';
import type {
  PushOptions,
  PushResult,
  ResolvedTaxonomyItem,
  TaxonomyResolutionStrategy,
} from './types.js';

export {
  PushValidationError,
  type PushOptions,
  type PushResult,
  type TaxonomyResolutionStrategy,
  type ResolvedTaxonomyItem,
};

/**
 * Pushes a local markdown article to remote EmDash with full preflight guards,
 * two-tier lock lease protection, and automatic 3-way merge on conflict.
 */
export async function pushArticle(
  targetFilePath: string,
  options: PushOptions,
): Promise<PushResult> {
  const fetchFn = createAuthedFetch(options);
  const fullPath = path.isAbsolute(targetFilePath)
    ? targetFilePath
    : path.join(options.workspaceRoot, targetFilePath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Target file not found: ${targetFilePath}`);
  }

  const originalRelPath = path.relative(options.workspaceRoot, fullPath);

  // Rescue copies under "<collection>/conflicts/" are deliberately unpushable.
  assertNotQuarantinedCopy(originalRelPath);

  const rawContent = fs.readFileSync(fullPath, 'utf8');
  const parsed = parseMarkdown(rawContent, targetFilePath);
  const id = parsed.frontmatter.id;
  const collection = parsed.frontmatter.collection;

  // Retrieve sync state and base snapshot
  const syncState = options.cache.getSyncState(id);
  const baseSnapshot = options.cache.getBaseSnapshot(id);

  // Pre-load local taxonomy maps once for canonicalization, G4 guard, and remote sync
  const taxonomyMaps = loadLocalTaxonomyMaps(options.workspaceRoot);

  // Canonicalize frontmatter taxonomy terms in-place before preflight and payload creation
  const { resolvedTaxonomies } = canonicalizeFrontmatterTaxonomies(parsed, taxonomyMaps);

  // Pre-build taxonomy candidates with slugToName for frontmatter serialization with inline '# <Name>' comments
  const candidates: TaxonomyCandidates =
    options.candidates || loadLocalTaxonomyCandidates(options.workspaceRoot);

  // If knownTaxonomies is not explicitly passed, populate from local categories/ and tags/ (if present)
  let knownTaxonomies = options.knownTaxonomies;
  if (!knownTaxonomies) {
    const knownCats = Object.keys(taxonomyMaps.slugToId.category);
    const knownTags = Object.keys(taxonomyMaps.slugToId.tag);
    if (knownCats.length > 0 || knownTags.length > 0) {
      knownTaxonomies = {
        ...(knownCats.length > 0 ? { categories: knownCats } : {}),
        ...(knownTags.length > 0 ? { tags: knownTags } : {}),
      };
    }
  }

  // 1. Guard against blind re-push when article is marked delete_pending (G15)
  checkDeletePendingGuard(syncState, options, collection, id, targetFilePath);

  // 2. Preflight Guards (including G6: UNRESOLVED_CONFLICT_MARKERS)
  const preflight = executePreflightStage(
    targetFilePath,
    parsed,
    options,
    syncState,
    baseSnapshot,
    knownTaxonomies,
  );

  // 3. Guard against blind re-push when taxonomy conflict is still pending (G16)
  checkTaxonomyConflictGuard(syncState, options, collection, id, targetFilePath);

  // 4. Guard against blind re-push when previous taxonomy update failed (G17)
  checkTaxonomyApplyGuard(syncState, options, collection, id, targetFilePath);

  const currentRev = syncState?.remoteRev || baseSnapshot?.rev || '';
  const warnings = [...preflight.warnings];

  // Load local bylines map for converting frontmatter byline slugs to ULIDs
  let bylineSlugToId = options.bylineSlugToId;
  if (!bylineSlugToId) {
    const cachedMaps = options.cache.getBylineMaps();
    if (Object.keys(cachedMaps.slugToId).length > 0) {
      bylineSlugToId = cachedMaps.slugToId;
    } else {
      const freshMaps = await syncRemoteBylines({
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        cache: options.cache,
        fetchFn: options.fetchFn,
      }).catch(() => ({ slugToId: {}, idToSlug: {} }));
      bylineSlugToId = freshMaps.slugToId;
    }
  }

  const effectiveOptions: PushOptions = {
    ...options,
    bylineSlugToId,
  };

  const isNewArticle = !syncState;

  if (isNewArticle) {
    // Upload/resolve standalone draft images and rewrite body
    const { body: rewrittenBody, uploadedByAbsPath } = await uploadAndRewriteDraftImages(
      parsed.body,
      preflight.draftImages,
      options,
      fetchFn,
    );
    parsed.body = rewrittenBody;

    const payload = localToApiPayload(parsed, '', effectiveOptions);
    warnings.push(
      ...preserveOrResolveFeaturedImage(
        payload,
        parsed.frontmatter.featuredImage,
        options.cache,
        id,
        options.workspaceRoot,
      ),
    );
    const postUrl = new URL(`/_emdash/api/content/${collection}`, options.origin).toString();

    const res = await fetchFn(postUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const slugConflictDetail = 'slug-conflict-detail';
      let remoteSlug: string | undefined;
      let conflictSignal: string | boolean = false;
      try {
        const parsedJson = JSON.parse(errBody) as {
          error?: { code?: string; message?: string; details?: { slug?: string } };
          code?: string;
          message?: string;
          details?: { slug?: string };
        };
        const errObj = parsedJson?.error || parsedJson;
        remoteSlug = errObj?.details?.slug;
        if (errObj?.code === 'SLUG_CONFLICT') {
          conflictSignal = true;
        } else if (remoteSlug !== undefined) {
          conflictSignal = slugConflictDetail;
        } else if (!errObj?.code && (res.status === 409 || res.status === 422)) {
          conflictSignal = /slug/i.test(errObj?.message || '');
        }
      } catch {
        conflictSignal =
          (res.status === 409 || res.status === 422 ? /slug/i.test(errBody) : false) ||
          /slug.*(?:already exists|conflict)|unique constraint.*slug/i.test(errBody);
      }

      const isSlugConflict = conflictSignal === true || conflictSignal === slugConflictDetail;
      const suggestion = isSlugConflict
        ? [
            `An article with slug "${remoteSlug || parsed.frontmatter.slug}" already exists on remote.`,
            'Change the "slug" field in frontmatter and re-run',
            `"emit push ${targetFilePath}" (Emit will automatically update the filename and cache).`,
            'Note: EmDash keeps slugs reserved for trashed entries too, so a slug freed by deletion may still be taken.',
          ].join(' ')
        : 'Check if an article with this slug already exists or if token has create permissions.';

      throw new ApiError({
        message: `Create push failed: ${res.statusText} - ${errBody}`,
        code: 'PUSH_CREATE_FAILED',
        status: res.status,
        endpoint: postUrl,
        suggestion,
      });
    }

    const createdJson = await res.json();
    const createdItem = unwrapItem<Record<string, unknown>>(createdJson);
    const actualId = String(createdItem.id || id);
    const newRev = extractRev(createdJson, '1');

    parsed.frontmatter.id = actualId;

    const taxFailures = await syncArticleTaxonomies({
      articleId: actualId,
      collection,
      parsed,
      taxonomyMaps,
      resolvedTaxonomies,
      baseSnapshot,
      options,
      fetchFn,
      warnings,
    });

    return await commitPostPush({
      mode: 'create',
      actualId,
      originalId: id,
      originalRelPath,
      fullPath,
      newRev,
      parsed,
      rawContent,
      draftImages: preflight.draftImages,
      uploadedByAbsPath,
      candidates,
      taxFailures,
      resolvedTaxonomies,
      options,
      fetchFn,
      warnings,
      createdItemCreatedAt: (createdItem.createdAt as string) || null,
    });
  }

  // Existing article: execute within full 7-minute entry lock lease
  return await withEntryLock(collection, id, options, async () => {
    const { body: rewrittenBody, uploadedByAbsPath } = await uploadAndRewriteDraftImages(
      parsed.body,
      preflight.draftImages,
      options,
      fetchFn,
    );
    parsed.body = rewrittenBody;

    let payload = localToApiPayload(parsed, currentRev, effectiveOptions);
    warnings.push(
      ...preserveOrResolveFeaturedImage(
        payload,
        parsed.frontmatter.featuredImage,
        options.cache,
        id,
        options.workspaceRoot,
      ),
    );
    const putUrl = new URL(`/_emdash/api/content/${collection}/${id}`, options.origin).toString();

    // Pre-PUT Taxonomy Audit
    const { remoteTaxAudit, taxonomyDivergenceDetected } = await auditRemoteTaxonomies({
      collection,
      id,
      parsed,
      syncState,
      baseSnapshot,
      options,
      fetchFn,
      warnings,
    });

    let res: Response | null = null;
    if (!taxonomyDivergenceDetected) {
      res = await fetchFn(putUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (res.status === 404 || res.status === 410) {
        throwRemoteArticleDeleted(collection, id, targetFilePath, putUrl);
      }
    }

    // Handle 409 Conflict or detected taxonomy divergence
    if (taxonomyDivergenceDetected || res?.status === 409) {
      const conflictOutcome = await resolveConflictAndMerge({
        collection,
        id,
        targetFilePath,
        fullPath,
        putUrl,
        res,
        taxonomyDivergenceDetected,
        parsed,
        syncState,
        baseSnapshot,
        remoteTaxAudit,
        candidates,
        options,
        fetchFn,
        warnings,
      });

      if (conflictOutcome.handled && conflictOutcome.pushResult) {
        return conflictOutcome.pushResult;
      }

      if (conflictOutcome.mergedParsed && conflictOutcome.remoteParsedRev) {
        parsed.frontmatter = conflictOutcome.mergedParsed.frontmatter;
        parsed.body = conflictOutcome.mergedParsed.body;
        payload = localToApiPayload(parsed, conflictOutcome.remoteParsedRev, effectiveOptions);
        warnings.push(
          ...preserveOrResolveFeaturedImage(
            payload,
            parsed.frontmatter.featuredImage,
            options.cache,
            id,
            options.workspaceRoot,
          ),
        );

        res = await fetchFn(putUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${options.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          if (res.status === 404 || res.status === 410) {
            throwRemoteArticleDeleted(collection, id, targetFilePath, putUrl);
          }

          const errText = await res.text().catch(() => '');
          const mergeResult = conflictOutcome.mergeResult;
          if (
            (res.status === 400 || res.status === 422) &&
            ((mergeResult?.autoMergedTaxonomies && mergeResult.autoMergedTaxonomies.length > 0) ||
              (mergeResult?.strategyAdoptions && mergeResult.strategyAdoptions.length > 0))
          ) {
            const wasStrategy =
              mergeResult.strategyAdoptions && mergeResult.strategyAdoptions.length > 0;
            throw new ApiError({
              message: `Remote server rejected the merged taxonomy union (HTTP ${res.status}): ${errText || res.statusText}`,
              code: 'TAXONOMY_UNION_REJECTED',
              status: res.status,
              endpoint: putUrl,
              suggestion: wasStrategy
                ? 'The remote server rejected the taxonomy adopted by your strategy (e.g. single-category constraint). Switch strategy with "--resolve-taxonomy=remote" or edit the frontmatter manually before pushing.'
                : 'The remote server enforces constraints that reject combining local and remote taxonomy terms (e.g. single-category constraint). Resolve by explicitly choosing a side: "emit push <file> --resolve-taxonomy=local" (or remote), or edit the frontmatter manually.',
            });
          }

          throw new ApiError({
            message: `Retry push after auto-merge failed: ${res.statusText}${errText ? ` - ${errText}` : ''}`,
            code: 'PUSH_RETRY_FAILED',
            status: res.status,
            endpoint: putUrl,
            suggestion:
              'Another change might have been committed in the meantime. Try pulling again.',
          });
        }
      }
    }

    if (!res || !res.ok) {
      if (res && (res.status === 404 || res.status === 410)) {
        throwRemoteArticleDeleted(collection, id, targetFilePath, putUrl);
      }
      const errText = res ? await res.text().catch(() => '') : '';
      throw new ApiError({
        message: `Push failed: ${res ? res.statusText : 'Request failed'}${errText ? ` - ${errText}` : ''}`,
        code: 'PUSH_FAILED',
        status: res ? res.status : 500,
        endpoint: putUrl,
        suggestion: 'Verify network connectivity, token permissions, and article status.',
      });
    }

    const updatedJson = await res.json().catch(() => ({}));
    const newRev = extractRev(updatedJson, currentRev);

    const taxFailures = await syncArticleTaxonomies({
      articleId: id,
      collection,
      parsed,
      taxonomyMaps,
      resolvedTaxonomies,
      baseSnapshot,
      options,
      fetchFn,
      warnings,
    });

    return await commitPostPush({
      mode: 'update',
      actualId: id,
      originalId: id,
      originalRelPath,
      fullPath,
      newRev,
      parsed,
      rawContent,
      draftImages: preflight.draftImages,
      uploadedByAbsPath,
      candidates,
      taxFailures,
      resolvedTaxonomies,
      options,
      fetchFn,
      warnings,
      syncState,
      baseSnapshot,
    });
  });
}
