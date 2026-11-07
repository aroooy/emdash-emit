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
});
