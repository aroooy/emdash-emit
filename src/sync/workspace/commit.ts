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
import type { CacheDatabase, SyncState } from '../../db/cache.js';
import { createBaseSnapshot } from '../../db/baseline.js';
import type { Frontmatter } from '../../utils/frontmatter.js';
import { calculateHash } from './hash.js';

export interface ArticleCommitInput {
  /** 26-character canonical ULID of the article */
  id: string;
  /** Final canonical relative file path (e.g. 'posts/published/20261113_...md') */
  relPath: string;
  /** Actual string content to write to disk in disk spelling */
  diskContent: string;
  /** Explicit local hash override (e.g. when preserving unpushed local edits) */
  localHash?: string;
  /** Canonical string content used for baseline hash (defaults to diskContent if omitted) */
  canonicalContent?: string;
  /** Frontmatter object for Layer A storage (remote-derived only, no synthetic values) */
  frontmatter: Frontmatter;
  /** Canonical body Markdown for Layer A storage */
  bodyMarkdown: string;
  /** Track 1 raw server revision token for base_snapshots.rev */
  revForTransport: string;
  /** Track 2 composite revision key for sync_state.remote_rev */
  revForComparison: string;
  /** Optional sync state flags (e.g. conflict flags, taxonomy hash) */
  flags?: Partial<SyncState>;
  /** When true, keeps existing frontmatter/body in base_snapshots and only updates baseline hash */
  bumpBaselineHashOnly?: boolean;
  /** Custom timestamp in epoch seconds (defaults to Math.floor(Date.now() / 1000)) */
  savedAt?: number;
  /** Whether to skip writing diskContent to disk (e.g. when already written or conflict quarantine only) */
  skipDiskWrite?: boolean;
}

export interface ArticleCommitResult {
  localHash: string;
  baselineHash: string;
  fullPath: string;
}

/**
 * Centralized article commit function (Phase 0 Refactoring).
 * Encapsulates the 4 core synchronization invariants:
 * 1. localHash strictly matches SHA-256 of diskContent
 * 2. baselineHash strictly matches SHA-256 of canonicalContent
 * 3. frontmatter in base_snapshots stores remote-derived clean values (Layer A)
 * 4. revForTransport and revForComparison are strictly separated between Track 1 and Track 2
 */
export function commitArticleSnapshot(
  cache: CacheDatabase,
  workspaceRoot: string,
  input: ArticleCommitInput,
  customFs: typeof fs = fs,
): ArticleCommitResult {
  const fullPath = path.resolve(workspaceRoot, input.relPath);
  const localHash = input.localHash ?? calculateHash(input.diskContent);
  const baselineHash = input.canonicalContent ? calculateHash(input.canonicalContent) : localHash;

  // 1. Disk mutation (unless caller opted out)
  if (!input.skipDiskWrite) {
    customFs.mkdirSync(path.dirname(fullPath), { recursive: true });
    customFs.writeFileSync(fullPath, input.diskContent, 'utf8');
  }

  // 2. Atomic database transaction
  const timestamp = input.savedAt ?? Math.floor(Date.now() / 1000);

  cache.runTransaction(() => {
    // Base snapshot update
    if (input.bumpBaselineHashOnly) {
      const existingBase = cache.getBaseSnapshot(input.id);
      if (existingBase) {
        cache.saveBaseSnapshot({
          ...existingBase,
          hash: baselineHash,
          savedAt: timestamp,
        });
      }
    } else {
      cache.saveBaseSnapshot(
        createBaseSnapshot({
          id: input.id,
          rev: input.revForTransport,
          bodyMarkdown: input.bodyMarkdown,
          frontmatter: input.frontmatter,
          hash: baselineHash,
          savedAt: timestamp,
        }),
      );
    }

    // Sync state update
    cache.saveSyncState({
      id: input.id,
      localFilePath: input.relPath,
      localHash,
      remoteRev: input.revForComparison,
      status: input.frontmatter.status,
      slug: input.frontmatter.slug,
      lastSyncedAt: timestamp,
      ...input.flags,
    });
  });

  return {
    localHash,
    baselineHash,
    fullPath,
  };
}
