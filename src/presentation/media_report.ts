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
  formatSearchHitLimitNotice,
  formatSnapshotTimestamp,
  type MediaSearchSnapshotView,
} from './article_report.js';
import type { DeleteMediaItemResult, DeleteMediaResult } from '../sync/media/index.js';

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
 * Formats the media search header (local mirrors + snapshot summary).
 */
export function formatMediaSearchHeader(
  result: MediaSearchResultView,
  options: { subject: string },
): string {
  const truncLabel = result.truncated ? ' [truncated at limit]' : '';
  if (!result.snapshot) {
    return `Media search (local mirrors only — no snapshot): ${options.subject} (searched ${result.scannedCount} asset(s))${truncLabel}`;
  }
  const staleTag = result.snapshot.stale
    ? ` ⚠️ [STALE_SNAPSHOT: ${result.snapshot.ageDays}d old]`
    : '';
  return `Media search (local + snapshot @ ${formatSnapshotTimestamp(result.snapshot.capturedAt)}): ${options.subject} (searched ${result.scannedCount} asset(s), ${result.snapshot.mediaCount} in snapshot)${staleTag}${truncLabel}`;
}

/**
 * Formats the empty-result notice for media search, returning null when hits exist.
 */
export function formatMediaSearchEmptyNotice(result: MediaSearchResultView): string | null {
  if (result.hits.length > 0) return null;
  if (!result.snapshot) {
    return 'No matching media found in local workspace (no snapshot captured yet).';
  }
  return `No matching media found (${result.scannedCount} local/snapshot asset(s) searched).`;
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
 * Formats supplementary hit-limit notice for media search results capped by `limit`.
 * Unifies presentation between CLI and MCP stdio interfaces.
 */
export function formatMediaSearchHitLimitNotice(
  hitCount: number,
  options?: { isMcp?: boolean },
): string {
  return formatSearchHitLimitNotice(hitCount, options);
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

/**
 * Formats a single media deletion item line for CLI / MCP reports.
 */
function formatMediaDeleteItemLines(item: DeleteMediaItemResult, dryRun: boolean): string[] {
  const sizeStr = formatSize(item.size);
  const metaParts: string[] = [];
  if (item.storageKey) metaParts.push(`storageKey ${item.storageKey}`);
  if (sizeStr) metaParts.push(sizeStr);
  const metaSuffix = metaParts.length > 0 ? ` (${metaParts.join(', ')})` : '';
  const idPart = item.mediaId ? ` -> mediaId ${item.mediaId}` : '';

  if (item.action === 'refused') {
    const refs = (item.referencedBy ?? []).join(', ');
    return [
      `   ⛔ refused [MEDIA_IN_USE_PROTECTION]: ${item.target}${idPart} -> referenced by ${refs}`,
    ];
  }

  if (item.action === 'error') {
    const code = item.error?.code ?? 'ERROR';
    const msg = item.error?.message ?? 'Unknown error';
    return [`   ❌ error [${code}]: ${item.target}${idPart} -> ${msg}`];
  }

  if (item.action === 'already-deleted') {
    const backupNote =
      item.backupPaths && item.backupPaths.length > 0
        ? ` (backed up to ${item.backupPaths.join(', ')})`
        : '';
    return [`   ⚠️ already deleted on remote: ${item.target}${idPart}${metaSuffix}${backupNote}`];
  }

  if (dryRun) {
    return [
      `   ✔ would delete: ${item.target}${idPart}${metaSuffix}`,
      `     refs: none (local workspace scan only)`,
    ];
  }

  const backupNote =
    item.backupPaths && item.backupPaths.length > 0
      ? ` (backed up to ${item.backupPaths.join(', ')})`
      : '';
  return [`   ✔ deleted: ${item.target}${idPart}${metaSuffix}${backupNote}`];
}

/**
 * Formats the unified media deletion report shared by CLI (`emit delete-media`) and MCP (`sync_delete_media`).
 */
export function formatMediaDeleteReport(result: DeleteMediaResult): string {
  const count = result.items.length;
  const noun = count === 1 ? '1 target' : `${count} targets`;
  const drySuffix = result.dryRun ? ' — DRY RUN' : '';
  const lines: string[] = [`🗑️  Media Deletion (${noun})${drySuffix}`];

  for (const item of result.items) {
    lines.push(...formatMediaDeleteItemLines(item, result.dryRun));
  }

  for (const w of result.warnings) {
    lines.push(`   ${w}`);
  }

  return lines.join('\n');
}

/**
 * Formats offline media cache statistics produced by `snapshot capture --include-media`.
 */
export function formatMediaCacheSummary(res: {
  mediaCached: number;
  mediaCacheSkipped: number;
  mediaCacheBytes: number;
  mediaCacheBudgetHit: boolean;
  mediaCacheTotalCandidates: number;
}): string {
  const mb = (res.mediaCacheBytes / (1024 * 1024)).toFixed(2);
  const budgetNote = res.mediaCacheBudgetHit
    ? ` ⚠️ [MEDIA_CACHE_BUDGET cached=${res.mediaCached}/${res.mediaCacheTotalCandidates}]`
    : '';
  return `Media cache: ${res.mediaCached} downloaded (${mb} MiB), ${res.mediaCacheSkipped} skipped/existing.${budgetNote}`;
}
