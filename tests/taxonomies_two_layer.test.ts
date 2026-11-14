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
  readTaxonomyDir,
  loadLocalTaxonomyMaps,
  getLocalTaxonomiesSummary,
  formatTaxonomiesHint,
  loadLocalTaxonomyCandidates,
  type LocalTaxonomyItem,
} from '../src/sync/taxonomies.js';
import { canonicalizeFrontmatterTaxonomies } from '../src/sync/push/taxonomy_plan.js';
import type { ParsedMarkdown } from '../src/utils/frontmatter.js';

describe('Taxonomies Two-Layer Representation (v0.1.26)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-tax-two-layer-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  const mockApiResponse = (categories: unknown[] = [], tags: unknown[] = []) => {
    return vi.fn().mockImplementation((url: string) => {
      if (url.includes('/category/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: categories } }),
        });
      }
      if (url.includes('/tag/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { terms: tags } }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { terms: [] } }),
      });
    });
  };

  it('pullTaxonomies() saves Japanese category with decoded slug and canonicalSlug, and ASCII with slug only', async () => {
    const rawJapaneseSlug = '%e3%83%ad%e3%83%bc%e3%82%ab%e3%83%ab%e3%82%ac%e3%82%a4%e3%83%89';
    const mockCats = [
      {
        id: '01M67MY25QW77PWZEDNH13JS4R',
        slug: rawJapaneseSlug,
        label: 'ローカルガイド',
        parentId: null,
        count: 5,
      },
      {
        id: '01M67MY23GDT9X8QMY0G5SEQ6M',
        slug: 'camera',
        label: 'カメラ',
        parentId: null,
        count: 12,
      },
    ];

    const mockFetch = mockApiResponse(mockCats, []);
    const res = await pullTaxonomies({
      workspaceRoot: tempDir,
      origin: 'https://test.example.com',
      token: 'test-token',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.categoriesCount).toBe(2);

    const catDir = path.join(tempDir, 'categories');
    const files = fs.readdirSync(catDir);
    expect(files.length).toBe(2);

    const japaneseFile = files.find((f) => f.includes('01M67MY25QW77PWZEDNH13JS4R'))!;
    const japaneseYaml = fs.readFileSync(path.join(catDir, japaneseFile), 'utf8');

    expect(japaneseYaml).toContain('slug: ローカルガイド');
    expect(japaneseYaml).toContain(`canonicalSlug: "${rawJapaneseSlug}"`);
    expect(japaneseYaml).toContain('count: 5');
    expect(japaneseYaml).toContain('parentId: null');

    const asciiFile = files.find((f) => f.includes('01M67MY23GDT9X8QMY0G5SEQ6M'))!;
    const asciiYaml = fs.readFileSync(path.join(catDir, asciiFile), 'utf8');

    expect(asciiYaml).toContain('slug: camera');
    expect(asciiYaml).not.toContain('canonicalSlug:');
    expect(asciiYaml).toContain('count: 12');
  });

  it('eliminates folded block (>-) on long percent-encoded slugs and keeps single-line output', async () => {
    // Very long multi-byte slug that js-yaml previously broke into folded block (> -)
    const longRawSlug =
      '%e3%83%88%e3%83%a9%e3%83%96%e3%83%ab%e3%82%b7%e3%83%a5%e3%83%bc%e3%83%86%e3%82%a3%e3%83%b3%e3%82%b0';
    const mockCats = [
      {
        id: '01M6LONGSLUG00000000000001',
        slug: longRawSlug,
        label: 'トラブルシューティング',
        parentId: null,
        count: 1,
      },
    ];

    const mockFetch = mockApiResponse(mockCats, []);
    await pullTaxonomies({
      workspaceRoot: tempDir,
      origin: 'https://test.example.com',
      token: 'test-token',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const catDir = path.join(tempDir, 'categories');
    const file = fs.readdirSync(catDir)[0];
    const rawYaml = fs.readFileSync(path.join(catDir, file), 'utf8');

    expect(rawYaml).not.toContain('>-');
    expect(rawYaml).toContain('slug: トラブルシューティング');
    expect(rawYaml).toContain(`canonicalSlug: "${longRawSlug}"`);

    const loaded = readTaxonomyDir(catDir);
    expect(loaded[0].slug).toBe('トラブルシューティング');
    expect(loaded[0].canonicalSlug).toBe(longRawSlug);
  });

  it('safely quotes reserved words, numeric slugs, and symbols without canonicalSlug', async () => {
    const mockTags = [
      { id: '01TAG_ON', slug: 'on', label: 'On Switch', count: 1 },
      { id: '01TAG_TRUE', slug: 'true', label: 'True Flag', count: 2 },
      { id: '01TAG_NUM', slug: '2026-review', label: '2026 Review', count: 3 },
      {
        id: '01TAG_SYM',
        slug: '%e8%b2%b7%e3%81%84%e7%89%a9(%e3%83%ac%e3%83%93%e3%83%a5%e3%83%bc)',
        label: '買い物(レビュー)',
        count: 4,
      },
    ];

    const mockFetch = mockApiResponse([], mockTags);
    await pullTaxonomies({
      workspaceRoot: tempDir,
      origin: 'https://test.example.com',
      token: 'test-token',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const tagDir = path.join(tempDir, 'tags');
    const onYaml = fs.readFileSync(
      path.join(
        tagDir,
        fs.readdirSync(tagDir).find((f) => f.includes('01TAG_ON'))!,
      ),
      'utf8',
    );
    expect(onYaml).toContain('slug: "on"');
    expect(onYaml).not.toContain('canonicalSlug');

    const trueYaml = fs.readFileSync(
      path.join(
        tagDir,
        fs.readdirSync(tagDir).find((f) => f.includes('01TAG_TRUE'))!,
      ),
      'utf8',
    );
    expect(trueYaml).toContain('slug: "true"');
    expect(trueYaml).not.toContain('canonicalSlug');

    const numYaml = fs.readFileSync(
      path.join(
        tagDir,
        fs.readdirSync(tagDir).find((f) => f.includes('01TAG_NUM'))!,
      ),
      'utf8',
    );
    expect(numYaml).toContain('slug: 2026-review');
    expect(numYaml).not.toContain('canonicalSlug');

    const symYaml = fs.readFileSync(
      path.join(
        tagDir,
        fs.readdirSync(tagDir).find((f) => f.includes('01TAG_SYM'))!,
      ),
      'utf8',
    );
    expect(symYaml).toContain('slug: "買い物(レビュー)"');

    // Verify round-trip parsing via readTaxonomyDir
    const items = readTaxonomyDir(tagDir);
    const itemOn = items.find((i) => i.id === '01TAG_ON')!;
    expect(itemOn.slug).toBe('on');
    expect(typeof itemOn.slug).toBe('string');
    expect(itemOn.canonicalSlug).toBe('on');

    const itemTrue = items.find((i) => i.id === '01TAG_TRUE')!;
    expect(itemTrue.slug).toBe('true');
    expect(typeof itemTrue.slug).toBe('string');

    const itemSym = items.find((i) => i.id === '01TAG_SYM')!;
    expect(itemSym.slug).toBe('買い物(レビュー)');
    expect(itemSym.canonicalSlug).toBe(
      '%e8%b2%b7%e3%81%84%e7%89%a9(%e3%83%ac%e3%83%93%e3%83%a5%e3%83%bc)',
    );
  });

  it('restores parentId as null and count as number type', () => {
    const catDir = path.join(tempDir, 'categories');
    fs.mkdirSync(catDir, { recursive: true });
    fs.writeFileSync(
      path.join(catDir, '01TEST-Type.yaml'),
      ['id: 01TEST', 'name: Type Test', 'slug: type-test', 'parentId: null', 'count: 42'].join(
        '\n',
      ),
      'utf8',
    );

    const items = readTaxonomyDir(catDir);
    expect(items.length).toBe(1);
    expect(items[0].parentId).toBeNull();
    expect(items[0].count).toBe(42);
    expect(typeof items[0].count).toBe('number');
  });

  it('readTaxonomyDir() transparently loads both legacy (v0.1.25) and new (v0.1.26) formats', () => {
    const catDir = path.join(tempDir, 'categories');
    fs.mkdirSync(catDir, { recursive: true });

    // Legacy file: slug is percent-encoded, no canonicalSlug
    fs.writeFileSync(
      path.join(catDir, '01LEGACY-Old.yaml'),
      [
        'id: 01LEGACY',
        'name: ローカルガイド',
        'slug: "%e3%83%ad%e3%83%bc%e3%82%ab%e3%83%ab%e3%82%ac%e3%82%a4%e3%83%89"',
        'count: 10',
      ].join('\n'),
      'utf8',
    );

    // New file: slug is decoded, canonicalSlug is present
    fs.writeFileSync(
      path.join(catDir, '01NEW-Current.yaml'),
      [
        'id: 01NEW',
        'name: 未分類',
        'slug: 未分類',
        'canonicalSlug: "%e6%9c%aa%e5%88%86%e9%a1%9e"',
        'count: 20',
      ].join('\n'),
      'utf8',
    );

    const items = readTaxonomyDir(catDir);
    const legacy = items.find((i) => i.id === '01LEGACY')!;
    expect(legacy.slug).toBe('ローカルガイド');
    expect(legacy.canonicalSlug).toBe(
      '%e3%83%ad%e3%83%bc%e3%82%ab%e3%83%ab%e3%82%ac%e3%82%a4%e3%83%89',
    );

    const current = items.find((i) => i.id === '01NEW')!;
    expect(current.slug).toBe('未分類');
    expect(current.canonicalSlug).toBe('%e6%9c%aa%e5%88%86%e9%a1%9e');
  });

  it('loadLocalTaxonomyMaps() returns canonicalSlug in idToSlug, and resolves both decoded and canonical in slugToId', () => {
    const catDir = path.join(tempDir, 'categories');
    fs.mkdirSync(catDir, { recursive: true });

    fs.writeFileSync(
      path.join(catDir, '01CAT1-Guide.yaml'),
      [
        'id: 01CAT1',
        'name: ローカルガイド',
        'slug: ローカルガイド',
        'canonicalSlug: "%e3%83%ad%e3%83%bc%e3%82%ab%e3%83%ab%e3%82%ac%e3%82%a4%e3%83%89"',
        'count: 15',
      ].join('\n'),
      'utf8',
    );

    const maps = loadLocalTaxonomyMaps(tempDir);

    // Invariant 1: idToSlug ALWAYS returns canonicalSlug
    expect(maps.idToSlug.category['01CAT1']).toBe(
      '%e3%83%ad%e3%83%bc%e3%82%ab%e3%83%ab%e3%82%ac%e3%82%a4%e3%83%89',
    );

    // Both canonical and decoded slugs resolve to same ULID
    expect(
      maps.slugToId.category['%e3%83%ad%e3%83%bc%e3%82%ab%e3%83%ab%e3%82%ac%e3%82%a4%e3%83%89'],
    ).toBe('01CAT1');
    expect(maps.slugToId.category['ローカルガイド']).toBe('01CAT1');
  });

  it('guarantees identical idToSlug and canonicalizeFrontmatterTaxonomies between legacy and new YAML files', () => {
    const dirA = path.join(tempDir, 'workspace-legacy');
    const dirB = path.join(tempDir, 'workspace-new');
    fs.mkdirSync(path.join(dirA, 'categories'), { recursive: true });
    fs.mkdirSync(path.join(dirB, 'categories'), { recursive: true });

    const rawSlug = '%e3%83%ad%e3%83%bc%e3%82%ab%e3%83%ab%e3%82%ac%e3%82%a4%e3%83%89';

    // Legacy YAML in dirA
    fs.writeFileSync(
      path.join(dirA, 'categories', '01CAT-Guide.yaml'),
      `id: 01CAT\nname: ローカルガイド\nslug: "${rawSlug}"\ncount: 1\n`,
    );

    // New YAML in dirB
    fs.writeFileSync(
      path.join(dirB, 'categories', '01CAT-Guide.yaml'),
      `id: 01CAT\nname: ローカルガイド\nslug: ローカルガイド\ncanonicalSlug: "${rawSlug}"\ncount: 1\n`,
    );

    const mapsA = loadLocalTaxonomyMaps(dirA);
    const mapsB = loadLocalTaxonomyMaps(dirB);

    expect(mapsA.idToSlug).toEqual(mapsB.idToSlug);
    expect(mapsA.slugToId).toEqual(mapsB.slugToId);

    const parsedA: ParsedMarkdown = {
      frontmatter: {
        id: '01POST00000000000000000000',
        slug: 'post',
        title: 'Post Title',
        collection: 'posts',
        status: 'draft',
        locale: 'ja',
        bylines: ['aroooy'],
        taxonomies: {
          categories: ['ローカルガイド'],
        },
      },
      body: 'Content',
      rawYaml: '',
    };
    const parsedB: ParsedMarkdown = JSON.parse(JSON.stringify(parsedA));

    const resA = canonicalizeFrontmatterTaxonomies(parsedA, mapsA);
    const resB = canonicalizeFrontmatterTaxonomies(parsedB, mapsB);

    expect(parsedA.frontmatter.taxonomies?.categories).toEqual([rawSlug]);
    expect(parsedB.frontmatter.taxonomies?.categories).toEqual([rawSlug]);
    expect(resA.resolvedTaxonomies).toEqual(resB.resolvedTaxonomies);
  });

  describe('Collision Protection & Resolution Invariants', () => {
    it('protects canonical slug from being overwritten by an identical alias (Canonical vs Alias collision)', () => {
      const catDir = path.join(tempDir, 'categories');
      fs.mkdirSync(catDir, { recursive: true });

      // Term A: canonical slug is 'local-guide'
      fs.writeFileSync(
        path.join(catDir, '01TERM_A-Canonical.yaml'),
        'id: 01TERM_A\nname: Guide A\nslug: local-guide\ncount: 10\n',
      );

      // Term B: name is 'local-guide' (would be alias candidate), but canonical slug is 'other-guide'
      fs.writeFileSync(
        path.join(catDir, '01TERM_B-Alias.yaml'),
        'id: 01TERM_B\nname: local-guide\nslug: other-guide\ncount: 5\n',
      );

      const maps = loadLocalTaxonomyMaps(tempDir);

      // Phase 1 preserves Term A's canonical registration
      expect(maps.slugToId.category['local-guide']).toBe('01TERM_A');
      expect(maps.slugToId.category['other-guide']).toBe('01TERM_B');

      // Term B's name alias was rejected because it collided with Term A's canonical slug
      expect(maps.idToSlug.category['01TERM_A']).toBe('local-guide');
      expect(maps.idToSlug.category['01TERM_B']).toBe('other-guide');
    });

    it('handles Canonical vs Canonical collision deterministically and preserves loser term ULID resolution', () => {
      const catDir = path.join(tempDir, 'categories');
      fs.mkdirSync(catDir, { recursive: true });

      const sharedRawSlug = '%e5%85%b1%e6%9c%89%e3%82%b9%e3%83%a9%e3%83%83%e3%82%b0';

      // Winner: higher count (10)
      fs.writeFileSync(
        path.join(catDir, '01WINNER-Cat.yaml'),
        `id: 01WINNER\nname: 勝者カテゴリ\nslug: 共有スラッグ\ncanonicalSlug: "${sharedRawSlug}"\ncount: 10\n`,
      );

      // Loser: lower count (2)
      fs.writeFileSync(
        path.join(catDir, '01LOSER-Cat.yaml'),
        `id: 01LOSER\nname: 敗者カテゴリ\nslug: 共有スラッグ\ncanonicalSlug: "${sharedRawSlug}"\ncount: 2\n`,
      );

      const maps = loadLocalTaxonomyMaps(tempDir);

      // 1. Winner claims the canonical and decoded slugs
      expect(maps.slugToId.category[sharedRawSlug]).toBe('01WINNER');
      expect(maps.slugToId.category['共有スラッグ']).toBe('01WINNER');

      // 2. Querying shared slug (both decoded and canonical) resolves to winner (silent assignment)
      expect(maps.slugToId.category['共有スラッグ']).not.toBe('01LOSER');
      expect(maps.slugToId.category[sharedRawSlug]).not.toBe('01LOSER');

      // 3. Unique name alias of loser allows reaching loser without ULID
      expect(maps.slugToId.category['敗者カテゴリ']).toBe('01LOSER');
      expect(maps.slugToId.category['勝者カテゴリ']).toBe('01WINNER');

      // 4. Invariant 1: idToSlug holds both terms
      expect(maps.idToSlug.category['01WINNER']).toBe(sharedRawSlug);
      expect(maps.idToSlug.category['01LOSER']).toBe(sharedRawSlug);

      // 5. Loser term ULID in frontmatter resolves to shared canonical slug while preserving loser ID
      const parsed: ParsedMarkdown = {
        frontmatter: {
          id: '01POST00000000000000000000',
          slug: 'test',
          title: 'Test Post',
          collection: 'posts',
          status: 'draft',
          locale: 'ja',
          bylines: ['aroooy'],
          taxonomies: {
            categories: ['01LOSER'],
          },
        },
        body: 'Body',
        rawYaml: '',
      };
      const res = canonicalizeFrontmatterTaxonomies(parsed, maps);
      expect(parsed.frontmatter.taxonomies?.categories).toEqual([sharedRawSlug]);
      expect(res.resolvedTaxonomies?.categories).toEqual([
        { input: '01LOSER', resolved: sharedRawSlug, id: '01LOSER' },
      ]);

      // 6. Layer B Presentation: dedupeBySlug drops the loser from candidates / summary
      const summary = getLocalTaxonomiesSummary(tempDir);
      expect(summary.categories.length).toBe(1);
      expect(summary.categories[0].id).toBe('01WINNER');

      const hint = formatTaxonomiesHint(summary);
      expect(hint).toContain('共有スラッグ (勝者カテゴリ)');
      expect(hint).not.toContain('敗者カテゴリ');
    });

    it('rejects ambiguous name aliases shared across multiple terms', () => {
      const catDir = path.join(tempDir, 'categories');
      fs.mkdirSync(catDir, { recursive: true });

      fs.writeFileSync(
        path.join(catDir, '01CAT_A-Dup.yaml'),
        'id: 01CAT_A\nname: 共通名称\nslug: cat-a\ncount: 5\n',
      );
      fs.writeFileSync(
        path.join(catDir, '01CAT_B-Dup.yaml'),
        'id: 01CAT_B\nname: 共通名称\nslug: cat-b\ncount: 3\n',
      );

      const maps = loadLocalTaxonomyMaps(tempDir);
      expect(maps.slugToId.category['cat-a']).toBe('01CAT_A');
      expect(maps.slugToId.category['cat-b']).toBe('01CAT_B');
      // Ambiguous alias is rejected
      expect(maps.slugToId.category['共通名称']).toBeUndefined();
    });
  });

  describe('Malformed & Special Percent-Encoding Handling', () => {
    it('handles malformed percent-encoding (%E0%A4%A) as literal without throwing or adding canonicalSlug', async () => {
      const malformedSlug = '%E0%A4%A';
      const mockTags = [
        { id: '01MALFORMED', slug: malformedSlug, label: 'MalformedTag', count: 1 },
      ];

      const mockFetch = mockApiResponse([], mockTags);
      await pullTaxonomies({
        workspaceRoot: tempDir,
        origin: 'https://test.example.com',
        token: 'test-token',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const tagDir = path.join(tempDir, 'tags');
      const files = fs.readdirSync(tagDir);
      const yaml = fs.readFileSync(path.join(tagDir, files[0]), 'utf8');

      expect(yaml).toContain(`slug: "${malformedSlug}"`);
      expect(yaml).not.toContain('canonicalSlug:');

      const items = readTaxonomyDir(tagDir);
      expect(items[0].slug).toBe(malformedSlug);
      expect(items[0].canonicalSlug).toBe(malformedSlug);

      const maps = loadLocalTaxonomyMaps(tempDir);
      expect(maps.slugToId.tag[malformedSlug]).toBe('01MALFORMED');
      expect(maps.slugToId.tag['MalformedTag']).toBe('01MALFORMED');
    });

    it('correctly handles decodable (%350%25off) vs undecodable (50%off) percent expressions from remote API', async () => {
      const mockTags = [
        { id: '01DEC_PCT', slug: '%350%25off', label: '50% Off (Encoded)', count: 2 },
        { id: '01RAW_PCT', slug: '50%off', label: '50% Off (Raw)', count: 3 },
      ];

      const mockFetch = mockApiResponse([], mockTags);
      await pullTaxonomies({
        workspaceRoot: tempDir,
        origin: 'https://test.example.com',
        token: 'test-token',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const tagDir = path.join(tempDir, 'tags');
      const decYaml = fs.readFileSync(
        path.join(
          tagDir,
          fs.readdirSync(tagDir).find((f) => f.includes('01DEC_PCT'))!,
        ),
        'utf8',
      );
      expect(decYaml).toContain('slug: "50%off"');
      expect(decYaml).toContain('canonicalSlug: "%350%25off"');

      const rawYaml = fs.readFileSync(
        path.join(
          tagDir,
          fs.readdirSync(tagDir).find((f) => f.includes('01RAW_PCT'))!,
        ),
        'utf8',
      );
      expect(rawYaml).toContain('slug: "50%off"');
      expect(rawYaml).not.toContain('canonicalSlug:');

      const maps = loadLocalTaxonomyMaps(tempDir);
      expect(maps.idToSlug.tag['01DEC_PCT']).toBe('%350%25off');
      expect(maps.idToSlug.tag['01RAW_PCT']).toBe('50%off');
    });
  });
});
