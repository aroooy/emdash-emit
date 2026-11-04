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
import { pullTaxonomies, loadLocalTaxonomyCandidates } from '../src/sync/taxonomies.js';

describe('Taxonomies Sync Engine', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-tax-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('pulls categories and tags into separate directories with sanitized filenames', async () => {
    const mockCategories = [
      { id: '01M67MY23GDT9X8QMY0G5SEQ6M', slug: 'camera', label: 'カメラ', count: 12 },
      { id: '01M65FEDX5ABY6AKMCBGEEJMB5', slug: 'development', label: 'Development', count: 5 },
    ];
    const mockTags = [
      { id: '01M65FEDZNS9GN01GD3JJRZFT2', slug: 'webdev', label: 'Web Development', count: 3 },
      { id: '01M67MY1X3PE6MZKB41RRECHPB', slug: 'dji', label: 'DJI', count: 8 },
    ];

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/category/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: mockCategories } }),
        });
      }
      if (url.includes('/tag/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: mockTags } }),
        });
      }
      return Promise.reject(new Error('Unknown url'));
    });

    const res = await pullTaxonomies({
      workspaceRoot: tempDir,
      origin: 'https://example.com',
      token: 'fake-token',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.categoriesCount).toBe(2);
    expect(res.tagsCount).toBe(2);

    const catFile = path.join(tempDir, 'categories', '01M67MY23GDT9X8QMY0G5SEQ6M-カメラ.yaml');
    expect(fs.existsSync(catFile)).toBe(true);
    const catContent = fs.readFileSync(catFile, 'utf8');
    expect(catContent).toContain('name: カメラ');
    expect(catContent).toContain('slug: camera');

    const tagFile = path.join(tempDir, 'tags', '01M65FEDZNS9GN01GD3JJRZFT2-Web-Development.yaml');
    expect(fs.existsSync(tagFile)).toBe(true);

    // Test loadLocalTaxonomyCandidates
    const candidates = loadLocalTaxonomyCandidates(tempDir);
    expect(candidates.categories).toContain('camera');
    expect(candidates.categories).toContain('development');
    expect(candidates.tags).toContain('webdev');
    expect(candidates.tags).toContain('dji');
  });
});
