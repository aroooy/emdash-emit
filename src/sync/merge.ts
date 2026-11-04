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

import { merge as diff3Merge } from 'node-diff3';
import type { Frontmatter, ParsedMarkdown } from '../utils/frontmatter.js';

export interface MergeResult {
  hasConflict: boolean;
  frontmatter: Frontmatter;
  body: string;
  warnings: string[];
}

/**
 * Merges frontmatter fields key by key.
 * Never inserts conflict markers into YAML (always produces valid Frontmatter).
 * On collision (both local and remote modified the same field differently), remote takes precedence
 * and a warning is logged.
 */
export function mergeFrontmatter(
  local: Frontmatter,
  base: Frontmatter | null,
  remote: Frontmatter,
): { merged: Frontmatter; warnings: string[] } {
  const warnings: string[] = [];
  const merged: Frontmatter = { ...remote };

  // Helper to check equality
  const isEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  const keys: Array<keyof Frontmatter> = [
    'title',
    'slug',
    'status',
    'publishedAt',
    'locale',
    'taxonomies',
    'seo',
    'bylines',
  ];

  for (const key of keys) {
    const localVal = local[key];
    const remoteVal = remote[key];
    const baseVal = base ? base[key] : undefined;

    const localChanged = !isEqual(localVal, baseVal);
    const remoteChanged = !isEqual(remoteVal, baseVal);

    if (localChanged && !remoteChanged) {
      // Only local changed; keep local
      (merged as Record<string, unknown>)[key] = localVal;
    } else if (!localChanged && remoteChanged) {
      // Only remote changed; keep remote
      (merged as Record<string, unknown>)[key] = remoteVal;
    } else if (localChanged && remoteChanged) {
      if (isEqual(localVal, remoteVal)) {
        // Both changed to the same value
        (merged as Record<string, unknown>)[key] = localVal;
      } else {
        // True conflict on frontmatter field: remote takes precedence
        (merged as Record<string, unknown>)[key] = remoteVal;
        warnings.push(
          `Conflict on frontmatter field '${key}': remote value was preferred over local changes.`,
        );
      }
    } else {
      // Neither changed
      (merged as Record<string, unknown>)[key] = remoteVal;
    }
  }

  // Preserve mandatory immutable fields
  merged.id = remote.id || local.id;
  merged.collection = remote.collection || local.collection;

  return { merged, warnings };
}

/**
 * Merges markdown body line by line using diff3.
 * Inserts Git-style conflict markers (<<<<<<< LOCAL ... ======= ... >>>>>>> REMOTE) only if there is a conflict.
 */
export function mergeBody(
  localBody: string,
  baseBody: string,
  remoteBody: string,
): { mergedBody: string; hasConflict: boolean } {
  // Normalize line breaks to \n and split into line arrays
  const localLines = localBody.replace(/\r\n/g, '\n').split('\n');
  const baseLines = baseBody.replace(/\r\n/g, '\n').split('\n');
  const remoteLines = remoteBody.replace(/\r\n/g, '\n').split('\n');

  // diff3Merge(a, o, b) where a = local, o = original (base), b = remote
  const res = diff3Merge(localLines, baseLines, remoteLines, {
    label: { a: 'LOCAL', b: 'REMOTE' },
  });

  const mergedBody = res.result.join('\n');
  return {
    mergedBody,
    hasConflict: res.conflict,
  };
}

/**
 * Executes a Hybrid 3-Way Merge separating frontmatter structured merge and markdown text merge.
 */
export function hybrid3WayMerge(
  local: ParsedMarkdown,
  base: { frontmatter: Frontmatter; body: string } | null,
  remote: { frontmatter: Frontmatter; body: string },
): MergeResult {
  const { merged: frontmatter, warnings } = mergeFrontmatter(
    local.frontmatter,
    base ? base.frontmatter : null,
    remote.frontmatter,
  );

  const baseBody = base ? base.body : '';
  const { mergedBody: body, hasConflict } = mergeBody(local.body, baseBody, remote.body);

  return {
    hasConflict,
    frontmatter,
    body,
    warnings,
  };
}
