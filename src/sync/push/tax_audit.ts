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

import { readBaselineFrontmatter } from '../../db/baseline.js';
import type { BaseSnapshot, SyncState } from '../../db/cache.js';
import type { ParsedMarkdown } from '../../utils/frontmatter.js';
import { fetchAssignedTaxonomies, computeTaxonomyHash } from '../terms.js';
import type { PushOptions } from './types.js';

export interface TaxonomyAuditResult {
  remoteTaxAudit: { categories: string[] | null; tags: string[] | null } | null;
  taxonomyDivergenceDetected: boolean;
}

/**
 * Pre-PUT Taxonomy Audit to detect out-of-band remote taxonomy changes before updating an article.
 */
export async function auditRemoteTaxonomies(params: {
  collection: string;
  id: string;
  parsed: ParsedMarkdown;
  syncState: SyncState | null | undefined;
  baseSnapshot: BaseSnapshot | null | undefined;
  options: PushOptions;
  fetchFn: typeof fetch;
  warnings: string[];
}): Promise<TaxonomyAuditResult> {
  const { collection, id, parsed, syncState, baseSnapshot, options, fetchFn, warnings } = params;

  let remoteTaxAudit: { categories: string[] | null; tags: string[] | null } | null = null;
  let taxonomyDivergenceDetected = false;

  const baseFm = readBaselineFrontmatter(baseSnapshot);
  const hasLocalTaxonomies = Boolean(
    parsed.frontmatter.taxonomies &&
    (parsed.frontmatter.taxonomies.categories !== undefined ||
      parsed.frontmatter.taxonomies.tags !== undefined),
  );
  const hasBaseTaxonomies = Boolean(
    baseFm?.taxonomies && (baseFm.taxonomies.categories || baseFm.taxonomies.tags),
  );

  if ((hasLocalTaxonomies || hasBaseTaxonomies) && !options.noTaxonomyAudit) {
    remoteTaxAudit = await fetchAssignedTaxonomies({
      origin: options.origin,
      token: options.token,
      collection,
      id,
      fetchFn,
    });

    if (remoteTaxAudit.categories === null && remoteTaxAudit.tags === null) {
      warnings.push('⚠️ Remote taxonomy state unknown (could not audit remote terms).');
    } else {
      if (remoteTaxAudit.categories === null) {
        warnings.push('⚠️ Remote category taxonomy state unknown (could not audit categories).');
      }
      if (remoteTaxAudit.tags === null) {
        warnings.push('⚠️ Remote tag taxonomy state unknown (could not audit tags).');
      }
      const baselineTaxHash =
        syncState?.remoteTaxonomyHash ||
        (baseFm?.taxonomies
          ? computeTaxonomyHash(baseFm.taxonomies.categories, baseFm.taxonomies.tags)
          : null);

      const currentRemoteCats =
        remoteTaxAudit.categories !== null
          ? remoteTaxAudit.categories
          : baseFm?.taxonomies?.categories || [];
      const currentRemoteTags =
        remoteTaxAudit.tags !== null ? remoteTaxAudit.tags : baseFm?.taxonomies?.tags || [];

      const currentRemoteTaxHash = computeTaxonomyHash(currentRemoteCats, currentRemoteTags);

      if (baselineTaxHash && currentRemoteTaxHash !== baselineTaxHash) {
        taxonomyDivergenceDetected = true;
      }
    }
  }

  return { remoteTaxAudit, taxonomyDivergenceDetected };
}
