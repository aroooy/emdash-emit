import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheDatabase } from '../src/db/cache.js';
import { pullArticle, calculateHash } from '../src/sync/pull.js';
import { createBaseSnapshot } from '../src/db/baseline.js';
import { serializeMarkdown, parseMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';

describe('Draft Revision Tracking (v0.1.22 Layer 2)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-draft-rev-test-'));
    cache = new CacheDatabase(path.join(tempDir, 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('pulls server draft updates when version is unchanged but draftRevisionId advanced', async () => {
    const articleId = '01M7BZH06K515A5NQWZ36QK7NQ';
    const relPath = `posts/draft/20261114_${articleId}-draft-rev-test.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const oldDraftRevId = '01M7OLDREV0000000000000000';
    const newDraftRevId = '01M7NEWREV0000000000000000';

    const oldFm: Frontmatter = {
      id: articleId,
      slug: 'draft-rev-test',
      title: 'Draft Rev Test',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: { categories: ['test'], tags: [] },
      bylines: ['aroooy'],
    };

    const oldBody = 'Old body before server edit.\n';
    const oldMarkdown = serializeMarkdown(oldFm, oldBody);
    fs.writeFileSync(fullPath, oldMarkdown, 'utf8');
    const oldHash = calculateHash(oldMarkdown);

    // Initial state: tracked with old composite rev
    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: articleId,
        rev: '3',
        bodyMarkdown: oldBody,
        frontmatter: oldFm,
        hash: oldHash,
      }),
    );

    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: oldHash,
      remoteRev: `3@draft:${oldDraftRevId}`,
      status: 'draft',
      slug: 'draft-rev-test',
      lastSyncedAt: 1000,
    });

    const newBody = 'New body edited on server with image.\n\n![img](../../media/test.jpg)\n';

    // Mock fetch for single article GET and taxonomies
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/category/terms') || url.includes('/tag/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: { terms: [] },
          }),
        });
      }

      if (url.includes(`/posts/${articleId}`)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              item: {
                id: articleId,
                version: 3,
                draftRevisionId: newDraftRevId,
                liveRevisionId: null,
                status: 'draft',
                slug: 'draft-rev-test',
                updatedAt: '2026-11-14T02:52:29.779Z',
                data: {
                  title: 'Draft Rev Test',
                  content: [
                    {
                      _type: 'block',
                      _key: 'b1',
                      children: [{ _type: 'span', text: 'New body edited on server with image.' }],
                    },
                  ],
                },
              },
              _rev: 'MzoyMDI2LTExLTE0VDAyOjUyOjI5Ljc3OVo=',
            },
          }),
        });
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    // 1st pull: Must detect that draftRevisionId advanced, despite version being '3'
    const result1 = await pullArticle('posts', articleId, {
      origin: 'https://example.com',
      token: 'fake-token',
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch,
    });

    expect(result1.updated).toBe(true);
    expect(result1.skipped).toBeUndefined();

    // Verify disk content was updated
    const updatedContent = fs.readFileSync(fullPath, 'utf8');
    const parsedUpdated = parseMarkdown(updatedContent);
    expect(parsedUpdated.body).toContain('New body edited on server with image.');

    // Verify sync_state was updated to the new composite rev
    const updatedSync = cache.getSyncState(articleId);
    expect(updatedSync?.remoteRev).toBe(`3@draft:${newDraftRevId}`);

    // Verify base_snapshots saved the raw server token (Track 1)
    const updatedBase = cache.getBaseSnapshot(articleId);
    expect(updatedBase?.rev).toBe('MzoyMDI2LTExLTE0VDAyOjUyOjI5Ljc3OVo=');

    // 2nd pull (idempotency check): Both version and draftRevisionId match, should cleanly skip
    const result2 = await pullArticle('posts', articleId, {
      origin: 'https://example.com',
      token: 'fake-token',
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch,
    });

    expect(result2.updated).toBe(false);
    expect(result2.skipped).toBe(true);
  });
});
