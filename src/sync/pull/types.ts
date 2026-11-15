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

import type { CacheDatabase } from '../../db/cache.js';
import type { MapperOptions } from '../../client/mapper.js';
import type { TaxonomyCandidates } from '../../utils/frontmatter.js';
import type { PrunedTaxonomiesDetail, TaxonomyLookupMaps } from '../../utils/taxonomy-key.js';

export interface PullArticleMediaSummary {
  total: number;
  downloaded: number;
  skipped: number;
  mirroredStorageKeys: string[];
  verifiedStorageKeys: string[];
  orphanStorageKeys: string[];
  unresolvedFeaturedImageId?: string;
  mediaFetchFailed?: boolean;
}

export interface MediaMirrorSession {
  mirrorArticleReferencedMedia(options: {
    canonicalMarkdown: string;
    featuredImage?: string | null;
  }): Promise<PullArticleMediaSummary | undefined>;
  finalizeBatchMediaResult(): Promise<{
    walkedCount: number;
    remoteTotalCount: number | null;
    complete: boolean;
    downloaded: number;
    skipped: number;
    mirroredStorageKeys: string[];
    verifiedStorageKeys: string[];
    orphanStorageKeys: string[];
  }>;
}

export interface PullOptions extends MapperOptions {
  workspaceRoot: string;
  cache: CacheDatabase;
  origin: string;
  token: string;
  refreshToken?: string;
  fetchFn?: typeof fetch;
  candidates?: TaxonomyCandidates;
  rawItem?: Record<string, unknown>;
  force?: boolean;
  /**
   * Write mirrored body images into the local file as article-relative `../../media/<storageKey>` references,
   * at the depth derived from the article's own path.
   * The cache baseline always keeps the canonical remote URL, so this only changes the disk spelling and an
   * editor preview can render the image from the mirror. Push restores the canonical form before any payload.
   */
  localMediaRefs?: boolean;
  /**
   * When false, skips on-demand mirroring of media referenced by the article.
   * Defaults to true.
   */
  mediaSync?: boolean;
  /**
   * Optional shared media mirror session across multiple pull operations (e.g. in pullBatch).
   */
  mediaSession?: MediaMirrorSession;
  /**
   * Bounds the library walk a single-article pull uses to resolve body storageKeys and an unresolved
   * `featuredImage` (default `mediaSyncLimit`). Ignored when a shared `mediaSession` already owns the walk.
   */
  mediaSyncLimit?: number;
  /**
   * Epistemic rule: When true, allows pruning nonexistent taxonomy terms from frontmatter during fast-path.
   * Only true when taxonomies were successfully synchronized in the current session and not skipped via postsOnly.
   */
  canPruneTaxonomies?: boolean;
}

export interface PullResult {
  id: string;
  slug: string;
  status: string;
  filePath: string;
  updated: boolean;
  skipped?: boolean;
  deleted?: boolean;
  orphan?: boolean;
  title?: string;
  /** True when the local file has unpushed edits and Emit kept them instead of applying remote changes. */
  localEditsPreserved?: boolean;
  /** True when frontmatter syntax was non-destructively healed while preserving unpushed local body content. */
  healed?: boolean;
  /** True if frontmatter meaning or keys/values were altered during heal (false for syntax-only repair). */
  meaningChanged?: boolean;
  /** Nonexistent taxonomy terms that were pruned from frontmatter during fast-path heal. */
  prunedTaxonomies?: PrunedTaxonomiesDetail;
  /** Local copies that diverged from the last synced baseline and were preserved in `<collection>/conflicts/`. */
  quarantined?: QuarantinedLocalCopy[];
  quarantineFilePath?: string;
  suggestion?: string;
  /** Media assets referenced by this article that were mirrored or verified during pull. */
  media?: PullArticleMediaSummary;
}

/**
 * A local Markdown copy whose content differed from Emit's last synced baseline and was
 * therefore preserved under `<collection>/conflicts/` before the canonical file was written.
 * Quarantined copies are informational only: they are not tracked, pushed, or pruned.
 */
export interface QuarantinedLocalCopy {
  /** Relative path of the local file that would have been overwritten or removed. */
  sourceFilePath: string;
  /** Relative path of the preserved copy inside `<collection>/conflicts/`. */
  quarantineFilePath: string;
  /** Why the copy was preserved: no cache baseline existed, or content diverged from it. */
  reason: 'no-cache-baseline' | 'diverged-from-baseline';
}

export interface RemoteArticleItem {
  id: string;
  slug: string;
  status: string;
  title: string;
  _rev: string;
  rawItem: Record<string, unknown>;
}

export interface ListRemoteArticlesOptions {
  origin: string;
  token: string;
  refreshToken?: string;
  limit?: number;
  all?: boolean;
  status?: 'draft' | 'published' | 'all';
  batchSize?: number;
  fetchFn?: typeof fetch;
}

export interface FastPathContext {
  collection: string;
  id: string;
  options: PullOptions;
  canPruneTaxonomies?: boolean;
  getTaxonomyMaps?: () => TaxonomyLookupMaps;
  fetchAssignedTerms: (taxonomy: 'category' | 'tag') => Promise<string[] | null>;
  getBylineIdToSlug: () => Promise<Record<string, string>>;
  getTaxonomyCandidates: () => TaxonomyCandidates | undefined;
  localizeDiskMarkdown: (
    canonicalContent: string,
    articleRelPath?: string,
    preferLegacyRef?: boolean,
  ) => string;
}
