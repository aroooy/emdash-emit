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

import {
  type Frontmatter,
  type TaxonomyCandidates,
  serializeMarkdown,
} from '../utils/frontmatter.js';
import type { BaseSnapshot } from './cache.js';

export interface DecodedBaseline {
  frontmatter: Frontmatter;
  body: string;
}

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
}): BaseSnapshot {
  return {
    id: params.id,
    rev: params.rev,
    bodyMarkdown: params.bodyMarkdown,
    /** Despite the column name, this value is JSON-encoded Frontmatter. */
    frontmatterYaml: JSON.stringify(params.frontmatter),
    hash: params.hash,
    savedAt: params.savedAt ?? Math.floor(Date.now() / 1000),
  };
}

/**
 * Reconstruct the exact canonical Markdown document from a baseline snapshot.
 *
 * Invariant: serializeMarkdown(readBaseline(snapshot).frontmatter, snapshot.bodyMarkdown)
 * must be byte-identical to the baseline hash and disk representation.
 */
export function baselineMarkdown(snapshot: BaseSnapshot, candidates?: TaxonomyCandidates): string {
  const { frontmatter, body } = readBaseline(snapshot);
  return serializeMarkdown(frontmatter, body, candidates);
}
