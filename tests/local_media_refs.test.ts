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
import { initWorkspace, loadConfig, persistLocalMediaRefs } from '../src/utils/config.js';
import { inspectArticleDiff } from '../src/sync/diff.js';
import { pushAll } from '../src/sync/orchestrator.js';
import { pullArticle, calculateHash } from '../src/sync/pull.js';
import { pushArticle } from '../src/sync/push.js';
import { getWorkspaceStatus } from '../src/sync/status.js';

const ARTICLE_ID = '01M67LQCALREF556YVG6RBT0J0';
const MEDIA_ID = '01M6TF1XXBS2KC9EVYG6RBT0J0';
const STORAGE_KEY = '01M67P0JW605ZJ5GV4YXB7W400.jpg';
const CANONICAL_URL = `/_emdash/api/media/file/${STORAGE_KEY}`;
/** How an article under `<collection>/draft|published/` spells its own mirror on disk. */
const LOCAL_REF = `../../media/${STORAGE_KEY}`;
const todayPrefix = new Date().toISOString().slice(0, 10).replace(/-/g, '');

describe('Article-Relative Local Media References (pull/push round-trip)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-local-media-refs-'));
    fs.mkdirSync(path.join(tempDir, 'posts', 'draft'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'media'), { recursive: true });
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
    // The mirror that a local reference resolves to.
    fs.writeFileSync(path.join(tempDir, 'media', STORAGE_KEY), Buffer.from('img'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const remoteItem = (rev: string) => ({
    id: ARTICLE_ID,
    slug: 'local-ref-article',
    collection: 'posts',
    status: 'draft',
    publishedAt: null,
    _rev: rev,
    data: {
      title: 'Local Ref Article',
      content: [
        { _type: 'block', style: 'normal', children: [{ _type: 'span', text: 'Body paragraph.' }] },
        {
          _type: 'image',
          alt: 'LG 背面端子',
          asset: { url: CANONICAL_URL, storageKey: STORAGE_KEY },
        },
      ],
    },
  });

  it('pull writes a mirrored image as an article-relative reference while the baseline keeps the canonical URL', async () => {
    const res = await pullArticle('posts', ARTICLE_ID, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      localMediaRefs: true,
      rawItem: remoteItem('rev_1'),
      fetchFn: vi.fn() as unknown as typeof fetch,
    });

    const disk = fs.readFileSync(path.join(tempDir, res.filePath), 'utf8');
    expect(disk).toContain(`![LG 背面端子](${LOCAL_REF})`);
    expect(disk).not.toContain(CANONICAL_URL);

    // The baseline must stay byte-identical to the canonical remote form or every diff and merge drifts.
    const base = cache.getBaseSnapshot(ARTICLE_ID)!;
    expect(base.bodyMarkdown).toContain(CANONICAL_URL);
    expect(base.bodyMarkdown).not.toContain(`media/${STORAGE_KEY}`);

    // sync_state tracks the exact bytes on disk, so an untouched article reads as synced.
    const status = getWorkspaceStatus(tempDir, cache, 'posts');
    expect(status.summary.modified).toBe(0);
    expect(status.summary.synced).toBe(1);

    // Re-pulling the same revision must hit the fast-path skip instead of rewriting the file from the canonical
    // baseline, which would silently swap every local reference for a remote URL.
    const repull = await pullArticle('posts', ARTICLE_ID, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      localMediaRefs: true,
      rawItem: remoteItem('rev_1'),
      fetchFn: vi.fn() as unknown as typeof fetch,
    });
    expect(repull.skipped).toBe(true);

    const afterRepull = fs.readFileSync(path.join(tempDir, res.filePath), 'utf8');
    expect(afterRepull).toBe(disk);

    // `diff` rebuilds the baseline from the canonical snapshot and compares it to disk. The two spellings must
    // never surface as a change, or every local-ref article would look permanently dirty.
    const inspection = inspectArticleDiff({ workspaceRoot: tempDir, cache, id: ARTICLE_ID });
    expect(inspection.status).toBe('synced');
    expect(inspection.diff?.hasChanges).toBe(false);
  });

  it('reports only the real edit when a local-ref article is modified', async () => {
    const res = await pullArticle('posts', ARTICLE_ID, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      localMediaRefs: true,
      rawItem: remoteItem('rev_1'),
      fetchFn: vi.fn() as unknown as typeof fetch,
    });

    const articlePath = path.join(tempDir, res.filePath);
    const original = fs.readFileSync(articlePath, 'utf8');
    fs.writeFileSync(articlePath, `${original}\n\nA new closing paragraph.\n`, 'utf8');

    const inspection = inspectArticleDiff({ workspaceRoot: tempDir, cache, id: ARTICLE_ID });
    expect(inspection.status).toBe('modified');
    expect(inspection.diff?.hasChanges).toBe(true);

    // The image line is identical on both sides, so it must not appear in the diff at all. A canonical baseline
    // compared against local-ref disk would show every mirrored image as a rewrite.
    expect(inspection.diff?.unifiedDiff).not.toContain('media/01JAAAAAAA000000000000IMG1.jpg');
    expect(inspection.diff?.unifiedDiff).not.toContain(
      '/_emdash/api/media/file/01JAAAAAAA000000000000IMG1.jpg',
    );
    expect(inspection.diff?.unifiedDiff).toContain('A new closing paragraph.');
  });

  it('push rewrites the local reference to the canonical URL for remote while the disk keeps the local form', async () => {
    const relPath = `posts/draft/${todayPrefix}_${ARTICLE_ID}-local-ref-article.md`;
    const localBody = ['Body paragraph.', '', `![LG 背面端子](${LOCAL_REF})`].join('\n');
    fs.writeFileSync(
      path.join(tempDir, relPath),
      [
        '---',
        `id: ${ARTICLE_ID}`,
        'slug: local-ref-article',
        'title: "local-ref-article"',
        'collection: posts',
        'status: draft',
        'publishedAt: null',
        'locale: ja',
        '---',
        '',
        localBody,
        '',
      ].join('\n'),
      'utf8',
    );

    // media_state confirms the key so preflight can resolve the reference without re-uploading.
    cache.saveMediaState({
      localHash: 'a'.repeat(64),
      mediaId: MEDIA_ID,
      storageKey: STORAGE_KEY,
      url: CANONICAL_URL,
      workspacePath: `media/${STORAGE_KEY}`,
      markdownRef: `media/${STORAGE_KEY.replace(/\.jpg$/, '')}`,
      status: 'ready',
      uploadedAt: 1700000000,
    });

    // The article is already tracked, so push updates (PUT) instead of creating a new remote record.
    cache.saveEntry({
      id: ARTICLE_ID,
      collection: 'posts',
      slug: 'local-ref-article',
      status: 'draft',
      title: 'Local Ref Article',
      rev: '1',
      publishedAt: null,
      rawJson: JSON.stringify({ id: ARTICLE_ID, slug: 'local-ref-article' }),
      updatedAt: 1700000000,
    });
    cache.saveSyncState({
      id: ARTICLE_ID,
      localFilePath: relPath,
      localHash: 'stale-baseline-hash',
      remoteRev: '1',
      status: 'draft',
      slug: 'local-ref-article',
      lastSyncedAt: 1700000000,
    });

    let capturedPayload: Record<string, unknown> | undefined;
    const mediaApiCalls: string[] = [];

    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      if (url.includes('/lock')) {
        return new Response(JSON.stringify({ status: 'acquired' }), { status: 200 });
      }
      if (url.includes('/terms/')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.includes('/_emdash/api/media/')) {
        mediaApiCalls.push(`${method} ${url}`);
        // Remote verification of the reused record must succeed.
        if (method === 'GET' && url.endsWith(`/_emdash/api/media/${MEDIA_ID}`)) {
          return new Response(
            JSON.stringify({
              success: true,
              data: { item: { id: MEDIA_ID, storageKey: STORAGE_KEY } },
            }),
            { status: 200 },
          );
        }
        if (method === 'POST' && url.endsWith('/_emdash/api/media/upload-url')) {
          throw new Error('local reference must never trigger an upload');
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (method === 'PUT' && url.endsWith(`/_emdash/api/content/posts/${ARTICLE_ID}`)) {
        capturedPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ item: { id: ARTICLE_ID }, _rev: '2' }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as unknown as typeof fetch;

    const res = await pushArticle(relPath, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      localMediaRefs: true,
      fetchFn,
    });

    expect(res.success).toBe(true);

    // The payload EmDash receives carries the canonical route, never a workspace-relative path.
    const payloadJson = JSON.stringify(capturedPayload);
    expect(payloadJson).toContain(CANONICAL_URL);
    expect(payloadJson).not.toContain(`(media/${STORAGE_KEY})`);

    // Reusing a confirmed mirror must not re-upload it.
    expect(mediaApiCalls.some((c) => c.includes('/upload-url'))).toBe(false);

    // Disk keeps the local spelling so the preview stays intact and status reports no phantom edit.
    const disk = fs.readFileSync(path.join(tempDir, res.filePath), 'utf8');
    expect(disk).toContain(`![LG 背面端子](${LOCAL_REF})`);
    expect(disk).not.toContain(CANONICAL_URL);

    const status = getWorkspaceStatus(tempDir, cache, 'posts');
    expect(status.summary.modified).toBe(0);
    expect(status.summary.synced).toBe(1);
  });

  it('pushAll honors localMediaRefs so a batch push keeps the disk spelling', async () => {
    const res = await pullArticle('posts', ARTICLE_ID, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      localMediaRefs: true,
      rawItem: remoteItem('rev_1'),
      fetchFn: vi.fn() as unknown as typeof fetch,
    });

    // Introduce a real edit so the article becomes eligible for batch push.
    const articlePath = path.join(tempDir, res.filePath);
    const original = fs.readFileSync(articlePath, 'utf8');
    fs.writeFileSync(articlePath, `${original}\n\nAppended through batch push.\n`, 'utf8');

    // Preflight resolves the local reference through media_state, so the mirror must be confirmed before push.
    cache.saveMediaState({
      localHash: 'a'.repeat(64),
      mediaId: MEDIA_ID,
      storageKey: STORAGE_KEY,
      url: CANONICAL_URL,
      workspacePath: `media/${STORAGE_KEY}`,
      markdownRef: `media/${STORAGE_KEY.replace(/\.jpg$/, '')}`,
      status: 'ready',
      uploadedAt: 1700000000,
    });

    const fetchFn = vi.fn(async () => {
      return new Response(JSON.stringify({ item: { id: ARTICLE_ID }, _rev: '2' }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const batch = await pushAll({
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      localMediaRefs: true,
      fetchFn,
    });

    expect(batch.pushed).toBe(1);

    // Without the setting threaded through pushAll, the batch path would rewrite every mirror back to a canonical URL.
    const afterBatch = fs.readFileSync(articlePath, 'utf8');
    expect(afterBatch).toContain(`![LG 背面端子](${LOCAL_REF})`);
    expect(afterBatch).not.toContain(CANONICAL_URL);
  });

  it('re-spells a legacy depth-free workspace ref into the article-relative form on the next pull', async () => {
    // A workspace built before article-relative refs existed carries `media/<storageKey>` on disk and its hash
    // tracked in sync_state. Re-pulling must repair the spelling to the preview-resolvable form instead of
    // reporting a phantom edit — and must stay byte-stable from then on.
    const first = await pullArticle('posts', ARTICLE_ID, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      localMediaRefs: true,
      rawItem: remoteItem('rev_1'),
      fetchFn: vi.fn() as unknown as typeof fetch,
    });
    const articlePath = path.join(tempDir, first.filePath);
    const legacy = fs
      .readFileSync(articlePath, 'utf8')
      .replace(`](${LOCAL_REF})`, `](media/${STORAGE_KEY})`);
    fs.writeFileSync(articlePath, legacy, 'utf8');
    cache.saveSyncState({ ...cache.getSyncState(ARTICLE_ID)!, localHash: calculateHash(legacy) });

    expect(getWorkspaceStatus(tempDir, cache, 'posts').summary.modified).toBe(0);

    const repull = await pullArticle('posts', ARTICLE_ID, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      localMediaRefs: true,
      rawItem: remoteItem('rev_1'),
      fetchFn: vi.fn() as unknown as typeof fetch,
    });

    const migrated = fs.readFileSync(articlePath, 'utf8');
    expect(migrated).toContain(`![LG 背面端子](${LOCAL_REF})`);
    expect(migrated).not.toContain(`](media/${STORAGE_KEY})`);
    expect(calculateHash(migrated)).toBe(cache.getSyncState(ARTICLE_ID)!.localHash);

    // The repaired spelling is now the stable one: a third pull of the same revision skips.
    const settled = await pullArticle('posts', ARTICLE_ID, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      localMediaRefs: true,
      rawItem: remoteItem('rev_1'),
      fetchFn: vi.fn() as unknown as typeof fetch,
    });
    expect(settled.skipped).toBe(true);
    expect(fs.readFileSync(articlePath, 'utf8')).toBe(migrated);
    expect(
      inspectArticleDiff({ workspaceRoot: tempDir, cache, id: ARTICLE_ID }).diff?.hasChanges,
    ).toBe(false);
    void repull;
  });

  it('keeps an untouched article clean when it moves from draft to published', async () => {
    // Moving an article changes the depth its mirror reference must carry. Both the disk bytes and the tracked
    // local_hash must land on the new depth together, or a status pass would report a media edit nobody made.
    const res = await pullArticle('posts', ARTICLE_ID, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      localMediaRefs: true,
      rawItem: remoteItem('rev_1'),
      fetchFn: vi.fn() as unknown as typeof fetch,
    });
    const draftPath = path.join(tempDir, res.filePath);
    const draftContent = fs.readFileSync(draftPath, 'utf8');
    expect(draftContent).toContain(`![LG 背面端子](${LOCAL_REF})`);

    // Promote the article through the cache-visible status change, then re-pull from remote.
    const publishedRemote = {
      ...remoteItem('rev_2'),
      status: 'published',
      publishedAt: '2026-11-11T00:00:00.000Z',
    };
    const moved = await pullArticle('posts', ARTICLE_ID, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      localMediaRefs: true,
      rawItem: publishedRemote,
      fetchFn: vi.fn() as unknown as typeof fetch,
    });

    expect(moved.filePath).toContain('/published/');
    const movedContent = fs.readFileSync(path.join(tempDir, moved.filePath), 'utf8');
    // Same depth for `published/` as for `draft/`, so the reference itself is unchanged.
    expect(movedContent).toContain(`![LG 背面端子](${LOCAL_REF})`);
    expect(fs.existsSync(draftPath)).toBe(false);

    const status = getWorkspaceStatus(tempDir, cache, 'posts');
    expect(status.summary.modified).toBe(0);
    expect(
      inspectArticleDiff({ workspaceRoot: tempDir, cache, id: ARTICLE_ID }).diff?.hasChanges,
    ).toBe(false);
  });

  it('a local reference whose asset is not mirrored is rejected before any request is made', async () => {
    const relPath = `posts/draft/${todayPrefix}_${ARTICLE_ID}-unmirrored.md`;
    fs.writeFileSync(
      path.join(tempDir, relPath),
      [
        '---',
        `id: ${ARTICLE_ID}`,
        'slug: unmirrored',
        'title: "Unmirrored"',
        'collection: posts',
        'status: draft',
        'publishedAt: null',
        'locale: ja',
        '---',
        '',
        `![Ghost](media/01M67NQTMRRED556YVG6RBT0J0.jpg)`,
        '',
      ].join('\n'),
      'utf8',
    );

    const fetchFn = vi.fn(async () => {
      throw new Error('no request may be issued once a guard rejects the body');
    }) as unknown as typeof fetch;

    await expect(
      pushArticle(relPath, {
        workspaceRoot: tempDir,
        cache,
        origin: 'https://example.com',
        token: 'fake-token',
        localMediaRefs: true,
        fetchFn,
      }),
    ).rejects.toThrow(/LOCAL_IMAGE_DETECTED|Preflight Guards/);
  });
});

describe('localMediaRefs workspace preference persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emit-local-ref-cfg-')));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('initWorkspace stores the flag and loadConfig carries it forward', () => {
    initWorkspace(tempDir, { localMediaRefs: true });

    const raw = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.emit', 'config.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(raw.localMediaRefs).toBe(true);
    expect(loadConfig(tempDir).localMediaRefs).toBe(true);
  });

  it('persistLocalMediaRefs toggles the stored preference without touching other keys', () => {
    initWorkspace(tempDir, { localMediaRefs: true });
    const before = loadConfig(tempDir);

    persistLocalMediaRefs(tempDir, false);
    const after = loadConfig(tempDir);

    expect(after.localMediaRefs).toBe(false);
    // Only the one key changes; connection settings survive.
    expect(after.defaultCollection).toBe(before.defaultCollection);
    expect(after.origin).toBe(before.origin);
  });
});
