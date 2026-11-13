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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { extractUlidFromFilename } from '../../utils/naming.js';
import { computeArticleRelativePath } from '../../utils/frontmatter.js';

/** Subdirectory (under a collection) reserved for preserved divergent local copies. */
export const CONFLICTS_SUBDIR = 'conflicts';

/**
 * Calculates SHA-256 hash of a string.
 */
export function calculateHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Detects a workspace-relative rescue-copy path (`<collection>/conflicts/<file>.md`).
 *
 * Canonical articles always live at `<collection>/draft|published/<file>.md`, so matching the
 * second path segment is sufficient and avoids false positives from a slug that merely contains
 * the word "conflicts". Used by the push guard (QUARANTINED_COPY_NOT_PUSHABLE) so a rescue copy
 * can never silently overwrite the canonical article it was preserved from.
 */
export function isQuarantinedRelativePath(relPath: string): boolean {
  const segments = relPath
    .split(path.sep)
    .join('/')
    .split('/')
    .filter((seg) => seg.length > 0);
  return segments.length >= 3 && segments[1] === CONFLICTS_SUBDIR;
}

/**
 * Finds all existing Markdown files in `<collection>/{draft,published}/` whose filename
 * contains the given 26-character ULID. Used to preserve date prefixes and clean up
 * stale duplicate files when pulling an uncached article.
 */
export function findLocalFilesByUlid(
  workspaceRoot: string,
  collection: string,
  id: string,
): string[] {
  const matches: string[] = [];
  for (const sub of ['draft', 'published']) {
    const subDir = path.join(workspaceRoot, collection, sub);
    if (!fs.existsSync(subDir)) continue;
    try {
      for (const file of fs.readdirSync(subDir)) {
        if (!file.endsWith('.md')) continue;
        if (extractUlidFromFilename(file) === id) {
          matches.push(path.join(collection, sub, file));
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }
  return matches;
}

/**
 * Resolves canonical relative path for an article symmetrically between
 * batch fast-path and full pull (EMIT-005 / R7).
 */
export function resolveCanonicalArticlePath(
  collection: string,
  status: string,
  id: string,
  title: string,
  dates: {
    publishedAt?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
  },
  existingPrefix?: string | null,
): string {
  const dateInput =
    dates.publishedAt || existingPrefix || dates.createdAt || dates.updatedAt || null;
  return computeArticleRelativePath(collection, status, id, title, dateInput);
}

/**
 * Preserves a local Markdown copy verbatim under `<collection>/conflicts/` before Emit
 * overwrites or removes the original path. Used to guarantee that no divergent local
 * content (e.g. an uncached file written by another tool or an older serializer) is
 * silently discarded during a pull.
 */
export function quarantineLocalCopy(
  workspaceRoot: string,
  collection: string,
  sourceRelPath: string,
  content: string,
  options?: {
    isForce?: boolean;
    existingCopyHash?: string | null;
  },
): string | null {
  const conflictsDir = path.join(workspaceRoot, collection, CONFLICTS_SUBDIR);
  const baseName = path.basename(sourceRelPath).replace(/\.md$/i, '');
  const suffixExt = options?.isForce ? '.local-dropped.md' : '.conflict.md';
  let quarantineRel = path.join(collection, CONFLICTS_SUBDIR, `${baseName}${suffixExt}`);
  const quarantineFull = path.join(workspaceRoot, quarantineRel);

  try {
    fs.mkdirSync(conflictsDir, { recursive: true });

    // Deduplication check: if canonical conflict file exists and is unedited, overwrite without incrementing
    if (!options?.isForce && fs.existsSync(quarantineFull)) {
      const existingDiskHash = calculateHash(fs.readFileSync(quarantineFull, 'utf8'));
      if (
        (options?.existingCopyHash && existingDiskHash === options.existingCopyHash) ||
        existingDiskHash === calculateHash(content)
      ) {
        fs.writeFileSync(quarantineFull, content, 'utf8');
        return quarantineRel;
      }
    }

    let suffix = 2;
    while (fs.existsSync(path.join(workspaceRoot, quarantineRel))) {
      quarantineRel = path.join(
        collection,
        CONFLICTS_SUBDIR,
        options?.isForce
          ? `${baseName}.local-dropped-${suffix}.md`
          : `${baseName}.conflict-${suffix}.md`,
      );
      suffix += 1;
      if (suffix > 100) return null;
    }
    fs.writeFileSync(path.join(workspaceRoot, quarantineRel), content, 'utf8');
    return quarantineRel;
  } catch {
    return null;
  }
}
