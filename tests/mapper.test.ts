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
    const validMediaUlid = '01M67MP2W0VKCK2DFWM166CR24';
    const withFeatured: ParsedMarkdown = {
      ...sampleParsed,
      frontmatter: {
        ...sampleParsed.frontmatter,
        featuredImage: validMediaUlid,
      },
    };

    const payload = localToApiPayload(withFeatured, 'rev_test_1');
    expect(payload.data.featured_image).toEqual({ id: validMediaUlid });

    // Legacy direct string shape
    const apiItemString = {
      id: validUlid,
      title: 'Post with Featured Image String',
      data: {
        title: 'Post with Featured Image String',
        featured_image: validMediaUlid,
        content: [],
      },
    };
    const localString = apiResponseToLocal(apiItemString);
    expect(localString.frontmatter.featuredImage).toBe(validMediaUlid);

    // Real EmDash provider: "external" object shape
    const apiItemExternal = {
      id: validUlid,
      title: 'Post with External Featured Image',
      data: {
        title: 'Post with External Featured Image',
        featured_image: {
          provider: 'external',
          id: '',
          src: '/_emdash/api/media/file/01M67NT31TW9WXJVC83ZRGK994.jpg',
        },
        content: [],
      },
    };
    const localExternal = apiResponseToLocal(apiItemExternal);
    expect(localExternal.frontmatter.featuredImage).toBe('01M67NT31TW9WXJVC83ZRGK994');
    expect(localExternal.frontmatter.featuredImage).not.toBe('[object Object]');

    // Real EmDash provider: "local" object shape
    const apiItemLocal = {
      id: validUlid,
      title: 'Post with Local Featured Image',
      data: {
        title: 'Post with Local Featured Image',
        featured_image: {
          id: '01M6A7SJ82SMPWKTJ7GSSDC6VZ',
          provider: 'local',
          filename: 'Gemini_Generated_Image.jpeg',
          mimeType: 'image/jpeg',
          meta: {
            storageKey: '01M6A7SJ82S6P98MN1YSPQ33YG.01M6A7SJEN7HNDPPM537J23R19.jpeg',
          },
        },
        content: [],
      },
    };
    const localLocal = apiResponseToLocal(apiItemLocal);
    expect(localLocal.frontmatter.featuredImage).toBe('01M6A7SJ82SMPWKTJ7GSSDC6VZ');
    expect(localLocal.frontmatter.featuredImage).not.toBe('[object Object]');

    // Null featured image clears it
    const apiItemNull = {
      id: validUlid,
      title: 'Post without Featured Image',
      data: {
        title: 'Post without Featured Image',
        featured_image: null,
        content: [],
      },
    };
    const localNull = apiResponseToLocal(apiItemNull);
    expect(localNull.frontmatter.featuredImage).toBeNull();
  });
});
