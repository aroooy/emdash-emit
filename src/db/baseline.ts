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
import {
  type Frontmatter,
  type TaxonomyCandidates,
  type SerializeMarkdownOptions,
  serializeMarkdown,
} from '../utils/frontmatter.js';
import type { BaseSnapshot, CacheDatabase } from './cache.js';

export interface DecodedBaseline {
  frontmatter: Frontmatter;
  body: string;
}

export type BaselineSerializeOptions = SerializeMarkdownOptions;

/**
 * Read and decode the frontmatter and body from a baseline snapshot.
 *
 * Invariant: Despite the database column being named `frontmatter_yaml` (preserved for Cache Schema v5 compatibility),
 * the stored value is strictly a JSON-encoded `Frontmatter` object.
 */
export function readBaseline(snapshot: BaseSnapshot): DecodedBaseline {
  const frontmatter = JSON.parse(snapshot.frontmatterYaml) as Frontmatter;
  return {
    frontmatter,
    body: snapshot.bodyMarkdown,
  };
}

/**
 * Convenience helper to safely read the frontmatter from an optional baseline snapshot.
 */
export function readBaselineFrontmatter(snapshot?: BaseSnapshot | null): Frontmatter | null {
  if (!snapshot?.frontmatterYaml) return null;
  try {
    return JSON.parse(snapshot.frontmatterYaml) as Frontmatter;
  } catch {
    return null;
  }
}

/**
 * Safely decodes opaque extra data preserved in `base_snapshots.extra_data_json`.
 */
export function readBaselineExtraData(
  snapshot?: BaseSnapshot | null,
): Record<string, unknown> | undefined {
  if (!snapshot?.extraDataJson) return undefined;
  try {
    const parsed = JSON.parse(snapshot.extraDataJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed).length > 0 ? (parsed as Record<string, unknown>) : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a canonical `BaseSnapshot` object from raw parts.
 * Encapsulates the JSON-encoding of `frontmatter` into the `frontmatterYaml` field.
 */
export function createBaseSnapshot(params: {
  id: string;
  rev: string;
  bodyMarkdown: string;
  frontmatter: Frontmatter;
  hash: string;
  savedAt?: number;
  extraDataJson?: string | null;
}): BaseSnapshot {
  return {
    id: params.id,
    rev: params.rev,
    bodyMarkdown: params.bodyMarkdown,
    /** Despite the column name, this value is JSON-encoded Frontmatter. */
    frontmatterYaml: JSON.stringify(params.frontmatter),
    hash: params.hash,
    savedAt: params.savedAt ?? Math.floor(Date.now() / 1000),
    ...(params.extraDataJson !== undefined ? { extraDataJson: params.extraDataJson } : {}),
  };
}

/**
 * Reconstruct the exact canonical Markdown document from a baseline snapshot.
 *
 * Invariant: serializeMarkdown(readBaseline(snapshot).frontmatter, snapshot.bodyMarkdown)
 * must be byte-identical to the baseline hash and disk representation.
 */
export function baselineMarkdown(
  snapshot: BaseSnapshot,
  candidates?: TaxonomyCandidates,
  options?: BaselineSerializeOptions,
): string {
  const { frontmatter, body } = readBaseline(snapshot);
  return serializeMarkdown(frontmatter, body, candidates, options);
}

/**
 * Sync-state-only re-tracking: the disk bytes changed (spelling), values did not.
 * Invariants:
 *  - local_hash strictly matches SHA-256 of the bytes now on disk
 *  - base_snapshots is NOT touched (baseline stays canonical / Layer A)
 *  - remote_rev, status, slug, conflict flags are preserved verbatim
 */
export function retrackLocalHashOnly(
  cache: CacheDatabase,
  input: {
    id: string;
    diskContent?: string;
    localHash?: string;
    touchSyncedAt?: boolean;
  },
): { localHash: string } | null {
  const existing = cache.getSyncState(input.id);
  if (!existing) {
    return null;
  }
  const localHash =
    input.localHash ??
    crypto
      .createHash('sha256')
      .update(input.diskContent ?? '', 'utf8')
      .digest('hex');
  cache.saveSyncState({
    ...existing,
    localHash,
    lastSyncedAt: input.touchSyncedAt ? Math.floor(Date.now() / 1000) : existing.lastSyncedAt,
  });
  return { localHash };
}
