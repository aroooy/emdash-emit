import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheDatabase } from '../src/db/cache.js';
import { discardDraftArticle } from '../src/sync/orchestrator.js';
import { calculateHash } from '../src/sync/workspace/index.js';
import { createBaseSnapshot } from '../src/db/baseline.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';

describe('emit discard-draft / discardDraftArticle (v0.1.63)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-discard-test-'));
    cache = new CacheDatabase(path.join(tempDir, 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function seedPublishedWithDraft(opts: {
    id: string;
    slug: string;
    title: string;
    status?: 'draft' | 'published';
    diskBody?: string;
  }): string {
    const status = opts.status ?? 'published';
    const folder = status === 'published' ? 'published' : 'draft';
    const relPath = `posts/${folder}/20261126_${opts.id}-${opts.slug}.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const fm: Frontmatter = {
      id: opts.id,
      slug: opts.slug,
      title: opts.title,
      collection: 'posts',
      status,
      publishedAt: status === 'published' ? '2026-11-26T00:00:00.000Z' : null,
      locale: 'ja',
      taxonomies: { categories: [], tags: [] },
      bylines: [],
    };
    const baseBody = 'Staged draft body.\n';
    const diskBody = opts.diskBody ?? baseBody;
    const baseMd = serializeMarkdown(fm, baseBody, undefined, {
      hasDraftRevision: status === 'published',
    });
    const diskMd = serializeMarkdown(fm, diskBody, undefined, {
      hasDraftRevision: status === 'published',
    });
    fs.writeFileSync(fullPath, diskMd, 'utf8');

    const baseHash = calculateHash(baseMd);
    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: opts.id,
        frontmatter: fm,
        bodyMarkdown: baseBody,
        rev: 'rev-2',
        hash: baseHash,
      }),
    );
    cache.saveSyncState({
      id: opts.id,
      status,
      localFilePath: relPath,
      localHash: baseHash,
      remoteRev: '2@draft:01M7DRAFT00000000000000001',
      slug: opts.slug,
      lastSyncedAt: 1000,
    });
    return relPath;
  }

  it('discards staged remote draft and re-pulls live version', async () => {
    const id = '01M7BZH06K515A5NQWZ36QK7D1';
    const liveRevId = '01M7LIVE000000000000000001';
    const relPath = seedPublishedWithDraft({
      id,
      slug: 'discard-test',
      title: 'Discard Test',
    });

    let discarded = false;
    let sentDiscardRev: unknown;
    const expectedTransportRev = 'MjoyMDI2LTExLTI2VDAwOjAwOjAwLjAwMFo=';
    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/lock')) {
        return Promise.resolve({ ok: true, json: async () => ({ heldByCaller: true }) });
      }
      if (url.endsWith(`/posts/${id}/discard-draft`) && init?.method === 'POST') {
        discarded = true;
        sentDiscardRev = JSON.parse(String(init.body))._rev;
        return Promise.resolve({ ok: true, json: async () => ({ success: true, data: {} }) });
      }
      if (url.endsWith(`/posts/${id}`) && (!init?.method || init.method === 'GET')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: discarded
              ? {
                  item: {
                    id,
                    slug: 'discard-test',
                    status: 'published',
                    version: 1,
                    draftRevisionId: null,
                    liveRevisionId: liveRevId,
                    publishedAt: '2026-11-26T00:00:00.000Z',
                    data: {
                      title: 'Discard Test',
                      content: [
                        {
                          _type: 'block',
                          _key: 'b1',
                          children: [{ _type: 'span', text: 'Original live body.' }],
                        },
                      ],
                    },
                  },
                  _rev: 'MToyMDI2LTExLTI2VDAwOjAwOjAwLjAwMFo=',
                }
              : {
                  item: {
                    id,
                    slug: 'discard-test',
                    status: 'published',
                    version: 2,
                    draftRevisionId: '01M7DRAFT00000000000000001',
                  },
                  _rev: expectedTransportRev,
                },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { items: [] } }),
      });
    });

    const res = await discardDraftArticle(relPath, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(discarded).toBe(true);
    expect(sentDiscardRev).toBe(expectedTransportRev);
    expect(res.noDraftPending).toBe(false);
    expect(cache.getSyncState(id)?.remoteRev).toBe(`1@live:${liveRevId}`);
    const disk = fs.readFileSync(path.join(tempDir, res.filePath), 'utf8');
    expect(disk).toContain('Original live body.');
    expect(disk).not.toContain('# draft revision');
  });

  it('enforces Guard G21 on draft-only articles and protects unpushed edits unless force=true', async () => {
    const draftId = '01M7BZH06K515A5NQWZ36QK7D2';
    const draftRel = seedPublishedWithDraft({
      id: draftId,
      slug: 'draft-only',
      title: 'Draft Only',
      status: 'draft',
    });

    const draftFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { id: draftId, status: 'draft', version: 1, _rev: 'rev-1' },
      }),
    });

    await expect(
      discardDraftArticle(draftRel, {
        workspaceRoot: tempDir,
        cache,
        origin: 'https://example.com',
        token: 'fake-token',
        fetchFn: draftFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'DRAFT_ONLY_DISCARD_FORBIDDEN' });

    const dirtyId = '01M7BZH06K515A5NQWZ36QK7D3';
    const dirtyRel = seedPublishedWithDraft({
      id: dirtyId,
      slug: 'dirty-local',
      title: 'Dirty Local',
      diskBody: 'Unsaved local draft work!\n',
    });

    await expect(
      discardDraftArticle(dirtyRel, {
        workspaceRoot: tempDir,
        cache,
        origin: 'https://example.com',
        token: 'fake-token',
      }),
    ).rejects.toMatchObject({ code: 'UNPUSHED_CHANGES_PROTECTION' });
  });

  it('quarantines unpushed edits when force=true and reports recovery hint if re-pull fails', async () => {
    const id = '01M7BZH06K515A5NQWZ36QK7D4';
    const relPath = seedPublishedWithDraft({
      id,
      slug: 'force-and-recover',
      title: 'Force And Recover',
      diskBody: 'Unsaved local edits to rescue!\n',
    });

    let getCount = 0;
    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/lock')) {
        return Promise.resolve({ ok: true, json: async () => ({ heldByCaller: true }) });
      }
      if (url.endsWith(`/posts/${id}/discard-draft`) && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, data: {} }) });
      }
      if (url.endsWith(`/posts/${id}`) && (!init?.method || init.method === 'GET')) {
        getCount += 1;
        if (getCount === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              data: {
                id,
                status: 'published',
                version: 2,
                draftRevisionId: '01M7DRAFT00000000000000001',
                _rev: 'rev-2',
              },
            }),
          });
        }
        return Promise.resolve({ ok: false, status: 503, statusText: 'Service Unavailable' });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { items: [] } }),
      });
    });

    await expect(
      discardDraftArticle(relPath, {
        workspaceRoot: tempDir,
        cache,
        origin: 'https://example.com',
        token: 'fake-token',
        force: true,
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: 'DISCARD_DRAFT_FAILED',
      suggestion: expect.stringContaining(`emit pull ${id}`),
    });

    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    expect(fs.existsSync(conflictsDir)).toBe(true);
    expect(fs.readdirSync(conflictsDir).length).toBeGreaterThan(0);
  });
});
