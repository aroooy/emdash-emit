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
import { articleTermsEndpoint } from '../client/endpoints.js';

/**
 * Computes deterministic SHA-256 hash for taxonomy assignments.
 * Format: sha256(sorted(categorySlugs).join(',') + '|' + sorted(tagSlugs).join(','))
 */
export function computeTaxonomyHash(categories?: string[] | null, tags?: string[] | null): string {
  const sortedCats = [...(categories || [])].sort().join(',');
  const sortedTags = [...(tags || [])].sort().join(',');
  return crypto.createHash('sha256').update(`${sortedCats}|${sortedTags}`).digest('hex');
}

/**
 * Fetches the terms currently assigned to an article for one taxonomy.
 *
 * EmDash does NOT embed taxonomy assignments in `GET /_emdash/api/content/{collection}/{id}`;
 * they live only behind `/terms/{taxonomy}`. Every code path that needs the *remote* taxonomy
 * state (pull, and the push-side 3-way merge) must read it from here, otherwise the remote side
 * looks like "no terms" and a merge silently drops the author's assignments.
 *
 * Returns `null` when the request fails so callers can distinguish "unknown" from "none" (`[]`).
 */
export async function fetchAssignedTerms(options: {
  origin: string;
  token: string;
  collection: string;
  id: string;
  taxonomy: 'category' | 'tag';
  fetchFn: typeof fetch;
}): Promise<string[] | null> {
  try {
    const termsUrl = articleTermsEndpoint(
      options.origin,
      options.collection,
      options.id,
      options.taxonomy,
    );
    const termsRes = await options.fetchFn(termsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/json',
      },
    });
    if (!termsRes.ok) return null;
    const termsJson = (await termsRes.json().catch(() => ({}))) as {
      data?: { terms?: Array<{ slug?: string; id?: string }> };
      terms?: Array<{ slug?: string; id?: string }>;
    };
    const termsList =
      termsJson.data && Array.isArray(termsJson.data.terms)
        ? termsJson.data.terms
        : Array.isArray(termsJson.terms)
          ? termsJson.terms
          : null;
    if (termsList === null) {
      return null;
    }
    return termsList.map((t) => t.slug || t.id).filter((s): s is string => Boolean(s));
  } catch {
    return null;
  }
}

/**
 * Fetches both category and tag assignments. Each entry is `null` when that request failed.
 */
export async function fetchAssignedTaxonomies(options: {
  origin: string;
  token: string;
  collection: string;
  id: string;
  fetchFn: typeof fetch;
}): Promise<{ categories: string[] | null; tags: string[] | null }> {
  const [categories, tags] = await Promise.all([
    fetchAssignedTerms({ ...options, taxonomy: 'category' }),
    fetchAssignedTerms({ ...options, taxonomy: 'tag' }),
  ]);
  return { categories, tags };
}
