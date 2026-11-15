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

describe('Initial Draft Pull Single GET Guarantee (v0.1.32 TD-1)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-draft-initial-test-'));
    fs.mkdirSync(path.join(tempDir, '.emit'), { recursive: true });
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
    fs.mkdirSync(path.join(tempDir, 'posts', 'draft'), { recursive: true });
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('TD-1: Initial pull of untracked draft article discards stale list rawItem and fetches full body via single GET', async () => {
    const draftId = '01M7TESTINITIALDRAFT000001';
    const draftSlug = 'initial-draft-test';
    const draftRev = '4@draft:01M7REVISIONULID0000000001';

    // List API returns stale creation body
    const listRawItem = {
      id: draftId,
      slug: draftSlug,
      status: 'draft',
      version: 4,
      draftRevisionId: '01M7REVISIONULID0000000001',
      _rev: '4:2026-11-15T00:00:00.000Z',
      createdAt: '2026-11-15T00:00:00.000Z',
      updatedAt: '2026-11-15T01:00:00.000Z',
      data: {
        title: 'Initial Draft Test',
        content: [
          {
            _type: 'block',
            _key: 'b1',
            style: 'normal',
            children: [
              { _type: 'span', _key: 's1', text: 'Stale creation-time body from list API' },
            ],
          },
        ],
      },
    };

    // Single GET returns full canonical draft revision body
    const singleGetItem = {
      id: draftId,
      slug: draftSlug,
      status: 'draft',
      version: 4,
      draftRevisionId: '01M7REVISIONULID0000000001',
      _rev: '4:2026-11-15T00:00:00.000Z',
      createdAt: '2026-11-15T00:00:00.000Z',
      updatedAt: '2026-11-15T01:00:00.000Z',
      data: {
        title: 'Initial Draft Test',
        content: [
          {
            _type: 'block',
            _key: 'b1',
            style: 'normal',
            children: [
              {
                _type: 'span',
                _key: 's1',
                text: 'Full canonical draft body fetched via single GET!',
              },
            ],
          },
        ],
      },
    };

    const requestedUrls: string[] = [];

    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      requestedUrls.push(url);

      // Single GET for article content
      if (url.includes(`/_emdash/api/content/posts/${draftId}`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: { item: singleGetItem },
            _rev: '4:2026-11-15T00:00:00.000Z',
          }),
          { status: 200 },
        );
      }

      // List API
      if (url.includes('/_emdash/api/content/posts')) {
        return new Response(
          JSON.stringify({
            items: [listRawItem],
            total: 1,
          }),
          { status: 200 },
        );
      }

      return new Response('{}', { status: 200 });
    });

    // Step 1: Initial pull of untracked draft article
    const firstPull = await pullBatch({
      collection: 'posts',
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'test-token',
      status: 'draft',
      postsOnly: true,
      mediaSync: false,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(firstPull.total).toBe(1);
    expect(firstPull.updated).toBe(1);

    // Assert (a): Single GET was issued during initial pull
    const singleGetCalls = requestedUrls.filter((u) =>
      u.split('?')[0].endsWith(`/_emdash/api/content/posts/${draftId}`),
    );
    expect(singleGetCalls.length).toBe(1);

    // Assert (b): Disk content came from single GET, NOT list rawItem
    const pulledItem = firstPull.items[0];
    const diskContent = fs.readFileSync(path.join(tempDir, pulledItem.filePath), 'utf8');
    expect(diskContent).toContain('Full canonical draft body fetched via single GET!');
    expect(diskContent).not.toContain('Stale creation-time body from list API');

    // Verify cache has Track 2 rev
    const syncState = cache.getSyncState(draftId);
    expect(syncState?.remoteRev).toBe(draftRev);

    // Step 2: Second pull of same unchanged article
    requestedUrls.length = 0; // reset URL tracker

    const secondPull = await pullBatch({
      collection: 'posts',
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'test-token',
      status: 'draft',
      postsOnly: true,
      mediaSync: false,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(secondPull.total).toBe(1);
    expect(secondPull.skipped).toBe(1);
    expect(secondPull.updated).toBe(0);

    // Assert (c): Fast-path hit! Zero extra GET calls to article content endpoint (A-2)
    const secondArticleCalls = requestedUrls.filter((u) =>
      u.split('?')[0].endsWith(`/_emdash/api/content/posts/${draftId}`),
    );
    expect(secondArticleCalls.length).toBe(0);
  });
});
