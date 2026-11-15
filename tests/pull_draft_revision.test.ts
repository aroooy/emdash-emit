import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheDatabase } from '../src/db/cache.js';
import { pullArticle } from '../src/sync/pull.js';
import { calculateHash } from '../src/sync/workspace/index.js';
import { createBaseSnapshot } from '../src/db/baseline.js';
import { serializeMarkdown, parseMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';
import { assertNotQuarantinedCopy } from '../src/sync/push/guards.js';

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

  it('discards stale rawItem from list API on draft update and fetches full content via single GET', async () => {
    const articleId = '01M7BZH06K515A5NQWZ36QK7NQ';
    const relPath = `posts/draft/20261114_${articleId}-draft-batch-test.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const oldDraftRevId = '01M7OLDREV0000000000000000';
    const newDraftRevId = '01M7NEWREV0000000000000000';

    const fm: Frontmatter = {
      id: articleId,
      slug: 'draft-batch-test',
      title: 'Draft Batch Test',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: { categories: ['test'], tags: [] },
      bylines: ['aroooy'],
    };

    const initialBody = 'Initial 3-block body.\n';
    const initialMarkdown = serializeMarkdown(fm, initialBody);
    fs.writeFileSync(fullPath, initialMarkdown, 'utf8');
    const initialHash = calculateHash(initialMarkdown);

    // Initial state: tracked with OLD composite rev
    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: articleId,
        rev: '3',
        bodyMarkdown: initialBody,
        frontmatter: fm,
        hash: initialHash,
      }),
    );

    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: initialHash,
      remoteRev: `3@draft:${oldDraftRevId}`,
      status: 'draft',
      slug: 'draft-batch-test',
      lastSyncedAt: 1000,
    });

    // Stale rawItem from List API: has new draftRevisionId, but OLD 3-block content!
    const staleListRawItem = {
      id: articleId,
      version: 3,
      draftRevisionId: newDraftRevId,
      liveRevisionId: null,
      status: 'draft',
      slug: 'draft-batch-test',
      updatedAt: '2026-11-14T02:52:29.779Z',
      data: {
        title: 'Draft Batch Test',
        content: [
          {
            _type: 'block',
            _key: 'b1',
            children: [{ _type: 'span', text: 'Stale 3-block content from list API.' }],
          },
        ],
      },
    };

    let singleGetCallCount = 0;

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/category/terms') || url.includes('/tag/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: [] } }),
        });
      }

      if (url.endsWith(`/posts/${articleId}`)) {
        singleGetCallCount++;
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
                slug: 'draft-batch-test',
                updatedAt: '2026-11-14T02:52:29.779Z',
                data: {
                  title: 'Draft Batch Test',
                  content: [
                    {
                      _type: 'block',
                      _key: 'b1',
                      children: [
                        { _type: 'span', text: 'Full 7-block content with image from single GET.' },
                      ],
                    },
                    {
                      _type: 'block',
                      _key: 'b2',
                      children: [{ _type: 'span', text: '追加テキスト' }],
                    },
                  ],
                },
              },
              _rev: 'MzoyMDI2LTExLTE0VDAyOjUyOjI5Ljc3OVo=',
            },
          }),
        });
      }

      if (url.includes(`/posts/${articleId}/terms/`)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: { terms: [] },
          }),
        });
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    // Execute pullArticle passing the STALE list rawItem (simulating batch pull)
    const result = await pullArticle('posts', articleId, {
      origin: 'https://example.com',
      token: 'fake-token',
      workspaceRoot: tempDir,
      cache,
      rawItem: staleListRawItem,
      fetchFn: mockFetch,
    });

    expect(result.updated).toBe(true);
    // Single GET MUST have been called exactly once because draft list item was discarded
    expect(singleGetCallCount).toBe(1);

    // Verify disk content contains the full content from single GET, NOT the stale list content
    const updatedContent = fs.readFileSync(fullPath, 'utf8');
    expect(updatedContent).toContain('Full 7-block content with image from single GET.');
    expect(updatedContent).toContain('追加テキスト');
    expect(updatedContent).not.toContain('Stale 3-block content from list API.');
  });

  it('safely quarantines unpushed local edits and flags bodyConflictPending when remote draft advances', async () => {
    const articleId = '01M7BZH06K515A5NQWZ36QK7NQ';
    const relPath = `posts/draft/20261114_${articleId}-draft-conflict-test.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const oldDraftRevId = '01M7OLDREV0000000000000000';
    const newDraftRevId = '01M7NEWREV0000000000000000';

    const fm: Frontmatter = {
      id: articleId,
      slug: 'draft-conflict-test',
      title: 'Draft Conflict Test',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: { categories: ['test'], tags: [] },
      bylines: ['aroooy'],
    };

    const initialBody = 'Initial baseline content.\n';
    const initialMarkdown = serializeMarkdown(fm, initialBody);
    const initialHash = calculateHash(initialMarkdown);

    // Seed baseline with initial content
    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: articleId,
        rev: '3',
        bodyMarkdown: initialBody,
        frontmatter: fm,
        hash: initialHash,
      }),
    );

    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: initialHash,
      remoteRev: `3@draft:${oldDraftRevId}`,
      status: 'draft',
      slug: 'draft-conflict-test',
      lastSyncedAt: 1000,
    });

    // Write UNPUSHED local edits to disk
    const unpushedBody = 'My unpushed precious local edits that must not be lost!\n';
    const unpushedMarkdown = serializeMarkdown(fm, unpushedBody);
    fs.writeFileSync(fullPath, unpushedMarkdown, 'utf8');

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/category/terms') || url.includes('/tag/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: [] } }),
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
                slug: 'draft-conflict-test',
                updatedAt: '2026-11-14T02:52:29.779Z',
                data: {
                  title: 'Draft Conflict Test',
                  content: [
                    {
                      _type: 'block',
                      _key: 'b1',
                      children: [
                        { _type: 'span', text: 'Server content advancing draft revision.' },
                      ],
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

    // Execute pull
    const result = await pullArticle('posts', articleId, {
      origin: 'https://example.com',
      token: 'fake-token',
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch,
    });

    expect(result.updated).toBe(true);

    // Verify unpushed local edits were quarantined to posts/conflicts/
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    expect(fs.existsSync(conflictsDir)).toBe(true);
    const conflictFiles = fs.readdirSync(conflictsDir);
    expect(conflictFiles.length).toBeGreaterThan(0);
    const rescueContent = fs.readFileSync(path.join(conflictsDir, conflictFiles[0]), 'utf8');
    expect(rescueContent).toContain('My unpushed precious local edits that must not be lost!');

    // Verify bodyConflictPending was set to 1
    const syncState = cache.getSyncState(articleId);
    expect(syncState?.bodyConflictPending).toBe(1);
    expect(syncState?.conflictCopyPath).toBeTruthy();

    // Verify canonical disk file has the server content
    const canonicalContent = fs.readFileSync(fullPath, 'utf8');
    expect(canonicalContent).toContain('Server content advancing draft revision.');
  });

  it('fetches full draft content via single GET when a published article has unpublished draft changes (v0.1.24)', async () => {
    const articleId = '01M77VFT15HSH2M1XW8MJPTCPQ';
    const relPath = `posts/published/20261113_${articleId}-kingfisher-diary.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const liveRevId = '01M7CCGC748FQWMC3FDBP4WDY7';
    const newDraftRevId = '01M7CD9YGWNPAEP1Z7NC8600ZD';

    const publishedFm: Frontmatter = {
      id: articleId,
      slug: 'kingfisher-diary',
      title: 'カワセミの静寂な佇まいに出会った日',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-13T10:00:00.000Z',
      locale: 'ja',
      taxonomies: { categories: ['野鳥撮影'], tags: ['カワセミ'] },
      bylines: ['aroooy'],
    };

    const initialContent = serializeMarkdown(
      publishedFm,
      '7-block old live content published on web.',
    );
    fs.writeFileSync(fullPath, initialContent, 'utf8');
    const initialHash = calculateHash(initialContent);

    // Initial sync state in cache: synced with published live revision
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: initialHash,
      remoteRev: `18@live:${liveRevId}`,
      status: 'published',
      slug: 'kingfisher-diary',
      lastSyncedAt: 1000,
    });

    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: articleId,
        rev: 'MTg6MjAyNi0xMS0xM1QxMDowMDowMC4wMDBa',
        frontmatter: publishedFm,
        bodyMarkdown: '7-block old live content published on web.',
        hash: initialHash,
      }),
    );

    // Stale rawItem from List API: has new draftRevisionId, but data.content is ONLY old liveData (7 blocks)!
    const staleListRawItem = {
      id: articleId,
      version: 19,
      draftRevisionId: newDraftRevId,
      liveRevisionId: liveRevId,
      status: 'published',
      slug: 'kingfisher-diary',
      publishedAt: '2026-11-13T10:00:00.000Z',
      updatedAt: '2026-11-14T07:10:00.000Z',
      data: {
        title: 'カワセミの静寂な佇まいに出会った日',
        content: [
          {
            _type: 'block',
            _key: 'b1',
            children: [{ _type: 'span', text: '7-block old live content from list API.' }],
          },
        ],
      },
    };

    let singleGetCallCount = 0;

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/category/terms') || url.includes('/tag/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: [] } }),
        });
      }

      if (url.endsWith(`/posts/${articleId}`)) {
        singleGetCallCount++;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              item: {
                id: articleId,
                version: 19,
                draftRevisionId: newDraftRevId,
                liveRevisionId: liveRevId,
                status: 'published',
                slug: 'kingfisher-diary',
                publishedAt: '2026-11-13T10:00:00.000Z',
                updatedAt: '2026-11-14T07:10:00.000Z',
                data: {
                  title: 'カワセミの静寂な佇まいに出会った日',
                  content: [
                    {
                      _type: 'block',
                      _key: 'b1',
                      children: [
                        { _type: 'span', text: '10-block latest unpublished draft content!' },
                      ],
                    },
                  ],
                },
                liveData: {
                  title: 'カワセミの静寂な佇まいに出会った日',
                  content: [
                    {
                      _type: 'block',
                      _key: 'b_live',
                      children: [{ _type: 'span', text: '7-block old live content.' }],
                    },
                  ],
                },
              },
            },
          }),
        });
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    // Execute pullArticle with stale list rawItem
    const result = await pullArticle('posts', articleId, {
      origin: 'https://example.com',
      token: 'fake-token',
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch,
      rawItem: staleListRawItem,
    });

    expect(result.updated).toBe(true);
    // Single GET MUST have been called exactly once to discard the stale list item!
    expect(singleGetCallCount).toBe(1);

    // Verify local markdown file now contains the full 10-block draft content and draft revision comment
    const updatedDisk = fs.readFileSync(path.join(tempDir, result.filePath), 'utf8');
    expect(updatedDisk).toContain('10-block latest unpublished draft content!');
    expect(updatedDisk).not.toContain('7-block old live content from list API.');
    expect(updatedDisk).toContain('status: published # draft revision');

    // Verify publishedAt is preserved in frontmatter
    const updatedParsed = parseMarkdown(updatedDisk);
    expect(updatedParsed.frontmatter.publishedAt).toBe('2026-11-13T10:00:00.000Z');
    expect(updatedParsed.frontmatter.status).toBe('published');

    // Verify sync_state now tracks the new draft composite rev
    const syncState = cache.getSyncState(articleId);
    expect(syncState?.remoteRev).toBe(`19@draft:${newDraftRevId}`);
    expect(syncState?.status).toBe('published');

    // Idempotency check: A second batch pull with the same item MUST fast-path with 0 single GETs!
    const secondResult = await pullArticle('posts', articleId, {
      origin: 'https://example.com',
      token: 'fake-token',
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch,
      rawItem: staleListRawItem,
    });
    expect(secondResult.updated).toBe(false);
    expect(secondResult.skipped).toBe(true);
    expect(singleGetCallCount).toBe(1); // Call count remains 1 (no extra network call!)
  });

  it('safely quarantines unpushed local edits for published article with advancing draftRevisionId and refuses rescue copy push with G12', async () => {
    const articleId = '01M77VFT15HSH2M1XW8MJPTCPQ';
    const relPath = `posts/published/20261113_${articleId}-kingfisher-diary.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const liveRevId = '01M7CCGC748FQWMC3FDBP4WDY7';
    const newDraftRevId = '01M7CD9YGWNPAEP1Z7NC8600ZD';

    const publishedFm: Frontmatter = {
      id: articleId,
      slug: 'kingfisher-diary',
      title: 'カワセミの静寂な佇まいに出会った日',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-13T10:00:00.000Z',
      locale: 'ja',
      taxonomies: { categories: ['野鳥撮影'], tags: ['カワセミ'] },
      bylines: ['aroooy'],
    };

    // Hand-crafted local edits before pull
    const unpushedLocalContent = serializeMarkdown(
      publishedFm,
      'My unpushed precious local camera notes that must not be wiped!',
    );
    fs.writeFileSync(fullPath, unpushedLocalContent, 'utf8');

    // Initial cache: baseline had 7-block content, so unpushedLocalContent diverged
    const baseContent = serializeMarkdown(publishedFm, 'Baseline 7-block content.');
    const baseHash = calculateHash(baseContent);
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: baseHash,
      remoteRev: `18@live:${liveRevId}`,
      status: 'published',
      slug: 'kingfisher-diary',
      lastSyncedAt: 1000,
    });

    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: articleId,
        rev: 'MTg6MjAyNi0xMS0xM1QxMDowMDowMC4wMDBa',
        frontmatter: publishedFm,
        bodyMarkdown: 'Baseline 7-block content.',
        hash: baseHash,
      }),
    );

    const staleListRawItem = {
      id: articleId,
      version: 19,
      draftRevisionId: newDraftRevId,
      liveRevisionId: liveRevId,
      status: 'published',
      slug: 'kingfisher-diary',
      publishedAt: '2026-11-13T10:00:00.000Z',
      updatedAt: '2026-11-14T07:10:00.000Z',
      data: {
        title: 'カワセミの静寂な佇まいに出会った日',
        content: [
          {
            _type: 'block',
            _key: 'b1',
            children: [{ _type: 'span', text: '7-block old live content from list API.' }],
          },
        ],
      },
    };

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/category/terms') || url.includes('/tag/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: [] } }),
        });
      }

      if (url.endsWith(`/posts/${articleId}`)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              item: {
                id: articleId,
                version: 19,
                draftRevisionId: newDraftRevId,
                liveRevisionId: liveRevId,
                status: 'published',
                slug: 'kingfisher-diary',
                publishedAt: '2026-11-13T10:00:00.000Z',
                updatedAt: '2026-11-14T07:10:00.000Z',
                data: {
                  title: 'カワセミの静寂な佇まいに出会った日',
                  content: [
                    {
                      _type: 'block',
                      _key: 'b1',
                      children: [
                        { _type: 'span', text: 'Server content with advancing draft revision.' },
                      ],
                    },
                  ],
                },
              },
            },
          }),
        });
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    // Execute pull
    const result = await pullArticle('posts', articleId, {
      origin: 'https://example.com',
      token: 'fake-token',
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch,
      rawItem: staleListRawItem,
    });

    expect(result.updated).toBe(true);

    // Verify unpushed local edits were quarantined to posts/conflicts/
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    expect(fs.existsSync(conflictsDir)).toBe(true);
    const conflictFiles = fs.readdirSync(conflictsDir);
    expect(conflictFiles.length).toBeGreaterThan(0);
    const rescueContent = fs.readFileSync(path.join(conflictsDir, conflictFiles[0]), 'utf8');
    expect(rescueContent).toContain(
      'My unpushed precious local camera notes that must not be wiped!',
    );

    // Verify bodyConflictPending was set to 1 and conflictCopyPath is recorded
    const syncState = cache.getSyncState(articleId);
    expect(syncState?.bodyConflictPending).toBe(1);
    expect(syncState?.conflictCopyPath).toBeTruthy();

    // Verify that attempting to push the quarantined rescue copy directly is refused by Guard G12
    try {
      assertNotQuarantinedCopy(syncState!.conflictCopyPath!);
      expect.fail('Expected assertNotQuarantinedCopy to throw');
    } catch (err: unknown) {
      expect((err as any).errors[0].code).toBe('QUARANTINED_COPY_NOT_PUSHABLE');
    }

    // Verify canonical disk file was updated with the server draft content
    const canonicalContent = fs.readFileSync(path.join(tempDir, result.filePath), 'utf8');
    expect(canonicalContent).toContain('Server content with advancing draft revision.');
  });

  it('heals missing `# draft revision` in-place on untouched published file without extra network fetch', async () => {
    const articleId = '01M77VFT15HSH2M1XW8MJPTCPQ';
    const relPath = `posts/published/20261113_${articleId}-kingfisher.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const draftRevId = '01M77VFTDRAFTREV00000000000';
    const fm: Frontmatter = {
      id: articleId,
      slug: 'kingfisher',
      title: 'カワセミの佇まい',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-13T07:54:00.000Z',
      locale: 'ja',
      taxonomies: { categories: ['camera'], tags: [] },
      bylines: ['aroooy'],
    };

    const body = 'Published content with uncommitted remote draft.\n';
    // Disk content created prior to v0.1.25 WITHOUT the comment
    const diskContentWithoutComment = serializeMarkdown(fm, body, undefined, {
      hasDraftRevision: false,
    });
    fs.writeFileSync(fullPath, diskContentWithoutComment, 'utf8');
    const diskHash = calculateHash(diskContentWithoutComment);

    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: articleId,
        rev: '26',
        bodyMarkdown: body,
        frontmatter: fm,
        hash: diskHash,
      }),
    );

    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: diskHash,
      remoteRev: `26@draft:${draftRevId}`,
      status: 'published',
      slug: 'kingfisher',
      lastSyncedAt: 1000,
    });

    const mockFetch = vi.fn(); // Should not be called!

    const rawItem = {
      id: articleId,
      version: 26,
      draftRevisionId: draftRevId,
      liveRevisionId: '01M77VFTLIVEREV00000000000',
      status: 'published',
      slug: 'kingfisher',
      updatedAt: '2026-11-13T07:54:00.000Z',
      createdAt: '2026-11-13T07:54:00.000Z',
      publishedAt: '2026-11-13T07:54:00.000Z',
      data: { title: 'kingfisher' },
    };

    const result = await pullArticle('posts', articleId, {
      origin: 'https://example.com',
      token: 'fake-token',
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch,
      rawItem,
    });

    expect(result.updated).toBe(true);
    expect(result.healed).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();

    const healedContent = fs.readFileSync(fullPath, 'utf8');
    expect(healedContent).toContain('status: published # draft revision');

    const updatedSync = cache.getSyncState(articleId);
    expect(updatedSync?.localHash).toBe(calculateHash(healedContent));
  });
});
