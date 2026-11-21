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
  relPath: string; // e.g. "posts/draft/20261121_01M...-title.md"
  fullPath: string;
  fileName: string;
  status: 'draft' | 'published' | 'conflicts';
}

/**
 * Iterates the workspace's article files for a collection. The conflicts/ boundary and the
 * `.deleted.md` rescue backup are expressed as explicit options so the intent that currently
 * lives in six separate comments becomes one declared contract.
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

  for (const status of statuses) {
    const dir = path.join(workspaceRoot, collection, status);
    if (!fs.existsSync(dir)) continue;

    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }

    for (const file of entries) {
      if (!file.endsWith('.md')) continue;
      if (excludeDeletedBackups && file.endsWith('.deleted.md')) continue;
      yield {
        relPath: path.posix.join(collection, status, file),
        fullPath: path.join(dir, file),
        fileName: file,
        status,
      };
    }
  }
}
