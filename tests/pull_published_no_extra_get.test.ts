import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheDatabase } from '../src/db/cache.js';
import { pullBatch } from '../src/sync/orchestrator.js';
import { createBaseSnapshot } from '../src/db/baseline.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';
import { calculateHash } from '../src/sync/workspace/index.js';

describe('Published Article Pull Zero-Overhead Invariant (v0.1.23 Layer 2)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-published-pull-test-'));
    cache = new CacheDatabase(path.join(tempDir, 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('updates published article from list API without calling single GET (zero extra HTTP requests)', async () => {
    const articleId = '01M77VFT15HSH2M1XW8MJPTCPQ';
    const relPath = `posts/ja/published/20261113_${articleId}-published-test.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const oldLiveRevId = '01M7OLDLIVE00000000000000';
    const newLiveRevId = '01M7NEWLIVE00000000000000';

    const fm: Frontmatter = {
      id: articleId,
      slug: 'published-test',
      title: 'published-test',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-13T00:00:00.000Z',
      locale: 'ja',
      taxonomies: { categories: ['news'], tags: [] },
      bylines: ['aroooy'],
    };

    const initialBody = 'Initial published content on disk.\n';
    const initialMarkdown = serializeMarkdown(fm, initialBody);
    fs.writeFileSync(fullPath, initialMarkdown, 'utf8');
    const initialHash = calculateHash(initialMarkdown);

    // Initial state: tracked with OLD live composite rev
    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: articleId,
        rev: '1',
        bodyMarkdown: initialBody,
        frontmatter: fm,
        hash: initialHash,
      }),
    );

    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: initialHash,
      remoteRev: `1@live:${oldLiveRevId}`,
      status: 'published',
      slug: 'published-test',
      lastSyncedAt: 1000,
    });

    const updatedPublishedItem = {
      id: articleId,
      version: 2,
      liveRevisionId: newLiveRevId,
      draftRevisionId: null,
      status: 'published',
      slug: 'published-test',
      publishedAt: '2026-11-13T00:00:00.000Z',
      updatedAt: '2026-11-14T03:00:00.000Z',
      data: {
        title: 'published-test',
        content: [
          {
            _type: 'block',
            _key: 'b1',
            children: [{ _type: 'span', text: 'Updated published body directly from list API.' }],
          },
        ],
      },
    };

    let singleGetCallCount = 0;

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      // 1. openapi.json for limit discovery
      if (url.includes('openapi.json')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            paths: {
              '/_emdash/api/content/{collection}': {
                get: { parameters: [{ name: 'limit', schema: { maximum: 50, default: 50 } }] },
              },
            },
          }),
        });
      }

      // 2. Bylines sync
      if (url.includes('/bylines') || url.includes('/authors')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { items: [] } }),
        });
      }

      // 3. Taxonomies terms
      if (url.includes('/category/terms') || url.includes('/tag/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: [] } }),
        });
      }

      // 4. List remote articles (draft and published)
      if (url.includes('/content/posts?')) {
        if (url.includes('status=published')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              data: {
                items: [updatedPublishedItem],
                total: 1,
              },
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              items: [],
              total: 0,
            },
          }),
        });
      }

      // 5. Single article GET: must NOT be called for published article!
      if (url.endsWith(`/posts/${articleId}`)) {
        singleGetCallCount++;
        return Promise.reject(
          new Error(`Single GET was unexpectedly called for published article: ${url}`),
        );
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    // Execute pullBatch with mediaSync: false
    const batchResult = await pullBatch({
      workspaceRoot: tempDir,
      collection: 'posts',
      origin: 'https://example.com',
      token: 'fake-token',
      cache,
      fetchFn: mockFetch,
      mediaSync: false,
      prune: false,
    });

    // Assert article was updated
    expect(batchResult.items.length).toBe(1);
    expect(batchResult.items[0].updated).toBe(true);

    // CRITICAL INVARIANT: Single GET must have been called 0 times!
    expect(singleGetCallCount).toBe(0);

    // Verify disk content was updated directly from list API's data.content
    const updatedContent = fs.readFileSync(fullPath, 'utf8');
    expect(updatedContent).toContain('Updated published body directly from list API.');

    // Verify sync_state remoteRev advanced to the new live composite rev
    const syncState = cache.getSyncState(articleId);
    expect(syncState?.remoteRev).toBe(`2@live:${newLiveRevId}`);
  });
});
