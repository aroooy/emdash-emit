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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheDatabase } from '../src/db/cache.js';
import { pullBatch } from '../src/sync/orchestrator.js';
import { calculateHash } from '../src/sync/workspace/index.js';
import { computeArticleRelativePath } from '../src/utils/naming.js';

describe('Pull Window Pruning & Unpushed Edits Guard', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-prune-test-'));
    cache = new CacheDatabase(path.join(tempDir, 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function setupLocalArticle(
    id: string,
    slug: string,
    status: 'draft' | 'published',
    content: string,
    isModified: boolean = false,
  ) {
    const relPath = computeArticleRelativePath('posts', status, id, slug);
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const initialContent = content;
    const initialHash = calculateHash(initialContent);

    if (isModified) {
      fs.writeFileSync(fullPath, initialContent + '\n\nExtra local edits.');
    } else {
      fs.writeFileSync(fullPath, initialContent);
    }

    cache.saveEntry({
      id,
      collection: 'posts',
      slug,
      status,
      title: slug,
      rev: 'rev_1',
      rawJson: JSON.stringify({ id, slug, status }),
      updatedAt: Date.now(),
    });

    cache.saveSyncState({
      id,
      localFilePath: relPath,
      localHash: initialHash,
      remoteRev: 'rev_1',
      status,
      slug,
      lastSyncedAt: Date.now(),
    });

    return { relPath, fullPath };
  }

  it('automatically prunes clean local articles that fall outside the sync window', async () => {
    // Setup 3 articles locally
    const art1 = setupLocalArticle('01M6ART01', 'article-1', 'published', '# Article 1');
    const art2 = setupLocalArticle('01M6ART02', 'article-2', 'published', '# Article 2');
    const art3 = setupLocalArticle('01M6ART03', 'article-3', 'published', '# Article 3');

    // Remote only returns art1 and art2 (art3 pushed out due to limit = 2)
    const mockFetch = vi.fn().mockImplementation((urlStr: string) => {
      const url = new URL(urlStr);
      if (url.pathname === '/_emdash/api/openapi.json') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            paths: {
              '/_emdash/api/content/{collection}': {
                get: { parameters: [{ name: 'limit', schema: { maximum: 100 } }] },
              },
            },
          }),
        });
      }

      if (url.pathname === '/_emdash/api/content/posts') {
        const status = url.searchParams.get('status');
        if (status === 'draft') {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              items: [
                {
                  id: '01M6ART01',
                  slug: 'article-1',
                  status: 'published',
                  data: { title: 'Article 1' },
                  _rev: 'rev_1',
                },
                {
                  id: '01M6ART02',
                  slug: 'article-2',
                  status: 'published',
                  data: { title: 'Article 2' },
                  _rev: 'rev_1',
                },
              ],
              nextCursor: null,
            },
          }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { items: [] } }),
      });
    });

    const result = await pullBatch({
      collection: 'posts',
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      limit: 2,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.total).toBe(2);
    expect(result.deleted).toBe(1);

    // art1 and art2 should still exist (at canonical title-cased paths)
    const art1State = cache.getSyncState('01M6ART01');
    const art2State = cache.getSyncState('01M6ART02');
    expect(art1State?.localFilePath).toBe(art1.relPath.replace('-article-1.md', '-Article-1.md'));
    expect(art2State?.localFilePath).toBe(art2.relPath.replace('-article-2.md', '-Article-2.md'));
    expect(fs.existsSync(path.join(tempDir, art1State!.localFilePath))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, art2State!.localFilePath))).toBe(true);

    // art3 should be pruned from disk and cache
    expect(fs.existsSync(art3.fullPath)).toBe(false);
    expect(cache.getSyncState('01M6ART03')).toBeNull();
  });

  it('skips pruning out-of-window article with unpushed edits and warns via pruneSkipped without aborting pull', async () => {
    // art1 and art2 are clean, art3 has local edits, art4 is clean & out-of-window (should still prune!)
    setupLocalArticle('01M6ART01', 'article-1', 'published', '# Article 1');
    setupLocalArticle('01M6ART02', 'article-2', 'published', '# Article 2');
    const art3 = setupLocalArticle('01M6ART03', 'article-3', 'published', '# Article 3', true);
    const art4 = setupLocalArticle('01M6ART04', 'article-4', 'published', '# Article 4', false);

    const mockFetch = vi.fn().mockImplementation((urlStr: string) => {
      const url = new URL(urlStr);
      if (url.pathname === '/_emdash/api/openapi.json') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            paths: {
              '/_emdash/api/content/{collection}': {
                get: { parameters: [{ name: 'limit', schema: { maximum: 100 } }] },
              },
            },
          }),
        });
      }

      if (url.pathname === '/_emdash/api/content/posts') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              items: [
                {
                  id: '01M6ART01',
                  slug: 'article-1',
                  status: 'published',
                  data: { title: 'Article 1' },
                  _rev: 'rev_1',
                },
                {
                  id: '01M6ART02',
                  slug: 'article-2',
                  status: 'published',
                  data: { title: 'Article 2' },
                  _rev: 'rev_1',
                },
              ],
              nextCursor: null,
            },
          }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { items: [] } }),
      });
    });

    const result = await pullBatch({
      collection: 'posts',
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      limit: 2,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.windowLimit).toBe(2);
    expect(result.pruneSkipped).toHaveLength(1);
    expect(result.pruneSkipped?.[0]?.id).toBe('01M6ART03');
    // Clean out-of-window art4 must still be pruned normally
    expect(result.deleted).toBe(1);
    expect(fs.existsSync(art4.fullPath)).toBe(false);
    // art3 must NOT be deleted
    expect(fs.existsSync(art3.fullPath)).toBe(true);
    expect(cache.getSyncState('01M6ART03')).not.toBeNull();
  });

  it('respects prune: false to keep articles outside the sync window', async () => {
    setupLocalArticle('01M6ART01', 'article-1', 'published', '# Article 1');
    setupLocalArticle('01M6ART02', 'article-2', 'published', '# Article 2');
    const art3 = setupLocalArticle('01M6ART03', 'article-3', 'published', '# Article 3');

    const mockFetch = vi.fn().mockImplementation((urlStr: string) => {
      const url = new URL(urlStr);
      if (url.pathname === '/_emdash/api/openapi.json') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            paths: {
              '/_emdash/api/content/{collection}': {
                get: { parameters: [{ name: 'limit', schema: { maximum: 100 } }] },
              },
            },
          }),
        });
      }

      if (url.pathname === '/_emdash/api/content/posts') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              items: [
                {
                  id: '01M6ART01',
                  slug: 'article-1',
                  status: 'published',
                  data: { title: 'Article 1' },
                  _rev: 'rev_1',
                },
              ],
              nextCursor: null,
            },
          }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { items: [] } }),
      });
    });

    const result = await pullBatch({
      collection: 'posts',
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      limit: 1,
      prune: false, // Explicitly disabled
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.deleted).toBe(0);
    expect(fs.existsSync(art3.fullPath)).toBe(true);
  });

  it('only prunes items matching the requested status filter', async () => {
    const pubArt = setupLocalArticle('01M6PUB01', 'pub-1', 'published', '# Published');
    const draftArt = setupLocalArticle('01M6DRF01', 'draft-1', 'draft', '# Draft 1');

    const mockFetch = vi.fn().mockImplementation((urlStr: string) => {
      const url = new URL(urlStr);
      if (url.pathname === '/_emdash/api/openapi.json') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            paths: {
              '/_emdash/api/content/{collection}': {
                get: { parameters: [{ name: 'limit', schema: { maximum: 100 } }] },
              },
            },
          }),
        });
      }

      // When status=draft is fetched, only returns empty draft
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
      });
    });

    await pullBatch({
      collection: 'posts',
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      status: 'draft', // only pulling drafts
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    // draft-1 was pruned because remote had no drafts
    expect(fs.existsSync(draftArt.fullPath)).toBe(false);
    // pub-1 MUST NOT be pruned because we only pulled drafts
    expect(fs.existsSync(pubArt.fullPath)).toBe(true);
  });

  it('prunes clean duplicate filenames on disk sharing the same 26-char ULID', async () => {
    const ulid = '01M67N0TNFS6F3PJX4T96NKPKT';
    const canonical = setupLocalArticle(ulid, 'canonical-post', 'published', '# Canonical');
    // Simulate a lingering clean duplicate file for the same ULID (matching baseline hash)
    const legacyDuplicatePath = path.join(
      tempDir,
      `posts/published/20190405_${ulid}-legacy-duplicate.md`,
    );
    fs.writeFileSync(legacyDuplicatePath, '# Canonical', 'utf8');

    const mockFetch = vi.fn().mockImplementation((urlStr: string) => {
      const url = new URL(urlStr);
      if (url.pathname === '/_emdash/api/openapi.json') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            paths: {
              '/_emdash/api/content/{collection}': {
                get: { parameters: [{ name: 'limit', schema: { maximum: 100 } }] },
              },
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
      });
    });

    const result = await pullBatch({
      collection: 'posts',
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      limit: 2,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.deleted).toBe(1);
    expect(fs.existsSync(canonical.fullPath)).toBe(false);
    expect(fs.existsSync(legacyDuplicatePath)).toBe(false);
  });

  it('skips pruning for the entire ULID if a duplicate filename sharing the 26-char ULID has unpushed edits', async () => {
    const ulid = '01M67N0TNFS6F3PJX4T96NKPKT';
    const canonical = setupLocalArticle(ulid, 'canonical-post', 'published', '# Canonical');
    // Canonical file is clean, but a duplicate file sharing the ULID has unpushed local modifications
    const editedDuplicateRelPath = `posts/published/20190405_${ulid}-legacy-edited-copy.md`;
    const editedDuplicateFullPath = path.join(tempDir, editedDuplicateRelPath);
    fs.writeFileSync(
      editedDuplicateFullPath,
      '# Canonical\n\nVALUABLE UNPUSHED LOCAL REWRITING.',
      'utf8',
    );

    const mockFetch = vi.fn().mockImplementation((urlStr: string) => {
      const url = new URL(urlStr);
      if (url.pathname === '/_emdash/api/openapi.json') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            paths: {
              '/_emdash/api/content/{collection}': {
                get: { parameters: [{ name: 'limit', schema: { maximum: 100 } }] },
              },
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
      });
    });

    const result = await pullBatch({
      collection: 'posts',
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      limit: 2,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.deleted).toBe(0);
    expect(result.pruneSkipped).toHaveLength(1);
    expect(result.pruneSkipped?.[0]?.filePath).toBe(editedDuplicateRelPath);
    // Neither the canonical file nor the edited duplicate file may be deleted
    expect(fs.existsSync(canonical.fullPath)).toBe(true);
    expect(fs.existsSync(editedDuplicateFullPath)).toBe(true);
  });

  it('reports pruneSkipped counts as files and deduplicated articles when several files share one ULID', async () => {
    const ulid = '01M67N0TNFS6F3PJX4T96NKPKT';
    const canonical = setupLocalArticle(ulid, 'canonical-post', 'published', '# Canonical');
    fs.writeFileSync(canonical.fullPath, '# Canonical\n\nLocal canonical edits.', 'utf8');
    const duplicateRelPath = `posts/published/20190405_${ulid}-legacy-edited-copy.md`;
    const duplicateFullPath = path.join(tempDir, duplicateRelPath);
    fs.writeFileSync(duplicateFullPath, '# Canonical\n\nLocal duplicate edits.', 'utf8');

    const mockFetch = vi.fn().mockImplementation((urlStr: string) => {
      const url = new URL(urlStr);
      if (url.pathname === '/_emdash/api/openapi.json') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            paths: {
              '/_emdash/api/content/{collection}': {
                get: { parameters: [{ name: 'limit', schema: { maximum: 100 } }] },
              },
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
      });
    });

    const result = await pullBatch({
      collection: 'posts',
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      limit: 2,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.deleted).toBe(0);
    expect(result.pruneSkipped).toHaveLength(2);
    expect(new Set(result.pruneSkipped?.map((i) => i.id)).size).toBe(1);
    expect(fs.existsSync(canonical.fullPath)).toBe(true);
    expect(fs.existsSync(duplicateFullPath)).toBe(true);
  });
});
