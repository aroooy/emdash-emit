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
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheDatabase } from '../src/db/cache.js';
import { pushMedia } from '../src/sync/media/index.js';
import { asMediaRecordId, asStorageKey } from '../src/utils/media-id.js';

const TINY_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('pushMedia (v0.1.52: Unified Standalone Media Upload & Metadata Sync)', () => {
  let tempDir: string;
  let extDir: string;
  let cache: CacheDatabase;
  const origin = 'https://aroooy.net';
  const token = 'test-token';
  const mediaId = asMediaRecordId('01M67P0MBMJQQXH2K95HHCYRYB');
  const storageKey = asStorageKey('01M67P0MBMJQQXH2K95HHCYRYB.01M6CONFIRMED0000000000000.png');

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-push-media-ws-'));
    extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-push-media-ext-'));
    fs.mkdirSync(path.join(tempDir, '.emit'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'media', 'drafts'), { recursive: true });
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(extDir, { recursive: true, force: true });
  });

  it('Mode B-2: moves media/drafts/* on upload, but copies external files while preserving the original', async () => {
    const draftPath = path.join(tempDir, 'media', 'drafts', 'draft-hero.png');
    const externalPath = path.join(extDir, 'camera-roll.png');
    fs.writeFileSync(draftPath, TINY_PNG_BUFFER);
    fs.writeFileSync(externalPath, TINY_PNG_BUFFER);

    const putPayloads: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();

      if (method === 'POST' && url.endsWith('/_emdash/api/media/upload-url')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              existing: true,
              mediaId,
              storageKey,
              url: `/_emdash/api/media/file/${storageKey}`,
            },
          }),
          { status: 200 },
        );
      }

      if (method === 'GET' && url.endsWith(`/_emdash/api/media/${mediaId}`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              item: {
                id: mediaId,
                filename: 'draft-hero.png',
                mimeType: 'image/png',
                size: TINY_PNG_BUFFER.length,
                width: 1,
                height: 1,
                storageKey,
                status: 'ready',
                createdAt: '2026-11-23T00:00:00.000Z',
              },
            },
          }),
          { status: 200 },
        );
      }

      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaId}`)) {
        putPayloads.push({
          url,
          body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
      }

      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof fetch;

    // 1. Draft upload moves file out of media/drafts/
    const draftRes = await pushMedia({
      workspaceRoot: tempDir,
      origin,
      token,
      targets: ['media/drafts/draft-hero.png'],
      alt: 'Hero Alt',
      caption: 'Hero Caption',
      cache,
      fetchFn,
    });
    expect(draftRes.items).toHaveLength(1);
    expect(draftRes.items[0]?.mediaId).toBe(mediaId);
    expect(fs.existsSync(draftPath)).toBe(false);
    expect(fs.existsSync(path.join(tempDir, draftRes.items[0]!.filePath!))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, draftRes.items[0]!.yamlPath!))).toBe(true);

    // 2. External file upload copies into media/ without deleting externalPath
    const extRes = await pushMedia({
      workspaceRoot: tempDir,
      origin,
      token,
      targets: [externalPath],
      alt: 'Camera Alt',
      cache,
      fetchFn,
    });
    expect(extRes.items).toHaveLength(1);
    expect(fs.existsSync(externalPath)).toBe(true);
    expect(putPayloads.some((p) => p.body.alt === 'Camera Alt')).toBe(true);
  });

  it('Mode A & Mode B-1: pushes edited companion YAML metadata, routes mirrored media/<stem>.<ext> to metadata update, and supports empty-string clearing', async () => {
    const stem = '01M67P0MBMJQQXH2K95HHCYRYB.01M6CONFIRMED0000000000000';
    const yamlPath = path.join(tempDir, 'media', `${stem}.yaml`);
    const pngPath = path.join(tempDir, 'media', `${stem}.png`);
    fs.writeFileSync(pngPath, TINY_PNG_BUFFER);
    fs.writeFileSync(
      yamlPath,
      yaml.dump({
        id: mediaId,
        filename: 'sample.png',
        mimeType: 'image/png',
        size: TINY_PNG_BUFFER.length,
        width: 1200,
        height: 800,
        alt: 'Edited in YAML',
        caption: 'Caption from YAML',
        storageKey,
        contentHash: 'sha1:abc',
        status: 'ready',
        url: `/_emdash/api/media/file/${storageKey}`,
        createdAt: '2026-11-23T00:00:00.000Z',
      }),
      'utf8',
    );

    const putPayloads: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaId}`)) {
        putPayloads.push({
          url,
          body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
      }
      throw new Error(`Unexpected network call: ${method} ${url}`);
    }) as unknown as typeof fetch;

    // 1. Mode A: YAML-driven update (no --alt/--caption flags)
    const yamlRes = await pushMedia({
      workspaceRoot: tempDir,
      origin,
      token,
      targets: [`media/${stem}.yaml`],
      cache,
      fetchFn,
    });
    expect(yamlRes.items[0]?.action).toBe('metadata-updated');
    expect(putPayloads).toEqual([
      {
        url: `${origin}/_emdash/api/media/${mediaId}`,
        body: { alt: 'Edited in YAML', caption: 'Caption from YAML' },
      },
    ]);

    // 2. Mode B-1: Passing mirrored image path media/<stem>.png deterministically routes to metadata update (0 upload calls)
    // and supports empty string "" clearing while preserving all other YAML fields
    putPayloads.length = 0;
    const b1ClearRes = await pushMedia({
      workspaceRoot: tempDir,
      origin,
      token,
      targets: [`media/${stem}.png`],
      alt: '',
      caption: 'Cleared Alt Only',
      cache,
      fetchFn,
    });
    expect(b1ClearRes.items[0]?.action).toBe('metadata-updated');
    expect(putPayloads).toEqual([
      {
        url: `${origin}/_emdash/api/media/${mediaId}`,
        body: { alt: '', caption: 'Cleared Alt Only' },
      },
    ]);

    const updatedYaml = yaml.load(fs.readFileSync(yamlPath, 'utf8')) as Record<string, unknown>;
    expect(updatedYaml.alt).toBe('');
    expect(updatedYaml.caption).toBe('Cleared Alt Only');
    expect(updatedYaml.id).toBe(mediaId);
    expect(updatedYaml.width).toBe(1200);
    expect(updatedYaml.storageKey).toBe(storageKey);
  });

  it('Mode C & Typo Path Guard: resolves storageKey -> D1 mediaId before PUT and rejects missing file paths immediately', async () => {
    cache.saveMediaState({
      localHash: 'h1',
      mediaId,
      storageKey,
      url: `/_emdash/api/media/file/${storageKey}`,
      status: 'ready',
    });

    const putUrls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'PUT') {
        putUrls.push(url);
        return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof fetch;

    // Mode C: Passing storageKey resolves to D1 mediaId (never puts storageKey in the endpoint URL)
    const keyRes = await pushMedia({
      workspaceRoot: tempDir,
      origin,
      token,
      targets: [storageKey],
      alt: 'Updated via storageKey',
      cache,
      fetchFn,
    });
    expect(keyRes.items[0]?.mediaId).toBe(mediaId);
    expect(putUrls).toEqual([`${origin}/_emdash/api/media/${mediaId}`]);

    // Typo file path guard: media/drafts/missing.png and ./missing.jpg must NOT fall through to Mode C
    await expect(
      pushMedia({
        workspaceRoot: tempDir,
        origin,
        token,
        targets: ['media/drafts/missing.png'],
        cache,
        fetchFn,
      }),
    ).rejects.toMatchObject({ code: 'MISSING_LOCAL_IMAGE_FILE' });

    await expect(
      pushMedia({
        workspaceRoot: tempDir,
        origin,
        token,
        targets: ['./missing.jpg'],
        cache,
        fetchFn,
      }),
    ).rejects.toMatchObject({ code: 'MISSING_LOCAL_IMAGE_FILE' });

    await expect(
      pushMedia({
        workspaceRoot: tempDir,
        origin,
        token,
        targets: ['media/missing.yaml'],
        cache,
        fetchFn,
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_COMPANION_NOT_FOUND' });
  });

  it('clears metadata with empty string on local media_state dedup hit and reports completed items on partial multi-target failure', async () => {
    const draftPath = path.join(tempDir, 'media', 'drafts', 'dedup-clear.png');
    fs.writeFileSync(draftPath, TINY_PNG_BUFFER);

    const { computeMediaHashes } = await import('../src/client/media.js');
    const { localHash } = computeMediaHashes(TINY_PNG_BUFFER);
    cache.saveMediaState({
      localHash,
      localContentHash: localHash,
      mediaId,
      storageKey,
      url: `/_emdash/api/media/file/${storageKey}`,
      status: 'ready',
    });

    const putPayloads: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'GET' && url.endsWith(`/_emdash/api/media/${mediaId}`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              item: {
                id: mediaId,
                filename: 'dedup-clear.png',
                mimeType: 'image/png',
                size: TINY_PNG_BUFFER.length,
                alt: 'Old Alt',
                caption: 'Old Caption',
                storageKey,
                status: 'ready',
              },
            },
          }),
          { status: 200 },
        );
      }
      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaId}`)) {
        putPayloads.push({
          url,
          body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof fetch;

    // 1. Dedup hit with explicit empty string alt="" triggers strict updateRemoteMediaMetadata and writes "" to companion YAML
    const clearRes = await pushMedia({
      workspaceRoot: tempDir,
      origin,
      token,
      targets: ['media/drafts/dedup-clear.png'],
      alt: '',
      cache,
      fetchFn,
    });
    expect(clearRes.items[0]?.action).toBe('deduplicated');
    expect(clearRes.items[0]?.alt).toBe('');
    expect(putPayloads).toEqual([
      {
        url: `${origin}/_emdash/api/media/${mediaId}`,
        body: { alt: '' },
      },
    ]);

    // 2. Partial failure across multiple targets reports already-completed targets in the error message
    await expect(
      pushMedia({
        workspaceRoot: tempDir,
        origin,
        token,
        targets: [clearRes.items[0]!.yamlPath!, 'media/drafts/does-not-exist.png'],
        alt: 'Batch Alt',
        cache,
        fetchFn,
      }),
    ).rejects.toThrow(/Completed 1\/2 target\(s\) before failure:/);
  });
});
