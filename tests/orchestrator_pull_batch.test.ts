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
import { CacheDatabase } from '../src/db/cache.js';
import { pullBatch } from '../src/sync/orchestrator.js';

describe('Orchestrator Batch Pull Taxonomy Synchronization (v0.1.32 TS-1 - TS-3)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-orchestrator-batch-test-'));
    fs.mkdirSync(path.join(tempDir, '.emit'), { recursive: true });
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
    fs.mkdirSync(path.join(tempDir, 'categories'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'tags'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'posts', 'ja', 'draft'), { recursive: true });
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('TS-1: pullBatch synchronizes taxonomies internally and returns complete 4 counts in taxonomies result', async () => {
    const mockCategories = [
      { id: '01M67MY23GDT9X8QMY0G5SEQ6M', slug: 'camera', label: 'camera', count: 12 },
    ];
    const mockTags = [
      { id: '01M65FEDZNS9GN01GD3JJRZFT2', slug: 'webdev', label: 'webdev', count: 3 },
    ];

    let taxonomyCallbackFired = false;
    let callbackCounts: unknown = null;

    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes('/taxonomies/category/terms')) {
        return new Response(JSON.stringify({ terms: mockCategories }), { status: 200 });
      }
      if (url.includes('/taxonomies/tag/terms')) {
        return new Response(JSON.stringify({ terms: mockTags }), { status: 200 });
      }
      if (url.includes('/_emdash/api/content/posts')) {
        return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const res = await pullBatch({
      collection: 'posts',
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'test-token',
      postsOnly: false,
      mediaSync: false,
      fetchFn: mockFetch as unknown as typeof fetch,
      onTaxonomySync: (taxRes) => {
        taxonomyCallbackFired = true;
        callbackCounts = taxRes;
      },
    });

    expect(taxonomyCallbackFired).toBe(true);
    expect(res.taxonomies).toBeDefined();
    expect(res.taxonomies?.categoriesCount).toBe(1);
    expect(res.taxonomies?.tagsCount).toBe(1);
    expect(res.taxonomies?.deletedCategoriesCount).toBe(0);
    expect(res.taxonomies?.deletedTagsCount).toBe(0);
    expect(res.taxonomies?.error).toBeUndefined();
    expect(callbackCounts).toEqual(res.taxonomies);

    // Verify local files were written under <locale>/
    expect(
      fs.existsSync(
        path.join(tempDir, 'categories', 'ja', '01M67MY23GDT9X8QMY0G5SEQ6M-camera.yaml'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tempDir, 'tags', 'ja', '01M65FEDZNS9GN01GD3JJRZFT2-webdev.yaml')),
    ).toBe(true);
  });

  it('TS-2: pullBatch catches taxonomy fetch failures safely and continues article pull without crashing', async () => {
    let taxonomyCallbackFired = false;

    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes('/taxonomies/category/terms') || url.includes('/taxonomies/tag/terms')) {
        return new Response('Internal Server Error', { status: 500, statusText: 'Server Error' });
      }
      if (url.includes('/_emdash/api/content/posts')) {
        return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const res = await pullBatch({
      collection: 'posts',
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'test-token',
      postsOnly: false,
      mediaSync: false,
      fetchFn: mockFetch as unknown as typeof fetch,
      onTaxonomySync: () => {
        taxonomyCallbackFired = true;
      },
    });

    // Should complete cleanly without throwing
    expect(taxonomyCallbackFired).toBe(true);
    expect(res.taxonomies).toBeDefined();
    expect(res.taxonomies?.categoriesFailed).toBe(true);
    expect(res.taxonomies?.tagsFailed).toBe(true);
    expect(res.total).toBe(0);
  });

  it('TS-3: pullBatch with postsOnly: true skips taxonomy sync completely', async () => {
    let taxonomyCallbackFired = false;

    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes('/taxonomies/')) {
        throw new Error('Should not call taxonomies API when postsOnly is true!');
      }
      if (url.includes('/_emdash/api/content/posts')) {
        return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const res = await pullBatch({
      collection: 'posts',
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'test-token',
      postsOnly: true,
      mediaSync: false,
      fetchFn: mockFetch as unknown as typeof fetch,
      onTaxonomySync: () => {
        taxonomyCallbackFired = true;
      },
    });

    expect(taxonomyCallbackFired).toBe(false);
    expect(res.taxonomies).toBeUndefined();
    expect(res.total).toBe(0);
  });
});
