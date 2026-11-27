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

export interface WorkspaceArticleEntry {
  relPath: string; // e.g. "posts/ja/draft/20261121_01M...-title.md"
  fullPath: string;
  fileName: string;
  status: 'draft' | 'published' | 'conflicts';
  locale?: string;
}

/**
 * Iterates the workspace's article files for a collection.
 * Canonical articles live under `<collection>/<locale>/{draft,published}/`, while
 * quarantined copies remain under `<collection>/conflicts/`.
 */
export function* iterWorkspaceArticles(
  workspaceRoot: string,
  collection: string,
  options?: {
    includeConflicts?: boolean;
    excludeDeletedBackups?: boolean;
    statuses?: ReadonlyArray<'draft' | 'published' | 'conflicts'>;
  },
): Iterable<WorkspaceArticleEntry> {
  const statuses: ReadonlyArray<'draft' | 'published' | 'conflicts'> =
    options?.statuses ??
    (options?.includeConflicts ? ['draft', 'published', 'conflicts'] : ['draft', 'published']);
  const excludeDeletedBackups = options?.excludeDeletedBackups ?? true;

  const collectionDir = path.join(workspaceRoot, collection);
  if (!fs.existsSync(collectionDir)) return;

  const articleStatuses = statuses.filter(
    (s): s is 'draft' | 'published' => s === 'draft' || s === 'published',
  );
  if (articleStatuses.length > 0) {
    let topEntries: fs.Dirent[];
    try {
      topEntries = fs.readdirSync(collectionDir, { withFileTypes: true });
    } catch {
      topEntries = [];
    }

    for (const entry of topEntries) {
      if (!entry.isDirectory()) continue;
      const locale = entry.name;
      if (
        locale.startsWith('.') ||
        locale === 'conflicts' ||
        locale === 'draft' ||
        locale === 'published'
      ) {
        continue;
      }

      for (const status of articleStatuses) {
        const dir = path.join(collectionDir, locale, status);
        if (!fs.existsSync(dir)) continue;

        let files: string[];
        try {
          files = fs.readdirSync(dir);
        } catch {
          continue;
        }

        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          if (excludeDeletedBackups && file.endsWith('.deleted.md')) continue;
          yield {
            relPath: path.posix.join(collection, locale, status, file),
            fullPath: path.join(dir, file),
            fileName: file,
            status,
            locale,
          };
        }
      }
    }
  }

  if (statuses.includes('conflicts')) {
    const conflictsDir = path.join(collectionDir, 'conflicts');
    if (fs.existsSync(conflictsDir)) {
      let files: string[];
      try {
        files = fs.readdirSync(conflictsDir);
      } catch {
        files = [];
      }
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        if (excludeDeletedBackups && file.endsWith('.deleted.md')) continue;
        yield {
          relPath: path.posix.join(collection, 'conflicts', file),
          fullPath: path.join(conflictsDir, file),
          fileName: file,
          status: 'conflicts',
        };
      }
    }
  }
}
