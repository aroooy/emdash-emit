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

import {
  formatOfflineSearchHeader,
  formatSearchHitLimitNotice,
  OFFLINE_SEARCH_EMPTY_NOTICE,
  type MediaSearchSnapshotView,
} from './article_report.js';

export interface MediaSearchHitView {
  mediaId: string;
  storageKey: string | null;
  mirrored: boolean;
  localPath: string | null;
  fromSnapshot?: boolean;
  alt: string | null;
  caption: string | null;
  mimeType: string | null;
  size: number | null;
}

export interface MediaSearchResultView {
  hits: readonly MediaSearchHitView[];
  scannedCount: number;
  walkComplete: boolean;
  totalCount: number | null;
  truncated: boolean;
  snapshot?: MediaSearchSnapshotView;
}

/**
 * Formats byte size into human-readable KB / MB string for media search hits.
 */
export function formatSize(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined) return null;
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Formats the media search header (offline local framing or remote scan summary).
 */
export function formatMediaSearchHeader(
  result: MediaSearchResultView,
  options: { subject: string; offline: boolean },
): string {
  if (options.offline) {
    return formatOfflineSearchHeader(result.scannedCount, result.snapshot);
  }
  const totalLabel =
    result.totalCount !== null ? `${result.totalCount} records` : 'an unknown-size library';
  return `Media search: ${options.subject} (scanned ${result.scannedCount} of ${totalLabel})${result.truncated ? ' [truncated at limit]' : ''}`;
}

/**
 * Formats the empty-result notice for media search, returning null when hits exist.
 */
export function formatMediaSearchEmptyNotice(
  result: MediaSearchResultView,
  options: { offline: boolean },
): string | null {
  if (result.hits.length > 0) return null;
  if (options.offline) {
    return OFFLINE_SEARCH_EMPTY_NOTICE;
  }
  if (result.walkComplete) {
    return `No match found in the remote media library (${result.scannedCount} records scanned).`;
  }
  return `No match in the first ${result.scannedCount} record(s).`;
}

/**
 * Formats a single media search hit as two display lines (ID/status line + metadata detail line).
 */
export function formatMediaSearchHit(hit: MediaSearchHitView, index: number): string[] {
  const num = `${index + 1}.`.padEnd(4, ' ');
  const statusBadge = hit.mirrored
    ? '[mirrored]'
    : hit.fromSnapshot
      ? '[snapshot]'
      : '[not mirrored]';
  const line1 = `  ${num}${hit.mediaId}  storageKey ${hit.storageKey || '(none)'}  ${statusBadge}`;

  const parts: string[] = [];
  if (hit.localPath) parts.push(hit.localPath);
  if (hit.alt) parts.push(`alt: ${hit.alt}`);
  if (hit.caption) parts.push(`caption: ${hit.caption}`);
  if (hit.mimeType) parts.push(hit.mimeType);
  const sizeStr = formatSize(hit.size);
  if (sizeStr) parts.push(sizeStr);

  return [line1, `     ${parts.join('   ')}`];
}

/**
 * Formats supplementary hit-limit notice for media search walks stopped early.
 * Unifies presentation between CLI and MCP stdio interfaces.
 */
export function formatMediaSearchHitLimitNotice(
  hitCount: number,
  options?: { isMcp?: boolean },
): string {
  return formatSearchHitLimitNotice(hitCount, options);
}

/**
 * Formats the [WALK_INCOMPLETE] epistemic warning shared by CLI and MCP media search.
 */
export function formatMediaSearchWalkIncompleteNotice(
  result: MediaSearchResultView,
  options: { isMcp: boolean; limit: number | undefined },
): string | null {
  if (result.walkComplete) return null;
  const maxScanSyntax = options.isMcp ? 'maxScan' : '--max-scan';
  const headline = `[WALK_INCOMPLETE] read ${result.scannedCount} record(s) and stopped at ${maxScanSyntax}; absence is not proven.`;
  const hitLimitLine =
    result.truncated && result.hits.length >= (options.limit ?? 20)
      ? formatMediaSearchHitLimitNotice(result.hits.length, { isMcp: options.isMcp })
      : null;
  const guidance = `Narrow the query or raise ${maxScanSyntax} (0 walks the whole library).`;

  if (options.isMcp) {
    return [headline, hitLimitLine, guidance].filter(Boolean).join(' ');
  }
  return [`⚠️ ${headline}`, ...(hitLimitLine ? [`   ${hitLimitLine}`] : []), `   ${guidance}`].join(
    '\n',
  );
}

/**
 * Formats the usage hint shown after remote media search hits in CLI.
 */
export function formatMediaSearchUsageHint(): string {
  return [
    '💡 To use a hit: write /_emdash/api/media/file/<storageKey> into the article body — pull/push mirrors it',
    '   automatically. For an offline copy first: emit pull-media --storage-key <storageKey>.',
    '   Fleet-scale listing stays on the official EmDash MCP / Admin Dashboard.',
  ].join('\n');
}

/**
 * Formats top tag slugs for `--suggest-keywords`, or null when no tags exist.
 */
export function formatTagSearchHints(tags: Array<{ slug: string }>): string | null {
  if (tags.length === 0) return null;
  const topTags = tags.slice(0, 10).map((t) => `#${t.slug}`);
  return `Tag search hints: ${topTags.join(', ')}`;
}
