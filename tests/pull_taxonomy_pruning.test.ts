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
import yaml from 'js-yaml';
import { CacheDatabase } from '../src/db/cache.js';
import { ApiError } from '../src/client/error.js';
import { pullArticle } from '../src/sync/pull/index.js';
import { pullBatch } from '../src/sync/orchestrator.js';
import { pushArticle } from '../src/sync/push/index.js';
import { inspectArticleDiff } from '../src/sync/diff.js';
import { calculateHash, commitArticleSnapshot } from '../src/sync/workspace/index.js';
import { computeTaxonomyHash } from '../src/sync/terms.js';
import { parseMarkdown, serializeMarkdown } from '../src/utils/frontmatter.js';

describe('Pull 0-GET Taxonomy Pruning & Remote Audit Parity (v0.1.31 T2-T7)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  const CAT_NEWS_ID = '01CAT000000000000000000001';
  const TAG_TS_ID = '01TAG000000000000000000001';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-tax-prune-test-'));
    cache = new CacheDatabase(path.join(tempDir, 'cache.db'));

    // Create categories/ and tags/ directories with local definitions
    fs.mkdirSync(path.join(tempDir, 'categories'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'tags'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'posts', 'draft'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'posts', 'published'), { recursive: true });

    // Category: news
    fs.writeFileSync(
      path.join(tempDir, 'categories', `${CAT_NEWS_ID}-news.yaml`),
      yaml.dump({ id: CAT_NEWS_ID, slug: 'news', name: 'News' }),
      'utf8',
    );

    // Tag: typescript (deleted-tag is deliberately NOT defined, simulating remote deletion)
    fs.writeFileSync(
      path.join(tempDir, 'tags', `${TAG_TS_ID}-typescript.yaml`),
      yaml.dump({ id: TAG_TS_ID, slug: 'typescript', name: 'TypeScript' }),
      'utf8',
    );
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function setupArticleFixture(params: {
    id: string;
    slug: string;
    status: 'draft' | 'published';
    categories: string[];
    tags: string[];
    body?: string;
    localEdits?: string;
  }) {
    const {
      id,
      slug,
      status,
      categories,
      tags,
      body = 'Initial test body.\n',
      localEdits,
    } = params;
    const relPath = `posts/${status}/20260101_${id}-${slug}.md`;
    const fullPath = path.join(tempDir, relPath);

    const frontmatter = {
      id,
      slug,
      title: slug,
      collection: 'posts',
      status,
      locale: 'ja',
      bylines: [],
      taxonomies: {
        categories,
        tags,
      },
    };

    const canonicalContent = serializeMarkdown(frontmatter, body);
    const diskContent = localEdits ? canonicalContent + localEdits : canonicalContent;

    commitArticleSnapshot(cache, tempDir, {
      id,
      relPath,
      diskContent: canonicalContent,
      canonicalContent,
      frontmatter,
      bodyMarkdown: body,
      revForTransport: '1:rev_initial',
      revForComparison: '1:rev_initial',
      bumpBaselineHashOnly: false,
      flags: {
        remoteTaxonomyHash: computeTaxonomyHash(categories, tags),
        taxonomyApplyPending: 0,
        conflictPending: 0,
        bodyConflictPending: 0,
        taxonomyConflictPending: 0,
        conflictCopyPath: null,
        conflictCopyHash: null,
        conflictAt: null,
      },
    });

    if (localEdits) {
      fs.writeFileSync(fullPath, diskContent, 'utf8');
    }

    return { relPath, fullPath, frontmatter, canonicalContent };
  }

  it('T2: Fast-path 0-GET prune & heal removes deleted tags from frontmatter with 0 GET calls to post content', async () => {
    const articleId = '01M6TESTT2PRUNE00000000001';
    const { fullPath } = setupArticleFixture({
      id: articleId,
      slug: 't2-article',
      status: 'draft',
      categories: ['news'],
      tags: ['typescript', 'deleted-tag'],
    });

    const requestedUrls: string[] = [];
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      requestedUrls.push(urlStr);
      return new Response('{}', { status: 200 });
    });

    const rawItem = {
      id: articleId,
      slug: 't2-article',
      status: 'draft',
      title: 't2-article',
      _rev: '1:rev_initial',
    };

    const res = await pullArticle('posts', articleId, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'test-token',
      rawItem,
      fetchFn: mockFetch as unknown as typeof fetch,
      canPruneTaxonomies: true,
      mediaSync: false,
    });

    // 1. Result assertions
    expect(res.healed).toBe(true);
    expect(res.updated).toBe(true);
    expect(res.meaningChanged).toBe(true);
    expect(res.prunedTaxonomies).toEqual({
      tags: ['deleted-tag'],
    });

    // 2. 0-GET verification: NO single GET was issued to fetch post content
    const postGetCalls = requestedUrls.filter((u) => u.includes(`/posts/${articleId}`));
    expect(postGetCalls).toHaveLength(0);

    // 3. Disk content verification: deleted-tag removed, typescript kept
    const diskAfter = fs.readFileSync(fullPath, 'utf8');
    const parsedAfter = parseMarkdown(diskAfter);
    expect(parsedAfter.frontmatter.taxonomies?.tags).toEqual(['typescript']);
    expect(parsedAfter.frontmatter.taxonomies?.categories).toEqual(['news']);

    // 4. Cache state verification: localHash updated to match new disk file
    const syncState = cache.getSyncState(articleId);
    expect(syncState?.localHash).toBe(calculateHash(diskAfter));
  });

  it('T3: Full tag deletion heals to tags: [] and clean push sends POST /terms/tag { termIds: [] } without G4/G19', async () => {
    const articleId = '01M6TESTT3PRUNE00000000001';
    const { relPath } = setupArticleFixture({
      id: articleId,
      slug: 't3-article',
      status: 'published',
      categories: ['news'],
      tags: ['deleted-tag-1', 'deleted-tag-2'],
    });

    // Step 1: Pull with canPruneTaxonomies: true
    const pullRawItem = {
      id: articleId,
      slug: 't3-article',
      status: 'published',
      title: 't3-article',
      _rev: '1:rev_initial',
    };

    const pullRes = await pullArticle('posts', articleId, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'test-token',
      rawItem: pullRawItem,
      canPruneTaxonomies: true,
      mediaSync: false,
    });

    expect(pullRes.healed).toBe(true);
    expect(pullRes.prunedTaxonomies?.tags).toEqual(['deleted-tag-1', 'deleted-tag-2']);

    // Check disk content: tags is explicitly []
    const diskContent = fs.readFileSync(path.join(tempDir, relPath), 'utf8');
    const parsed = parseMarkdown(diskContent);
    expect(parsed.frontmatter.taxonomies?.tags).toEqual([]);

    // Step 2: Push article to remote
    const networkCalls: { url: string; method: string; body?: unknown }[] = [];
    const mockPushFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method || 'GET';
      let body: unknown = undefined;
      if (init?.body && typeof init.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      networkCalls.push({ url, method, body });

      // Pre-PUT Taxonomy Audit endpoint
      if (url.includes(`/posts/${articleId}/terms`)) {
        if (method === 'GET') {
          // Simulate remote CMS where tags were already deleted (0 assignments)
          if (url.endsWith('/terms/category') || url.includes('/terms/category')) {
            return new Response(JSON.stringify({ termIds: [CAT_NEWS_ID] }), { status: 200 });
          }
          if (url.endsWith('/terms/tag') || url.includes('/terms/tag')) {
            return new Response(JSON.stringify({ termIds: [] }), { status: 200 });
          }
          return new Response(
            JSON.stringify({
              categories: [CAT_NEWS_ID],
              tags: [],
            }),
            { status: 200 },
          );
        }
        if (method === 'POST') {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
      }

      // PUT post content
      if (method === 'PUT') {
        return new Response(
          JSON.stringify({
            post: { id: articleId, version: 2, updatedAt: Date.now() },
          }),
          { status: 200 },
        );
      }

      return new Response('{}', { status: 200 });
    });

    // Pushing must NOT throw DESTRUCTIVE_TAXONOMY_WIPE (G19) or INVALID_TAXONOMY_ERROR (G4)
    const pushResult = await pushArticle(relPath, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'test-token',
      fetchFn: mockPushFetch as unknown as typeof fetch,
    });

    expect(pushResult.id).toBe(articleId);

    // Verify POST /terms/tag was called with empty array { termIds: [] }
    const tagTermPost = networkCalls.find(
      (c) => c.method === 'POST' && c.url.includes(`/posts/${articleId}/terms/tag`),
    );
    expect(tagTermPost).toBeDefined();
    expect(tagTermPost?.body).toEqual({ termIds: [] });
  });

  it('T4: Unmodified protection: local edits are preserved and nonexistent tags are NOT pruned', async () => {
    const articleId = '01M6TESTT4PROTECT000000001';
    const { fullPath } = setupArticleFixture({
      id: articleId,
      slug: 't4-article',
      status: 'draft',
      categories: ['news'],
      tags: ['typescript', 'user-added-or-deleted-tag'],
      localEdits: '\n\nUser wrote unpushed local changes here!',
    });

    const rawItem = {
      id: articleId,
      slug: 't4-article',
      status: 'draft',
      title: 't4-article',
      _rev: '1:rev_initial',
    };

    const res = await pullArticle('posts', articleId, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'test-token',
      rawItem,
      canPruneTaxonomies: true,
      mediaSync: false,
    });

    // Local edits must be strictly preserved
    expect(res.localEditsPreserved).toBe(true);
    expect(res.healed).toBeFalsy();

    const diskAfter = fs.readFileSync(fullPath, 'utf8');
    expect(diskAfter).toContain('User wrote unpushed local changes here!');
    const parsed = parseMarkdown(diskAfter);
    expect(parsed.frontmatter.taxonomies?.tags).toContain('user-added-or-deleted-tag');
  });

  it('T5: Batch pull prunes multiple articles and aligns remote_taxonomy_hash in sync_state', async () => {
    const id1 = '01M6TESTT5BATCH00000000001';
    const id2 = '01M6TESTT5BATCH00000000002';

    setupArticleFixture({
      id: id1,
      slug: 'batch-1',
      status: 'draft',
      categories: ['news'],
      tags: ['typescript', 'deleted-tag'],
    });

    setupArticleFixture({
      id: id2,
      slug: 'batch-2',
      status: 'draft',
      categories: ['news'],
      tags: ['deleted-tag'],
    });

    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      // List remote articles
      if (url.includes('/_emdash/api/content/posts')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: id1,
                slug: 'batch-1',
                status: 'draft',
                title: 'batch-1',
                _rev: '1:rev_initial',
              },
              {
                id: id2,
                slug: 'batch-2',
                status: 'draft',
                title: 'batch-2',
                _rev: '1:rev_initial',
              },
            ],
            total: 2,
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const batchRes = await pullBatch({
      collection: 'posts',
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'test-token',
      status: 'draft',
      canPruneTaxonomies: true,
      mediaSync: false,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(batchRes.total).toBe(2);
    expect(batchRes.updated).toBe(2);

    const healed1 = batchRes.items.find((i) => i.id === id1);
    const healed2 = batchRes.items.find((i) => i.id === id2);

    expect(healed1?.healed).toBe(true);
    expect(healed1?.prunedTaxonomies?.tags).toEqual(['deleted-tag']);

    expect(healed2?.healed).toBe(true);
    expect(healed2?.prunedTaxonomies?.tags).toEqual(['deleted-tag']);

    // Check remoteTaxonomyHash in sync_state
    const syncState1 = cache.getSyncState(id1);
    expect(syncState1?.remoteTaxonomyHash).toBe(computeTaxonomyHash(['news'], ['typescript']));

    const syncState2 = cache.getSyncState(id2);
    expect(syncState2?.remoteTaxonomyHash).toBe(computeTaxonomyHash(['news'], []));
  });

  it('T6: Zero phantom diff in inspectArticleDiff immediately after pruning (Layer A rewrite verified)', () => {
    const articleId = '01M6TESTT6DIFF00000000001';
    setupArticleFixture({
      id: articleId,
      slug: 't6-article',
      status: 'draft',
      categories: ['news'],
      tags: ['typescript', 'deleted-tag'],
    });

    const rawItem = {
      id: articleId,
      slug: 't6-article',
      status: 'draft',
      title: 'Title for t6-article',
      _rev: '1:rev_initial',
    };

    // Run pullArticle
    return pullArticle('posts', articleId, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'test-token',
      rawItem,
      canPruneTaxonomies: true,
      mediaSync: false,
    }).then(() => {
      // Run inspectArticleDiff
      const diffRes = inspectArticleDiff({
        workspaceRoot: tempDir,
        cache,
        id: articleId,
      });

      expect(diffRes.ok).toBe(true);
      expect(diffRes.status).toBe('synced');
      expect(diffRes.diff?.hasChanges).toBe(false);
      expect(diffRes.diff?.additions).toBe(0);
      expect(diffRes.diff?.deletions).toBe(0);
    });
  });

  it('T7: Epistemic rule: canPruneTaxonomies: false skips pruning and protects frontmatter', async () => {
    const articleId = '01M6TESTT7EPISTEMIC0000001';
    const { fullPath } = setupArticleFixture({
      id: articleId,
      slug: 't7-article',
      status: 'draft',
      categories: ['news'],
      tags: ['typescript', 'deleted-tag'],
    });

    const rawItem = {
      id: articleId,
      slug: 't7-article',
      status: 'draft',
      title: 't7-article',
      _rev: '1:rev_initial',
    };

    // When canPruneTaxonomies is false (e.g. --posts-only or taxonomy sync failed)
    const res = await pullArticle('posts', articleId, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'test-token',
      rawItem,
      canPruneTaxonomies: false,
      mediaSync: false,
    });

    expect(res.skipped).toBe(true);
    expect(res.healed).toBeFalsy();

    // Disk content must remain untouched
    const diskAfter = fs.readFileSync(fullPath, 'utf8');
    const parsed = parseMarkdown(diskAfter);
    expect(parsed.frontmatter.taxonomies?.tags).toContain('deleted-tag');
  });

  it('T8: Negative test: remoteCount > 0 with local empty array enforces Guard G19 (DESTRUCTIVE_TAXONOMY_WIPE)', async () => {
    const articleId = '01M6TESTT8G19WIPE000000001';
    const { relPath, fullPath } = setupArticleFixture({
      id: articleId,
      slug: 't8-article',
      status: 'published',
      categories: ['news'],
      tags: ['typescript'],
    });

    // User locally edited frontmatter to wipe all tags: tags: []
    const parsed = parseMarkdown(fs.readFileSync(fullPath, 'utf8'));
    parsed.frontmatter.taxonomies = { categories: ['news'], tags: [] };
    fs.writeFileSync(fullPath, serializeMarkdown(parsed.frontmatter, parsed.body), 'utf8');

    const mockPushFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method || 'GET';

      if (url.includes(`/posts/${articleId}/terms`)) {
        if (method === 'GET') {
          // Remote CMS still has 1 tag assigned (remoteCount === 1)
          if (url.endsWith('/terms/category') || url.includes('/terms/category')) {
            return new Response(JSON.stringify({ termIds: [CAT_NEWS_ID] }), { status: 200 });
          }
          if (url.endsWith('/terms/tag') || url.includes('/terms/tag')) {
            return new Response(JSON.stringify({ termIds: [TAG_TS_ID] }), { status: 200 });
          }
          return new Response(
            JSON.stringify({
              categories: [CAT_NEWS_ID],
              tags: [TAG_TS_ID],
            }),
            { status: 200 },
          );
        }
      }

      if (method === 'PUT') {
        return new Response(
          JSON.stringify({
            post: { id: articleId, version: 2, updatedAt: Date.now() },
          }),
          { status: 200 },
        );
      }

      return new Response('{}', { status: 200 });
    });

    let caughtError: unknown = null;
    try {
      await pushArticle(relPath, {
        workspaceRoot: tempDir,
        cache,
        origin: 'https://example.com',
        token: 'test-token',
        fetchFn: mockPushFetch as unknown as typeof fetch,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ApiError);
    const apiErr = caughtError as ApiError;
    expect(apiErr.code).toBe('DESTRUCTIVE_TAXONOMY_WIPE');
  });

  it('T9: Negative test: remoteTaxAudit === null (--no-taxonomy-audit) with local empty array enforces Guard G19', async () => {
    const articleId = '01M6TESTT9NOAUDIT000000001';
    const { relPath, fullPath } = setupArticleFixture({
      id: articleId,
      slug: 't9-article',
      status: 'published',
      categories: ['news'],
      tags: ['typescript'],
    });

    // User locally edited frontmatter to wipe all tags: tags: []
    const parsed = parseMarkdown(fs.readFileSync(fullPath, 'utf8'));
    parsed.frontmatter.taxonomies = { categories: ['news'], tags: [] };
    fs.writeFileSync(fullPath, serializeMarkdown(parsed.frontmatter, parsed.body), 'utf8');

    const mockPushFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method || 'GET';

      if (method === 'PUT') {
        return new Response(
          JSON.stringify({
            post: { id: articleId, version: 2, updatedAt: Date.now() },
          }),
          { status: 200 },
        );
      }

      return new Response('{}', { status: 200 });
    });

    let caughtError: unknown = null;
    try {
      await pushArticle(relPath, {
        workspaceRoot: tempDir,
        cache,
        origin: 'https://example.com',
        token: 'test-token',
        noTaxonomyAudit: true, // Disables pre-PUT audit so remoteTaxAudit is null
        fetchFn: mockPushFetch as unknown as typeof fetch,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ApiError);
    const apiErr = caughtError as ApiError;
    expect(apiErr.code).toBe('DESTRUCTIVE_TAXONOMY_WIPE');
  });
});
