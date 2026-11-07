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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheDatabase } from '../src/db/cache.js';
import { ApiError } from '../src/client/error.js';
import { computeMediaHashes, uploadMediaFile } from '../src/client/media.js';

// Exact 1x1 PNG buffer used in Phase 0 production spike (70 bytes)
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_PNG_BUFFER = Buffer.from(TINY_PNG_BASE64, 'base64');

describe('EmDash 4-Phase Media Upload Client & Compensation', () => {
  let tempDir: string;
  let cache: CacheDatabase;
  const origin = 'https://aroooy.net';
  const token = 'test-token-123';

  // Verbatim fixtures captured from live EmDash production OpenAPI 3.1.0 endpoints during Phase 0
  const mediaId = '01M6TF1XXBS2KC9EVYG6RBT0J0';
  const pendingStorageKey = '01M6TF1XXBSC06QQG9M648B4K3.png';
  const confirmedStorageKey = '01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png';
  const confirmedUrl = `/_emdash/api/media/file/${confirmedStorageKey}`;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-media-upload-test-'));
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('executes the 4-phase same-origin upload flow and adopts the confirmed double-ULID storageKey', async () => {
    const calls: Array<{
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: unknown;
    }> = [];

    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      const hdrs = new Headers(init?.headers);
      const headers: Record<string, string> = {};
      hdrs.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      calls.push({
        method,
        url,
        headers,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });

      if (method === 'POST' && url.endsWith('/_emdash/api/media/upload-url')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              uploadUrl: `/_emdash/api/media/${mediaId}/upload`,
              method: 'PUT',
              headers: {
                'Content-Type': 'image/png',
                'X-EmDash-Request': '1',
              },
              mediaId,
              storageKey: pendingStorageKey,
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaId}/upload`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: { uploaded: true, size: TINY_PNG_BUFFER.length },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (method === 'POST' && url.endsWith(`/_emdash/api/media/${mediaId}/confirm`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              item: {
                id: mediaId,
                filename: 'emit-phase0-spike-1x1.png',
                mimeType: 'image/png',
                size: TINY_PNG_BUFFER.length,
                width: 1,
                height: 1,
                focalX: null,
                focalY: null,
                alt: null,
                caption: null,
                storageKey: confirmedStorageKey,
                contentHash: 'sha1:4a5eb7171b58e08a6881721e3b43d5a44419a2be',
                blurhash: 'L~09dghVhVhVhVhVhVhVhVhVhVhV',
                dominantColor: 'rgb(0,0,0)',
                status: 'ready',
                createdAt: '2026-11-07T07:37:33.355Z',
                authorId: '01M67MP2W0VKCK2DFWM166CR24',
                folderId: null,
                url: confirmedUrl,
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected call: ${method} ${url}`);
    }) as unknown as typeof fetch;

    const res = await uploadMediaFile({
      buffer: TINY_PNG_BUFFER,
      filename: 'emit-phase0-spike-1x1.png',
      origin,
      token,
      cache,
      fetchFn,
    });

    expect(res.deduplicated).toBe(false);
    expect(res.mediaId).toBe(mediaId);
    // Must use the confirmed double-ULID storageKey, NOT the initial single-ULID pending key
    expect(res.storageKey).toBe(confirmedStorageKey);
    expect(res.url).toBe(confirmedUrl);
    expect(res.contentHash).toBe('sha1:4a5eb7171b58e08a6881721e3b43d5a44419a2be');

    expect(calls).toHaveLength(3);
    // Phase A sends sha1:<hex> + deduplicate: true
    expect(calls[0].body).toEqual({
      filename: 'emit-phase0-spike-1x1.png',
      contentType: 'image/png',
      size: 70,
      deduplicate: true,
      contentHash: 'sha1:4a5eb7171b58e08a6881721e3b43d5a44419a2be',
    });
    // Phase B sends returned headers + Authorization for same-origin streaming
    expect(calls[1].headers['x-emdash-request']).toBe('1');
    expect(calls[1].headers['authorization']).toBe(`Bearer ${token}`);

    // Local media_state is recorded as 'uploaded'
    const state = cache.getMediaState(res.localHash);
    expect(state?.status).toBe('uploaded');
    expect(state?.storageKey).toBe(confirmedStorageKey);
  });

  it('omits Authorization header when PUT target is an external signed storage URL', async () => {
    let putHeadersCaptured: Record<string, string> = {};

    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();

      if (method === 'POST' && url.endsWith('/_emdash/api/media/upload-url')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              uploadUrl: 'https://r2-bucket.cloudflarestorage.com/signed-put?X-Amz-Signature=abc',
              method: 'PUT',
              headers: { 'Content-Type': 'image/png', 'x-amz-acl': 'private' },
              mediaId,
              storageKey: pendingStorageKey,
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            },
          }),
          { status: 200 },
        );
      }

      if (method === 'PUT' && url.includes('r2-bucket.cloudflarestorage.com')) {
        putHeadersCaptured = (init?.headers || {}) as Record<string, string>;
        return new Response('', { status: 200 });
      }

      if (method === 'POST' && url.endsWith(`/_emdash/api/media/${mediaId}/confirm`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              item: {
                id: mediaId,
                filename: 'signed.png',
                mimeType: 'image/png',
                size: TINY_PNG_BUFFER.length,
                storageKey: confirmedStorageKey,
                status: 'ready',
                url: `https://aroooy.net${confirmedUrl}`,
              },
            },
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof fetch;

    const res = await uploadMediaFile({
      buffer: TINY_PNG_BUFFER,
      filename: 'signed.png',
      origin,
      token,
      fetchFn,
    });

    expect(putHeadersCaptured['x-amz-acl']).toBe('private');
    expect(putHeadersCaptured['Authorization']).toBeUndefined();
    // Absolute item.url from confirm is normalized to root-relative
    expect(res.url).toBe(confirmedUrl);
  });

  it('short-circuits Phase B and C when upload-url returns existing: true (Response B) and fetches authoritative createdAt via GET (B-1)', async () => {
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
              storageKey: confirmedStorageKey,
              url: confirmedUrl,
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
                filename: 'original-hero.png',
                mimeType: 'image/png',
                size: 70,
                width: 1,
                height: 1,
                storageKey: confirmedStorageKey,
                contentHash: 'sha1:4a5eb7171b58e08a6881721e3b43d5a44419a2be',
                status: 'ready',
                createdAt: '2020-03-04T21:40:00.000Z',
              },
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Should not call ${method} ${url} on deduplication hit`);
    }) as unknown as typeof fetch;

    const res = await uploadMediaFile({
      buffer: TINY_PNG_BUFFER,
      filename: 'duplicate.png',
      origin,
      token,
      cache,
      fetchFn,
    });

    expect(res.deduplicated).toBe(true);
    expect(res.mediaId).toBe(mediaId);
    expect(res.storageKey).toBe(confirmedStorageKey);
    expect(res.url).toBe(confirmedUrl);
    expect(res.createdAt).toBe('2020-03-04T21:40:00.000Z');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('re-uploads when local media_state references a mediaId that was deleted on remote (GET returns 404, B-4)', async () => {
    const { localHash } = computeMediaHashes(TINY_PNG_BUFFER);
    const staleMediaId = '01M6DELETED000000000000000';
    cache.saveMediaState({
      localHash,
      mediaId: staleMediaId,
      storageKey: '01M6DELETED000000000000000.png',
      url: '/_emdash/api/media/file/01M6DELETED000000000000000.png',
      status: 'ready',
    });

    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();

      if (method === 'GET' && url.endsWith(`/_emdash/api/media/${staleMediaId}`)) {
        return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 });
      }
      if (method === 'POST' && url.endsWith('/_emdash/api/media/upload-url')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              uploadUrl: `/_emdash/api/media/${mediaId}/upload`,
              method: 'PUT',
              headers: { 'Content-Type': 'image/png' },
              mediaId,
              storageKey: pendingStorageKey,
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            },
          }),
          { status: 200 },
        );
      }
      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaId}/upload`)) {
        return new Response(JSON.stringify({ success: true, data: { uploaded: true } }), {
          status: 200,
        });
      }
      if (method === 'POST' && url.endsWith(`/_emdash/api/media/${mediaId}/confirm`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              item: {
                id: mediaId,
                filename: 'recreated.png',
                mimeType: 'image/png',
                size: TINY_PNG_BUFFER.length,
                storageKey: confirmedStorageKey,
                status: 'ready',
                url: confirmedUrl,
              },
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof fetch;

    const res = await uploadMediaFile({
      buffer: TINY_PNG_BUFFER,
      filename: 'recreated.png',
      origin,
      token,
      cache,
      fetchFn,
    });

    expect(res.deduplicated).toBe(false);
    expect(res.mediaId).toBe(mediaId);
    expect(res.storageKey).toBe(confirmedStorageKey);
    expect(cache.getMediaState(localHash)?.mediaId).toBe(mediaId);
  });

  it('cleans up expired upload-url target and re-requests a fresh one', async () => {
    const expiredMediaId = '01M6EXPIRED000000000000000';
    let uploadUrlCallCount = 0;
    const deletedIds: string[] = [];

    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();

      if (method === 'POST' && url.endsWith('/_emdash/api/media/upload-url')) {
        uploadUrlCallCount++;
        if (uploadUrlCallCount === 1) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                uploadUrl: `/_emdash/api/media/${expiredMediaId}/upload`,
                method: 'PUT',
                headers: { 'Content-Type': 'image/png' },
                mediaId: expiredMediaId,
                storageKey: '01M6EXPIREDKEY000000000000.png',
                expiresAt: new Date(Date.now() - 10_000).toISOString(), // Already expired
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              uploadUrl: `/_emdash/api/media/${mediaId}/upload`,
              method: 'PUT',
              headers: { 'Content-Type': 'image/png' },
              mediaId,
              storageKey: pendingStorageKey,
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            },
          }),
          { status: 200 },
        );
      }

      if (method === 'GET' && url.endsWith(`/_emdash/api/media/${expiredMediaId}`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: { item: { id: expiredMediaId, status: 'pending' } },
          }),
          { status: 200 },
        );
      }

      if (method === 'DELETE' && url.endsWith(`/_emdash/api/media/${expiredMediaId}`)) {
        deletedIds.push(expiredMediaId);
        return new Response(JSON.stringify({ success: true, data: { deleted: true } }), {
          status: 200,
        });
      }

      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaId}/upload`)) {
        return new Response(JSON.stringify({ success: true, data: { uploaded: true } }), {
          status: 200,
        });
      }

      if (method === 'POST' && url.endsWith(`/_emdash/api/media/${mediaId}/confirm`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              item: {
                id: mediaId,
                filename: 'fresh.png',
                mimeType: 'image/png',
                size: TINY_PNG_BUFFER.length,
                storageKey: confirmedStorageKey,
                status: 'ready',
                url: confirmedUrl,
              },
            },
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof fetch;

    const res = await uploadMediaFile({
      buffer: TINY_PNG_BUFFER,
      filename: 'fresh.png',
      origin,
      token,
      fetchFn,
    });

    expect(deletedIds).toEqual([expiredMediaId]);
    expect(res.mediaId).toBe(mediaId);
    expect(res.storageKey).toBe(confirmedStorageKey);
  });

  it('compensates by deleting the orphan pending record when Phase B PUT fails', async () => {
    const deletedIds: string[] = [];
    const { localHash } = computeMediaHashes(TINY_PNG_BUFFER);

    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();

      if (method === 'POST' && url.endsWith('/_emdash/api/media/upload-url')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              uploadUrl: `/_emdash/api/media/${mediaId}/upload`,
              method: 'PUT',
              headers: { 'Content-Type': 'image/png' },
              mediaId,
              storageKey: pendingStorageKey,
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            },
          }),
          { status: 200 },
        );
      }

      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaId}/upload`)) {
        return new Response('Storage Gateway Timeout', {
          status: 504,
          statusText: 'Gateway Timeout',
        });
      }

      if (method === 'GET' && url.endsWith(`/_emdash/api/media/${mediaId}`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: { item: { id: mediaId, status: 'pending', storageKey: pendingStorageKey } },
          }),
          { status: 200 },
        );
      }

      if (method === 'DELETE' && url.endsWith(`/_emdash/api/media/${mediaId}`)) {
        deletedIds.push(mediaId);
        return new Response(
          JSON.stringify({ success: true, data: { deleted: true, storageDeleted: true } }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof fetch;

    await expect(
      uploadMediaFile({
        buffer: TINY_PNG_BUFFER,
        filename: 'fail-put.png',
        origin,
        token,
        cache,
        fetchFn,
      }),
    ).rejects.toThrow(/Failed to upload binary/);

    // Orphan pending record was deleted on server and cleaned from local media_state
    expect(deletedIds).toEqual([mediaId]);
    expect(cache.getMediaState(localHash)).toBeNull();
  });

  it('records status="failed" in media_state and surfaces manual deletion guidance if DELETE compensation also fails', async () => {
    const { localHash } = computeMediaHashes(TINY_PNG_BUFFER);

    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();

      if (method === 'POST' && url.endsWith('/_emdash/api/media/upload-url')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              uploadUrl: `/_emdash/api/media/${mediaId}/upload`,
              method: 'PUT',
              headers: { 'Content-Type': 'image/png' },
              mediaId,
              storageKey: pendingStorageKey,
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            },
          }),
          { status: 200 },
        );
      }

      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaId}/upload`)) {
        return new Response('Network Drop', { status: 502, statusText: 'Bad Gateway' });
      }

      if (method === 'GET' && url.endsWith(`/_emdash/api/media/${mediaId}`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: { item: { id: mediaId, status: 'pending' } },
          }),
          { status: 200 },
        );
      }

      if (method === 'DELETE' && url.endsWith(`/_emdash/api/media/${mediaId}`)) {
        return new Response('Server down', { status: 500 });
      }

      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof fetch;

    const caught = await uploadMediaFile({
      buffer: TINY_PNG_BUFFER,
      filename: 'uncompensated.png',
      origin,
      token,
      cache,
      fetchFn,
    }).catch((e: unknown) => e as ApiError);

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).suggestion).toContain(mediaId);

    const failedState = cache.getMediaState(localHash);
    expect(failedState?.status).toBe('failed');
    expect(failedState?.mediaId).toBe(mediaId);
  });
});
