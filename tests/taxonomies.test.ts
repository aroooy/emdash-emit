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
import {
  pullTaxonomies,
  loadLocalTaxonomyCandidates,
  loadLocalTaxonomyMaps,
  getLocalTaxonomiesSummary,
  formatTaxonomiesHint,
} from '../src/sync/taxonomies.js';

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

  it('getLocalTaxonomiesSummary sorts categories alphabetically and tags by count desc then ULID desc', () => {
    const catDir = path.join(tempDir, 'categories');
    const tagDir = path.join(tempDir, 'tags');
    fs.mkdirSync(catDir, { recursive: true });
    fs.mkdirSync(tagDir, { recursive: true });

    // Categories: beta, alpha (with duplicate alpha slug: count 5 vs count 20)
    fs.writeFileSync(
      path.join(catDir, '01M6CAT1-Beta.yaml'),
      'id: 01M6CAT1\nname: Beta\nslug: beta\ncount: 0\n',
    );
    fs.writeFileSync(
      path.join(catDir, '01M6CAT2-AlphaLow.yaml'),
      'id: 01M6CAT2\nname: アルファ低\nslug: alpha\ncount: 5\n',
    );
    fs.writeFileSync(
      path.join(catDir, '01M6CAT3-AlphaHigh.yaml'),
      'id: 01M6CAT3\nname: アルファ高\nslug: alpha\ncount: 20\n',
    );

    // Tags:
    // tag-popular: count 20, older ULID (01M60000000000000000000001)
    // tag-trending: count 10, newest ULID (01M6ZZZZZZZZZZZZZZZZZZZZZZ)
    // tag-legacy: count 10, middle ULID (01M6MMMMMMMMMMMMMMMMMMMMMM)
    fs.writeFileSync(
      path.join(tagDir, '01M60000000000000000000001-Popular.yaml'),
      'id: 01M60000000000000000000001\nname: Popular\nslug: popular\ncount: 20\n',
    );
    fs.writeFileSync(
      path.join(tagDir, '01M6ZZZZZZZZZZZZZZZZZZZZZZ-Trending.yaml'),
      'id: 01M6ZZZZZZZZZZZZZZZZZZZZZZ\nname: トレンド\nslug: trending\ncount: 10\n',
    );
    fs.writeFileSync(
      path.join(tagDir, '01M6MMMMMMMMMMMMMMMMMMMMMM-Legacy.yaml'),
      'id: 01M6MMMMMMMMMMMMMMMMMMMMMM\nname: Legacy\nslug: legacy\ncount: 10\n',
    );

    const summary = getLocalTaxonomiesSummary(tempDir);

    // Categories: alpha (deduped to AlphaHigh with count 20), beta (ordinal slug asc)
    expect(summary.categories.map((c) => c.slug)).toEqual(['alpha', 'beta']);
    expect(summary.categories.find((c) => c.slug === 'alpha')?.id).toBe('01M6CAT3');

    // Tags: popular (count 20), trending (count 10, ULID 'Z'), legacy (count 10, ULID 'M')
    expect(summary.tags.map((t) => t.slug)).toEqual(['popular', 'trending', 'legacy']);

    // Test formatTaxonomiesHint
    const hint = formatTaxonomiesHint(summary, { maxTags: 10 });
    expect(hint).toContain('- alpha (アルファ高)');
    expect(hint).toContain('- beta'); // slug.toLowerCase() === name.toLowerCase()
    expect(hint).toContain('Available Tags:');
    expect(hint).toContain('popular, trending (トレンド), legacy');

    // Test truncation when maxTags exceeded
    const truncatedHint = formatTaxonomiesHint(summary, { maxTags: 2 });
    expect(truncatedHint).toContain('popular, trending (トレンド)');
    expect(truncatedHint).toContain('(and 1 more in tags/)');
  });

  it('formatTaxonomiesHint cleanly omits sections when maxTags or maxCategories is 0', () => {
    const catDir = path.join(tempDir, 'categories');
    const tagDir = path.join(tempDir, 'tags');
    fs.mkdirSync(catDir, { recursive: true });
    fs.mkdirSync(tagDir, { recursive: true });

    fs.writeFileSync(path.join(catDir, '01M6C1.yaml'), 'id: 01M6C1\nname: Cat\nslug: cat\n');
    fs.writeFileSync(path.join(tagDir, '01M6T1.yaml'), 'id: 01M6T1\nname: Tag\nslug: tag\n');

    const summary = getLocalTaxonomiesSummary(tempDir);

    const noTags = formatTaxonomiesHint(summary, { maxTags: 0 });
    expect(noTags).toContain('Available Categories:');
    expect(noTags).not.toContain('Available Tags:');

    const noCats = formatTaxonomiesHint(summary, { maxCategories: 0 });
    expect(noCats).not.toContain('Available Categories:');
    expect(noCats).toContain('Available Tags:');
  });

  it('handles empty or missing taxonomy directories gracefully', () => {
    const summary = getLocalTaxonomiesSummary(tempDir);
    expect(summary.categories).toEqual([]);
    expect(summary.tags).toEqual([]);

    const hint = formatTaxonomiesHint(summary);
    expect(hint).toBe('');
  });

  it('preserves existing local YAMLs and skips pruning when remote fetch fails (500)', async () => {
    const catDir = path.join(tempDir, 'categories');
    fs.mkdirSync(catDir, { recursive: true });
    const localCatFile = path.join(catDir, '01M6CAT1-Local.yaml');
    fs.writeFileSync(localCatFile, 'id: 01M6CAT1\nname: Local\nslug: local\n', 'utf8');

    // Simulate 500 error from remote
    const mockFailingFetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );

    const res = await pullTaxonomies({
      workspaceRoot: tempDir,
      origin: 'https://example.com',
      token: 'fake-token',
      fetchFn: mockFailingFetch as unknown as typeof fetch,
    });

    expect(res.deletedCategoriesCount).toBe(0);
    expect(res.categoriesFailed).toBe(true);
    expect(res.tagsFailed).toBe(true);
    // Local YAML must NOT be pruned or deleted on fetch error
    expect(fs.existsSync(localCatFile)).toBe(true);
  });

  it('loadLocalTaxonomyMaps resolves unique decoded slugs and names, rejects colliding aliases, and survives malformed percent-encoding', () => {
    const catDir = path.join(tempDir, 'categories');
    const tagDir = path.join(tempDir, 'tags');
    fs.mkdirSync(catDir, { recursive: true });
    fs.mkdirSync(tagDir, { recursive: true });

    // Category 1: percent-encoded slug "%e6%9c%aa%e5%88%86%e9%a1%9e" (decodes to "未分類"), name "未分類" -> unique
    fs.writeFileSync(
      path.join(catDir, '01M6CAT1-Uncat.yaml'),
      'id: 01M6CAT1\nname: 未分類\nslug: "%e6%9c%aa%e5%88%86%e9%a1%9e"\ncount: 10\n',
    );
    // Category 2 & 3: colliding name "共通名" across two different category IDs -> must NOT register "共通名" alias
    fs.writeFileSync(
      path.join(catDir, '01M6CAT2-DupA.yaml'),
      'id: 01M6CAT2\nname: 共通名\nslug: dup-a\ncount: 5\n',
    );
    fs.writeFileSync(
      path.join(catDir, '01M6CAT3-DupB.yaml'),
      'id: 01M6CAT3\nname: 共通名\nslug: dup-b\ncount: 3\n',
    );
    // Tag 1: malformed percent sequence "%E0%A4%A" -> must not throw URIError
    fs.writeFileSync(
      path.join(tagDir, '01M6TAG1-Malformed.yaml'),
      'id: 01M6TAG1\nname: MalformedTag\nslug: "%E0%A4%A"\ncount: 1\n',
    );

    const maps = loadLocalTaxonomyMaps(tempDir);

    // Canonical slug works
    expect(maps.slugToId.category['%e6%9c%aa%e5%88%86%e9%a1%9e']).toBe('01M6CAT1');
    // Unique decoded slug / name alias works
    expect(maps.slugToId.category['未分類']).toBe('01M6CAT1');

    // Canonical slugs for colliding categories work, but ambiguous name "共通名" is NOT registered
    expect(maps.slugToId.category['dup-a']).toBe('01M6CAT2');
    expect(maps.slugToId.category['dup-b']).toBe('01M6CAT3');
    expect(maps.slugToId.category['共通名']).toBeUndefined();

    // Malformed percent-encoding survived without throwing, and unique name alias works
    expect(maps.slugToId.tag['%E0%A4%A']).toBe('01M6TAG1');
    expect(maps.slugToId.tag['MalformedTag']).toBe('01M6TAG1');

    // formatTaxonomiesHint quotes %-prefixed slugs so copy-pasting into YAML frontmatter is valid
    const summary = getLocalTaxonomiesSummary(tempDir);
    const hint = formatTaxonomiesHint(summary);
    expect(hint).toContain('"%e6%9c%aa%e5%88%86%e9%a1%9e" (未分類)');
  });
});
