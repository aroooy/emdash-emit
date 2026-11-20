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
import { storageKeyToMarkdownRef } from '../../utils/naming.js';
import { collectArticleReferencedMediaIds, collectArticleStorageKeys } from './body_scan.js';

/** The two ID spaces a protected reference can live in — see docs/media-id-spaces.md. */
export interface PruneProtectionSets {
  /**
   * Mirror stems (`storageKeyToMarkdownRef` of every storageKey an article body names) plus the local
   * spelling's basename, which is the same key without its extension. A mirror file whose stem matches one
   * of these backs a reference some workspace article still makes, so it may never be pruned even when the
   * bounded library walk never reached the record that owns it.
   */
  protectedStems: Set<string>;
  /** Record ULIDs named by frontmatter `featuredImage` or a body ULID, already upper-cased. */
  protectedRecordIds: Set<string>;
}

/**
 * Collects every media reference the workspace's own articles make, so pruning can protect it.
 *
 * Pruning authority is remote records only (AGENTS.md §7), but a record outside the walk window proves
 * nothing about whether an asset is still wanted: an article sitting on disk may reference it and the walk
 * that would have confirmed the record never reached item 101. Deleting such a mirror breaks a writing
 * asset over a knowledge gap, so this pass reads the local side of the ledger instead.
 *
 * Scope, deliberately:
 * - `draft/` and `published/` — the canonical articles themselves.
 * - `conflicts/` — rescue copies are read-only but their references still describe writing intent, so an
 *   asset they name stays mirrored until the human resolves the conflict.
 * - `.deleted.md` backups are EXCLUDED: they belong to articles already deleted remotely, and honoring them
 *   would keep a mirror for a record that can never be pruned again.
 *
 * The two ID spaces are never conflated: body URLs carry an R2 `storageKey`, while a companion YAML's `id:`
 * carries the D1 record ULID, and those differ for migrated corpora. So the result is split into a stem set
 * (compared against mirror filenames after normalization) and a record-id set (compared against the id read
 * from companion metadata — never parsed out of a filename).
 */
export function collectPruneProtectionSets(
  workspaceRoot: string,
  collection: string,
): PruneProtectionSets {
  const protectedStems = new Set<string>();
  const protectedRecordIds = new Set<string>();

  for (const statusDir of ['draft', 'published', 'conflicts']) {
    const dir = path.join(workspaceRoot, collection, statusDir);
    if (!fs.existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith('.md')) continue;
      // A deletion backup is the residue of an article that no longer exists remotely. Keeping its
      // references alive would make the corresponding record permanently unprunable.
      if (file.endsWith('.deleted.md')) continue;
      let content: string;
      try {
        content = fs.readFileSync(path.join(dir, file), 'utf8');
      } catch {
        // An unreadable article contributes nothing to the protection set — it cannot be blamed for a
        // mirror it might have referenced, but it also cannot vouch for one.
        continue;
      }

      for (const descriptor of collectArticleStorageKeys(content)) {
        const stem = storageKeyToMarkdownRef(descriptor.storageKey);
        if (stem) protectedStems.add(stem);
        // The article-relative spelling (`../../media/<storageKey>`) names the mirror outright, so its
        // extension-stripped basename is a second accepted stem for the same asset.
        const key = descriptor.storageKey;
        const withoutExt = key.replace(/\.[A-Za-z0-9]{1,11}$/, '');
        if (withoutExt && withoutExt !== key) protectedStems.add(withoutExt);
      }

      for (const mediaId of collectArticleReferencedMediaIds(content)) {
        protectedRecordIds.add(mediaId.toUpperCase());
      }
    }
  }

  return { protectedStems, protectedRecordIds };
}
