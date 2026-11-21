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
  formatArticleSearchWalkIncompleteNotice,
  OFFLINE_ARTICLE_SEARCH_EMPTY_NOTICE,
} from '../src/presentation/article_report.js';
import { ApiError } from '../src/client/error.js';

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
});
