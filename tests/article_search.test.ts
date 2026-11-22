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
import { readTaxonomiesFromBaseline } from '../src/sync/article_search/remote.js';
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
import { getWorkspaceStatus } from '../src/sync/status.js';
import { parseMarkdownLenient, serializeMarkdown } from '../src/utils/frontmatter.js';
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
      `---\nid: 01M77VFT000000000000000003\nslug: local-file\ntitle: Local File\nstatus: published\n---\nLocal body`,
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
      `---\nid: 01M77VFT000000000000000091\nslug: sunset-view\ntitle: Sunset View\nstatus: published\n---\nMagnificent golden hour in Kyoto.`,
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
      `---\nid: 01M77VFT000000000000000099\nslug: quarantined-conflict\ntitle: Quarantined Conflict\nstatus: draft\n---\nQuarantined text`,
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

      // v0.1.49 P1: When a snapshot exists, MCP hint attaches snapshotArticles and payload.snapshot
      cache.saveSnapshotMeta({
        collection: 'posts',
        capturedAt: Date.now(),
        articleCount: 763,
        mediaCount: 0,
        taxonomyFetchedCount: 0,
        taxonomyReusedCount: 0,
        articleSingleGetCount: 0,
        durationMs: 10,
      });
      const resWithSnap = await registered['sync_article_search'].handler({
        status: 'published',
        maxScan: 1,
      });
      const payloadWithSnap = JSON.parse(resWithSnap.content[0].text);
      expect(payloadWithSnap.snapshot?.articleCount).toBe(763);
      expect(payloadWithSnap.hint).toMatchObject({
        offlineSearch: true,
        reason: 'walk-truncated',
        snapshotArticles: 763,
      });
      expect(payloadWithSnap.note).toContain('the full library snapshot (763 articles @');
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

  describe('v0.1.45 P4: parseMarkdownLenient() & Diagnostic Alignment', () => {
    const tempDirs: string[] = [];
    afterEach(() => {
      for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      tempDirs.length = 0;
    });

    it('F-1 & F-2: leniently repairs unquoted percent-encoded taxonomies so offline search hits and aligns with status', () => {
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-lenient-search-'));
      tempDirs.push(wsDir);
      initWorkspace(wsDir, { origin: 'https://emdash.test' });
      const wsCache = new CacheDatabase(path.join(wsDir, '.emit', 'cache.db'));

      try {
        const draftDir = path.join(wsDir, 'posts', 'draft');
        fs.mkdirSync(draftDir, { recursive: true });
        const articleUlid = '01M77VFT000000000000000901';
        const unquotedBrokenContent = [
          '---',
          `id: ${articleUlid}`,
          'slug: broken-percent-slug',
          'title: Broken Percent Article',
          'status: draft',
          'taxonomies:',
          '  tags:',
          '    - %e3%82%ab%e3%83%a1%e3%83%a9',
          '---',
          '',
          'Findable body keyword: supercalifragilistic.',
        ].join('\n');

        const filePath = path.join(draftDir, `20261121_${articleUlid}-broken-percent-slug.md`);
        fs.writeFileSync(filePath, unquotedBrokenContent, 'utf8');

        // F-1: parseMarkdownLenient returns non-null and offline search hits the article
        const parsed = parseMarkdownLenient(unquotedBrokenContent, filePath);
        expect(parsed).not.toBeNull();
        expect(parsed!.frontmatter.taxonomies.tags).toEqual(['%e3%82%ab%e3%83%a1%e3%83%a9']);

        const searchRes = searchLocalArticles({
          workspaceRoot: wsDir,
          origin: mockOrigin,
          query: 'supercalifragilistic',
          cache: wsCache,
        });
        expect(searchRes.hits).toHaveLength(1);
        expect(searchRes.hits[0].id).toBe(articleUlid);

        // F-2: getWorkspaceStatus agrees the file is invalid and healable: true
        const statusRes = getWorkspaceStatus(wsDir, wsCache);
        const item = statusRes.items.find((i) => i.id === articleUlid);
        expect(item).toBeDefined();
        expect(item!.syncStatus).toBe('invalid');
        expect(item!.healable).toBe(true);
      } finally {
        wsCache.close();
      }
    });

    it('F-3: returns null for completely invalid YAML and search skips it gracefully', () => {
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-lenient-invalid-'));
      tempDirs.push(wsDir);
      initWorkspace(wsDir, { origin: 'https://emdash.test' });
      const wsCache = new CacheDatabase(path.join(wsDir, '.emit', 'cache.db'));

      try {
        const draftDir = path.join(wsDir, 'posts', 'draft');
        fs.mkdirSync(draftDir, { recursive: true });
        const brokenContent = '---\nid: [unclosed\n---\n\nUnsearchable body keyword: xyzzy.';
        const filePath = path.join(draftDir, '20261121_01M77VFT000000000000000902-broken.md');
        fs.writeFileSync(filePath, brokenContent, 'utf8');

        expect(parseMarkdownLenient(brokenContent, filePath)).toBeNull();

        const searchRes = searchLocalArticles({
          workspaceRoot: wsDir,
          origin: mockOrigin,
          query: 'xyzzy',
          cache: wsCache,
        });
        expect(searchRes.hits).toHaveLength(0);
      } finally {
        wsCache.close();
      }
    });
  });

  describe('v0.1.45 P6: readTaxonomiesFromBaseline() precondition unit tests', () => {
    const itemId = '01M77VFT000000000000000950';
    const rev = '1@live:01M77VFT0000000000000000L1';
    const b64Rev1 = Buffer.from('1:2026-11-20T00:00:00.000Z').toString('base64');
    const remoteItem = {
      id: itemId,
      _rev: b64Rev1,
      liveRevisionId: '01M77VFT0000000000000000L1',
    };

    const tempDirs: string[] = [];
    afterEach(() => {
      for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      tempDirs.length = 0;
    });

    function setupSyncedWorkspace() {
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-baseline-tax-'));
      tempDirs.push(wsDir);
      initWorkspace(wsDir, { origin: mockOrigin });
      const wsCache = new CacheDatabase(path.join(wsDir, '.emit', 'cache.db'));
      const relPath = `posts/published/20261121_${itemId}-tax-test.md`;
      fs.mkdirSync(path.join(wsDir, 'posts', 'published'), { recursive: true });

      const fm = makeTestFrontmatter({
        id: itemId,
        slug: 'tax-test',
        title: 'Tax Test',
        status: 'published',
        taxonomies: { categories: ['tech'], tags: ['vitest'] },
      });
      const content = serializeMarkdown(fm, 'Body text\n');
      fs.writeFileSync(path.join(wsDir, relPath), content, 'utf8');
      const hash = calculateHash(content);

      wsCache.saveBaseSnapshot(
        createBaseSnapshot({
          id: itemId,
          rev,
          bodyMarkdown: 'Body text\n',
          frontmatter: fm,
          hash,
        }),
      );
      wsCache.saveSyncState({
        id: itemId,
        localFilePath: relPath,
        localHash: hash,
        remoteRev: rev,
        status: 'published',
        slug: 'tax-test',
        lastSyncedAt: Date.now(),
        taxonomyApplyPending: 0,
        taxonomyConflictPending: 0,
      });

      return { wsDir, wsCache, relPath, fm, hash };
    }

    it('T-1: returns no-cache when cache is missing or item is untracked', () => {
      const { wsDir, wsCache } = setupSyncedWorkspace();
      try {
        expect(
          readTaxonomiesFromBaseline({
            cache: undefined,
            itemId,
            item: remoteItem,
            workspaceRoot: wsDir,
          }),
        ).toEqual({ terms: null, reason: 'no-cache' });

        expect(
          readTaxonomiesFromBaseline({
            cache: wsCache,
            itemId: '01M77VFT000000000000000999',
            item: remoteItem,
            workspaceRoot: wsDir,
          }),
        ).toEqual({ terms: null, reason: 'no-cache' });
      } finally {
        wsCache.close();
      }
    });

    it('T-2: returns pending-flag when any of the 4 pending flags is set', () => {
      const { wsDir, wsCache, relPath, hash } = setupSyncedWorkspace();
      try {
        for (const flag of [
          { deletePending: 1 },
          { bodyConflictPending: 1 },
          { taxonomyApplyPending: 1 },
          { taxonomyConflictPending: 1 },
        ]) {
          wsCache.saveSyncState({
            id: itemId,
            localFilePath: relPath,
            localHash: hash,
            remoteRev: rev,
            status: 'published',
            slug: 'tax-test',
            lastSyncedAt: Date.now(),
            deletePending: 0,
            bodyConflictPending: 0,
            taxonomyApplyPending: 0,
            taxonomyConflictPending: 0,
            ...flag,
          });
          expect(
            readTaxonomiesFromBaseline({
              cache: wsCache,
              itemId,
              item: remoteItem,
              workspaceRoot: wsDir,
            }),
          ).toEqual({ terms: null, reason: 'pending-flag' });
        }
      } finally {
        wsCache.close();
      }
    });

    it('T-3: returns rev-mismatch when remote revision differs', () => {
      const { wsDir, wsCache } = setupSyncedWorkspace();
      try {
        const b64Rev2 = Buffer.from('2:2026-11-21T00:00:00.000Z').toString('base64');
        expect(
          readTaxonomiesFromBaseline({
            cache: wsCache,
            itemId,
            item: { id: itemId, _rev: b64Rev2, liveRevisionId: '01M77VFT0000000000000000L2' },
            workspaceRoot: wsDir,
          }),
        ).toEqual({ terms: null, reason: 'rev-mismatch' });
      } finally {
        wsCache.close();
      }
    });

    it('T-4: returns disk-modified when local file has unpushed edits', () => {
      const { wsDir, wsCache, relPath } = setupSyncedWorkspace();
      try {
        fs.writeFileSync(path.join(wsDir, relPath), 'Modified local content', 'utf8');
        expect(
          readTaxonomiesFromBaseline({
            cache: wsCache,
            itemId,
            item: remoteItem,
            workspaceRoot: wsDir,
          }),
        ).toEqual({ terms: null, reason: 'disk-modified' });
      } finally {
        wsCache.close();
      }
    });

    it('T-5: returns no-snapshot when base_snapshot is absent', () => {
      const { wsDir, wsCache } = setupSyncedWorkspace();
      try {
        wsCache.deleteBaseSnapshot(itemId);
        expect(
          readTaxonomiesFromBaseline({
            cache: wsCache,
            itemId,
            item: remoteItem,
            workspaceRoot: wsDir,
          }),
        ).toEqual({ terms: null, reason: 'no-snapshot' });
      } finally {
        wsCache.close();
      }
    });

    it('T-6: returns no-recorded-taxonomies for legacy snapshot lacking taxonomies', () => {
      const { wsDir, wsCache, fm, hash } = setupSyncedWorkspace();
      try {
        const legacyFm = { ...fm } as Record<string, unknown>;
        delete legacyFm.taxonomies;
        wsCache.saveBaseSnapshot({
          id: itemId,
          rev,
          bodyMarkdown: 'Body text\n',
          frontmatterYaml: JSON.stringify(legacyFm),
          hash,
          savedAt: Date.now(),
        });
        expect(
          readTaxonomiesFromBaseline({
            cache: wsCache,
            itemId,
            item: remoteItem,
            workspaceRoot: wsDir,
          }),
        ).toEqual({ terms: null, reason: 'no-recorded-taxonomies' });
      } finally {
        wsCache.close();
      }
    });

    it('T-7 & T-8: returns cache-hit with terms and never mutates sync_state.local_hash on spelling-only mismatch', () => {
      const { wsDir, wsCache, relPath, fm } = setupSyncedWorkspace();
      try {
        // Seed media mirror so localization spelling differs from canonical
        const storageKeyStem = '01M67P2N0A44G4KHK6QZZGMRW7';
        const storageKey = `${storageKeyStem}.webp`;
        fs.mkdirSync(path.join(wsDir, 'media'), { recursive: true });
        fs.writeFileSync(path.join(wsDir, 'media', storageKey), 'webp');
        fs.writeFileSync(
          path.join(wsDir, 'media', `${storageKeyStem}.yaml`),
          `id: "01M67PG2WTXPEJVMS4W5N3FC48"\nfilename: "${storageKey}"\nstorageKey: "${storageKey}"\nmimeType: "image/webp"\n`,
        );

        const canonicalBody = `Body\n\n![Img](/_emdash/api/media/file/${storageKey})\n`;
        const localBody = `Body\n\n![Img](../../media/${storageKey})\n`;
        const canonicalHash = calculateHash(serializeMarkdown(fm, canonicalBody));
        fs.writeFileSync(path.join(wsDir, relPath), serializeMarkdown(fm, localBody), 'utf8');

        wsCache.saveBaseSnapshot(
          createBaseSnapshot({
            id: itemId,
            rev,
            bodyMarkdown: canonicalBody,
            frontmatter: fm,
            hash: canonicalHash,
          }),
        );
        wsCache.saveSyncState({
          id: itemId,
          localFilePath: relPath,
          localHash: canonicalHash,
          remoteRev: rev,
          status: 'published',
          slug: 'tax-test',
          lastSyncedAt: Date.now(),
          taxonomyApplyPending: 0,
          taxonomyConflictPending: 0,
        });

        const res = readTaxonomiesFromBaseline({
          cache: wsCache,
          itemId,
          item: remoteItem,
          workspaceRoot: wsDir,
        });
        expect(res).toEqual({
          terms: { categories: ['tech'], tags: ['vitest'] },
          reason: 'cache-hit',
        });
        expect(wsCache.getSyncState(itemId)!.localHash).toBe(canonicalHash);
      } finally {
        wsCache.close();
      }
    });
  });

  describe('v0.1.45 P7: clampSearchLimit() shared search limit bounds', () => {
    it('L-1: clamps undefined to 20, <= 0 to 1, and > 50 to 50', async () => {
      const { clampSearchLimit } = await import('../src/utils/search-options.js');
      expect(clampSearchLimit(undefined)).toBe(20);
      expect(clampSearchLimit(0)).toBe(1);
      expect(clampSearchLimit(-5)).toBe(1);
      expect(clampSearchLimit(999)).toBe(50);
      expect(clampSearchLimit(25)).toBe(25);
    });
  });

  describe('v0.1.47: Snapshot integration in offline & taxonomy search', () => {
    it('merges snapshot-only articles in offline search, gives disk precedence, and excludes list-stale body from keyword match', async () => {
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-art-snap-'));
      fs.mkdirSync(path.join(wsDir, '.emit'), { recursive: true });
      fs.mkdirSync(path.join(wsDir, 'posts', 'published'), { recursive: true });
      const wsCache = new CacheDatabase(path.join(wsDir, '.emit', 'cache.db'));
      try {
        const diskId = '01KNGD5W934R00000000000001';
        fs.writeFileSync(
          path.join(wsDir, 'posts', 'published', `20260101_${diskId}-disk.md`),
          `---\nid: ${diskId}\nslug: disk-post\ntitle: Disk Version Title\nstatus: published\n---\n\nDisk body\n`,
          'utf8',
        );

        const snapFreshId = '01KNGD5W934R00000000000002';
        const snapStaleId = '01KNGD5W934R00000000000003';
        const oldCapturedAt = Date.now() - 8 * 86_400_000;
        wsCache.saveSnapshotMeta({
          collection: 'posts',
          capturedAt: oldCapturedAt,
          articleCount: 3,
          mediaCount: 0,
          taxonomyFetchedCount: 0,
          taxonomyReusedCount: 0,
          articleSingleGetCount: 0,
          durationMs: 10,
        });
        wsCache.upsertSnapshotArticlesBatch({
          collection: 'posts',
          walkComplete: true,
          records: [
            {
              id: diskId,
              collection: 'posts',
              slug: 'disk-post',
              title: 'Snapshot Stale Duplicate',
              status: 'published',
              excerpt: null,
              bodyMarkdown: 'Body',
              bodySource: 'list-live',
              taxonomyVerified: 1,
              categoriesJson: '[]',
              tagsJson: '[]',
              publishedAt: '2026-01-01T00:00:00.000Z',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              comparisonRev: '1@live:rev1',
              capturedAt: oldCapturedAt,
            },
            {
              id: snapFreshId,
              collection: 'posts',
              slug: 'snap-fresh',
              title: 'Snapshot Camera Guide',
              status: 'published',
              excerpt: 'Lens overview',
              bodyMarkdown: 'Full mirrorless body token',
              bodySource: 'list-live',
              taxonomyVerified: 1,
              categoriesJson: '["tech"]',
              tagsJson: '["camera"]',
              publishedAt: '2026-01-02T00:00:00.000Z',
              createdAt: '2026-01-02T00:00:00.000Z',
              updatedAt: '2026-01-02T00:00:00.000Z',
              comparisonRev: '1@live:rev2',
              capturedAt: oldCapturedAt,
            },
            {
              id: snapStaleId,
              collection: 'posts',
              slug: 'snap-stale',
              title: 'Unverified Draft Title',
              status: 'draft',
              excerpt: null,
              bodyMarkdown: 'hidden-stale-body-keyword',
              bodySource: 'list-stale',
              taxonomyVerified: 0,
              categoriesJson: '[]',
              tagsJson: '[]',
              publishedAt: null,
              createdAt: '2026-01-03T00:00:00.000Z',
              updatedAt: '2026-01-03T00:00:00.000Z',
              comparisonRev: '1@draft:rev3',
              capturedAt: oldCapturedAt,
            },
          ],
        });

        // 1. Body keyword in list-stale must NOT match
        const staleBodyRes = searchLocalArticles({
          query: 'hidden-stale-body-keyword',
          offline: true,
          origin: 'https://example.com',
          workspaceRoot: wsDir,
          cache: wsCache,
        });
        expect(staleBodyRes.hits).toHaveLength(0);
        expect(staleBodyRes.snapshot?.stale).toBe(true);

        // 2. Title match on list-stale carries bodyUnverified: true
        const staleTitleRes = searchLocalArticles({
          query: 'Unverified Draft',
          offline: true,
          origin: 'https://example.com',
          workspaceRoot: wsDir,
          cache: wsCache,
        });
        expect(staleTitleRes.hits).toHaveLength(1);
        expect(staleTitleRes.hits[0].fromSnapshot).toBe(true);
        expect(staleTitleRes.hits[0].bodyUnverified).toBe(true);

        // 3. Disk precedence & snapshot-only hit
        const allRes = searchLocalArticles({
          offline: true,
          origin: 'https://example.com',
          workspaceRoot: wsDir,
          cache: wsCache,
        });
        expect(allRes.hits.map((h) => h.id)).toEqual([snapStaleId, snapFreshId, diskId]);
        expect(allRes.hits.find((h) => h.id === diskId)?.title).toBe('Disk Version Title');
        expect(allRes.hits.find((h) => h.id === diskId)?.fromSnapshot).toBeUndefined();

        const { formatArticleSearchHeader, formatArticleSearchHit } =
          await import('../src/presentation/article_report.js');
        const header = formatArticleSearchHeader(allRes, { offline: true });
        expect(header).toContain('STALE_SNAPSHOT');
        expect(formatArticleSearchHit(staleTitleRes.hits[0], 0)).toContain(
          '[snapshot] [body unverified]',
        );
      } finally {
        wsCache.close();
        fs.rmSync(wsDir, { recursive: true, force: true });
      }
    });

    it('uses snapshot-hit in readTaxonomiesFromBaseline only when taxonomyVerified === 1 and rev matches', () => {
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-tax-snap-'));
      fs.mkdirSync(path.join(wsDir, '.emit'), { recursive: true });
      const wsCache = new CacheDatabase(path.join(wsDir, '.emit', 'cache.db'));
      try {
        const verifiedId = '01KNGD5W934R00000000000010';
        const unverifiedId = '01KNGD5W934R00000000000011';
        wsCache.upsertSnapshotArticlesBatch({
          collection: 'posts',
          walkComplete: true,
          records: [
            {
              id: verifiedId,
              collection: 'posts',
              slug: 'v',
              title: 'V',
              status: 'published',
              excerpt: null,
              bodyMarkdown: 'b',
              bodySource: 'list-live',
              taxonomyVerified: 1,
              categoriesJson: '["news"]',
              tagsJson: '["alpha"]',
              publishedAt: '2026-01-01T00:00:00.000Z',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              comparisonRev: '2@live:live2',
              capturedAt: Date.now(),
            },
            {
              id: unverifiedId,
              collection: 'posts',
              slug: 'u',
              title: 'U',
              status: 'published',
              excerpt: null,
              bodyMarkdown: 'b',
              bodySource: 'list-live',
              taxonomyVerified: 0,
              categoriesJson: '["news"]',
              tagsJson: '["beta"]',
              publishedAt: '2026-01-01T00:00:00.000Z',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              comparisonRev: '2@live:live2',
              capturedAt: Date.now(),
            },
          ],
        });

        const hit = readTaxonomiesFromBaseline({
          cache: wsCache,
          itemId: verifiedId,
          item: { id: verifiedId, status: 'published', version: 2, liveRevisionId: 'live2' },
          workspaceRoot: wsDir,
        });
        expect(hit).toEqual({
          terms: { categories: ['news'], tags: ['alpha'] },
          reason: 'snapshot-hit',
        });

        const missUnverified = readTaxonomiesFromBaseline({
          cache: wsCache,
          itemId: unverifiedId,
          item: { id: unverifiedId, status: 'published', version: 2, liveRevisionId: 'live2' },
          workspaceRoot: wsDir,
        });
        expect(missUnverified.terms).toBeNull();
      } finally {
        wsCache.close();
        fs.rmSync(wsDir, { recursive: true, force: true });
      }
    });
  });

  describe('v0.1.49: FTS snapshot enrichment, offline hint, and hit-limit notice', () => {
    it('E-1, E-1b, E-2, E-3, E-4, E-5: enriches FTS hits from snapshot with rev verification and preserves backward compatibility without snapshot', async () => {
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-fts-enrich-'));
      fs.mkdirSync(path.join(wsDir, '.emit'), { recursive: true });
      const wsCache = new CacheDatabase(path.join(wsDir, '.emit', 'cache.db'));
      try {
        const hitSnapNoRevId = '01KNGD5W934R00000000000101';
        const hitNoSnapId = '01KNGD5W934R00000000000102';
        const hitRevMatchId = '01KNGD5W934R00000000000103';
        const hitRevMismatchId = '01KNGD5W934R00000000000104';

        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              items: [
                { id: hitSnapNoRevId, slug: 'a', title: 'Alpha', snippet: 's1' },
                { id: hitNoSnapId, slug: 'b', title: 'Beta', snippet: 's2' },
                {
                  id: hitRevMatchId,
                  slug: 'c',
                  title: 'Gamma',
                  snippet: 's3',
                  _rev: '2@live:live2',
                },
                {
                  id: hitRevMismatchId,
                  slug: 'd',
                  title: 'Delta',
                  snippet: 's4',
                  _rev: '9@live:live9',
                },
              ],
              nextCursor: 'cursor-2',
            },
          }),
        });

        // E-2 & E-3: No snapshot -> no enrichment, no result.snapshot key
        const noSnapRes = await searchRemoteArticles({
          query: 'Alpha',
          origin: 'https://example.com',
          token: 'tok',
          fetchFn: mockFetch as unknown as typeof fetch,
          workspaceRoot: wsDir,
          cache: wsCache,
          limit: 4,
        });
        expect('snapshot' in noSnapRes).toBe(false);
        expect(noSnapRes.snapshotEnrichedCount).toBeUndefined();
        const { formatArticleSearchHit } = await import('../src/presentation/article_report.js');
        expect(formatArticleSearchHit(noSnapRes.hits[0], 0)).toContain(
          '---- [unknown] Alpha (id: 01KNGD5W934R00000000000101) [remote only]',
        );

        // Populate snapshot_meta + snapshot_articles
        const now = Date.now();
        wsCache.saveSnapshotMeta({
          collection: 'posts',
          capturedAt: now,
          articleCount: 763,
          mediaCount: 0,
          taxonomyFetchedCount: 0,
          taxonomyReusedCount: 0,
          articleSingleGetCount: 0,
          durationMs: 15,
        });
        wsCache.upsertSnapshotArticlesBatch({
          collection: 'posts',
          walkComplete: true,
          records: [
            {
              id: hitSnapNoRevId,
              collection: 'posts',
              slug: 'a',
              title: 'Alpha',
              status: 'published',
              excerpt: null,
              bodyMarkdown: 'body',
              bodySource: 'list-live',
              taxonomyVerified: 1,
              categoriesJson: '[]',
              tagsJson: '[]',
              publishedAt: '2023-03-09T10:00:00.000Z',
              createdAt: '2023-03-08T10:00:00.000Z',
              updatedAt: '2023-03-09T10:00:00.000Z',
              comparisonRev: '1@live:live1',
              capturedAt: now,
            },
            {
              id: hitRevMatchId,
              collection: 'posts',
              slug: 'c',
              title: 'Gamma',
              status: 'published',
              excerpt: null,
              bodyMarkdown: 'body',
              bodySource: 'list-live',
              taxonomyVerified: 1,
              categoriesJson: '[]',
              tagsJson: '[]',
              publishedAt: '2024-05-01T10:00:00.000Z',
              createdAt: '2024-05-01T10:00:00.000Z',
              updatedAt: '2024-05-01T10:00:00.000Z',
              comparisonRev: '2@live:live2',
              capturedAt: now,
            },
            {
              id: hitRevMismatchId,
              collection: 'posts',
              slug: 'd',
              title: 'Delta',
              status: 'draft',
              excerpt: null,
              bodyMarkdown: 'body',
              bodySource: 'single-get',
              taxonomyVerified: 1,
              categoriesJson: '[]',
              tagsJson: '[]',
              publishedAt: null,
              createdAt: '2025-01-15T10:00:00.000Z',
              updatedAt: '2025-01-15T10:00:00.000Z',
              comparisonRev: '1@draft:d1',
              capturedAt: now,
            },
          ],
        });

        mockFetch.mockClear();
        const enrichedRes = await searchRemoteArticles({
          query: 'Alpha',
          origin: 'https://example.com',
          token: 'tok',
          fetchFn: mockFetch as unknown as typeof fetch,
          workspaceRoot: wsDir,
          cache: wsCache,
          limit: 4,
        });

        // E-3: Zero extra HTTP calls
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(enrichedRes.snapshotEnrichedCount).toBe(3);
        expect(enrichedRes.snapshot?.articleCount).toBe(763);

        // L-3: FTS nextCursor + limit keeps walkComplete: false (because nextCursor is set) & truncated: true
        expect(enrichedRes.truncated).toBe(true);
        expect(enrichedRes.walkComplete).toBe(false);

        // E-1: no rev candidate -> unverified
        expect(enrichedRes.hits[0].enrichedFromSnapshot).toBe(true);
        expect(enrichedRes.hits[0].enrichmentStale).toBe(true);
        expect(formatArticleSearchHit(enrichedRes.hits[0], 0)).toContain(
          '2023-03-09 [published] Alpha (id: 01KNGD5W934R00000000000101) [remote only] [enriched: snapshot (unverified)]',
        );

        // E-2: no snapshot row -> unchanged
        expect(enrichedRes.hits[1].enrichedFromSnapshot).toBeUndefined();
        expect(formatArticleSearchHit(enrichedRes.hits[1], 1)).toContain(
          '---- [unknown] Beta (id: 01KNGD5W934R00000000000102) [remote only]',
        );

        // E-1b: matching rev -> verified (no unverified suffix)
        expect(enrichedRes.hits[2].enrichedFromSnapshot).toBe(true);
        expect(enrichedRes.hits[2].enrichmentStale).toBeUndefined();
        expect(formatArticleSearchHit(enrichedRes.hits[2], 2)).toContain(
          '2024-05-01 [published] Gamma (id: 01KNGD5W934R00000000000103) [remote only] [enriched: snapshot]',
        );
        expect(formatArticleSearchHit(enrichedRes.hits[2], 2)).not.toContain('(unverified)');

        // E-1b / E-3: mismatched rev -> unverified
        expect(enrichedRes.hits[3].enrichedFromSnapshot).toBe(true);
        expect(enrichedRes.hits[3].enrichmentStale).toBe(true);

        // E-5: read-only enrichment never mutates sync_state or base_snapshots
        expect(wsCache.getSyncState(hitSnapNoRevId)).toBeNull();
        expect(wsCache.getBaseSnapshot(hitSnapNoRevId)).toBeNull();
      } finally {
        wsCache.close();
        fs.rmSync(wsDir, { recursive: true, force: true });
      }
    });

    it('H-1, H-2, L-1, L-2, L-3: formats snapshot-aware offline hint and scan hit-limit notice', async () => {
      const { formatArticleSearchOfflineHint, formatArticleSearchWalkIncompleteNotice } =
        await import('../src/presentation/article_report.js');

      const freshSnap = {
        capturedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        ageDays: 2,
        stale: false,
        articleCount: 763,
      };
      const staleSnap = {
        capturedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        ageDays: 10,
        stale: true,
        articleCount: 763,
      };

      const baseEmptyResult = {
        hits: [],
        searchMode: 'scan' as const,
        scannedCount: 50,
        totalCount: null,
        walkComplete: false,
        truncated: false,
        normalizedQuery: 'q',
        taxonomyFetchCount: 0,
        taxonomyCacheHitCount: 0,
      };

      // H-1 & H-2
      const freshHint = formatArticleSearchOfflineHint({
        ...baseEmptyResult,
        snapshot: freshSnap,
      });
      expect(freshHint).toContain('the full library snapshot (763 articles @');
      expect(freshHint).not.toContain('stale snapshot');

      const staleHint = formatArticleSearchOfflineHint({
        ...baseEmptyResult,
        snapshot: staleSnap,
      });
      expect(staleHint).toContain('⚠️ stale snapshot (>7d): run emit snapshot first.');

      // L-1: scan path hit-limit at limit=3
      const hitLimitRes = {
        ...baseEmptyResult,
        hits: [
          {
            id: '1',
            slug: '1',
            title: '1',
            isLocal: false,
            localPath: null,
            matchedOn: ['recency' as const],
          },
          {
            id: '2',
            slug: '2',
            title: '2',
            isLocal: false,
            localPath: null,
            matchedOn: ['recency' as const],
          },
          {
            id: '3',
            slug: '3',
            title: '3',
            isLocal: false,
            localPath: null,
            matchedOn: ['recency' as const],
          },
        ],
        truncated: true,
      };
      const cliNotice = formatArticleSearchWalkIncompleteNotice(hitLimitRes, {
        limit: 3,
        isMcp: false,
      });
      expect(cliNotice).toContain('[WALK_INCOMPLETE]');
      expect(cliNotice).toContain(
        'Hit limit reached at 3; raise --limit to see more matches from the same walk.',
      );

      // L-2: stopped at maxScan without hitting limit -> no hit-limit line
      const maxScanOnlyNotice = formatArticleSearchWalkIncompleteNotice(baseEmptyResult, {
        limit: 20,
        isMcp: false,
      });
      expect(maxScanOnlyNotice).toContain('[WALK_INCOMPLETE]');
      expect(maxScanOnlyNotice).not.toContain('Hit limit reached');

      // L-3: complete walk -> null notice
      expect(
        formatArticleSearchWalkIncompleteNotice(
          { ...hitLimitRes, walkComplete: true, searchMode: 'fts' },
          { limit: 3, isMcp: false },
        ),
      ).toBeNull();
    });

    it('v0.1.50 (#3): routes query + status to scan path so --status draft never returns published articles', async () => {
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-status-scan-'));
      fs.mkdirSync(path.join(wsDir, '.emit'), { recursive: true });
      const wsCache = new CacheDatabase(path.join(wsDir, '.emit', 'cache.db'));
      try {
        const requestedUrls: string[] = [];
        const mockFetch = vi.fn().mockImplementation(async (urlStr: string) => {
          requestedUrls.push(urlStr);
          if (urlStr.includes('/_emdash/api/search')) {
            throw new Error('FTS endpoint must NOT be called when status is specified');
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                items: [
                  {
                    id: '01KNGD5W934R00000000000201',
                    slug: 'ai-draft-post',
                    title: 'AI執筆の下書きメモ',
                    status: 'draft',
                    createdAt: '2026-05-01T00:00:00.000Z',
                    updatedAt: '2026-05-01T00:00:00.000Z',
                    publishedAt: null,
                    data: { title: 'AI執筆の下書きメモ', content: [] },
                  },
                ],
                nextCursor: null,
              },
            }),
          };
        });

        const res = await searchRemoteArticles({
          query: 'AI執筆',
          status: 'draft',
          origin: 'https://example.com',
          token: 'tok',
          fetchFn: mockFetch as unknown as typeof fetch,
          workspaceRoot: wsDir,
          cache: wsCache,
        });

        expect(res.searchMode).toBe('scan');
        expect(requestedUrls.some((u) => u.includes('/_emdash/api/search'))).toBe(false);
        expect(requestedUrls.every((u) => u.includes('status=draft'))).toBe(true);
        expect(res.hits).toHaveLength(1);
        expect(res.hits[0].status).toBe('draft');
      } finally {
        wsCache.close();
        fs.rmSync(wsDir, { recursive: true, force: true });
      }
    });
  });
});
