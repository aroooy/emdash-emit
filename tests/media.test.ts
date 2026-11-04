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
import { pullMedia } from '../src/sync/media.js';

describe('Media Sync Engine', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-media-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('pulls media metadata and files into media/ directory', async () => {
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
        url: '/_emdash/api/media/file/sample.jpg',
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
      if (url.includes('/sample.jpg')) {
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
});
