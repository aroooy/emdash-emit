import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheDatabase } from '../src/db/cache.js';
import { publishArticle } from '../src/sync/orchestrator.js';
import { calculateHash } from '../src/sync/workspace/index.js';
import { createBaseSnapshot } from '../src/db/baseline.js';
import { serializeMarkdown, parseMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';

describe('emit publish / publishArticle (v0.1.63)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-publish-test-'));
    cache = new CacheDatabase(path.join(tempDir, 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function seedArticle(opts: {
    id: string;
    slug: string;
    title: string;
    status: 'draft' | 'published';
    hasDraftRevision?: boolean;
    remoteRev: string;
    diskBody?: string;
    baselineBody?: string;
    taxonomyApplyPending?: number;
  }): string {
    const folder = opts.status === 'published' ? 'published' : 'draft';
    const titleSlug = opts.title.replace(/\s+/g, '-');
    const relPath = `posts/${folder}/20261126_${opts.id}-${titleSlug}.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const fm: Frontmatter = {
      id: opts.id,
      slug: opts.slug,
      title: opts.title,
      collection: 'posts',
      status: opts.status,
      publishedAt: opts.status === 'published' ? '2026-11-26T00:00:00.000Z' : null,
      locale: 'ja',
      taxonomies: { categories: [], tags: [] },
      bylines: [],
    };
    const baseBody = opts.baselineBody ?? 'Staged content ready to publish.\n';
    const diskBody = opts.diskBody ?? baseBody;
    const baseMd = serializeMarkdown(fm, baseBody, undefined, {
      hasDraftRevision: opts.hasDraftRevision,
    });
    const diskMd = serializeMarkdown(fm, diskBody, undefined, {
      hasDraftRevision: opts.hasDraftRevision,
    });
    fs.writeFileSync(fullPath, diskMd, 'utf8');

    const baseHash = calculateHash(baseMd);
    const baseSnap = createBaseSnapshot({
      id: opts.id,
      frontmatter: fm,
      bodyMarkdown: baseBody,
      rev: 'rev-1',
      hash: baseHash,
    });
    cache.saveBaseSnapshot(baseSnap);
    cache.saveSyncState({
      id: opts.id,
      status: opts.status,
      localFilePath: relPath,
      localHash: baseHash,
      remoteRev: opts.remoteRev,
      slug: opts.slug,
      lastSyncedAt: 1000,
      taxonomyApplyPending: opts.taxonomyApplyPending ?? 0,
    });
    return relPath;
  }

  it('promotes published* staged draft to live without re-uploading content', async () => {
    const id = '01M7BZH06K515A5NQWZ36QK7P1';
    const draftRevId = '01M7DRAFT00000000000000001';
    const liveRevId = '01M7LIVE000000000000000002';
    const relPath = seedArticle({
      id,
      slug: 'staged-post',
      title: 'Staged Post',
      status: 'published',
      hasDraftRevision: true,
      remoteRev: `2@draft:${draftRevId}`,
    });

    let publishCalled = false;
    let sentPublishRev: unknown;
    const expectedTransportRev = 'MjoyMDI2LTExLTI2VDAwOjAwOjAwLjAwMFo=';
    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/lock')) {
        return Promise.resolve({ ok: true, json: async () => ({ heldByCaller: true }) });
      }
      if (url.endsWith(`/posts/${id}/publish`) && init?.method === 'POST') {
        publishCalled = true;
        sentPublishRev = JSON.parse(String(init.body))._rev;
        // Minimal /publish response (without liveRevisionId) to verify post-publish GET preserves Track 2
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: { _rev: 'MzoyMDI2LTExLTI2VDAwOjAxOjAwLjAwMFo=' },
          }),
        });
      }
      if (url.endsWith(`/posts/${id}`) && (!init?.method || init.method === 'GET')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: publishCalled
              ? {
                  item: {
                    id,
                    status: 'published',
                    version: 3,
                    draftRevisionId: null,
                    liveRevisionId: liveRevId,
                    publishedAt: '2026-11-26T00:00:00.000Z',
                  },
                  _rev: 'MzoyMDI2LTExLTI2VDAwOjAxOjAwLjAwMFo=',
                }
              : {
                  item: {
                    id,
                    status: 'published',
                    version: 2,
                    draftRevisionId: draftRevId,
                  },
                  _rev: expectedTransportRev,
                },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: {} }) });
    });

    const res = await publishArticle(relPath, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(publishCalled).toBe(true);
    expect(sentPublishRev).toBe(expectedTransportRev);
    expect(res.success).toBe(true);
    expect(res.alreadyPublished).toBe(false);
    expect(res.filePath).toBe(relPath);
    expect(cache.getSyncState(id)?.remoteRev).toBe(`3@live:${liveRevId}`);
    const disk = fs.readFileSync(path.join(tempDir, relPath), 'utf8');
    expect(disk).not.toContain('# draft revision');
  });

  it('moves draft article from posts/draft/ to posts/published/ on publish', async () => {
    const id = '01M7BZH06K515A5NQWZ36QK7P2';
    const draftRevId = '01M7DRAFT00000000000000002';
    const liveRevId = '01M7LIVE000000000000000003';
    const relPath = seedArticle({
      id,
      slug: 'draft-to-live',
      title: 'Draft To Live',
      status: 'draft',
      remoteRev: `1@draft:${draftRevId}`,
    });

    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/lock')) {
        return Promise.resolve({ ok: true, json: async () => ({ heldByCaller: true }) });
      }
      if (url.endsWith(`/posts/${id}/publish`) && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              id,
              status: 'published',
              version: 2,
              draftRevisionId: null,
              liveRevisionId: liveRevId,
              publishedAt: '2026-11-26T01:00:00.000Z',
              _rev: 'rev-2',
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            id,
            status: 'draft',
            version: 1,
            draftRevisionId: draftRevId,
            _rev: 'rev-1',
          },
        }),
      });
    });

    const res = await publishArticle(id, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.previousFilePath).toBe(relPath);
    expect(res.filePath).toBe(`posts/published/20261126_${id}-Draft-To-Live.md`);
    expect(fs.existsSync(path.join(tempDir, relPath))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, res.filePath))).toBe(true);
    const parsed = parseMarkdown(fs.readFileSync(path.join(tempDir, res.filePath), 'utf8'));
    expect(parsed.frontmatter.status).toBe('published');
  });

  it('blocks publish when unpushed local edits exist or remote changed (G22)', async () => {
    const id1 = '01M7BZH06K515A5NQWZ36QK7P3';
    const rel1 = seedArticle({
      id: id1,
      slug: 'local-dirty',
      title: 'Local Dirty',
      status: 'published',
      hasDraftRevision: true,
      remoteRev: '2@draft:01M7DRAFT00000000000000003',
      diskBody: 'Unpushed local edit!\n',
    });

    await expect(
      publishArticle(rel1, {
        workspaceRoot: tempDir,
        cache,
        origin: 'https://example.com',
        token: 'fake-token',
      }),
    ).rejects.toMatchObject({ code: 'UNPUSHED_CHANGES_PROTECTION' });

    const id2 = '01M7BZH06K515A5NQWZ36QK7P4';
    const rel2 = seedArticle({
      id: id2,
      slug: 'remote-diverged',
      title: 'Remote Diverged',
      status: 'published',
      hasDraftRevision: true,
      remoteRev: '2@draft:01M7OLD_DRAFT0000000000000',
    });

    const divergedFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          id: id2,
          status: 'published',
          version: 2,
          draftRevisionId: '01M7NEW_DRAFT0000000000000',
          _rev: 'rev-new',
        },
      }),
    });

    await expect(
      publishArticle(rel2, {
        workspaceRoot: tempDir,
        cache,
        origin: 'https://example.com',
        token: 'fake-token',
        fetchFn: divergedFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_CHANGED_BEFORE_PUBLISH' });
  });
});
