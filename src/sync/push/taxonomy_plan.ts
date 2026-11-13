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

import { ApiError } from '../../client/error.js';
import { articleTermsEndpoint } from '../../client/endpoints.js';
import { readBaselineFrontmatter } from '../../db/baseline.js';
import type { BaseSnapshot } from '../../db/cache.js';
import type { ParsedMarkdown } from '../../utils/frontmatter.js';
import type { loadLocalTaxonomyMaps } from '../taxonomies.js';
import type { PushOptions, ResolvedTaxonomyItem } from './types.js';

export interface TaxonomyPlanResult {
  resolvedTaxonomies: {
    categories?: ResolvedTaxonomyItem[];
    tags?: ResolvedTaxonomyItem[];
    [taxonomy: string]: ResolvedTaxonomyItem[] | undefined;
  };
}

/**
 * Canonicalizes frontmatter taxonomy terms in-place before preflight and payload creation.
 */
export function canonicalizeFrontmatterTaxonomies(
  parsed: ParsedMarkdown,
  taxonomyMaps: ReturnType<typeof loadLocalTaxonomyMaps>,
): TaxonomyPlanResult {
  const resolvedTaxonomies: TaxonomyPlanResult['resolvedTaxonomies'] = {};

  const canonicalizeTerms = (taxName: 'category' | 'tag', terms: string[]): string[] => {
    const list: ResolvedTaxonomyItem[] = [];
    const canonicalized = terms.map((term) => {
      // 1. If term is a ULID in idToSlug
      if (taxonomyMaps.idToSlug[taxName]?.[term]) {
        const canonicalSlug = taxonomyMaps.idToSlug[taxName][term];
        list.push({ input: term, resolved: canonicalSlug, id: term });
        return canonicalSlug;
      }
      // 2. If term is in slugToId (can be canonical slug, decoded slug, or human name alias)
      const id = taxonomyMaps.slugToId[taxName]?.[term];
      if (id && taxonomyMaps.idToSlug[taxName]?.[id]) {
        const canonicalSlug = taxonomyMaps.idToSlug[taxName][id];
        if (term !== canonicalSlug) {
          list.push({ input: term, resolved: canonicalSlug, id });
        }
        return canonicalSlug;
      }
      return term;
    });
    if (list.length > 0) {
      resolvedTaxonomies[taxName === 'category' ? 'categories' : 'tags'] = list;
    }
    return canonicalized;
  };

  if (parsed.frontmatter.taxonomies) {
    if (parsed.frontmatter.taxonomies.categories) {
      parsed.frontmatter.taxonomies.categories = canonicalizeTerms(
        'category',
        parsed.frontmatter.taxonomies.categories,
      );
    }
    if (parsed.frontmatter.taxonomies.tags) {
      parsed.frontmatter.taxonomies.tags = canonicalizeTerms(
        'tag',
        parsed.frontmatter.taxonomies.tags,
      );
    }
  }

  return { resolvedTaxonomies };
}

export interface TaxonomySyncFailure {
  taxonomy: string;
  status: number;
  error: string;
  endpoint: string;
}

/**
 * Synchronizes taxonomy assignments for an article via dedicated terms endpoints.
 */
export async function syncArticleTaxonomies(params: {
  articleId: string;
  collection: string;
  parsed: ParsedMarkdown;
  taxonomyMaps: ReturnType<typeof loadLocalTaxonomyMaps>;
  resolvedTaxonomies: TaxonomyPlanResult['resolvedTaxonomies'];
  baseSnapshot: BaseSnapshot | null | undefined;
  options: PushOptions;
  fetchFn: typeof fetch;
  warnings: string[];
}): Promise<TaxonomySyncFailure[]> {
  const {
    articleId,
    collection,
    parsed,
    taxonomyMaps,
    resolvedTaxonomies,
    baseSnapshot,
    options,
    fetchFn,
    warnings,
  } = params;
  const failures: TaxonomySyncFailure[] = [];
  if (!parsed.frontmatter.taxonomies) return failures;
  const taxMaps = taxonomyMaps;

  const updateTaxonomy = async (taxonomyName: 'category' | 'tag', termSlugsOrIds: string[]) => {
    const slugMap = taxMaps.slugToId[taxonomyName] || {};
    const idMap = taxMaps.idToSlug[taxonomyName] || {};
    const resolvedTermIds = Array.from(
      new Set(
        termSlugsOrIds
          .map((item) => {
            // 1. If item is already a known ULID, preserve it directly to avoid silent substitution
            if (idMap[item]) return item;
            // 2. If item was canonicalized from a specific ULID or alias, preserve the bound term ID
            const tracked = resolvedTaxonomies[taxonomyName === 'category' ? 'categories' : 'tags'];
            const match = tracked?.find((t) => t.resolved === item);
            if (match?.id) return match.id;
            // 3. Fallback to slugMap
            return slugMap[item] || item;
          })
          .filter((tid): tid is string => Boolean(tid)),
      ),
    );

    if (resolvedTermIds.length === 0) {
      // Check if remote previously had assignments in baseline
      const baseFm = readBaselineFrontmatter(baseSnapshot);
      const prevTerms =
        taxonomyName === 'category' ? baseFm?.taxonomies?.categories : baseFm?.taxonomies?.tags;
      if (prevTerms && prevTerms.length > 0) {
        if (!options.allowWipeTaxonomies && !options.force && !options.resolveTaxonomy) {
          throw new ApiError({
            endpoint: `/_emdash/api/content/${collection}/${articleId}/terms/${taxonomyName}`,
            code: 'DESTRUCTIVE_TAXONOMY_WIPE',
            status: 400,
            message: `Local article specified empty array for ${taxonomyName}, which would remove ${prevTerms.length} existing remote assignment(s).`,
            suggestion: `Pass --allow-wipe-taxonomies (or --force) to confirm wiping all ${taxonomyName} assignments.`,
          });
        }
        warnings.push(
          `🏷️ Cleared all ${prevTerms.length} ${taxonomyName} assignment(s) from remote (local specified empty array).`,
        );
      }
    }

    const termsUrl = articleTermsEndpoint(options.origin, collection, articleId, taxonomyName);

    const termRes = await fetchFn(termsUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ termIds: resolvedTermIds }),
    });

    if (!termRes.ok) {
      const errBody = await termRes.text().catch(() => '');
      failures.push({
        taxonomy: taxonomyName,
        status: termRes.status,
        error: errBody || termRes.statusText,
        endpoint: termsUrl,
      });
      warnings.push(`Failed to update ${taxonomyName} terms: ${termRes.statusText} ${errBody}`);
    }
  };

  if (parsed.frontmatter.taxonomies.categories) {
    await updateTaxonomy('category', parsed.frontmatter.taxonomies.categories);
  }
  if (parsed.frontmatter.taxonomies.tags) {
    await updateTaxonomy('tag', parsed.frontmatter.taxonomies.tags);
  }
  return failures;
}
