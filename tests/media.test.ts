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
import { pullMedia, promoteDraftMediaFile } from '../src/sync/media.js';

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
      "url: 'https://aroooy.net/_emdash/api/media/file/01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png'",
    );
  });
});
