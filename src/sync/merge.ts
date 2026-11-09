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
  /**
   * Taxonomy names (e.g. "categories", "tags") where local and remote both changed the
   * assignment differently. Callers must NOT silently resolve these: taxonomy assignments
   * are user intent and dropping either side is data loss.
   */
  taxonomyConflicts: string[];
  autoMergedTaxonomies?: TaxonomyMergeItem[];
  wipeWarnings?: TaxonomyWipeWarning[];
}

/** Order-insensitive normalization for a taxonomy term list (undefined stays undefined). */
function normalizeTermList(val: unknown): string[] | undefined {
  if (!Array.isArray(val)) return undefined;
  return [...new Set(val.map((v) => String(v)))].sort();
}

export interface TaxonomyMergeItem {
  name: string;
  remoteAdded: string[];
  remoteRemoved: string[];
}

export interface TaxonomyWipeWarning {
  name: string;
  remoteTerms: string[];
  remoteAdded: string[];
}

export interface TaxonomyMergeResult {
  merged: Record<string, string[]>;
  conflicts: string[];
  autoMergedTaxonomies: TaxonomyMergeItem[];
  wipeWarnings: TaxonomyWipeWarning[];
}

export interface TaxonomyMergeOptions {
  strictRenameConflict?: boolean;
}

/**
 * 3-way merge for taxonomies frontmatter record (category, tag, etc.).
 *
 * Implements strict set-algebraic 3-way merge:
 *   localRemoved  := base \ local
 *   localAdded    := local \ base
 *   remoteRemoved := base \ remote
 *   remoteAdded   := remote \ base
 *   localChanged  := (local ≠ base)
 *   remoteChanged := (remote ≠ base)
 *
 * Evaluation order (strict):
 * 1. localChanged = false  -> Keep remote (local did not touch this taxonomy)
 * 2. remoteChanged = false -> Push local (clean single-side edit)
 * 3. Both changed:
 *    union := (base \ (localRemoved ∪ remoteRemoved)) ∪ localAdded ∪ remoteAdded
 *    3a. union = local      -> Push local (remote changes are subsumed)
 *    3b. local = ∅ & remote ≠ ∅ -> Destructive wipe guard
 *    3c. union ≠ local      -> Automatically push union with explicit merge log.
 *        Conflicts only if:
 *        (i) Server rejects union (400/422)
 *        (ii) Remote performed rename/replacement (remoteRemoved ≠ ∅ ∧ remoteAdded ≠ ∅) AND strictRenameConflict=true
 *        (iii) Base snapshot is null (cannot compute 3-way)
 */
export function mergeTaxonomies(
  local: Record<string, string[]> | undefined,
  base: Record<string, string[]> | undefined | null,
  remote: Record<string, string[]> | undefined,
  options?: TaxonomyMergeOptions,
): TaxonomyMergeResult {
  const merged: Record<string, string[]> = {};
  const conflicts: string[] = [];
  const autoMergedTaxonomies: TaxonomyMergeItem[] = [];
  const wipeWarnings: TaxonomyWipeWarning[] = [];

  const names = new Set([
    ...Object.keys(local || {}),
    ...Object.keys(base || {}),
    ...Object.keys(remote || {}),
  ]);
  const eq = (a: string[] | undefined, b: string[] | undefined) =>
    JSON.stringify(a) === JSON.stringify(b);

  for (const name of names) {
    const lDefined = local !== undefined && name in local && local[name] !== undefined;
    const rDefined = remote !== undefined && name in remote && remote[name] !== undefined;
    const bDefined =
      base !== null && base !== undefined && name in base && base[name] !== undefined;

    // Case 1: Neither side defined this taxonomy
    if (!lDefined && !rDefined) {
      if (bDefined && base![name] !== undefined) {
        merged[name] = base![name];
      }
      continue;
    }

    // Case 2: Only local defined this taxonomy (remote omitted or deleted)
    if (lDefined && !rDefined) {
      if (!bDefined) {
        merged[name] = local![name];
      } else {
        const l = normalizeTermList(local![name]);
        const b = normalizeTermList(base![name]);
        if (eq(l, b)) {
          // Local didn't change it, remote deleted it
        } else {
          // Local changed it, remote deleted it -> Conflict
          conflicts.push(name);
          merged[name] = local![name];
        }
      }
      continue;
    }

    // Case 3: Only remote defined this taxonomy (local omitted the field)
    if (!lDefined && rDefined) {
      merged[name] = remote![name];
      continue;
    }

    // Case 4: Both local and remote defined this taxonomy
    const lRaw = local![name];
    const rRaw = remote![name];
    const l = normalizeTermList(lRaw) ?? [];
    const r = normalizeTermList(rRaw) ?? [];

    if (eq(l, r)) {
      merged[name] = lRaw;
      continue;
    }

    // (iii) Base is null / missing: cannot compute 3-way -> conservative conflict
    if (!bDefined) {
      conflicts.push(name);
      merged[name] = lRaw;
      continue;
    }

    const b = normalizeTermList(base![name]) ?? [];
    const baseSet = new Set(b);
    const localSet = new Set(l);
    const remoteSet = new Set(r);

    const localAdded = l.filter((x) => !baseSet.has(x));
    const localRemoved = b.filter((x) => !localSet.has(x));
    const remoteAdded = r.filter((x) => !baseSet.has(x));
    const remoteRemoved = b.filter((x) => !remoteSet.has(x));

    const localChanged = localAdded.length > 0 || localRemoved.length > 0;
    const remoteChanged = remoteAdded.length > 0 || remoteRemoved.length > 0;

    // 1. localChanged = false -> Keep remote (local untouched)
    if (!localChanged) {
      merged[name] = rRaw;
      continue;
    }

    // 2. remoteChanged = false -> Push local (clean single-side edit)
    if (!remoteChanged) {
      merged[name] = lRaw;
      continue;
    }

    // 3. Both sides changed:
    // union := (base \ (localRemoved ∪ remoteRemoved)) ∪ localAdded ∪ remoteAdded
    const allRemovals = new Set([...localRemoved, ...remoteRemoved]);
    const union = [
      ...b.filter((x) => !allRemovals.has(x)),
      ...localAdded,
      ...remoteAdded.filter((x) => !localAdded.includes(x)),
    ];

    // 3a. union = local -> clean (remote changes are subsumed)
    const unionSet = new Set(union);
    const isUnionEqualLocal =
      unionSet.size === localSet.size && [...unionSet].every((x) => localSet.has(x));
    if (isUnionEqualLocal) {
      merged[name] = lRaw;
      continue;
    }

    // 3b. Destructive wipe guard: local = ∅ and remote ≠ ∅
    if (l.length === 0 && r.length > 0) {
      wipeWarnings.push({
        name,
        remoteTerms: r,
        remoteAdded,
      });
    }

    // 3c. union ≠ local: check for remote replacement under strictRenameConflict
    const isRemoteReplacement = remoteRemoved.length > 0 && remoteAdded.length > 0;
    if (isRemoteReplacement && options?.strictRenameConflict) {
      conflicts.push(name);
      merged[name] = lRaw;
      continue;
    }

    // Default: auto-merge union and record change log
    merged[name] = union;
    autoMergedTaxonomies.push({
      name,
      remoteAdded,
      remoteRemoved,
    });
  }

  return { merged, conflicts, autoMergedTaxonomies, wipeWarnings };
}

/**
 * Merges frontmatter fields key by key.
 * Never inserts conflict markers into YAML (always produces valid Frontmatter).
 * On collision (both local and remote modified the same field differently), remote takes precedence
 * and a warning is logged. Taxonomies are the exception: they are merged per taxonomy name with set
 * semantics and true conflicts are reported via `taxonomyConflicts` instead of being overwritten.
 */
export function mergeFrontmatter(
  local: Frontmatter,
  base: Frontmatter | null,
  remote: Frontmatter,
  options?: TaxonomyMergeOptions,
): {
  merged: Frontmatter;
  warnings: string[];
  taxonomyConflicts: string[];
  autoMergedTaxonomies?: TaxonomyMergeItem[];
  wipeWarnings?: TaxonomyWipeWarning[];
} {
  const warnings: string[] = [];
  let taxonomyConflicts: string[] = [];
  let autoMergedTaxonomies: TaxonomyMergeItem[] | undefined;
  let wipeWarnings: TaxonomyWipeWarning[] | undefined;
  const merged: Frontmatter = { ...remote };

  // Helper to check equality
  const isEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  const keys: Array<keyof Frontmatter> = [
    'title',
    'slug',
    'status',
    'publishedAt',
    'locale',
    'featuredImage',
    'taxonomies',
    'seo',
    'bylines',
  ];

  for (const key of keys) {
    if (key === 'taxonomies') {
      const tax = mergeTaxonomies(
        local.taxonomies,
        base ? base.taxonomies : null,
        remote.taxonomies,
        options,
      );
      merged.taxonomies = tax.merged;
      taxonomyConflicts = tax.conflicts;
      autoMergedTaxonomies = tax.autoMergedTaxonomies;
      wipeWarnings = tax.wipeWarnings;
      continue;
    }

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

  return {
    merged,
    warnings,
    taxonomyConflicts,
    autoMergedTaxonomies,
    wipeWarnings,
  };
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
  options?: TaxonomyMergeOptions,
): MergeResult {
  const {
    merged: frontmatter,
    warnings,
    taxonomyConflicts,
    autoMergedTaxonomies,
    wipeWarnings,
  } = mergeFrontmatter(
    local.frontmatter,
    base ? base.frontmatter : null,
    remote.frontmatter,
    options,
  );

  const baseBody = base ? base.body : '';
  const { mergedBody: body, hasConflict } = mergeBody(local.body, baseBody, remote.body);

  return {
    hasConflict,
    frontmatter,
    body,
    warnings,
    taxonomyConflicts,
    autoMergedTaxonomies,
    wipeWarnings,
  };
}
