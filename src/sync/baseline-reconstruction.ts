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
import type { BaseSnapshot, CacheDatabase, SyncState } from '../db/cache.js';
import { baselineMarkdown, retrackLocalHashOnly } from '../db/baseline.js';
import type { TaxonomyCandidates } from '../utils/frontmatter.js';
import { resolveDiskSpelling, renderForDisk, type DiskSpelling } from '../utils/disk-spelling.js';
import { loadLocalTaxonomyCandidates } from './taxonomies.js';
import { calculateHash } from './workspace/index.js';

export interface ReconstructedBaseline {
  canonicalMarkdown: string;
  diskSpellingMarkdown: string;
  spelling: DiskSpelling;
  matchesDisk: boolean;
}

/**
 * Reconstructs the canonical baseline document and its disk-spelling representation
 * (`localMediaRefs`, legacy percent-encoded taxonomy terms, and `# draft revision` comment).
 */
export function reconstructBaseline(params: {
  workspaceRoot: string;
  snapshot: BaseSnapshot;
  localContent: string;
  currentHash?: string;
  syncState?: SyncState | null;
  relPath: string;
  candidates?: TaxonomyCandidates;
  fs?: typeof fs;
}): ReconstructedBaseline {
  const customFs = params.fs ?? fs;
  const currentHash = params.currentHash ?? calculateHash(params.localContent);
  const candidates = params.candidates ?? loadLocalTaxonomyCandidates(params.workspaceRoot);
  const spelling = resolveDiskSpelling(params.localContent, params.syncState);
  const canonicalMarkdown = baselineMarkdown(params.snapshot, candidates, {
    preferEncodedTaxonomy: spelling.preferEncodedTaxonomy,
    hasDraftRevision: spelling.hasDraftRevision,
  });
  const diskSpellingMarkdown = renderForDisk(canonicalMarkdown, spelling, {
    workspaceRoot: params.workspaceRoot,
    articleRelPath: params.relPath,
    fs: customFs,
  });
  const canonicalHash = calculateHash(canonicalMarkdown);
  const hasSpellingTransform =
    diskSpellingMarkdown !== canonicalMarkdown || canonicalHash !== params.snapshot.hash;
  const matchesDisk =
    calculateHash(diskSpellingMarkdown) === currentHash &&
    (!params.syncState ||
      params.syncState.localHash === currentHash ||
      params.syncState.localHash === params.snapshot.hash ||
      hasSpellingTransform);
  return {
    canonicalMarkdown,
    diskSpellingMarkdown,
    spelling,
    matchesDisk,
  };
}

/**
 * Checks whether a tracked file on disk is unmodified against its cached `sync_state` or
 * reconstructed baseline. When raw `localHash` mismatches purely due to reference spelling
 * (and `matchesDisk` is true), automatically re-tracks `sync_state.local_hash` via
 * `retrackLocalHashOnly()` so subsequent status/diff/doctor/delete checks fast-path cleanly.
 */
export function isLocalFileUnmodified(params: {
  workspaceRoot: string;
  cache: CacheDatabase;
  id: string;
  relPath: string;
  localContent: string;
  currentHash?: string;
  syncState?: SyncState | null;
  healOnSpellingMatch?: boolean;
  candidates?: TaxonomyCandidates;
  fs?: typeof fs;
}): boolean {
  const syncState =
    params.syncState !== undefined ? params.syncState : params.cache.getSyncState(params.id);
  if (!syncState) return false;

  const currentHash = params.currentHash ?? calculateHash(params.localContent);
  if (syncState.localHash === currentHash) {
    return true;
  }

  const snapshot = params.cache.getBaseSnapshot(params.id);
  if (!snapshot) return false;

  try {
    const reconstructed = reconstructBaseline({
      workspaceRoot: params.workspaceRoot,
      snapshot,
      localContent: params.localContent,
      currentHash,
      syncState,
      relPath: params.relPath,
      candidates: params.candidates,
      fs: params.fs,
    });
    if (reconstructed.matchesDisk) {
      if (params.healOnSpellingMatch !== false) {
        retrackLocalHashOnly(params.cache, {
          id: params.id,
          localHash: currentHash,
        });
      }
      return true;
    }
    return false;
  } catch {
    // An unreadable or malformed baseline cannot certify the file as untouched.
    return false;
  }
}
