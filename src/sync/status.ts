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
import { parseMarkdown } from '../utils/frontmatter.js';
import { calculateHash } from './pull.js';

export interface ArticleStatusItem {
  id: string;
  slug: string;
  title: string;
  status: 'draft' | 'published';
  syncStatus: 'synced' | 'modified' | 'untracked';
  filePath: string;
  rev?: string;
}

export interface WorkspaceStatusResult {
  items: ArticleStatusItem[];
  summary: {
    total: number;
    synced: number;
    modified: number;
    untracked: number;
  };
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
      summary: { total: 0, synced: 0, modified: 0, untracked: 0 },
    };
  }

  // Scan draft/ and published/ subdirectories
  const subdirs = ['draft', 'published'];
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
        if (syncState) {
          if (syncState.localHash === currentHash) {
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
        });
      } catch {
        // Skip invalid markdown files
      }
    }
  }

  const summary = {
    total: items.length,
    synced: items.filter((i) => i.syncStatus === 'synced').length,
    modified: items.filter((i) => i.syncStatus === 'modified').length,
    untracked: items.filter((i) => i.syncStatus === 'untracked').length,
  };

  return { items, summary };
}
