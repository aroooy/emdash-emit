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

import { ApiError } from '../../client/error.js';
import type { SyncState } from '../../db/cache.js';
import { CONFLICTS_SUBDIR, isQuarantinedRelativePath } from '../workspace/index.js';
import type { PreflightError } from '../preflight.js';
import type { PushOptions } from './types.js';

export class PushValidationError extends Error {
  public errors: PreflightError[];

  constructor(message: string, errors: PreflightError[]) {
    super(message);
    this.name = 'PushValidationError';
    this.errors = errors;
  }
}

/**
 * Validates that the target file is not a quarantined rescue copy.
 */
export function assertNotQuarantinedCopy(originalRelPath: string): void {
  if (isQuarantinedRelativePath(originalRelPath)) {
    throw new PushValidationError(`Refusing to push a preserved rescue copy: ${originalRelPath}`, [
      {
        code: 'QUARANTINED_COPY_NOT_PUSHABLE',
        message:
          `'${originalRelPath}' is a preserved rescue copy under "${CONFLICTS_SUBDIR}/". ` +
          'Rescue copies hold stale divergent content captured before a pull overwrote it; ' +
          'pushing one would overwrite the canonical article of the same ULID and recreate duplicate local files.',
        suggestion:
          'Merge the valuable lines into the canonical article file (posts/draft/... or posts/published/...), then delete this copy. ' +
          'To intentionally replace the remote version, copy the rescue file over the canonical path and push that canonical path instead.',
      },
    ]);
  }
}

/**
 * Guard G15: deletePending protection.
 */
export function checkDeletePendingGuard(
  syncState: SyncState | null | undefined,
  options: PushOptions,
  collection: string,
  id: string,
  targetFilePath: string,
): void {
  if (syncState?.deletePending === 1 && !options.revive && !options.force) {
    throw new ApiError({
      endpoint: `/_emdash/api/content/${collection}/${id}`,
      code: 'DELETE_PENDING_ARTICLE',
      status: 409,
      message: `Article ${id} (${targetFilePath}) is marked as delete-pending (previous remote deletion was unconfirmed).`,
      suggestion: `To intentionally revive and push this article to remote, pass --revive (or --force): "emit push ${targetFilePath} --revive"`,
    });
  }
}

/**
 * Guard G16: taxonomy conflict pending protection.
 */
export function checkTaxonomyConflictGuard(
  syncState: SyncState | null | undefined,
  options: PushOptions,
  collection: string,
  id: string,
  targetFilePath: string,
): void {
  const isTaxConflictPending =
    syncState?.taxonomyConflictPending !== undefined
      ? syncState.taxonomyConflictPending === 1
      : syncState?.conflictPending === 1 && (syncState?.bodyConflictPending ?? 0) === 0;

  if (isTaxConflictPending && !options.resolveTaxonomy && !options.force) {
    throw new ApiError({
      endpoint: `/_emdash/api/content/${collection}/${id}`,
      code: 'TAXONOMY_CONFLICT_PENDING',
      status: 409,
      message: `Article ${id} (${targetFilePath}) has an unresolved taxonomy conflict from a previous sync.`,
      suggestion: `Pass --resolve-taxonomy=union|local|remote (or --force) to explicitly resolve and confirm: "emit push ${targetFilePath} --resolve-taxonomy=union"`,
    });
  }
}

/**
 * Guard G17: taxonomy apply pending protection.
 */
export function checkTaxonomyApplyGuard(
  syncState: SyncState | null | undefined,
  options: PushOptions,
  collection: string,
  id: string,
  targetFilePath: string,
): void {
  if (
    syncState?.taxonomyApplyPending === 1 &&
    !options.allowUnappliedTaxonomies &&
    !options.force
  ) {
    throw new ApiError({
      endpoint: `/_emdash/api/content/${collection}/${id}`,
      code: 'TAXONOMY_APPLY_PENDING',
      status: 409,
      message: `Article ${id} (${targetFilePath}) has an unconfirmed taxonomy assignment from a previous failed update.`,
      suggestion: `Run "emit pull-taxonomies" to synchronize taxonomy definitions, then re-push (or pass --allow-unapplied-taxonomies / --force).`,
    });
  }
}

/**
 * Declarative pipeline: evaluates pre-preflight guards (G15).
 */
export function evaluatePrePreflightGuards(
  syncState: SyncState | null | undefined,
  options: PushOptions,
  collection: string,
  id: string,
  targetFilePath: string,
): void {
  checkDeletePendingGuard(syncState, options, collection, id, targetFilePath);
}

/**
 * Declarative pipeline: evaluates post-preflight guards (G16, G17).
 * T2-1 invariant: preflight (including G6 conflict markers) MUST precede G16.
 */
export function evaluatePostPreflightGuards(
  syncState: SyncState | null | undefined,
  options: PushOptions,
  collection: string,
  id: string,
  targetFilePath: string,
): void {
  checkTaxonomyConflictGuard(syncState, options, collection, id, targetFilePath);
  checkTaxonomyApplyGuard(syncState, options, collection, id, targetFilePath);
}
