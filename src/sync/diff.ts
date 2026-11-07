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
import { diffPatch } from 'node-diff3';
import type { CacheDatabase } from '../db/cache.js';
import { extractUlidFromFilename } from '../utils/naming.js';
import { serializeMarkdown, type Frontmatter } from '../utils/frontmatter.js';
import { calculateHash } from './pull.js';

export interface DiffResult {
  hasChanges: boolean;
  unifiedDiff: string;
  additions: number;
  deletions: number;
}

export interface ResolveArticleTargetOptions {
  workspaceRoot: string;
  cache?: CacheDatabase;
  filePath?: string;
  id?: string;
}

export interface ResolvedArticleTarget {
  id?: string;
  filePath?: string;
}

/**
 * Resolves a paired article ULID and workspace-relative file path from either `filePath` or `id`.
 * Shared across CLI (`emit diff`) and MCP (`sync_diff`, `sync_pull`).
 */
export function resolveArticleTarget(options: ResolveArticleTargetOptions): ResolvedArticleTarget {
  let targetId = options.id;
  let targetFile = options.filePath;

  if (!targetId && targetFile) {
    // Filename parsing is purely lexical, so resolve the ULID even when the file is absent:
    // callers can then report an accurate "Local file not found" instead of a false
    // filename-shape complaint, and sync_pull can still target a pruned path by ID.
    const ulid = extractUlidFromFilename(path.join(options.workspaceRoot, targetFile));
    if (ulid) targetId = ulid;
  }

  if (targetId && !targetFile && options.cache) {
    const syncState = options.cache.getSyncState(targetId);
    if (syncState) targetFile = syncState.localFilePath;
  }

  return { id: targetId, filePath: targetFile };
}

export interface ArticleDiffInspection {
  ok: boolean;
  status: 'modified' | 'synced' | 'untracked' | 'missing_args' | 'not_found';
  id?: string;
  filePath?: string;
  rev?: string;
  /** Base snapshot save time in epoch seconds (matches base_snapshots.saved_at storage unit). */
  savedAt?: number;
  diff?: DiffResult;
  formattedOutput: string;
}

/**
 * Inspects the diff between a local Markdown article and its cached baseline snapshot.
 */
export function inspectArticleDiff(options: {
  workspaceRoot: string;
  cache: CacheDatabase;
  filePath?: string;
  id?: string;
}): ArticleDiffInspection {
  const { id: targetId, filePath: targetFile } = resolveArticleTarget(options);

  if (!targetId && !targetFile) {
    return {
      ok: false,
      status: 'missing_args',
      id: targetId,
      filePath: targetFile,
      formattedOutput: '❌ Please specify a valid "filePath" or "id" to compute diff.',
    };
  }

  if (!targetId) {
    // A file path was provided but carries no canonical ULID, so it cannot be matched
    // against the cache. Report the expected filename shape instead of asking the caller
    // to provide an argument it already provided.
    return {
      ok: false,
      status: 'not_found',
      filePath: targetFile,
      formattedOutput:
        `❌ Could not resolve an article ULID from "${targetFile}".\n` +
        '   Expected filename form: posts/<status>/<yyyyMMdd>_<26-char ULID>-<title>.md\n' +
        '   Or inspect by ID instead: emit diff --id <ULID> (MCP: { "id": "<ULID>" })',
    };
  }

  if (!targetFile) {
    return {
      ok: false,
      status: 'not_found',
      id: targetId,
      formattedOutput:
        `❌ No local file path is tracked for ID "${targetId}".\n` +
        `   The article is not part of this workspace yet. Pull it first: emit pull ${targetId}`,
    };
  }

  const fullLocalPath = path.join(options.workspaceRoot, targetFile);
  if (!fs.existsSync(fullLocalPath)) {
    return {
      ok: false,
      status: 'not_found',
      id: targetId,
      filePath: targetFile,
      formattedOutput: `❌ Local file not found: ${targetFile}`,
    };
  }

  const localContent = fs.readFileSync(fullLocalPath, 'utf8');
  const baseSnapshot = options.cache.getBaseSnapshot(targetId);

  if (!baseSnapshot) {
    return {
      ok: true,
      status: 'untracked',
      id: targetId,
      filePath: targetFile,
      formattedOutput: `ℹ️ No base snapshot found for ID "${targetId}". Article is untracked or newly created.`,
    };
  }

  const syncState = options.cache.getSyncState(targetId);
  const currentHash = calculateHash(localContent);
  const isModified = syncState ? syncState.localHash !== currentHash : true;
  // base_snapshots.frontmatterYaml stores a JSON-encoded Frontmatter (see pull.ts / push.ts).
  // Rebuild the base document with the exact same serializer used to write the local file so the
  // diff compares canonical Markdown against canonical Markdown instead of JSON against YAML.
  const baseFullMarkdown = serializeMarkdown(
    JSON.parse(baseSnapshot.frontmatterYaml) as Frontmatter,
    baseSnapshot.bodyMarkdown,
  );
  const diffResult = computeContextDiff(baseFullMarkdown, localContent, {
    baseLabel: `base [rev: ${baseSnapshot.rev}]`,
    localLabel: `local [${targetFile}]`,
  });

  const formattedOutput = [
    `--- Diff for ${targetFile} (${targetId}) ---`,
    `Status: ${isModified ? '🟡 Modified' : '🟢 In Sync with base snapshot'}`,
    `Base Rev: ${baseSnapshot.rev}`,
    `Base Saved At: ${new Date(baseSnapshot.savedAt * 1000).toISOString()}`,
    `Changes: +${diffResult.additions} / -${diffResult.deletions} lines`,
    '',
    'Unified Diff:',
    '----------------------------------------',
    diffResult.unifiedDiff,
    '----------------------------------------',
  ].join('\n');

  return {
    ok: true,
    status: isModified ? 'modified' : 'synced',
    id: targetId,
    filePath: targetFile,
    rev: baseSnapshot.rev,
    savedAt: baseSnapshot.savedAt,
    diff: diffResult,
    formattedOutput,
  };
}

/**
 * Computes a unified-like diff between base text and local text without dumping full contents.
 * Conserves LLM context tokens by outputting only changed regions with line context.
 */
export function computeContextDiff(
  baseText: string,
  localText: string,
  options?: { contextLines?: number; baseLabel?: string; localLabel?: string },
): DiffResult {
  if (baseText === localText) {
    return {
      hasChanges: false,
      unifiedDiff: 'No changes detected.',
      additions: 0,
      deletions: 0,
    };
  }

  const baseLines = baseText.split('\n');
  const localLines = localText.split('\n');
  const patches = diffPatch(baseLines, localLines);

  const contextLines = options?.contextLines ?? 3;
  const baseLabel = options?.baseLabel ?? 'base';
  const localLabel = options?.localLabel ?? 'local';

  let additions = 0;
  let deletions = 0;
  const output: string[] = [`--- ${baseLabel}`, `+++ ${localLabel}`];

  for (const patch of patches) {
    const b1 = patch.buffer1;
    const b2 = patch.buffer2;

    deletions += b1.length;
    additions += b2.length;

    // Output hunk header
    output.push(`@@ -${b1.offset + 1},${b1.length} +${b2.offset + 1},${b2.length} @@`);

    // Removed lines
    for (const line of b1.chunk) {
      output.push(`-${line}`);
    }

    // Added lines
    for (const line of b2.chunk) {
      output.push(`+${line}`);
    }
  }

  return {
    hasChanges: true,
    unifiedDiff: output.join('\n'),
    additions,
    deletions,
  };
}
