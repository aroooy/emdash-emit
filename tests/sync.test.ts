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
import { pullArticle } from '../src/sync/pull.js';
import { pushArticle, PushValidationError } from '../src/sync/push.js';
import { getWorkspaceStatus } from '../src/sync/status.js';
import { formatDatePrefix, serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';

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
});
