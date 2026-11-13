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
  localizeArticleMediaRefs,
  mediaRefPrefixForArticle,
  storageKeyFromCanonicalUrl,
  storageKeyFromMirrorRef,
  scanArticleMediaReferences,
} from '../src/utils/media-body-refs.js';
import { FENCE_POLICY } from '../src/utils/media-refs.js';

const STORAGE_KEY = '01M67P0JW605ZJ5GV4YXB7W400.jpg';
const CANONICAL_URL = `/_emdash/api/media/file/${STORAGE_KEY}`;
/** The disk spelling for an article two levels below the workspace root (`posts/draft/…`). */
const ARTICLE_REL_PATH = 'posts/draft/20261111_01M67P0JW605ZJ5GV4YXB7W40-title.md';
const DEPTH_LOCAL_REF = `../../media/${STORAGE_KEY}`;

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

  it('recognizes a storageKey reference with or without article-relative depth, never an arbitrary path', () => {
    expect(isLocalMediaRef(`media/${STORAGE_KEY}`)).toBe(true);
    expect(isLocalMediaRef(`  media/${STORAGE_KEY}  `)).toBe(true);
    // An article spells its mirror relative to its own directory so preview resolves the link.
    expect(isLocalMediaRef(DEPTH_LOCAL_REF)).toBe(true);
    expect(isLocalMediaRef('../media/shot.jpg')).toBe(true);
    expect(isLocalMediaRef('./media/shot.jpg')).toBe(true);
    // A leading slash makes it the canonical route shape, not a local ref.
    expect(isLocalMediaRef(CANONICAL_URL)).toBe(false);
    expect(isLocalMediaRef('./hero.png')).toBe(false);
    expect(isLocalMediaRef('media/drafts/shot.png')).toBe(false);
    // Depth alone does not make a staging draft or an unrelated folder a canonicalized local reference.
    expect(isLocalMediaRef('../../media/drafts/shot.png')).toBe(false);
    expect(isLocalMediaRef('../../uploads/x.jpg')).toBe(false);
  });
});

describe('canonicalToLocalMediaRefs', () => {
  it('rewrites a standalone canonical line to the article-relative mirror path when one is given', () => {
    const body = `Paragraph.\n\n![LG 背面端子](${CANONICAL_URL})\n`;
    const localized = canonicalToLocalMediaRefs(body, {
      mediaDir: '/ws/media',
      fs: fsWith(STORAGE_KEY),
      articleRelPath: ARTICLE_REL_PATH,
    });
    expect(localized).toBe(`Paragraph.\n\n![LG 背面端子](${DEPTH_LOCAL_REF})\n`);
  });

  it('spells the depth for a published article and for an article at the workspace root', () => {
    const body = `![alt](${CANONICAL_URL})`;
    expect(
      canonicalToLocalMediaRefs(body, {
        mediaDir: '/ws/media',
        fs: fsWith(STORAGE_KEY),
        articleRelPath: 'posts/published/20261111_01M67P0JW605ZJ5GV4YXB7W40-title.md',
      }),
    ).toBe(`![alt](../../media/${STORAGE_KEY})`);
    expect(
      canonicalToLocalMediaRefs(body, {
        mediaDir: '/ws/media',
        fs: fsWith(STORAGE_KEY),
        articleRelPath: 'root-level.md',
      }),
    ).toBe(`![alt](../media/${STORAGE_KEY})`);
  });

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
  it('resolves an exact storageKey reference verbatim, with or without article-relative depth', () => {
    expect(storageKeyFromMirrorRef(`media/${STORAGE_KEY}`, [])).toBe(STORAGE_KEY);
    expect(storageKeyFromMirrorRef(DEPTH_LOCAL_REF, [])).toBe(STORAGE_KEY);
    expect(storageKeyFromMirrorRef('../media/shot.jpg', [])).toBe('shot.jpg');
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

describe('localizeArticleMediaRefs', () => {
  /** fs stub keyed by workspace-relative paths (`media/<key>`, `media/drafts/<name>`). */
  function fsWithFiles(...workspacePaths: string[]) {
    const set = new Set(workspacePaths);
    return { existsSync: (p: string) => set.has(String(p).replace(/^\/ws\//, '')) };
  }

  it('prefers the article-relative spelling so a preview resolves the mirror offline', () => {
    const localized = localizeArticleMediaRefs(`![alt](${CANONICAL_URL})`, {
      workspaceRoot: '/ws',
      articleRelPath: ARTICLE_REL_PATH,
      fs: fsWithFiles(`media/${STORAGE_KEY}`),
    });
    expect(localized).toBe(`![alt](${DEPTH_LOCAL_REF})`);
  });

  it('falls back to the legacy depth-free spelling when that is what the disk already carries', () => {
    // A workspace built before article-relative refs existed keeps `media/<storageKey>` on disk. Reading it
    // back in its own spelling is what keeps an untouched article from reporting a phantom media rewrite.
    const localized = localizeArticleMediaRefs(`![alt](media/${STORAGE_KEY})`, {
      workspaceRoot: '/ws',
      articleRelPath: ARTICLE_REL_PATH,
      fs: fsWithFiles(`media/${STORAGE_KEY}`),
      preferLegacyRef: true,
    });
    expect(localized).toBe(`![alt](media/${STORAGE_KEY})`);
  });

  it('re-spells a disk file that carries the legacy form into the article-relative form', () => {
    const localized = localizeArticleMediaRefs(`![alt](media/${STORAGE_KEY})`, {
      workspaceRoot: '/ws',
      articleRelPath: ARTICLE_REL_PATH,
      fs: fsWithFiles(`media/${STORAGE_KEY}`),
    });
    expect(localized).toBe(`![alt](${DEPTH_LOCAL_REF})`);
  });

  it('leaves a disk file already written in the article-relative form byte-identical', () => {
    const body = `![alt](${DEPTH_LOCAL_REF})`;
    expect(
      localizeArticleMediaRefs(body, {
        workspaceRoot: '/ws',
        articleRelPath: ARTICLE_REL_PATH,
        fs: fsWithFiles(`media/${STORAGE_KEY}`),
      }),
    ).toBe(body);
  });

  it('keeps the canonical URL when no mirror exists, so no broken local link is invented', () => {
    const body = `![alt](${CANONICAL_URL})`;
    expect(
      localizeArticleMediaRefs(body, {
        workspaceRoot: '/ws',
        articleRelPath: ARTICLE_REL_PATH,
        fs: fsWithFiles(),
      }),
    ).toBe(body);
  });

  it('localizes only a reference whose storageKey is confirmed mirrored, never a hand-written path', () => {
    const localized = localizeArticleMediaRefs(`![alt](${CANONICAL_URL})`, {
      workspaceRoot: '/ws',
      articleRelPath: ARTICLE_REL_PATH,
      fs: fsWithFiles('media/drafts/shot.png'),
    });
    expect(localized).toBe(`![alt](${CANONICAL_URL})`);
  });
});

describe('scanArticleMediaReferences (Layer 0 workspace contract)', () => {
  it('collects markdown and HTML media refs from the body, skipping external URLs', () => {
    const body = [
      'Intro text',
      '![Hero](media/01M6_hero.jpg)',
      '![Ext](https://example.com/logo.png)',
      '<img src="../../media/banner.png" alt="Banner" />',
      '![Again](media/01M6_hero.jpg)',
    ].join('\n');

    expect(scanArticleMediaReferences(body)).toEqual([
      '../../media/banner.png',
      'media/01M6_hero.jpg',
    ]);
  });

  it('honours the declared fence policy: backtick-only for guards, backtick-or-tilde for diagnostics', () => {
    const body = [
      '```',
      '![fenced](media/fenced.png)',
      '```',
      '~~~',
      '![tilde](media/tilde.png)',
      '~~~',
    ].join('\n');

    // Guard policy exempts only backtick fences, so the tilde-fenced ref is still reported.
    expect(scanArticleMediaReferences(body)).toEqual(['media/tilde.png']);
    // Diagnostic policy treats both fence kinds as code, so nothing is reported.
    expect(scanArticleMediaReferences(body, FENCE_POLICY.diagnostic)).toEqual([]);
  });
});
