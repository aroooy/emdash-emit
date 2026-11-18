import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheDatabase } from '../src/db/cache.js';
import { pushArticle } from '../src/sync/push/index.js';
import { createBaseSnapshot } from '../src/db/baseline.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';
import { calculateHash } from '../src/sync/workspace/index.js';
import { computeTaxonomyHash } from '../src/sync/terms.js';

describe('Push Transport Token Protection (v0.1.22 Guard against 409)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-push-transport-test-'));
    cache = new CacheDatabase(path.join(tempDir, 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('uses baseSnapshot.rev raw token in PUT payload instead of composite sync_state.remote_rev', async () => {
    const articleId = '01M7BZH06K515A5NQWZ36QK7NQ';
    const relPath = `posts/draft/20261114_${articleId}-transport-test.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const rawServerToken = 'MzoyMDI2LTExLTE0VDAyOjUyOjI5Ljc3OVo=';
    const compositeRev = '3@draft:01M7C7GRKQK8N2KTAJNXXMVPG3';

    const fm: Frontmatter = {
      id: articleId,
      slug: 'transport-test',
      title: 'Transport Test',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: { categories: ['test'], tags: [] },
      bylines: ['aroooy'],
    };

    const body = 'Body content to push.\n';
    const markdown = serializeMarkdown(fm, body);
    fs.writeFileSync(fullPath, markdown, 'utf8');
    const contentHash = calculateHash(markdown);

    // Seed state: sync_state has composite rev, base_snapshot has raw server token
    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: articleId,
        rev: rawServerToken,
        bodyMarkdown: body,
        frontmatter: fm,
        hash: contentHash,
      }),
    );

    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: contentHash,
      remoteRev: compositeRev,
      status: 'draft',
      slug: 'transport-test',
      lastSyncedAt: 1000,
      remoteTaxonomyHash: computeTaxonomyHash(['test'], []),
    });

    let sentPutPayload: any = null;

    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/lock')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
      }

      if (url.includes('/terms/category')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { terms: ['test'] },
          }),
        });
      }

      if (url.includes('/terms/tag')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { terms: [] },
          }),
        });
      }

      if (url.includes('/terms')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { terms: [] },
          }),
        });
      }

      if (url.includes(`/posts/${articleId}`) && init?.method === 'PUT') {
        sentPutPayload = JSON.parse(init.body as string);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              item: {
                id: articleId,
                version: 4,
                draftRevisionId: '01M7NEWDRAFTREV00000000000',
                status: 'draft',
                slug: 'transport-test',
                updatedAt: '2026-11-14T15:00:00.000Z',
              },
              _rev: 'NDoyMDI2LTExLTE0VDE1OjAwOjAwLjAwMFo=',
            },
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
      noTaxonomyAudit: true,
    });

    expect(result.success).toBe(true);
    expect(sentPutPayload).not.toBeNull();

    // Critical assertion: _rev sent to server must be the raw token, NEVER the composite key!
    expect(sentPutPayload._rev).toBe(rawServerToken);
    expect(sentPutPayload._rev).not.toContain('@draft:');

    // Post-push verification: base_snapshots got new raw token, sync_state got new composite key
    const newBase = cache.getBaseSnapshot(articleId);
    expect(newBase?.rev).toBe('NDoyMDI2LTExLTE0VDE1OjAwOjAwLjAwMFo=');

    const newSync = cache.getSyncState(articleId);
    expect(newSync?.remoteRev).toBe('4@draft:01M7NEWDRAFTREV00000000000');
  });

  it('preserves raw transport token during transitionContentStatus (publish transition)', async () => {
    const articleId = '01M7BZH06K515A5NQWZ36QK7NQ';
    const relPath = `posts/draft/20261114_${articleId}-publish-test.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const rawServerToken = 'MzoyMDI2LTExLTE0VDAyOjUyOjI5Ljc3OVo=';

    const fm: Frontmatter = {
      id: articleId,
      slug: 'publish-test',
      title: 'Publish Test',
      collection: 'posts',
      status: 'published', // Wants to publish
      publishedAt: '2026-11-14T15:00:00.000Z',
      locale: 'ja',
      taxonomies: { categories: ['test'], tags: [] },
      bylines: ['aroooy'],
    };

    const body = 'Publish body.\n';
    const markdown = serializeMarkdown(fm, body);
    fs.writeFileSync(fullPath, markdown, 'utf8');
    const contentHash = calculateHash(markdown);

    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: articleId,
        rev: rawServerToken,
        bodyMarkdown: body,
        frontmatter: { ...fm, status: 'draft' }, // previous status is draft
        hash: contentHash,
      }),
    );

    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: contentHash,
      remoteRev: '3@draft:01M7DRAFTREV000000000000',
      status: 'draft',
      slug: 'publish-test',
      lastSyncedAt: 1000,
    });

    let sentPublishRev: string | null = null;

    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/lock')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
      }

      if (url.includes('/terms')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { terms: [] },
          }),
        });
      }

      if (url.includes(`/posts/${articleId}`) && init?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              item: {
                id: articleId,
                version: 4,
                draftRevisionId: '01M7DRAFTREV000000000000',
                status: 'draft',
                slug: 'publish-test',
              },
              _rev: 'NDoyMDI2LTExLTE0VDE1OjAwOjAwLjAwMFo=',
            },
          }),
        });
      }

      // Publish transition endpoint: POST /posts/:id/publish
      if (url.includes(`/posts/${articleId}/publish`) && init?.method === 'POST') {
        const payload = JSON.parse(init.body as string);
        sentPublishRev = payload._rev;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              item: {
                id: articleId,
                version: 5,
                liveRevisionId: '01M7LIVEREV0000000000000',
                status: 'published',
                slug: 'publish-test',
              },
              _rev: 'NToyMDI2LTExLTE0VDE1OjAwOjAwLjAwMFo=',
            },
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
      noTaxonomyAudit: true,
    });

    expect(result.success).toBe(true);
    expect(sentPublishRev).toBe('NDoyMDI2LTExLTE0VDE1OjAwOjAwLjAwMFo=');
    expect(sentPublishRev).not.toContain('@draft:');

    // After publish, base_snapshots holds new raw token and sync_state holds @live composite rev
    const finalBase = cache.getBaseSnapshot(articleId);
    expect(finalBase?.rev).toBe('NToyMDI2LTExLTE0VDE1OjAwOjAwLjAwMFo=');

    const finalSync = cache.getSyncState(articleId);
    expect(finalSync?.remoteRev).toBe('5@live:01M7LIVEREV0000000000000');
  });
});
