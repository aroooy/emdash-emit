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

import { describe, it, expect } from 'vitest';
import {
  parseMarkdown,
  serializeMarkdown,
  formatFrontmatterYaml,
  type Frontmatter,
} from '../src/utils/frontmatter.js';

describe('Frontmatter Draft Revision (status: published # draft revision)', () => {
  const publishedFm: Frontmatter = {
    id: '01M77VFT15HSH2M1XW8MJPTCPQ',
    slug: 'kingfisher-photography',
    title: 'カワセミ写真',
    collection: 'posts',
    status: 'published',
    publishedAt: '2026-11-13T08:00:00.000Z',
    locale: 'ja',
    taxonomies: { categories: ['野鳥'], tags: [] },
    bylines: ['aroooy'],
  };

  it('emits "status: published # draft revision" when hasDraftRevision is true', () => {
    const yaml = formatFrontmatterYaml(publishedFm, undefined, { hasDraftRevision: true });
    expect(yaml).toContain('status: published # draft revision');

    const markdown = serializeMarkdown(
      publishedFm,
      'Body with uncommitted draft text.',
      undefined,
      {
        hasDraftRevision: true,
      },
    );
    expect(markdown).toContain('status: published # draft revision');
  });

  it('emits clean "status: published" when hasDraftRevision is false or omitted', () => {
    const yamlClean = formatFrontmatterYaml(publishedFm, undefined, { hasDraftRevision: false });
    expect(yamlClean).toContain('status: published\n');
    expect(yamlClean).not.toContain('# draft revision');

    const yamlDefault = formatFrontmatterYaml(publishedFm);
    expect(yamlDefault).toContain('status: published\n');
    expect(yamlDefault).not.toContain('# draft revision');
  });

  it('does NOT emit "# draft revision" for draft articles even if hasDraftRevision is true', () => {
    const draftFm: Frontmatter = {
      ...publishedFm,
      status: 'draft',
      publishedAt: null,
    };
    const yaml = formatFrontmatterYaml(draftFm, undefined, { hasDraftRevision: true });
    expect(yaml).toContain('status: draft\n');
    expect(yaml).not.toContain('# draft revision');
  });

  it('transparently parses "status: published # draft revision" back into status: "published"', () => {
    const markdown = serializeMarkdown(publishedFm, 'Body content.', undefined, {
      hasDraftRevision: true,
    });

    const parsed = parseMarkdown(markdown);
    expect(parsed.frontmatter.status).toBe('published');
    expect(parsed.frontmatter.id).toBe(publishedFm.id);
    expect(parsed.frontmatter.title).toBe(publishedFm.title);
    expect(parsed.body.trim()).toBe('Body content.');
    // Invariant: Inline comment does NOT bleed into body
    expect(parsed.body).not.toContain('# draft revision');
  });
});
