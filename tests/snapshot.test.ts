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
import {
  captureWorkspaceSnapshot,
  clearWorkspaceSnapshot,
  getWorkspaceSnapshotStatus,
} from '../src/sync/snapshot/index.js';

describe('Workspace Metadata Snapshot Engine (v0.1.47 Phase 2)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-snapshot-test-'));
    initWorkspace(tempDir, { origin: 'https://example.com' });
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('captures clean published (0-GET body), draft (single-GET body), taxonomies, and media metadata (including null storageKey)', async () => {
    const pubId = '01M6PUB0000000000000000001';
    const draftId = '01M6DFT0000000000000000002';
    const calls: string[] = [];

    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);

      if (url.includes('/_emdash/api/openapi.json')) {
        return new Response(JSON.stringify({ paths: {} }), { status: 200 });
      }
      if (url.includes('/_emdash/api/taxonomies/category/terms')) {
        return new Response(
          JSON.stringify({ data: { terms: [{ id: '01M6CAT1', slug: 'tech', name: 'Tech' }] } }),
          { status: 200 },
        );
      }
      if (url.includes('/_emdash/api/taxonomies/tag/terms')) {
        return new Response(
          JSON.stringify({ data: { terms: [{ id: '01M6TAG1', slug: 'ai', name: 'AI' }] } }),
          { status: 200 },
        );
      }
      if (url.includes('/_emdash/api/content/posts?status=published')) {
        return new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  id: pubId,
                  slug: 'clean-pub',
                  status: 'published',
                  _rev: '2',
                  version: 2,
                  liveRevisionId: '01M6LIVE2',
                  draftRevisionId: null,
                  createdAt: '2026-11-01T00:00:00.000Z',
                  data: {
                    title: 'Clean Published',
                    content: [
                      {
                        _type: 'block',
                        style: 'normal',
                        children: [{ _type: 'span', text: 'Live body text' }],
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
        return new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  id: draftId,
                  slug: 'my-draft',
                  status: 'draft',
                  _rev: '1',
                  version: 1,
                  draftRevisionId: '01M6DREV1',
                  createdAt: '2026-11-02T00:00:00.000Z',
                  data: {
                    title: 'My Draft',
                    content: [
                      {
                        _type: 'block',
                        style: 'normal',
                        children: [{ _type: 'span', text: 'STALE creation body' }],
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
      if (url.endsWith(`/_emdash/api/content/posts/${draftId}`)) {
        return new Response(
          JSON.stringify({
            data: {
              id: draftId,
              data: {
                title: 'My Draft',
                content: [
                  {
                    _type: 'block',
                    style: 'normal',
                    children: [{ _type: 'span', text: 'Latest verified draft body' }],
                  },
                ],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes(`/terms/category`)) {
        return new Response(JSON.stringify({ data: { terms: [{ slug: 'tech' }] } }), {
          status: 200,
        });
      }
      if (url.includes(`/terms/tag`)) {
        return new Response(JSON.stringify({ data: { terms: [{ slug: 'ai' }] } }), { status: 200 });
      }
      if (url.includes('/_emdash/api/media?')) {
        return new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  id: '01m6med0000000000000000001',
                  storageKey: '01M6KEY1.jpg',
                  filename: 'sunset.jpg',
                  mimeType: 'image/jpeg',
                  size: 2048,
                  alt: 'Sunset',
                  createdAt: '2026-11-01T00:00:00.000Z',
                },
                {
                  id: '01m6med0000000000000000002',
                  storageKey: null,
                  filename: 'legacy.png',
                  mimeType: 'image/png',
                  size: 512,
                  createdAt: '2026-11-02T00:00:00.000Z',
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response('Not found', { status: 404 });
    });

    const first = await captureWorkspaceSnapshot({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(first.articleCount).toBe(2);
    expect(first.mediaCount).toBe(2);
    expect(first.articleSingleGetCount).toBe(1); // Only draft triggered single GET
    expect(first.taxonomyFetchedCount).toBe(2);
    expect(first.taxonomyReusedCount).toBe(0);

    // Clean published uses list-live; draft uses single-get (never stale list body)
    const pubRow = cache.getSnapshotArticle(pubId);
    expect(pubRow?.bodySource).toBe('list-live');
    expect(pubRow?.bodyMarkdown).toContain('Live body text');
    expect(JSON.parse(pubRow!.categoriesJson)).toEqual(['tech']);

    const draftRow = cache.getSnapshotArticle(draftId);
    expect(draftRow?.bodySource).toBe('single-get');
    expect(draftRow?.bodyMarkdown).toContain('Latest verified draft body');
    expect(draftRow?.bodyMarkdown).not.toContain('STALE creation body');

    // Second run with unchanged comparison_rev: 0-GET reuse for both single-GET body and taxonomies
    calls.length = 0;
    const second = await captureWorkspaceSnapshot({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(second.articleSingleGetCount).toBe(0);
    expect(second.taxonomyFetchedCount).toBe(0);
    expect(second.taxonomyReusedCount).toBe(2);
    expect(calls.some((u) => u.includes('/terms/'))).toBe(false);
    expect(calls.some((u) => u.endsWith(`/${draftId}`))).toBe(false);

    const status = getWorkspaceSnapshotStatus(cache, 'posts');
    expect(status.meta?.articleCount).toBe(2);
    expect(status.meta?.mediaCount).toBe(2);

    const cleared = clearWorkspaceSnapshot(cache, 'posts');
    expect(cleared).toEqual({ collection: 'posts', articlesCleared: 2, mediaCleared: 2 });
    expect(getWorkspaceSnapshotStatus(cache, 'posts').meta).toBeNull();
  });

  it('self-heals taxonomyVerified=0 and list-stale rows on the next snapshot even when comparisonRev matches (R-2)', async () => {
    const draftId = '01M6DFT0000000000000000099';
    let failTerms = true;

    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/_emdash/api/openapi.json'))
        return new Response(JSON.stringify({}), { status: 200 });
      if (url.includes('/_emdash/api/taxonomies/'))
        return new Response(JSON.stringify({ data: { terms: [] } }), { status: 200 });
      if (url.includes('/_emdash/api/content/posts?status=published'))
        return new Response(JSON.stringify({ data: { items: [] } }), { status: 200 });
      if (url.includes('/_emdash/api/content/posts?status=draft')) {
        return new Response(
          JSON.stringify({
            data: {
              items: [
                {
                  id: draftId,
                  slug: 'healing-draft',
                  status: 'draft',
                  _rev: '1',
                  version: 1,
                  draftRevisionId: '01M6DREV99',
                  data: { title: 'Healing Draft', content: [] },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/${draftId}`)) {
        return failTerms
          ? new Response('Temporary 500', { status: 500 })
          : new Response(
              JSON.stringify({
                data: {
                  id: draftId,
                  data: {
                    title: 'Healing Draft',
                    content: [
                      {
                        _type: 'block',
                        style: 'normal',
                        children: [{ _type: 'span', text: 'Healed body' }],
                      },
                    ],
                  },
                },
              }),
              { status: 200 },
            );
      }
      if (url.includes('/terms/')) {
        return failTerms
          ? new Response('Temporary 500', { status: 500 })
          : new Response(JSON.stringify({ data: { terms: [{ slug: 'news' }] } }), { status: 200 });
      }
      if (url.includes('/_emdash/api/media?'))
        return new Response(JSON.stringify({ data: { items: [] } }), { status: 200 });
      return new Response('Not found', { status: 404 });
    });

    const first = await captureWorkspaceSnapshot({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    expect(first.taxonomyFetchedCount).toBe(1);
    const staleRow = cache.getSnapshotArticle(draftId);
    expect(staleRow?.bodySource).toBe('list-stale');
    expect(staleRow?.taxonomyVerified).toBe(0);

    // Next snapshot with same comparisonRev must NOT reuse list-stale / taxonomyVerified=0
    failTerms = false;
    const second = await captureWorkspaceSnapshot({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    expect(second.articleSingleGetCount).toBe(1);
    expect(second.taxonomyFetchedCount).toBe(1);
    expect(second.taxonomyReusedCount).toBe(0);

    const healedRow = cache.getSnapshotArticle(draftId);
    expect(healedRow?.bodySource).toBe('single-get');
    expect(healedRow?.bodyMarkdown).toContain('Healed body');
    expect(healedRow?.taxonomyVerified).toBe(1);
    expect(JSON.parse(healedRow!.categoriesJson)).toEqual(['news']);
  });
});
