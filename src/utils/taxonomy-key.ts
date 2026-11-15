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

import { tryDecodeTaxonomyTerm } from './frontmatter.js';

/**
 * Decodes a potentially percent-encoded taxonomy term and normalizes to Unicode NFC.
 * Preserves case so callers can apply case-insensitive matching only when needed.
 */
export function normalizeTaxonomyKey(term: string): string {
  return tryDecodeTaxonomyTerm(term).normalize('NFC');
}

/**
 * Returns true when `tryDecodeTaxonomyTerm(term) !== term` (i.e. valid percent-encoded term).
 */
export function isPercentEncodedTerm(term: string): boolean {
  return tryDecodeTaxonomyTerm(term) !== term;
}

/**
 * Returns the canonical (Layer A / Track 1) slug of a local taxonomy item.
 */
export function canonicalSlugOf(item: { slug: string; canonicalSlug?: string }): string {
  return item.canonicalSlug && item.canonicalSlug !== item.slug ? item.canonicalSlug : item.slug;
}

/**
 * Returns `[item.slug, item.canonicalSlug]` when `canonicalSlug` differs from `slug`,
 * or `[item.slug]` otherwise.
 */
export function aliasesOf(item: { slug: string; canonicalSlug?: string }): string[] {
  return item.canonicalSlug && item.canonicalSlug !== item.slug
    ? [item.slug, item.canonicalSlug]
    : [item.slug];
}
