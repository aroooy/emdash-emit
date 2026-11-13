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

import type { MapperOptions } from '../../client/mapper.js';
import type { CacheDatabase } from '../../db/cache.js';
import type { TaxonomyCandidates } from '../../utils/frontmatter.js';

import type { PreflightError } from '../preflight.js';

export type TaxonomyResolutionStrategy = 'union' | 'local' | 'remote';

export interface PushOptions extends MapperOptions {
  workspaceRoot: string;
  cache: CacheDatabase;
  origin: string;
  token: string;
  refreshToken?: string;
  fetchFn?: typeof fetch;
  allowPublish?: boolean;
  knownTaxonomies?: Record<string, string[]>;
  candidates?: TaxonomyCandidates;
  resolveTaxonomy?: TaxonomyResolutionStrategy;
  force?: boolean;
  /**
   * Explicit confirmation required to clear all remote assignments for a taxonomy.
   */
  allowWipeTaxonomies?: boolean;
  /**
   * Skip pre-PUT audit of remote taxonomy assignments (defaults to false).
   */
  noTaxonomyAudit?: boolean;
  /**
   * Allow push even if unapplied taxonomy updates remain pending in sync_state.
   */
  allowUnappliedTaxonomies?: boolean;
  /**
   * Explicit confirmation required to push an article that is marked delete_pending.
   */
  revive?: boolean;
  /**
   * Write mirrored body images into the local file as article-relative `../../media/<storageKey>` references,
   * at the depth derived from the article's own path.
   */
  localMediaRefs?: boolean;
}

export interface ResolvedTaxonomyItem {
  input: string;
  resolved: string;
  id?: string;
}

export interface PushResult {
  success: boolean;
  id: string;
  rev: string;
  filePath: string;
  previousId?: string;
  previousFilePath?: string;
  conflict: boolean;
  taxonomyConflict?: boolean;
  warnings: string[];
  errors?: PreflightError[];
  resolvedTaxonomies?: {
    categories?: ResolvedTaxonomyItem[];
    tags?: ResolvedTaxonomyItem[];
    [taxonomy: string]: ResolvedTaxonomyItem[] | undefined;
  };
}
