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
  pullArticleMedia,
} from '../src/sync/media.js';

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
![Inline](/_emdash/api/media/file/01M67TARGET000000000000002.jpg)
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
});
