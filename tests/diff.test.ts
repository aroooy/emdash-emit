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
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { computeContextDiff, resolveArticleTarget, inspectArticleDiff } from '../src/sync/diff.js';
import { calculateHash } from '../src/sync/pull.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';
import { CacheDatabase } from '../src/db/cache.js';

describe('computeContextDiff', () => {
  it('returns no changes when strings are identical', () => {
    const text = 'line 1\nline 2\nline 3';
    const res = computeContextDiff(text, text);
    expect(res.hasChanges).toBe(false);
    expect(res.additions).toBe(0);
    expect(res.deletions).toBe(0);
    expect(res.unifiedDiff).toBe('No changes detected.');
  });

  it('outputs unified diff hunk for modified lines', () => {
    const base = 'line 1\nline 2\nline 3';
    const local = 'line 1\nline 2 (modified)\nline 3';
    const res = computeContextDiff(base, local);
    expect(res.hasChanges).toBe(true);
    expect(res.additions).toBe(1);
    expect(res.deletions).toBe(1);
    expect(res.unifiedDiff).toContain('-line 2');
    expect(res.unifiedDiff).toContain('+line 2 (modified)');
  });

  it('outputs additions when new lines are appended', () => {
    const base = 'line 1\nline 2';
    const local = 'line 1\nline 2\nline 3\nline 4';
    const res = computeContextDiff(base, local);
    expect(res.hasChanges).toBe(true);
    expect(res.additions).toBe(2);
    expect(res.deletions).toBe(0);
    expect(res.unifiedDiff).toContain('+line 3');
    expect(res.unifiedDiff).toContain('+line 4');
  });
});

describe('resolveArticleTarget & inspectArticleDiff', () => {
  let tempDir: string;
  let cache: CacheDatabase;
  const articleId = '01M6ABCDEF1234567890123456';
  const relPath = `posts/draft/20261107_${articleId}-test-article.md`;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-diff-test-'));
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
    fs.mkdirSync(path.join(tempDir, 'posts', 'draft'), { recursive: true });
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns missing_args when neither filePath nor id can be resolved', () => {
    const res = inspectArticleDiff({
      workspaceRoot: tempDir,
      cache,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('missing_args');
    expect(res.formattedOutput).toContain('Please specify a valid "filePath" or "id"');
  });

  it('returns untracked when local file exists without a base snapshot', () => {
    const fullPath = path.join(tempDir, relPath);
    fs.writeFileSync(fullPath, '---\nid: ' + articleId + '\n---\nHello world\n', 'utf8');

    const resolved = resolveArticleTarget({
      workspaceRoot: tempDir,
      cache,
      filePath: relPath,
    });
    expect(resolved.id).toBe(articleId);
    expect(resolved.filePath).toBe(relPath);

    const res = inspectArticleDiff({
      workspaceRoot: tempDir,
      cache,
      filePath: relPath,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('untracked');
    expect(res.formattedOutput).toContain('Article is untracked or newly created');
  });

  it('reports an actionable error when the filename carries no canonical ULID', () => {
    const res = inspectArticleDiff({
      workspaceRoot: tempDir,
      cache,
      filePath: 'posts/draft/typo-name.md',
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('not_found');
    expect(res.formattedOutput).toContain('Could not resolve an article ULID');
    expect(res.formattedOutput).toContain('26-char ULID');
  });

  it('reports a pull hint when an unknown id has no tracked local file path', () => {
    const res = inspectArticleDiff({
      workspaceRoot: tempDir,
      cache,
      id: '01M6UNKNOWN0000000000000',
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('not_found');
    expect(res.formattedOutput).toContain('No local file path is tracked');
    expect(res.formattedOutput).toContain('emit pull 01M6UNKNOWN0000000000000');
  });

  it('reports a missing local file when the id is tracked but the file was deleted', () => {
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: 'hash_x',
      remoteRev: 'rev-1',
      status: 'draft',
      slug: 'test-article',
      lastSyncedAt: 1700000000,
    });

    const res = inspectArticleDiff({
      workspaceRoot: tempDir,
      cache,
      id: articleId,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('not_found');
    expect(res.formattedOutput).toContain('Local file not found');
  });

  it('resolves the ULID from a well-named path even when the file is absent', () => {
    const ghostPath = `posts/draft/20200101_${articleId}-ghost.md`;
    const resolved = resolveArticleTarget({
      workspaceRoot: tempDir,
      cache,
      filePath: ghostPath,
    });
    expect(resolved.id).toBe(articleId);
    expect(resolved.filePath).toBe(ghostPath);

    const res = inspectArticleDiff({
      workspaceRoot: tempDir,
      cache,
      filePath: ghostPath,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('not_found');
    expect(res.formattedOutput).toContain('Local file not found');
    expect(res.formattedOutput).not.toContain('Could not resolve an article ULID');
  });

  it('inspects synced and modified articles by filePath or by id', () => {
    // Mirror the production cache storage format exactly:
    // base_snapshots.frontmatter_yaml holds a JSON-encoded Frontmatter (pull.ts / push.ts)
    // and saved_at holds epoch seconds.
    const frontmatter: Frontmatter = {
      id: articleId,
      slug: 'test-article',
      title: 'Test Article',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: { categories: ['tech'], tags: [] },
      bylines: ['aroooy'],
    };
    const baseBody = 'Line 1\nLine 2\n';
    const baseFull = serializeMarkdown(frontmatter, baseBody);
    const baseHash = calculateHash(baseFull);

    const fullPath = path.join(tempDir, relPath);
    fs.writeFileSync(fullPath, baseFull, 'utf8');

    cache.saveBaseSnapshot({
      id: articleId,
      rev: 'rev-1',
      frontmatterYaml: JSON.stringify(frontmatter),
      bodyMarkdown: baseBody,
      hash: baseHash,
      savedAt: 1700000000,
    });
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: baseHash,
      remoteRev: 'rev-1',
      status: 'draft',
      slug: 'test-article',
      lastSyncedAt: 1700000000,
    });

    // 1. In sync: an untouched article must produce an empty diff
    const syncedRes = inspectArticleDiff({
      workspaceRoot: tempDir,
      cache,
      id: articleId,
    });
    expect(syncedRes.ok).toBe(true);
    expect(syncedRes.status).toBe('synced');
    expect(syncedRes.diff?.hasChanges).toBe(false);
    expect(syncedRes.formattedOutput).toContain('🟢 In Sync with base snapshot');
    expect(syncedRes.formattedOutput).toContain('Changes: +0 / -0 lines');
    expect(syncedRes.formattedOutput).toContain('No changes detected.');
    expect(syncedRes.formattedOutput).toContain('2023-11-14T22:13:20.000Z');

    // 2. Modified body only
    const modifiedFull = serializeMarkdown(frontmatter, 'Line 1\nLine 2 updated\nLine 3 added\n');
    fs.writeFileSync(fullPath, modifiedFull, 'utf8');

    const modRes = inspectArticleDiff({
      workspaceRoot: tempDir,
      cache,
      filePath: relPath,
    });
    expect(modRes.ok).toBe(true);
    expect(modRes.status).toBe('modified');
    expect(modRes.diff?.additions).toBe(2);
    expect(modRes.diff?.deletions).toBe(1);
    expect(modRes.formattedOutput).toContain('🟡 Modified');
    expect(modRes.formattedOutput).toContain('+Line 2 updated');
    expect(modRes.formattedOutput).toContain('+Line 3 added');
  });
});
