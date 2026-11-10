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
import type { CacheDatabase } from '../db/cache.js';
import {
  formatFrontmatterParseError,
  lenientRepairMarkdownFrontmatter,
  parseMarkdown,
} from '../utils/frontmatter.js';
import { calculateHash, CONFLICTS_SUBDIR } from './pull.js';
import {
  compareArticleFilenameDesc,
  extractUlidFromFilename,
  stripDatePrefix,
} from '../utils/naming.js';

export interface ArticleStatusItem {
  id: string;
  slug: string;
  title: string;
  status: 'draft' | 'published';
  syncStatus: 'synced' | 'modified' | 'untracked' | 'invalid';
  filePath: string;
  rev?: string;
  cached?: boolean;
  error?: string;
  /** True when strict parsing failed but a syntax-only lenient repair would succeed (recoverable by `emit pull`). */
  healable?: boolean;
  conflictPending?: boolean;
  deletePending?: boolean;
  orphan?: boolean;
  taxonomyApplyPending?: boolean;
}

export interface WorkspaceStatusResult {
  items: ArticleStatusItem[];
  summary: {
    total: number;
    synced: number;
    modified: number;
    untracked: number;
    invalid: number;
    /** Invalid files that a syntax-only lenient repair can fix (subset of `invalid`). */
    healableInvalid: number;
    /** Preserved divergent local copies stored in `<collection>/conflicts/` by a pull. */
    conflicts: number;
    /** Extended state flags preserving backward compatibility of the main 4 summary counts */
    flags?: {
      conflictPending: number;
      orphan: number;
      deletePending: number;
      taxonomyApplyPending: number;
    };
  };
}

export interface StatusFilterOptions {
  search?: string;
  slugFilter?: string;
  status?: 'draft' | 'published';
  syncStatus?: 'synced' | 'modified' | 'untracked' | 'invalid';
}

/**
 * Filters a list of article status items based on search term, slug, publication status, or sync status.
 */
export function filterStatusItems(
  items: ArticleStatusItem[],
  filters: StatusFilterOptions,
): ArticleStatusItem[] {
  return items.filter((item) => {
    if (filters.status && item.status !== filters.status) return false;
    if (filters.syncStatus && item.syncStatus !== filters.syncStatus) return false;
    if (filters.slugFilter) {
      const q = filters.slugFilter.toLowerCase();
      if (!item.slug.toLowerCase().includes(q)) return false;
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      const match =
        item.title.toLowerCase().includes(q) ||
        item.slug.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q) ||
        item.filePath.toLowerCase().includes(q);
      if (!match) return false;
    }
    return true;
  });
}

/**
 * Counts preserved divergent local copies in `<collection>/conflicts/`.
 * These files are informational rescue copies: they are never tracked, pushed, or pruned.
 */
export function countQuarantinedCopies(
  workspaceRoot: string,
  collection: string = 'posts',
): number {
  const conflictsDir = path.join(workspaceRoot, collection, CONFLICTS_SUBDIR);
  if (!fs.existsSync(conflictsDir)) return 0;
  try {
    return fs.readdirSync(conflictsDir).filter((f) => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

/**
 * Scans the workspace directory and compares files against cache.db to compute sync status.
 */
export function getWorkspaceStatus(
  workspaceRoot: string,
  cache: CacheDatabase,
  collection: string = 'posts',
): WorkspaceStatusResult {
  const collectionDir = path.join(workspaceRoot, collection);
  const items: ArticleStatusItem[] = [];

  if (!fs.existsSync(collectionDir)) {
    return {
      items: [],
      summary: {
        total: 0,
        synced: 0,
        modified: 0,
        untracked: 0,
        invalid: 0,
        healableInvalid: 0,
        conflicts: 0,
      },
    };
  }

  // Scan draft/ and published/ subdirectories
  const subdirs: Array<'draft' | 'published'> = ['draft', 'published'];
  for (const sub of subdirs) {
    const subDirPath = path.join(collectionDir, sub);
    if (!fs.existsSync(subDirPath)) continue;

    const files = fs.readdirSync(subDirPath).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const relPath = path.join(collection, sub, file);
      const fullPath = path.join(workspaceRoot, relPath);
      const content = fs.readFileSync(fullPath, 'utf8');

      try {
        const parsed = parseMarkdown(content);
        const currentHash = calculateHash(content);
        const syncState = cache.getSyncState(parsed.frontmatter.id);

        let syncStatus: 'synced' | 'modified' | 'untracked' = 'untracked';
        const conflictPending = syncState?.conflictPending === 1;
        const deletePending = syncState?.deletePending === 1;
        const taxonomyApplyPending = syncState?.taxonomyApplyPending === 1;

        if (syncState) {
          if (syncState.localHash === currentHash && !conflictPending && !taxonomyApplyPending) {
            syncStatus = 'synced';
          } else {
            syncStatus = 'modified';
          }
        }

        items.push({
          id: parsed.frontmatter.id,
          slug: parsed.frontmatter.slug,
          title: parsed.frontmatter.title,
          status: parsed.frontmatter.status,
          syncStatus,
          filePath: relPath,
          rev: syncState?.remoteRev,
          conflictPending: conflictPending || undefined,
          deletePending: deletePending || undefined,
          taxonomyApplyPending: taxonomyApplyPending || undefined,
        });
      } catch (err: unknown) {
        const fallbackId = extractUlidFromFilename(file) || 'unknown';
        const baseWithoutDate = stripDatePrefix(file).replace(/\.md$/i, '');
        const fallbackTitle =
          fallbackId !== 'unknown' && baseWithoutDate.startsWith(`${fallbackId}-`)
            ? baseWithoutDate.slice(fallbackId.length + 1)
            : baseWithoutDate;
        const syncState = fallbackId !== 'unknown' ? cache.getSyncState(fallbackId) : null;
        const errorMsg = formatFrontmatterParseError(err);
        // Match `emit doctor`: distinguish files that a syntax-only lenient repair can recover from
        // files with unrecoverable frontmatter, so status and doctor never disagree.
        const healable = lenientRepairMarkdownFrontmatter(content) !== null;

        items.push({
          id: fallbackId,
          slug: syncState?.slug || 'invalid-frontmatter',
          title: fallbackTitle,
          status: sub,
          syncStatus: 'invalid',
          filePath: relPath,
          rev: syncState?.remoteRev,
          cached: Boolean(syncState),
          healable: healable || undefined,
          error: errorMsg,
        });
      }
    }
  }

  // Sort items descending by filename (YYYYMMDD_ prefix / ULID) so newest articles appear first
  items.sort((a, b) => compareArticleFilenameDesc(a.filePath, b.filePath));

  const summary = {
    total: items.length,
    synced: items.filter((i) => i.syncStatus === 'synced').length,
    modified: items.filter((i) => i.syncStatus === 'modified').length,
    untracked: items.filter((i) => i.syncStatus === 'untracked').length,
    invalid: items.filter((i) => i.syncStatus === 'invalid').length,
    healableInvalid: items.filter((i) => i.syncStatus === 'invalid' && i.healable).length,
    conflicts: countQuarantinedCopies(workspaceRoot, collection),
    flags: {
      conflictPending: items.filter((i) => i.conflictPending).length,
      orphan: items.filter((i) => i.orphan).length,
      deletePending: items.filter((i) => i.deletePending).length,
      taxonomyApplyPending: items.filter((i) => i.taxonomyApplyPending).length,
    },
  };

  return { items, summary };
}
