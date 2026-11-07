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
import { runPreflightChecks } from '../src/sync/preflight.js';
import type { ParsedMarkdown } from '../src/utils/frontmatter.js';

describe('AI Misbehavior Preflight Guards (G2 - G9)', () => {
  const validUlid = '01M67MP2W0VKCK2DFWM166CR24';
  const filePath = `posts/draft/${validUlid}-test-article.md`;

  const validParsed: ParsedMarkdown = {
    frontmatter: {
      id: validUlid,
      slug: 'test-article',
      title: 'Test Article',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: { categories: ['tech'], tags: ['cloudflare'] },
      bylines: [],
    },
    body: 'This is valid body text with an image ![Remote](https://example.com/img.jpg).',
    rawYaml: '',
  };

  it('passes completely for clean and valid article', () => {
    const res = runPreflightChecks(filePath, validParsed, {
      knownTaxonomies: { categories: ['tech', 'gadget'], tags: ['cloudflare'] },
      previousStatus: 'draft',
    });

    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('G2: blocks push when filename ULID does not match frontmatter ID', () => {
    const mismatchedPath = `posts/draft/01DIFFERENT_ULID_000000000-test-article.md`;
    const res = runPreflightChecks(mismatchedPath, validParsed);

    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === 'ID_MISMATCH_ERROR')).toBe(true);
  });

  it('G3: blocks unintended draft to published transition without allowPublish', () => {
    const publishedParsed: ParsedMarkdown = {
      ...validParsed,
      frontmatter: { ...validParsed.frontmatter, status: 'published' },
    };

    const res = runPreflightChecks(filePath, publishedParsed, {
      previousStatus: 'draft',
      allowPublish: false,
    });

    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === 'UNINTENDED_PUBLISH_GUARD')).toBe(true);
    expect(res.errors[0].suggestion).toContain('allowPublish: true');
  });

  it('G4: blocks unknown taxonomy categories or tags', () => {
    const res = runPreflightChecks(filePath, validParsed, {
      knownTaxonomies: { categories: ['life'], tags: ['cloudflare'] }, // 'tech' is missing
    });

    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === 'INVALID_TAXONOMY_ERROR')).toBe(true);
    expect(res.errors[0].message).toContain('tech');
  });

  it('G4: notes staleness only for canonical ULID term IDs, not for 26-character slugs', () => {
    const staleIdParsed: ParsedMarkdown = {
      ...validParsed,
      frontmatter: {
        ...validParsed.frontmatter,
        taxonomies: { categories: ['01M6G4ST000000000000000000'], tags: ['cloudflare'] },
      },
    };
    const idRes = runPreflightChecks(filePath, staleIdParsed, {
      knownTaxonomies: { categories: ['tech'], tags: ['cloudflare'] },
    });
    expect(idRes.valid).toBe(false);
    expect(idRes.errors[0].message).toContain('01M6G4ST000000000000000000');
    expect(idRes.errors[0].message).toContain('may be stale or deleted');

    // A 26-character lowercase slug must not be described as a term ID
    const slugParsed: ParsedMarkdown = {
      ...validParsed,
      frontmatter: {
        ...validParsed.frontmatter,
        taxonomies: { categories: ['abcdefghijklmnopqrstuvwxyz'], tags: ['cloudflare'] },
      },
    };
    const slugRes = runPreflightChecks(filePath, slugParsed, {
      knownTaxonomies: { categories: ['tech'], tags: ['cloudflare'] },
    });
    expect(slugRes.valid).toBe(false);
    expect(slugRes.errors[0].message).toContain('abcdefghijklmnopqrstuvwxyz');
    expect(slugRes.errors[0].message).not.toContain('stale or deleted');
  });

  it('G5: blocks local image paths but ignores local paths inside code fences', () => {
    // 1. Invalid: local image path in body
    const badParsed: ParsedMarkdown = {
      ...validParsed,
      body: 'Check out this screenshot: ![Diagram](./assets/screenshot.png)',
    };
    const res1 = runPreflightChecks(filePath, badParsed);
    expect(res1.valid).toBe(false);
    expect(res1.errors.some((e) => e.code === 'LOCAL_IMAGE_DETECTED')).toBe(true);
    expect(res1.errors[0].suggestion).toContain('media_upload');

    // 2. Valid: local image syntax inside code block
    const codeParsed: ParsedMarkdown = {
      ...validParsed,
      body: 'Example syntax:\n```markdown\n![Diagram](./assets/screenshot.png)\n```\nDone.',
    };
    const res2 = runPreflightChecks(filePath, codeParsed);
    expect(res2.valid).toBe(true);

    // 3. Valid: root-relative canonical remote media URL (used in EmDash published posts)
    const remoteCanonicalParsed: ParsedMarkdown = {
      ...validParsed,
      body: 'Here is an uploaded photo: ![Photo](/_emdash/api/media/file/01M67NPPKKGDWBH3HVQ1JR4JSB.jpg)\nAnd another: ![](https://aroooy.net/_emdash/api/media/file/01M67NPRAFFQQMPT3S9148JC0Z.jpeg)',
    };
    const res3 = runPreflightChecks(filePath, remoteCanonicalParsed);
    expect(res3.valid).toBe(true);

    // 4. Invalid: absolute filesystem path
    const absoluteFsParsed: ParsedMarkdown = {
      ...validParsed,
      body: 'Dangerous absolute path: ![Secret](/Users/hiroaki/Desktop/secret.png)',
    };
    const res4 = runPreflightChecks(filePath, absoluteFsParsed);
    expect(res4.valid).toBe(false);
    expect(res4.errors.some((e) => e.code === 'LOCAL_IMAGE_DETECTED')).toBe(true);
  });

  it('G6: blocks push when unresolved conflict markers exist in body', () => {
    const conflictParsed: ParsedMarkdown = {
      ...validParsed,
      body: '<<<<<<< LOCAL\nMy local version\n=======\nRemote version\n>>>>>>> REMOTE',
    };
    const res = runPreflightChecks(filePath, conflictParsed);
    expect(res.valid).toBe(false);
    expect(
      res.errors.some(
        (e) => e.code === 'UNINTENDED_PUBLISH_GUARD' || e.code === 'UNRESOLVED_CONFLICT_MARKERS',
      ),
    ).toBe(true);
  });

  it('G7: automatically trims duplicate top-level heading matching title', () => {
    const duplicateHeadingParsed: ParsedMarkdown = {
      ...validParsed,
      body: '# Test Article\n\nActual body begins here.',
    };

    const res = runPreflightChecks(filePath, duplicateHeadingParsed);
    expect(res.valid).toBe(true);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(res.cleanedBody.trim()).toBe('Actual body begins here.');
  });

  it('G9: blocks push when an opaque block fence is modified or removed', () => {
    const baseMd = '<!--ec:block {"_type":"core:gallery","_key":"1"} -->\nSome text';
    const modifiedParsed: ParsedMarkdown = {
      ...validParsed,
      body: '<!--ec:block {"_type":"core:gallery","_key":"tampered"} -->\nSome text',
    };

    const res = runPreflightChecks(filePath, modifiedParsed, {
      baseMarkdown: baseMd,
    });

    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === 'MODIFIED_OPAQUE_BLOCK')).toBe(true);
  });

  it('G10: validates featuredImage frontmatter format and blocks invalid values', () => {
    // Valid 26-char ULID passes
    const validFiParsed: ParsedMarkdown = {
      ...validParsed,
      frontmatter: {
        ...validParsed.frontmatter,
        featuredImage: '01M67P0MBMJQQXH2K95HHCYRYB',
      },
    };
    const resValid = runPreflightChecks(filePath, validFiParsed);
    expect(resValid.valid).toBe(true);

    // Null passes (explicit clear)
    const nullFiParsed: ParsedMarkdown = {
      ...validParsed,
      frontmatter: {
        ...validParsed.frontmatter,
        featuredImage: null,
      },
    };
    const resNull = runPreflightChecks(filePath, nullFiParsed);
    expect(resNull.valid).toBe(true);

    // Invalid: local file path
    const localPathFiParsed: ParsedMarkdown = {
      ...validParsed,
      frontmatter: {
        ...validParsed.frontmatter,
        featuredImage: './my-photo.jpg',
      },
    };
    const resLocalPath = runPreflightChecks(filePath, localPathFiParsed);
    expect(resLocalPath.valid).toBe(false);
    expect(resLocalPath.errors.some((e) => e.code === 'INVALID_FEATURED_IMAGE')).toBe(true);

    // Invalid: wrong length / invalid Crockford characters
    const invalidCharFiParsed: ParsedMarkdown = {
      ...validParsed,
      frontmatter: {
        ...validParsed.frontmatter,
        featuredImage: '01M6MEDIA123456',
      },
    };
    const resInvalidChar = runPreflightChecks(filePath, invalidCharFiParsed);
    expect(resInvalidChar.valid).toBe(false);
    expect(resInvalidChar.errors.some((e) => e.code === 'INVALID_FEATURED_IMAGE')).toBe(true);
  });
});
