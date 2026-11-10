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
  pullMedia,
  promoteDraftMediaFile,
  collectArticleReferencedMediaIds,
  collectArticleStorageKeys,
  collectLocalMediaMirrorCandidates,
  pullArticleMedia,
} from '../src/sync/media.js';
import { formatOrphanMediaWarning } from '../src/cli/commands/pull.js';

describe('Media Sync Engine', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-media-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('pulls media metadata (including storageKey, contentHash, status) and files into media/ directory', async () => {
    const mockItems = [
      {
        id: '01M6A7SJ82SMPWKTJ7GSSDC6VZ',
        filename: 'sample-image.jpg',
        mimeType: 'image/jpeg',
        size: 15,
        width: 800,
        height: 600,
        alt: 'Sample Alt',
        caption: 'Sample Caption',
        storageKey: '01M6A7SJ82S6P98MN1YSPQ33YG.01M6A7SJEN7HNDPPM537J23R19.jpeg',
        contentHash: 'sha1:0e5d66b7644b9d2107b1fe95763df391b398e3df',
        status: 'ready' as const,
        url: '/_emdash/api/media/file/01M6A7SJ82S6P98MN1YSPQ33YG.01M6A7SJEN7HNDPPM537J23R19.jpeg',
        createdAt: '2026-11-01T00:22:48.322Z',
      },
    ];

    const fakeImageBuffer = Buffer.from('fake image data');

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/media?')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { items: mockItems } }),
        });
      }
      if (url.includes('/_emdash/api/media/file/')) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () =>
            fakeImageBuffer.buffer.slice(
              fakeImageBuffer.byteOffset,
              fakeImageBuffer.byteOffset + fakeImageBuffer.byteLength,
            ),
        });
      }
      return Promise.reject(new Error('Unknown url'));
    });

    const res = await pullMedia({
      workspaceRoot: tempDir,
      origin: 'https://example.com',
      token: 'fake-token',
      limit: 10,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.total).toBe(1);
    expect(res.downloaded).toBe(1);

    const yamlPath = path.join(
      tempDir,
      'media',
      '20261101_01M6A7SJ82SMPWKTJ7GSSDC6VZ-sample-image.yaml',
    );
    expect(fs.existsSync(yamlPath)).toBe(true);
    const yamlContent = fs.readFileSync(yamlPath, 'utf8');
    expect(yamlContent).toContain('id: 01M6A7SJ82SMPWKTJ7GSSDC6VZ');
    expect(yamlContent).toContain('alt: Sample Alt');
    expect(yamlContent).toContain(
      'storageKey: 01M6A7SJ82S6P98MN1YSPQ33YG.01M6A7SJEN7HNDPPM537J23R19.jpeg',
    );
    expect(yamlContent).toContain('sha1:0e5d66b7644b9d2107b1fe95763df391b398e3df');
    expect(yamlContent).toContain('status: ready');

    const filePath = path.join(
      tempDir,
      'media',
      '20261101_01M6A7SJ82SMPWKTJ7GSSDC6VZ-sample-image.jpg',
    );
    expect(fs.existsSync(filePath)).toBe(true);

    // Second pull skips re-downloading if size matches
    const res2 = await pullMedia({
      workspaceRoot: tempDir,
      origin: 'https://example.com',
      token: 'fake-token',
      limit: 10,
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    expect(res2.downloaded).toBe(0);
    expect(res2.skipped).toBe(1);
  });

  it('preserves media/drafts/ untouched during pullMedia with prune: true', async () => {
    const draftsDir = path.join(tempDir, 'media', 'drafts');
    fs.mkdirSync(draftsDir, { recursive: true });
    const draftImg = path.join(draftsDir, 'offline-sunset.jpg');
    fs.writeFileSync(draftImg, 'draft-bytes');

    // Stale top-level mirrored media that is no longer on remote
    const staleMedia = path.join(
      tempDir,
      'media',
      '20261031_01M67P08DXFTYDPFRTJCC4XMP8-stale.yaml',
    );
    fs.writeFileSync(staleMedia, 'id: 01M67P08DXFTYDPFRTJCC4XMP8\n');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { items: [] } }),
    });

    const res = await pullMedia({
      workspaceRoot: tempDir,
      origin: 'https://aroooy.net',
      token: 'fake-token',
      prune: true,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.deleted).toBe(1);
    expect(fs.existsSync(staleMedia)).toBe(false);
    expect(fs.existsSync(draftImg)).toBe(true);
  });

  it('promotes a draft media file into canonical media/<yyyyMMdd>_<id>-<name> with companion YAML', () => {
    const draftsDir = path.join(tempDir, 'media', 'drafts');
    fs.mkdirSync(draftsDir, { recursive: true });
    const draftPath = path.join(draftsDir, 'flight-sunset.png');
    fs.writeFileSync(draftPath, Buffer.from([1, 2, 3, 4]));

    const relPromoted = promoteDraftMediaFile({
      workspaceRoot: tempDir,
      origin: 'https://aroooy.net',
      draftAbsPath: draftPath,
      item: {
        id: '01M6TF1XXBS2KC9EVYG6RBT0J0',
        filename: 'flight-sunset.png',
        mimeType: 'image/png',
        size: 4,
        width: 100,
        height: 80,
        alt: 'Sunset over clouds',
        storageKey: '01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png',
        contentHash: 'sha1:4a5eb7171b58e08a6881721e3b43d5a44419a2be',
        status: 'ready',
        url: '/_emdash/api/media/file/01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png',
        createdAt: '2026-11-07T07:37:33.355Z',
      },
    });

    expect(relPromoted).toBe('media/20261107_01M6TF1XXBS2KC9EVYG6RBT0J0-flight-sunset.png');
    expect(fs.existsSync(draftPath)).toBe(false);
    expect(fs.existsSync(path.join(tempDir, relPromoted))).toBe(true);

    const yamlPath = path.join(
      tempDir,
      'media',
      '20261107_01M6TF1XXBS2KC9EVYG6RBT0J0-flight-sunset.yaml',
    );
    expect(fs.existsSync(yamlPath)).toBe(true);
    const yamlText = fs.readFileSync(yamlPath, 'utf8');
    expect(yamlText).toContain(
      'storageKey: 01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png',
    );
    expect(yamlText).toContain(
      'url: /_emdash/api/media/file/01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png',
    );
  });

  it('preserves local alt and contentHash when pullMedia refreshes YAML, and cleans up duplicate date-prefixed files for the same media ID (B-1 / B-2)', async () => {
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    // Simulate a locally promoted file with a fabricated date prefix (20261107) and local alt/contentHash
    const oldYaml = path.join(mediaDir, '20261107_01M6TF1XXBS2KC9EVYG6RBT0J0-hero.yaml');
    const oldPng = path.join(mediaDir, '20261107_01M6TF1XXBS2KC9EVYG6RBT0J0-hero.png');
    fs.writeFileSync(
      oldYaml,
      [
        'id: 01M6TF1XXBS2KC9EVYG6RBT0J0',
        'filename: hero.png',
        'mimeType: image/png',
        'size: 4',
        'alt: LOCAL ALT TEXT',
        'storageKey: 01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png',
        'contentHash: sha1:4a5eb7171b58e08a6881721e3b43d5a44419a2be',
        'status: ready',
        'url: /_emdash/api/media/file/01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png',
        'createdAt: "2026-11-07T08:00:00.000Z"',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(oldPng, Buffer.from([1, 2, 3, 4]));

    // Remote list returns authoritative createdAt (2020-03-04) and empty alt/contentHash
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          items: [
            {
              id: '01M6TF1XXBS2KC9EVYG6RBT0J0',
              filename: 'hero.png',
              mimeType: 'image/png',
              size: 4,
              alt: null,
              contentHash: null,
              storageKey: '01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png',
              url: '/_emdash/api/media/file/01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png',
              createdAt: '2020-03-04T21:40:00.000Z',
            },
          ],
        },
      }),
    });

    await pullMedia({
      workspaceRoot: tempDir,
      origin: 'https://aroooy.net',
      token: 'fake-token',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const filesAfter = fs.readdirSync(mediaDir).sort();
    expect(filesAfter).toEqual([
      '20200305_01M6TF1XXBS2KC9EVYG6RBT0J0-hero.png',
      '20200305_01M6TF1XXBS2KC9EVYG6RBT0J0-hero.yaml',
    ]);

    const mergedYaml = fs.readFileSync(
      path.join(mediaDir, '20200305_01M6TF1XXBS2KC9EVYG6RBT0J0-hero.png'.replace('.png', '.yaml')),
      'utf8',
    );
    expect(mergedYaml).toContain('alt: LOCAL ALT TEXT');
    expect(mergedYaml).toContain('sha1:4a5eb7171b58e08a6881721e3b43d5a44419a2be');
  });

  it('collects all referenced media ULIDs from frontmatter featuredImage and body markdown/html', () => {
    const content = `---
title: Sample Article
id: 01M67ART000000000000000001
featuredImage: 01M67MEDA00000000000000001
---

Here is a paragraph with an image:
![Photo 1](/_emdash/api/media/file/01M67MEDA00000000000000002.jpg)

Another relative image reference:
![Photo 2](media/20261108_01M67MEDA00000000000000003-my-photo.png)

And an HTML tag:
<img src="/_emdash/api/media/file/01M67MEDA00000000000000004" alt="HTML photo" />

Duplicate reference:
![Photo 1 again](/api/media/file/01M67MEDA00000000000000002)
`;

    const mediaIds = collectArticleReferencedMediaIds(content);
    expect(mediaIds).toEqual([
      '01M67MEDA00000000000000001',
      '01M67MEDA00000000000000002',
      '01M67MEDA00000000000000003',
      '01M67MEDA00000000000000004',
    ]);
  });

  it('pulls only targeted media referenced by an article via pullMedia({ article: ... })', async () => {
    // 1. Setup local article file
    const postsDir = path.join(tempDir, 'posts', 'draft');
    fs.mkdirSync(postsDir, { recursive: true });
    const articleFilePath = path.join(postsDir, '20261108_01M67ART000000000000000001-test.md');
    fs.writeFileSync(
      articleFilePath,
      `---
id: 01M67ART000000000000000001
title: Targeted Media Article
featuredImage: 01M67TARGET000000000000001
---

Body with targeted image:
![Inline](/_emdash/api/media/file/01M67TARGET000000000000002-inline-chart.png)
`,
      'utf8',
    );

    const fakeImageBuffer = Buffer.from('targeted media content');
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/media/01M67TARGET000000000000001')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              item: {
                id: '01M67TARGET000000000000001',
                filename: 'hero-banner.jpg',
                mimeType: 'image/jpeg',
                size: fakeImageBuffer.length,
                url: '/_emdash/api/media/file/hero-banner.jpg',
                createdAt: '2026-11-08T12:00:00.000Z',
              },
            },
          }),
        });
      }
      if (url.includes('/api/media/01M67TARGET000000000000002')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              item: {
                id: '01M67TARGET000000000000002',
                filename: 'inline-chart.png',
                mimeType: 'image/png',
                size: fakeImageBuffer.length,
                url: '/_emdash/api/media/file/inline-chart.png',
                createdAt: '2026-11-08T12:01:00.000Z',
              },
            },
          }),
        });
      }
      if (url.includes('/_emdash/api/media/file/')) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () =>
            fakeImageBuffer.buffer.slice(
              fakeImageBuffer.byteOffset,
              fakeImageBuffer.byteOffset + fakeImageBuffer.byteLength,
            ),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const res = await pullMedia({
      workspaceRoot: tempDir,
      origin: 'https://example.com',
      token: 'fake-token',
      article: '01M67ART000000000000000001',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.total).toBe(2);
    expect(res.downloaded).toBe(2);
    expect(res.articleId).toBe('01M67ART000000000000000001');
    expect(res.mediaIds).toEqual(['01M67TARGET000000000000001', '01M67TARGET000000000000002']);
    // Both records resolved and mirrored, so nothing is reported as orphan. A body URL that carries
    // the media record id instead of a storageKey is not a storageKey and is never collected.
    expect(res.orphanStorageKeys).toEqual([]);

    const mediaDir = path.join(tempDir, 'media');
    expect(
      fs.existsSync(path.join(mediaDir, '20261108_01M67TARGET000000000000001-hero-banner.jpg')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(mediaDir, '20261108_01M67TARGET000000000000001-hero-banner.yaml')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(mediaDir, '20261108_01M67TARGET000000000000002-inline-chart.png')),
    ).toBe(true);
  });

  it('collects ULID-based storageKeys from bodies including legacy containers and opaque fences', () => {
    const body = [
      '![ok](/_emdash/api/media/file/01M67LEGACYX00000000000001.jpg)',
      '[dimage url="/_emdash/api/media/file/01M67LEGACYX00000000000002.png" control=true]',
      '<!--ec:block {"type":"custom","src":"/_emdash/api/media/file/01M67LEGACYX00000000000003.webp"} -->',
      '![tpl](/_emdash/api/media/file/${item.storageKey})',
      '<img src="/_emdash/api/media/file/01M67LEGACYX00000000000004.01M67LEGACYX00000000000005.jpeg">',
    ].join('\n');

    const keys = collectArticleStorageKeys(body);
    expect(keys.map((k) => k.storageKey)).toEqual([
      '01M67LEGACYX00000000000001.jpg',
      '01M67LEGACYX00000000000002.png',
      '01M67LEGACYX00000000000003.webp',
      '01M67LEGACYX00000000000004.01M67LEGACYX00000000000005.jpeg',
    ]);
    expect(keys[3].ulids).toEqual(['01M67LEGACYX00000000000004', '01M67LEGACYX00000000000005']);
  });

  it('reports an orphan storageKey when the media record lookup fails (legacy WP assets)', async () => {
    const postsDir = path.join(tempDir, 'posts', 'draft');
    fs.mkdirSync(postsDir, { recursive: true });
    fs.writeFileSync(
      path.join(postsDir, '20210620_01M67ART000000000000000009-legacy.md'),
      `---
id: 01M67ART000000000000000009
title: Legacy Asset Article
collection: posts
status: draft
locale: ja
---

![legacy](/_emdash/api/media/file/01M67LEGACYX0000000000000A.jpg)
`,
      'utf8',
    );

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/media/01M67LEGACYX0000000000000A')) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const res = await pullMedia({
      workspaceRoot: tempDir,
      origin: 'https://example.com',
      token: 'fake-token',
      article: '01M67ART000000000000000009',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    // The reference is detected and reported. Emit never downloads it and never invents a media record.
    expect(res.total).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.orphanStorageKeys).toEqual(['01M67LEGACYX0000000000000A.jpg']);
    expect(res.verifiedStorageKeys).toEqual([]);
    expect(res.downloaded).toBe(0);
    expect(res.skipped).toBe(0);

    const mediaDir = path.join(tempDir, 'media');
    expect(
      fs.readdirSync(mediaDir).filter((f) => f.includes('01M67LEGACYX0000000000000A')),
    ).toEqual([]);

    // The file route is never probed by a pull; only doctor may probe it, and only when asked.
    expect(mockFetch.mock.calls.map((c) => String(c[0]))).not.toContain(
      'https://example.com/_emdash/api/media/file/01M67LEGACYX0000000000000A.jpg',
    );
  });

  it('mirrors a healthy asset whose record reports the body storageKey without orphan reporting', async () => {
    const postsDir = path.join(tempDir, 'posts', 'draft');
    fs.mkdirSync(postsDir, { recursive: true });
    fs.writeFileSync(
      path.join(postsDir, '20210620_01M67ART000000000000000010-healthy.md'),
      `---
id: 01M67ART000000000000000010
title: Healthy Asset Article
featuredImage: 01M67HEALTHYX000000000000B
collection: posts
status: draft
locale: ja
---

![ok](/_emdash/api/media/file/01M67HEALTHYX000000000000B.jpg)
`,
      'utf8',
    );

    const fakeImageBuffer = Buffer.from('healthy image bytes');
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/media/01M67HEALTHYX000000000000B')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              item: {
                id: '01M67HEALTHYX000000000000B',
                filename: 'hero-photo.jpg',
                mimeType: 'image/jpeg',
                size: fakeImageBuffer.length,
                storageKey: '01M67HEALTHYX000000000000B.jpg',
                url: '/_emdash/api/media/file/01M67HEALTHYX000000000000B.jpg',
                createdAt: '2021-06-20T12:00:00.000Z',
              },
            },
          }),
        });
      }
      if (url.includes('/_emdash/api/media/file/01M67HEALTHYX000000000000B.jpg')) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () =>
            fakeImageBuffer.buffer.slice(
              fakeImageBuffer.byteOffset,
              fakeImageBuffer.byteOffset + fakeImageBuffer.byteLength,
            ),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const res = await pullArticleMedia({
      workspaceRoot: tempDir,
      origin: 'https://example.com',
      token: 'fake-token',
      article: '01M67ART000000000000000010',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.total).toBe(1);
    expect(res.downloaded).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.orphanStorageKeys).toEqual([]);
    expect(
      fs.existsSync(
        path.join(tempDir, 'media', '20210620_01M67HEALTHYX000000000000B-hero-photo.jpg'),
      ),
    ).toBe(true);
  });

  it('confirms a body storageKey when the record resolves under that id but reports another storageKey', async () => {
    // The production ID-space shape: `collectArticleReferencedMediaIds` accepts a ULID found in a file
    // route, so Emit fetches GET /_emdash/api/media/<storageKey-looking ULID> and the server answers
    // with the real record whose own storageKey differs. The asset is mirrored under its true key; the
    // body key must be reported as verified, never as missing, because a "missing" report invites a
    // duplicate registration of a record that demonstrably exists.
    const postsDir = path.join(tempDir, 'posts', 'draft');
    fs.mkdirSync(postsDir, { recursive: true });
    fs.writeFileSync(
      path.join(postsDir, '20210620_01M67ART000000000000000012-mismatch.md'),
      `---
id: 01M67ART000000000000000012
title: Mismatched Storage Key Article
collection: posts
status: draft
locale: ja
---

![mismatch](/_emdash/api/media/file/01M67MSMATCHX000000000000E.jpg)
`,
      'utf8',
    );

    const fakeImageBuffer = Buffer.from('other bytes');
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/media/01M67MSMATCHX000000000000E')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              item: {
                id: '01M67MSMATCHX000000000000E',
                filename: 'other-name.jpg',
                mimeType: 'image/jpeg',
                size: fakeImageBuffer.length,
                storageKey: '01M67THERKEYX000000000000F.jpg',
                url: '/_emdash/api/media/file/01M67THERKEYX000000000000F.jpg',
                createdAt: '2021-06-20T12:00:00.000Z',
              },
            },
          }),
        });
      }
      if (url.includes('/_emdash/api/media/file/01M67THERKEYX000000000000F.jpg')) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () =>
            fakeImageBuffer.buffer.slice(
              fakeImageBuffer.byteOffset,
              fakeImageBuffer.byteOffset + fakeImageBuffer.byteLength,
            ),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const res = await pullArticleMedia({
      workspaceRoot: tempDir,
      origin: 'https://example.com',
      token: 'fake-token',
      article: '01M67ART000000000000000012',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.total).toBe(2);
    expect(res.downloaded).toBe(1);
    // The record was fetched successfully under its own primary key and mirrored, but the body baked a
    // different storageKey. Emit records that key as verified — the ULID matched a real record it just
    // resolved — and never as missing, because declaring it missing invites a duplicate registration.
    expect(res.orphanStorageKeys).toEqual([]);
    expect(res.verifiedStorageKeys).toEqual(['01M67MSMATCHX000000000000E.jpg']);
    expect(mockFetch.mock.calls.map((c) => String(c[0]))).not.toContain(
      'https://example.com/_emdash/api/media/file/01M67MSMATCHX000000000000E.jpg',
    );
  });

  it('never prunes leftover legacy_* files but still prunes stale real media records', async () => {
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    // Residue from the removed file-route fallback: Emit no longer writes these and does not delete
    // them either, so a human must clean them up by hand (announced in the release notes).
    fs.writeFileSync(path.join(mediaDir, 'legacy_01M67LEGACYX0000000000000C.jpg'), 'legacy bytes');
    fs.writeFileSync(
      path.join(mediaDir, 'legacy_01M67LEGACYX0000000000000C.yaml'),
      ['id: null', 'storageKey: 01M67LEGACYX0000000000000C.jpg', 'synthesized: true', ''].join(
        '\n',
      ),
    );
    fs.writeFileSync(
      path.join(mediaDir, '20261108_01M67GONEAAAAAAAAAAAAAA0K5-stale.jpg'),
      'stale bytes',
    );

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/media?')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { items: [], nextCursor: null } }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const res = await pullMedia({
      workspaceRoot: tempDir,
      origin: 'https://example.com',
      token: 'fake-token',
      all: true,
      prune: true,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.deleted).toBe(1);
    expect(fs.existsSync(path.join(mediaDir, 'legacy_01M67LEGACYX0000000000000C.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(mediaDir, 'legacy_01M67LEGACYX0000000000000C.yaml'))).toBe(true);
  });

  it('does not re-download a mirrored asset whose storageKey is already local (idempotent pull)', async () => {
    const postsDir = path.join(tempDir, 'posts', 'draft');
    fs.mkdirSync(postsDir, { recursive: true });
    fs.writeFileSync(
      path.join(postsDir, '20210620_01M67ART000000000000000011-idempotent.md'),
      `---
id: 01M67ART000000000000000011
title: Idempotent Pull Article
featuredImage: 01M67HEALTHYX000000000000D
collection: posts
status: draft
locale: ja
---

![ok](/_emdash/api/media/file/01M67HEALTHYX000000000000D.jpg)
`,
      'utf8',
    );

    const fakeImageBuffer = Buffer.from('already on disk');
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/media/01M67HEALTHYX000000000000D')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              item: {
                id: '01M67HEALTHYX000000000000D',
                filename: 'hero-photo.jpg',
                mimeType: 'image/jpeg',
                size: fakeImageBuffer.length,
                storageKey: '01M67HEALTHYX000000000000D.jpg',
                url: '/_emdash/api/media/file/01M67HEALTHYX000000000000D.jpg',
                createdAt: '2021-06-20T12:00:00.000Z',
              },
            },
          }),
        });
      }
      if (url.includes('/_emdash/api/media/file/01M67HEALTHYX000000000000D.jpg')) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () =>
            fakeImageBuffer.buffer.slice(
              fakeImageBuffer.byteOffset,
              fakeImageBuffer.byteOffset + fakeImageBuffer.byteLength,
            ),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const first = await pullArticleMedia({
      workspaceRoot: tempDir,
      origin: 'https://example.com',
      token: 'fake-token',
      article: '01M67ART000000000000000011',
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    expect(first.downloaded).toBe(1);

    const second = await pullArticleMedia({
      workspaceRoot: tempDir,
      origin: 'https://example.com',
      token: 'fake-token',
      article: '01M67ART000000000000000011',
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    expect(second.skipped).toBe(1);
    expect(second.downloaded).toBe(0);
    expect(second.orphanStorageKeys).toEqual([]);
  });

  it('formats an actionable unresolved-media warning that refuses to assume a missing record', () => {
    const warning = formatOrphanMediaWarning(['01M67LEGACYX0000000000000A.jpg']);
    expect(warning).toContain('[UNRESOLVED_MEDIA_ASSET]');
    expect(warning).toContain('01M67LEGACYX0000000000000A.jpg');
    expect(warning).toContain('GET /_emdash/api/media/{id} searches the primary key');
    expect(warning).toContain('does not prove the record is missing');
    expect(warning).toContain('wrangler d1 SELECT');
    expect(warning).toContain('blind INSERT can create a duplicate');
    expect(warning).toContain('Emit mirrors records and never repairs server data');
    // The warning must never assert that the record is absent, nor tell the user to insert it.
    expect(warning).not.toContain('have no EmDash media record');
    expect(warning).not.toContain('Register the missing media records');

    // Nothing unresolved means no warning line at all.
    expect(formatOrphanMediaWarning([])).toBe('');
    expect(formatOrphanMediaWarning(undefined)).toBe('');
  });

  it('mirrors a record whose storageKey differs from its id and reports nothing as orphan (ID-space regression)', async () => {
    // Two distinct ID spaces: `GET /_emdash/api/media/{id}` keys on the D1 primary key, while the
    // body URL carries the storageKey. A migrated WordPress import can store a record whose
    // storageKey ULID is NOT its record id, so matching by "the first segment of the body URL" would
    // hit no record and falsely report an existing asset as orphaned. The canonical path must resolve
    // the real record and mirror it under that record's own filename.
    const postsDir = path.join(tempDir, 'posts', 'draft');
    fs.mkdirSync(postsDir, { recursive: true });
    fs.writeFileSync(
      path.join(postsDir, '20210620_01M67ARTICLEIDXY0000000123-mixed-id-space.md'),
      `---
id: 01M67ARTICLEIDXY0000000123
title: Mixed ID Space Article
collection: posts
status: draft
locale: ja
---

![mixed](/_emdash/api/media/file/01M67STRGKEYX0000000123456.jpg)
`,
      'utf8',
    );

    const imageBuffer = Buffer.from('mixed id space bytes');
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/media/01M67STRGKEYX0000000123456')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              item: {
                id: '01M67ARTCLEDXY000000012345',
                filename: 'wp-import-photo.jpg',
                mimeType: 'image/jpeg',
                size: imageBuffer.length,
                storageKey: '01M67STRGKEYX0000000123456.jpg',
                url: '/_emdash/api/media/file/01M67STRGKEYX0000000123456.jpg',
                createdAt: '2021-06-20T12:00:00.000Z',
              },
            },
          }),
        });
      }
      if (url.includes('/_emdash/api/media/file/01M67STRGKEYX0000000123456.jpg')) {
        return Promise.resolve({ ok: true, arrayBuffer: async () => imageBuffer.buffer });
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const res = await pullArticleMedia({
      workspaceRoot: tempDir,
      origin: 'https://example.com',
      token: 'fake-token',
      article: '01M67ARTICLEIDXY0000000123',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.total).toBe(1);
    expect(res.downloaded).toBe(1);
    expect(res.failed).toBe(0);
    // The asset is mirrored under the record's own id, never as a synthesized legacy_* pair.
    const mediaFiles = fs.readdirSync(path.join(tempDir, 'media'));
    expect(mediaFiles).toContain('20210620_01M67ARTCLEDXY000000012345-wp-import-photo.jpg');
    expect(mediaFiles.some((f) => f.startsWith('legacy_'))).toBe(false);
  });

  it('downgrades an unresolved body storageKey to verified when a local mirror already proves it', async () => {
    // The canonical id lookup cannot resolve this key (it is a storageKey, not a record id), but the
    // media/ companion YAML already records both ids for the same asset. A confirmed local match must
    // downgrade the reference to verified instead of reporting it as unresolved, because declaring it
    // missing would invite a duplicate registration of a record that exists under another primary key.
    const postsDir = path.join(tempDir, 'posts', 'draft');
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(postsDir, { recursive: true });
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(
      path.join(postsDir, '20210620_01M67ART000000000000000013-mirror-proof.md'),
      `---
id: 01M67ART000000000000000013
title: Mirror Proof Article
collection: posts
status: draft
locale: ja
---

![mirror](/_emdash/api/media/file/01M67STRGKEYX0000000123456.jpg)
`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(mediaDir, '20210620_01M67THERKEYX000000000000F-mirror-photo.jpg'),
      'mirror bytes',
    );
    fs.writeFileSync(
      path.join(mediaDir, '20210620_01M67THERKEYX000000000000F-mirror-photo.yaml'),
      [
        'id: 01M67THERKEYX000000000000F',
        'filename: mirror-photo.jpg',
        'storageKey: 01M67STRGKEYX0000000123456.jpg',
        'mimeType: image/jpeg',
        '',
      ].join('\n'),
    );

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/media/01M67STRGKEYX0000000123456')) {
        // The exact failure mode the production investigation described: the record exists, but this
        // endpoint searches the primary key and the body supplied a storageKey, so it 404s.
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const res = await pullArticleMedia({
      workspaceRoot: tempDir,
      origin: 'https://example.com',
      token: 'fake-token',
      article: '01M67ART000000000000000013',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.failed).toBe(1);
    expect(res.orphanStorageKeys).toEqual([]);
    expect(res.verifiedStorageKeys).toEqual(['01M67STRGKEYX0000000123456.jpg']);
  });

  it('indexes local mirror companions by both record id and storageKey, ignoring legacy residue', () => {
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(
      path.join(mediaDir, '20210620_01M67HEALTHYX000000000000B-indexed.jpg'),
      'bytes',
    );
    fs.writeFileSync(
      path.join(mediaDir, '20210620_01M67HEALTHYX000000000000B-indexed.yaml'),
      ['id: 01M67HEALTHYX000000000000B', 'storageKey: 01M67LEGACYX00000000000002.jpg', ''].join(
        '\n',
      ),
    );
    fs.writeFileSync(path.join(mediaDir, 'legacy_01M67LEGACYX00000000000003.jpg'), 'residue');
    fs.writeFileSync(
      path.join(mediaDir, 'legacy_01M67LEGACYX00000000000003.yaml'),
      ['id: 01M67LEGACYX00000000000003', 'storageKey: 01M67LEGACYX00000000000003.jpg'].join('\n'),
    );

    const candidates = collectLocalMediaMirrorCandidates(mediaDir);
    expect(candidates.get('01M67HEALTHYX000000000000B')?.storageKey).toBe(
      '01M67LEGACYX00000000000002.jpg',
    );
    expect(candidates.get('01M67LEGACYX00000000000002')?.mediaId).toBe(
      '01M67HEALTHYX000000000000B',
    );
    // Legacy residue backs no real record, so it must never be usable as verification evidence.
    expect(candidates.has('01M67LEGACYX00000000000003')).toBe(false);
  });
});
