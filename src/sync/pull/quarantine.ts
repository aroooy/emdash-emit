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
import type { TaxonomyCandidates } from '../../utils/frontmatter.js';
import { isLocalFileUnmodified } from '../baseline-reconstruction.js';
import { CONFLICTS_SUBDIR, calculateHash, quarantineLocalCopy } from '../workspace/index.js';
import type { PullOptions, PullResult, QuarantinedLocalCopy } from './types.js';

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

/**
 * Discovers local files for this article that are about to be overwritten or unlinked, and
 * preserves every copy whose content does not match the last synced baseline hash (or its
 * reconstructed disk-spelling baseline) or the content Emit is about to write.
 */
export function quarantineDivergentLocalCopies(
  options: PullOptions,
  collection: string,
  localRelPaths: Set<string>,
  baselineHash: string | undefined,
  canonicalContent: string,
  existingCopyHash?: string | null,
  existingSync?: SyncState | null,
  candidates?: TaxonomyCandidates,
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
    // Identical to the last synced state (raw hash or reconstructed disk spelling): carries no information worth preserving.
    if (
      (baselineHash && calculateHash(localContent) === baselineHash) ||
      (existingSync &&
        isLocalFileUnmodified({
          workspaceRoot: options.workspaceRoot,
          cache: options.cache,
          id: existingSync.id,
          relPath: localRel,
          localContent,
          syncState: existingSync,
          candidates,
          healOnSpellingMatch: false,
        }))
    ) {
      continue;
    }

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
 * Handles remote 404/410 article deletion during pull:
 * - Unlinks local file and deletes cache entry if the local file is unmodified.
 * - Quarantines local edits and unlinks if `force: true`.
 * - Preserves local edits as `orphan: true` otherwise.
 */
export function handleRemoteDeletedArticle(
  collection: string,
  id: string,
  options: PullOptions,
  candidates?: TaxonomyCandidates,
): PullResult | null {
  const existingSync = options.cache.getSyncState(id);
  if (!existingSync) return null;

  const fullPath = path.join(options.workspaceRoot, existingSync.localFilePath);
  if (!fs.existsSync(fullPath)) return null;

  const diskContent = fs.readFileSync(fullPath, 'utf8');
  const isUnmodified =
    calculateHash(diskContent) === existingSync.localHash ||
    isLocalFileUnmodified({
      workspaceRoot: options.workspaceRoot,
      cache: options.cache,
      id,
      relPath: existingSync.localFilePath,
      localContent: diskContent,
      syncState: existingSync,
      candidates,
      healOnSpellingMatch: false,
    });

  // Only delete if local file has no unpushed edits
  if (isUnmodified) {
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

  if (options.force) {
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
  }

  // Local file has unpushed edits: preserve as orphan!
  return {
    id,
    slug: existingSync.slug,
    status: existingSync.status,
    filePath: existingSync.localFilePath,
    updated: false,
    orphan: true,
    localEditsPreserved: true,
    suggestion: 'Pass --force to preserve your edits under posts/conflicts/ and remove tracking.',
  };
}
