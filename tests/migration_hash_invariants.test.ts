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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheDatabase } from '../src/db/cache.js';
import {
  createBaseSnapshot,
  readBaseline,
  readBaselineFrontmatter,
  baselineMarkdown,
} from '../src/db/baseline.js';
import { calculateHash } from '../src/sync/workspace/index.js';
import { getWorkspaceStatus } from '../src/sync/status.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';

describe('Migration Hash Invariants & Workspace Upgrade Safety', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-migration-invariants-'));
    cache = new CacheDatabase(path.join(tempDir, 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps healthy articles byte-identical and prevents false modified status when upgrading workspace without re-pull', () => {
    const articles = [
      {
        id: '01M67MP2W0VKCK2DFWM166CR24',
        slug: 'tech-article',
        title: 'Tech Article',
        category: 'tech',
      },
      {
        id: '01M67MP2W0VKCK2DFWM166CR25',
        slug: 'diary-post',
        title: 'Diary Post',
        category: 'diary',
      },
      {
        id: '01M67MP2W0VKCK2DFWM166CR26',
        slug: 'gadget-review',
        title: 'Gadget Review',
        category: 'gadget',
      },
      {
        id: '01M67MP2W0VKCK2DFWM166CR27',
        slug: '%e5%8f%b0%e6%b9%be-travel',
        title: 'Taiwan Travel',
        category: '%e6%9c%aa%e5%88%86%e9%a1%9e',
      },
    ];

    for (const a of articles) {
      const relPath = `posts/ja/published/20261101_${a.id}-${a.slug}.md`;
      const fullPath = path.join(tempDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });

      const fm: Frontmatter = {
        id: a.id,
        slug: a.slug,
        title: a.title,
        collection: 'posts',
        status: 'published',
        publishedAt: '2026-11-01T00:00:00.000Z',
        locale: 'ja',
        taxonomies: { categories: [a.category] },
        bylines: [],
      };

      const content = serializeMarkdown(fm, `Content for ${a.title}.\n`);
      fs.writeFileSync(fullPath, content, 'utf8');

      const hash = calculateHash(content);

      // Baseline snapshot and sync state matching 0.1.8/0.1.9 serializer (epoch seconds for lastSyncedAt)
      cache.saveSyncState({
        id: a.id,
        localFilePath: relPath,
        localHash: hash,
        remoteRev: 'rev_1',
        status: 'published',
        slug: a.slug,
        lastSyncedAt: Math.floor(Date.now() / 1000),
      });

      cache.saveBaseSnapshot({
        id: a.id,
        rev: 'rev_1',
        bodyMarkdown: `Content for ${a.title}.\n`,
        frontmatterYaml: JSON.stringify(fm),
        hash,
        savedAt: Math.floor(Date.now() / 1000),
      });
    }

    // Checking status on upgrade without pulling MUST report 100% synced, 0 modified, 0 invalid
    const status = getWorkspaceStatus(tempDir, cache, 'posts');
    expect(status.summary.total).toBe(4);
    expect(status.summary.synced).toBe(4);
    expect(status.summary.modified).toBe(0);
    expect(status.summary.invalid).toBe(0);
    expect(status.summary.untracked).toBe(0);
  });

  it('guarantees bidirectional byte-identical baseline reconstruction (pull output and push write paths)', () => {
    const fm: Frontmatter = {
      id: '01M67MP2W0VKCK2DFWM166CR30',
      slug: 'baseline-invariant-article',
      title: 'Baseline Invariant Article',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: {
        categories: ['tech'],
        tags: ['typescript', 'sqlite'],
      },
      bylines: ['author-1'],
    };
    const body = '# Heading 2\n\nArticle body with paragraph and list:\n\n- item 1\n- item 2\n';

    // 1. Simulate pull writing to disk
    const diskContent = serializeMarkdown(fm, body);
    const diskHash = calculateHash(diskContent);

    // 2. Save snapshot via createBaseSnapshot (pull / push write pattern)
    const snapshot = createBaseSnapshot({
      id: fm.id,
      rev: 'rev_pull_100',
      bodyMarkdown: body,
      frontmatter: fm,
      hash: diskHash,
    });
    cache.saveBaseSnapshot(snapshot);

    // 3. Read back from database and decode
    const retrieved = cache.getBaseSnapshot(fm.id);
    expect(retrieved).not.toBeNull();
    const decoded = readBaseline(retrieved!);
    expect(decoded.frontmatter).toEqual(fm);
    expect(decoded.body).toBe(body);

    const decodedFm = readBaselineFrontmatter(retrieved!);
    expect(decodedFm).toEqual(fm);

    // 4. Assert bidirectional byte-identical reconstruction
    const reconstructed = baselineMarkdown(retrieved!);
    expect(reconstructed).toBe(diskContent);
    expect(calculateHash(reconstructed)).toBe(diskHash);
    expect(calculateHash(reconstructed)).toBe(retrieved!.hash);

    // 5. Simulate push update: modifying frontmatter and updating baseline
    const updatedFm: Frontmatter = {
      ...fm,
      title: 'Updated Title',
      status: 'published',
      publishedAt: '2026-11-13T00:00:00.000Z',
    };
    const updatedDiskContent = serializeMarkdown(updatedFm, body);
    const updatedDiskHash = calculateHash(updatedDiskContent);

    const pushSnapshot = createBaseSnapshot({
      id: fm.id,
      rev: 'rev_push_200',
      bodyMarkdown: body,
      frontmatter: updatedFm,
      hash: updatedDiskHash,
    });
    cache.saveBaseSnapshot(pushSnapshot);

    const pushRetrieved = cache.getBaseSnapshot(fm.id);
    expect(pushRetrieved).not.toBeNull();
    const pushReconstructed = baselineMarkdown(pushRetrieved!);
    expect(pushReconstructed).toBe(updatedDiskContent);
    expect(calculateHash(pushReconstructed)).toBe(updatedDiskHash);
    expect(calculateHash(pushReconstructed)).toBe(pushRetrieved!.hash);
  });

  it('guarantees bidirectional byte-identical reconstruction with hasDraftRevision: true', () => {
    const fm: Frontmatter = {
      id: '01M6TESTULID00000000000000',
      slug: 'test-draft-rev',
      title: 'Draft Rev Invariant',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-13T00:00:00.000Z',
      locale: 'ja',
      taxonomies: { categories: ['%e6%9c%aa%e5%88%86%e9%a1%9e'] },
      bylines: ['aroooy'],
    };
    const body = 'Body with draft changes.\n';
    const diskContent = serializeMarkdown(fm, body, undefined, { hasDraftRevision: true });
    expect(diskContent).toContain('status: published # draft revision');
    const diskHash = calculateHash(diskContent);

    const snapshot = createBaseSnapshot({
      id: fm.id,
      rev: 'rev_1',
      bodyMarkdown: body,
      frontmatter: fm,
      hash: diskHash,
    });
    cache.saveBaseSnapshot(snapshot);

    const retrieved = cache.getBaseSnapshot(fm.id);
    expect(retrieved).not.toBeNull();

    const reconstructed = baselineMarkdown(retrieved!, undefined, { hasDraftRevision: true });
    expect(reconstructed).toBe(diskContent);
    expect(calculateHash(reconstructed)).toBe(diskHash);
    expect(calculateHash(reconstructed)).toBe(retrieved!.hash);
  });

  it('preserves local_hash and base_snapshots.hash across Schema v6 -> v7 migration', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const v6DbPath = path.join(tempDir, 'v6-upgrade.db');
    const rawDb = new DatabaseSync(v6DbPath);
    rawDb.exec(`
      CREATE TABLE sync_state (
        id TEXT PRIMARY KEY, local_file_path TEXT NOT NULL, local_hash TEXT NOT NULL,
        remote_rev TEXT NOT NULL, status TEXT NOT NULL, slug TEXT NOT NULL,
        last_synced_at INTEGER NOT NULL, remote_taxonomy_hash TEXT,
        conflict_pending INTEGER NOT NULL DEFAULT 0, body_conflict_pending INTEGER NOT NULL DEFAULT 0,
        taxonomy_conflict_pending INTEGER NOT NULL DEFAULT 0, conflict_copy_path TEXT,
        conflict_copy_hash TEXT, conflict_at INTEGER, delete_pending INTEGER NOT NULL DEFAULT 0,
        taxonomy_apply_pending INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE base_snapshots (
        id TEXT PRIMARY KEY, rev TEXT NOT NULL, body_markdown TEXT NOT NULL,
        frontmatter_yaml TEXT NOT NULL, hash TEXT NOT NULL, saved_at INTEGER NOT NULL
      );
      CREATE TABLE snapshot_articles (
        id TEXT PRIMARY KEY, collection TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT, updated_at TEXT, published_at TEXT,
        comparison_rev TEXT NOT NULL, excerpt TEXT, body_markdown TEXT NOT NULL DEFAULT '',
        body_source TEXT NOT NULL DEFAULT 'list-live', categories_json TEXT NOT NULL DEFAULT '[]',
        tags_json TEXT NOT NULL DEFAULT '[]', taxonomy_verified INTEGER NOT NULL DEFAULT 1,
        captured_at INTEGER NOT NULL
      );
      INSERT INTO sync_state (id, local_file_path, local_hash, remote_rev, status, slug, last_synced_at)
      VALUES ('01M7MIG1', 'posts/ja/published/20261101_01M7MIG1-test.md', 'hash_abc', '3@live:01L1', 'published', 'test', 1700000000);
      INSERT INTO base_snapshots (id, rev, body_markdown, frontmatter_yaml, hash, saved_at)
      VALUES ('01M7MIG1', '3', 'body', '{}', 'hash_abc', 1700000000);
      INSERT INTO snapshot_articles (id, collection, slug, title, status, comparison_rev, body_markdown, body_source, captured_at)
      VALUES ('01M7MIG1', 'posts', 'test', 'Test', 'published', '3@live:01L1', 'body', 'list-live', 1700000000);
      PRAGMA user_version = 6;
    `);
    rawDb.close();

    const upgraded = new CacheDatabase(v6DbPath);
    try {
      expect(upgraded.getSyncState('01M7MIG1')?.localHash).toBe('hash_abc');
      expect(upgraded.getBaseSnapshot('01M7MIG1')?.hash).toBe('hash_abc');
      const legacyRow = upgraded.getSnapshotArticle('01M7MIG1');
      expect(legacyRow?.locale).toBeNull();
      expect(legacyRow?.featuredImage).toBeNull();
      expect(legacyRow?.seoJson).toBe('{}');
      expect(legacyRow?.bylinesJson).toBe('[]');
    } finally {
      upgraded.close();
    }
  });

  it('preserves local_hash, base_snapshots.hash, and snapshot_media rows across Schema v7 -> v8 migration', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const v7DbPath = path.join(tempDir, 'v7-upgrade.db');
    const rawDb = new DatabaseSync(v7DbPath);
    rawDb.exec(`
      CREATE TABLE sync_state (
        id TEXT PRIMARY KEY, local_file_path TEXT NOT NULL, local_hash TEXT NOT NULL,
        remote_rev TEXT NOT NULL, status TEXT NOT NULL, slug TEXT NOT NULL,
        last_synced_at INTEGER NOT NULL, remote_taxonomy_hash TEXT,
        conflict_pending INTEGER NOT NULL DEFAULT 0, body_conflict_pending INTEGER NOT NULL DEFAULT 0,
        taxonomy_conflict_pending INTEGER NOT NULL DEFAULT 0, conflict_copy_path TEXT,
        conflict_copy_hash TEXT, conflict_at INTEGER, delete_pending INTEGER NOT NULL DEFAULT 0,
        taxonomy_apply_pending INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE base_snapshots (
        id TEXT PRIMARY KEY, rev TEXT NOT NULL, body_markdown TEXT NOT NULL,
        frontmatter_yaml TEXT NOT NULL, hash TEXT NOT NULL, saved_at INTEGER NOT NULL
      );
      CREATE TABLE snapshot_articles (
        id TEXT PRIMARY KEY, collection TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT, updated_at TEXT, published_at TEXT,
        comparison_rev TEXT NOT NULL, excerpt TEXT, body_markdown TEXT NOT NULL DEFAULT '',
        body_source TEXT NOT NULL DEFAULT 'list-live', categories_json TEXT NOT NULL DEFAULT '[]',
        tags_json TEXT NOT NULL DEFAULT '[]', taxonomy_verified INTEGER NOT NULL DEFAULT 1,
        captured_at INTEGER NOT NULL,
        locale TEXT, featured_image TEXT, seo_json TEXT NOT NULL DEFAULT '{}', bylines_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE snapshot_media (
        media_id TEXT PRIMARY KEY, storage_key TEXT, filename TEXT, mime_type TEXT,
        size INTEGER, alt TEXT, caption TEXT, created_at TEXT, captured_at INTEGER NOT NULL
      );
      INSERT INTO sync_state (id, local_file_path, local_hash, remote_rev, status, slug, last_synced_at)
      VALUES ('01M8MIG1', 'posts/ja/published/20261101_01M8MIG1-test.md', 'hash_v7', '3@live:01L1', 'published', 'test', 1700000000);
      INSERT INTO base_snapshots (id, rev, body_markdown, frontmatter_yaml, hash, saved_at)
      VALUES ('01M8MIG1', '3', 'body', '{}', 'hash_v7', 1700000000);
      INSERT INTO snapshot_media (media_id, storage_key, filename, mime_type, size, captured_at)
      VALUES ('01M8MED1', '01M8KEY0000000000000000001.png', 'photo.png', 'image/png', 1024, 1700000000);
      PRAGMA user_version = 7;
    `);
    rawDb.close();

    const upgraded = new CacheDatabase(v7DbPath);
    try {
      expect(upgraded.getSchemaVersion()).toBe(9);
      expect(upgraded.getSyncState('01M8MIG1')?.localHash).toBe('hash_v7');
      expect(upgraded.getBaseSnapshot('01M8MIG1')?.hash).toBe('hash_v7');
      const media = upgraded.getSnapshotMediaByStorageKey('01M8KEY0000000000000000001.png');
      expect(media?.mediaId).toBe('01M8MED1');
      expect(media?.cachedAt).toBeNull();
      expect(media?.cachePath).toBeNull();
      expect(media?.contentHash).toBeNull();
    } finally {
      upgraded.close();
    }
  });
});
