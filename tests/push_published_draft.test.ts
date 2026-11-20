import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheDatabase } from '../src/db/cache.js';
import { pushArticle } from '../src/sync/push/index.js';
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
    // Invariant: Disk file retains draft revision comment because remote still has an uncommitted draft
    const diskAfter = fs.readFileSync(path.join(tempDir, result.filePath), 'utf8');
    expect(diskAfter).toContain('status: published # draft revision');
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
    // Invariant: Disk file automatically removes draft revision comment because remote published live
    const diskAfter = fs.readFileSync(path.join(tempDir, result.filePath), 'utf8');
    expect(diskAfter).toContain('status: published');
    expect(diskAfter).not.toContain('# draft revision');
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

  it('retains draft revision comment if remote publish response still returns a draftRevisionId (6(c) regression test)', async () => {
    const articleId = '01M77VFT15HSH2M1XW8MJPTCP2';
    const relPath = `posts/published/20261113_${articleId}-still-has-draft.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const rawServerToken = 'MTk6MjAyNi0xMS0xNFQwNzoxMDowMC4wMDBa';
    const compositeRev = '19@draft:01M7CD9YGWNPAEP1Z7NC8600ZD';

    const fm: Frontmatter = {
      id: articleId,
      slug: 'still-has-draft',
      title: 'Still Has Draft Post',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-13T10:00:00.000Z',
      locale: 'ja',
      taxonomies: {},
      bylines: ['aroooy'],
    };

    const initialBody = 'Body text.\n';
    const initialContent = serializeMarkdown(fm, initialBody, undefined, {
      hasDraftRevision: true,
    });
    fs.writeFileSync(fullPath, initialContent, 'utf8');
    const hash = calculateHash(initialContent);

    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: hash,
      remoteRev: compositeRev,
      status: 'published',
      slug: 'still-has-draft',
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

    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: [] } }),
        });
      }
      if (url.includes('/lock')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { lockToken: 'mock-lock-token' } }),
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
                _rev: rawServerToken,
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
      if (url.includes('/publish')) {
        // Server response where draftRevisionId is still present!
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            version: 21,
            draftRevisionId: '01M7STILLDRAFT00000000000',
            liveRevisionId: '01M7LIVE00000000000000000',
            _rev: 'MjE6MjAyNi0xMS0xNFQwOTowMDowMC4wMDBa',
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
      allowPublish: true,
    });

    expect(result.success).toBe(true);
    // Invariant 6(c): Because remote returned a draftRevisionId, disk MUST keep the draft revision comment!
    const diskAfter = fs.readFileSync(path.join(tempDir, result.filePath), 'utf8');
    expect(diskAfter).toContain('status: published # draft revision');

    const syncState = cache.getSyncState(articleId);
    expect(syncState?.remoteRev).toBe('21@draft:01M7STILLDRAFT00000000000');
  });

  it('emits draft staging warning when pushing a clean published article (@live:) if remote returns draftRevisionId (T1-1 / v0.1.41 P1)', async () => {
    const articleId = '01M77VFT15HSH2M1XW8MJPTCP3';
    const relPath = `posts/published/20261113_${articleId}-live-to-draft.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const rawServerToken = 'MTk6MjAyNi0xMS0xNFQwNzoxMDowMC4wMDBa';
    const liveComparisonRev = '19@live:01M7LIVE00000000000000000';

    const fm: Frontmatter = {
      id: articleId,
      slug: 'live-to-draft',
      title: 'Live Post Edited to Draft',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-13T10:00:00.000Z',
      locale: 'ja',
      taxonomies: {},
      bylines: ['aroooy'],
    };

    const initialBody = 'Live content before edit';
    const localEditedBody = 'Local content edited and pushed as draft';

    const initialMd = serializeMarkdown(fm, initialBody);
    const editedMd = serializeMarkdown(fm, localEditedBody);
    fs.writeFileSync(fullPath, editedMd, 'utf8');

    const hash = calculateHash(initialMd);
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: hash,
      remoteRev: liveComparisonRev,
      status: 'published',
      slug: 'live-to-draft',
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

    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: [] } }),
        });
      }
      if (url.includes('/lock')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { lockToken: 'mock-lock-token' } }),
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
                _rev: rawServerToken,
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
            draftRevisionId: '01M7NEWDRAFT0000000000000',
            liveRevisionId: '01M7LIVE00000000000000000',
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
    // T1-1: Warning emitted because comparison rev contains @draft:
    expect(result.warnings).toContain(
      'Changes were staged as a draft on EmDash (live version unchanged). Use --allow-publish to publish live.',
    );
    // Did NOT have a previous draft, so no overwrite warning
    expect(result.warnings).not.toContain(
      'Existing uncommitted remote draft was overwritten by this push (previous draft revision replaced).',
    );
    // Exactly 1 warning
    expect(result.warnings.filter((w) => w.includes('staged as a draft'))).toHaveLength(1);

    const diskAfter = fs.readFileSync(path.join(tempDir, result.filePath), 'utf8');
    expect(diskAfter).toContain('status: published # draft revision');
  });

  it('does NOT emit draft staging warning when push aborts due to 409 conflict markers (T1-8 / v0.1.41 P1)', async () => {
    const articleId = '01M77VFT15HSH2M1XW8MJPTCP8';
    const relPath = `posts/published/20261113_${articleId}-conflict-abort.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const rawServerToken = 'MTk6MjAyNi0xMS0xNFQwNzoxMDowMC4wMDBa';
    const liveComparisonRev = '19@live:01M7LIVE00000000000000000';

    const fm: Frontmatter = {
      id: articleId,
      slug: 'conflict-abort',
      title: 'Conflict Abort Article',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-13T10:00:00.000Z',
      locale: 'ja',
      taxonomies: {},
      bylines: ['aroooy'],
    };

    const baseBody = 'Base line 1\nBase line 2';
    const localBody = 'Local conflicting line\nBase line 2';
    const remoteBody = 'Remote conflicting line\nBase line 2';

    const baseMd = serializeMarkdown(fm, baseBody);
    const localMd = serializeMarkdown(fm, localBody);
    fs.writeFileSync(fullPath, localMd, 'utf8');

    const hash = calculateHash(baseMd);
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: hash,
      remoteRev: liveComparisonRev,
      status: 'published',
      slug: 'conflict-abort',
      lastSyncedAt: 1000,
    });

    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: articleId,
        rev: rawServerToken,
        frontmatter: fm,
        bodyMarkdown: baseBody,
        hash,
      }),
    );

    let putCallCount = 0;
    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: [] } }),
        });
      }
      if (url.includes('/lock')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { lockToken: 'mock-lock-token' } }),
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
                version: 20,
                draftRevisionId: '01M7REMOTEDRAFT0000000000',
                status: 'published',
                _rev: 'MjA6MjAyNi0xMS0xNFQwODowMDowMC4wMDBa',
                data: {
                  title: 'Conflict Abort Article',
                  content: [{ _type: 'block', children: [{ _type: 'span', text: remoteBody }] }],
                },
              },
            },
          }),
        });
      }
      if (url.endsWith(`/posts/${articleId}`) && init?.method === 'PUT') {
        putCallCount++;
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ error: 'Conflict' }),
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

    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
    // PUT was called only once (not retried)
    expect(putCallCount).toBe(1);
    // T1-8 invariant: Absolutely NO "staged as a draft" warning when push fails due to conflicts!
    expect(result.warnings).not.toContain(
      'Changes were staged as a draft on EmDash (live version unchanged). Use --allow-publish to publish live.',
    );
  });

  it('emits draft staging warning after clean 3-way merge PUT retry (T1-9 / v0.1.41 P1)', async () => {
    const articleId = '01M77VFT15HSH2M1XW8MJPTCP9';
    const relPath = `posts/published/20261113_${articleId}-clean-merge.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const rawServerToken = 'MTk6MjAyNi0xMS0xNFQwNzoxMDowMC4wMDBa';
    const liveComparisonRev = '19@live:01M7LIVE00000000000000000';

    const fm: Frontmatter = {
      id: articleId,
      slug: 'clean-merge',
      title: 'Clean Merge Article',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-13T10:00:00.000Z',
      locale: 'ja',
      taxonomies: {},
      bylines: ['aroooy'],
    };

    const baseBody = 'Line 1\n\nLine 2\n\nLine 3\n';
    const localBody = 'Line 1 edited locally\n\nLine 2\n\nLine 3\n';
    const remoteBody = 'Line 1\n\nLine 2\n\nLine 3 edited remotely\n';

    const baseMd = serializeMarkdown(fm, baseBody);
    const localMd = serializeMarkdown(fm, localBody);
    fs.writeFileSync(fullPath, localMd, 'utf8');

    const hash = calculateHash(baseMd);
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: hash,
      remoteRev: liveComparisonRev,
      status: 'published',
      slug: 'clean-merge',
      lastSyncedAt: 1000,
    });

    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: articleId,
        rev: rawServerToken,
        frontmatter: fm,
        bodyMarkdown: baseBody,
        hash,
      }),
    );

    let putCallCount = 0;
    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: [] } }),
        });
      }
      if (url.includes('/lock')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { lockToken: 'mock-lock-token' } }),
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
                version: 20,
                status: 'published',
                _rev: 'MjA6MjAyNi0xMS0xNFQwODowMDowMC4wMDBa',
                data: {
                  title: 'Clean Merge Article',
                  body: remoteBody,
                },
              },
            },
          }),
        });
      }
      if (url.endsWith(`/posts/${articleId}`) && init?.method === 'PUT') {
        putCallCount++;
        if (putCallCount === 1) {
          // First PUT returns 409 conflict
          return Promise.resolve({
            ok: false,
            status: 409,
            json: async () => ({ error: 'Conflict' }),
          });
        }
        // Second PUT (retry after clean 3-way merge) succeeds and stages a draft
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: articleId,
            version: 21,
            status: 'published',
            draftRevisionId: '01M7CLEANDRAFT00000000000',
            liveRevisionId: '01M7LIVE00000000000000000',
            _rev: 'MjE6MjAyNi0xMS0xNFQwOTowMDowMC4wMDBa',
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
    expect(putCallCount).toBe(2);
    // T1-9 invariant: Staged as draft warning is emitted after successful retry
    expect(result.warnings).toContain(
      'Changes were staged as a draft on EmDash (live version unchanged). Use --allow-publish to publish live.',
    );
  });

  it('does NOT emit draft staging warning for draft post push (T1-4 / v0.1.41 P1)', async () => {
    const articleId = '01M77VFT15HSH2M1XW8MJPTCP4';
    const relPath = `posts/draft/20261113_${articleId}-draft-post.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const fm: Frontmatter = {
      id: articleId,
      slug: 'draft-post',
      title: 'Draft Post',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: {},
      bylines: ['aroooy'],
    };

    const body = 'Draft content';
    const md = serializeMarkdown(fm, body);
    fs.writeFileSync(fullPath, md, 'utf8');

    const hash = calculateHash(md);
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: hash,
      remoteRev: '10',
      status: 'draft',
      slug: 'draft-post',
      lastSyncedAt: 1000,
    });

    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: articleId,
        rev: '10',
        frontmatter: fm,
        bodyMarkdown: body,
        hash,
      }),
    );

    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: [] } }),
        });
      }
      if (url.includes('/lock')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { lockToken: 'mock-lock-token' } }),
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
                version: 10,
                status: 'draft',
                _rev: '10',
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
            version: 11,
            status: 'draft',
            _rev: '11',
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
    expect(result.warnings).not.toContain(
      'Changes were staged as a draft on EmDash (live version unchanged). Use --allow-publish to publish live.',
    );
  });

  it('does NOT emit draft staging warning on create with allowPublish (T1-5 / v0.1.41 P1)', async () => {
    const articleId = '01M77VFT15HSH2M1XW8MJPTCP5';
    const relPath = `posts/published/20261113_${articleId}-create-pub.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const fm: Frontmatter = {
      id: articleId,
      slug: 'create-pub',
      title: 'Created Published Post',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-13T10:00:00.000Z',
      locale: 'ja',
      taxonomies: {},
      bylines: ['aroooy'],
    };

    const body = 'Initial created content';
    const md = serializeMarkdown(fm, body);
    fs.writeFileSync(fullPath, md, 'utf8');

    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: [] } }),
        });
      }
      if (url.includes('/lock')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { lockToken: 'mock-lock-token' } }),
        });
      }
      if (url.endsWith('/posts') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: articleId,
            version: 1,
            status: 'draft',
            _rev: '1',
          }),
        });
      }
      if (url.includes('/publish')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            version: 2,
            liveRevisionId: '01M7LIVE00000000000000001',
            draftRevisionId: null,
            _rev: '2',
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
      allowPublish: true,
    });

    expect(result.success).toBe(true);
    expect(result.warnings).not.toContain(
      'Changes were staged as a draft on EmDash (live version unchanged). Use --allow-publish to publish live.',
    );
  });
});
