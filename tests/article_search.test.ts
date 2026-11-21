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
import { searchLocalArticles, searchRemoteArticles } from '../src/sync/article_search/index.js';
import {
  formatArticleSearchEmptyNotice,
  formatArticleSearchHeader,
  formatArticleSearchHit,
  formatArticleSearchOfflineHint,
  formatArticleSearchWalkIncompleteNotice,
  OFFLINE_ARTICLE_SEARCH_EMPTY_NOTICE,
} from '../src/presentation/article_report.js';
import { createBaseSnapshot } from '../src/db/baseline.js';
import { ApiError } from '../src/client/error.js';
import { createMcpServer } from '../src/mcp/server.js';
import { initWorkspace } from '../src/utils/config.js';
import { setProfile } from '../src/utils/profile.js';
import { calculateHash } from '../src/sync/workspace/index.js';
import { serializeMarkdown } from '../src/utils/frontmatter.js';
import type { Frontmatter } from '../src/utils/frontmatter.js';

function makeTestFrontmatter(
  overrides: Partial<Frontmatter> & { id: string; title: string; slug: string },
): Frontmatter {
  return {
    collection: 'posts',
    status: 'published',
    locale: 'ja',
    bylines: [],
    taxonomies: {},
    ...overrides,
  };
}

describe('Article Search & Targeting Engine (v0.1.43)', () => {
  let tempDir: string;
  let cache: CacheDatabase;
  const mockOrigin = 'https://emdash.test';
  const mockToken = 'test-token';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-article-search-'));
    fs.mkdirSync(path.join(tempDir, 'posts', 'draft'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'posts', 'published'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'posts', 'conflicts'), { recursive: true });
    cache = new CacheDatabase(path.join(tempDir, 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // T0-1: query only -> FTS called, returns searchMode: 'fts', does not call content list endpoint
  it('T0-1: query only invokes FTS search returning searchMode: fts', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/_emdash/api/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              items: [
                {
                  id: '01M77VFT000000000000000001',
                  slug: 'kingfisher-photo',
                  title: 'カワセミの撮影記',
                  snippet: '枝にとまるカワセミの静寂な佇まい',
                  score: 1.5,
                },
              ],
              nextCursor: null,
            },
          }),
        };
      }
      throw new Error(`Unexpected URL called: ${url}`);
    });

    const result = await searchRemoteArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'カワセミ',
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.searchMode).toBe('fts');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].title).toBe('カワセミの撮影記');
    expect(result.hits[0].snippet).toContain('枝にとまるカワセミ');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/_emdash/api/search');
  });

  // T0-2: FTS HTTP error -> falls back to scan with fallbackReason. 0 hits does NOT fall back.
  it('T0-2: FTS HTTP error falls back to scan with fallbackReason; 0 hits does NOT fall back', async () => {
    // 1. HTTP 500 error triggers fallback
    const mockFetchError = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/_emdash/api/search')) {
        return { ok: false, status: 500, statusText: 'Internal Server Error' };
      }
      if (url.includes('/_emdash/api/content/posts')) {
        if (url.includes('status=published')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                items: [
                  {
                    id: '01M77VFT000000000000000002',
                    slug: 'fallback-post',
                    title: 'Fallback Post Title',
                    status: 'published',
                    createdAt: '2026-11-20T10:00:00Z',
                    data: { title: 'Fallback Post Title' },
                  },
                ],
                nextCursor: null,
              },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
        };
      }
      return { ok: true, json: async () => ({ success: true, data: { items: [] } }) };
    });

    const resultFallback = await searchRemoteArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'Fallback',
      cache,
      fetchFn: mockFetchError as unknown as typeof fetch,
    });

    expect(resultFallback.searchMode).toBe('scan');
    expect(resultFallback.fallbackReason).toContain('HTTP 500');
    expect(resultFallback.hits).toHaveLength(1);

    // 2. FTS 0 hits with query >= 3 chars stays fts mode (does not fall back to scan)
    const mockFetchZeroHits = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/_emdash/api/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { items: [], nextCursor: null },
          }),
        };
      }
      throw new Error(`Should not call content endpoint: ${url}`);
    });

    const resultZeroHits = await searchRemoteArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'NonExistentLongQuery',
      cache,
      fetchFn: mockFetchZeroHits as unknown as typeof fetch,
    });

    expect(resultZeroHits.searchMode).toBe('fts');
    expect(resultZeroHits.hits).toHaveLength(0);
    expect(mockFetchZeroHits).toHaveBeenCalledTimes(1);
  });

  // T0-3: Decision rule precedence
  it('T0-3: decision rule precedence offline > tag/category > since/until > query > recency', async () => {
    // Write a local file
    fs.writeFileSync(
      path.join(tempDir, 'posts', 'published', '20261120_01M77VFT000000000000000003-local.md'),
      `---\nid: 01M77VFT000000000000000003\ntitle: Local File\nstatus: published\n---\nLocal body`,
    );

    const mockFetch = vi.fn();

    // 1. offline: true -> zero network calls
    const resOffline = await searchRemoteArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      offline: true,
      query: 'Local',
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    expect(resOffline.searchMode).toBe('scan');
    expect(resOffline.hits).toHaveLength(1);
    expect(mockFetch).not.toHaveBeenCalled();

    // 2. tag specified with query -> does NOT call /search, routes to scan path
    const mockFetchScan = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/_emdash/api/search')) {
        throw new Error('FTS endpoint must NOT be called when tag filter is present');
      }
      if (url.includes('/_emdash/api/content/posts')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { items: [], nextCursor: null },
          }),
        };
      }
      return { ok: true, json: async () => ({ success: true, data: [] }) };
    });

    const resTag = await searchRemoteArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'hello',
      tag: 'nature',
      cache,
      fetchFn: mockFetchScan as unknown as typeof fetch,
    });
    expect(resTag.searchMode).toBe('scan');
  });

  // T0-4: maxScan ignored for FTS path
  it('T0-4: maxScan is ignored on FTS path and limit is passed to search endpoint', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      expect(u.searchParams.get('limit')).toBe('15');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { items: [], nextCursor: null },
        }),
      };
    });

    const res = await searchRemoteArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'test',
      limit: 15,
      maxScan: 10,
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.searchMode).toBe('fts');
  });

  // T1-1: Recency browse without query
  it('T1-1: query-less execution browses newest articles via scan path', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('status=published')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              items: [
                {
                  id: '01M77VFT000000000000000010',
                  slug: 'newest-article',
                  title: 'Newest Article',
                  status: 'published',
                  createdAt: '2026-11-20T12:00:00Z',
                  publishedAt: '2026-11-20T12:00:00Z',
                },
              ],
              nextCursor: null,
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
      };
    });

    const res = await searchRemoteArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.searchMode).toBe('scan');
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].id).toBe('01M77VFT000000000000000010');
    expect(res.hits[0].matchedOn).toContain('recency');
  });

  // T1-2: keyword matching in scan path
  it('T1-2: matches keyword against title, slug, and excerpt in scan fallback', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/_emdash/api/search')) {
        return { ok: false, status: 503 };
      }
      if (url.includes('/_emdash/api/content/posts')) {
        if (url.includes('status=published')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                items: [
                  {
                    id: '01M77VFT000000000000000011',
                    slug: 'keyword-slug-match',
                    title: 'Random Title',
                    status: 'published',
                    data: { excerpt: 'Nothing special' },
                  },
                  {
                    id: '01M77VFT000000000000000012',
                    slug: 'another-slug',
                    title: 'Random Title 2',
                    status: 'published',
                    data: { excerpt: 'Has keyword inside excerpt' },
                  },
                ],
                nextCursor: null,
              },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
        };
      }
      return { ok: true, json: async () => ({ success: true, data: { items: [] } }) };
    });

    const res = await searchRemoteArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'keyword',
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.hits).toHaveLength(2);
    expect(res.hits[0].matchedOn).toContain('slug');
    expect(res.hits[1].matchedOn).toContain('excerpt');
  });

  // T1-3 & T1-4 & T1-7: tag and category filters with bounded HTTP GET count
  it('T1-3 & T1-7: tag filter verifies assigned terms and bounds HTTP count to <= limit * 2', async () => {
    let termFetchCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/terms/tag')) {
        termFetchCount++;
        if (url.includes('01M77VFT000000000000000021')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { terms: [{ slug: 'nature' }] } }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { terms: [{ slug: 'tech' }] } }),
        };
      }
      if (url.includes('/_emdash/api/content/posts')) {
        if (url.includes('status=published')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                items: [
                  { id: '01M77VFT000000000000000021', title: 'Post 1', status: 'published' },
                  { id: '01M77VFT000000000000000022', title: 'Post 2', status: 'published' },
                ],
                nextCursor: null,
              },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
        };
      }
      return { ok: true, json: async () => ({ success: true, data: { items: [] } }) };
    });

    const res = await searchRemoteArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      tag: 'nature',
      limit: 1,
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].id).toBe('01M77VFT000000000000000021');
    expect(res.taxonomyFetchCount).toBe(1);
    expect(res.taxonomyFetchCount).toBeLessThanOrEqual(1 * 2);
  });

  // T1-5: status filter
  it('T1-5: filters by status querying only the requested collection', async () => {
    const requestedStatuses: string[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      const st = u.searchParams.get('status');
      if (st) requestedStatuses.push(st);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
      };
    });

    await searchRemoteArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      status: 'draft',
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(requestedStatuses).toEqual(['draft']);
  });

  // T1-6: slug filter
  it('T1-6: filters by slug substring', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/_emdash/api/content/posts')) {
        if (url.includes('status=published')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                items: [
                  { id: '01M77VFT000000000000000031', slug: 'tokyo-ramen-guide', title: 'Ramen' },
                  { id: '01M77VFT000000000000000032', slug: 'osaka-sushi-guide', title: 'Sushi' },
                ],
                nextCursor: null,
              },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
        };
      }
      return { ok: true, json: async () => ({ success: true, data: { items: [] } }) };
    });

    const res = await searchRemoteArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      slug: 'tokyo',
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].slug).toBe('tokyo-ramen-guide');
  });

  // T1-8: Epistemic protection on incomplete walk
  it('T1-8: prints WALK_INCOMPLETE when walk stops before end of library', () => {
    const incompleteRes = {
      hits: [],
      searchMode: 'scan' as const,
      scannedCount: 50,
      totalCount: null,
      walkComplete: false,
      truncated: true,
      normalizedQuery: '',
      taxonomyFetchCount: 0,
      taxonomyCacheHitCount: 0,
    };

    const notice = formatArticleSearchWalkIncompleteNotice(incompleteRes);
    expect(notice).toContain('[WALK_INCOMPLETE]');
    expect(notice).toContain('absence is not proven');

    const completeRes = { ...incompleteRes, walkComplete: true };
    expect(formatArticleSearchWalkIncompleteNotice(completeRes)).toBeNull();
  });

  // T2-1 & T2-2: since / until date range and same-day boundary
  it('T2-1 & T2-2: filters by date range with same-day boundary inclusive', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/_emdash/api/content/posts')) {
        if (url.includes('status=published')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                items: [
                  {
                    id: '01M77VFT000000000000000041',
                    title: 'Today Post',
                    createdAt: '2026-11-20T10:00:00Z',
                    publishedAt: '2026-11-20T10:00:00Z',
                    status: 'published',
                  },
                  {
                    id: '01M77VFT000000000000000042',
                    title: 'Older Post',
                    createdAt: '2026-11-18T10:00:00Z',
                    publishedAt: '2026-11-18T10:00:00Z',
                    status: 'published',
                  },
                ],
                nextCursor: null,
              },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
        };
      }
      return { ok: true, json: async () => ({ success: true, data: { items: [] } }) };
    });

    const res = await searchRemoteArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      since: '2026-11-20',
      until: '2026-11-20',
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].id).toBe('01M77VFT000000000000000041');
  });

  // T2-3 & T2-6: early exit on createdAt only; series evaluated independently
  it('T2-3: early-exit fires only when dateField is createdAt', async () => {
    const requestedUrls: string[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      requestedUrls.push(url);
      if (url.includes('status=published')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              items: [
                {
                  id: '01M77VFT000000000000000051',
                  createdAt: '2026-11-15T00:00:00Z', // older than since
                  publishedAt: '2026-11-21T00:00:00Z', // newer than since
                  status: 'published',
                },
              ],
              nextCursor: 'next-page-cursor',
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ success: true, data: { items: [] } }) };
    });

    // 1. With dateField: 'createdAt' (default), items older than since trigger early-exit
    await searchRemoteArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      status: 'published',
      since: '2026-11-20',
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    // Cursor loop should have broken after first page because createdAt < since
    expect(requestedUrls.filter((u) => u.includes('cursor=next-page-cursor'))).toHaveLength(0);

    // 2. With dateField: 'publishedAt', early-exit does NOT break on createdAt
    requestedUrls.length = 0;
    const mockFetchPublishedAt = vi.fn().mockImplementation(async (url: string) => {
      requestedUrls.push(url);
      if (url.includes('cursor=next-page-cursor')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            items: [
              {
                id: '01M77VFT000000000000000052',
                createdAt: '2026-11-15T00:00:00Z',
                publishedAt: '2026-11-21T00:00:00Z',
                status: 'published',
              },
            ],
            nextCursor: 'next-page-cursor',
          },
        }),
      };
    });

    const resPub = await searchRemoteArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      status: 'published',
      since: '2026-11-20',
      dateField: 'publishedAt',
      cache,
      fetchFn: mockFetchPublishedAt as unknown as typeof fetch,
    });

    expect(resPub.hits).toHaveLength(1);
    expect(requestedUrls.some((u) => u.includes('cursor=next-page-cursor'))).toBe(true);
  });

  // T2-4: dateField switching
  it('T2-4: respects explicit dateField for filtering', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          items: [
            {
              id: '01M77VFT000000000000000061',
              createdAt: '2026-11-10T00:00:00Z',
              updatedAt: '2026-11-20T00:00:00Z',
              status: 'published',
            },
          ],
          nextCursor: null,
        },
      }),
    }));

    const res = await searchRemoteArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      status: 'published',
      since: '2026-11-19',
      dateField: 'updatedAt',
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.hits).toHaveLength(1);
  });

  // T2-5: rawItem without date handled gracefully
  it('T2-5: rawItem without dates is excluded from date range without throwing', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          items: [{ id: '01M77VFT000000000000000071', title: 'No dates' }],
          nextCursor: null,
        },
      }),
    }));

    const res = await searchRemoteArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      since: '2026-11-01',
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.hits).toHaveLength(0);
  });

  // T3-1 & T3-2: local tracking status visualization
  it('T3-1 & T3-2: identifies local vs remote-only articles and renders pull suggestions', async () => {
    // Write local article file
    const localUlid = '01M77VFT000000000000000081';
    fs.writeFileSync(
      path.join(tempDir, 'posts', 'published', `20261120_${localUlid}-my-post.md`),
      `---\nid: ${localUlid}\ntitle: My Post\nstatus: published\n---\nBody`,
    );

    const remoteUlid = '01M77VFT000000000000000082';

    const mockFetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          items: [
            { id: localUlid, title: 'Local Article', status: 'published' },
            { id: remoteUlid, title: 'Remote Article', status: 'published' },
          ],
          nextCursor: null,
        },
      }),
    }));

    const res = await searchRemoteArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      status: 'published',
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.hits).toHaveLength(2);
    const localHit = res.hits.find((h) => h.id === localUlid)!;
    const remoteHit = res.hits.find((h) => h.id === remoteUlid)!;

    expect(localHit.isLocal).toBe(true);
    expect(localHit.localPath).toContain('posts/published');
    expect(remoteHit.isLocal).toBe(false);
    expect(remoteHit.localPath).toBeNull();

    const formattedRemote = formatArticleSearchHit(remoteHit, 1);
    expect(formattedRemote).toContain('[remote only]');
    expect(formattedRemote).toContain(`--> To edit or pull locally: emit pull ${remoteUlid}`);
  });

  // T4-1 & T4-2 & T4-3: offline search with body matching, header, and empty notice
  it('T4-1 & T4-2 & T4-3: offline search searches markdown bodies, renders header and absence notice', () => {
    fs.writeFileSync(
      path.join(tempDir, 'posts', 'published', '20261120_01M77VFT000000000000000091-sunset.md'),
      `---\nid: 01M77VFT000000000000000091\ntitle: Sunset View\nstatus: published\n---\nMagnificent golden hour in Kyoto.`,
    );

    // 1. Matches body text offline
    const res = searchLocalArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      query: 'golden hour',
      cache,
    });

    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].id).toBe('01M77VFT000000000000000091');
    expect(res.hits[0].matchedOn).toContain('body');

    // 2. Header
    const header = formatArticleSearchHeader(res, { offline: true });
    expect(header).toContain('[SOURCE: LOCAL WORKSPACE ONLY (OFFLINE)]');
    expect(header).toContain('Remote EmDash library was NOT queried.');

    // 3. Empty notice
    const emptyRes = searchLocalArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      query: 'nonexistent',
      cache,
    });
    expect(emptyRes.hits).toHaveLength(0);
    const emptyNotice = formatArticleSearchEmptyNotice(emptyRes, true);
    expect(emptyNotice).toBe(OFFLINE_ARTICLE_SEARCH_EMPTY_NOTICE);
    expect(emptyNotice).toContain('This does NOT prove the article does not exist on remote');
  });

  // T4-4: posts/conflicts/ excluded by default; tagged quarantined with includeConflicts
  it('T4-4: excludes posts/conflicts/ by default; includes and flags quarantined with includeConflicts', () => {
    fs.writeFileSync(
      path.join(tempDir, 'posts', 'conflicts', '20261120_01M77VFT000000000000000099-conflict.md'),
      `---\nid: 01M77VFT000000000000000099\ntitle: Quarantined Conflict\nstatus: draft\n---\nQuarantined text`,
    );

    // Default: excluded
    const resDefault = searchLocalArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      query: 'Quarantined',
      cache,
    });
    expect(resDefault.hits).toHaveLength(0);

    // With includeConflicts: true
    const resIncluded = searchLocalArticles({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      query: 'Quarantined',
      includeConflicts: true,
      cache,
    });
    expect(resIncluded.hits).toHaveLength(1);
    expect(resIncluded.hits[0].quarantined).toBe(true);

    const hitLine = formatArticleSearchHit(resIncluded.hits[0], 0);
    expect(hitLine).toContain('[quarantined — never push]');
  });

  // T5-2 & T5-3: Error code registry and DATE_BOUNDARY_INVALID handling
  it('T5-2 & T5-3: DATE_BOUNDARY_INVALID raises typed ApiError with suggestion', async () => {
    try {
      await searchRemoteArticles({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        since: 'invalid-date-format',
        cache,
      });
      expect.unreachable('Should have thrown DATE_BOUNDARY_INVALID');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe('DATE_BOUNDARY_INVALID');
      expect(apiErr.suggestion).toContain('today / yesterday');
    }
  });

  describe('v0.1.44 P2: Taxonomy Fast-Path via Baseline Snapshots', () => {
    const articleId = '01M77VFT000000000000000101';
    const rev = '4@live:01M77VFT000000000000000101';
    const b64Rev4 = Buffer.from('4:2026-11-20T10:00:00.000Z').toString('base64');

    // T-1: rev matches, no pending flags -> 0 terms GETs, fast-path hits
    it('T-1: evaluates taxonomies from baseline snapshot with 0 terms GETs when rev matches and no pending changes', async () => {
      const diskPath = path.join(
        tempDir,
        'posts',
        'published',
        `20261120_${articleId}-fast-path.md`,
      );
      const diskContent = `---\nid: ${articleId}\ntitle: Fast Path Article\nslug: fast-path-article\nstatus: published\nlocale: ja\ncollection: posts\ntaxonomies:\n  categories:\n    - photography\n  tags:\n    - nature\n---\nBody content`;
      fs.writeFileSync(diskPath, diskContent, 'utf8');
      const diskHash = calculateHash(diskContent);

      const base = createBaseSnapshot({
        id: articleId,
        rev,
        bodyMarkdown: 'Body content',
        frontmatter: makeTestFrontmatter({
          id: articleId,
          title: 'Fast Path Article',
          slug: 'fast-path-article',
          taxonomies: {
            categories: ['photography'],
            tags: ['nature'],
          },
        }),
        hash: diskHash,
      });
      cache.saveBaseSnapshot(base);
      cache.saveSyncState({
        id: articleId,
        localFilePath: `posts/published/20261120_${articleId}-fast-path.md`,
        localHash: diskHash,
        remoteRev: rev,
        status: 'published',
        slug: 'fast-path-article',
        lastSyncedAt: Date.now(),
        taxonomyApplyPending: 0,
        taxonomyConflictPending: 0,
      });

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/terms/')) {
          throw new Error(`terms endpoint should NOT be called on fast-path: ${url}`);
        }
        if (url.includes('/_emdash/api/content/posts')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                items: [
                  {
                    id: articleId,
                    title: 'Fast Path Article',
                    status: 'published',
                    _rev: b64Rev4,
                    version: 4,
                    liveRevisionId: '01M77VFT000000000000000101',
                  },
                ],
                nextCursor: null,
              },
            }),
          };
        }
        return { ok: true, json: async () => ({ success: true, data: { items: [] } }) };
      });

      const result = await searchRemoteArticles({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        status: 'published',
        tag: 'nature',
        category: 'photography',
        cache,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result.hits).toHaveLength(1);
      expect(result.hits[0].id).toBe(articleId);
      expect(result.taxonomyFetchCount).toBe(0);
      expect(result.taxonomyCacheHitCount).toBe(1);

      // Verify fast-path still succeeds when item.version is absent from list item (reconstructed from _rev)
      const mockFetchNoVersion = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/terms/')) {
          throw new Error(`terms endpoint should NOT be called on fast-path: ${url}`);
        }
        if (url.includes('/_emdash/api/content/posts')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                items: [
                  {
                    id: articleId,
                    title: 'Fast Path Article',
                    status: 'published',
                    _rev: b64Rev4,
                    liveRevisionId: '01M77VFT000000000000000101',
                  },
                ],
                nextCursor: null,
              },
            }),
          };
        }
        return { ok: true, json: async () => ({ success: true, data: { items: [] } }) };
      });

      const resultNoVersion = await searchRemoteArticles({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        status: 'published',
        tag: 'nature',
        cache,
        fetchFn: mockFetchNoVersion as unknown as typeof fetch,
      });
      expect(resultNoVersion.hits).toHaveLength(1);
      expect(resultNoVersion.taxonomyFetchCount).toBe(0);
      expect(resultNoVersion.taxonomyCacheHitCount).toBe(1);
    });

    // T-2: rev mismatch triggers fallback to terms GET
    it('T-2: issues terms GET when rev does not match cached rev (remote edited)', async () => {
      const base = createBaseSnapshot({
        id: articleId,
        rev,
        bodyMarkdown: 'Body content',
        frontmatter: makeTestFrontmatter({
          id: articleId,
          title: 'Fast Path Article',
          slug: 'fast-path-article',
          taxonomies: { tags: ['old-tag'] },
        }),
        hash: 'hash-101',
      });
      cache.saveBaseSnapshot(base);
      cache.saveSyncState({
        id: articleId,
        localFilePath: `posts/published/20261120_${articleId}-fast-path.md`,
        localHash: 'hash-101',
        remoteRev: rev,
        status: 'published',
        slug: 'fast-path-article',
        lastSyncedAt: Date.now(),
        taxonomyApplyPending: 0,
        taxonomyConflictPending: 0,
      });

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/terms/tag')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { terms: [{ slug: 'nature' }] } }),
          };
        }
        if (url.includes('/_emdash/api/content/posts')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                items: [
                  {
                    id: articleId,
                    title: 'Fast Path Article',
                    status: 'published',
                    _rev: '2', // Rev 2 differs from cached rev 1!
                    liveRevisionId: '01M77VFT000000000000000999',
                  },
                ],
                nextCursor: null,
              },
            }),
          };
        }
        return { ok: true, json: async () => ({ success: true, data: { items: [] } }) };
      });

      const result = await searchRemoteArticles({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        status: 'published',
        tag: 'nature',
        cache,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result.hits).toHaveLength(1);
      expect(result.taxonomyFetchCount).toBe(1);
      expect(result.taxonomyCacheHitCount).toBe(0);
    });

    // T-3: taxonomyApplyPending, taxonomyConflictPending, or deletePending bypasses fast-path
    it('T-3: bypasses fast-path and issues terms GET when pending flags are set', async () => {
      const base = createBaseSnapshot({
        id: articleId,
        rev,
        bodyMarkdown: 'Body content',
        frontmatter: makeTestFrontmatter({
          id: articleId,
          title: 'Pending Article',
          slug: 'pending-article',
          taxonomies: { tags: ['nature'] },
        }),
        hash: 'hash-101',
      });
      cache.saveBaseSnapshot(base);
      cache.saveSyncState({
        id: articleId,
        localFilePath: `posts/published/20261120_${articleId}-fast-path.md`,
        localHash: 'hash-101',
        remoteRev: rev,
        status: 'published',
        slug: 'pending-article',
        lastSyncedAt: Date.now(),
        taxonomyApplyPending: 1, // Pending flag set!
        taxonomyConflictPending: 0,
      });

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/terms/tag')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { terms: [{ slug: 'nature' }] } }),
          };
        }
        if (url.includes('/_emdash/api/content/posts')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                items: [
                  {
                    id: articleId,
                    title: 'Pending Article',
                    status: 'published',
                    _rev: '1',
                    liveRevisionId: '01M77VFT000000000000000101',
                  },
                ],
                nextCursor: null,
              },
            }),
          };
        }
        return { ok: true, json: async () => ({ success: true, data: { items: [] } }) };
      });

      const result = await searchRemoteArticles({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        status: 'published',
        tag: 'nature',
        cache,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result.hits).toHaveLength(1);
      expect(result.taxonomyFetchCount).toBe(1);
      expect(result.taxonomyCacheHitCount).toBe(0);

      // Verify deletePending: 1 also bypasses fast-path
      cache.saveSyncState({
        id: articleId,
        localFilePath: `posts/published/20261120_${articleId}-fast-path.md`,
        localHash: 'hash-101',
        remoteRev: rev,
        status: 'published',
        slug: 'pending-article',
        lastSyncedAt: Date.now(),
        taxonomyApplyPending: 0,
        taxonomyConflictPending: 0,
        deletePending: 1, // deletePending flag set!
      });

      const resultDeletePending = await searchRemoteArticles({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        status: 'published',
        tag: 'nature',
        cache,
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      expect(resultDeletePending.hits).toHaveLength(1);
      expect(resultDeletePending.taxonomyFetchCount).toBe(1);
      expect(resultDeletePending.taxonomyCacheHitCount).toBe(0);

      // Verify bodyConflictPending: 1 also bypasses fast-path
      cache.saveSyncState({
        id: articleId,
        localFilePath: `posts/published/20261120_${articleId}-fast-path.md`,
        localHash: 'hash-101',
        remoteRev: rev,
        status: 'published',
        slug: 'pending-article',
        lastSyncedAt: Date.now(),
        taxonomyApplyPending: 0,
        taxonomyConflictPending: 0,
        bodyConflictPending: 1, // bodyConflictPending flag set!
      });

      const resultBodyConflictPending = await searchRemoteArticles({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        status: 'published',
        tag: 'nature',
        cache,
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      expect(resultBodyConflictPending.hits).toHaveLength(1);
      expect(resultBodyConflictPending.taxonomyFetchCount).toBe(1);
      expect(resultBodyConflictPending.taxonomyCacheHitCount).toBe(0);
    });

    // T-4: corrupt baseline frontmatter falls back to GET gracefully
    it('T-4: falls back to terms GET when baseline frontmatter is corrupt', async () => {
      // Direct insert corrupt baseline JSON
      cache.saveSyncState({
        id: articleId,
        localFilePath: `posts/published/20261120_${articleId}-corrupt.md`,
        localHash: 'hash-101',
        remoteRev: rev,
        status: 'published',
        slug: 'corrupt-article',
        lastSyncedAt: Date.now(),
        taxonomyApplyPending: 0,
        taxonomyConflictPending: 0,
      });
      cache.saveBaseSnapshot({
        id: articleId,
        rev,
        bodyMarkdown: '',
        frontmatterYaml: 'not a valid json {{{{',
        hash: 'hash-101',
        savedAt: Date.now(),
      });

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/terms/tag')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { terms: [{ slug: 'nature' }] } }),
          };
        }
        if (url.includes('/_emdash/api/content/posts')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                items: [
                  {
                    id: articleId,
                    title: 'Corrupt Article',
                    status: 'published',
                    _rev: '1',
                    liveRevisionId: '01M77VFT000000000000000101',
                  },
                ],
                nextCursor: null,
              },
            }),
          };
        }
        return { ok: true, json: async () => ({ success: true, data: { items: [] } }) };
      });

      const result = await searchRemoteArticles({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        status: 'published',
        tag: 'nature',
        cache,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result.hits).toHaveLength(1);
      expect(result.taxonomyFetchCount).toBe(1);
      expect(result.taxonomyCacheHitCount).toBe(0);
    });

    // T-4b: legacy baseline frontmatter with no categories/tags recorded falls back to GET
    it('T-4b: falls back to terms GET when baseline frontmatter has no recorded categories or tags', async () => {
      const baseLegacy = createBaseSnapshot({
        id: articleId,
        rev,
        bodyMarkdown: 'Body content',
        frontmatter: makeTestFrontmatter({
          id: articleId,
          title: 'Legacy Article',
          slug: 'legacy-article',
          taxonomies: {}, // Empty / unrecorded taxonomies
        }),
        hash: 'hash-101',
      });
      cache.saveBaseSnapshot(baseLegacy);
      cache.saveSyncState({
        id: articleId,
        localFilePath: `posts/published/20261120_${articleId}-legacy.md`,
        localHash: 'hash-101',
        remoteRev: rev,
        status: 'published',
        slug: 'legacy-article',
        lastSyncedAt: Date.now(),
        taxonomyApplyPending: 0,
        taxonomyConflictPending: 0,
      });

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/terms/tag')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { terms: [{ slug: 'nature' }] } }),
          };
        }
        if (url.includes('/_emdash/api/content/posts')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                items: [
                  {
                    id: articleId,
                    title: 'Legacy Article',
                    status: 'published',
                    _rev: '1',
                    liveRevisionId: '01M77VFT000000000000000101',
                  },
                ],
                nextCursor: null,
              },
            }),
          };
        }
        return { ok: true, json: async () => ({ success: true, data: { items: [] } }) };
      });

      const result = await searchRemoteArticles({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        status: 'published',
        tag: 'nature',
        cache,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result.hits).toHaveLength(1);
      expect(result.taxonomyFetchCount).toBe(1);
      expect(result.taxonomyCacheHitCount).toBe(0);
    });

    // T-5: matches encoded canonical slug from baseline against decoded filter
    it('T-5: matches encoded canonical slug in baseline against decoded filter', async () => {
      const guideId = '01M77VFT000000000000000105';
      const encodedSlug = '%e3%83%ad%e3%83%bc%e3%82%ab%e3%83%ab%e3%82%ac%e3%82%a4%e3%83%89';
      const decodedFilter = 'ローカルガイド';

      // Create local tag definition
      fs.mkdirSync(path.join(tempDir, 'tags'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'tags', '01M77VFT0000000000000000T1-guide.yaml'),
        `id: 01M77VFT0000000000000000T1\nslug: ${decodedFilter}\ncanonicalSlug: ${encodedSlug}\nname: ${decodedFilter}\n`,
      );

      const guidePath = path.join(tempDir, 'posts', 'published', `20261120_${guideId}-guide.md`);
      const guideContent = `---\nid: ${guideId}\ntitle: Guide Article\nslug: guide-article\nstatus: published\nlocale: ja\ncollection: posts\ntaxonomies:\n  tags:\n    - ${encodedSlug}\n---\nBody content`;
      fs.writeFileSync(guidePath, guideContent, 'utf8');
      const guideHash = calculateHash(guideContent);

      const base = createBaseSnapshot({
        id: guideId,
        rev,
        bodyMarkdown: 'Body content',
        frontmatter: makeTestFrontmatter({
          id: guideId,
          title: 'Guide Article',
          slug: 'guide-article',
          taxonomies: { tags: [encodedSlug] },
        }),
        hash: guideHash,
      });
      cache.saveBaseSnapshot(base);
      cache.saveSyncState({
        id: guideId,
        localFilePath: `posts/published/20261120_${guideId}-guide.md`,
        localHash: guideHash,
        remoteRev: rev,
        status: 'published',
        slug: 'guide-article',
        lastSyncedAt: Date.now(),
        taxonomyApplyPending: 0,
        taxonomyConflictPending: 0,
      });

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/terms/')) {
          throw new Error(`Should not call terms on fast-path: ${url}`);
        }
        if (url.includes('/_emdash/api/content/posts')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                items: [
                  {
                    id: guideId,
                    title: 'Guide Article',
                    status: 'published',
                    _rev: b64Rev4,
                    liveRevisionId: '01M77VFT000000000000000101',
                  },
                ],
                nextCursor: null,
              },
            }),
          };
        }
        return { ok: true, json: async () => ({ success: true, data: { items: [] } }) };
      });

      const result = await searchRemoteArticles({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        status: 'published',
        tag: decodedFilter,
        cache,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result.hits).toHaveLength(1);
      expect(result.taxonomyCacheHitCount).toBe(1);
      expect(result.taxonomyFetchCount).toBe(0);
    });

    // T-6: ULID loser term in baseline is preserved verbatim
    it('T-6: preserves ULID loser terms in baseline and matches verbatim', async () => {
      const loserUlid = '01M77VFT000000000000000L01';
      const loserArticleId = '01M77VFT000000000000000106';

      const loserPath = path.join(
        tempDir,
        'posts',
        'published',
        `20261120_${loserArticleId}-loser.md`,
      );
      const loserContent = `---\nid: ${loserArticleId}\ntitle: Loser Article\nslug: loser-article\nstatus: published\nlocale: ja\ncollection: posts\ntaxonomies:\n  tags:\n    - ${loserUlid}\n---\nBody content`;
      fs.writeFileSync(loserPath, loserContent, 'utf8');
      const loserHash = calculateHash(loserContent);

      const base = createBaseSnapshot({
        id: loserArticleId,
        rev,
        bodyMarkdown: 'Body content',
        frontmatter: makeTestFrontmatter({
          id: loserArticleId,
          title: 'Loser Article',
          slug: 'loser-article',
          taxonomies: { tags: [loserUlid] },
        }),
        hash: loserHash,
      });
      cache.saveBaseSnapshot(base);
      cache.saveSyncState({
        id: loserArticleId,
        localFilePath: `posts/published/20261120_${loserArticleId}-loser.md`,
        localHash: loserHash,
        remoteRev: rev,
        status: 'published',
        slug: 'loser-article',
        lastSyncedAt: Date.now(),
        taxonomyApplyPending: 0,
        taxonomyConflictPending: 0,
      });

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/_emdash/api/content/posts')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                items: [
                  {
                    id: loserArticleId,
                    title: 'Loser Article',
                    status: 'published',
                    _rev: b64Rev4,
                    liveRevisionId: '01M77VFT000000000000000101',
                  },
                ],
                nextCursor: null,
              },
            }),
          };
        }
        return { ok: true, json: async () => ({ success: true, data: { items: [] } }) };
      });

      const result = await searchRemoteArticles({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        status: 'published',
        tag: loserUlid,
        cache,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result.hits).toHaveLength(1);
      expect(result.taxonomyCacheHitCount).toBe(1);
    });

    // T-7: taxonomy reporting in header and counts
    it('T-7: header displays cached taxonomy count when taxonomyCacheHitCount > 0', () => {
      const resultWithCache = {
        hits: [],
        searchMode: 'scan' as const,
        scannedCount: 10,
        totalCount: null,
        walkComplete: true,
        truncated: false,
        normalizedQuery: '',
        taxonomyFetchCount: 2,
        taxonomyCacheHitCount: 8,
      };

      const header = formatArticleSearchHeader(resultWithCache, { tag: 'nature' });
      expect(header).toContain('[taxonomies fetched: 2 GET(s)]');
      expect(header).toContain('[taxonomies cached: 8]');
    });

    // T-8: unpushed local edits on disk bypass fast-path and issue terms GET
    it('T-8: unpushed local edits on disk bypass fast-path and issue terms GET', async () => {
      const editArticleId = '01M77VFT000000000000000108';
      const filePath = path.join(
        tempDir,
        'posts',
        'published',
        `20261120_${editArticleId}-modified.md`,
      );
      // Clean content initially recorded
      const cleanContent = `---\nid: ${editArticleId}\ntitle: Modified Article\nslug: modified-article\nstatus: published\nlocale: ja\ncollection: posts\ntaxonomies:\n  tags:\n    - old-tag\n---\nOriginal body`;
      const cleanHash = calculateHash(cleanContent);

      const base = createBaseSnapshot({
        id: editArticleId,
        rev,
        bodyMarkdown: 'Original body',
        frontmatter: makeTestFrontmatter({
          id: editArticleId,
          title: 'Modified Article',
          slug: 'modified-article',
          taxonomies: { tags: ['old-tag'] },
        }),
        hash: cleanHash,
      });
      cache.saveBaseSnapshot(base);
      cache.saveSyncState({
        id: editArticleId,
        localFilePath: `posts/published/20261120_${editArticleId}-modified.md`,
        localHash: cleanHash,
        remoteRev: rev,
        status: 'published',
        slug: 'modified-article',
        lastSyncedAt: Date.now(),
        taxonomyApplyPending: 0,
        taxonomyConflictPending: 0,
      });

      // User modified the file locally on disk adding camera tag (unpushed edit!)
      const modifiedContent = `---\nid: ${editArticleId}\ntitle: Modified Article\nslug: modified-article\nstatus: published\nlocale: ja\ncollection: posts\ntaxonomies:\n  tags:\n    - old-tag\n    - camera\n---\nModified body`;
      fs.writeFileSync(filePath, modifiedContent, 'utf8');

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/terms/tag')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { terms: [{ slug: 'camera' }] } }),
          };
        }
        if (url.includes('/_emdash/api/content/posts')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                items: [
                  {
                    id: editArticleId,
                    title: 'Modified Article',
                    status: 'published',
                    _rev: b64Rev4,
                    liveRevisionId: '01M77VFT000000000000000101',
                  },
                ],
                nextCursor: null,
              },
            }),
          };
        }
        return { ok: true, json: async () => ({ success: true, data: { items: [] } }) };
      });

      const result = await searchRemoteArticles({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        status: 'published',
        tag: 'camera',
        cache,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      // Because local file is modified on disk, fast-path is bypassed and remote terms GET is issued
      expect(result.hits).toHaveLength(1);
      expect(result.taxonomyFetchCount).toBe(1);
      expect(result.taxonomyCacheHitCount).toBe(0);
    });

    // T-9: spelling-only mismatch evaluates fast-path without healing sync_state.local_hash
    it('T-9: article search never heals sync_state.local_hash on a spelling-only mismatch', async () => {
      const storageKeyStem = '01M67P2N0A44G4KHK6QZZGMRW7';
      const storageKey = `${storageKeyStem}.webp`;
      const canonicalUrl = `/_emdash/api/media/file/${storageKey}`;
      const localRef = `../../media/${storageKey}`;

      // Seed a confirmed local mirror so the localization transform is eligible to fire.
      const mediaDir = path.join(tempDir, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      fs.writeFileSync(path.join(mediaDir, storageKey), 'fake-webp-bytes');
      fs.writeFileSync(
        path.join(mediaDir, `${storageKeyStem}.yaml`),
        [
          `id: "01M67PG2WTXPEJVMS4W5N3FC48"`,
          `filename: "${storageKey}"`,
          `storageKey: "${storageKey}"`,
          'mimeType: "image/webp"',
        ].join('\n'),
        'utf8',
      );

      const diskRelPath = `posts/published/20261120_${articleId}-localized-ref.md`;
      const fullPath = path.join(tempDir, diskRelPath);
      const frontmatter = makeTestFrontmatter({
        id: articleId,
        title: 'Localized Ref Article',
        slug: 'localized-ref-article',
        taxonomies: { categories: ['photography'], tags: ['nature'] },
      });
      const canonicalBody = `Body content\n\n![Sample Image](${canonicalUrl})\n`;
      const localizedBody = `Body content\n\n![Sample Image](${localRef})\n`;

      // Disk carries the article-relative local spelling; baseline and sync_state carry canonical bytes.
      fs.writeFileSync(fullPath, serializeMarkdown(frontmatter, localizedBody), 'utf8');
      const staleCanonicalHash = calculateHash(serializeMarkdown(frontmatter, canonicalBody));
      const diskHash = calculateHash(serializeMarkdown(frontmatter, localizedBody));

      cache.saveBaseSnapshot(
        createBaseSnapshot({
          id: articleId,
          rev,
          bodyMarkdown: canonicalBody,
          frontmatter,
          hash: staleCanonicalHash,
        }),
      );
      cache.saveSyncState({
        id: articleId,
        localFilePath: diskRelPath,
        localHash: staleCanonicalHash,
        remoteRev: rev,
        status: 'published',
        slug: 'localized-ref-article',
        lastSyncedAt: Date.now(),
        taxonomyApplyPending: 0,
        taxonomyConflictPending: 0,
      });

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/terms/tag')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { terms: [{ slug: 'nature' }] } }),
          };
        }
        if (url.includes('/_emdash/api/content/posts')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                items: [
                  {
                    id: articleId,
                    title: 'Localized Ref Article',
                    status: 'published',
                    _rev: b64Rev4,
                    liveRevisionId: '01M77VFT000000000000000101',
                  },
                ],
                nextCursor: null,
              },
            }),
          };
        }
        return { ok: true, json: async () => ({ success: true, data: { items: [] } }) };
      });

      const result = await searchRemoteArticles({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        status: 'published',
        tag: 'nature',
        cache,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      // Sanity check: the mismatch really is spelling-only (disk bytes differ from the recorded hash).
      expect(diskHash).not.toBe(staleCanonicalHash);

      // Spelling-only mismatch is recognized as unmodified, evaluating taxonomies from baseline (0-GET fast-path).
      expect(result.hits).toHaveLength(1);
      expect(result.taxonomyFetchCount).toBe(0);
      expect(result.taxonomyCacheHitCount).toBe(1);

      // Article search is read-only: it must not re-track sync_state.local_hash as a side effect.
      expect(cache.getSyncState(articleId)!.localHash).toBe(staleCanonicalHash);
    });
  });

  describe('v0.1.44 P3: Offline Search Hint for AI Agents', () => {
    // H-1: formatArticleSearchOfflineHint returns hint on 0 hits for remote search, null for offline
    it('H-1: returns hint on remote search 0 hits and null on offline search', () => {
      const emptyResult = {
        hits: [],
        searchMode: 'scan' as const,
        scannedCount: 30,
        totalCount: null,
        walkComplete: true,
        truncated: false,
        normalizedQuery: 'nature',
        taxonomyFetchCount: 0,
        taxonomyCacheHitCount: 0,
      };

      const remoteHint = formatArticleSearchOfflineHint(emptyResult, { offline: false });
      expect(remoteHint).toContain(
        '💡 Hint: workspace-synced articles can be searched instantly with --offline',
      );

      const offlineHint = formatArticleSearchOfflineHint(emptyResult, { offline: true });
      expect(offlineHint).toBeNull();
    });

    // H-2: returns hint when truncated or walkComplete is false even with hits
    it('H-2: returns hint on truncated or incomplete walk even when hits > 0', () => {
      const truncatedResult = {
        hits: [
          {
            id: '01M77VFT000000000000000201',
            slug: 'hit-1',
            title: 'Hit 1',
            isLocal: false,
            localPath: null,
            matchedOn: ['title' as const],
          },
        ],
        searchMode: 'scan' as const,
        scannedCount: 50,
        totalCount: null,
        walkComplete: false,
        truncated: true,
        normalizedQuery: 'hit',
        taxonomyFetchCount: 0,
        taxonomyCacheHitCount: 0,
      };

      const hint = formatArticleSearchOfflineHint(truncatedResult, { offline: false });
      expect(hint).toContain(
        '💡 Hint: workspace-synced articles can be searched instantly with --offline',
      );
    });

    // H-3: MCP sync_article_search attaches hint.offlineSearch and merges note on 0-hits or truncated walks
    it('H-3: MCP sync_article_search attaches hint.offlineSearch and merges note on 0-hits or truncated walks', async () => {
      const customProfiles = path.join(tempDir, 'profiles.yaml');
      initWorkspace(tempDir, { origin: mockOrigin });
      setProfile(
        'default',
        { origin: mockOrigin, token: mockToken, workspace: tempDir },
        true,
        customProfiles,
      );

      const server = createMcpServer({
        workspaceRoot: tempDir,
        cache,
        profilesPath: customProfiles,
      });
      const registered = (
        server as unknown as {
          _registeredTools: Record<
            string,
            {
              handler: (
                args: Record<string, unknown>,
              ) => Promise<{ content: Array<{ text: string }> }>;
            }
          >;
        }
      )._registeredTools;

      // 1. Mock fetch for 0-hits search
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { items: [], nextCursor: null },
        }),
      } as Response);

      const res0 = await registered['sync_article_search'].handler({ status: 'published' });
      const payload0 = JSON.parse(res0.content[0].text);
      expect(payload0.hits).toHaveLength(0);
      expect(payload0.hint).toEqual({ offlineSearch: true, reason: 'no-hits' });
      expect(payload0.note).toContain(
        '💡 Hint: workspace-synced articles can be searched instantly with --offline',
      );

      // 2. Mock fetch for truncated walk (maxScan=1, 1 hit returned, nextCursor present -> walkComplete=false)
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            items: [
              {
                id: '01M77VFT000000000000000301',
                title: 'Article 1',
                slug: 'article-1',
                status: 'published',
                _rev: '1',
              },
            ],
            nextCursor: 'next-page-cursor',
          },
        }),
      } as Response);

      const resTruncated = await registered['sync_article_search'].handler({
        status: 'published',
        maxScan: 1,
      });
      const payloadTruncated = JSON.parse(resTruncated.content[0].text);
      expect(payloadTruncated.hits).toHaveLength(1);
      expect(payloadTruncated.walkComplete).toBe(false);
      expect(payloadTruncated.hint).toEqual({ offlineSearch: true, reason: 'walk-truncated' });
      expect(payloadTruncated.note).toContain('[WALK_INCOMPLETE]');
      expect(payloadTruncated.note).toContain(
        '💡 Hint: workspace-synced articles can be searched instantly with --offline',
      );
    });

    // H-4: includes taxonomy verification clause only when local taxonomy definitions exist
    it('H-4: omits taxonomy verification clause when local taxonomy definitions are empty', () => {
      const emptyResult = {
        hits: [],
        searchMode: 'scan' as const,
        scannedCount: 10,
        totalCount: null,
        walkComplete: true,
        truncated: false,
        normalizedQuery: '',
        taxonomyFetchCount: 0,
        taxonomyCacheHitCount: 0,
      };

      // Empty workspaceRoot with no categories or tags
      const hintNoDefs = formatArticleSearchOfflineHint(emptyResult, {
        offline: false,
        tag: 'nature',
        workspaceRoot: tempDir,
      });
      expect(hintNoDefs).not.toContain('emit pull-taxonomies');

      // Add a tag to workspaceRoot
      fs.mkdirSync(path.join(tempDir, 'tags'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'tags', '01M77VFT0000000000000000T2-tech.yaml'),
        'id: 01M77VFT0000000000000000T2\nslug: tech\nname: Tech\n',
      );

      const hintWithDefs = formatArticleSearchOfflineHint(emptyResult, {
        offline: false,
        tag: 'nature',
        workspaceRoot: tempDir,
      });
      expect(hintWithDefs).toContain('emit pull-taxonomies');
    });
  });
});
