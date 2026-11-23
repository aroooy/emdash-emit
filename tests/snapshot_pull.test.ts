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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheDatabase } from '../src/db/cache.js';
import { initWorkspace } from '../src/utils/config.js';
import { parseMarkdown } from '../src/utils/frontmatter.js';
import { captureWorkspaceSnapshot } from '../src/sync/snapshot/index.js';
import { pullArticle, pullFromSnapshot } from '../src/sync/pull/index.js';
import { pushArticle } from '../src/sync/push/index.js';
import { inspectArticleDiff } from '../src/sync/diff.js';
import { getWorkspaceStatus } from '../src/sync/status.js';
import { ApiError } from '../src/client/error.js';

describe('Snapshot Fallback Pull (v0.1.54)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-snapshot-pull-test-'));
    initWorkspace(tempDir, { origin: 'https://example.com' });
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('restores v7 article offline, supports diff/status, blocks push with PULL_REQUIRED_BEFORE_PUSH, and promotes sentinel on online pull', async () => {
    const postId = '01M7PUB0000000000000000001';
    const mediaId = '01M7MED0000000000000000009';
    const bylineId = '01M7BYL0000000000000000007';
    let pushedBodyRev: string | undefined;

    const onlineFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();

      if (url.includes('/_emdash/api/openapi.json')) {
        return new Response(JSON.stringify({ paths: {} }), { status: 200 });
      }
      if (url.includes('/_emdash/api/taxonomies/category/terms')) {
        return new Response(
          JSON.stringify({
            data: { terms: [{ id: '01M7CAT1', slug: 'tech', name: 'Tech' }] },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/_emdash/api/taxonomies/tag/terms')) {
        return new Response(
          JSON.stringify({
            data: { terms: [{ id: '01M7TAG1', slug: 'ai', name: 'AI' }] },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/_emdash/api/mcp') && method === 'POST') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    items: [{ id: bylineId, slug: 'hiroaki', displayName: 'Hiroaki' }],
                  }),
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/_emdash/api/content/posts?status=published')) {
        return new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  id: postId,
                  slug: 'offline-ready',
                  status: 'published',
                  _rev: '5',
                  version: 5,
                  liveRevisionId: '01M7LIVE5',
                  draftRevisionId: null,
                  locale: 'ja',
                  publishedAt: '2026-11-20T00:00:00.000Z',
                  createdAt: '2026-11-19T00:00:00.000Z',
                  seo: {
                    title: 'SEO Title',
                    description: 'SEO Desc',
                    noIndex: false,
                  },
                  bylines: [{ bylineId }],
                  data: {
                    title: 'Offline Ready Article',
                    featured_image: { id: mediaId },
                    content: [
                      {
                        _type: 'block',
                        style: 'normal',
                        children: [{ _type: 'span', text: 'Original body paragraph.' }],
                      },
                    ],
                  },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/_emdash/api/content/posts?status=draft')) {
        return new Response(JSON.stringify({ data: { items: [] } }), { status: 200 });
      }
      if (url.includes(`/posts/${postId}/terms/category`)) {
        return new Response(JSON.stringify({ data: { terms: [{ slug: 'tech' }] } }), {
          status: 200,
        });
      }
      if (url.includes(`/posts/${postId}/terms/tag`)) {
        return new Response(JSON.stringify({ data: { terms: [{ slug: 'ai' }] } }), {
          status: 200,
        });
      }
      if (url.includes('/_emdash/api/media')) {
        return new Response(JSON.stringify({ data: { items: [] } }), { status: 200 });
      }
      if (url.endsWith('/lock') && method === 'POST') {
        return new Response(
          JSON.stringify({ data: { acquired: true, lockToken: 'lock_1', expiresInSeconds: 420 } }),
          { status: 200 },
        );
      }
      if (url.endsWith('/lock') && method === 'DELETE') {
        return new Response(JSON.stringify({ data: { released: true } }), { status: 200 });
      }
      if (url.endsWith(`/_emdash/api/content/posts/${postId}`) && method === 'GET') {
        return new Response(
          JSON.stringify({
            data: {
              id: postId,
              slug: 'offline-ready',
              status: 'published',
              _rev: '5',
              version: 5,
              liveRevisionId: '01M7LIVE5',
              draftRevisionId: null,
              locale: 'ja',
              publishedAt: '2026-11-20T00:00:00.000Z',
              seo: { title: 'SEO Title', description: 'SEO Desc', noIndex: false },
              bylines: [{ bylineId }],
              data: {
                title: 'Offline Ready Article',
                featured_image: { id: mediaId },
                content: [
                  {
                    _type: 'block',
                    style: 'normal',
                    children: [{ _type: 'span', text: 'Original body paragraph.' }],
                  },
                ],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/_emdash/api/content/posts/${postId}`) && method === 'PUT') {
        const body = JSON.parse(String(init?.body || '{}')) as { _rev?: string };
        pushedBodyRev = body._rev;
        return new Response(
          JSON.stringify({
            data: {
              id: postId,
              slug: 'offline-ready',
              status: 'published',
              _rev: '6',
              version: 6,
              liveRevisionId: '01M7LIVE5',
              draftRevisionId: '01M7DREV6',
              data: { title: 'Offline Ready Article', content: [] },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes(`/terms/`) && method === 'PUT') {
        return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    // 1. Capture snapshot online
    const cap = await captureWorkspaceSnapshot({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      fetchFn: onlineFetch as unknown as typeof fetch,
    });
    expect(cap.articleCount).toBe(1);

    // 2. Restore offline (no network calls allowed)
    const restored = pullFromSnapshot({
      workspaceRoot: tempDir,
      cache,
      collection: 'posts',
      id: postId,
    });

    expect(restored.updated).toBe(true);
    expect(restored.degradedFields).toEqual([]);
    expect(restored.warnings.some((w) => w.includes('[SNAPSHOT_FALLBACK'))).toBe(true);
    expect(restored.warnings.some((w) => w.includes('[MEDIA_NOT_GUARANTEED]'))).toBe(true);

    const diskPath = path.join(tempDir, restored.filePath);
    const diskText = fs.readFileSync(diskPath, 'utf8');
    const parsed = parseMarkdown(diskText);
    expect(parsed.frontmatter.featuredImage).toBe(mediaId);
    expect(parsed.frontmatter.locale).toBe('ja');
    expect(parsed.frontmatter.seo?.title).toBe('SEO Title');
    expect(parsed.frontmatter.bylines).toEqual(['hiroaki']);
    expect(parsed.frontmatter.taxonomies?.categories).toEqual(['tech']);
    expect(parsed.frontmatter.taxonomies?.tags).toEqual(['ai']);
    expect(parsed.body).toContain('Original body paragraph.');

    // Sentinel stored in base_snapshots.rev, Track 2 comparisonRev stored in sync_state.remote_rev
    const baseSnap = cache.getBaseSnapshot(postId);
    expect(baseSnap?.rev).toBe('snapshot:5@live:01M7LIVE5');

    // 3. Offline status & diff work cleanly without network
    const statusBefore = getWorkspaceStatus(tempDir, cache, 'posts');
    expect(statusBefore.summary.synced).toBe(1);
    expect(statusBefore.summary.modified).toBe(0);

    fs.writeFileSync(
      diskPath,
      diskText.replace('Original body paragraph.', 'Edited offline paragraph.'),
      'utf8',
    );

    const diffAfter = inspectArticleDiff({
      workspaceRoot: tempDir,
      cache,
      filePath: restored.filePath,
    });
    expect(diffAfter.status).toBe('modified');
    expect(diffAfter.formattedOutput).toContain('-Original body paragraph.');
    expect(diffAfter.formattedOutput).toContain('+Edited offline paragraph.');

    // 4. Push immediately after snapshot pull is blocked by PULL_REQUIRED_BEFORE_PUSH (0 PUTs)
    const throwingFetch = vi.fn(async () => {
      throw new Error('Network should not be called');
    });
    await expect(
      pushArticle(restored.filePath, {
        workspaceRoot: tempDir,
        cache,
        origin: 'https://example.com',
        token: 'tok',
        fetchFn: throwingFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'PULL_REQUIRED_BEFORE_PUSH' });
    expect(throwingFetch).not.toHaveBeenCalled();

    // 5. Back online: normal pull preserves offline edit AND promotes base_snapshots.rev to live Track 1 _rev
    const onlinePull = await pullArticle('posts', postId, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      fetchFn: onlineFetch as unknown as typeof fetch,
      mediaSync: false,
      rawItem: {
        id: postId,
        slug: 'offline-ready',
        status: 'published',
        _rev: '5',
        version: 5,
        liveRevisionId: '01M7LIVE5',
        draftRevisionId: null,
        data: { title: 'Offline Ready Article' },
      },
    });
    expect(onlinePull.localEditsPreserved).toBe(true);
    expect(cache.getBaseSnapshot(postId)?.rev).toBe('5');
    expect(fs.readFileSync(diskPath, 'utf8')).toContain('Edited offline paragraph.');

    // 6. Push now succeeds using promoted live Track 1 _rev
    const pushRes = await pushArticle(restored.filePath, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      fetchFn: onlineFetch as unknown as typeof fetch,
    });
    expect(pushRes.id).toBe(postId);
    expect(pushedBodyRev).toBe('5');
  });

  it('distinguishes v6 legacy rows (locale === null) from v7 empty-field rows with zero false warnings', () => {
    const now = Date.now();
    const v7EmptyId = '01M7V7EMPTY000000000000001';
    const v6LegacyId = '01M7V6LEG00000000000000002';

    cache.saveSnapshotMeta({
      collection: 'posts',
      capturedAt: now,
      articleCount: 2,
      mediaCount: 0,
      taxonomyFetchedCount: 0,
      taxonomyReusedCount: 0,
      articleSingleGetCount: 0,
      durationMs: 10,
    });

    cache.upsertSnapshotArticlesBatch({
      collection: 'posts',
      walkComplete: true,
      records: [
        {
          id: v7EmptyId,
          collection: 'posts',
          slug: 'v7-empty',
          title: 'V7 Empty Fields',
          status: 'draft',
          comparisonRev: '1@draft:01M7D1',
          bodyMarkdown: 'Hello v7',
          bodySource: 'single-get',
          categoriesJson: '[]',
          tagsJson: '[]',
          taxonomyVerified: 1,
          featuredImage: null,
          seoJson: '{}',
          locale: 'ja',
          bylinesJson: '[]',
          capturedAt: now,
        },
        {
          id: v6LegacyId,
          collection: 'posts',
          slug: 'v6-legacy',
          title: 'V6 Legacy Row',
          status: 'draft',
          comparisonRev: '1@draft:01M7D2',
          bodyMarkdown: 'Hello v6',
          bodySource: 'single-get',
          categoriesJson: '[]',
          tagsJson: '[]',
          taxonomyVerified: 1,
          featuredImage: null,
          seoJson: '{}',
          locale: null,
          bylinesJson: '[]',
          capturedAt: now,
        },
      ],
    });

    const v7Res = pullFromSnapshot({ workspaceRoot: tempDir, cache, id: v7EmptyId });
    expect(v7Res.degradedFields).toEqual([]);
    expect(v7Res.warnings.some((w) => w.includes('Schema v6'))).toBe(false);

    const v6Res = pullFromSnapshot({ workspaceRoot: tempDir, cache, id: v6LegacyId });
    expect(v6Res.degradedFields).toEqual(['featuredImage', 'seo', 'locale', 'bylines']);
    expect(v6Res.warnings.some((w) => w.includes('Schema v6'))).toBe(true);
  });

  it('throws SNAPSHOT_NOT_AVAILABLE, SNAPSHOT_MISS (epistemic), warns when stale, and applies 30+30 window without pruning', () => {
    expect(() =>
      pullFromSnapshot({ workspaceRoot: tempDir, cache, collection: 'posts' }),
    ).toThrowError(ApiError);

    try {
      pullFromSnapshot({ workspaceRoot: tempDir, cache, collection: 'posts' });
    } catch (err) {
      expect((err as ApiError).code).toBe('SNAPSHOT_NOT_AVAILABLE');
    }

    const oldCapturedAt = Date.now() - 45 * 86_400_000;
    cache.saveSnapshotMeta({
      collection: 'posts',
      capturedAt: oldCapturedAt,
      articleCount: 70,
      mediaCount: 0,
      taxonomyFetchedCount: 0,
      taxonomyReusedCount: 0,
      articleSingleGetCount: 0,
      durationMs: 10,
    });

    const records = [];
    for (let i = 1; i <= 35; i++) {
      const day = String(i).padStart(2, '0');
      records.push({
        id: `01M7PUB00000000000000000${day}`,
        collection: 'posts',
        slug: `pub-${day}`,
        title: `Published ${day}`,
        status: 'published',
        publishedAt: `2026-10-${day}T00:00:00.000Z`,
        comparisonRev: `1@live:01L${day}`,
        bodyMarkdown: `Body ${day}`,
        bodySource: 'list-live' as const,
        categoriesJson: '[]',
        tagsJson: '[]',
        taxonomyVerified: 1,
        locale: 'ja',
        capturedAt: oldCapturedAt,
      });
      records.push({
        id: `01M7DFT00000000000000000${day}`,
        collection: 'posts',
        slug: `dft-${day}`,
        title: `Draft ${day}`,
        status: 'draft',
        createdAt: `2026-10-${day}T00:00:00.000Z`,
        comparisonRev: `1@draft:01D${day}`,
        bodyMarkdown: `Draft ${day}`,
        bodySource: 'single-get' as const,
        categoriesJson: '[]',
        tagsJson: '[]',
        taxonomyVerified: 1,
        locale: 'ja',
        capturedAt: oldCapturedAt,
      });
    }
    cache.upsertSnapshotArticlesBatch({
      collection: 'posts',
      walkComplete: true,
      records,
    });

    // Targeted miss throws epistemic SNAPSHOT_MISS
    try {
      pullFromSnapshot({
        workspaceRoot: tempDir,
        cache,
        id: '01M7MISSING000000000000000',
      });
      expect.unreachable('Expected SNAPSHOT_MISS');
    } catch (err) {
      expect((err as ApiError).code).toBe('SNAPSHOT_MISS');
      expect((err as ApiError).message).toContain('does not prove');
    }

    // Extra local file on disk must NOT be pruned by snapshot fallback
    const extraFile = path.join(
      tempDir,
      'posts/draft/20261101_01M7EXTRA00000000000000000-extra.md',
    );
    fs.mkdirSync(path.dirname(extraFile), { recursive: true });
    fs.writeFileSync(extraFile, '# extra', 'utf8');

    const batch = pullFromSnapshot({
      workspaceRoot: tempDir,
      cache,
      collection: 'posts',
      staleThresholdDays: 30,
    });

    expect(batch.isStale).toBe(true);
    expect(batch.warnings.some((w) => w.includes('[SNAPSHOT_STALE'))).toBe(true);
    // 30 published + 30 draft = 60
    expect(batch.total).toBe(60);
    expect(batch.items.filter((i) => i.status === 'published')).toHaveLength(30);
    expect(batch.items.filter((i) => i.status === 'draft')).toHaveLength(30);
    // Newest first (day 35 included, day 01 excluded)
    expect(batch.items.some((i) => i.slug === 'pub-35')).toBe(true);
    expect(batch.items.some((i) => i.slug === 'pub-01')).toBe(false);
    // Extra file untouched
    expect(fs.existsSync(extraFile)).toBe(true);
  });
});
