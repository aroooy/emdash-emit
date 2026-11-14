import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheDatabase } from '../src/db/cache.js';
import { pushArticle } from '../src/sync/push.js';
import { createBaseSnapshot } from '../src/db/baseline.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';
import { calculateHash } from '../src/sync/workspace/index.js';

describe('Push Semantics for Published Post with Draft Revision (v0.1.24)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-push-pub-draft-test-'));
    cache = new CacheDatabase(path.join(tempDir, 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('does NOT call status transition /publish endpoint when allowPublish is false (stages draft on remote)', async () => {
    const articleId = '01M77VFT15HSH2M1XW8MJPTCPQ';
    const relPath = `posts/published/20261113_${articleId}-kingfisher-diary.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const rawServerToken = 'MTk6MjAyNi0xMS0xNFQwNzoxMDowMC4wMDBa';
    const compositeRev = '19@draft:01M7CD9YGWNPAEP1Z7NC8600ZD';

    const fm: Frontmatter = {
      id: articleId,
      slug: 'kingfisher-diary',
      title: 'カワセミの静寂な佇まいに出会った日',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-13T10:00:00.000Z',
      locale: 'ja',
      taxonomies: {},
      bylines: ['aroooy'],
    };

    const initialBody = '10-block draft content edited locally.\n';
    const initialContent = serializeMarkdown(fm, initialBody);
    fs.writeFileSync(fullPath, initialContent, 'utf8');
    const hash = calculateHash(initialContent);

    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: hash,
      remoteRev: compositeRev,
      status: 'published',
      slug: 'kingfisher-diary',
      lastSyncedAt: 1000,
    });

    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: articleId,
        rev: rawServerToken,
        frontmatter: fm,
        bodyMarkdown: initialBody,
        hash,
      }),
    );

    let putCalled = false;
    let publishTransitionCalled = false;

    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      // Mock taxonomy terms
      if (url.includes('/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: [] } }),
        });
      }

      // Mock entry lock
      if (url.includes('/lock')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { lockToken: 'mock-lock-token' } }),
        });
      }

      // Mock article single GET (pre-audit)
      if (url.endsWith(`/posts/${articleId}`) && (!init || init.method === 'GET')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              item: {
                id: articleId,
                version: 19,
                draftRevisionId: '01M7CD9YGWNPAEP1Z7NC8600ZD',
                status: 'published',
                slug: 'kingfisher-diary',
                publishedAt: '2026-11-13T10:00:00.000Z',
                data: { title: 'カワセミの静寂な佇まいに出会った日', content: [] },
              },
            },
          }),
        });
      }

      // Mock PUT
      if (url.endsWith(`/posts/${articleId}`) && init?.method === 'PUT') {
        putCalled = true;
        const bodyObj = JSON.parse(init.body as string);
        // Verify payload does NOT have status property
        expect(bodyObj.status).toBeUndefined();
        // Verify publishedAt is present
        expect(bodyObj.publishedAt).toBe('2026-11-13T10:00:00.000Z');
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: articleId,
            version: 20,
            draftRevisionId: '01M7NEWDRAFT00000000000000',
            liveRevisionId: '01M7CCGC748FQWMC3FDBP4WDY7',
            status: 'published',
            _rev: 'MjA6MjAyNi0xMS0xNFQwODowMDowMC4wMDBa',
          }),
        });
      }

      // Mock status transition
      if (url.includes('/publish') || url.includes('/unpublish')) {
        publishTransitionCalled = true;
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true }),
        });
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    // Push with allowPublish: false (default push)
    const result = await pushArticle(relPath, {
      origin: 'https://example.com',
      token: 'fake-token',
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch,
      allowPublish: false,
    });

    expect(result.success).toBe(true);
    expect(putCalled).toBe(true);
    // Crucial invariant: Without allowPublish: true, /publish endpoint MUST NOT be called!
    expect(publishTransitionCalled).toBe(false);
    expect(result.warnings).toContain(
      'Changes were staged as a draft on EmDash (live version unchanged). Use --allow-publish to publish live.',
    );
  });

  it('calls status transition /publish endpoint when allowPublish is true', async () => {
    const articleId = '01M77VFT15HSH2M1XW8MJPTCPQ';
    const relPath = `posts/published/20261113_${articleId}-kingfisher-diary.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const rawServerToken = 'MTk6MjAyNi0xMS0xNFQwNzoxMDowMC4wMDBa';
    const compositeRev = '19@draft:01M7CD9YGWNPAEP1Z7NC8600ZD';

    const fm: Frontmatter = {
      id: articleId,
      slug: 'kingfisher-diary',
      title: 'カワセミの静寂な佇まいに出会った日',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-13T10:00:00.000Z',
      locale: 'ja',
      taxonomies: {},
      bylines: ['aroooy'],
    };

    const initialBody = '10-block draft content edited locally to publish live.\n';
    const initialContent = serializeMarkdown(fm, initialBody);
    fs.writeFileSync(fullPath, initialContent, 'utf8');
    const hash = calculateHash(initialContent);

    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: hash,
      remoteRev: compositeRev,
      status: 'published',
      slug: 'kingfisher-diary',
      lastSyncedAt: 1000,
    });

    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: articleId,
        rev: rawServerToken,
        frontmatter: fm,
        bodyMarkdown: initialBody,
        hash,
      }),
    );

    let putCalled = false;
    let publishTransitionCalled = false;

    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      // Mock taxonomy terms
      if (url.includes('/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: [] } }),
        });
      }

      // Mock entry lock
      if (url.includes('/lock')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { lockToken: 'mock-lock-token' } }),
        });
      }

      // Mock article single GET (pre-audit)
      if (url.endsWith(`/posts/${articleId}`) && (!init || init.method === 'GET')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              item: {
                id: articleId,
                version: 19,
                draftRevisionId: '01M7CD9YGWNPAEP1Z7NC8600ZD',
                status: 'published',
                slug: 'kingfisher-diary',
                publishedAt: '2026-11-13T10:00:00.000Z',
                data: { title: 'カワセミの静寂な佇まいに出会った日', content: [] },
              },
            },
          }),
        });
      }

      // Mock PUT
      if (url.endsWith(`/posts/${articleId}`) && init?.method === 'PUT') {
        putCalled = true;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: articleId,
            version: 20,
            draftRevisionId: '01M7NEWDRAFT00000000000000',
            liveRevisionId: '01M7CCGC748FQWMC3FDBP4WDY7',
            status: 'published',
            _rev: 'MjA6MjAyNi0xMS0xNFQwODowMDowMC4wMDBa',
          }),
        });
      }

      // Mock status transition
      if (url.includes('/publish')) {
        publishTransitionCalled = true;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            _rev: 'MjE6MjAyNi0xMS0xNFQwODowNTowMC4wMDBa',
          }),
        });
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    // Push with allowPublish: true
    const result = await pushArticle(relPath, {
      origin: 'https://example.com',
      token: 'fake-token',
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch,
      allowPublish: true,
    });

    expect(result.success).toBe(true);
    expect(putCalled).toBe(true);
    // With allowPublish: true, /publish endpoint MUST be called!
    expect(publishTransitionCalled).toBe(true);
    expect(result.warnings).toContain(
      'Published article with uncommitted remote draft was published live to the web (--allow-publish).',
    );
  });

  it('does NOT emit draft staging warning when pushing a clean published article without remote draft (@live:)', async () => {
    const articleId = '01M77VFT15HSH2M1XW8MJPTCP1';
    const relPath = `posts/published/20261113_${articleId}-clean-pub.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const rawServerToken = 'MTk6MjAyNi0xMS0xNFQwNzoxMDowMC4wMDBa';
    const compositeRev = '19@live:01M7CCGC748FQWMC3FDBP4WDY7';

    const fm: Frontmatter = {
      id: articleId,
      slug: 'clean-pub',
      title: 'Clean Published Article',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-13T10:00:00.000Z',
      locale: 'ja',
      taxonomies: {},
      bylines: ['aroooy'],
    };

    const body = 'Clean published body edited locally.\n';
    const markdown = serializeMarkdown(fm, body);
    fs.writeFileSync(fullPath, markdown, 'utf8');
    const hash = calculateHash(markdown);

    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: hash,
      remoteRev: compositeRev,
      status: 'published',
      slug: 'clean-pub',
      lastSyncedAt: 1000,
    });

    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: articleId,
        rev: rawServerToken,
        frontmatter: fm,
        bodyMarkdown: body,
        hash,
      }),
    );

    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/lock')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
      }
      if (url.includes('/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: [] } }),
        });
      }
      if (url.endsWith(`/posts/${articleId}`) && (!init || init.method === 'GET')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              item: {
                id: articleId,
                version: 19,
                status: 'published',
                slug: 'clean-pub',
                data: { title: 'Clean Published Article', content: [] },
              },
            },
          }),
        });
      }
      if (url.endsWith(`/posts/${articleId}`) && init?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: articleId,
            version: 20,
            status: 'published',
            _rev: 'MjA6MjAyNi0xMS0xNFQwODowMDowMC4wMDBa',
          }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const result = await pushArticle(relPath, {
      origin: 'https://example.com',
      token: 'fake-token',
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch,
      allowPublish: false,
    });

    expect(result.success).toBe(true);
    // Crucial check: No draft staging warning should be emitted for clean published articles!
    expect(result.warnings).not.toContain(
      'Changes were staged as a draft on EmDash (live version unchanged). Use --allow-publish to publish live.',
    );
  });
});
