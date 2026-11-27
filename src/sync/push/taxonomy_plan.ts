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
import {
  createRemoteTaxonomyTerm,
  loadLocalTaxonomyTerms,
  promoteLocalDraftTerm,
  type loadLocalTaxonomyMaps,
  type LocalTaxonomyTermEntry,
} from '../taxonomies.js';
import { aliasesOf, canonicalSlugOf } from '../../utils/taxonomy-key.js';
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

/**
 * Promotes any offline draft taxonomy terms (`categories/drafts/` or `tags/drafts/`) referenced
 * by the article to remote EmDash in parent-before-child topological order, updating the shared
 * `taxonomyMaps` in-place so subsequent articles in `pushAll()` never double-POST.
 */
export async function promoteDraftTaxonomiesForArticle(params: {
  parsed: ParsedMarkdown;
  taxonomyMaps: ReturnType<typeof loadLocalTaxonomyMaps>;
  options: PushOptions;
  fetchFn: typeof fetch;
}): Promise<
  Array<{ taxonomy: 'category' | 'tag'; provisionalId: string; id: string; slug: string }>
> {
  const { parsed, taxonomyMaps, options, fetchFn } = params;
  if (!parsed.frontmatter.taxonomies) return [];

  const allLocalTerms = loadLocalTaxonomyTerms(options.workspaceRoot);
  const draftById = new Map<string, LocalTaxonomyTermEntry>();
  for (const t of allLocalTerms) {
    if (t.isDraft) {
      draftById.set(t.id, t);
    }
  }
  if (draftById.size === 0) return [];

  const promoted: Array<{
    taxonomy: 'category' | 'tag';
    provisionalId: string;
    id: string;
    slug: string;
  }> = [];
  const provisionalToServerId = new Map<string, string>();
  const visiting = new Set<string>();

  const promoteTermWithAncestors = async (draft: LocalTaxonomyTermEntry): Promise<string> => {
    const already = provisionalToServerId.get(draft.id);
    if (already) return already;
    if (visiting.has(draft.id)) {
      throw new Error(`Circular parentId reference detected in draft taxonomy term "${draft.id}".`);
    }
    visiting.add(draft.id);

    let resolvedParentId = draft.parentId ?? null;
    if (resolvedParentId && draftById.has(resolvedParentId)) {
      resolvedParentId = await promoteTermWithAncestors(draftById.get(resolvedParentId)!);
    }

    const reqSlug = canonicalSlugOf(draft);
    const serverTerm = await createRemoteTaxonomyTerm({
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      fetchFn,
      taxonomy: draft.taxonomy,
      label: draft.name,
      slug: reqSlug,
      locale: draft.locale || parsed.frontmatter.locale || 'ja',
      parentId: resolvedParentId,
      translationOf: draft.translationOf,
      ...(typeof draft.description === 'string' && draft.description
        ? { description: draft.description }
        : {}),
    });

    promoteLocalDraftTerm({
      workspaceRoot: options.workspaceRoot,
      taxonomy: draft.taxonomy,
      draftFilePath: draft.filePath || '',
      serverTerm,
      fallbackLocale: draft.locale || parsed.frontmatter.locale || 'ja',
    });

    // Update shared taxonomyMaps in-place
    const taxKind = draft.taxonomy;
    const oldId = draft.id;
    const canonical = serverTerm.slug;
    delete taxonomyMaps.idToSlug[taxKind][oldId];
    taxonomyMaps.idToSlug[taxKind][serverTerm.id] = canonical;
    taxonomyMaps.slugToId[taxKind][canonical] = serverTerm.id;
    for (const alias of aliasesOf(draft)) {
      if (taxonomyMaps.slugToId[taxKind][alias] === oldId) {
        taxonomyMaps.slugToId[taxKind][alias] = serverTerm.id;
      }
    }
    if (taxonomyMaps.slugToId[taxKind][draft.name] === oldId) {
      taxonomyMaps.slugToId[taxKind][draft.name] = serverTerm.id;
    }

    provisionalToServerId.set(oldId, serverTerm.id);
    draftById.delete(oldId);
    visiting.delete(oldId);
    promoted.push({
      taxonomy: taxKind,
      provisionalId: oldId,
      id: serverTerm.id,
      slug: canonical,
    });
    return serverTerm.id;
  };

  const axes: Array<{ key: 'categories' | 'tags'; kind: 'category' | 'tag' }> = [
    { key: 'categories', kind: 'category' },
    { key: 'tags', kind: 'tag' },
  ];

  for (const { key, kind } of axes) {
    const terms = parsed.frontmatter.taxonomies[key];
    if (!Array.isArray(terms)) continue;
    for (let i = 0; i < terms.length; i++) {
      const term = terms[i];
      const resolvedId = draftById.has(term) ? term : taxonomyMaps.slugToId[kind]?.[term];
      if (resolvedId && draftById.has(resolvedId)) {
        const draft = draftById.get(resolvedId)!;
        const serverId = await promoteTermWithAncestors(draft);
        // If frontmatter held the provisional ULID directly, replace with canonical slug
        if (term === draft.id) {
          terms[i] = taxonomyMaps.idToSlug[kind][serverId] || term;
        }
      }
    }
  }

  return promoted;
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
  remoteTaxAudit?: { categories?: string[] | null; tags?: string[] | null } | null;
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
    remoteTaxAudit,
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
        const taxKey = taxonomyName === 'category' ? 'categories' : 'tags';
        const auditKnown =
          remoteTaxAudit !== null &&
          remoteTaxAudit !== undefined &&
          Array.isArray(remoteTaxAudit[taxKey]);
        const remoteCount = auditKnown ? remoteTaxAudit![taxKey]!.length : null;

        if (remoteCount === 0) {
          // Remote already has 0 assignments: Clean bypass!
          // Remote terms are already deleted on CMS, so sending empty termIds [] cleans up orphan relations safely.
          warnings.push(
            `🏷️ Remote ${taxonomyName} terms were already unassigned; synchronizing empty assignment.`,
          );
        } else {
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
