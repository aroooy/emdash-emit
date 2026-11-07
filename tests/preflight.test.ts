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
import { describe, expect, it } from 'vitest';
import { runPreflightChecks } from '../src/sync/preflight.js';
import type { ParsedMarkdown } from '../src/utils/frontmatter.js';

describe('AI Misbehavior Preflight Guards (G2 - G11)', () => {
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

  it('G11: accepts standalone images under media/drafts/ for auto-upload, rejects missing files, inline images, and ignores opaque fences', () => {
    const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-preflight-g11-'));
    try {
      const draftsDir = path.join(tempWorkspace, 'media', 'drafts');
      fs.mkdirSync(draftsDir, { recursive: true });
      const sunsetPath = path.join(draftsDir, 'sunset.jpg');
      fs.writeFileSync(sunsetPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

      // 1. Standalone draft image on its own line + opaque fence containing image-like string + canonical double-ULID remote URL
      const draftMd: ParsedMarkdown = {
        ...validParsed,
        body: [
          'Intro paragraph.',
          '',
          '![Flight Sunset](../../media/drafts/sunset.jpg)',
          '',
          '<!--ec:block {"_type":"core:custom","raw":"![ignored](../../media/drafts/nonexistent.jpg)"} -->',
          '',
          '![Already Remote](/_emdash/api/media/file/01M6QM290DBY13GFC29W2WSAEP.01M6QM29S8H8DZX6VZMYP32H5E.jpeg)',
        ].join('\n'),
      };

      const resOk = runPreflightChecks(filePath, draftMd, {
        workspaceRoot: tempWorkspace,
      });
      expect(resOk.valid).toBe(true);
      expect(resOk.errors).toHaveLength(0);
      expect(resOk.draftImages).toHaveLength(1);
      expect(resOk.draftImages[0]).toEqual({
        line: '![Flight Sunset](../../media/drafts/sunset.jpg)',
        alt: 'Flight Sunset',
        rawPath: '../../media/drafts/sunset.jpg',
        filename: 'sunset.jpg',
        resolvedAbsPath: sunsetPath,
      });

      // 2. Missing file under media/drafts/ -> MISSING_LOCAL_IMAGE_FILE
      const missingMd: ParsedMarkdown = {
        ...validParsed,
        body: '![Missing](../../media/drafts/does-not-exist.png)',
      };
      const resMissing = runPreflightChecks(filePath, missingMd, {
        workspaceRoot: tempWorkspace,
      });
      expect(resMissing.valid).toBe(false);
      expect(resMissing.errors.some((e) => e.code === 'MISSING_LOCAL_IMAGE_FILE')).toBe(true);

      // 3. Inline paragraph image referencing media/drafts/ or media/ -> INLINE_LOCAL_IMAGE_NOT_SUPPORTED
      const inlineMd: ParsedMarkdown = {
        ...validParsed,
        body: 'Here is an inline image ![Sunset](../../media/drafts/sunset.jpg) inside a sentence.',
      };
      const resInline = runPreflightChecks(filePath, inlineMd, {
        workspaceRoot: tempWorkspace,
      });
      expect(resInline.valid).toBe(false);
      expect(resInline.errors.some((e) => e.code === 'INLINE_LOCAL_IMAGE_NOT_SUPPORTED')).toBe(
        true,
      );
      expect(resInline.errors[0].suggestion).toContain('standalone line');

      // 4. Unsupported extension under media/drafts/ -> INVALID_LOCAL_IMAGE_TYPE
      const badExtPath = path.join(draftsDir, 'archive.zip');
      fs.writeFileSync(badExtPath, 'pk-zip');
      const badExtMd: ParsedMarkdown = {
        ...validParsed,
        body: '![Zip](../../media/drafts/archive.zip)',
      };
      const resBadExt = runPreflightChecks(filePath, badExtMd, {
        workspaceRoot: tempWorkspace,
      });
      expect(resBadExt.valid).toBe(false);
      expect(resBadExt.errors.some((e) => e.code === 'INVALID_LOCAL_IMAGE_TYPE')).toBe(true);
    } finally {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });

  it('G9b: exempts local media references inside backtick code fences while still blocking identical lines outside them (tilde fences are not code to the mapper)', () => {
    const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-preflight-fence-'));
    try {
      fs.mkdirSync(path.join(tempWorkspace, 'media', 'drafts'), { recursive: true });

      // Real-world documentation bodies: an article that quotes Emit's own image rules.
      const quotedLines = [
        '![Broken example](media/drafts/ghost.png)',
        '![Promoted example](media/20260101_01M6GHOST0000000000000000-ghost.png)',
        'Inline text with ![Inline ghost](media/drafts/ghost.png) embedded.',
      ];

      // 1. Inside a fenced example block: never inspected, nothing queued for upload
      const fencedMd: ParsedMarkdown = {
        ...validParsed,
        body: ['Documenting the offline workflow:', '', '```md', ...quotedLines, '```'].join('\n'),
      };
      const resFenced = runPreflightChecks(filePath, fencedMd, { workspaceRoot: tempWorkspace });
      expect(resFenced.valid).toBe(true);
      expect(resFenced.errors).toHaveLength(0);
      expect(resFenced.draftImages).toHaveLength(0);
      // The fence content itself must be handed over untouched
      expect(resFenced.cleanedBody).toContain('![Broken example](media/drafts/ghost.png)');

      // 2. Tilde fences are deliberately NOT exempted, because the Portable Text mapper
      //    (markdownToPortableText) only recognizes backtick fences as code blocks. Exempting
      //    a `~~~` block here would let a local image path skip validation and still be converted
      //    into a real remote image block, producing a broken URL in production. The guard's
      //    exemption scope must stay a strict subset of what the mapper treats as code.
      const tildeFencedMd: ParsedMarkdown = {
        ...validParsed,
        body: ['~~~~~~~~~~~~~~~~~~~~', ...quotedLines, '~~~~~~~~~~~~~~~~~~~~'].join('\n'),
      };
      const resTilde = runPreflightChecks(filePath, tildeFencedMd, {
        workspaceRoot: tempWorkspace,
      });
      expect(resTilde.valid).toBe(false);
      expect(resTilde.errors.some((e) => e.code === 'MISSING_LOCAL_IMAGE_FILE')).toBe(true);
      expect(resTilde.errors.some((e) => e.code === 'LOCAL_IMAGE_DETECTED')).toBe(true);
      expect(resTilde.errors.some((e) => e.code === 'INLINE_LOCAL_IMAGE_NOT_SUPPORTED')).toBe(true);

      // 3. The exact same lines outside a fence are still reported by G5 / G11
      const bareMd: ParsedMarkdown = { ...validParsed, body: quotedLines.join('\n') };
      const resBare = runPreflightChecks(filePath, bareMd, { workspaceRoot: tempWorkspace });
      expect(resBare.valid).toBe(false);
      expect(resBare.errors.some((e) => e.code === 'MISSING_LOCAL_IMAGE_FILE')).toBe(true);
      expect(resBare.errors.some((e) => e.code === 'LOCAL_IMAGE_DETECTED')).toBe(true);
      expect(resBare.errors.some((e) => e.code === 'INLINE_LOCAL_IMAGE_NOT_SUPPORTED')).toBe(true);

      // 4. An unterminated fence must NOT suppress real violations in the rest of the body
      const unterminatedMd: ParsedMarkdown = {
        ...validParsed,
        body: ['![Missing](media/drafts/gone.png)', '', '```md', '```markdown'].join('\n'),
      };
      const resUnterminated = runPreflightChecks(filePath, unterminatedMd, {
        workspaceRoot: tempWorkspace,
      });
      expect(resUnterminated.valid).toBe(false);
      expect(resUnterminated.errors.some((e) => e.code === 'MISSING_LOCAL_IMAGE_FILE')).toBe(true);
    } finally {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });
});
