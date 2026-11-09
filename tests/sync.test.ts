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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheDatabase } from '../src/db/cache.js';
import { pullBatch, pushAll } from '../src/sync/orchestrator.js';
import { hybrid3WayMerge } from '../src/sync/merge.js';
import { calculateHash, pullArticle } from '../src/sync/pull.js';
import { pushArticle, PushValidationError } from '../src/sync/push.js';
import { getWorkspaceStatus } from '../src/sync/status.js';
import {
  formatDatePrefix,
  parseMarkdown,
  serializeMarkdown,
  type Frontmatter,
} from '../src/utils/frontmatter.js';

describe('Pull & Push Synchronization Engine', () => {
  let tempDir: string;
  let cache: CacheDatabase;
  const validUlid = '01M67MP2W0VKCK2DFWM166CR24';
  const todayPrefix = formatDatePrefix(new Date());

  const options = {
    origin: 'https://aroooy.net',
    token: 'test-token',
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-sync-test-'));
    const dbPath = path.join(tempDir, '.emit', 'cache.db');
    cache = new CacheDatabase(dbPath);
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('pullArticle creates local markdown file and updates cache with path tracking', async () => {
    const remoteApiItem = {
      id: validUlid,
      slug: 'my-remote-post',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      _rev: 'rev_remote_101',
      data: {
        title: 'My Remote Post',
        body: [
          {
            _type: 'block',
            style: 'normal',
            children: [{ _type: 'span', text: 'Hello from remote' }],
          },
        ],
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => remoteApiItem,
    });

    const res = await pullArticle('posts', validUlid, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.id).toBe(validUlid);
    expect(res.filePath).toBe(`posts/draft/${todayPrefix}${validUlid}-My-Remote-Post.md`);

    const createdFilePath = path.join(tempDir, res.filePath);
    expect(fs.existsSync(createdFilePath)).toBe(true);

    const content = fs.readFileSync(createdFilePath, 'utf8');
    expect(content).toContain('title: "My Remote Post"');
    expect(content).toContain('Hello from remote');

    // Verify cache updates
    const syncState = cache.getSyncState(validUlid);
    expect(syncState?.remoteRev).toBe('rev_remote_101');
    expect(syncState?.localFilePath).toBe(res.filePath);
  });

  it('pushArticle runs preflight guards and blocks when invalid', async () => {
    const invalidFm: Frontmatter = {
      id: validUlid,
      slug: 'invalid-post',
      title: 'Invalid Post',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    // Include local image in body
    const invalidMd = serializeMarkdown(
      invalidFm,
      'Here is an image: ![Local](./images/photo.png)',
    );
    const targetFile = path.join(tempDir, 'posts', 'draft', `${validUlid}-invalid-post.md`);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, invalidMd, 'utf8');

    await expect(
      pushArticle(targetFile, {
        ...options,
        workspaceRoot: tempDir,
        cache,
      }),
    ).rejects.toThrowError(PushValidationError);
  });

  it('pushArticle runs G4 guard and blocks when frontmatter contains invalid taxonomy slug', async () => {
    // Pre-create local category 'tech'
    const catDir = path.join(tempDir, 'categories');
    fs.mkdirSync(catDir, { recursive: true });
    fs.writeFileSync(
      path.join(catDir, '01M6CAT1-Tech.yaml'),
      'id: 01M6CAT1\nname: Tech\nslug: tech\n',
    );

    const invalidFm: Frontmatter = {
      id: validUlid,
      slug: 'invalid-tax-post',
      title: 'Invalid Taxonomy Post',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: { categories: ['nonexistent-category'] },
      bylines: [],
    };
    const invalidMd = serializeMarkdown(invalidFm, 'Valid body content');
    const targetFile = path.join(tempDir, 'posts', 'draft', `${validUlid}-tax-post.md`);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, invalidMd, 'utf8');

    await expect(
      pushArticle(targetFile, {
        ...options,
        workspaceRoot: tempDir,
        cache,
      }),
    ).rejects.toThrowError(/Push blocked by Preflight Guards/);
  });

  it('pushArticle canonicalizes term ULIDs to slugs, passes G4 guard, and preserves exact ULIDs or resolves slugs deterministically', async () => {
    // Pre-create local categories with duplicate slug 'tech':
    // 01M6CAT1: count 5 (lower count)
    // 01M6CAT2: count 99 (deterministic winner for slug input)
    const catDir = path.join(tempDir, 'categories');
    const tagDir = path.join(tempDir, 'tags');
    fs.mkdirSync(catDir, { recursive: true });
    fs.mkdirSync(tagDir, { recursive: true });
    fs.writeFileSync(
      path.join(catDir, '01M6CAT1-Tech-old.yaml'),
      'id: 01M6CAT1\nname: Tech-old\nslug: tech\ncount: 5\n',
    );
    fs.writeFileSync(
      path.join(catDir, '01M6CAT2-Tech-new.yaml'),
      'id: 01M6CAT2\nname: Tech-new\nslug: tech\ncount: 99\n',
    );
    fs.writeFileSync(
      path.join(tagDir, '01M6TAG1-Nodejs.yaml'),
      'id: 01M6TAG1\nname: Nodejs\nslug: nodejs\n',
    );

    // Case 1: Frontmatter uses ULID for category ('01M6CAT1') and slug for tag ('nodejs')
    // M1 regression test: 01M6CAT1 must NOT be silently substituted by 01M6CAT2
    const validFm: Frontmatter = {
      id: validUlid,
      slug: 'valid-tax-post',
      title: 'Valid Taxonomy Post',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {
        categories: ['01M6CAT1'], // ULID: passes G4 guard, must retain 01M6CAT1
        tags: ['nodejs'], // Valid slug
      },
      bylines: [],
    };
    const validMd = serializeMarkdown(validFm, 'Valid body content');
    const targetFile = path.join(tempDir, 'posts', 'draft', `${validUlid}-valid-tax-post.md`);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, validMd, 'utf8');

    let postedCalls: Array<{ url: string; body: any }> = [];
    const mockFetch = vi.fn().mockImplementation((url, init) => {
      if (init.method === 'POST') {
        postedCalls.push({
          url: String(url),
          body: init.body ? JSON.parse(init.body as string) : undefined,
        });
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: validUlid, _rev: 'rev_v1' }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch call: ${url}`));
    });

    const res = await pushArticle(targetFile, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.success).toBe(true);
    expect(res.errors).toBeUndefined();

    // Verify remote term assignment preserved the exact ULID (01M6CAT1, not 01M6CAT2)
    const catPost = postedCalls.find((c) => c.url.includes('/terms/category'));
    expect(catPost).toBeDefined();
    expect(catPost?.body).toEqual({ termIds: ['01M6CAT1'] });

    const tagPost = postedCalls.find((c) => c.url.includes('/terms/tag'));
    expect(tagPost).toBeDefined();
    expect(tagPost?.body).toEqual({ termIds: ['01M6TAG1'] });

    // Case 2: Frontmatter uses slug 'tech'. M1' regression test:
    // Must deterministically resolve to 01M6CAT2 (the winner by count: 99)
    const slugFm: Frontmatter = {
      id: '01M6ZZZZZZZZZZZZZZZZZZZZZZ',
      slug: 'slug-tax-post',
      title: 'Slug Taxonomy Post',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {
        categories: ['tech'], // Slug: should resolve to highest-count winner 01M6CAT2
      },
      bylines: [],
    };
    const slugMd = serializeMarkdown(slugFm, 'Slug taxonomy body');
    const slugFile = path.join(
      tempDir,
      'posts',
      'draft',
      `01M6ZZZZZZZZZZZZZZZZZZZZZZ-slug-tax-post.md`,
    );
    fs.writeFileSync(slugFile, slugMd, 'utf8');

    postedCalls = [];
    const resSlug = await pushArticle(slugFile, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(resSlug.success).toBe(true);
    const catPostSlug = postedCalls.find((c) => c.url.includes('/terms/category'));
    expect(catPostSlug).toBeDefined();
    expect(catPostSlug?.body).toEqual({ termIds: ['01M6CAT2'] });

    // Case 3: Mixed input where slug and ULID point to the SAME term ('tech' === 01M6CAT2).
    // Both entries resolve to 01M6CAT2, so the remote payload must assign it exactly once.
    const mixedFm: Frontmatter = {
      id: '01M6YYYYYYYYYYYYYYYYYYYYYY',
      slug: 'mixed-tax-post',
      title: 'Mixed Taxonomy Post',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {
        categories: ['tech', '01M6CAT2'],
      },
      bylines: [],
    };
    const mixedMd = serializeMarkdown(mixedFm, 'Mixed taxonomy body');
    const mixedFile = path.join(
      tempDir,
      'posts',
      'draft',
      `01M6YYYYYYYYYYYYYYYYYYYYYY-mixed-tax-post.md`,
    );
    fs.writeFileSync(mixedFile, mixedMd, 'utf8');

    postedCalls = [];
    const resMixed = await pushArticle(mixedFile, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(resMixed.success).toBe(true);
    const catPostMixed = postedCalls.find((c) => c.url.includes('/terms/category'));
    expect(catPostMixed).toBeDefined();
    expect(catPostMixed?.body).toEqual({ termIds: ['01M6CAT2'] });
  });

  it('pushArticle acquires lock, sends PUT, and moves file when status changes (Path Tracking)', async () => {
    const draftFm: Frontmatter = {
      id: validUlid,
      slug: 'publishing-post',
      title: 'Publishing Post',
      collection: 'posts',
      status: 'published', // changed from draft to published
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const draftMd = serializeMarkdown(draftFm, 'Great article body ready for publication.');

    const initialRelPath = `posts/draft/${todayPrefix}${validUlid}-publishing-post.md`;
    const initialFullPath = path.join(tempDir, initialRelPath);
    fs.mkdirSync(path.dirname(initialFullPath), { recursive: true });
    fs.writeFileSync(initialFullPath, draftMd, 'utf8');

    // Initial cache state as draft
    cache.saveSyncState({
      id: validUlid,
      localFilePath: initialRelPath,
      localHash: 'hash_old',
      remoteRev: 'rev_v1',
      status: 'draft',
      slug: 'publishing-post',
      lastSyncedAt: 1730500000,
    });

    const mockFetch = vi.fn().mockImplementation((url, init) => {
      if (init.method === 'POST') {
        const urlStr = String(url);
        if (urlStr.includes('/publish')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ id: validUlid, _rev: 'rev_v3', status: 'published' }),
          });
        }
        // Lock acquisition
        return Promise.resolve({
          ok: true,
          json: async () => ({ enabled: true, holder: null, heldByCaller: true }),
        });
      }
      if (init.method === 'PUT') {
        // Successful update
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: validUlid, _rev: 'rev_v2' }),
        });
      }
      if (init.method === 'DELETE') {
        // Lock release
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error('Unexpected fetch call'));
    });

    const res = await pushArticle(initialRelPath, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      allowPublish: true, // explicit permission
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.success).toBe(true);
    expect(res.rev).toBe('rev_v3');
    expect(res.filePath).toBe(`posts/published/${todayPrefix}${validUlid}-Publishing-Post.md`);

    // Path tracking check: Old draft file unlinked, new published file created
    expect(fs.existsSync(initialFullPath)).toBe(false);
    expect(fs.existsSync(path.join(tempDir, res.filePath))).toBe(true);

    // Sync state updated
    const updatedSync = cache.getSyncState(validUlid);
    expect(updatedSync?.status).toBe('published');
    expect(updatedSync?.localFilePath).toBe(res.filePath);
    expect(updatedSync?.remoteRev).toBe('rev_v3');
  });

  it('pushArticle renames file and updates sync_state when title is changed in frontmatter', async () => {
    const draftFm: Frontmatter = {
      id: validUlid,
      slug: 'my-article',
      title: 'New Renovated Title',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const draftMd = serializeMarkdown(draftFm, 'Body content of renovated article.');

    const initialRelPath = `posts/draft/${todayPrefix}${validUlid}-Old-Title.md`;
    const initialFullPath = path.join(tempDir, initialRelPath);
    fs.mkdirSync(path.dirname(initialFullPath), { recursive: true });
    fs.writeFileSync(initialFullPath, draftMd, 'utf8');

    // Initial cache state with old path and old hash
    cache.saveSyncState({
      id: validUlid,
      localFilePath: initialRelPath,
      localHash: 'hash_old_title',
      remoteRev: 'rev_v1',
      status: 'draft',
      slug: 'my-article',
      lastSyncedAt: 1730500000,
    });

    const mockFetch = vi.fn().mockImplementation((url, init) => {
      if (init.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ enabled: true, holder: null, heldByCaller: true }),
        });
      }
      if (init.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: validUlid, _rev: 'rev_v2' }),
        });
      }
      if (init.method === 'DELETE') {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error('Unexpected fetch call'));
    });

    const res = await pushArticle(initialRelPath, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.success).toBe(true);
    expect(res.filePath).toBe(`posts/draft/${todayPrefix}${validUlid}-New-Renovated-Title.md`);

    // Old file with old title is deleted, new file exists
    expect(fs.existsSync(initialFullPath)).toBe(false);
    expect(fs.existsSync(path.join(tempDir, res.filePath))).toBe(true);

    // Sync state DB record is updated with new path and new hash
    const updatedSync = cache.getSyncState(validUlid);
    expect(updatedSync?.localFilePath).toBe(res.filePath);
    expect(updatedSync?.localHash).not.toBe('hash_old_title');
    expect(updatedSync?.remoteRev).toBe('rev_v2');

    // getWorkspaceStatus reports synced!
    const statusResult = getWorkspaceStatus(tempDir, cache);
    expect(statusResult.summary.synced).toBe(1);
    expect(statusResult.summary.modified).toBe(0);
  });

  it('pushArticle handles 409 conflict, performs 3-way auto-merge, and repushes cleanly', async () => {
    const baseBody = '# Article Title\n\nBase intro paragraph.\n\nSection 1\n\nFooter.';
    const localBody =
      '# Article Title\n\nBase intro paragraph.\n\nSection 1 (Local edit)\n\nFooter.';
    const remoteBody = '# Article Title\n\nRemote updated intro paragraph.\n\nSection 1\n\nFooter.';

    const fm: Frontmatter = {
      id: validUlid,
      slug: 'conflict-post',
      title: 'Conflict Post',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };

    const targetRelPath = `posts/draft/${todayPrefix}${validUlid}-Conflict-Post.md`;
    const targetFullPath = path.join(tempDir, targetRelPath);
    fs.mkdirSync(path.dirname(targetFullPath), { recursive: true });
    fs.writeFileSync(targetFullPath, serializeMarkdown(fm, localBody), 'utf8');

    // Setup base snapshot
    cache.saveBaseSnapshot({
      id: validUlid,
      rev: 'rev_v1',
      bodyMarkdown: baseBody,
      frontmatterYaml: JSON.stringify(fm),
      hash: 'hash_base',
      savedAt: 1730500000,
    });
    cache.saveSyncState({
      id: validUlid,
      localFilePath: targetRelPath,
      localHash: 'hash_local',
      remoteRev: 'rev_v1',
      status: 'draft',
      slug: 'conflict-post',
      lastSyncedAt: 1730500000,
    });

    let putCallCount = 0;
    const mockFetch = vi.fn().mockImplementation((url, init) => {
      if (init.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ heldByCaller: true }) });
      }
      if (init.method === 'PUT') {
        putCallCount++;
        if (putCallCount === 1) {
          // First PUT fails with 409 CONFLICT
          return Promise.resolve({
            status: 409,
            json: async () => ({ error: { code: 'CONFLICT', message: 'Revision mismatch' } }),
          });
        }
        // Second PUT succeeds with auto-merged content
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: validUlid, _rev: 'rev_v2' }),
        });
      }
      if (init.method === 'GET') {
        // Fetch remote latest
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: validUlid,
            slug: 'conflict-post',
            collection: 'posts',
            status: 'draft',
            _rev: 'rev_remote_latest',
            data: {
              title: 'Conflict Post',
              body: remoteBody,
            },
          }),
        });
      }
      if (init.method === 'DELETE') {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error('Unexpected fetch call'));
    });

    const res = await pushArticle(targetRelPath, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.success).toBe(true);
    expect(res.conflict).toBe(false); // Cleanly auto-merged!
    expect(putCallCount).toBe(2);

    // Verify auto-merged content written to disk
    const contentOnDisk = fs.readFileSync(targetFullPath, 'utf8');
    expect(contentOnDisk).toContain('Remote updated intro paragraph.');
    expect(contentOnDisk).toContain('Section 1 (Local edit)');
  });

  it('pushArticle automatically resolves frontmatter bylines slug to ULID using DB cache', async () => {
    cache.saveBylines([
      {
        id: '01M67MY3691HMDHDPS4HF5GBB0',
        slug: 'aroooy',
        displayName: 'aroooy',
      },
    ]);

    const articleFm: Frontmatter = {
      id: validUlid,
      slug: 'byline-test-post',
      title: 'Byline Test Post',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: ['aroooy'],
    };
    const articleMd = serializeMarkdown(articleFm, 'Testing byline slug to ULID mapping.');
    const relPath = `posts/draft/${todayPrefix}${validUlid}-Byline-Post.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, articleMd, 'utf8');

    // Existing article in sync state
    cache.saveSyncState({
      id: validUlid,
      localFilePath: relPath,
      localHash: 'hash_old',
      remoteRev: 'rev_v1',
      status: 'draft',
      slug: 'byline-test-post',
      lastSyncedAt: 1730500000,
    });

    let capturedPayload: any = null;
    const mockFetch = vi.fn().mockImplementation((url, init) => {
      const urlStr = String(url);
      if (init.method === 'POST') {
        if (!urlStr.includes('/terms/') && !urlStr.includes('/lock')) {
          try {
            capturedPayload = JSON.parse(init.body);
          } catch {
            // ignore
          }
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            enabled: true,
            holder: null,
            heldByCaller: true,
            id: validUlid,
            _rev: 'rev_v2',
          }),
        });
      }
      if (init.method === 'PUT') {
        capturedPayload = JSON.parse(init.body);
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: validUlid, _rev: 'rev_v2' }),
        });
      }
      if (init.method === 'DELETE') {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error('Unexpected fetch call'));
    });

    const res = await pushArticle(relPath, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.success).toBe(true);
    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload.bylines).toEqual([
      { bylineId: '01M67MY3691HMDHDPS4HF5GBB0', roleLabel: null },
    ]);
  });

  it('pushArticle does not move draft file if publish endpoint fails', async () => {
    const draftFm: Frontmatter = {
      id: validUlid,
      slug: 'failing-publish-post',
      title: 'Failing Publish Post',
      collection: 'posts',
      status: 'published',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const draftMd = serializeMarkdown(
      draftFm,
      'Ready for publish but remote publish endpoint fails.',
    );
    const relPath = `posts/draft/${todayPrefix}${validUlid}-Failing-Post.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, draftMd, 'utf8');

    cache.saveSyncState({
      id: validUlid,
      localFilePath: relPath,
      localHash: 'hash_old',
      remoteRev: 'rev_v1',
      status: 'draft',
      slug: 'failing-publish-post',
      lastSyncedAt: 1730500000,
    });

    const mockFetch = vi.fn().mockImplementation((url, init) => {
      const urlStr = String(url);
      if (init.method === 'POST') {
        if (urlStr.includes('/publish')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: async () => 'Publish failed',
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ enabled: true, holder: null, heldByCaller: true }),
        });
      }
      if (init.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: validUlid, _rev: 'rev_v2' }),
        });
      }
      if (init.method === 'DELETE') {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error('Unexpected fetch call'));
    });

    await expect(
      pushArticle(relPath, {
        ...options,
        workspaceRoot: tempDir,
        cache,
        allowPublish: true,
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow();

    // Verify local file is still in draft/ and NOT moved to published/
    expect(fs.existsSync(fullPath)).toBe(true);
    const publishedPath = path.join(
      tempDir,
      `posts/published/${todayPrefix}${validUlid}-Failing-Post.md`,
    );
    expect(fs.existsSync(publishedPath)).toBe(false);
  });

  it('getWorkspaceStatus sorts items descending by filename date across draft and published', () => {
    const articles = [
      {
        sub: 'draft',
        file: '20240120_01M67N19JPWNGFZ0M6KBQ8FS01-Old-Draft.md',
        id: '01M67N19JPWNGFZ0M6KBQ8FS01',
        title: 'Old Draft',
        status: 'draft' as const,
      },
      {
        sub: 'published',
        file: '20250615_01M67N19JPWNGFZ0M6KBQ8FS02-Mid-Published.md',
        id: '01M67N19JPWNGFZ0M6KBQ8FS02',
        title: 'Mid Published',
        status: 'published' as const,
      },
      {
        sub: 'published',
        file: '20261105_01M67N19JPWNGFZ0M6KBQ8FS03-Newest-Published.md',
        id: '01M67N19JPWNGFZ0M6KBQ8FS03',
        title: 'Newest Published',
        status: 'published' as const,
      },
      {
        sub: 'draft',
        file: '20261106_01M67N19JPWNGFZ0M6KBQ8FS04-Newest-Draft.md',
        id: '01M67N19JPWNGFZ0M6KBQ8FS04',
        title: 'Newest Draft',
        status: 'draft' as const,
      },
    ];

    for (const a of articles) {
      const fullPath = path.join(tempDir, 'posts', a.sub, a.file);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      const fm: Frontmatter = {
        id: a.id,
        slug: a.title.toLowerCase().replace(/\s+/g, '-'),
        title: a.title,
        collection: 'posts',
        status: a.status,
        locale: 'ja',
        taxonomies: {},
        bylines: [],
      };
      fs.writeFileSync(fullPath, serializeMarkdown(fm, 'Body content'), 'utf8');
    }

    const res = getWorkspaceStatus(tempDir, cache, 'posts');
    expect(res.items).toHaveLength(4);
    // Verifies newest date first, regardless of draft vs published directory
    expect(res.items[0].filePath).toBe(
      'posts/draft/20261106_01M67N19JPWNGFZ0M6KBQ8FS04-Newest-Draft.md',
    );
    expect(res.items[1].filePath).toBe(
      'posts/published/20261105_01M67N19JPWNGFZ0M6KBQ8FS03-Newest-Published.md',
    );
    expect(res.items[2].filePath).toBe(
      'posts/published/20250615_01M67N19JPWNGFZ0M6KBQ8FS02-Mid-Published.md',
    );
    expect(res.items[3].filePath).toBe(
      'posts/draft/20240120_01M67N19JPWNGFZ0M6KBQ8FS01-Old-Draft.md',
    );
  });

  it('getWorkspaceStatus surfaces invalid YAML frontmatter files and pushAll safely excludes them', async () => {
    const brokenId = '01M67N19JPWNGFZ0M6KBQ8FS99';
    const brokenRelPath = `posts/published/20261107_${brokenId}-Broken-Post.md`;
    const brokenFullPath = path.join(tempDir, brokenRelPath);
    fs.mkdirSync(path.dirname(brokenFullPath), { recursive: true });

    // Unquoted %-prefixed taxonomy term (legacy serializer output)
    const brokenMarkdown = [
      '---',
      `id: ${brokenId}`,
      'slug: broken-post',
      'title: "Broken Post"',
      'collection: posts',
      'status: published',
      'locale: ja',
      'taxonomies:',
      '  categories:',
      '    - %e6%9c%aa%e5%88%86%e9%a1%9e',
      '  tags:',
      '    []',
      'bylines:',
      '  []',
      '---',
      '',
      'Broken body.',
    ].join('\n');
    fs.writeFileSync(brokenFullPath, brokenMarkdown, 'utf8');

    const status = getWorkspaceStatus(tempDir, cache, 'posts');
    expect(status.summary.total).toBe(1);
    expect(status.summary.invalid).toBe(1);
    expect(status.items[0].syncStatus).toBe('invalid');
    expect(status.items[0].id).toBe(brokenId);
    expect(status.items[0].error).toBeDefined();

    // pushAll must NOT crash on the invalid file; it should skip it and report invalid: 1
    const pushAllRes = await pushAll({
      ...options,
      workspaceRoot: tempDir,
      cache,
    });
    expect(pushAllRes.total).toBe(0);
    expect(pushAllRes.pushed).toBe(0);
    expect(pushAllRes.invalid).toBe(1);
  });

  it('pullArticle self-heals a legacy broken YAML frontmatter file even when localHash matches disk', async () => {
    const brokenId = '01M67N19JPWNGFZ0M6KBQ8FS88';
    const relPath = `posts/published/20261107_${brokenId}-Self-Heal.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const brokenMarkdown = [
      '---',
      `id: ${brokenId}`,
      'slug: self-heal',
      'title: "Self Heal"',
      'collection: posts',
      'status: published',
      'publishedAt: "2026-11-07T00:00:00.000Z"',
      'locale: ja',
      'taxonomies:',
      '  categories:',
      '    - %e6%9c%aa%e5%88%86%e9%a1%9e',
      '  tags:',
      '    []',
      'bylines:',
      '  []',
      '---',
      '',
      'Self heal body.',
    ].join('\n');
    fs.writeFileSync(fullPath, brokenMarkdown, 'utf8');
    const brokenHash = calculateHash(brokenMarkdown);

    cache.saveSyncState({
      id: brokenId,
      localFilePath: relPath,
      localHash: brokenHash,
      remoteRev: 'rev_1',
      status: 'published',
      slug: 'self-heal',
      lastSyncedAt: 1730500000,
    });

    const rawItem = {
      id: brokenId,
      slug: 'self-heal',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-07T00:00:00.000Z',
      _rev: 'rev_1',
      data: {
        title: 'Self Heal',
        body: 'Self heal body.',
      },
    };

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/terms/category')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: { terms: [{ id: '01M6CAT1', slug: '%e6%9c%aa%e5%88%86%e9%a1%9e' }] },
          }),
        });
      }
      if (url.includes('/terms/tag')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: { terms: [] } }),
        });
      }
      if (url.includes('/bylines')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: { bylines: [] } }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    // Pull without --force: Fast-path detects parseMarkdown failure and falls through to re-serialize
    const res = await pullArticle('posts', brokenId, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      rawItem,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.updated).toBe(true);
    expect(res.skipped).toBeUndefined();

    const healedContent = fs.readFileSync(fullPath, 'utf8');
    expect(healedContent).toContain('    - "%e6%9c%aa%e5%88%86%e9%a1%9e"');
    const parsed = parseMarkdown(healedContent);
    expect(parsed.frontmatter.taxonomies?.categories).toEqual(['%e6%9c%aa%e5%88%86%e9%a1%9e']);

    // Now getWorkspaceStatus sees it as synced (0 invalid)
    const status = getWorkspaceStatus(tempDir, cache, 'posts');
    expect(status.summary.invalid).toBe(0);
    expect(status.summary.synced).toBe(1);
  });

  it('pushArticle reports previousId and previousFilePath when initial POST assigns a new server ULID', async () => {
    const provisionalId = '01M60000000000000000000001';
    const assignedServerId = '01M6SERVERASSIGNEDULID9999';
    const fm: Frontmatter = {
      id: provisionalId,
      slug: 'new-post-ulid-swap',
      title: 'New Post ULID Swap',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const relPath = `posts/draft/20261108_${provisionalId}-New-Post-ULID-Swap.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, serializeMarkdown(fm, 'Initial draft body.'), 'utf8');

    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && !url.includes('/terms/')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: {
              id: assignedServerId,
              slug: 'new-post-ulid-swap',
              createdAt: '2026-11-08T00:00:00.000Z',
              _rev: '1',
            },
          }),
        });
      }
      if (url.includes('/bylines')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: { bylines: [] } }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const res = await pushArticle(relPath, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.success).toBe(true);
    expect(res.id).toBe(assignedServerId);
    expect(res.previousId).toBe(provisionalId);
    expect(res.previousFilePath).toBe(relPath);
    expect(res.filePath).toBe(`posts/draft/20261108_${assignedServerId}-New-Post-ULID-Swap.md`);
  });

  it('pullArticle repairs an uncached invalid file and cleans up stale duplicate filenames for the same ULID', async () => {
    const uncachedId = '01M67N0TNFS6F3PJX4T96NKPKT';
    // Uncached legacy file with lowercased title slug and 20190405_ prefix (no entry in sync_state)
    const oldBrokenRelPath = `posts/published/20190405_${uncachedId}-old-post.md`;
    const oldBrokenFullPath = path.join(tempDir, oldBrokenRelPath);
    fs.mkdirSync(path.dirname(oldBrokenFullPath), { recursive: true });
    fs.writeFileSync(
      oldBrokenFullPath,
      [
        '---',
        `id: ${uncachedId}`,
        'slug: old-post',
        'title: "Old Post"',
        'collection: posts',
        'status: published',
        'locale: ja',
        'taxonomies:',
        '  categories:',
        '    - %e6%9c%aa%e5%88%86%e9%a1%9e',
        '---',
        '',
        'Old post body.',
      ].join('\n'),
      'utf8',
    );

    const statusBefore = getWorkspaceStatus(tempDir, cache, 'posts');
    expect(statusBefore.summary.invalid).toBe(1);
    expect(statusBefore.items[0].cached).toBe(false);

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith(`/content/posts/${uncachedId}`)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: uncachedId,
            slug: 'old-post',
            collection: 'posts',
            status: 'published',
            _rev: 'rev_1',
            data: {
              title: 'Repaired Old Post',
              body: 'Old post body.',
            },
          }),
        });
      }
      if (url.includes('/terms/category')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: { terms: [{ id: '01M6CAT1', slug: '%e6%9c%aa%e5%88%86%e9%a1%9e' }] },
          }),
        });
      }
      if (url.includes('/terms/tag')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: { terms: [] } }),
        });
      }
      if (url.includes('/bylines')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: { bylines: [] } }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    // Repair via single-article pull (emit pull <ULID>)
    const res = await pullArticle('posts', uncachedId, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    // Preserves 20190405_ prefix from existing disk file and writes canonical title filename
    expect(res.filePath).toBe(`posts/published/20190405_${uncachedId}-Repaired-Old-Post.md`);
    // Old broken file ("-old-post.md") is removed so no duplicate remains
    expect(fs.existsSync(oldBrokenFullPath)).toBe(false);
    expect(fs.existsSync(path.join(tempDir, res.filePath))).toBe(true);
    expect(fs.readdirSync(path.join(tempDir, 'posts/published'))).toEqual([
      `20190405_${uncachedId}-Repaired-Old-Post.md`,
    ]);

    const statusAfter = getWorkspaceStatus(tempDir, cache, 'posts');
    expect(statusAfter.summary.total).toBe(1);
    expect(statusAfter.summary.synced).toBe(1);
    expect(statusAfter.summary.invalid).toBe(0);
  });

  it('pullArticle performs non-destructive frontmatter heal on local files with unpushed edits, preserving local body', async () => {
    const articleId = '01M6TESTHEALBODY0000000000';
    const relPath = `posts/draft/20261108_${articleId}-Heal-Test.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const brokenLocalContent = [
      '---',
      `id: ${articleId}`,
      'slug: heal-test',
      'title: "Heal Test"',
      'status: draft',
      'taxonomies:',
      '  categories:',
      '    - %e6%9c%aa%e5%88%86%e9%a1%9e', // unquoted %
      '---',
      '',
      'Valuable local modifications that have not been pushed.',
    ].join('\n');

    fs.writeFileSync(fullPath, brokenLocalContent, 'utf8');

    // Baseline cache exists with matching remoteRev
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: 'baseline_different_hash',
      remoteRev: 'rev_1',
      status: 'draft',
      slug: 'heal-test',
      lastSyncedAt: Math.floor(Date.now() / 1000),
    });

    const statusBefore = getWorkspaceStatus(tempDir, cache, 'posts');
    expect(statusBefore.summary.invalid).toBe(1);

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/terms/category')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: { terms: [{ id: '01CAT', slug: '%e6%9c%aa%e5%88%86%e9%a1%9e' }] },
          }),
        });
      }
      if (url.includes('/terms/tag')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: { terms: [{ id: '01TAG', slug: 'travel' }] },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ data: {} }),
      });
    });

    const res = await pullArticle('posts', articleId, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      rawItem: {
        id: articleId,
        slug: 'heal-test',
        status: 'draft',
        _rev: 'rev_1',
        data: { title: 'Heal Test' },
      },
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.updated).toBe(true);
    expect(res.healed).toBe(true);
    expect(res.meaningChanged).toBe(false);

    // The file on disk now has valid frontmatter AND strictly preserves the local body
    const diskContentAfter = fs.readFileSync(fullPath, 'utf8');
    expect(diskContentAfter).toContain('    - "%e6%9c%aa%e5%88%86%e9%a1%9e"');
    expect(diskContentAfter).toContain('Valuable local modifications that have not been pushed.');

    const parsed = parseMarkdown(diskContentAfter);
    expect(parsed.frontmatter.taxonomies?.categories).toEqual(['%e6%9c%aa%e5%88%86%e9%a1%9e']);
    expect(parsed.body.trim()).toBe('Valuable local modifications that have not been pushed.');

    // Base snapshot contains remote taxonomy assignments (NEW-1)
    const baseSnapshot = cache.getBaseSnapshot(articleId);
    expect(baseSnapshot).not.toBeNull();
    const baseFm = JSON.parse(baseSnapshot!.frontmatterYaml);
    expect(baseFm.taxonomies?.categories).toEqual(['%e6%9c%aa%e5%88%86%e9%a1%9e']);
    expect(baseFm.taxonomies?.tags).toEqual(['travel']);

    const statusAfter = getWorkspaceStatus(tempDir, cache, 'posts');
    expect(statusAfter.summary.invalid).toBe(0);
    expect(statusAfter.summary.modified).toBe(1); // correctly identified as modified local edits!

    // Subsequent pull with same rev cleanly preserves local edits without quarantine or false conflict
    const res2 = await pullArticle('posts', articleId, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      rawItem: {
        id: articleId,
        slug: 'heal-test',
        status: 'draft',
        _rev: 'rev_1',
        data: { title: 'Heal Test' },
      },
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    expect(res2.skipped).toBe(true);
    expect(res2.localEditsPreserved).toBe(true);
    expect(res2.quarantined).toBeUndefined();
  });

  it('pullArticle performs non-destructive frontmatter heal on single-article pull fetched via HTTP (D5)', async () => {
    const singleHealId = '01M67SINGLEHEAL00000000001';
    const relPath = `posts/draft/20261109_${singleHealId}-Single-Heal.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    // Local file with unquoted percent-encoded category and unpushed body edits
    const brokenContent = [
      '---',
      `id: ${singleHealId}`,
      'slug: single-heal',
      'title: "Single Heal"',
      'status: draft',
      'taxonomies:',
      '  categories:',
      '    - %e6%9c%aa%e5%88%86%e9%a1%9e',
      '---',
      '',
      'Unique local body edits that must be preserved.',
    ].join('\n');
    fs.writeFileSync(fullPath, brokenContent, 'utf8');

    cache.saveSyncState({
      id: singleHealId,
      localFilePath: relPath,
      localHash: 'baseline_hash_orig',
      remoteRev: 'rev_remote_1',
      status: 'draft',
      slug: 'single-heal',
      lastSyncedAt: Math.floor(Date.now() / 1000),
    });

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes(`/posts/${singleHealId}`)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: singleHealId,
            slug: 'single-heal',
            collection: 'posts',
            status: 'draft',
            locale: 'ja',
            _rev: 'rev_remote_1',
            data: { title: 'Single Heal', body: 'Remote body content' },
          }),
        });
      }
      if (url.includes(`/terms/category`)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: { terms: [{ id: 'cat1', slug: '%e6%9c%aa%e5%88%86%e9%a1%9e' }] },
          }),
        });
      }
      if (url.includes(`/terms/tag`)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: { terms: [] } }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    // Invoke pullArticle WITHOUT rawItem (simulates `emit pull <id>`)
    const res = await pullArticle('posts', singleHealId, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.healed).toBe(true);
    expect(res.updated).toBe(true);
    expect(res.quarantined).toBeUndefined();

    // Verify local body was preserved
    const diskContentAfter = fs.readFileSync(fullPath, 'utf8');
    expect(diskContentAfter).toContain('Unique local body edits that must be preserved.');
    expect(diskContentAfter).toContain('"%e6%9c%aa%e5%88%86%e9%a1%9e"');
  });

  it('pullArticle falls through to quarantine when frontmatter cannot be leniently healed without altering meaning (M-3)', async () => {
    const unhealableId = '01M6UNHEALABLE00000000000';
    const relPath = `posts/draft/20261108_${unhealableId}-Unhealable.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    // Severely corrupted frontmatter (mismatched brackets, invalid syntax) that lenient repair refuses
    const unhealableContent = [
      '---',
      `id: ${unhealableId}`,
      'slug: unhealable-post',
      'title: "Unhealable Post"',
      'status: draft',
      'taxonomies: {[[[corrupted syntax that cannot be healed safely]]]}',
      '---',
      '',
      'Valuable local content that must be rescued in conflicts/.',
    ].join('\n');

    fs.writeFileSync(fullPath, unhealableContent, 'utf8');

    cache.saveSyncState({
      id: unhealableId,
      localFilePath: relPath,
      localHash: 'baseline_hash_1',
      remoteRev: 'rev_1',
      status: 'draft',
      slug: 'unhealable-post',
      lastSyncedAt: Math.floor(Date.now() / 1000),
    });

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (
        url.includes(`/terms/category`) ||
        url.includes(`/terms/tag`) ||
        url.includes(`/bylines`)
      ) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: { terms: [], bylines: [] } }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const res = await pullArticle('posts', unhealableId, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
      rawItem: {
        id: unhealableId,
        slug: 'unhealable-post',
        status: 'draft',
        _rev: 'rev_1',
        data: { title: 'Unhealable Post' },
      },
    });

    // Full pull executed with canonical write and quarantine preservation
    expect(res.updated).toBe(true);
    expect(res.quarantined).toBeDefined();
    expect(res.quarantined!.length).toBe(1);
    expect(res.quarantined![0].sourceFilePath).toBe(relPath);

    // Verify rescue copy preserved under posts/conflicts/ with valuable unpushed content
    const conflictRel = res.quarantined![0].quarantineFilePath;
    const conflictFull = path.join(tempDir, conflictRel);
    expect(fs.existsSync(conflictFull)).toBe(true);
    expect(fs.readFileSync(conflictFull, 'utf8')).toContain(
      'Valuable local content that must be rescued in conflicts/.',
    );
  });

  it('pullArticle heal maintains correct base snapshot taxonomy terms for subsequent 3-way merge when remote rev advances (NEW-1)', async () => {
    const articleId = '01M67HEAL3WAY0000000000001';
    const relPath = `posts/draft/20261108_${articleId}-Heal-3Way.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    // 1. Broken local file with unquoted % category, plus local body edits
    const brokenLocalContent = [
      '---',
      `id: ${articleId}`,
      'slug: heal-3way',
      'title: "Heal 3Way"',
      'status: draft',
      'taxonomies:',
      '  categories:',
      '    - %e6%9c%aa%e5%88%86%e9%a1%9e',
      '---',
      '',
      'Local valuable body edits.',
    ].join('\n');
    fs.writeFileSync(fullPath, brokenLocalContent, 'utf8');

    // Baseline cache exists with matching remoteRev rev_1
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: 'baseline_different_hash',
      remoteRev: 'rev_1',
      status: 'draft',
      slug: 'heal-3way',
      lastSyncedAt: Math.floor(Date.now() / 1000),
    });

    // Mock fetch for rev_1
    let remoteTags = ['travel'];
    let remoteRev = 'rev_1';
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/terms/category')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: { terms: [{ id: '01CAT', slug: '%e6%9c%aa%e5%88%86%e9%a1%9e' }] },
          }),
        });
      }
      if (url.includes('/terms/tag')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: { terms: remoteTags.map((t) => ({ id: `id-${t}`, slug: t })) },
          }),
        });
      }
      if (url.includes(`/posts/${articleId}`)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: articleId,
            slug: 'heal-3way',
            collection: 'posts',
            status: 'draft',
            locale: 'ja',
            _rev: remoteRev,
            data: { title: 'Heal 3Way', body: 'Remote body content' },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ data: {} }),
      });
    });

    // 1. Heal fast-path runs
    const healRes = await pullArticle('posts', articleId, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      rawItem: {
        id: articleId,
        slug: 'heal-3way',
        collection: 'posts',
        status: 'draft',
        locale: 'ja',
        _rev: 'rev_1',
        data: { title: 'Heal 3Way', body: 'Remote body content' },
      },
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    expect(healRes.healed).toBe(true);

    // Verify base snapshot contains remote taxonomy terms (NEW-1)
    const baseSnapshot = cache.getBaseSnapshot(articleId);
    expect(baseSnapshot).not.toBeNull();
    const baseFm = JSON.parse(baseSnapshot!.frontmatterYaml);
    expect(baseFm.taxonomies?.categories).toEqual(['%e6%9c%aa%e5%88%86%e9%a1%9e']);
    expect(baseFm.taxonomies?.tags).toEqual(['travel']);

    // 2. Perform 3-way merge using baseSnapshot when remote adds a tag
    const localParsed = parseMarkdown(fs.readFileSync(fullPath, 'utf8'));
    const remoteState = {
      frontmatter: {
        ...baseFm,
        taxonomies: {
          categories: ['%e6%9c%aa%e5%88%86%e9%a1%9e'],
          tags: ['travel', 'japan'], // Remote added 'japan'
        },
      },
      body: 'Remote body content',
    };

    const mergeResult = hybrid3WayMerge(
      localParsed,
      {
        frontmatter: baseFm,
        body: baseSnapshot!.bodyMarkdown,
      },
      remoteState,
    );

    expect(mergeResult.hasConflict).toBe(false);
    expect(mergeResult.frontmatter.taxonomies?.categories).toEqual(['%e6%9c%aa%e5%88%86%e9%a1%9e']);
    expect(mergeResult.frontmatter.taxonomies?.tags).toEqual(['travel', 'japan']);
    expect(mergeResult.body.trim()).toBe('Local valuable body edits.');
  });

  it('preserves local unpushed edits across rev formats (Base64 token vs numeric rev)', async () => {
    const articleId = '01M6TESTB64REV000000000001';
    const relPath = 'posts/draft/20261109_01M6TESTB64REV000000000001-test.md';
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    // Local content with unpushed edits
    const localContent = `---
id: ${articleId}
slug: test
title: test
collection: posts
status: draft
publishedAt: null
locale: ja
---

My valuable unpushed local edits
`;
    fs.writeFileSync(fullPath, localContent, 'utf8');

    // Simulate previous push or single pull that saved Base64 encoded rev token ("1:...")
    const b64Rev = Buffer.from('1:2026-10-31T00:16:28.950Z').toString('base64');
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: 'hash-of-original', // differs from localContent hash (unpushed edits)
      remoteRev: b64Rev,
      status: 'draft',
      slug: 'test',
      lastSyncedAt: 1000,
    });
    cache.saveBaseSnapshot({
      id: articleId,
      rev: b64Rev,
      bodyMarkdown: 'Original body',
      frontmatterYaml: JSON.stringify({
        id: articleId,
        slug: 'test',
        title: 'test',
        collection: 'posts',
        status: 'draft',
        locale: 'ja',
      }),
      hash: 'hash-of-original',
      savedAt: 1000,
    });

    // Mock API returning numeric rev ("1")
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/posts?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: articleId,
                slug: 'test',
                status: 'draft',
                title: 'test',
                _rev: '1',
              },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const res = await pullBatch({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://test.emdash.local',
      token: 'test-token',
      collection: 'posts',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const itemRes = res.items.find((r) => r.id === articleId);
    expect(itemRes).toBeDefined();
    expect(itemRes?.localEditsPreserved).toBe(true);

    // Verify canonical file still has local edits and conflicts/ is empty
    expect(fs.readFileSync(fullPath, 'utf8')).toBe(localContent);
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    const conflictFiles = fs.existsSync(conflictsDir) ? fs.readdirSync(conflictsDir) : [];
    expect(conflictFiles).toHaveLength(0);
  });

  it('single pull preserves local unpushed edits when rev is Base64 token on disk and numeric on remote', async () => {
    const articleId = '01M6TESTSNGLPULLB640000001';
    const relPath = 'posts/draft/20261109_01M6TESTSNGLPULLB640000001-test.md';
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const localContent = `---
id: ${articleId}
slug: test
title: test
collection: posts
status: draft
publishedAt: null
locale: ja
---

Valuable local unpushed content for single pull
`;
    fs.writeFileSync(fullPath, localContent, 'utf8');

    const b64Rev = Buffer.from('1:2026-10-31T00:16:28.950Z').toString('base64');
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: 'hash-of-original',
      remoteRev: b64Rev,
      status: 'draft',
      slug: 'test',
      lastSyncedAt: 1000,
    });
    cache.saveBaseSnapshot({
      id: articleId,
      rev: b64Rev,
      bodyMarkdown: 'Original body',
      frontmatterYaml: JSON.stringify({
        id: articleId,
        slug: 'test',
        title: 'test',
        collection: 'posts',
        status: 'draft',
        locale: 'ja',
      }),
      hash: 'hash-of-original',
      savedAt: 1000,
    });

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes(`/posts/${articleId}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: articleId,
            slug: 'test',
            status: 'draft',
            title: 'test',
            _rev: '1',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const res = await pullArticle('posts', articleId, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://test.emdash.local',
      token: 'test-token',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.localEditsPreserved).toBe(true);
    expect(fs.readFileSync(fullPath, 'utf8')).toBe(localContent);
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    const conflictFiles = fs.existsSync(conflictsDir) ? fs.readdirSync(conflictsDir) : [];
    expect(conflictFiles).toHaveLength(0);
  });

  it('pushArticle blocks with DELETE_PENDING_ARTICLE when article has delete_pending: 1 unless revive: true is passed', async () => {
    const articleId = '01M6TESTDELPEND00000000001';
    const relPath = `posts/draft/20261109_${articleId}-del-pending.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const content = `---
id: ${articleId}
slug: del-pending
title: Delete Pending
collection: posts
status: draft
publishedAt: null
locale: ja
---

Content
`;
    fs.writeFileSync(fullPath, content, 'utf8');
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: calculateHash(content),
      remoteRev: '1',
      status: 'draft',
      slug: 'del-pending',
      lastSyncedAt: 1000,
      deletePending: 1,
    });

    // Push without revive or force should be blocked
    await expect(
      pushArticle(relPath, {
        workspaceRoot: tempDir,
        cache,
        origin: 'https://test.emdash.local',
        token: 'test-token',
        fetchFn: (async () => ({})) as unknown as typeof fetch,
      }),
    ).rejects.toThrowError(/is marked as delete-pending/);

    // Push with revive: true should pass the guard
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: articleId, _rev: '2' }),
      };
    });

    const res = await pushArticle(relPath, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://test.emdash.local',
      token: 'test-token',
      revive: true,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.success).toBe(true);
    const updatedSync = cache.getSyncState(articleId);
    expect(updatedSync?.deletePending).toBe(0);
  });

  it('pushArticle converts server 400/422 on taxonomy union into TAXONOMY_UNION_REJECTED', async () => {
    const articleId = '01M6TESTUNIONREJ0000000001';
    const relPath = `posts/draft/20261109_${articleId}-union-reject.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const localContent = `---
id: ${articleId}
slug: union-reject
title: Union Reject
collection: posts
status: draft
publishedAt: null
locale: ja
taxonomies:
  categories:
    - news
    - cat-local
---

Shared Body
`;
    fs.writeFileSync(fullPath, localContent, 'utf8');

    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: 'hash-orig',
      remoteRev: '1',
      status: 'draft',
      slug: 'union-reject',
      lastSyncedAt: 1000,
    });
    cache.saveBaseSnapshot({
      id: articleId,
      rev: '1',
      bodyMarkdown: 'Shared Body',
      frontmatterYaml: JSON.stringify({
        id: articleId,
        slug: 'union-reject',
        title: 'Union Reject',
        collection: 'posts',
        status: 'draft',
        locale: 'ja',
        taxonomies: { categories: ['news'] },
      }),
      hash: 'hash-orig',
      savedAt: 1000,
    });

    // Mock API: PUT initially returns 409 conflict
    // GET returns remote with different category (e.g. ['tech'])
    // Retried PUT returns 422 (e.g. single category limit)
    let putAttempts = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        putAttempts++;
        if (putAttempts === 1) {
          return {
            ok: false,
            status: 409,
            statusText: 'Conflict',
            text: async () => 'Revision mismatch',
            json: async () => ({ message: 'Revision mismatch' }),
          };
        }
        return {
          ok: false,
          status: 422,
          statusText: 'Unprocessable Entity',
          text: async () => 'Only one category allowed per post',
          json: async () => ({ message: 'Only one category allowed per post' }),
        };
      }
      if (url.includes(`/content/posts/${articleId}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: articleId,
            slug: 'union-reject',
            status: 'draft',
            title: 'Union Reject',
            _rev: '2',
            data: { title: 'Union Reject', body: 'Shared Body' },
          }),
        };
      }
      if (url.includes(`/terms/category`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { terms: [{ id: 'cat2', slug: 'tech' }] },
          }),
        };
      }
      if (url.includes(`/terms/tag`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { terms: [] },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    await expect(
      pushArticle(relPath, {
        workspaceRoot: tempDir,
        cache,
        origin: 'https://test.emdash.local',
        token: 'test-token',
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrowError(/Remote server rejected the merged taxonomy union/);
  });
});
