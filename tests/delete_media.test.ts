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
import {
  deleteMedia,
  LOCAL_REFERENCE_SCAN_ONLY_WARNING,
  MediaInUseDeletionForbiddenError,
} from '../src/sync/media/index.js';
import { asMediaRecordId, asStorageKey } from '../src/utils/media-id.js';

describe('deleteMedia (v0.1.53: Standalone Media Deletion & Guard G20 Reference Protection)', () => {
  let tempDir: string;
  let cache: CacheDatabase;
  const origin = 'https://aroooy.net';
  const token = 'test-token';
  const mediaId1 = asMediaRecordId('01M67P0MBMJQQXH2K95HHCYRYB');
  const storageKey1 = asStorageKey('01M67P0MBMJQQXH2K95HHCYRYB.01M6CONFIRMED0000000000001.png');
  const stem1 = '01M67P0MBMJQQXH2K95HHCYRYB.01M6CONFIRMED0000000000001';

  const mediaId2 = asMediaRecordId('01M67P0MBMJQQXH2K95HHCYRYC');
  const storageKey2 = asStorageKey('01M67P0MBMJQQXH2K95HHCYRYC.01M6CONFIRMED0000000000002.jpg');
  const stem2 = '01M67P0MBMJQQXH2K95HHCYRYC.01M6CONFIRMED0000000000002';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-delete-media-ws-'));
    fs.mkdirSync(path.join(tempDir, '.emit'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'media'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'posts', 'ja', 'published'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'posts', 'conflicts'), { recursive: true });
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeMirror(id: string, key: string, stem: string, ext = '.png'): void {
    const mediaDir = path.join(tempDir, 'media');
    fs.writeFileSync(path.join(mediaDir, `${stem}${ext}`), 'binary-bytes', 'utf8');
    fs.writeFileSync(
      path.join(mediaDir, `${stem}.yaml`),
      yaml.dump({
        id,
        filename: `sample${ext}`,
        mimeType: ext === '.png' ? 'image/png' : 'image/jpeg',
        size: 12,
        storageKey: key,
        status: 'ready',
        url: `/_emdash/api/media/file/${key}`,
      }),
      'utf8',
    );
    cache.saveMediaState({
      localHash: `h-${id}`,
      mediaId: asMediaRecordId(id),
      storageKey: asStorageKey(key),
      url: `/_emdash/api/media/file/${key}`,
      workspacePath: `media/${stem}${ext}`,
      markdownRef: `media/${stem}`,
      status: 'ready',
    });
  }

  it('T-A, T-B, T-C: resolves companion YAML, mirror binary, mediaId, and storageKey strictly to D1 mediaId for DELETE and moves mirror to media/_trash/', async () => {
    writeMirror(mediaId1, storageKey1, stem1, '.png');
    writeMirror(mediaId2, storageKey2, stem2, '.jpg');

    const deleteUrls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'GET') {
        const id = url.split('/').pop()!;
        return new Response(
          JSON.stringify({
            success: true,
            data: { item: { id, status: 'ready' } },
          }),
          { status: 200 },
        );
      }
      if (method === 'DELETE') {
        deleteUrls.push(url);
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof fetch;

    // T-B (mirror binary) and T-C (storageKey)
    const res = await deleteMedia({
      workspaceRoot: tempDir,
      origin,
      token,
      targets: [`media/${stem1}.png`, storageKey2],
      cache,
      fetchFn,
    });

    expect(res.dryRun).toBe(false);
    expect(res.warnings).toContain(LOCAL_REFERENCE_SCAN_ONLY_WARNING);
    expect(res.items.map((it) => it.action)).toEqual(['deleted', 'deleted']);
    // DELETE endpoints strictly use D1 mediaId, never storageKey
    expect(deleteUrls).toEqual([
      `${origin}/_emdash/api/media/${mediaId1}`,
      `${origin}/_emdash/api/media/${mediaId2}`,
    ]);

    // Original mirrors removed, moved to media/_trash/<stem>.deleted.*
    expect(fs.existsSync(path.join(tempDir, 'media', `${stem1}.png`))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'media', `${stem1}.yaml`))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'media', '_trash', `${stem1}.deleted.png`))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'media', '_trash', `${stem1}.deleted.yaml`))).toBe(
      true,
    );
    expect(cache.getMediaStateByStorageKey(storageKey1)).toBeNull();
    expect(cache.getMediaStateByStorageKey(storageKey2)).toBeNull();
  });

  it('G20 (MEDIA_IN_USE_PROTECTION): blocks deletion of media referenced in article body or featuredImage with 0 network calls, while ignoring .deleted.md backups', async () => {
    writeMirror(mediaId1, storageKey1, stem1, '.png');
    writeMirror(mediaId2, storageKey2, stem2, '.jpg');

    const articleRel = 'posts/ja/published/20261123_01M6ARTICLE000000000000001-trip.md';
    fs.writeFileSync(
      path.join(tempDir, articleRel),
      [
        '---',
        'id: 01M6ARTICLE000000000000001',
        'slug: trip',
        'title: "Trip"',
        'status: published',
        `featuredImage: ${mediaId2}`,
        '---',
        '',
        `![Hero](../../../media/${storageKey1})`,
        '',
      ].join('\n'),
      'utf8',
    );

    const fetchFn = vi.fn(async () => {
      throw new Error('Network should NOT be called when G20 refuses deletion');
    }) as unknown as typeof fetch;

    let caught: MediaInUseDeletionForbiddenError | undefined;
    try {
      await deleteMedia({
        workspaceRoot: tempDir,
        origin,
        token,
        targets: [`media/${stem1}.png`, mediaId2],
        cache,
        fetchFn,
      });
    } catch (err) {
      caught = err as MediaInUseDeletionForbiddenError;
    }

    expect(caught).toBeInstanceOf(MediaInUseDeletionForbiddenError);
    expect(caught?.code).toBe('MEDIA_IN_USE_PROTECTION');
    expect(caught?.referencedBy).toEqual([articleRel]);
    expect(caught?.items.map((it) => it.action)).toEqual(['refused', 'refused']);
    expect(fetchFn).not.toHaveBeenCalled();

    // Now move the referencing article to a .deleted.md backup in conflicts/ -> no longer protected!
    fs.unlinkSync(path.join(tempDir, articleRel));
    fs.writeFileSync(
      path.join(
        tempDir,
        'posts',
        'conflicts',
        '20261123_01M6ARTICLE000000000000001-trip.deleted.md',
      ),
      `---\nid: 01M6ARTICLE000000000000001\nslug: trip\ntitle: "Trip"\nstatus: draft\n---\n\n![Hero](../../../media/${storageKey1})\n`,
      'utf8',
    );

    const delFetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'GET') {
        return new Response(
          JSON.stringify({ success: true, data: { item: { id: mediaId1, status: 'ready' } } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const okRes = await deleteMedia({
      workspaceRoot: tempDir,
      origin,
      token,
      targets: [`media/${stem1}.png`],
      noBackup: true,
      cache,
      fetchFn: delFetch,
    });
    expect(okRes.items[0]?.action).toBe('deleted');
    expect(fs.existsSync(path.join(tempDir, 'media', '_trash'))).toBe(false);
  });

  it('supports zero-token offline --dry-run, handles already-deleted (404), blocks pending status, preserves local atomicity on 500, and summarizes batch partial completion', async () => {
    writeMirror(mediaId1, storageKey1, stem1, '.png');
    writeMirror(mediaId2, storageKey2, stem2, '.jpg');

    const noNetFetch = vi.fn(async () => {
      throw new Error('Zero network calls expected in dry-run');
    }) as unknown as typeof fetch;

    // 1. Offline dry-run without token -> 0 network calls, local files untouched
    const dryRes = await deleteMedia({
      workspaceRoot: tempDir,
      origin,
      targets: [`media/${stem1}.png`],
      dryRun: true,
      cache,
      fetchFn: noNetFetch,
    });
    expect(dryRes.dryRun).toBe(true);
    expect(dryRes.items[0]?.action).toBe('deleted');
    expect(noNetFetch).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tempDir, 'media', `${stem1}.png`))).toBe(true);

    // 2. Pending status gate -> MEDIA_DELETE_PRECONDITION_FAILED, 0 DELETE calls
    const pendingFetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'GET') {
        return new Response(
          JSON.stringify({ success: true, data: { item: { id: mediaId1, status: 'pending' } } }),
          { status: 200 },
        );
      }
      throw new Error('DELETE must not be called for pending media');
    }) as unknown as typeof fetch;

    await expect(
      deleteMedia({
        workspaceRoot: tempDir,
        origin,
        token,
        targets: [mediaId1],
        cache,
        fetchFn: pendingFetch,
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_DELETE_PRECONDITION_FAILED' });

    // 3. Remote DELETE 500 -> REMOTE_MEDIA_DELETE_FAILED, local files and media/_trash/ completely untouched
    const failDeleteFetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'GET') {
        return new Response(
          JSON.stringify({ success: true, data: { item: { id: mediaId1, status: 'ready' } } }),
          { status: 200 },
        );
      }
      return new Response('Internal Server Error', { status: 500 });
    }) as unknown as typeof fetch;

    await expect(
      deleteMedia({
        workspaceRoot: tempDir,
        origin,
        token,
        targets: [`media/${stem1}.png`],
        cache,
        fetchFn: failDeleteFetch,
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_MEDIA_DELETE_FAILED' });
    expect(fs.existsSync(path.join(tempDir, 'media', `${stem1}.png`))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'media', `${stem1}.yaml`))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'media', '_trash'))).toBe(false);
    expect(cache.getMediaStateByStorageKey(storageKey1)).not.toBeNull();

    // 4. Unattributed image in media/ without companion YAML -> MEDIA_COMPANION_NOT_FOUND
    fs.writeFileSync(path.join(tempDir, 'media', 'orphan.png'), 'bytes', 'utf8');
    await expect(
      deleteMedia({
        workspaceRoot: tempDir,
        origin,
        token,
        targets: ['media/orphan.png'],
        cache,
        fetchFn: noNetFetch,
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_COMPANION_NOT_FOUND' });

    // 5. GET 404 (already-deleted) + batch partial completion when 2nd item is refused by G20
    const articleRel = 'posts/ja/published/20261123_01M6ARTICLE000000000000002-use2.md';
    fs.writeFileSync(
      path.join(tempDir, articleRel),
      `---\nid: 01M6ARTICLE000000000000002\nslug: use2\ntitle: "Use2"\nstatus: published\nfeaturedImage: ${mediaId2}\n---\n\nBody\n`,
      'utf8',
    );

    const get404Fetch = vi.fn(
      async () => new Response('Not Found', { status: 404 }),
    ) as unknown as typeof fetch;

    await expect(
      deleteMedia({
        workspaceRoot: tempDir,
        origin,
        token,
        targets: [`media/${stem1}.yaml`, `media/${stem2}.jpg`],
        cache,
        fetchFn: get404Fetch,
      }),
    ).rejects.toThrow(/Completed 1\/2 target\(s\) before refusal:.*already-deleted/);
    expect(fs.existsSync(path.join(tempDir, 'media', `${stem1}.yaml`))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'media', `${stem2}.jpg`))).toBe(true);
  });

  it('blocks deletion via Guard G20 when remote usedIn reports active references (EmDash 1.6+)', async () => {
    const usedInFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/media/${mediaId1}`) && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              item: {
                id: mediaId1,
                status: 'ready',
                storageKey: storageKey1,
                usedIn: [
                  {
                    id: '01M7REMOTEART0000000000001',
                    collection: 'posts',
                    title: 'Remote Post',
                  },
                ],
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response('Unexpected call', { status: 500 });
    }) as unknown as typeof fetch;

    await expect(
      deleteMedia({
        workspaceRoot: tempDir,
        origin,
        token,
        targets: [mediaId1],
        cache,
        fetchFn: usedInFetch,
      }),
    ).rejects.toMatchObject({
      code: 'MEDIA_IN_USE_PROTECTION',
      referencedBy: ['remote:posts:"Remote Post" (01M7REMOTEART0000000000001)'],
    });

    // Empty usedIn: [] deletes cleanly and omits LOCAL_REFERENCE_SCAN_ONLY_WARNING
    const emptyUsedInFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/media/${mediaId1}`) && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              item: {
                id: mediaId1,
                status: 'ready',
                storageKey: storageKey1,
                usedIn: [],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/media/${mediaId1}`) && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    const cleanRes = await deleteMedia({
      workspaceRoot: tempDir,
      origin,
      token,
      targets: [mediaId1],
      cache,
      fetchFn: emptyUsedInFetch,
    });
    expect(cleanRes.items[0]?.action).toBe('deleted');
    expect(cleanRes.warnings).toEqual([]);
  });
});
