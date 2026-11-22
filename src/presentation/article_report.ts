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

import type { PrunedTaxonomiesDetail } from '../utils/taxonomy-key.js';
import type { ArticleSearchHit, ArticleSearchResult } from '../sync/article_search/index.js';
import { getLocalTaxonomiesSummary } from '../sync/taxonomies.js';

export type ArticleSearchSnapshotView = NonNullable<ArticleSearchResult['snapshot']>;

export interface MediaSearchSnapshotView {
  capturedAt: string;
  ageDays: number;
  stale: boolean;
  mediaCount: number;
}

export function formatSnapshotAge(capturedAt: string): string {
  const ms = Date.now() - Date.parse(capturedAt);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatSnapshotTimestamp(capturedAt: string): string {
  return capturedAt.slice(0, 16).replace('T', ' ');
}

/**
 * Presentation layer: unified report formatting helpers for CLI and MCP consumers.
 *
 * Shared presentation logic ensures that CLI and MCP outputs maintain identical
 * vocabulary, warning formats, and status representations without cross-consumer
 * coupling (Layer 3 intra-layer isolation).
 */

/**
 * Formats the warning for referenced media storageKeys that could not be resolved
 * against a media record or local mirror during pull.
 */
export function formatOrphanMediaWarning(orphanStorageKeys: string[] | undefined): string {
  if (!orphanStorageKeys || orphanStorageKeys.length === 0) return '';
  const keyList = orphanStorageKeys.join(', ');
  return (
    `⚠️ [UNRESOLVED_MEDIA_ASSET] ${orphanStorageKeys.length} storageKey(s) referenced in article bodies ` +
    `could not be matched to a media record or a local mirror and were not downloaded: ${keyList}. ` +
    `These keys are R2 storage keys, not media record ids — GET /_emdash/api/media/{id} searches the ` +
    `primary key, so a 404 here does not prove the record is missing. The library's own storageKeys are ` +
    `reachable from Emit: run "emit doctor --check-media-library" (or "emit pull-media --all" for complete backup) to index ` +
    `every record the server reports, which resolves these keys without any server-side query. Verify by ` +
    `storageKey before registering anything: a blind INSERT can create a duplicate. Emit mirrors records ` +
    `and never repairs server data.`
  );
}

/**
 * Renders the coverage line for a library-wide media pull: how many records the server reports, how
 * many this run walked, and any referenced key that even a complete walk could not match.
 */
export function formatMediaCoverageLine(res: {
  total: number;
  remoteTotalCount?: number | null;
  referencedUnmirroredStorageKeys?: string[];
}): string {
  const parts: string[] = [];
  const remoteTotal = res.remoteTotalCount;
  if (typeof remoteTotal === 'number' && remoteTotal > 0) {
    parts.push(
      `remote library holds ${remoteTotal} record(s), of which this run walked ${res.total}`,
    );
  }
  const unmirrored = res.referencedUnmirroredStorageKeys;
  if (unmirrored && unmirrored.length > 0) {
    parts.push(
      `⚠️ [UNREFERENCED_REMOTE_MEDIA] ${unmirrored.length} body storageKey(s) match no record in the complete remote library and no local mirror: ${unmirrored.join(', ')}. This is a lookup result, not proof that a record is absent — verify by storageKey (after the complete library walk above) before registering anything, because a blind INSERT can duplicate an existing record. (Note: this remote unreferenced check differs from doctor's media_isolated, which reports mirrored local files unreferenced by any article).`,
    );
  }
  return parts.length > 0 ? `\n${parts.join('\n')}` : '';
}

/**
 * Explains why automatic pruning deleted nothing because the library walk stopped early.
 *
 * Pruning authority is remote records only, and a bounded walk holds no authority over what sits past its
 * window: an unmirrored-looking file may simply be record 101 of a 400-record library. Deleting on that
 * knowledge would break the epistemic rule, so the safe answer is to say so and name the command that does
 * know. Shared by CLI and MCP so neither consumer invents its own wording for the same safety decision.
 */
export function formatPruneSkippedNotice(limit: number | null | undefined): string {
  const window = typeof limit === 'number' && limit > 0 ? ` (${limit})` : '';
  return (
    `ℹ️ Pruning skipped: the media walk stopped at the limit${window} and did not reach the end of the ` +
    `remote library, so deleted records cannot be proven. Run "emit pull-media --all" to prune safely, or ` +
    `raise "mediaSyncLimit" in .emit/config.json.`
  );
}

/**
 * Frames an offline media search as what it is: a view of this workspace's mirrors and nothing else.
 *
 * The failure mode this guards against is inference — an agent that reads a local-only list as the library's
 * truth concludes an absent asset does not exist remotely and re-uploads a duplicate on returning online. So
 * the framing is loud, appears first, and repeats on the empty result.
 */
export function formatOfflineSearchHeader(
  scannedCount: number,
  snapshot?: MediaSearchSnapshotView,
): string {
  if (!snapshot) {
    return (
      `[SOURCE: LOCAL WORKSPACE ONLY (OFFLINE)]\n` +
      `Searched ${scannedCount} mirrored asset(s) in this workspace.\n` +
      `Remote EmDash library was NOT queried.`
    );
  }
  const staleTag = snapshot.stale ? ' ⚠️ [STALE_SNAPSHOT: >7d old]' : '';
  return (
    `[SOURCE: LOCAL WORKSPACE + SNAPSHOT @ ${formatSnapshotTimestamp(snapshot.capturedAt)} (${formatSnapshotAge(snapshot.capturedAt)}) (OFFLINE)]\n` +
    `Searched ${scannedCount} mirrored/cached asset(s) (${snapshot.mediaCount} in snapshot).${staleTag}\n` +
    `Remote EmDash library was NOT queried live.`
  );
}

/** The absence-protection line an offline search must print when it finds nothing. */
export const OFFLINE_SEARCH_EMPTY_NOTICE =
  'No matching media found in local workspace. (Remote EmDash library was NOT checked. The asset may exist remotely.)';

/** The machine-readable counterpart of that framing for MCP JSON payloads. */
export function buildOfflineSearchFraming(snapshot?: MediaSearchSnapshotView): {
  source: 'local_mirrors';
  remoteQueried: false;
  warning: string;
  snapshot?: MediaSearchSnapshotView;
  staleSnapshot?: true;
} {
  return {
    source: 'local_mirrors',
    remoteQueried: false,
    warning:
      'Remote CMS was NOT checked. Absence from this list does NOT prove the asset does not exist remotely.',
    ...(snapshot ? { snapshot } : {}),
    ...(snapshot?.stale ? { staleSnapshot: true as const } : {}),
  };
}

/**
 * Options for rendering article diff summary reports.
 */
export interface ArticleDiffReportOptions {
  targetFile: string;
  targetId: string;
  isModified: boolean;
  baseRev: string;
  baseSavedAt: number; // in epoch seconds
  additions: number;
  deletions: number;
  unifiedDiff: string;
}

/**
 * Renders a standardized line-by-line diff report for an article against its baseline snapshot.
 * Matches the canonical diff format established in diff.ts.
 */
export function formatArticleDiffReport(options: ArticleDiffReportOptions): string {
  return [
    `--- Diff for ${options.targetFile} (${options.targetId}) ---`,
    `Status: ${options.isModified ? '🟡 Modified' : '🟢 In Sync with base snapshot'}`,
    `Base Rev: ${options.baseRev}`,
    `Base Saved At: ${new Date(options.baseSavedAt * 1000).toISOString()}`,
    `Changes: +${options.additions} / -${options.deletions} lines`,
    '',
    'Unified Diff:',
    '----------------------------------------',
    options.unifiedDiff,
    '----------------------------------------',
  ].join('\n');
}

/**
 * Renders a notice informing the user that deleted taxonomy terms were pruned from frontmatter.
 */
export function formatPrunedTaxonomiesNotice(
  pruned: PrunedTaxonomiesDetail | undefined,
): string | null {
  if (!pruned) return null;
  const parts: string[] = [];
  if (pruned.categories && pruned.categories.length > 0) {
    parts.push(`categories: ${JSON.stringify(pruned.categories)}`);
  }
  if (pruned.tags && pruned.tags.length > 0) {
    parts.push(`tags: ${JSON.stringify(pruned.tags)}`);
  }
  if (parts.length === 0) return null;
  return `🏷️ Pruned deleted taxonomy term(s) from frontmatter (${parts.join(', ')}). Push the file to apply changes on remote.`;
}

/**
 * Frames an offline article search as what it is: a view of this workspace's local files only.
 */
export function formatArticleOfflineSearchHeader(
  scannedCount: number,
  snapshot?: ArticleSearchSnapshotView,
): string {
  if (!snapshot) {
    return (
      `[SOURCE: LOCAL WORKSPACE ONLY (OFFLINE)]\n` +
      `Searched ${scannedCount} local article(s) in this workspace.\n` +
      `Remote EmDash library was NOT queried.`
    );
  }
  const staleTag = snapshot.stale ? ' ⚠️ [STALE_SNAPSHOT: >7d old]' : '';
  return (
    `[SOURCE: LOCAL WORKSPACE + SNAPSHOT @ ${formatSnapshotTimestamp(snapshot.capturedAt)} (${formatSnapshotAge(snapshot.capturedAt)}) (OFFLINE)]\n` +
    `Searched ${scannedCount} local/cached article(s) (${snapshot.articleCount} in snapshot).${staleTag}\n` +
    `Remote EmDash library was NOT queried live.`
  );
}

/** The absence-protection line an offline article search must print when it finds nothing. */
export const OFFLINE_ARTICLE_SEARCH_EMPTY_NOTICE =
  'ℹ️ No matching articles found in local workspace. This does NOT prove the article does not exist on remote. Run without --offline to search the remote library.';

/** The machine-readable counterpart of offline article search framing for MCP JSON payloads. */
export function buildOfflineArticleSearchFraming(snapshot?: ArticleSearchSnapshotView): {
  source: 'local_workspace';
  remoteQueried: false;
  warning: string;
  snapshot?: ArticleSearchSnapshotView;
  staleSnapshot?: true;
} {
  return {
    source: 'local_workspace',
    remoteQueried: false,
    warning:
      'Remote CMS was NOT checked. Absence from this list does NOT prove the article does not exist remotely.',
    ...(snapshot ? { snapshot } : {}),
    ...(snapshot?.stale ? { staleSnapshot: true as const } : {}),
  };
}

export interface ArticleSearchHeaderOptions {
  offline?: boolean;
  query?: string;
  since?: string;
  until?: string;
  tag?: string;
  category?: string;
  slug?: string;
}

/**
 * Formats the header line for article search results.
 */
export function formatArticleSearchHeader(
  result: ArticleSearchResult,
  options: ArticleSearchHeaderOptions,
): string {
  if (options.offline) {
    return formatArticleOfflineSearchHeader(result.scannedCount, result.snapshot);
  }

  const filters: string[] = [];
  if (options.query) filters.push(`"${options.query}"`);
  if (options.tag) filters.push(`tag:#${options.tag}`);
  if (options.category) filters.push(`category:${options.category}`);
  if (options.slug) filters.push(`slug:${options.slug}`);
  if (options.since) filters.push(`since ${options.since}`);
  if (options.until) filters.push(`until ${options.until}`);

  const subject = filters.length > 0 ? filters.join(' ') : 'recency browse';
  const modeLabel =
    result.searchMode === 'fts'
      ? 'mode: fts'
      : result.fallbackReason
        ? `mode: scan (fallback: ${result.fallbackReason})`
        : 'mode: scan';

  const taxLabel =
    result.taxonomyFetchCount > 0
      ? ` [taxonomies fetched: ${result.taxonomyFetchCount} GET(s)]`
      : '';
  const taxCacheLabel =
    result.taxonomyCacheHitCount > 0 ? ` [taxonomies cached: ${result.taxonomyCacheHitCount}]` : '';
  const truncLabel = result.truncated ? ' [truncated at limit]' : '';

  return `Article search: ${subject} (${modeLabel}, scanned ${result.scannedCount} article(s))${taxLabel}${taxCacheLabel}${truncLabel}`;
}

/**
 * Formats a single article search hit line.
 */
export function formatArticleSearchHit(hit: ArticleSearchHit, index?: number): string {
  const num = typeof index === 'number' ? `${index + 1}.`.padEnd(4, ' ') : '  ';
  const dateStr = hit.publishedAt?.slice(0, 10) || hit.createdAt?.slice(0, 10) || '----';
  const statusStr = `[${hit.status || 'unknown'}]`;
  const qStr = hit.quarantined ? ' [quarantined — never push]' : '';
  const localStr = hit.isLocal
    ? hit.localPath
      ? `[local: ${hit.localPath}]`
      : '[local]'
    : hit.fromSnapshot
      ? `[snapshot]${hit.bodyUnverified ? ' [body unverified]' : ''}`
      : '[remote only]';
  const enrichedStr = hit.enrichedFromSnapshot
    ? hit.enrichmentStale
      ? ' [enriched: snapshot (unverified)]'
      : ' [enriched: snapshot]'
    : '';

  const lines = [
    `  ${num}${dateStr} ${statusStr} ${hit.title} (id: ${hit.id})${qStr} ${localStr}${enrichedStr}`,
  ];

  if (hit.snippet) {
    lines.push(`     ${hit.snippet}`);
  }
  if (!hit.isLocal && !hit.quarantined) {
    lines.push(`     --> To edit or pull locally: emit pull ${hit.id}`);
  }

  return lines.join('\n');
}

/**
 * Formats the notice when 0 hits were found.
 */
export function formatArticleSearchEmptyNotice(
  result: ArticleSearchResult,
  offline?: boolean,
): string {
  if (offline) {
    return OFFLINE_ARTICLE_SEARCH_EMPTY_NOTICE;
  }
  if (result.walkComplete) {
    return `No match found in the remote article library (${result.scannedCount} articles scanned).`;
  }
  return `No match in the first ${result.scannedCount} article(s).`;
}

/**
 * Formats supplementary hit-limit notice for search walks stopped early.
 * Shared across article and media search (CLI and MCP).
 */
export function formatSearchHitLimitNotice(
  hitCount: number,
  options?: { isMcp?: boolean },
): string {
  const limitSyntax = options?.isMcp ? 'limit' : '--limit';
  return `Hit limit reached at ${hitCount}; raise ${limitSyntax} to see more matches from the same walk.`;
}

/**
 * Formats walk incomplete notice.
 */
export function formatArticleSearchWalkIncompleteNotice(
  result: ArticleSearchResult,
  options?: { limit?: number; isMcp?: boolean },
): string | null {
  if (result.walkComplete) return null;
  const isMcp = Boolean(options?.isMcp);
  const maxScanSyntax = isMcp ? 'maxScan' : '--max-scan';
  const headline = `[WALK_INCOMPLETE] read ${result.scannedCount} article(s) and stopped at ${maxScanSyntax}; absence is not proven.`;
  const hitLimitLine =
    result.truncated && result.hits.length >= (options?.limit ?? 20)
      ? formatSearchHitLimitNotice(result.hits.length, { isMcp })
      : null;
  const guidance = `Narrow the query or raise ${maxScanSyntax} (0 walks the whole library).`;

  if (isMcp) {
    return [headline, hitLimitLine, guidance].filter(Boolean).join(' ');
  }
  return [`⚠️ ${headline}`, ...(hitLimitLine ? [`   ${hitLimitLine}`] : []), `   ${guidance}`].join(
    '\n',
  );
}

/**
 * Formats the offline re-search hint for a remote article search that found nothing
 * or stopped before the end of the library. Returns null when no hint applies.
 */
export function formatArticleSearchOfflineHint(
  result: ArticleSearchResult,
  options?: { offline?: boolean; tag?: string; category?: string; workspaceRoot?: string },
): string | null {
  if (options?.offline) return null;

  const applies = result.hits.length === 0 || result.truncated || !result.walkComplete;
  if (!applies) return null;

  const hasTaxonomyFilter = Boolean(options?.tag || options?.category);
  let taxonomyClause = '';
  if (hasTaxonomyFilter && options?.workspaceRoot) {
    try {
      const summary = getLocalTaxonomiesSummary(options.workspaceRoot);
      if (summary.categories.length > 0 || summary.tags.length > 0) {
        taxonomyClause = ' For taxonomy filters, verify terms first: emit pull-taxonomies';
      }
    } catch {
      // ignore
    }
  }

  if (result.snapshot) {
    const snap = result.snapshot;
    const datePart = formatSnapshotTimestamp(snap.capturedAt).slice(0, 10);
    const agePart = formatSnapshotAge(snap.capturedAt);
    const staleSuffix = snap.stale ? ' ⚠️ stale snapshot (>7d): run emit snapshot first.' : '';
    return (
      `💡 Hint: the full library snapshot (${snap.articleCount} articles @ ${datePart}, ${agePart}) can be searched\n` +
      `   instantly with --offline (zero HTTP).${staleSuffix}${taxonomyClause}`
    );
  }

  return (
    `💡 Hint: workspace-synced articles can be searched instantly with --offline\n` +
    `   (local Markdown bodies, zero HTTP).${taxonomyClause}`
  );
}
