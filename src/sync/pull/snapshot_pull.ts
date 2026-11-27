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

import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from '../../client/error.js';
import { countPreservedOpaqueBlocks } from '../../client/portable-text.js';
import type { CacheDatabase, SnapshotArticleRecord, SnapshotBodySource } from '../../db/cache.js';
import { hasUncommittedDraftRevision } from '../../utils/draft-revision.js';
import {
  extractDatePrefixFromPath,
  serializeMarkdown,
  type Frontmatter,
  type TaxonomyCandidates,
} from '../../utils/frontmatter.js';
import { localizeArticleMediaRefs } from '../../utils/media-body-refs.js';
import { isLocalFileUnmodified } from '../baseline-reconstruction.js';
import { loadLocalTaxonomyCandidates } from '../taxonomies.js';
import { computeTaxonomyHash } from '../terms.js';
import {
  calculateHash,
  commitArticleSnapshot,
  findLocalFilesByUlid,
  resolveCanonicalArticlePath,
} from '../workspace/index.js';
import { quarantineDivergentLocalCopies } from './quarantine.js';
import { restoreSnapshotReferencedMedia } from './media_stage.js';
import type { PullOptions, QuarantinedLocalCopy } from './types.js';

const DEFAULT_STALE_THRESHOLD_DAYS = 30;
const DEFAULT_SNAPSHOT_BATCH_LIMIT = 30;

export interface PullFromSnapshotOptions {
  workspaceRoot: string;
  cache: CacheDatabase;
  collection?: string;
  id?: string;
  status?: 'all' | 'draft' | 'published';
  limit?: number;
  all?: boolean;
  force?: boolean;
  localMediaRefs?: boolean;
  restoreMedia?: boolean;
  staleThresholdDays?: number;
  onProgress?: (progress: { current: number; total: number; item: PullFromSnapshotResult }) => void;
}

export interface PullFromSnapshotResult {
  id: string;
  slug: string;
  status: string;
  filePath: string;
  updated: boolean;
  skipped?: boolean;
  localEditsPreserved?: boolean;
  title?: string;
  bodySource: SnapshotBodySource;
  degradedFields: string[];
  snapshotCapturedAt: number;
  mediaRestored?: number;
  mediaMissing?: number;
  mediaSkipped?: number;
  preservedBlocks?: number;
  quarantined?: QuarantinedLocalCopy[];
  warnings: string[];
}

export interface PullFromSnapshotBatchResult {
  collection: string;
  snapshotCapturedAt: number;
  staleDays: number;
  isStale: boolean;
  total: number;
  updated: number;
  skipped: number;
  preserved: number;
  mediaRestored: number;
  mediaMissing: number;
  mediaSkipped: number;
  items: PullFromSnapshotResult[];
  warnings: string[];
}

function parseJsonStringArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseSeoJson(raw: string | undefined): Frontmatter['seo'] {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const obj = parsed as Record<string, unknown>;
    if (Object.keys(obj).length === 0) return undefined;
    return {
      title: obj.title ? String(obj.title) : null,
      description: obj.description ? String(obj.description) : null,
      canonical: obj.canonical ? String(obj.canonical) : null,
      noIndex: Boolean(obj.noIndex),
      image: obj.image ? String(obj.image) : null,
    };
  } catch {
    return undefined;
  }
}

function restoreSnapshotArticle(
  row: SnapshotArticleRecord,
  options: PullFromSnapshotOptions,
  candidates: TaxonomyCandidates,
  bylineIdToSlug: Record<string, string>,
  globalWarnings: string[],
): PullFromSnapshotResult {
  const isV6LegacyRow = row.locale === null || row.locale === undefined;
  const categories = parseJsonStringArray(row.categoriesJson);
  const tags = parseJsonStringArray(row.tagsJson);
  const seo = parseSeoJson(row.seoJson);
  const bylines = parseJsonStringArray(row.bylinesJson).map((b) => bylineIdToSlug[b] || b);

  const degradedFields: string[] = [];
  if (isV6LegacyRow) {
    degradedFields.push('featuredImage', 'seo', 'locale', 'bylines');
  }
  if (row.taxonomyVerified === 0) {
    degradedFields.push('taxonomies');
  }
  if (row.bodySource === 'list-stale') {
    degradedFields.push('body');
  }

  const itemWarnings = [...globalWarnings];
  if (isV6LegacyRow) {
    itemWarnings.push(
      'Schema v6 snapshot row: featuredImage, seo, locale, bylines unavailable (run "emit snapshot capture" to upgrade).',
    );
  }

  const frontmatter: Frontmatter = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    collection: row.collection,
    status: row.status === 'published' ? 'published' : 'draft',
    publishedAt: row.publishedAt ?? null,
    locale: row.locale || 'ja',
    ...(row.featuredImage ? { featuredImage: row.featuredImage } : {}),
    taxonomies: {
      categories,
      tags,
    },
    seo,
    bylines,
  };

  const hasDraftRevision = row.comparisonRev.includes('@draft:');
  // Sanity-check: align with hasUncommittedDraftRevision semantics
  const draftAnnotation =
    hasDraftRevision &&
    hasUncommittedDraftRevision({
      status: frontmatter.status,
      remoteRev: row.comparisonRev,
    });

  const canonicalMarkdown = serializeMarkdown(frontmatter, row.bodyMarkdown, candidates, {
    hasDraftRevision: draftAnnotation,
  });

  const existingSync = options.cache.getSyncState(row.id);
  const localFiles = findLocalFilesByUlid(options.workspaceRoot, row.collection, row.id);
  const existingPrefix = existingSync
    ? extractDatePrefixFromPath(existingSync.localFilePath)
    : localFiles[0]
      ? extractDatePrefixFromPath(localFiles[0])
      : undefined;

  const relPath = resolveCanonicalArticlePath(
    row.collection,
    frontmatter.status,
    row.id,
    row.title,
    {
      publishedAt: row.publishedAt ?? null,
      createdAt: row.createdAt ?? null,
      updatedAt: row.updatedAt ?? null,
    },
    existingPrefix,
    frontmatter.locale,
  );

  const useLocalMediaRefs = options.localMediaRefs !== false;
  const diskContent = useLocalMediaRefs
    ? localizeArticleMediaRefs(canonicalMarkdown, {
        workspaceRoot: options.workspaceRoot,
        articleRelPath: relPath,
        fs,
      })
    : canonicalMarkdown;

  const preservedBlocks = countPreservedOpaqueBlocks(diskContent);

  if (!options.force && existingSync) {
    const fullExistingPath = path.resolve(options.workspaceRoot, existingSync.localFilePath);
    if (fs.existsSync(fullExistingPath)) {
      const currentDiskContent = fs.readFileSync(fullExistingPath, 'utf8');
      const isUnmodified =
        calculateHash(currentDiskContent) === existingSync.localHash ||
        isLocalFileUnmodified({
          workspaceRoot: options.workspaceRoot,
          cache: options.cache,
          id: row.id,
          relPath: existingSync.localFilePath,
          localContent: currentDiskContent,
          syncState: existingSync,
          candidates,
          healOnSpellingMatch: false,
        });

      if (!isUnmodified) {
        return {
          id: row.id,
          slug: row.slug,
          status: frontmatter.status,
          filePath: existingSync.localFilePath,
          updated: false,
          skipped: true,
          localEditsPreserved: true,
          title: row.title,
          bodySource: row.bodySource,
          degradedFields,
          snapshotCapturedAt: row.capturedAt,
          preservedBlocks: countPreservedOpaqueBlocks(currentDiskContent),
          warnings: itemWarnings,
        };
      }
    }
  }

  // Quarantine any divergent untracked local copies before overwriting
  const localRelPaths = new Set<string>(localFiles);
  if (existingSync?.localFilePath) {
    localRelPaths.add(existingSync.localFilePath);
  }
  const baseSnapshot = options.cache.getBaseSnapshot(row.id);
  const quarantined = quarantineDivergentLocalCopies(
    {
      workspaceRoot: options.workspaceRoot,
      cache: options.cache,
      origin: '',
      token: '',
      force: options.force,
    } as PullOptions,
    row.collection,
    localRelPaths,
    baseSnapshot?.hash || existingSync?.localHash,
    diskContent,
    existingSync?.conflictCopyHash,
    existingSync,
    candidates,
  );

  // Clean up old relocated canonical files for this ULID if path changed
  for (const oldRel of localRelPaths) {
    if (oldRel === relPath) continue;
    const oldFull = path.resolve(options.workspaceRoot, oldRel);
    if (fs.existsSync(oldFull)) {
      try {
        fs.unlinkSync(oldFull);
      } catch {
        // Ignore cleanup failure on relocated file
      }
    }
  }

  const sentinelRev = `snapshot:${row.comparisonRev}`;
  commitArticleSnapshot(options.cache, options.workspaceRoot, {
    id: row.id,
    relPath,
    diskContent,
    canonicalContent: canonicalMarkdown,
    frontmatter,
    bodyMarkdown: row.bodyMarkdown,
    revForTransport: sentinelRev,
    revForComparison: row.comparisonRev,
    flags: {
      remoteTaxonomyHash: computeTaxonomyHash(categories, tags),
      taxonomyApplyPending: 0,
    },
  });

  options.cache.saveEntry({
    id: row.id,
    collection: row.collection,
    slug: row.slug,
    status: frontmatter.status,
    title: row.title,
    rev: sentinelRev,
    publishedAt: row.publishedAt ?? null,
    rawJson: JSON.stringify({
      source: 'snapshot',
      capturedAt: row.capturedAt,
      id: row.id,
      slug: row.slug,
      status: frontmatter.status,
      locale: frontmatter.locale,
    }),
    updatedAt: Math.floor(Date.now() / 1000),
  });

  const mediaRes =
    options.restoreMedia !== false
      ? restoreSnapshotReferencedMedia({
          workspaceRoot: options.workspaceRoot,
          cache: options.cache,
          canonicalMarkdown,
          featuredImage: frontmatter.featuredImage,
        })
      : { referencedCount: 0, restored: 0, skipped: 0, missing: 0, corruptKeys: [], warnings: [] };

  const capturedIso = new Date(row.capturedAt).toISOString();
  const resolvedMediaWarnings: string[] = [];
  if (mediaRes.referencedCount > 0 && mediaRes.missing === 0 && mediaRes.corruptKeys.length === 0) {
    resolvedMediaWarnings.push(
      `[MEDIA_CACHE captured_at=${capturedIso} restored=${mediaRes.restored} missing=0 skipped=${mediaRes.skipped}]`,
    );
  } else {
    if (mediaRes.restored > 0 || mediaRes.skipped > 0) {
      resolvedMediaWarnings.push(
        `[MEDIA_CACHE captured_at=${capturedIso} restored=${mediaRes.restored} missing=${mediaRes.missing} skipped=${mediaRes.skipped}]`,
      );
    }
    resolvedMediaWarnings.push(...mediaRes.warnings);
    resolvedMediaWarnings.push(
      '[MEDIA_NOT_GUARANTEED] mirrored assets only; run pull-media when back online',
    );
  }

  return {
    id: row.id,
    slug: row.slug,
    status: frontmatter.status,
    filePath: relPath,
    updated: true,
    title: row.title,
    bodySource: row.bodySource,
    degradedFields,
    snapshotCapturedAt: row.capturedAt,
    mediaRestored: mediaRes.restored,
    mediaMissing: mediaRes.missing,
    mediaSkipped: mediaRes.skipped,
    preservedBlocks,
    quarantined: quarantined.length > 0 ? quarantined : undefined,
    warnings: [...itemWarnings, ...resolvedMediaWarnings],
  };
}

/**
 * Restores one or more articles from the local `.emit/cache.db` snapshot catalog without making
 * any network requests. Stores a `snapshot:<comparisonRev>` sentinel in `base_snapshots.rev` so
 * offline `status` and `diff` work immediately while `push` is blocked (`PULL_REQUIRED_BEFORE_PUSH`)
 * until the next online `pull` promotes the baseline to a live Track 1 `_rev` token.
 */
export function pullFromSnapshot(
  options: PullFromSnapshotOptions & { id: string },
): PullFromSnapshotResult;
export function pullFromSnapshot(
  options: PullFromSnapshotOptions & { id?: undefined },
): PullFromSnapshotBatchResult;
export function pullFromSnapshot(
  options: PullFromSnapshotOptions,
): PullFromSnapshotResult | PullFromSnapshotBatchResult;
export function pullFromSnapshot(
  options: PullFromSnapshotOptions,
): PullFromSnapshotResult | PullFromSnapshotBatchResult {
  const collection = options.collection || 'posts';
  const meta = options.cache.getSnapshotMeta(collection);

  if (!meta) {
    throw new ApiError({
      endpoint: 'snapshot://cache.db',
      code: 'SNAPSHOT_NOT_AVAILABLE',
      status: 404,
      message: `No captured snapshot found for collection "${collection}" in .emit/cache.db.`,
      suggestion: 'Run "emit snapshot capture" while online before using --from-snapshot.',
    });
  }

  const thresholdDays = options.staleThresholdDays ?? DEFAULT_STALE_THRESHOLD_DAYS;
  const ageMs = Math.max(0, Date.now() - meta.capturedAt);
  const staleDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
  const isStale = ageMs > thresholdDays * 86_400_000;
  const capturedIso = new Date(meta.capturedAt).toISOString();

  const globalWarnings: string[] = [`[SNAPSHOT_FALLBACK captured_at=${capturedIso}]`];
  if (isStale) {
    globalWarnings.push(`[SNAPSHOT_STALE age=${staleDays}d threshold=${thresholdDays}d]`);
  }

  const candidates = loadLocalTaxonomyCandidates(options.workspaceRoot);
  const bylineIdToSlug = options.cache.getBylineMaps().idToSlug;

  if (options.id) {
    const row = options.cache.getSnapshotArticle(options.id);
    if (!row || row.collection !== collection) {
      throw new ApiError({
        endpoint: 'snapshot://cache.db',
        code: 'SNAPSHOT_MISS',
        status: 404,
        message: `Article "${options.id}" was not found in the local snapshot (captured at ${capturedIso}). Absence in the snapshot does not prove the article does not exist on remote.`,
        suggestion:
          'Connect to the network and run "emit pull <id>" to fetch from remote, or run "emit snapshot capture" to refresh the snapshot.',
      });
    }
    return restoreSnapshotArticle(row, options, candidates, bylineIdToSlug, globalWarnings);
  }

  const allRows = options.cache.listSnapshotArticles(collection);
  allRows.sort((a, b) => {
    const dateA = a.publishedAt ?? a.createdAt ?? '';
    const dateB = b.publishedAt ?? b.createdAt ?? '';
    const cmp = dateB.localeCompare(dateA);
    return cmp !== 0 ? cmp : b.id.localeCompare(a.id);
  });

  const statusFilter = options.status || 'all';
  const limit = options.all
    ? Number.POSITIVE_INFINITY
    : (options.limit ?? DEFAULT_SNAPSHOT_BATCH_LIMIT);

  let selectedRows: SnapshotArticleRecord[];
  if (statusFilter === 'all') {
    const publishedRows = allRows.filter((r) => r.status === 'published').slice(0, limit);
    const draftRows = allRows.filter((r) => r.status !== 'published').slice(0, limit);
    selectedRows = [...publishedRows, ...draftRows];
  } else if (statusFilter === 'published') {
    selectedRows = allRows.filter((r) => r.status === 'published').slice(0, limit);
  } else {
    selectedRows = allRows.filter((r) => r.status !== 'published').slice(0, limit);
  }

  const items: PullFromSnapshotResult[] = [];
  let updated = 0;
  let skipped = 0;
  let preserved = 0;
  let mediaRestored = 0;
  let mediaMissing = 0;
  let mediaSkipped = 0;

  for (let i = 0; i < selectedRows.length; i++) {
    const item = restoreSnapshotArticle(
      selectedRows[i]!,
      options,
      candidates,
      bylineIdToSlug,
      globalWarnings,
    );
    items.push(item);
    mediaRestored += item.mediaRestored ?? 0;
    mediaMissing += item.mediaMissing ?? 0;
    mediaSkipped += item.mediaSkipped ?? 0;
    if (item.localEditsPreserved) {
      preserved++;
      skipped++;
    } else if (item.skipped) {
      skipped++;
    } else if (item.updated) {
      updated++;
    }
    options.onProgress?.({ current: i + 1, total: selectedRows.length, item });
  }

  const batchWarnings = [...globalWarnings];
  if (mediaMissing > 0 || (mediaRestored === 0 && mediaSkipped === 0)) {
    batchWarnings.push(
      '[MEDIA_NOT_GUARANTEED] mirrored assets only; run pull-media when back online',
    );
  } else {
    batchWarnings.push(
      `[MEDIA_CACHE captured_at=${capturedIso} restored=${mediaRestored} missing=0 skipped=${mediaSkipped}]`,
    );
  }

  return {
    collection,
    snapshotCapturedAt: meta.capturedAt,
    staleDays,
    isStale,
    total: items.length,
    updated,
    skipped,
    preserved,
    mediaRestored,
    mediaMissing,
    mediaSkipped,
    items,
    warnings: batchWarnings,
  };
}
