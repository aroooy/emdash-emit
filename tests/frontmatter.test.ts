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

import { describe, expect, it } from 'vitest';
import {
  computeArticleRelativePath,
  formatFrontmatterParseError,
  formatFrontmatterYaml,
  formatYamlScalar,
  lenientRepairMarkdownFrontmatter,
  parseMarkdown,
  serializeMarkdown,
  type Frontmatter,
} from '../src/utils/frontmatter.js';

describe('Frontmatter & Markdown Serialization', () => {
  const validUlid = '01M67MP2W0VKCK2DFWM166CR24';

  it('parses valid markdown and frontmatter correctly', () => {
    const raw = [
      '---',
      `id: ${validUlid}`,
      'slug: my-awesome-post',
      'title: "My Awesome Post"',
      'collection: posts',
      'status: draft',
      'locale: ja',
      'taxonomies:',
      '  categories:',
      '    - tech',
      '  tags:',
      '    - emdash',
      '---',
      '',
      'Here is the body content.',
    ].join('\n');

    const parsed = parseMarkdown(raw);
    expect(parsed.frontmatter.id).toBe(validUlid);
    expect(parsed.frontmatter.slug).toBe('my-awesome-post');
    expect(parsed.frontmatter.title).toBe('My Awesome Post');
    expect(parsed.frontmatter.status).toBe('draft');
    expect(parsed.frontmatter.taxonomies?.categories).toEqual(['tech']);
    expect(parsed.body.trim()).toBe('Here is the body content.');
  });

  it('rejects invalid ULID format', () => {
    const invalid = [
      '---',
      'id: not-a-ulid',
      'slug: invalid-post',
      'title: Invalid',
      '---',
      'body',
    ].join('\n');

    expect(() => parseMarkdown(invalid)).toThrowError(/26-character ULID/i);
  });

  it('formats frontmatter with clean taxonomies and bylines without comments', () => {
    const data: Frontmatter = {
      id: validUlid,
      slug: 'cloudflare-guide',
      title: 'Cloudflare Guide',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: {
        categories: ['tech'],
        tags: ['cloudflare'],
      },
      bylines: ['hiroaki-hayase'],
    };

    const yaml = formatFrontmatterYaml(data);
    expect(yaml).not.toContain('# Allowed:');
    expect(yaml).not.toContain('# Allowed slugs:');
    expect(yaml).toContain('categories:');
    expect(yaml).toContain('tags:');
    expect(yaml).toContain('bylines:');
    expect(yaml).toContain('- tech');
    expect(yaml).toContain('- cloudflare');
    expect(yaml).toContain('- hiroaki-hayase');
  });

  it('serializes identically with or without taxonomy candidates (base snapshot invariant)', () => {
    // Base snapshot reconstruction in src/sync/diff.ts re-serializes the cached frontmatter
    // without candidates. If candidates ever start affecting output, untouched articles would
    // show phantom diffs and the 3-way merge baseline would drift. This test locks that in.
    const data: Frontmatter = {
      id: validUlid,
      slug: 'cloudflare-guide',
      title: 'Cloudflare Guide',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: { categories: ['tech'], tags: ['cloudflare'] },
      bylines: ['hiroaki-hayase'],
    };

    const withCandidates = serializeMarkdown(data, 'Body line.\n', {
      categories: ['tech', 'travel'],
      tags: ['cloudflare', 'workers'],
      bylines: ['hiroaki-hayase', 'aroooy'],
    });
    const withoutCandidates = serializeMarkdown(data, 'Body line.\n');

    expect(withCandidates).toBe(withoutCandidates);
  });

  it('preserves featuredImage across parse and serialization round-trips', () => {
    const raw = [
      '---',
      `id: ${validUlid}`,
      'slug: hero-post',
      'title: "Hero Post"',
      'collection: posts',
      'status: draft',
      'featuredImage: "01M67P0MBMJQQXH2K95HHCYRYB"',
      '---',
      '',
      'Body with featured hero image.',
    ].join('\n');

    const parsed = parseMarkdown(raw);
    expect(parsed.frontmatter.featuredImage).toBe('01M67P0MBMJQQXH2K95HHCYRYB');

    const serialized = serializeMarkdown(parsed.frontmatter, parsed.body);
    expect(serialized).toContain('featuredImage: "01M67P0MBMJQQXH2K95HHCYRYB"');

    const reparsed = parseMarkdown(serialized);
    expect(reparsed.frontmatter.featuredImage).toBe('01M67P0MBMJQQXH2K95HHCYRYB');
  });

  it('serializes full document cleanly', () => {
    const data: Frontmatter = {
      id: validUlid,
      slug: 'hello',
      title: 'Hello',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };

    const fullDoc = serializeMarkdown(data, 'Hello world body');
    expect(fullDoc).toContain('---');
    expect(fullDoc).toContain(`id: ${validUlid}`);
    expect(fullDoc).toContain('Hello world body');
  });

  it('computes standardized relative file path with yyyyMMdd_ date prefix and sanitized symbols', () => {
    const p1 = computeArticleRelativePath(
      'posts',
      'draft',
      validUlid,
      'My First Post!',
      '2026-11-03',
    );
    expect(p1).toBe(`posts/draft/20261103_${validUlid}-My-First-Post!.md`);

    const p2 = computeArticleRelativePath(
      'posts',
      'published',
      validUlid,
      '日本語タイトル / テスト: 特殊文字',
      '2026-01-25',
    );
    expect(p2).toBe(`posts/published/20260125_${validUlid}-日本語タイトル-テスト-特殊文字.md`);
  });

  it('quotes %-prefixed slugs, reserved words, dates, and all-digit ULIDs while keeping standard ASCII/CJK scalars unquoted', () => {
    // Standard ULIDs and ASCII/CJK slugs remain unquoted (baseline hash invariant)
    expect(formatYamlScalar(validUlid)).toBe(validUlid);
    expect(formatYamlScalar('cloudflare-guide')).toBe('cloudflare-guide');
    expect(formatYamlScalar('2026-11-08-post')).toBe('2026-11-08-post');
    expect(formatYamlScalar('未分類')).toBe('未分類');

    // %-prefixed percent-encoded slugs and strings containing % are quoted
    expect(formatYamlScalar('%e6%9c%aa%e5%88%86%e9%a1%9e')).toBe('"%e6%9c%aa%e5%88%86%e9%a1%9e"');
    expect(formatYamlScalar('50%off')).toBe('"50%off"');

    // All-digit 26-char ULID, numbers, ISO dates, and YAML reserved words are quoted
    const allDigitUlid = '01234567890123456789012345';
    expect(formatYamlScalar(allDigitUlid)).toBe(`"${allDigitUlid}"`);
    expect(formatYamlScalar('2026-11-08')).toBe('"2026-11-08"');
    expect(formatYamlScalar('true')).toBe('"true"');
    expect(formatYamlScalar('null')).toBe('"null"');
    expect(formatYamlScalar('yes')).toBe('"yes"');

    // Full round-trip with adversarial values
    const fm: Frontmatter = {
      id: allDigitUlid,
      slug: '%e6%97%a5%e6%9c%ac%e8%aa%9e-slug',
      title: 'Percent Encoded & All-Digit ID Post',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: {
        categories: ['%e6%9c%aa%e5%88%86%e9%a1%9e', '未分類'],
        tags: ['50%off', 'true', '2026-11-08', 'foo: bar'],
      },
      bylines: ['%e8%91%97%e8%80%85'],
    };

    const serialized = serializeMarkdown(fm, 'Adversarial YAML body.\n');
    expect(serialized).toContain(`id: "${allDigitUlid}"`);
    expect(serialized).toContain('    - "%e6%9c%aa%e5%88%86%e9%a1%9e"');
    expect(serialized).toContain('    - 未分類');

    const reparsed = parseMarkdown(serialized);
    expect(reparsed.frontmatter.id).toBe(allDigitUlid);
    expect(reparsed.frontmatter.slug).toBe('%e6%97%a5%e6%9c%ac%e8%aa%9e-slug');
    expect(reparsed.frontmatter.taxonomies?.categories).toEqual([
      '%e6%9c%aa%e5%88%86%e9%a1%9e',
      '未分類',
    ]);
    expect(reparsed.frontmatter.taxonomies?.tags).toEqual([
      '50%off',
      'true',
      '2026-11-08',
      'foo: bar',
    ]);
    expect(reparsed.frontmatter.bylines).toEqual(['%e8%91%97%e8%80%85']);
  });

  it('formatFrontmatterParseError formats ZodError issues into a concise single line instead of "["', () => {
    const invalid = ['---', 'id: too-short', 'slug: ""', 'title: Valid Title', '---', 'Body'].join(
      '\n',
    );

    let caught: unknown;
    try {
      parseMarkdown(invalid);
    } catch (err) {
      caught = err;
    }

    const formatted = formatFrontmatterParseError(caught);
    expect(formatted).not.toBe('[');
    expect(formatted).toContain('id: ID must be a 26-character ULID');
    expect(formatted).toContain('slug: Slug cannot be empty');
  });

  it('lenientRepairMarkdownFrontmatter repairs unquoted % scalars without touching the body', () => {
    const broken = [
      '---',
      `id: ${validUlid}`,
      'slug: %e5%8f%b0%e6%b9%be-travel',
      'title: "Taiwan Travel"',
      'status: draft',
      'taxonomies:',
      '  categories:',
      '   - %e6%9c%aa%e5%88%86%e9%a1%9e', // unquoted % scalar + 3 spaces indent
      '  tags:',
      '    - %e5%8f%b0%e6%b9%be',
      '---',
      '',
      'Valuable unpushed local body content with unicode 台湾.',
    ].join('\n');

    // Initially fails parseMarkdown due to YAMLException
    expect(() => parseMarkdown(broken)).toThrow();

    const repaired = lenientRepairMarkdownFrontmatter(broken);
    expect(repaired).not.toBeNull();
    expect(repaired).toContain('    - "%e6%9c%aa%e5%88%86%e9%a1%9e"');
    expect(repaired).toContain('    - "%e5%8f%b0%e6%b9%be"');
    expect(repaired).toContain('Valuable unpushed local body content with unicode 台湾.');

    // Repaired document parses cleanly
    const parsed = parseMarkdown(repaired!);
    expect(parsed.frontmatter.id).toBe(validUlid);
    expect(parsed.frontmatter.taxonomies?.categories).toEqual(['%e6%9c%aa%e5%88%86%e9%a1%9e']);
    expect(parsed.frontmatter.taxonomies?.tags).toEqual(['%e5%8f%b0%e6%b9%be']);
    expect(parsed.body.trim()).toBe('Valuable unpushed local body content with unicode 台湾.');
  });
});
