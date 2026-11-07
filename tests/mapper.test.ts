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
import { apiResponseToLocal, localToApiPayload } from '../src/client/mapper.js';
import type { ParsedMarkdown } from '../src/utils/frontmatter.js';

describe('Mapper (Local Frontend <-> EmDash API)', () => {
  const validUlid = '01M67MP2W0VKCK2DFWM166CR24';

  const sampleParsed: ParsedMarkdown = {
    frontmatter: {
      id: validUlid,
      slug: 'migration-story',
      title: 'Migration Story',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-01T10:00:00Z',
      locale: 'ja',
      taxonomies: { categories: ['tech'] },
      bylines: ['hiroaki-author'],
      seo: { title: 'SEO Title', description: 'SEO Desc', noIndex: false },
    },
    body: '# Migration Story\n\nContent paragraph.',
    rawYaml: '',
  };

  it('omits status from PUT payload (status transitions use /publish and /unpublish)', () => {
    const payload = localToApiPayload(sampleParsed, 'rev_test_1', {
      allowPublish: false,
    });

    expect(payload.id).toBe(validUlid);
    expect(payload.status).toBeUndefined();
    expect(payload._rev).toBe('rev_test_1');
    expect(Array.isArray(payload.data.content)).toBe(true);
  });

  it('maps bylines correctly in payload', () => {
    const payload = localToApiPayload(sampleParsed, 'rev_test_1', {
      allowPublish: true,
      bylineSlugToId: { 'hiroaki-author': '01BYLINE_ID_123' },
    });

    expect(payload.status).toBeUndefined();
    expect(payload.bylines).toEqual([{ bylineId: '01BYLINE_ID_123', roleLabel: null }]);
  });

  it('converts API response item to local frontmatter and separates _rev', () => {
    const apiItem = {
      id: validUlid,
      slug: 'api-post',
      collection: 'posts',
      status: 'published',
      locale: 'ja',
      publishedAt: '2026-11-01T12:00:00Z',
      _rev: 'rev_remote_999',
      data: {
        title: 'API Post Title',
        body: [
          {
            _type: 'block',
            style: 'normal',
            children: [{ _type: 'span', text: 'Paragraph from API' }],
          },
        ],
      },
      taxonomies: { categories: ['tech'] },
      bylines: [{ bylineId: '01BYLINE_ID_123' }],
    };

    const local = apiResponseToLocal(apiItem, {
      bylineIdToSlug: { '01BYLINE_ID_123': 'hiroaki-author' },
    });

    expect(local.frontmatter.id).toBe(validUlid);
    expect(local.frontmatter.title).toBe('API Post Title');
    expect(local.frontmatter.status).toBe('published');
    expect(local.frontmatter.bylines).toEqual(['hiroaki-author']);
    expect(local.body.trim()).toBe('Paragraph from API');
    expect(local.rev).toBe('rev_remote_999');
    // Ensure _rev is NOT in frontmatter
    expect((local.frontmatter as Record<string, unknown>)._rev).toBeUndefined();
  });

  it('maps featuredImage to payload.data.featured_image and back to frontmatter.featuredImage', () => {
    const withFeatured: ParsedMarkdown = {
      ...sampleParsed,
      frontmatter: {
        ...sampleParsed.frontmatter,
        featuredImage: '01M6MEDIA1234567890123456',
      },
    };

    const payload = localToApiPayload(withFeatured, 'rev_test_1');
    expect(payload.data.featured_image).toBe('01M6MEDIA1234567890123456');

    const apiItem = {
      id: validUlid,
      title: 'Post with Featured Image',
      data: {
        title: 'Post with Featured Image',
        featured_image: '01M6MEDIA1234567890123456',
        content: [],
      },
    };

    const local = apiResponseToLocal(apiItem);
    expect(local.frontmatter.featuredImage).toBe('01M6MEDIA1234567890123456');
  });
});
