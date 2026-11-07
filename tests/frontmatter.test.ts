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
  formatFrontmatterYaml,
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
});
