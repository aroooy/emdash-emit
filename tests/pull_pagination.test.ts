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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getRemoteMaxBatchLimit, listRemoteArticles, pullArticle } from '../src/sync/pull.js';
import { CacheDatabase } from '../src/db/cache.js';

describe('Pull Pagination & Dynamic Limit Engine', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-pull-page-'));
    cache = new CacheDatabase(path.join(tempDir, 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('discovers maximum limit from openapi.json dynamically', async () => {
    const mockOpenApi = {
      paths: {
        '/_emdash/api/content/{collection}': {
          get: {
            parameters: [
              {
                name: 'limit',
                schema: {
                  maximum: 100,
                  default: 50,
                },
              },
            ],
          },
        },
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockOpenApi,
    });

    const maxLimit = await getRemoteMaxBatchLimit({
      origin: 'https://example.com',
      token: 'fake-token',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(maxLimit).toBe(100);
  });

  it('pages across multiple cursors to satisfy requested limit', async () => {
    // 250 requested, server max limit is 100. Should require 3 pages: 100, 100, 50.
    const mockFetch = vi.fn().mockImplementation((urlStr: string) => {
      const url = new URL(urlStr);
      if (url.pathname === '/_emdash/api/openapi.json') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            paths: {
              '/_emdash/api/content/{collection}': {
                get: { parameters: [{ name: 'limit', schema: { maximum: 100 } }] },
              },
            },
          }),
        });
      }

      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const cursor = url.searchParams.get('cursor');

      if (!cursor) {
        // Page 1: 100 items
        const items = Array.from({ length: limit }, (_, i) => ({
          id: `01M67MP2W0VKCK2DFWM166CR${String(i).padStart(2, '0')}`,
          slug: `post-${i}`,
          data: { title: `Post ${i}`, content: [] },
          _rev: 'rev_1',
        }));
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { items, nextCursor: 'cursor_page_2' } }),
        });
      }

      if (cursor === 'cursor_page_2') {
        // Page 2: 100 items
        const items = Array.from({ length: limit }, (_, i) => ({
          id: `01M67MP2W0VKCK2DFWM166CR${String(100 + i).padStart(2, '0')}`,
          slug: `post-${100 + i}`,
          data: { title: `Post ${100 + i}`, content: [] },
          _rev: 'rev_1',
        }));
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { items, nextCursor: 'cursor_page_3' } }),
        });
      }

      if (cursor === 'cursor_page_3') {
        // Page 3: 50 items (reaches 250)
        const items = Array.from({ length: limit }, (_, i) => ({
          id: `01M67MP2W0VKCK2DFWM166CR${String(200 + i).padStart(2, '0')}`,
          slug: `post-${200 + i}`,
          data: { title: `Post ${200 + i}`, content: [] },
          _rev: 'rev_1',
        }));
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { items, nextCursor: 'cursor_page_4' } }),
        });
      }

      return Promise.reject(new Error('Unexpected fetch call'));
    });

    const articles = await listRemoteArticles('posts', {
      origin: 'https://example.com',
      token: 'fake-token',
      limit: 250,
      status: 'published',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(articles.length).toBe(250);
    expect(articles[0].slug).toBe('post-0');
    expect(articles[249].slug).toBe('post-249');
  });

  it('pulls both draft and published articles in parallel up to limit each', async () => {
    const mockFetch = vi.fn().mockImplementation((urlStr: string) => {
      const url = new URL(urlStr);
      if (url.pathname === '/_emdash/api/openapi.json') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            paths: {
              '/_emdash/api/content/{collection}': {
                get: { parameters: [{ name: 'limit', schema: { maximum: 100 } }] },
              },
            },
          }),
        });
      }

      const status = url.searchParams.get('status');
      const items = [
        {
          id: `01M67MP2W0VKCK2DFWM166CR${status === 'draft' ? '01' : '02'}`,
          slug: `${status}-article`,
          status: status || 'draft',
          data: { title: `${status} Article`, content: [] },
          _rev: 'rev_1',
        },
      ];

      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { items, nextCursor: null } }),
      });
    });

    const articles = await listRemoteArticles('posts', {
      origin: 'https://example.com',
      token: 'fake-token',
      limit: 10,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(articles.length).toBe(2);
    expect(articles.some((a) => a.status === 'draft')).toBe(true);
    expect(articles.some((a) => a.status === 'published')).toBe(true);
  });

  it('implements differential skip when remote rev and local hash match', async () => {
    const validUlid = '01M67MP2W0VKCK2DFWM166CR24';
    const mockRawItem = {
      id: validUlid,
      slug: 'test-skip-article',
      status: 'draft',
      _rev: 'rev_v1',
      data: {
        title: 'Skip Test Article',
        content: [
          {
            _type: 'block',
            style: 'normal',
            children: [{ _type: 'span', text: 'Initial remote body' }],
          },
        ],
      },
    };

    // 1. Initial pull
    const res1 = await pullArticle('posts', validUlid, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      rawItem: mockRawItem,
    });

    expect(res1.updated).toBe(true);
    expect(res1.skipped).toBeFalsy();

    // 2. Second pull with identical rawItem
    const res2 = await pullArticle('posts', validUlid, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      rawItem: mockRawItem,
    });

    expect(res2.updated).toBe(false);
    expect(res2.skipped).toBe(true);
  });
});
