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

/** Term spellings a workspace definition or remote payload may carry for one taxonomy term. */
export interface TaxonomyTermAliases {
  slug: string;
  canonicalSlug?: string;
  name?: string;
}

function pushAlias(aliases: Set<string>, raw: string | undefined): void {
  if (!raw) return;
  const trimmed = raw.trim();
  if (!trimmed) return;
  // The decoded spelling is what a human or an agent types (`カメラレビュー`); the raw spelling is
  // what a remote payload carries (`%e3%82%ab...`). Registering both keeps either side matchable.
  aliases.add(trimmed.normalize('NFC'));
  const decoded = tryDecodeTaxonomyTerm(trimmed).normalize('NFC');
  if (decoded !== trimmed) aliases.add(decoded);
}

/**
 * Expands a user-supplied taxonomy filter into every spelling it may legitimately match against:
 * the input itself, its decoded form when percent-encoded, and — when local definitions resolve it —
 * its canonical slug, decoded slug, and human-readable name.
 *
 * A workspace stores terms as decoded slugs in frontmatter while a remote article's assigned terms come
 * back as canonical (often percent-encoded) slugs, so comparing one raw string against the other silently
 * yields zero matches for every non-ASCII term. Case is preserved; callers fold case when they compare.
 */
export function taxonomyTermFilterAliases(
  filter: string,
  definitions?: readonly TaxonomyTermAliases[],
): string[] {
  const aliases = new Set<string>();
  pushAlias(aliases, filter);

  if (definitions && definitions.length > 0) {
    const rawFilter = filter.trim();
    const decodedFilter = tryDecodeTaxonomyTerm(rawFilter).normalize('NFC');
    for (const definition of definitions) {
      const canonical = (definition.canonicalSlug || definition.slug || '').trim().normalize('NFC');
      const decodedSlug = tryDecodeTaxonomyTerm(definition.slug || '').normalize('NFC');
      const name = (definition.name || '').trim().normalize('NFC');
      if (!canonical && !decodedSlug && !name) continue;
      const matchesFilter =
        (canonical && (canonical === rawFilter || canonical === decodedFilter)) ||
        (decodedSlug && (decodedSlug === rawFilter || decodedSlug === decodedFilter)) ||
        (name && (name === rawFilter || name === decodedFilter));
      if (!matchesFilter) continue;
      pushAlias(aliases, definition.slug);
      pushAlias(aliases, definition.canonicalSlug);
      pushAlias(aliases, definition.name);
    }
  }

  return Array.from(aliases);
}

/**
 * True when a term carried by an article (a frontmatter spelling or a remote assigned-term slug) refers to
 * the same taxonomy term as the filter, comparing through decoded and canonical spellings rather than raw
 * bytes. Substring matching is preserved so a partial filter keeps behaving as it did before.
 */
export function taxonomyTermMatchesFilter(term: string, filterAliases: readonly string[]): boolean {
  if (!term) return false;
  const decoded = tryDecodeTaxonomyTerm(term).normalize('NFC');
  for (const alias of filterAliases) {
    if (term.includes(alias) || decoded.includes(alias)) return true;
  }
  return false;
}
