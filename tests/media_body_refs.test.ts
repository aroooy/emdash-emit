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
  canonicalToLocalMediaRefs,
  isCanonicalMediaUrl,
  isLocalMediaRef,
  mediaRefPrefixForArticle,
  storageKeyFromCanonicalUrl,
  storageKeyFromMirrorRef,
} from '../src/utils/media-body-refs.js';

const STORAGE_KEY = '01M67P0JW605ZJ5GV4YXB7W400.jpg';
const CANONICAL_URL = `/_emdash/api/media/file/${STORAGE_KEY}`;

/** Minimal fs stub: only the keys listed here "exist" under media/. */
function fsWith(...existingKeys: string[]) {
  const set = new Set(existingKeys);
  return { existsSync: (p: string) => set.has(p.replace(/^.*\/media\//, '')) };
}

describe('media-body-refs classification', () => {
  it('recognizes the canonical media file route and extracts its storageKey', () => {
    expect(isCanonicalMediaUrl(CANONICAL_URL)).toBe(true);
    expect(storageKeyFromCanonicalUrl(`![alt](${CANONICAL_URL})`)).toBe(STORAGE_KEY);
    expect(storageKeyFromCanonicalUrl('https://cdn.example.com/a.jpg')).toBeNull();
  });

  it('recognizes only a workspace-relative storageKey reference, never an arbitrary path', () => {
    expect(isLocalMediaRef(`media/${STORAGE_KEY}`)).toBe(true);
    expect(isLocalMediaRef(`  media/${STORAGE_KEY}  `)).toBe(true);
    // A leading slash makes it the canonical route shape, not a local ref.
    expect(isLocalMediaRef(CANONICAL_URL)).toBe(false);
    expect(isLocalMediaRef('./hero.png')).toBe(false);
    expect(isLocalMediaRef('media/drafts/shot.png')).toBe(false);
  });
});

describe('canonicalToLocalMediaRefs', () => {
  it('rewrites a standalone canonical line only when the mirror exists on disk', () => {
    const body = `Paragraph.\n\n![LG 背面端子](${CANONICAL_URL})\n`;
    const localized = canonicalToLocalMediaRefs(body, {
      mediaDir: '/ws/media',
      fs: fsWith(STORAGE_KEY),
    });
    expect(localized).toBe(`Paragraph.\n\n![LG 背面端子](media/${STORAGE_KEY})\n`);
  });

  it('leaves an unmirrored canonical line untouched so no broken local link is invented', () => {
    const body = `![alt](${CANONICAL_URL})`;
    const localized = canonicalToLocalMediaRefs(body, { mediaDir: '/ws/media', fs: fsWith() });
    expect(localized).toBe(body);
  });

  it('never rewrites external src, inline images, or opaque EmDash block fences', () => {
    const body = [
      '![ext](https://cdn.example.com/a.jpg)',
      'text ![inline](../../media/drafts/x.png) more',
      `<!--ec:block {"type":"image","url":"${CANONICAL_URL}"} -->`,
      CANONICAL_URL,
    ].join('\n');
    const localized = canonicalToLocalMediaRefs(body, {
      mediaDir: '/ws/media',
      fs: fsWith(STORAGE_KEY),
    });
    expect(localized).toBe(body);
  });

  it('preserves a trailing carriage return on a rewritten line', () => {
    const localized = canonicalToLocalMediaRefs(`![alt](${CANONICAL_URL})\r`, {
      mediaDir: '/ws/media',
      fs: fsWith(STORAGE_KEY),
    });
    expect(localized).toBe(`![alt](media/${STORAGE_KEY})\r`);
  });
});

describe('storageKeyFromMirrorRef', () => {
  it('resolves an exact storageKey reference verbatim', () => {
    expect(storageKeyFromMirrorRef(`media/${STORAGE_KEY}`, [])).toBe(STORAGE_KEY);
    expect(storageKeyFromMirrorRef(`../../media/${STORAGE_KEY}`, [])).toBeNull();
  });

  it('recovers a collision-suffixed or truncated stem from confirmed storageKeys', () => {
    const confirmed = new Set(['sample.png', 'other.jpg']);
    expect(storageKeyFromMirrorRef('media/sample--01M6TF1XXBS2KC9EVYG6RBT0J0.png', confirmed)).toBe(
      'sample.png',
    );
    expect(storageKeyFromMirrorRef('media/other.jpg', confirmed)).toBe('other.jpg');
  });

  it('returns null for a reference no confirmed mirror matches', () => {
    expect(storageKeyFromMirrorRef('media/hand-written.png', new Set(['sample.png']))).toBeNull();
    expect(storageKeyFromMirrorRef('./uploads/x.jpg', new Set(['sample.png']))).toBeNull();
  });
});

describe('mediaRefPrefixForArticle', () => {
  it('builds the depth from an article path two levels below the workspace root', () => {
    expect(mediaRefPrefixForArticle('posts/draft/20261111_01M67X-title.md')).toBe('../../');
    expect(mediaRefPrefixForArticle('articles/published/x.md')).toBe('../../');
    expect(mediaRefPrefixForArticle('root-level.md')).toBe('../');
  });
});
