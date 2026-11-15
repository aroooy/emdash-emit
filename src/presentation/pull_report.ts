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

/**
 * Presentation layer: pull summary and notification formatters for CLI and MCP.
 *
 * Consolidates taxonomy synchronization summaries, window labels, and article media
 * reporting to guarantee consistent terminology across interfaces (Layer 3 intra-layer isolation).
 */

export interface TaxonomySyncFailureOptions {
  categoriesFailed?: boolean;
  tagsFailed?: boolean;
  error?: string;
}

/**
 * Formats the warning message when remote taxonomy synchronization fails partially or completely.
 */
export function formatTaxonomySyncFailure(options: TaxonomySyncFailureOptions): string {
  if (options.error) {
    return `⚠️ Taxonomies: Failed to sync remote taxonomies (${options.error}, preserved existing local definitions).`;
  }
  if (options.categoriesFailed && options.tagsFailed) {
    return '⚠️ Taxonomies: Failed to fetch remote categories and tags (preserved existing local definitions).';
  }
  if (options.categoriesFailed) {
    return '⚠️ Taxonomies: Failed to fetch remote categories (preserved existing local definitions).';
  }
  if (options.tagsFailed) {
    return '⚠️ Taxonomies: Failed to fetch remote tags (preserved existing local definitions).';
  }
  return '⚠️ Taxonomies: Failed to sync remote taxonomies (preserved existing local definitions).';
}

export interface TaxonomySyncSuccessCounts {
  categoriesCount: number;
  tagsCount: number;
  deletedCategoriesCount?: number;
  deletedTagsCount?: number;
}

export interface TaxonomySyncSuccessOptions {
  label?: string;
}

/**
 * Formats the success summary line for synchronized categories and tags.
 */
export function formatTaxonomySyncSuccess(
  counts: TaxonomySyncSuccessCounts,
  options?: TaxonomySyncSuccessOptions,
): string {
  const label = options?.label ?? 'Taxonomies';
  const prunedCat = counts.deletedCategoriesCount
    ? `, ${counts.deletedCategoriesCount} categories pruned`
    : '';
  const prunedTag = counts.deletedTagsCount ? `, ${counts.deletedTagsCount} tags pruned` : '';
  return `✅ ${label}: ${counts.categoriesCount} categories, ${counts.tagsCount} tags${prunedCat}${prunedTag}`;
}

export interface ArticleMediaSummaryResult {
  articleId?: string;
  total: number;
  downloaded: number;
  skipped: number;
  failed?: number;
  unresolvedIds?: number;
  verifiedStorageKeys?: string[];
}

/**
 * Renders the per-article media summary. A migrated corpus bakes R2 storageKeys into body URLs, so the
 * ids collected from those URLs mostly resolve to nothing; that is reported as expected resolution data,
 * never as a failure. Only a reference no id lookup and no storageKey check could match is a failure.
 */
export function formatArticleMediaSummary(res: ArticleMediaSummaryResult): string {
  const parts = [`${res.downloaded} downloaded`, `${res.skipped} skipped/up-to-date`];
  if (res.failed) parts.push(`${res.failed} unresolved`);
  const mirrored =
    res.verifiedStorageKeys?.length ?? res.total - (res.failed ?? 0) - res.downloaded - res.skipped;
  if (mirrored > 0) parts.push(`${mirrored} verified/mirrored`);
  const body = parts.join(', ');
  const note =
    res.unresolvedIds && !res.failed
      ? ` (${res.unresolvedIds} body ULID(s) are R2 storageKeys, not media record ids, so no id lookup was expected to match)`
      : '';
  return `✅ Media sync for article '${res.articleId || ''}' complete: ${res.total} referenced item(s) (${body}).${note}`;
}

/**
 * Formats status breakdown label for batch pulls when status is 'all'.
 */
export function formatPullStatusBreakdown(
  status: string | undefined,
  items: Array<{ deleted?: boolean; status?: string }>,
): string {
  if (status !== 'all') return '';
  const publishedCount = items.filter((i) => !i.deleted && i.status === 'published').length;
  const draftCount = items.filter((i) => !i.deleted && i.status === 'draft').length;
  return ` [${publishedCount} published, ${draftCount} draft]`;
}

/**
 * Formats the limit window label for pull summary display.
 */
export function formatPullWindowLabel(status: string | undefined, limit: number): string {
  return status === 'all' ? `${limit}/status` : `${limit}`;
}
