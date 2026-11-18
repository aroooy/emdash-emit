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
import { pullTaxonomies } from '../src/sync/taxonomies.js';
import { CacheDatabase } from '../src/db/cache.js';
import { pullArticle } from '../src/sync/pull/index.js';
import { calculateHash } from '../src/sync/workspace/index.js';
import { createBaseSnapshot } from '../src/db/baseline.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';

describe('Unified Pull: Taxonomy Auto-Sync Behavior', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-unified-pull-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeMockFetch() {
    return vi.fn().mockImplementation((url: string) => {
      if (url.includes('/category/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              terms: [{ id: '01M6CAT00000000000000001', slug: 'tech', label: 'Tech', count: 5 }],
            },
          }),
        });
      }
      if (url.includes('/tag/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              terms: [
                { id: '01M6TAG00000000000000001', slug: 'nodejs', label: 'Nodejs', count: 3 },
              ],
            },
          }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
  }

  it('pullTaxonomies creates categories/ and tags/ directories with YAML files', async () => {
    const mockFetch = makeMockFetch();

    const res = await pullTaxonomies({
      workspaceRoot: tempDir,
      origin: 'https://example.com',
      token: 'test-token',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.categoriesCount).toBe(1);
    expect(res.tagsCount).toBe(1);

    expect(fs.existsSync(path.join(tempDir, 'categories'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'tags'))).toBe(true);

    const catFile = path.join(tempDir, 'categories', '01M6CAT00000000000000001-Tech.yaml');
    expect(fs.existsSync(catFile)).toBe(true);
    const catContent = fs.readFileSync(catFile, 'utf8');
    expect(catContent).toContain('slug: tech');
    expect(catContent).toContain('name: Tech');

    const tagFile = path.join(tempDir, 'tags', '01M6TAG00000000000000001-Nodejs.yaml');
    expect(fs.existsSync(tagFile)).toBe(true);
    const tagContent = fs.readFileSync(tagFile, 'utf8');
    expect(tagContent).toContain('slug: nodejs');
  });

  it('pullTaxonomies prunes stale local YAML files not present on remote', async () => {
    // Pre-create a stale category file
    const catDir = path.join(tempDir, 'categories');
    fs.mkdirSync(catDir, { recursive: true });
    fs.writeFileSync(
      path.join(catDir, '01M6STALE000000000000001-Stale.yaml'),
      'id: 01M6STALE000000000000001\nslug: stale\nname: Stale\ntaxonomy: category\n',
    );

    const mockFetch = makeMockFetch();

    const res = await pullTaxonomies({
      workspaceRoot: tempDir,
      origin: 'https://example.com',
      token: 'test-token',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.deletedCategoriesCount).toBe(1);
    expect(fs.existsSync(path.join(catDir, '01M6STALE000000000000001-Stale.yaml'))).toBe(false);
  });

  it('pullTaxonomies handles empty remote gracefully', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/category/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: [] } }),
        });
      }
      if (url.includes('/tag/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: [] } }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const res = await pullTaxonomies({
      workspaceRoot: tempDir,
      origin: 'https://example.com',
      token: 'test-token',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.categoriesCount).toBe(0);
    expect(res.tagsCount).toBe(0);
    expect(fs.existsSync(path.join(tempDir, 'categories'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'tags'))).toBe(true);
  });

  it('heals valid legacy percent-encoded taxonomy article to decoded on 1st pull and no-ops on 2nd pull', async () => {
    const cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
    const articleId = '01M67HEALVALID000000000001';
    const relPath = `posts/draft/20261114_${articleId}-Heal-Valid.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const fm: Frontmatter = {
      id: articleId,
      slug: 'heal-valid',
      title: 'Heal Valid',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: { categories: ['%e6%9c%aa%e5%88%86%e9%a1%9e'] },
      bylines: [],
    };

    // Valid YAML serialized in legacy percent-encoded format
    const legacyContent = serializeMarkdown(fm, 'Body content.\n', undefined, {
      preferEncodedTaxonomy: true,
    });
    fs.writeFileSync(fullPath, legacyContent, 'utf8');
    const legacyHash = calculateHash(legacyContent);

    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: legacyHash,
      remoteRev: 'rev_1',
      status: 'draft',
      slug: 'heal-valid',
      lastSyncedAt: 1730000000,
    });

    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: articleId,
        rev: 'rev_1',
        bodyMarkdown: 'Body content.\n',
        frontmatter: fm,
        hash: legacyHash,
      }),
    );

    const rawItem = {
      id: articleId,
      slug: 'heal-valid',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      _rev: 'rev_1',
      data: { title: 'Heal Valid', body: 'Body content.\n' },
    };

    const mockFetch = vi.fn();

    // 1st pull: fast-path heal promotes disk to decoded representation with zero network requests
    const res1 = await pullArticle('posts', articleId, {
      workspaceRoot: tempDir,
      cache,
      rawItem,
      origin: 'https://example.com',
      token: 'fake',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res1.updated).toBe(true);
    expect(res1.healed).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();

    const healedContent = fs.readFileSync(fullPath, 'utf8');
    expect(healedContent).toContain('    - 未分類');
    expect(cache.getSyncState(articleId)!.localHash).toBe(calculateHash(healedContent));
    // Base snapshot frontmatter JSON remains canonical slug
    const baseFm = JSON.parse(cache.getBaseSnapshot(articleId)!.frontmatterYaml);
    expect(baseFm.taxonomies?.categories).toEqual(['%e6%9c%aa%e5%88%86%e9%a1%9e']);
    expect(cache.getBaseSnapshot(articleId)!.hash).toBe(calculateHash(healedContent));

    // 2nd pull: clean no-op skip, no rewrite, no lastSyncedAt churn
    const syncBefore2 = cache.getSyncState(articleId)!;
    const res2 = await pullArticle('posts', articleId, {
      workspaceRoot: tempDir,
      cache,
      rawItem,
      origin: 'https://example.com',
      token: 'fake',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res2.skipped).toBe(true);
    expect(res2.updated).toBe(false);
    expect(res2.healed).toBeUndefined();
    expect(cache.getSyncState(articleId)!.lastSyncedAt).toBe(syncBefore2.lastSyncedAt);
    expect(mockFetch).not.toHaveBeenCalled();

    cache.close();
  });

  it('does not re-heal articles where article slug is percent-encoded but taxonomies are already decoded', async () => {
    const cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
    const articleId = '01M67SLUGENC00000000000001';
    const slug = '%e6%97%a5%e6%9c%ac%e8%aa%9e-slug';
    const relPath = `posts/draft/20261114_${articleId}-Japanese-Slug.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const fm: Frontmatter = {
      id: articleId,
      slug,
      title: 'Japanese Slug',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: { categories: ['未分類'] },
      bylines: [],
    };

    const diskContent = serializeMarkdown(fm, 'Body content.\n');
    fs.writeFileSync(fullPath, diskContent, 'utf8');
    const diskHash = calculateHash(diskContent);

    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: diskHash,
      remoteRev: 'rev_1',
      status: 'draft',
      slug,
      lastSyncedAt: 1730000000,
    });

    const rawItem = {
      id: articleId,
      slug,
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      _rev: 'rev_1',
      data: { title: 'Japanese Slug', body: 'Body content.\n' },
    };

    const mockFetch = vi.fn();
    const res = await pullArticle('posts', articleId, {
      workspaceRoot: tempDir,
      cache,
      rawItem,
      origin: 'https://example.com',
      token: 'fake',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.skipped).toBe(true);
    expect(res.updated).toBe(false);
    expect(res.healed).toBeUndefined();

    cache.close();
  });
});
