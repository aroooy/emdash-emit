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
import { initWorkspace, loadConfig } from '../src/utils/config.js';
import {
  createLocalDraftTerm,
  loadLocalTaxonomyMaps,
  loadLocalTaxonomyTerms,
  pullTaxonomies,
} from '../src/sync/taxonomies.js';
import { createArticleScaffold } from '../src/sync/new.js';
import { pushArticle } from '../src/sync/push/index.js';
import { pushAll } from '../src/sync/orchestrator.js';
import { getWorkspaceStatus } from '../src/sync/status.js';
import { runWorkspaceDoctor } from '../src/sync/doctor.js';

describe('v0.2.1 Offline Taxonomy Creation & pushAll Taxonomy Cache', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-v021-tax-'));
    initWorkspace(tempDir);
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('stages draft terms offline, rejects duplicate slugs, protects drafts/ during pullTaxonomies, and keeps status/doctor healthy', async () => {
    const parentCat = createLocalDraftTerm({
      workspaceRoot: tempDir,
      taxonomy: 'category',
      slug: 'gadgets',
      name: 'ガジェット',
      locale: 'ja',
    });
    expect(parentCat.filePath).toMatch(/^categories\/drafts\/ja\//);
    expect(fs.existsSync(parentCat.fullPath)).toBe(true);

    const childCat = createLocalDraftTerm({
      workspaceRoot: tempDir,
      taxonomy: 'category',
      slug: 'cameras',
      name: 'カメラ',
      locale: 'ja',
      parent: 'gadgets',
    });
    expect(childCat.parentId).toBe(parentCat.id);

    // Duplicate slug rejected with DUPLICATE_TERM_SLUG
    expect(() =>
      createLocalDraftTerm({
        workspaceRoot: tempDir,
        taxonomy: 'category',
        slug: 'GADGETS',
        locale: 'ja',
      }),
    ).toThrow(/DUPLICATE_TERM_SLUG/);

    // pullTaxonomies must NOT prune categories/drafts/
    const mockFetch = (async () =>
      new Response(JSON.stringify({ terms: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    await pullTaxonomies({
      workspaceRoot: tempDir,
      origin: 'https://example.test',
      token: 'tok',
      fetchFn: mockFetch,
    });
    expect(fs.existsSync(parentCat.fullPath)).toBe(true);
    expect(fs.existsSync(childCat.fullPath)).toBe(true);

    // readTaxonomyDir / loadLocalTaxonomyTerms sees both drafts
    const terms = loadLocalTaxonomyTerms(tempDir);
    expect(terms.filter((t) => t.isDraft)).toHaveLength(2);

    // status and doctor work cleanly with drafts/ present
    const status = getWorkspaceStatus(tempDir, cache, 'posts');
    expect(status.summary.total).toBe(0);
    const doctor = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config: loadConfig(tempDir),
      collection: 'posts',
    });
    expect(doctor.checks.every((c) => c.status !== 'error')).toBe(true);
  });

  it('promotes parent-before-child draft categories on push, avoids double-POST on subsequent push, and aborts on slug mismatch', async () => {
    const parentCat = createLocalDraftTerm({
      workspaceRoot: tempDir,
      taxonomy: 'category',
      slug: 'hardware',
      name: 'Hardware',
      locale: 'en',
    });
    const childCat = createLocalDraftTerm({
      workspaceRoot: tempDir,
      taxonomy: 'category',
      slug: 'cameras',
      name: 'Cameras',
      locale: 'en',
      parent: 'hardware',
    });

    const art = createArticleScaffold({
      workspaceRoot: tempDir,
      slug: 'camera-guide',
      title: 'Camera Guide',
      locale: 'en',
      categories: ['cameras'],
      cache,
    });

    const createdTermPayloads: Array<Record<string, unknown>> = [];
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';
      if (url.includes('/_emdash/api/taxonomies/category/terms') && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
        createdTermPayloads.push(body);
        const serverId =
          body.slug === 'hardware' ? '01SRVPARENT000000000000001' : '01SRVCHILD0000000000000002';
        return new Response(
          JSON.stringify({
            data: {
              term: {
                id: serverId,
                slug: body.slug,
                label: body.label,
                locale: body.locale,
                parentId: body.parentId ?? null,
              },
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/_emdash/api/bylines')) {
        return new Response(JSON.stringify({ bylines: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/_emdash/api/content/posts') && url.includes('/terms/')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/_emdash/api/content/posts') && method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              _rev: 'rev-1',
              item: {
                id: '01SRVART000000000000000001',
                slug: 'camera-guide',
                collection: 'posts',
                status: 'draft',
                locale: 'en',
                version: 1,
                draftRevisionId: 'D1',
                data: { title: 'Camera Guide', content: [] },
              },
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const pushRes = await pushArticle(art.filePath, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.test',
      token: 'tok',
      fetchFn: mockFetch,
    });
    expect(pushRes.success).toBe(true);

    // Parent created first, then child with parent's server ID
    expect(createdTermPayloads).toHaveLength(2);
    expect(createdTermPayloads[0].slug).toBe('hardware');
    expect(createdTermPayloads[1].slug).toBe('cameras');
    expect(createdTermPayloads[1].parentId).toBe('01SRVPARENT000000000000001');

    // Draft files promoted & removed from drafts/
    expect(fs.existsSync(parentCat.fullPath)).toBe(false);
    expect(fs.existsSync(childCat.fullPath)).toBe(false);
    expect(
      fs.existsSync(
        path.join(tempDir, 'categories', 'en', '01SRVPARENT000000000000001-Hardware.yaml'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(tempDir, 'categories', 'en', '01SRVCHILD0000000000000002-Cameras.yaml'),
      ),
    ).toBe(true);

    // Separate process / second article referencing 'cameras' must NOT POST to taxonomies again
    const art2 = createArticleScaffold({
      workspaceRoot: tempDir,
      slug: 'camera-guide-2',
      title: 'Camera Guide 2',
      locale: 'en',
      categories: ['cameras'],
      cache,
    });
    const postCountBefore = createdTermPayloads.length;
    await pushArticle(art2.filePath, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.test',
      token: 'tok',
      fetchFn: mockFetch,
    });
    expect(createdTermPayloads.length).toBe(postCountBefore);
  });

  it('aborts with TAXONOMY_SLUG_MISMATCH and preserves draft YAML when server alters slug', async () => {
    const draftTag = createLocalDraftTerm({
      workspaceRoot: tempDir,
      taxonomy: 'tag',
      slug: 'my-custom-tag',
      name: 'My Custom Tag',
      locale: 'en',
    });
    const art = createArticleScaffold({
      workspaceRoot: tempDir,
      slug: 'mismatch-art',
      title: 'Mismatch Art',
      locale: 'en',
      tags: ['my-custom-tag'],
      cache,
    });

    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/_emdash/api/taxonomies/tag/terms') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              term: {
                id: '01SRVMISMATCH0000000000001',
                slug: 'server-rewritten-slug',
                label: 'My Custom Tag',
                locale: 'en',
              },
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ bylines: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await expect(
      pushArticle(art.filePath, {
        workspaceRoot: tempDir,
        cache,
        origin: 'https://example.test',
        token: 'tok',
        fetchFn: mockFetch,
      }),
    ).rejects.toThrow(/TAXONOMY_SLUG_MISMATCH|differs from requested/);

    // Draft file must remain intact in drafts/
    expect(fs.existsSync(draftTag.fullPath)).toBe(true);
  });

  it('pushAll refreshes taxonomies once upfront and promotes shared draft tag only once across 2 articles', async () => {
    createLocalDraftTerm({
      workspaceRoot: tempDir,
      taxonomy: 'tag',
      slug: 'shared-new-tag',
      name: 'Shared New Tag',
      locale: 'ja',
    });
    createArticleScaffold({
      workspaceRoot: tempDir,
      slug: 'batch-1',
      title: 'Batch 1',
      locale: 'ja',
      tags: ['shared-new-tag'],
      cache,
    });
    createArticleScaffold({
      workspaceRoot: tempDir,
      slug: 'batch-2',
      title: 'Batch 2',
      locale: 'ja',
      tags: ['shared-new-tag'],
      cache,
    });

    let taxGetCount = 0;
    let taxPostCount = 0;
    let articleSeq = 0;
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';
      if (url.includes('/_emdash/api/taxonomies/') && method === 'GET') {
        taxGetCount++;
        return new Response(JSON.stringify({ terms: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/_emdash/api/taxonomies/tag/terms') && method === 'POST') {
        taxPostCount++;
        return new Response(
          JSON.stringify({
            data: {
              term: {
                id: '01SRVTAG000000000000000001',
                slug: 'shared-new-tag',
                label: 'Shared New Tag',
                locale: 'ja',
              },
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/_emdash/api/bylines')) {
        return new Response(JSON.stringify({ bylines: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/_emdash/api/content/posts') && url.includes('/terms/')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/_emdash/api/content/posts') && method === 'POST') {
        articleSeq++;
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            data: {
              _rev: `rev-${articleSeq}`,
              item: {
                id: `01SRVBATCH000000000000000${articleSeq}`,
                slug: body.slug,
                collection: 'posts',
                status: 'draft',
                locale: 'ja',
                version: 1,
                draftRevisionId: `D${articleSeq}`,
                data: { title: (body.data as Record<string, unknown>).title, content: [] },
              },
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const batchRes = await pushAll({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.test',
      token: 'tok',
      fetchFn: mockFetch,
    });

    expect(batchRes.pushed).toBe(2);
    // pullTaxonomies ran once upfront (1 category GET + 1 tag GET = 2 GETs)
    expect(taxGetCount).toBe(2);
    // Shared draft tag was POSTed exactly ONCE across both articles
    expect(taxPostCount).toBe(1);
    const maps = loadLocalTaxonomyMaps(tempDir);
    expect(maps.slugToId.tag['shared-new-tag']).toBe('01SRVTAG000000000000000001');
  });
});
