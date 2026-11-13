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
      `⚠️ [UNREFERENCED_REMOTE_MEDIA] ${unmirrored.length} body storageKey(s) match no record in the complete remote library and no local mirror: ${unmirrored.join(', ')}. This is a lookup result, not proof that a record is absent — verify by storageKey (after the complete library walk above) before registering anything, because a blind INSERT can duplicate an existing record.`,
    );
  }
  return parts.length > 0 ? `\n${parts.join('\n')}` : '';
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
