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

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheDatabase } from '../src/db/cache.js';
import { DEFAULT_CONFIG, initWorkspace, loadConfig } from '../src/utils/config.js';
import { resolveSnapshotMediaOption } from '../src/utils/media-ref-precedence.js';
import { toMediaCacheFileName } from '../src/utils/media-cache.js';
import {
  captureWorkspaceSnapshot,
  clearWorkspaceSnapshot,
  pruneOrphanMediaCache,
} from '../src/sync/snapshot/index.js';
import { pullFromSnapshot } from '../src/sync/pull/index.js';
import {
  collectLocalMirrorIndex,
  deleteMedia,
  pullMedia,
  searchLocalMirrorMedia,
} from '../src/sync/media/index.js';
import { runWorkspaceDoctor } from '../src/sync/doctor.js';
import { formatMediaCacheSummary } from '../src/presentation/media_report.js';

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('Offline Media Cache & Materialize (v0.1.56)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-media-cache-test-'));
    initWorkspace(tempDir, { origin: 'https://example.com' });
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function buildOnlineMock(
    posts: Array<{
      id: string;
      slug: string;
      title: string;
      status: string;
      storageKey?: string;
      featuredImage?: string;
    }>,
    mediaItems: Array<{
      id: string;
      storageKey: string;
      filename: string;
      mimeType: string;
      bytes: Buffer;
    }>,
    counts: { fileGets: number },
  ) {
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes('/_emdash/api/taxonomies/category/terms')) {
        return new Response(JSON.stringify({ data: { terms: [] } }), { status: 200 });
      }
      if (url.includes('/_emdash/api/taxonomies/tag/terms')) {
        return new Response(JSON.stringify({ data: { terms: [] } }), { status: 200 });
      }
      if (url.includes('/_emdash/api/bylines')) {
        return new Response(JSON.stringify({ data: { bylines: [] } }), { status: 200 });
      }
      if (url.includes('/_emdash/api/content/posts')) {
        const mapped = posts.map((p) => ({
          id: p.id,
          slug: p.slug,
          status: p.status,
          version: 1,
          liveRevisionId: '01M8LIVE000000000000000001',
          createdAt: '2026-11-20T00:00:00.000Z',
          updatedAt: '2026-11-20T01:00:00.000Z',
          publishedAt: '2026-11-20T01:00:00.000Z',
          data: {
            title: p.title,
            content: p.storageKey
              ? [
                  {
                    _type: 'image',
                    _key: 'img1',
                    src: `/_emdash/api/media/file/${p.storageKey}`,
                    alt: 'Hero',
                  },
                ]
              : [{ _type: 'block', _key: 'b1', children: [{ _type: 'span', text: 'Hello' }] }],
            ...(p.featuredImage ? { featured_image: p.featuredImage } : {}),
          },
        }));
        return new Response(JSON.stringify({ data: { items: mapped } }), { status: 200 });
      }
      if (url.includes('/_emdash/api/media/file/')) {
        counts.fileGets += 1;
        const key = decodeURIComponent(url.split('/_emdash/api/media/file/')[1]!.split('?')[0]!);
        const found = mediaItems.find((m) => m.storageKey === key);
        if (!found) {
          return new Response('Not Found', { status: 404 });
        }
        return new Response(new Uint8Array(found.bytes), {
          status: 200,
          headers: { 'content-type': found.mimeType },
        });
      }
      if (url.includes('/_emdash/api/media?')) {
        return new Response(
          JSON.stringify({
            data: {
              items: mediaItems.map((m) => ({
                id: m.id,
                storageKey: m.storageKey,
                filename: m.filename,
                mimeType: m.mimeType,
                size: m.bytes.byteLength,
                createdAt: '2026-11-20T00:00:00.000Z',
              })),
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: `Unexpected ${url}` }), { status: 404 });
    }) as typeof fetch;
  }

  it('captures media binaries into media/_cache/ and materializes them offline on pullFromSnapshot', async () => {
    const postId = '01M8POST000000000000000001';
    const mediaId = '01M8MED0000000000000000001';
    const storageKey = '01M8KEY0000000000000000001.png';
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]);
    const counts = { fileGets: 0 };

    const onlineFetch = buildOnlineMock(
      [
        {
          id: postId,
          slug: 'cached-media-post',
          title: 'Cached Media Post',
          status: 'published',
          storageKey,
          featuredImage: mediaId,
        },
      ],
      [
        {
          id: mediaId,
          storageKey,
          filename: 'hero.png',
          mimeType: 'image/png',
          bytes: pngBytes,
        },
      ],
      counts,
    );

    const cap1 = await captureWorkspaceSnapshot({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      includeMedia: true,
      fetchFn: onlineFetch,
    });

    expect(cap1.mediaCached).toBe(1);
    expect(cap1.mediaCacheSkipped).toBe(0);
    expect(cap1.mediaCacheBytes).toBe(pngBytes.byteLength);
    expect(cap1.mediaCacheBudgetHit).toBe(false);
    expect(counts.fileGets).toBe(1);

    const cacheFileName = toMediaCacheFileName(storageKey)!;
    const cacheFilePath = path.join(tempDir, 'media', '_cache', cacheFileName);
    expect(fs.existsSync(cacheFilePath)).toBe(true);
    expect(fs.readFileSync(path.join(tempDir, 'media', '_cache', '.gitignore'), 'utf8')).toBe(
      '*\n',
    );

    const dbRow = cache.getSnapshotMediaByStorageKey(storageKey);
    expect(dbRow?.cachePath).toBe(`media/_cache/${cacheFileName}`);
    expect(dbRow?.contentHash).toBe(`sha256:${sha256(pngBytes)}`);
    expect(dbRow?.cachedAt).toBeTypeOf('number');

    // Second capture reuses existing cache with 0 HTTP GETs
    const cap2 = await captureWorkspaceSnapshot({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      includeMedia: true,
      fetchFn: onlineFetch,
    });
    expect(cap2.mediaCached).toBe(0);
    expect(cap2.mediaCacheSkipped).toBe(1);
    expect(counts.fileGets).toBe(1);

    // Delete any existing mirrors/articles and run offline pullFromSnapshot
    fs.rmSync(path.join(tempDir, 'posts'), { recursive: true, force: true });
    fs.mkdirSync(path.join(tempDir, 'posts'), { recursive: true });
    for (const f of fs.readdirSync(path.join(tempDir, 'media'))) {
      if (f !== '_cache' && f !== 'drafts' && f !== '_trash') {
        fs.rmSync(path.join(tempDir, 'media', f), { force: true });
      }
    }

    const pullRes = pullFromSnapshot({
      workspaceRoot: tempDir,
      cache,
      id: postId,
    });

    expect(pullRes.updated).toBe(true);
    expect(pullRes.id).toBe(postId);
    expect(pullRes.mediaRestored).toBe(1);
    expect(pullRes.mediaMissing).toBe(0);
    expect(
      pullRes.warnings.some((w) => w.includes('[MEDIA_CACHE ') && w.includes('restored=1')),
    ).toBe(true);
    expect(pullRes.warnings.some((w) => w.includes('[MEDIA_NOT_GUARANTEED]'))).toBe(false);

    // Mirror image + companion YAML + media_state materialized
    const mirrorImg = path.join(tempDir, 'media', storageKey);
    const mirrorYaml = path.join(tempDir, 'media', `${storageKey.replace(/\.png$/, '')}.yaml`);
    expect(fs.existsSync(mirrorImg)).toBe(true);
    expect(sha256(fs.readFileSync(mirrorImg))).toBe(sha256(pngBytes));
    expect(fs.existsSync(mirrorYaml)).toBe(true);
    expect(fs.readFileSync(mirrorYaml, 'utf8')).toContain(`id: ${mediaId}`);
    expect(cache.getMediaState(storageKey)?.status).toBe('ready');
  });

  it('enforces mediaCacheLimit and mediaCacheMaxBytes and emits [MEDIA_CACHE_BUDGET]', async () => {
    const items = [1, 2, 3].map((i) => ({
      id: `01M8MED000000000000000000${i}`,
      storageKey: `01M8KEY000000000000000000${i}.png`,
      filename: `img${i}.png`,
      mimeType: 'image/png',
      bytes: Buffer.alloc(100, i),
    }));
    const counts = { fileGets: 0 };
    const fetchFn = buildOnlineMock([], items, counts);

    const byLimit = await captureWorkspaceSnapshot({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      includeMedia: true,
      mediaCacheLimit: 2,
      fetchFn,
    });
    expect(byLimit.mediaCached).toBe(2);
    expect(byLimit.mediaCacheBudgetHit).toBe(true);
    expect(formatMediaCacheSummary(byLimit)).toContain('[MEDIA_CACHE_BUDGET');

    // Now test byte cap on the remaining 100-byte item with 50-byte max
    const byBytes = await captureWorkspaceSnapshot({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      includeMedia: true,
      mediaCacheMaxBytes: 50,
      fetchFn,
    });
    expect(byBytes.mediaCacheBudgetHit).toBe(true);
    expect(formatMediaCacheSummary(byBytes)).toContain('[MEDIA_CACHE_BUDGET');
  });

  it('falls back to copyFileSync when linkSync fails, detects corrupt cache, and respects restoreMedia: false', async () => {
    const postId = '01M8POST000000000000000002';
    const mediaId = '01M8MED0000000000000000002';
    const storageKey = '01M8KEY0000000000000000002.png';
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
    const counts = { fileGets: 0 };

    await captureWorkspaceSnapshot({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      includeMedia: true,
      fetchFn: buildOnlineMock(
        [{ id: postId, slug: 'fallback-post', title: 'Fallback', status: 'published', storageKey }],
        [
          {
            id: mediaId,
            storageKey,
            filename: 'fallback.png',
            mimeType: 'image/png',
            bytes: pngBytes,
          },
        ],
        counts,
      ),
    });

    // 1) --no-media-restore skips materialization
    const skippedRes = pullFromSnapshot({
      workspaceRoot: tempDir,
      cache,
      id: postId,
      restoreMedia: false,
    });
    expect(skippedRes.mediaRestored).toBe(0);
    expect(fs.existsSync(path.join(tempDir, 'media', storageKey))).toBe(false);

    // 2) linkSync failure falls back cleanly to copyFileSync
    fs.rmSync(path.join(tempDir, skippedRes.filePath), { force: true });
    vi.spyOn(fs, 'linkSync').mockImplementation((..._args) => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    });
    const copyRes = pullFromSnapshot({
      workspaceRoot: tempDir,
      cache,
      id: postId,
    });
    expect(copyRes.updated).toBe(true);
    expect(copyRes.mediaRestored).toBe(1);
    const mirrorPath = path.join(tempDir, 'media', storageKey);
    expect(sha256(fs.readFileSync(mirrorPath))).toBe(sha256(pngBytes));
  });

  it('detects corrupt cache file size and emits [MEDIA_CACHE_CORRUPT]', async () => {
    const postId = '01M8POST000000000000000005';
    const mediaId = '01M8MED0000000000000000005';
    const storageKey = '01M8KEY0000000000000000005.png';
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
    const counts = { fileGets: 0 };

    await captureWorkspaceSnapshot({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      includeMedia: true,
      fetchFn: buildOnlineMock(
        [{ id: postId, slug: 'corrupt-post', title: 'Corrupt', status: 'published', storageKey }],
        [
          {
            id: mediaId,
            storageKey,
            filename: 'corrupt.png',
            mimeType: 'image/png',
            bytes: pngBytes,
          },
        ],
        counts,
      ),
    });

    const cacheFile = path.join(tempDir, 'media', '_cache', toMediaCacheFileName(storageKey)!);
    fs.writeFileSync(cacheFile, Buffer.from('corrupt'));

    const corruptRes = pullFromSnapshot({
      workspaceRoot: tempDir,
      cache,
      id: postId,
    });
    expect(corruptRes.mediaRestored).toBe(0);
    expect(corruptRes.mediaMissing).toBe(1);
    expect(corruptRes.warnings.some((w) => w.includes('[MEDIA_CACHE_CORRUPT'))).toBe(true);
    expect(corruptRes.warnings.some((w) => w.includes('[MEDIA_NOT_GUARANTEED]'))).toBe(true);
  });

  it('isolates media/_cache/ from doctor, local search, pullMedia prune, and deleteMedia', async () => {
    const postId = '01M8POST000000000000000003';
    const mediaId = '01M8MED0000000000000000003';
    const storageKey = '01M8KEY0000000000000000003.png';
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 1, 1, 1]);
    const counts = { fileGets: 0 };

    await captureWorkspaceSnapshot({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      includeMedia: true,
      fetchFn: buildOnlineMock(
        [{ id: postId, slug: 'iso-post', title: 'Iso', status: 'published', storageKey }],
        [{ id: mediaId, storageKey, filename: 'iso.png', mimeType: 'image/png', bytes: pngBytes }],
        counts,
      ),
    });

    const cacheFileName = toMediaCacheFileName(storageKey)!;
    const cacheRelPath = `media/_cache/${cacheFileName}`;

    // Doctor must NOT report _cache as unindexed/nonYamlMediaFiles
    const doctorRes = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config: DEFAULT_CONFIG,
    });
    expect(
      doctorRes.checks.some((c) => c.status !== 'ok' && JSON.stringify(c).includes('_cache')),
    ).toBe(false);

    // searchLocalMirrorMedia must NOT treat _cache files as mirrors, while snapshot hits carry cached: true
    const mirrorIndex = collectLocalMirrorIndex(tempDir, cache);
    const searchRes = searchLocalMirrorMedia({ mirrorIndex, cache, query: 'iso' });
    expect(searchRes.hits.some((h) => h.localPath?.includes('_cache'))).toBe(false);
    expect(searchRes.hits.find((h) => h.storageKey === storageKey)?.cached).toBe(true);

    // pullMedia({ prune: true }) must NOT delete media/_cache/
    const emptyFetch = buildOnlineMock([], [], { fileGets: 0 });
    await pullMedia({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      prune: true,
      fetchFn: emptyFetch,
    });
    expect(fs.existsSync(path.join(tempDir, cacheRelPath))).toBe(true);

    // deleteMedia must reject direct media/_cache/* target
    await expect(
      deleteMedia({
        workspaceRoot: tempDir,
        cache,
        origin: 'https://example.com',
        token: 'tok',
        targets: [cacheRelPath],
        fetchFn: emptyFetch,
      }),
    ).rejects.toThrow(/media\/_cache\//);
  });

  it('handles clearWorkspaceSnapshot GC ordering (single-collection preserve vs last-collection delete) and pruneOrphanMediaCache', async () => {
    const keyA = '01M8KEYA000000000000000001.png';
    const keyB = '01M8KEYB000000000000000002.png';
    const bytes = Buffer.from([1, 2, 3, 4]);
    const counts = { fileGets: 0 };

    await captureWorkspaceSnapshot({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      includeMedia: true,
      fetchFn: buildOnlineMock(
        [{ id: '01M8PA', slug: 'post-a', title: 'A', status: 'published', storageKey: keyA }],
        [
          { id: '01M8MA', storageKey: keyA, filename: 'a.png', mimeType: 'image/png', bytes },
          { id: '01M8MB', storageKey: keyB, filename: 'b.png', mimeType: 'image/png', bytes },
        ],
        counts,
      ),
    });

    // Add a second collection meta so clearing 'posts' is NOT the last snapshot_meta
    cache.saveSnapshotMeta({
      collection: 'pages',
      capturedAt: Date.now(),
      articleCount: 0,
      mediaCount: 0,
      taxonomyFetchedCount: 0,
      taxonomyReusedCount: 0,
      articleSingleGetCount: 0,
      durationMs: 10,
    });

    const partialClear = clearWorkspaceSnapshot(cache, 'posts', tempDir);
    expect(partialClear.cacheFilesDeleted).toBe(0);
    expect(partialClear.cacheFilesPreserved).toBe(0);

    // Re-capture and write a local article referencing keyA on disk
    await captureWorkspaceSnapshot({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      includeMedia: true,
      fetchFn: buildOnlineMock(
        [{ id: '01M8PA', slug: 'post-a', title: 'A', status: 'published', storageKey: keyA }],
        [
          { id: '01M8MA', storageKey: keyA, filename: 'a.png', mimeType: 'image/png', bytes },
          { id: '01M8MB', storageKey: keyB, filename: 'b.png', mimeType: 'image/png', bytes },
        ],
        counts,
      ),
    });
    fs.mkdirSync(path.join(tempDir, 'posts', 'published'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'posts', 'published', '20261120_01M8PA-post-a.md'),
      `---\nid: 01M8PA\nslug: post-a\ntitle: A\ncollection: posts\nstatus: published\n---\n\n![a](../../media/${keyA})\n`,
      'utf8',
    );

    // Clear 'pages' first so clearing 'posts' becomes the final snapshot_meta clear
    clearWorkspaceSnapshot(cache, 'pages', tempDir);
    const fullClear = clearWorkspaceSnapshot(cache, 'posts', tempDir);
    expect(fullClear.cacheFilesDeleted).toBe(1);
    expect(fullClear.cacheFilesPreserved).toBe(1);
    expect(fs.existsSync(path.join(tempDir, 'media', '_cache', toMediaCacheFileName(keyA)!))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(tempDir, 'media', '_cache', toMediaCacheFileName(keyB)!))).toBe(
      false,
    );

    // Drop an orphan file into media/_cache/ and verify pruneOrphanMediaCache removes unbacked files
    const orphanPath = path.join(tempDir, 'media', '_cache', 'orphan-file.png');
    fs.writeFileSync(orphanPath, bytes);
    const pruneRes = pruneOrphanMediaCache(cache, tempDir);
    expect(pruneRes.deletedFiles).toBe(2);
    expect(fs.existsSync(orphanPath)).toBe(false);
  });

  it('excludes slash-bearing migrated keys from cache and reports [MEDIA_NOT_GUARANTEED]', async () => {
    const postId = '01M8POST000000000000000004';
    const mediaId = '01M8MED0000000000000000004';
    const slashKey = 'uploads/2026/11/sample.png';
    const counts = { fileGets: 0 };

    const cap = await captureWorkspaceSnapshot({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'tok',
      includeMedia: true,
      fetchFn: buildOnlineMock(
        [
          {
            id: postId,
            slug: 'migrated-post',
            title: 'Migrated',
            status: 'published',
            storageKey: slashKey,
          },
        ],
        [
          {
            id: mediaId,
            storageKey: slashKey,
            filename: 'sample.png',
            mimeType: 'image/png',
            bytes: Buffer.from([1, 2]),
          },
        ],
        counts,
      ),
    });

    expect(cap.mediaCached).toBe(0);
    expect(counts.fileGets).toBe(0);

    const pullRes = pullFromSnapshot({
      workspaceRoot: tempDir,
      cache,
      id: postId,
    });
    expect(pullRes.mediaRestored).toBe(0);
    expect(pullRes.warnings.some((w) => w.includes('[MEDIA_NOT_GUARANTEED]'))).toBe(true);
  });

  it('resolves snapshotMedia precedence cleanly without MCP mutating .emit/config.json', () => {
    const cfgBefore = loadConfig(tempDir);
    expect(cfgBefore.snapshotMedia).toBe(false);

    expect(resolveSnapshotMediaOption(true, cfgBefore)).toBe(true);
    expect(resolveSnapshotMediaOption(false, { ...cfgBefore, snapshotMedia: true })).toBe(false);
    expect(resolveSnapshotMediaOption(undefined, { ...cfgBefore, snapshotMedia: true })).toBe(true);
  });
});
