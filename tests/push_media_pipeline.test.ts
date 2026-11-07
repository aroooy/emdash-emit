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
import { computeMediaHashes } from '../src/client/media.js';
import { calculateHash } from '../src/sync/pull.js';
import { pushArticle } from '../src/sync/push.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';

const TINY_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('Offline Draft Media Auto-Upload Pipeline (P1 - P6 & Compensation)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  const articleId = '01M67MP2W0VKCK2DFWM166CR24';
  const mediaRecordId = '01M6TF1XXBS2KC9EVYG6RBT0J0';
  const pendingStorageKey = '01M6TF1XXBSC06QQG9M648B4K3.png';
  const confirmedStorageKey = '01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png';
  const confirmedUrl = `/_emdash/api/media/file/${confirmedStorageKey}`;
  const todayPrefix = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const baseOptions = {
    origin: 'https://aroooy.net',
    token: 'test-token',
    bylineSlugToId: { aroooy: '01M6BYLINE0000000000000000' },
    knownTaxonomies: { categories: ['tech'], tags: ['cloudflare'] },
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-push-media-pipeline-'));
    fs.mkdirSync(path.join(tempDir, 'posts', 'draft'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'media', 'drafts'), { recursive: true });
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedTrackedArticle(slug: string, body: string): string {
    const fm: Frontmatter = {
      id: articleId,
      slug,
      title: `Title ${slug}`,
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: { categories: ['tech'], tags: ['cloudflare'] },
      bylines: ['aroooy'],
    };
    const relPath = `posts/draft/${todayPrefix}_${articleId}-${slug}.md`;
    const serialized = serializeMarkdown(fm, body);
    fs.writeFileSync(path.join(tempDir, relPath), serialized, 'utf8');

    cache.saveEntry({
      id: articleId,
      collection: 'posts',
      slug,
      status: 'draft',
      title: fm.title,
      rev: '1',
      publishedAt: null,
      rawJson: JSON.stringify({
        id: articleId,
        slug,
        status: 'draft',
        data: { title: fm.title, content: [] },
      }),
      updatedAt: 1700000000,
    });
    cache.saveBaseSnapshot({
      id: articleId,
      rev: '1',
      bodyMarkdown: 'Initial paragraph.',
      frontmatterYaml: JSON.stringify(fm),
      hash: calculateHash(serializeMarkdown(fm, 'Initial paragraph.')),
      savedAt: 1700000000,
    });
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: calculateHash(serialized),
      remoteRev: '1',
      status: 'draft',
      slug,
      lastSyncedAt: 1700000000,
    });

    return relPath;
  }

  it('uploads media/drafts/* via 4-phase flow, rewrites body to storageKey URL (never record ID), promotes asset, and stays idempotent on second push', async () => {
    const draftImgPath = path.join(tempDir, 'media', 'drafts', 'flight-sunset.png');
    fs.writeFileSync(draftImgPath, TINY_PNG_BUFFER);

    const relPath = seedTrackedArticle(
      'offline-flight',
      [
        'Writing offline on the plane.',
        '',
        '![Sunset from window](../../media/drafts/flight-sunset.png)',
        '',
        '```markdown',
        '![Example in code fence](../../media/drafts/flight-sunset.png)',
        '```',
      ].join('\n'),
    );

    const requestLog: string[] = [];
    let capturedPutPayload: Record<string, unknown> | null = null;

    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      requestLog.push(`${method} ${new URL(url).pathname}`);

      // Lock acquire / release
      if (url.includes('/lock')) {
        return new Response(JSON.stringify({ status: 'acquired' }), { status: 200 });
      }
      // Terms sync
      if (url.includes('/terms/')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      // Phase A: upload-url
      if (method === 'POST' && url.endsWith('/_emdash/api/media/upload-url')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              uploadUrl: `/_emdash/api/media/${mediaRecordId}/upload`,
              method: 'PUT',
              headers: { 'Content-Type': 'image/png', 'X-EmDash-Request': '1' },
              mediaId: mediaRecordId,
              storageKey: pendingStorageKey,
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            },
          }),
          { status: 200 },
        );
      }
      // Phase B: PUT binary
      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaRecordId}/upload`)) {
        return new Response(
          JSON.stringify({ success: true, data: { uploaded: true, size: TINY_PNG_BUFFER.length } }),
          { status: 200 },
        );
      }
      // Phase C: confirm (returns double-ULID storageKey)
      if (method === 'POST' && url.endsWith(`/_emdash/api/media/${mediaRecordId}/confirm`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              item: {
                id: mediaRecordId,
                filename: 'flight-sunset.png',
                mimeType: 'image/png',
                size: TINY_PNG_BUFFER.length,
                width: 1,
                height: 1,
                storageKey: confirmedStorageKey,
                contentHash: 'sha1:4a5eb7171b58e08a6881721e3b43d5a44419a2be',
                status: 'ready',
                createdAt: '2026-11-07T07:37:33.355Z',
                url: confirmedUrl,
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/_emdash/api/media/')) {
        // B-2: Best-effort PUT /_emdash/api/media/{id} to sync alt text
        if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaRecordId}`)) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
      }
      // Phase D: Article PUT
      if (method === 'PUT' && url.endsWith(`/_emdash/api/content/posts/${articleId}`)) {
        capturedPutPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ item: { id: articleId }, _rev: '2' }), {
          status: 200,
        });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as unknown as typeof fetch;

    const res1 = await pushArticle(relPath, {
      ...baseOptions,
      workspaceRoot: tempDir,
      cache,
      fetchFn,
    });

    expect(res1.success).toBe(true);
    expect(res1.rev).toBe('2');
    expect(
      res1.warnings?.some((w) => w.includes('[LOCAL_IMAGE_AUTO_UPLOAD] Auto-uploaded 1 draft')),
    ).toBe(true);

    // Verify order: lock acquired BEFORE upload-url -> PUT upload -> POST confirm -> PUT article (B-3)
    expect(requestLog).toContain(`POST /_emdash/api/content/posts/${articleId}/lock`);
    expect(requestLog).toContain('POST /_emdash/api/media/upload-url');
    expect(requestLog).toContain(`PUT /_emdash/api/media/${mediaRecordId}/upload`);
    expect(requestLog).toContain(`POST /_emdash/api/media/${mediaRecordId}/confirm`);
    expect(requestLog).toContain(`PUT /_emdash/api/content/posts/${articleId}`);
    expect(requestLog.indexOf(`POST /_emdash/api/content/posts/${articleId}/lock`)).toBeLessThan(
      requestLog.indexOf('POST /_emdash/api/media/upload-url'),
    );
    expect(requestLog.indexOf(`POST /_emdash/api/media/${mediaRecordId}/confirm`)).toBeLessThan(
      requestLog.indexOf(`PUT /_emdash/api/content/posts/${articleId}`),
    );

    // CRITICAL P0-1 CHECK: Portable Text image block uses storageKey URL, NEVER mediaRecordId!
    const contentBlocks = (capturedPutPayload!.data as { content: Array<Record<string, unknown>> })
      .content;
    const imageBlock = contentBlocks.find((b) => b._type === 'image') as {
      alt: string;
      asset: { url: string };
    };
    expect(imageBlock).toBeDefined();
    expect(imageBlock.alt).toBe('Sunset from window');
    expect(imageBlock.asset.url).toBe(confirmedUrl);
    expect(imageBlock.asset.url).not.toContain(mediaRecordId);

    // Verify local Markdown on disk was rewritten with confirmedUrl (code fence preserved)
    const diskMd = fs.readFileSync(path.join(tempDir, res1.filePath), 'utf8');
    expect(diskMd).toContain(`![Sunset from window](${confirmedUrl})`);
    expect(diskMd).toContain('![Example in code fence](../../media/drafts/flight-sunset.png)');

    // Verify cache.db sync_state hash matches the rewritten Markdown on disk
    const syncState = cache.getSyncState(articleId);
    expect(syncState?.localHash).toBe(calculateHash(diskMd));

    // Verify draft file was moved out of media/drafts/ and promoted into media/ with companion YAML
    expect(fs.existsSync(draftImgPath)).toBe(false);
    const promotedFile = path.join(tempDir, 'media', `20261107_${mediaRecordId}-flight-sunset.png`);
    const promotedYaml = path.join(
      tempDir,
      'media',
      `20261107_${mediaRecordId}-flight-sunset.yaml`,
    );
    expect(fs.existsSync(promotedFile)).toBe(true);
    expect(fs.existsSync(promotedYaml)).toBe(true);

    // Verify media_state is committed as 'ready'
    const { localHash } = computeMediaHashes(TINY_PNG_BUFFER);
    const mediaState = cache.getMediaState(localHash);
    expect(mediaState?.status).toBe('ready');
    expect(mediaState?.mediaId).toBe(mediaRecordId);
    expect(mediaState?.storageKey).toBe(confirmedStorageKey);

    // Second push: body no longer contains draft paths, so media upload endpoints are never called
    requestLog.length = 0;
    const res2 = await pushArticle(res1.filePath, {
      ...baseOptions,
      workspaceRoot: tempDir,
      cache,
      fetchFn,
    });
    expect(res2.success).toBe(true);
    expect(requestLog.some((r) => r.includes('/_emdash/api/media'))).toBe(false);
  });

  it('aborts push, deletes orphan pending record on server, and leaves local .md and media/drafts/ completely untouched when upload fails', async () => {
    const draftImgPath = path.join(tempDir, 'media', 'drafts', 'broken-upload.png');
    fs.writeFileSync(draftImgPath, TINY_PNG_BUFFER);

    const originalBody = 'Paragraph.\n\n![Broken](../../media/drafts/broken-upload.png)';
    const relPath = seedTrackedArticle('abort-on-upload-fail', originalBody);
    const originalDiskMd = fs.readFileSync(path.join(tempDir, relPath), 'utf8');

    const deletedMediaIds: string[] = [];
    let articlePutCalled = false;

    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();

      if (url.includes('/lock')) {
        return new Response(JSON.stringify({ status: 'acquired' }), { status: 200 });
      }

      if (method === 'POST' && url.endsWith('/_emdash/api/media/upload-url')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              uploadUrl: `/_emdash/api/media/${mediaRecordId}/upload`,
              method: 'PUT',
              headers: { 'Content-Type': 'image/png' },
              mediaId: mediaRecordId,
              storageKey: pendingStorageKey,
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            },
          }),
          { status: 200 },
        );
      }

      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaRecordId}/upload`)) {
        return new Response('R2 Failure', { status: 500, statusText: 'Internal Server Error' });
      }

      if (method === 'GET' && url.endsWith(`/_emdash/api/media/${mediaRecordId}`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: { item: { id: mediaRecordId, status: 'pending' } },
          }),
          { status: 200 },
        );
      }

      if (method === 'DELETE' && url.endsWith(`/_emdash/api/media/${mediaRecordId}`)) {
        deletedMediaIds.push(mediaRecordId);
        return new Response(JSON.stringify({ success: true, data: { deleted: true } }), {
          status: 200,
        });
      }

      if (url.includes('/_emdash/api/content/') && !url.includes('/lock')) {
        articlePutCalled = true;
      }

      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof fetch;

    await expect(
      pushArticle(relPath, {
        ...baseOptions,
        workspaceRoot: tempDir,
        cache,
        fetchFn,
      }),
    ).rejects.toThrow(/Failed to upload binary/);

    expect(deletedMediaIds).toEqual([mediaRecordId]);
    expect(articlePutCalled).toBe(false);
    // Local file and draft image remain 100% untouched
    expect(fs.readFileSync(path.join(tempDir, relPath), 'utf8')).toBe(originalDiskMd);
    expect(fs.existsSync(draftImgPath)).toBe(true);
  });

  it('recovers cleanly from the "upload succeeded -> article PUT failed" window on the next push without re-uploading media', async () => {
    const draftImgPath = path.join(tempDir, 'media', 'drafts', 'window-test.png');
    fs.writeFileSync(draftImgPath, TINY_PNG_BUFFER);

    const relPath = seedTrackedArticle(
      'window-recovery',
      'Testing window.\n\n![Window](../../media/drafts/window-test.png)',
    );
    const originalDiskMd = fs.readFileSync(path.join(tempDir, relPath), 'utf8');

    let shouldFailArticlePut = true;
    let mediaApiCalls = 0;

    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();

      if (url.includes('/lock')) {
        return new Response(JSON.stringify({ status: 'acquired' }), { status: 200 });
      }
      if (url.includes('/terms/')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.includes('/_emdash/api/media')) {
        mediaApiCalls++;
        if (method === 'POST' && url.endsWith('/upload-url')) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                uploadUrl: `/_emdash/api/media/${mediaRecordId}/upload`,
                method: 'PUT',
                headers: { 'Content-Type': 'image/png' },
                mediaId: mediaRecordId,
                storageKey: pendingStorageKey,
                expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              },
            }),
            { status: 200 },
          );
        }
        if (method === 'PUT' && url.endsWith('/upload')) {
          return new Response(JSON.stringify({ success: true, data: { uploaded: true } }), {
            status: 200,
          });
        }
        if (method === 'POST' && url.endsWith('/confirm')) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                item: {
                  id: mediaRecordId,
                  filename: 'window-test.png',
                  mimeType: 'image/png',
                  size: TINY_PNG_BUFFER.length,
                  storageKey: confirmedStorageKey,
                  status: 'ready',
                  createdAt: '2026-11-07T07:37:33.355Z',
                  url: confirmedUrl,
                },
              },
            }),
            { status: 200 },
          );
        }
        if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaRecordId}`)) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        if (method === 'GET' && url.endsWith(`/_emdash/api/media/${mediaRecordId}`)) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                item: {
                  id: mediaRecordId,
                  filename: 'window-test.png',
                  mimeType: 'image/png',
                  size: TINY_PNG_BUFFER.length,
                  storageKey: confirmedStorageKey,
                  status: 'ready',
                  createdAt: '2026-11-07T07:37:33.355Z',
                  url: confirmedUrl,
                },
              },
            }),
            { status: 200 },
          );
        }
      }

      if (method === 'PUT' && url.endsWith(`/_emdash/api/content/posts/${articleId}`)) {
        if (shouldFailArticlePut) {
          return new Response('Service Unavailable', {
            status: 503,
            statusText: 'Service Unavailable',
          });
        }
        return new Response(JSON.stringify({ item: { id: articleId }, _rev: '2' }), {
          status: 200,
        });
      }

      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof fetch;

    // 1st push: media upload succeeds (upload-url + PUT upload + POST confirm + PUT alt = 4 calls), but article PUT fails with 503
    await expect(
      pushArticle(relPath, {
        ...baseOptions,
        workspaceRoot: tempDir,
        cache,
        fetchFn,
      }),
    ).rejects.toThrow(/Push failed: Service Unavailable/);

    expect(mediaApiCalls).toBe(4);
    // Draft file and local .md are still in their original state
    expect(fs.existsSync(draftImgPath)).toBe(true);
    expect(fs.readFileSync(path.join(tempDir, relPath), 'utf8')).toBe(originalDiskMd);

    // media_state holds status='uploaded' with the confirmed storageKey and URL
    const { localHash } = computeMediaHashes(TINY_PNG_BUFFER);
    expect(cache.getMediaState(localHash)?.status).toBe('uploaded');

    // 2nd push: article PUT succeeds; only 1 lightweight GET check is made (B-4), Phase A/B/C are skipped!
    shouldFailArticlePut = false;
    mediaApiCalls = 0;

    const res2 = await pushArticle(relPath, {
      ...baseOptions,
      workspaceRoot: tempDir,
      cache,
      fetchFn,
    });

    expect(res2.success).toBe(true);
    expect(mediaApiCalls).toBe(1);
    expect(fs.existsSync(draftImgPath)).toBe(false);
    expect(cache.getMediaState(localHash)?.status).toBe('ready');
    expect(fs.readFileSync(path.join(tempDir, res2.filePath), 'utf8')).toContain(
      `![Window](${confirmedUrl})`,
    );
  });

  it('reuses an already-promoted draft image across a second article without re-uploading or throwing MISSING_LOCAL_IMAGE_FILE (P1)', async () => {
    const draftImgPath = path.join(tempDir, 'media', 'drafts', 'shared-banner.png');
    fs.writeFileSync(draftImgPath, TINY_PNG_BUFFER);

    const relPathA = seedTrackedArticle(
      'article-a',
      'Article A.\n\n![Banner A](../../media/drafts/shared-banner.png)',
    );

    const secondArticleId = '01M6SECONDARTICLE000000000';
    const fmB: Frontmatter = {
      id: secondArticleId,
      slug: 'article-b',
      title: 'Title article-b',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: { categories: ['tech'], tags: ['cloudflare'] },
      bylines: ['aroooy'],
    };
    const relPathB = `posts/draft/${todayPrefix}_${secondArticleId}-article-b.md`;
    const bodyB =
      'Article B sharing the same banner.\n\n![Banner B](../../media/drafts/shared-banner.png)';
    fs.writeFileSync(path.join(tempDir, relPathB), serializeMarkdown(fmB, bodyB), 'utf8');
    cache.saveSyncState({
      id: secondArticleId,
      localFilePath: relPathB,
      localHash: calculateHash(serializeMarkdown(fmB, bodyB)),
      remoteRev: '1',
      status: 'draft',
      slug: 'article-b',
      lastSyncedAt: 1700000000,
    });

    let uploadUrlCalls = 0;
    let mediaDetailCalls = 0;
    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();

      if (url.includes('/lock')) {
        return new Response(JSON.stringify({ status: 'acquired' }), { status: 200 });
      }
      if (url.includes('/terms/')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (method === 'GET' && url.endsWith(`/_emdash/api/media/${mediaRecordId}`)) {
        mediaDetailCalls++;
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              item: {
                id: mediaRecordId,
                filename: 'shared-banner.png',
                mimeType: 'image/png',
                size: TINY_PNG_BUFFER.length,
                storageKey: confirmedStorageKey,
                status: 'ready',
                createdAt: '2026-11-07T07:37:33.355Z',
                url: confirmedUrl,
              },
            },
          }),
          { status: 200 },
        );
      }
      if (method === 'POST' && url.endsWith('/_emdash/api/media/upload-url')) {
        uploadUrlCalls++;
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              uploadUrl: `/_emdash/api/media/${mediaRecordId}/upload`,
              method: 'PUT',
              headers: { 'Content-Type': 'image/png' },
              mediaId: mediaRecordId,
              storageKey: pendingStorageKey,
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            },
          }),
          { status: 200 },
        );
      }
      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaRecordId}/upload`)) {
        return new Response(JSON.stringify({ success: true, data: { uploaded: true } }), {
          status: 200,
        });
      }
      if (method === 'POST' && url.endsWith(`/_emdash/api/media/${mediaRecordId}/confirm`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              item: {
                id: mediaRecordId,
                filename: 'shared-banner.png',
                mimeType: 'image/png',
                size: TINY_PNG_BUFFER.length,
                storageKey: confirmedStorageKey,
                status: 'ready',
                createdAt: '2026-11-07T07:37:33.355Z',
                url: confirmedUrl,
              },
            },
          }),
          { status: 200 },
        );
      }
      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaRecordId}`)) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (method === 'PUT' && url.includes('/_emdash/api/content/posts/')) {
        return new Response(JSON.stringify({ item: { id: articleId }, _rev: '2' }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof fetch;

    // 1st article push uploads and promotes media/drafts/shared-banner.png -> media/20261107_...-shared-banner.png
    const resA = await pushArticle(relPathA, {
      ...baseOptions,
      workspaceRoot: tempDir,
      cache,
      fetchFn,
    });
    expect(resA.success).toBe(true);
    expect(uploadUrlCalls).toBe(1);
    expect(fs.existsSync(draftImgPath)).toBe(false);

    // 2nd article push still references ../../media/drafts/shared-banner.png -> reuses promoted asset without error!
    const resB = await pushArticle(relPathB, {
      ...baseOptions,
      workspaceRoot: tempDir,
      cache,
      fetchFn,
    });
    expect(resB.success).toBe(true);
    expect(uploadUrlCalls).toBe(1); // No second upload!
    expect(
      resB.warnings?.some((w) =>
        w.includes('[LOCAL_IMAGE_AUTO_UPLOAD] Reused 1 already-promoted media asset'),
      ),
    ).toBe(true);
    // Remote existence of the reused asset was explicitly verified (1 GET, no re-upload)
    expect(mediaDetailCalls).toBe(1);
    expect(resB.warnings?.some((w) => w.includes('[MEDIA_EXISTENCE_UNVERIFIED]'))).toBe(false);

    const diskMdB = fs.readFileSync(path.join(tempDir, resB.filePath), 'utf8');
    expect(diskMdB).toContain(`![Banner B](${confirmedUrl})`);
  });

  /** Seeds a second tracked article (distinct ULID) used by the already-promoted reuse tests. */
  function seedSecondArticle(body: string): string {
    const secondArticleId = '01M6SECONDARTICLE000000000';
    const fm: Frontmatter = {
      id: secondArticleId,
      slug: 'article-b',
      title: 'Title article-b',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: { categories: ['tech'], tags: ['cloudflare'] },
      bylines: ['aroooy'],
    };
    const relPath = `posts/draft/${todayPrefix}_${secondArticleId}-article-b.md`;
    fs.writeFileSync(path.join(tempDir, relPath), serializeMarkdown(fm, body), 'utf8');
    cache.saveSyncState({
      id: secondArticleId,
      localFilePath: relPath,
      localHash: calculateHash(serializeMarkdown(fm, body)),
      remoteRev: '1',
      status: 'draft',
      slug: 'article-b',
      lastSyncedAt: 1700000000,
    });
    return relPath;
  }

  it('aborts with PROMOTED_MEDIA_NOT_FOUND_REMOTE and purges the stale record when the promoted media was deleted on remote (R-1)', async () => {
    const draftImgPath = path.join(tempDir, 'media', 'drafts', 'shared-banner.png');
    fs.writeFileSync(draftImgPath, TINY_PNG_BUFFER);

    const relPathA = seedTrackedArticle(
      'article-a',
      'Article A.\n\n![Banner A](../../media/drafts/shared-banner.png)',
    );
    const relPathB = seedSecondArticle(
      'Article B referencing the same banner.\n\n![Banner B](../../media/drafts/shared-banner.png)',
    );

    let uploadUrlCalls = 0;
    let mediaDetailCalls = 0;

    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();

      if (url.includes('/lock')) {
        return new Response(JSON.stringify({ status: 'acquired' }), { status: 200 });
      }
      if (url.includes('/terms/')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      // Remote existence check: the media record was deleted on the EmDash side
      if (method === 'GET' && url.endsWith(`/_emdash/api/media/${mediaRecordId}`)) {
        mediaDetailCalls++;
        return new Response(JSON.stringify({ success: false, message: 'Media not found' }), {
          status: 404,
        });
      }
      if (method === 'POST' && url.endsWith('/_emdash/api/media/upload-url')) {
        uploadUrlCalls++;
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              uploadUrl: `/_emdash/api/media/${mediaRecordId}/upload`,
              method: 'PUT',
              headers: { 'Content-Type': 'image/png' },
              mediaId: mediaRecordId,
              storageKey: pendingStorageKey,
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            },
          }),
          { status: 200 },
        );
      }
      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaRecordId}/upload`)) {
        return new Response(JSON.stringify({ success: true, data: { uploaded: true } }), {
          status: 200,
        });
      }
      if (method === 'POST' && url.endsWith(`/_emdash/api/media/${mediaRecordId}/confirm`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              item: {
                id: mediaRecordId,
                filename: 'shared-banner.png',
                mimeType: 'image/png',
                size: TINY_PNG_BUFFER.length,
                storageKey: confirmedStorageKey,
                status: 'ready',
                createdAt: '2026-11-07T07:37:33.355Z',
                url: confirmedUrl,
              },
            },
          }),
          { status: 200 },
        );
      }
      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaRecordId}`)) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (method === 'PUT' && url.includes('/_emdash/api/content/posts/')) {
        return new Response(JSON.stringify({ item: { id: articleId }, _rev: '2' }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof fetch;

    // 1st push uploads and promotes the draft image normally
    const resA = await pushArticle(relPathA, {
      ...baseOptions,
      workspaceRoot: tempDir,
      cache,
      fetchFn,
    });
    expect(resA.success).toBe(true);
    expect(uploadUrlCalls).toBe(1);
    expect(cache.getMediaStateByMediaId(mediaRecordId)?.status).toBe('ready');

    // 2nd push: the canonical URL must NOT be baked into the body because the remote record is gone
    await expect(
      pushArticle(relPathB, {
        ...baseOptions,
        workspaceRoot: tempDir,
        cache,
        fetchFn,
      }),
    ).rejects.toThrow(/no longer exists on remote/);

    expect(mediaDetailCalls).toBe(1);
    expect(uploadUrlCalls).toBe(1); // Emit does not silently re-upload behind the user's back
    expect(cache.getMediaStateByMediaId(mediaRecordId)).toBeNull(); // stale media_state purged

    // Article B on disk is untouched and still references the local draft path
    const diskMdB = fs.readFileSync(path.join(tempDir, relPathB), 'utf8');
    expect(diskMdB).toContain('![Banner B](../../media/drafts/shared-banner.png)');
    expect(diskMdB).not.toContain('/_emdash/api/media/file/');
  });

  it('still pushes but warns [MEDIA_EXISTENCE_UNVERIFIED] when the server does not support the media existence GET (R-2)', async () => {
    const draftImgPath = path.join(tempDir, 'media', 'drafts', 'shared-banner.png');
    fs.writeFileSync(draftImgPath, TINY_PNG_BUFFER);

    const relPathA = seedTrackedArticle(
      'article-a',
      'Article A.\n\n![Banner A](../../media/drafts/shared-banner.png)',
    );
    const relPathB = seedSecondArticle(
      'Article B referencing the same banner.\n\n![Banner B](../../media/drafts/shared-banner.png)',
    );

    let uploadUrlCalls = 0;
    let mediaDetailCalls = 0;

    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();

      if (url.includes('/lock')) {
        return new Response(JSON.stringify({ status: 'acquired' }), { status: 200 });
      }
      if (url.includes('/terms/')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      // Server does not implement the single-media GET endpoint
      if (method === 'GET' && url.endsWith(`/_emdash/api/media/${mediaRecordId}`)) {
        mediaDetailCalls++;
        return new Response(JSON.stringify({ success: false, message: 'Not Implemented' }), {
          status: 501,
        });
      }
      if (method === 'POST' && url.endsWith('/_emdash/api/media/upload-url')) {
        uploadUrlCalls++;
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              uploadUrl: `/_emdash/api/media/${mediaRecordId}/upload`,
              method: 'PUT',
              headers: { 'Content-Type': 'image/png' },
              mediaId: mediaRecordId,
              storageKey: pendingStorageKey,
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            },
          }),
          { status: 200 },
        );
      }
      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaRecordId}/upload`)) {
        return new Response(JSON.stringify({ success: true, data: { uploaded: true } }), {
          status: 200,
        });
      }
      if (method === 'POST' && url.endsWith(`/_emdash/api/media/${mediaRecordId}/confirm`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              item: {
                id: mediaRecordId,
                filename: 'shared-banner.png',
                mimeType: 'image/png',
                size: TINY_PNG_BUFFER.length,
                storageKey: confirmedStorageKey,
                status: 'ready',
                createdAt: '2026-11-07T07:37:33.355Z',
                url: confirmedUrl,
              },
            },
          }),
          { status: 200 },
        );
      }
      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaRecordId}`)) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (method === 'PUT' && url.includes('/_emdash/api/content/posts/')) {
        return new Response(JSON.stringify({ item: { id: articleId }, _rev: '2' }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected: ${method} ${url}`);
    }) as unknown as typeof fetch;

    const resA = await pushArticle(relPathA, {
      ...baseOptions,
      workspaceRoot: tempDir,
      cache,
      fetchFn,
    });
    expect(resA.success).toBe(true);
    expect(uploadUrlCalls).toBe(1);

    const resB = await pushArticle(relPathB, {
      ...baseOptions,
      workspaceRoot: tempDir,
      cache,
      fetchFn,
    });

    expect(resB.success).toBe(true);
    expect(mediaDetailCalls).toBe(1);
    expect(uploadUrlCalls).toBe(1); // reuse still happened: no re-upload
    expect(resB.warnings?.some((w) => w.includes('[MEDIA_EXISTENCE_UNVERIFIED]'))).toBe(true);
    expect(resB.warnings?.some((w) => w.includes('emit pull-media'))).toBe(true);
    // The warning must carry the concrete reason so a user can diagnose the server behavior
    expect(resB.warnings?.some((w) => w.includes('HTTP 501'))).toBe(true);

    const diskMdB = fs.readFileSync(path.join(tempDir, resB.filePath), 'utf8');
    expect(diskMdB).toContain(`![Banner B](${confirmedUrl})`);
  });

  it('G9b: ignores image lines inside Markdown code fences while still auto-uploading real draft images', async () => {
    const draftImgPath = path.join(tempDir, 'media', 'drafts', 'flight-sunset.png');
    fs.writeFileSync(draftImgPath, TINY_PNG_BUFFER);

    // A documentation article that quotes Emit's own image rules inside a fenced example.
    // None of the quoted paths exist on disk and one even points at media/, yet the fenced
    // block must never be inspected by G5 / G11.
    const relPath = seedTrackedArticle(
      'fence-guard',
      [
        'Documenting the offline image workflow.',
        '',
        '```md',
        '![Broken example](media/drafts/ghost.png)',
        '![Promoted example](media/20260101_01M6GHOST0000000000000000-ghost.png)',
        'Inline text with ![Inline ghost](media/drafts/ghost.png) inside.',
        '```',
        '',
        'The real asset is below.',
        '',
        '![Sunset from window](../../media/drafts/flight-sunset.png)',
      ].join('\n'),
    );

    const stats: MediaFlowStats = {
      uploadUrlCalls: 0,
      mediaDetailCalls: 0,
      requestLog: [],
      capturedPayload: null,
    };
    const fetchFn = mediaFlowMockServer(stats);

    const res = await pushArticle(relPath, {
      ...baseOptions,
      workspaceRoot: tempDir,
      cache,
      fetchFn,
    });

    expect(res.success).toBe(true);

    // Exactly one real upload: the quoted ghost references were never auto-uploaded
    expect(stats.uploadUrlCalls).toBe(1);

    // The Portable Text payload holds exactly one image block: the real draft image only
    const contentBlocks = (
      stats.capturedPayload!.data as { content: Array<Record<string, unknown>> }
    ).content;
    const imageBlocks = contentBlocks.filter((b) => b._type === 'image');
    expect(imageBlocks.length).toBe(1);
    expect((imageBlocks[0].asset as { url: string }).url).toBe(confirmedUrl);

    // The fenced example survived verbatim: code fences are never rewritten (G9 preservation)
    const diskMd = fs.readFileSync(path.join(tempDir, res.filePath), 'utf8');
    expect(diskMd).toContain('![Broken example](media/drafts/ghost.png)');
    expect(diskMd).toContain(
      '![Promoted example](media/20260101_01M6GHOST0000000000000000-ghost.png)',
    );
    expect(diskMd).toContain('Inline text with ![Inline ghost](media/drafts/ghost.png) inside.');
    expect(diskMd).toContain(`![Sunset from window](${confirmedUrl})`);

    // media_state contains only the promoted real asset
    const states = cache.listMediaStates();
    expect(states.length).toBe(1);
    expect(states[0].mediaId).toBe(mediaRecordId);
    expect(states[0].status).toBe('ready');
  });

  /** Mutable counters/collectors shared with {@link mediaFlowMockServer}. */
  interface MediaFlowStats {
    uploadUrlCalls: number;
    mediaDetailCalls: number;
    requestLog: string[];
    capturedPayload: Record<string, unknown> | null;
  }

  /**
   * EmDash media + article flow mock used by the G9b / cross-push dedup tests.
   * When `rejectArticlePut` is true, the first article PUT fails exactly once with 409.
   */
  function mediaFlowMockServer(stats: MediaFlowStats, rejectArticlePut = false): typeof fetch {
    let shouldReject = rejectArticlePut;
    return vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      stats.requestLog.push(`${method} ${new URL(url).pathname}`);

      if (url.includes('/lock')) {
        return new Response(JSON.stringify({ status: 'acquired' }), { status: 200 });
      }
      if (url.includes('/terms/')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (method === 'POST' && url.endsWith('/_emdash/api/media/upload-url')) {
        stats.uploadUrlCalls++;
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              uploadUrl: `/_emdash/api/media/${mediaRecordId}/upload`,
              method: 'PUT',
              headers: { 'Content-Type': 'image/png' },
              mediaId: mediaRecordId,
              storageKey: pendingStorageKey,
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            },
          }),
          { status: 200 },
        );
      }
      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaRecordId}/upload`)) {
        return new Response(JSON.stringify({ success: true, data: { uploaded: true } }), {
          status: 200,
        });
      }
      if (method === 'POST' && url.endsWith(`/_emdash/api/media/${mediaRecordId}/confirm`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              item: {
                id: mediaRecordId,
                filename: 'window-test.png',
                mimeType: 'image/png',
                size: TINY_PNG_BUFFER.length,
                storageKey: confirmedStorageKey,
                status: 'ready',
                createdAt: '2026-11-07T07:37:33.355Z',
                url: confirmedUrl,
              },
            },
          }),
          { status: 200 },
        );
      }
      if (method === 'PUT' && url.endsWith(`/_emdash/api/media/${mediaRecordId}`)) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (method === 'GET' && url.endsWith(`/_emdash/api/media/${mediaRecordId}`)) {
        stats.mediaDetailCalls++;
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              item: {
                id: mediaRecordId,
                filename: 'window-test.png',
                mimeType: 'image/png',
                size: TINY_PNG_BUFFER.length,
                storageKey: confirmedStorageKey,
                status: 'ready',
                createdAt: '2026-11-07T07:37:33.355Z',
                url: confirmedUrl,
              },
            },
          }),
          { status: 200 },
        );
      }
      if (method === 'PUT' && url.endsWith(`/_emdash/api/content/posts/${articleId}`)) {
        if (shouldReject) {
          shouldReject = false;
          return new Response(JSON.stringify({ error: { code: 'ENTRY_LOCKED' } }), {
            status: 409,
            statusText: 'Entry is currently locked by another user',
          });
        }
        stats.capturedPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ item: { id: articleId }, _rev: '2' }), {
          status: 200,
        });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as unknown as typeof fetch;
  }

  it('reuses a media upload already committed by a push whose article PUT was rejected', async () => {
    const draftImgPath = path.join(tempDir, 'media', 'drafts', 'window-test.png');
    fs.writeFileSync(draftImgPath, TINY_PNG_BUFFER);

    const relPath = seedTrackedArticle(
      'lock-window',
      'Article blocked by a remote entry lock.\n\n![Window test](../../media/drafts/window-test.png)',
    );

    const stats: MediaFlowStats = {
      uploadUrlCalls: 0,
      mediaDetailCalls: 0,
      requestLog: [],
      capturedPayload: null,
    };
    const fetchFn = mediaFlowMockServer(stats, true);

    // 1st push: the 4-phase media upload completes, then the article PUT is rejected remotely
    await expect(
      pushArticle(relPath, { ...baseOptions, workspaceRoot: tempDir, cache, fetchFn }),
    ).rejects.toThrow();

    expect(stats.uploadUrlCalls).toBe(1);
    const { localHash } = computeMediaHashes(TINY_PNG_BUFFER);
    expect(cache.getMediaState(localHash)?.status).toBe('uploaded');
    // Nothing was promoted yet: draft file and local Markdown remain untouched
    expect(fs.existsSync(draftImgPath)).toBe(true);
    expect(fs.readFileSync(path.join(tempDir, relPath), 'utf8')).toContain(
      '![Window test](../../media/drafts/window-test.png)',
    );

    // 2nd push: the committed media record is reused instead of a second 4-phase upload
    stats.requestLog.length = 0;
    const res = await pushArticle(relPath, {
      ...baseOptions,
      workspaceRoot: tempDir,
      cache,
      fetchFn,
    });

    expect(res.success).toBe(true);
    expect(stats.uploadUrlCalls).toBe(1); // no second upload
    expect(stats.requestLog.some((r) => r.includes('upload-url'))).toBe(false);
    expect(stats.requestLog.some((r) => r.includes(`/media/${mediaRecordId}/upload`))).toBe(false);
    expect(stats.mediaDetailCalls).toBe(1); // remote existence verified once
    expect(res.warnings?.some((w) => w.includes('[LOCAL_IMAGE_AUTO_UPLOAD]'))).toBe(true);

    // Promotion happens only on the push that actually succeeded
    expect(fs.existsSync(draftImgPath)).toBe(false);
    const promotedRel = `media/${todayPrefix}_${mediaRecordId}-window-test.png`;
    expect(fs.existsSync(path.join(tempDir, promotedRel))).toBe(true);
    expect(cache.getMediaState(localHash)?.status).toBe('ready');
    expect(cache.getMediaState(localHash)?.workspacePath).toBe(promotedRel);

    const diskMd = fs.readFileSync(path.join(tempDir, res.filePath), 'utf8');
    expect(diskMd).toContain(`![Window test](${confirmedUrl})`);
  });
});
