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
import { pullArticle } from '../src/sync/pull.js';
import { pushArticle, PushValidationError } from '../src/sync/push.js';
import {
  formatFrontmatterYaml,
  lenientRepairMarkdownFrontmatter,
  parseMarkdown,
  serializeMarkdown,
  type Frontmatter,
} from '../src/utils/frontmatter.js';
import {
  findClosestTaxonomySuggestions,
  levenshteinDistance,
  loadLocalTaxonomyMaps,
  type LocalTaxonomyItem,
} from '../src/sync/taxonomies.js';

describe('Phase 1b: Taxonomy UX, First-Class Name Resolution & Inline Comments', () => {
  let tempDir: string;
  let cache: CacheDatabase;
  const validUlid = '01M67TAXCORPUS000000000001';
  const taiwanCatId = '01M67MY261YYMGCAA25Q58CP3A';
  const nodejsTagId = '01M67NODEJSTAG0000000001';

  const options = {
    origin: 'https://aroooy.net',
    token: 'test-token',
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-corpus-tax-'));
    const dbPath = path.join(tempDir, '.emit', 'cache.db');
    cache = new CacheDatabase(dbPath);

    // Setup categories and tags definitions simulating real corpus (102/103 name != slug)
    const catDir = path.join(tempDir, 'categories');
    const tagDir = path.join(tempDir, 'tags');
    fs.mkdirSync(catDir, { recursive: true });
    fs.mkdirSync(tagDir, { recursive: true });

    // Category: %e5%8f%b0%e6%b9%be (台湾)
    fs.writeFileSync(
      path.join(catDir, `${taiwanCatId}-Taiwan.yaml`),
      [`id: ${taiwanCatId}`, 'name: 台湾', 'slug: "%e5%8f%b0%e6%b9%be"', 'count: 42'].join('\n'),
      'utf8',
    );

    // Category: %e6%9c%aa%e5%88%86%e9%a1%9e (未分類)
    fs.writeFileSync(
      path.join(catDir, '01M67UNCAT000000000000001-Uncategorized.yaml'),
      [
        'id: 01M67UNCAT000000000000001',
        'name: 未分類',
        'slug: "%e6%9c%aa%e5%88%86%e9%a1%9e"',
        'count: 100',
      ].join('\n'),
      'utf8',
    );

    // Tag: nodejs (Node.js)
    fs.writeFileSync(
      path.join(tagDir, `${nodejsTagId}-Nodejs.yaml`),
      [`id: ${nodejsTagId}`, 'name: Node.js', 'slug: nodejs', 'count: 15'].join('\n'),
      'utf8',
    );

    // Tag: travel (Travel)
    fs.writeFileSync(
      path.join(tagDir, '01M67TRAVELTAG00000000001-Travel.yaml'),
      ['id: 01M67TRAVELTAG00000000001', 'name: 旅行', 'slug: travel', 'count: 20'].join('\n'),
      'utf8',
    );
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('Levenshtein distance & G4 suggestion ranking', () => {
    it('levenshteinDistance computes exact edit distance', () => {
      expect(levenshteinDistance('', '')).toBe(0);
      expect(levenshteinDistance('abc', '')).toBe(3);
      expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
      expect(levenshteinDistance('台湾', '台')).toBe(1);
      expect(levenshteinDistance('未分類', '未分')).toBe(1);
    });

    it('findClosestTaxonomySuggestions ranks prefix, substring, and typos accurately', () => {
      const items: LocalTaxonomyItem[] = [
        { id: taiwanCatId, name: '台湾', slug: '%e5%8f%b0%e6%b9%be' },
        { id: '01UNCAT', name: '未分類', slug: '%e6%9c%aa%e5%88%86%e9%a1%9e' },
        { id: '01DIARY', name: '日記', slug: 'diary' },
      ];

      // Typo '未分' should suggest '未分類' first
      const suggestionsUncat = findClosestTaxonomySuggestions('未分', items, 2);
      expect(suggestionsUncat[0]).toBe('未分類 -> "%e6%9c%aa%e5%88%86%e9%a1%9e"');

      // Input '台' should suggest '台湾' first
      const suggestionsTaiwan = findClosestTaxonomySuggestions('台', items, 2);
      expect(suggestionsTaiwan[0]).toBe('台湾 -> "%e5%8f%b0%e6%b9%be"');

      // Input 'dia' should suggest 'diary'
      const suggestionsDiary = findClosestTaxonomySuggestions('dia', items, 2);
      expect(suggestionsDiary[0]).toBe('日記 -> diary');
    });
  });

  describe('formatFrontmatterYaml & serializeMarkdown inline comments', () => {
    it('appends # <Name> comments when human name differs from slug', () => {
      const fm: Frontmatter = {
        id: validUlid,
        slug: 'taiwan-travel',
        title: 'Taiwan Travel',
        collection: 'posts',
        status: 'draft',
        locale: 'ja',
        taxonomies: {
          categories: ['%e5%8f%b0%e6%b9%be'],
          tags: ['nodejs', 'travel'],
        },
        bylines: [],
      };

      const serialized = formatFrontmatterYaml(fm, {
        slugToName: {
          category: { '%e5%8f%b0%e6%b9%be': '台湾' },
          tag: { nodejs: 'Node.js', travel: 'travel' }, // travel has identical slug/name -> no comment
        },
      });

      expect(serialized).toContain('    - "%e5%8f%b0%e6%b9%be" # 台湾');
      expect(serialized).toContain('    - nodejs # Node.js');
      expect(serialized).toContain('    - travel\n'); // no redundant comment
      expect(serialized).not.toContain('    - travel # travel');

      // Parse markdown must ignore YAML comments and extract pristine values
      const parsed = parseMarkdown(serialized);
      expect(parsed.frontmatter.taxonomies?.categories).toEqual(['%e5%8f%b0%e6%b9%be']);
      expect(parsed.frontmatter.taxonomies?.tags).toEqual(['nodejs', 'travel']);

      // Lenient repair returns null because the commented document is already valid YAML
      expect(lenientRepairMarkdownFrontmatter(serialized)).toBeNull();
    });
  });

  describe('pushArticle First-Class Taxonomy Name & ULID Resolution', () => {
    it('canonicalizes human name and ULID inputs to canonical slugs and echoes resolvedTaxonomies', async () => {
      const relPath = `posts/draft/20261108_${validUlid}-Taiwan-Post.md`;
      const fullPath = path.join(tempDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });

      // Agent writes human name '台湾' in categories, and ULID for tag
      const localContent = [
        '---',
        `id: ${validUlid}`,
        'slug: taiwan-post',
        'title: "Taiwan Post"',
        'status: draft',
        'taxonomies:',
        '  categories:',
        '    - 台湾',
        '  tags:',
        `    - ${nodejsTagId}`,
        '---',
        '',
        'Article content about Taiwan and Node.js.',
      ].join('\n');
      fs.writeFileSync(fullPath, localContent, 'utf8');

      const postedTerms: Array<{ url: string; body: any }> = [];
      const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          if (url.includes('/terms/')) {
            postedTerms.push({ url, body: JSON.parse(init.body as string) });
            return Promise.resolve({ ok: true, json: async () => ({}) });
          }
          // Article POST
          return Promise.resolve({
            ok: true,
            json: async () => ({
              id: validUlid,
              slug: 'taiwan-post',
              collection: 'posts',
              status: 'draft',
              _rev: 'rev_1',
              data: { title: 'Taiwan Post' },
            }),
          });
        }
        if (init?.method === 'PUT') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              id: validUlid,
              _rev: 'rev_2',
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });

      const res = await pushArticle(relPath, {
        ...options,
        workspaceRoot: tempDir,
        cache,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(res.success).toBe(true);

      // Verify resolvedTaxonomies structured echo
      expect(res.resolvedTaxonomies).toBeDefined();
      expect(res.resolvedTaxonomies?.categories).toEqual([
        { input: '台湾', resolved: '%e5%8f%b0%e6%b9%be', id: taiwanCatId },
      ]);
      expect(res.resolvedTaxonomies?.tags).toEqual([
        { input: nodejsTagId, resolved: 'nodejs', id: nodejsTagId },
      ]);

      // Verify remote terms endpoint received actual ULIDs
      const categoryCall = postedTerms.find((p) => p.url.includes('/terms/category'));
      expect(categoryCall).toBeDefined();
      expect(categoryCall?.body.termIds).toContain(taiwanCatId);

      const tagCall = postedTerms.find((p) => p.url.includes('/terms/tag'));
      expect(tagCall).toBeDefined();
      expect(tagCall?.body.termIds).toContain(nodejsTagId);

      // Verify disk file was serialized with canonical slugs and # <Name> comments
      const diskContent = fs.readFileSync(fullPath, 'utf8');
      expect(diskContent).toContain('    - "%e5%8f%b0%e6%b9%be" # 台湾');
      expect(diskContent).toContain('    - nodejs # Node.js');
    });

    it('G4 preflight guard offers Levenshtein suggestions on typos', async () => {
      const relPath = `posts/draft/20261108_${validUlid}-Typo-Post.md`;
      const fullPath = path.join(tempDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });

      // Frontmatter has typo '台' in categories
      const localContent = [
        '---',
        `id: ${validUlid}`,
        'slug: typo-post',
        'title: "Typo Post"',
        'status: draft',
        'taxonomies:',
        '  categories:',
        '    - 台',
        '---',
        '',
        'Content.',
      ].join('\n');
      fs.writeFileSync(fullPath, localContent, 'utf8');

      try {
        await pushArticle(relPath, {
          ...options,
          workspaceRoot: tempDir,
          cache,
        });
        expect.unreachable('Should have thrown PushValidationError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(PushValidationError);
        const pve = err as PushValidationError;
        const g4Error = pve.errors.find((e) => e.code === 'INVALID_TAXONOMY_ERROR');
        expect(g4Error).toBeDefined();
        expect(g4Error?.message).toContain("Unknown categories term: '台'");
        expect(g4Error?.suggestion).toContain('Did you mean:');
        expect(g4Error?.suggestion).toContain('台湾 -> "%e5%8f%b0%e6%b9%be"');
      }
    });
  });

  describe('pullArticle Serialization with Comments', () => {
    it('pullArticle formats downloaded markdown with # <Name> inline comments', async () => {
      const remoteItem = {
        id: validUlid,
        slug: 'pull-comment-test',
        collection: 'posts',
        status: 'draft',
        locale: 'ja',
        _rev: 'rev_100',
        data: {
          title: 'Pull Comment Test',
        },
      };

      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/terms/category')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              data: { terms: [{ id: taiwanCatId, slug: '%e5%8f%b0%e6%b9%be' }] },
            }),
          });
        }
        if (url.includes('/terms/tag')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              data: { terms: [{ id: nodejsTagId, slug: 'nodejs' }] },
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });

      const res = await pullArticle('posts', validUlid, {
        ...options,
        workspaceRoot: tempDir,
        cache,
        rawItem: remoteItem,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(res.updated).toBe(true);
      const fullDiskPath = path.join(tempDir, res.filePath);
      const diskContent = fs.readFileSync(fullDiskPath, 'utf8');

      // Comments are injected based on local taxonomy YAML definitions
      expect(diskContent).toContain('    - "%e5%8f%b0%e6%b9%be" # 台湾');
      expect(diskContent).toContain('    - nodejs # Node.js');
    });
  });
});
