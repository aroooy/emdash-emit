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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheDatabase } from '../src/db/cache.js';
import { readBaseline } from '../src/db/baseline.js';
import { calculateHash, commitArticleSnapshot } from '../src/sync/workspace/index.js';
import type { Frontmatter } from '../src/utils/frontmatter.js';

describe('commitArticleSnapshot (Phase 0 Centralized Commit)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-symmetry-test-'));
    const dbPath = path.join(tempDir, 'cache.db');
    cache = new CacheDatabase(dbPath);
  });

  afterEach(() => {
    try {
      cache.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  const sampleFrontmatter: Frontmatter = {
    id: '01M77VFT15HSH2M1XW8MJPTCPQ',
    slug: 'kingfisher-photo',
    title: 'カワセミ写真',
    collection: 'posts',
    status: 'published',
    publishedAt: '2026-11-13T08:00:00.000Z',
    locale: 'ja',
    taxonomies: { categories: ['%e9%87%8e%e9%b3%a5'], tags: [] },
    bylines: ['aroooy'],
  };

  it('guarantees localHash == calculateHash(diskContent) and baselineHash == calculateHash(canonicalContent)', () => {
    const diskContent =
      '---\nid: 01M77VFT15HSH2M1XW8MJPTCPQ\n---\nLocal body with ../../../media/image.jpg';
    const canonicalContent =
      '---\nid: 01M77VFT15HSH2M1XW8MJPTCPQ\n---\nCanonical body with /_emdash/api/media/file/img.jpg';
    const relPath = 'posts/ja/published/20261113_01M77VFT15HSH2M1XW8MJPTCPQ-kingfisher-photo.md';

    const result = commitArticleSnapshot(cache, tempDir, {
      id: sampleFrontmatter.id,
      relPath,
      diskContent,
      canonicalContent,
      frontmatter: sampleFrontmatter,
      bodyMarkdown: 'Canonical body with /_emdash/api/media/file/img.jpg',
      revForTransport: 'raw_rev_123',
      revForComparison: '24@draft:01M7CD9YGWNPAEP1Z7NC8600ZD',
    });

    // 1. Verify return values
    expect(result.localHash).toBe(calculateHash(diskContent));
    expect(result.baselineHash).toBe(calculateHash(canonicalContent));
    expect(result.fullPath).toBe(path.resolve(tempDir, relPath));

    // 2. Verify disk write
    expect(fs.existsSync(result.fullPath)).toBe(true);
    expect(fs.readFileSync(result.fullPath, 'utf8')).toBe(diskContent);

    // 3. Verify sync_state
    const syncState = cache.getSyncState(sampleFrontmatter.id);
    expect(syncState).not.toBeNull();
    expect(syncState?.localFilePath).toBe(relPath);
    expect(syncState?.localHash).toBe(result.localHash);
    expect(syncState?.remoteRev).toBe('24@draft:01M7CD9YGWNPAEP1Z7NC8600ZD');
    expect(syncState?.status).toBe('published');
    expect(syncState?.slug).toBe('kingfisher-photo');

    // 4. Verify base_snapshots
    const snapshot = cache.getBaseSnapshot(sampleFrontmatter.id);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.rev).toBe('raw_rev_123');
    expect(snapshot?.hash).toBe(result.baselineHash);
    expect(snapshot?.bodyMarkdown).toBe('Canonical body with /_emdash/api/media/file/img.jpg');

    const decoded = readBaseline(snapshot!);
    expect(decoded.frontmatter).toEqual(sampleFrontmatter);
  });

  it('supports bumpBaselineHashOnly for heal operations', () => {
    const relPath = 'posts/ja/published/test.md';
    const initialDisk = 'initial disk';

    commitArticleSnapshot(cache, tempDir, {
      id: sampleFrontmatter.id,
      relPath,
      diskContent: initialDisk,
      frontmatter: sampleFrontmatter,
      bodyMarkdown: 'Initial body',
      revForTransport: 'rev_1',
      revForComparison: 'rev_comp_1',
    });

    const healedDisk = 'healed disk content';
    commitArticleSnapshot(cache, tempDir, {
      id: sampleFrontmatter.id,
      relPath,
      diskContent: healedDisk,
      frontmatter: sampleFrontmatter,
      bodyMarkdown: 'ignored when bumpBaselineHashOnly is true',
      revForTransport: 'ignored_rev',
      revForComparison: 'rev_comp_1',
      bumpBaselineHashOnly: true,
    });

    const snapshot = cache.getBaseSnapshot(sampleFrontmatter.id);
    expect(snapshot?.hash).toBe(calculateHash(healedDisk));
    expect(snapshot?.bodyMarkdown).toBe('Initial body'); // preserved!
    expect(snapshot?.rev).toBe('rev_1'); // preserved!

    const syncState = cache.getSyncState(sampleFrontmatter.id);
    expect(syncState?.localHash).toBe(calculateHash(healedDisk));
  });

  it('honors skipDiskWrite when disk was already written', () => {
    const relPath = 'posts/ja/published/custom.md';
    const fullPath = path.resolve(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, 'already on disk', 'utf8');

    commitArticleSnapshot(cache, tempDir, {
      id: sampleFrontmatter.id,
      relPath,
      diskContent: 'already on disk',
      frontmatter: sampleFrontmatter,
      bodyMarkdown: 'Body',
      revForTransport: 'rev',
      revForComparison: 'comp',
      skipDiskWrite: true,
    });

    expect(fs.readFileSync(fullPath, 'utf8')).toBe('already on disk');
    const syncState = cache.getSyncState(sampleFrontmatter.id);
    expect(syncState?.localHash).toBe(calculateHash('already on disk'));
  });
});
