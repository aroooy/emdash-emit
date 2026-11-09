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
import type { CacheDatabase } from '../db/cache.js';
import { parseMarkdown, lenientRepairMarkdownFrontmatter } from '../utils/frontmatter.js';
import { computeContextDiff } from './diff.js';
import { calculateHash } from './pull.js';

export type ConflictFileType = 'conflict' | 'dropped' | 'deleted' | 'unknown';

export interface ConflictItem {
  filePath: string;
  fileName: string;
  type: ConflictFileType;
  id?: string;
  slug?: string;
  title?: string;
  status?: string;
  canonicalPath?: string | null;
  sizeBytes: number;
  createdAt: string;
}

export interface ConflictDiffResult {
  conflictFilePath: string;
  canonicalFilePath: string | null;
  type: ConflictFileType;
  id?: string;
  slug?: string;
  hasDifferences: boolean;
  additions: number;
  deletions: number;
  diffText: string;
}

export interface ConflictResolutionResult {
  success: boolean;
  strategy: 'accept-local' | 'accept-canonical';
  conflictFilePath: string;
  canonicalFilePath?: string | null;
  message: string;
  warnings?: string[];
}

export class CanonicalHasUnpushedEditsError extends Error {
  public code = 'CANONICAL_HAS_UNPUSHED_EDITS';
  public canonicalFilePath: string;
  public conflictFilePath: string;
  public id: string;
  public suggestion: string;

  constructor(details: { canonicalFilePath: string; conflictFilePath: string; id: string }) {
    super(
      `ABORT: Canonical article "${details.canonicalFilePath}" contains unpushed local modifications. Overwriting it with quarantined copy "${details.conflictFilePath}" would lose those edits.`,
    );
    this.name = 'CanonicalHasUnpushedEditsError';
    this.canonicalFilePath = details.canonicalFilePath;
    this.conflictFilePath = details.conflictFilePath;
    this.id = details.id;
    this.suggestion = `Inspect differences first with "emit conflicts diff ${details.conflictFilePath}" or "emit diff ${details.canonicalFilePath}". If you explicitly intend to discard canonical edits and overwrite, pass --force (or MCP force: true).`;
  }
}

export class QuarantinedPathRequiredError extends Error {
  public code = 'QUARANTINED_PATH_REQUIRED';
  public filePath: string;
  public collection: string;
  public suggestion: string;

  constructor(details: { filePath: string; collection: string }) {
    super(
      `Target file must be located inside ${details.collection}/conflicts/: ${details.filePath}`,
    );
    this.name = 'QuarantinedPathRequiredError';
    this.filePath = details.filePath;
    this.collection = details.collection;
    this.suggestion = `Specify a quarantined conflict file path located inside ${details.collection}/conflicts/. Run "emit conflicts list" (or MCP sync_conflicts action: "list") to inspect valid targets.`;
  }
}

/**
 * Strips the conflict/deletion suffix to recover the original article filename base.
 * e.g. "20261108_01M6...-my-slug.conflict.md" -> "20261108_01M6...-my-slug"
 *      "20261108_01M6...-my-slug.deleted.md"  -> "20261108_01M6...-my-slug"
 */
export function extractBaseArticleName(fileName: string): string {
  if (fileName.endsWith('.conflict.md')) {
    return fileName.slice(0, -'.conflict.md'.length);
  }
  if (fileName.endsWith('.deleted.md')) {
    return fileName.slice(0, -'.deleted.md'.length);
  }
  if (fileName.endsWith('.md')) {
    return fileName.slice(0, -'.md'.length);
  }
  return fileName;
}

/**
 * Resolves the canonical live file corresponding to a quarantined conflict or deleted backup.
 */
export function findCanonicalArticlePath(
  workspaceRoot: string,
  baseName: string,
  articleId?: string,
  collection = 'posts',
): string | null {
  const candidateDraft = path.join(collection, 'draft', `${baseName}.md`);
  if (fs.existsSync(path.join(workspaceRoot, candidateDraft))) {
    return candidateDraft;
  }

  const candidatePublished = path.join(collection, 'published', `${baseName}.md`);
  if (fs.existsSync(path.join(workspaceRoot, candidatePublished))) {
    return candidatePublished;
  }

  // If exact baseName doesn't match, attempt search by ULID in draft and published dirs
  if (articleId && articleId.length === 26) {
    for (const sub of ['draft', 'published']) {
      const dir = path.join(workspaceRoot, collection, sub);
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        const match = files.find((f) => f.includes(articleId) && f.endsWith('.md'));
        if (match) {
          return path.join(collection, sub, match);
        }
      }
    }
  }

  return null;
}

/**
 * Lists all quarantined conflict files and deleted rescue copies in posts/conflicts/.
 */
export function listConflicts(workspaceRoot: string, collection = 'posts'): ConflictItem[] {
  const conflictsDir = path.join(workspaceRoot, collection, 'conflicts');
  if (!fs.existsSync(conflictsDir)) {
    return [];
  }

  const entries = fs.readdirSync(conflictsDir, { withFileTypes: true });
  const items: ConflictItem[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }

    const fileName = entry.name;
    const relPath = path.join(collection, 'conflicts', fileName);
    const fullPath = path.join(conflictsDir, fileName);

    let type: ConflictFileType = 'unknown';
    if (/\.deleted(-\d+)?\.md$/i.test(fileName)) {
      type = 'deleted';
    } else if (/\.local-dropped(-\d+)?\.md$/i.test(fileName)) {
      type = 'dropped';
    } else if (/\.conflict(-\d+)?\.md$/i.test(fileName)) {
      type = 'conflict';
    }

    let id: string | undefined;
    let slug: string | undefined;
    let title: string | undefined;
    let status: string | undefined;

    let sizeBytes = 0;
    let createdAt = new Date().toISOString();

    try {
      const stats = fs.statSync(fullPath);
      sizeBytes = stats.size;
      createdAt = stats.mtime.toISOString();
    } catch {
      // Ignore stat error
    }

    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const parsed = parseMarkdown(content);
      id = parsed.frontmatter.id;
      slug = parsed.frontmatter.slug;
      title = parsed.frontmatter.title;
      status = parsed.frontmatter.status;
    } catch {
      // Lenient fallback
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const healed = lenientRepairMarkdownFrontmatter(content);
        if (healed) {
          const parsed = parseMarkdown(healed);
          id = parsed.frontmatter.id;
          slug = parsed.frontmatter.slug;
          title = parsed.frontmatter.title;
          status = parsed.frontmatter.status;
        }
      } catch {
        // Unparseable frontmatter
      }
    }

    const baseName = extractBaseArticleName(fileName);
    const canonicalPath = findCanonicalArticlePath(workspaceRoot, baseName, id, collection);

    items.push({
      filePath: relPath,
      fileName,
      type,
      id,
      slug,
      title,
      status,
      canonicalPath,
      sizeBytes,
      createdAt,
    });
  }

  // Sort newest first
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items;
}

/**
 * Resolves a user-provided file query (path or basename) to an existing conflict file.
 */
function resolveConflictFile(
  workspaceRoot: string,
  filePathOrName: string,
  collection = 'posts',
): { relPath: string; fullPath: string; fileName: string } {
  const norm = filePathOrName.trim();
  const conflictsDir = path.resolve(workspaceRoot, collection, 'conflicts');

  const checkInside = (p: string) => {
    const rel = path.relative(conflictsDir, p);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  };

  const directFull = path.isAbsolute(norm) ? norm : path.resolve(workspaceRoot, norm);
  if (fs.existsSync(directFull) && fs.statSync(directFull).isFile()) {
    if (!checkInside(directFull)) {
      throw new QuarantinedPathRequiredError({
        filePath: filePathOrName,
        collection,
      });
    }
    const relPath = path.relative(workspaceRoot, directFull);
    return { relPath, fullPath: directFull, fileName: path.basename(directFull) };
  }

  // Check inside collection/conflicts
  const insideFull = path.join(conflictsDir, path.basename(norm));
  if (fs.existsSync(insideFull) && fs.statSync(insideFull).isFile()) {
    const relPath = path.relative(workspaceRoot, insideFull);
    return { relPath, fullPath: insideFull, fileName: path.basename(insideFull) };
  }

  throw new Error(`Conflict file not found: ${filePathOrName}`);
}

/**
 * Computes a diff between the quarantined conflict/deleted copy and the canonical article.
 */
export function diffConflict(options: {
  workspaceRoot: string;
  filePath: string;
  collection?: string;
}): ConflictDiffResult {
  const collection = options.collection || 'posts';
  const { relPath, fullPath, fileName } = resolveConflictFile(
    options.workspaceRoot,
    options.filePath,
    collection,
  );

  const conflictContent = fs.readFileSync(fullPath, 'utf8');
  let type: ConflictFileType = 'unknown';
  if (/\.deleted(-\d+)?\.md$/i.test(fileName)) {
    type = 'deleted';
  } else if (/\.local-dropped(-\d+)?\.md$/i.test(fileName)) {
    type = 'dropped';
  } else if (/\.conflict(-\d+)?\.md$/i.test(fileName)) {
    type = 'conflict';
  }

  let id: string | undefined;
  let slug: string | undefined;
  try {
    const parsed = parseMarkdown(conflictContent);
    id = parsed.frontmatter.id;
    slug = parsed.frontmatter.slug;
  } catch {
    // Lenient
  }

  const baseName = extractBaseArticleName(fileName);
  const canonicalRel = findCanonicalArticlePath(options.workspaceRoot, baseName, id, collection);

  if (!canonicalRel) {
    // Canonical file is absent (e.g. deleted copy)
    const lineCount = conflictContent.split('\n').length;
    return {
      conflictFilePath: relPath,
      canonicalFilePath: null,
      type,
      id,
      slug,
      hasDifferences: true,
      additions: lineCount,
      deletions: 0,
      diffText: `Canonical article is absent (deleted or not found).\nQuarantined copy (${type}): ${lineCount} lines.`,
    };
  }

  const canonicalFull = path.join(options.workspaceRoot, canonicalRel);
  const canonicalContent = fs.readFileSync(canonicalFull, 'utf8');

  const diffResult = computeContextDiff(canonicalContent, conflictContent, {
    baseLabel: `canonical: ${canonicalRel}`,
    localLabel: `quarantined: ${relPath}`,
  });

  return {
    conflictFilePath: relPath,
    canonicalFilePath: canonicalRel,
    type,
    id,
    slug,
    hasDifferences: diffResult.hasChanges,
    additions: diffResult.additions,
    deletions: diffResult.deletions,
    diffText: diffResult.unifiedDiff,
  };
}

/**
 * Resolves a quarantined conflict file with either accept-local or accept-canonical strategy.
 */
export function resolveConflict(options: {
  workspaceRoot: string;
  cache: CacheDatabase;
  filePath: string;
  strategy: 'accept-local' | 'accept-canonical';
  force?: boolean;
  collection?: string;
}): ConflictResolutionResult {
  const collection = options.collection || 'posts';
  const { relPath, fullPath, fileName } = resolveConflictFile(
    options.workspaceRoot,
    options.filePath,
    collection,
  );

  if (options.strategy === 'accept-canonical') {
    // Try to extract article ID to clear conflict flags in cache
    let id: string | null = null;
    try {
      const conflictContent = fs.readFileSync(fullPath, 'utf8');
      const idMatch = conflictContent.match(/^id:\s*['"]?([^\s\r\n'"]+)['"]?/m);
      if (idMatch && idMatch[1] && idMatch[1] !== 'unknown') {
        id = idMatch[1].trim();
      }
    } catch {
      // Ignore read error
    }

    if (!id) {
      const baseName = extractBaseArticleName(fileName);
      const match = baseName.match(/_([0-9A-Za-z]{26})-/);
      if (match) {
        id = match[1];
      } else {
        const canonicalRel = findCanonicalArticlePath(
          options.workspaceRoot,
          baseName,
          undefined,
          collection,
        );
        if (canonicalRel) {
          try {
            const canContent = fs.readFileSync(
              path.join(options.workspaceRoot, canonicalRel),
              'utf8',
            );
            const canMatch = canContent.match(/^id:\s*['"]?([^\s\r\n'"]+)['"]?/m);
            if (canMatch) id = canMatch[1].trim();
          } catch {
            // Ignore read error
          }
        }
      }
    }

    if (id) {
      options.cache.clearConflictsByKind(id, 'body');
    }

    // Discard the quarantined copy
    fs.unlinkSync(fullPath);
    return {
      success: true,
      strategy: 'accept-canonical',
      conflictFilePath: relPath,
      message: `Quarantined file ${relPath} was safely discarded.`,
    };
  }

  // accept-local: Restore quarantined content to canonical location
  const conflictContent = fs.readFileSync(fullPath, 'utf8');
  let id = 'unknown';
  let slug = 'restored';
  let status: 'draft' | 'published' = 'draft';

  try {
    const parsed = parseMarkdown(conflictContent);
    id = parsed.frontmatter.id;
    slug = parsed.frontmatter.slug;
    status = parsed.frontmatter.status;
  } catch {
    // If invalid, try lenient
    try {
      const healed = lenientRepairMarkdownFrontmatter(conflictContent);
      if (healed) {
        const parsed = parseMarkdown(healed);
        id = parsed.frontmatter.id;
        slug = parsed.frontmatter.slug;
        status = parsed.frontmatter.status;
      }
    } catch {
      // Keep defaults
    }
  }

  const baseName = extractBaseArticleName(fileName);
  let canonicalRel = findCanonicalArticlePath(options.workspaceRoot, baseName, id, collection);

  if (canonicalRel) {
    const canonicalFull = path.join(options.workspaceRoot, canonicalRel);
    // Major 1 Guard: Check if canonical file has unpushed modifications
    if (!options.force && fs.existsSync(canonicalFull)) {
      const canonicalContent = fs.readFileSync(canonicalFull, 'utf8');
      const canonicalHash = calculateHash(canonicalContent);
      let canonicalId = id;
      try {
        const parsedCan = parseMarkdown(canonicalContent);
        canonicalId = parsedCan.frontmatter.id;
      } catch {
        // fallback
      }
      const syncState = options.cache.getSyncState(canonicalId);
      if (syncState && syncState.localHash !== canonicalHash) {
        throw new CanonicalHasUnpushedEditsError({
          canonicalFilePath: canonicalRel,
          conflictFilePath: relPath,
          id: canonicalId,
        });
      }
    }
  } else {
    // Recreate target file in collection/status/baseName.md
    canonicalRel = path.join(collection, status, `${baseName}.md`);
  }

  const canonicalFull = path.join(options.workspaceRoot, canonicalRel);
  fs.mkdirSync(path.dirname(canonicalFull), { recursive: true });
  fs.writeFileSync(canonicalFull, conflictContent, 'utf8');

  // Minor B: check if restored article is missing valid ULID
  const warnings: string[] = [];
  if (!id || id === 'unknown') {
    warnings.push(
      `Restored article has no valid ULID (id: ${id}). Re-fetch the canonical copy using "emit pull", or rename the file to follow canonical naming ("<yyyyMMdd>_<ulid>-<title>.md") with a matching frontmatter ID before pushing.`,
    );
  }

  // Update cache sync state if id is valid
  if (id && id !== 'unknown') {
    const newHash = calculateHash(conflictContent);
    const existingSync = options.cache.getSyncState(id);
    options.cache.saveSyncState({
      id,
      localFilePath: canonicalRel,
      localHash: newHash,
      remoteRev: existingSync?.remoteRev || 'local-restored',
      status,
      slug,
      lastSyncedAt: existingSync?.lastSyncedAt || Math.floor(Date.now() / 1000),
      conflictPending: 0,
      bodyConflictPending: 0,
      taxonomyConflictPending: 0,
      conflictCopyHash: null,
      conflictCopyPath: null,
      conflictAt: null,
      remoteTaxonomyHash: existingSync?.remoteTaxonomyHash ?? null,
      taxonomyApplyPending: existingSync?.taxonomyApplyPending ?? 0,
    });
  }

  // Safe deletion of conflict file now that canonical is written
  fs.unlinkSync(fullPath);

  return {
    success: true,
    strategy: 'accept-local',
    conflictFilePath: relPath,
    canonicalFilePath: canonicalRel,
    message: `Restored quarantined content to ${canonicalRel} and removed ${relPath}.`,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export interface PruneConflictsOptions {
  workspaceRoot: string;
  cache: CacheDatabase;
  collection?: string;
  olderThan?: string;
  dryRun?: boolean;
  allowOrphanRescues?: boolean;
}

export interface PruneConflictsResult {
  pruned: string[];
  skipped: Array<{ filePath: string; reason: string }>;
  dryRun: boolean;
}

function parseDurationMs(durationStr?: string): number {
  if (!durationStr) return 0;
  const match = durationStr.trim().match(/^(\d+)([smhdwy])$/i);
  if (!match) return 0;
  const val = Number(match[1]);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case 's':
      return val * 1000;
    case 'm':
      return val * 60 * 1000;
    case 'h':
      return val * 60 * 60 * 1000;
    case 'd':
      return val * 24 * 60 * 60 * 1000;
    case 'w':
      return val * 7 * 24 * 60 * 60 * 1000;
    case 'y':
      return val * 365 * 24 * 60 * 60 * 1000;
    default:
      return 0;
  }
}

/**
 * Prunes quarantined conflict copies and deletion backups under <collection>/conflicts/.
 * Guarded against data loss:
 * - Refuses to prune if the canonical article has unpushed local modifications.
 * - Refuses to prune orphan rescue copies (e.g. .deleted.md) without explicit allowOrphanRescues: true.
 * - Respects olderThan age cutoff.
 */
export function pruneConflicts(options: PruneConflictsOptions): PruneConflictsResult {
  const collection = options.collection || 'posts';
  const items = listConflicts(options.workspaceRoot, collection);
  const cutoffMs = parseDurationMs(options.olderThan);
  const now = Date.now();

  const pruned: string[] = [];
  const skipped: Array<{ filePath: string; reason: string }> = [];

  for (const item of items) {
    const fullPath = path.join(options.workspaceRoot, item.filePath);
    if (!fs.existsSync(fullPath)) continue;

    const stat = fs.statSync(fullPath);
    if (cutoffMs > 0 && now - stat.mtimeMs < cutoffMs) {
      skipped.push({
        filePath: item.filePath,
        reason: `File is newer than cutoff (${options.olderThan})`,
      });
      continue;
    }

    const baseName = extractBaseArticleName(path.basename(item.filePath));
    const canonicalRel = findCanonicalArticlePath(
      options.workspaceRoot,
      baseName,
      item.id,
      collection,
    );

    if (canonicalRel) {
      // Check if canonical file has unpushed edits
      const canonicalFull = path.join(options.workspaceRoot, canonicalRel);
      if (fs.existsSync(canonicalFull)) {
        const canonicalContent = fs.readFileSync(canonicalFull, 'utf8');
        const canonicalHash = calculateHash(canonicalContent);
        let resolvedId = item.id;
        if (!resolvedId) {
          try {
            const parsedCan = parseMarkdown(canonicalContent);
            resolvedId = parsedCan.frontmatter.id;
          } catch {
            // ignore parse failure
          }
        }
        const syncState = resolvedId
          ? options.cache.getSyncState(resolvedId)
          : options.cache.getSyncStateByPath(canonicalRel);
        if (syncState && syncState.localHash !== canonicalHash) {
          skipped.push({
            filePath: item.filePath,
            reason: `Canonical article ${canonicalRel} has unpushed modifications; rescue copy preserved`,
          });
          continue;
        }
      }
    } else {
      // Orphan rescue copy (no canonical article exists, e.g. .deleted.md)
      if (!options.allowOrphanRescues) {
        skipped.push({
          filePath: item.filePath,
          reason:
            'No canonical article exists for this rescue backup; pass --allow-orphan-rescues to prune',
        });
        continue;
      }
    }

    if (!options.dryRun) {
      try {
        fs.unlinkSync(fullPath);
      } catch (err: unknown) {
        skipped.push({
          filePath: item.filePath,
          reason: `Failed to delete file: ${(err as Error).message}`,
        });
        continue;
      }
    }

    pruned.push(item.filePath);
  }

  return {
    pruned,
    skipped,
    dryRun: Boolean(options.dryRun),
  };
}
