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
import { pushArticle, PushValidationError } from '../src/sync/push.js';
import { formatDatePrefix, serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';

/**
 * Observes the actual PUT / POST request bodies produced by pushArticle for
 * featuredImage, which is the layer where remote media references are either
 * preserved, canonicalized, or lost.
 */
describe('featuredImage Push Payload Shaping', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  const validUlid = '01M67MP2W0VKCK2DFWM166CR24';
  const mediaUlid = '01M67P0MBMJQQXH2K95HHCYRYB';
  const otherMediaUlid = '01M6A7SJ82SMPWKTJ7GSSDC6VZ';
  const todayPrefix = formatDatePrefix(new Date());
  const options = { origin: 'https://aroooy.net', token: 'test-token' };

  const remoteFeaturedExternal = {
    provider: 'external',
    id: '',
    src: `/_emdash/api/media/file/${mediaUlid}.jpg`,
    filename: 'hero.jpg',
    mimeType: 'image/jpeg',
    width: 1600,
    height: 900,
  };
  const remoteFeaturedLocal = {
    provider: 'local',
    id: mediaUlid,
    storageKey: 'uploads/2026/hero.png',
    filename: 'hero.png',
    mimeType: 'image/png',
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-featured-test-'));
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeArticle(slug: string, featuredImage?: string | null): string {
    const fm: Frontmatter = {
      id: validUlid,
      slug,
      title: 'Featured Image Payload Test',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
      ...(featuredImage === undefined ? {} : { featuredImage }),
    };
    const relPath = `posts/draft/${todayPrefix}${validUlid}-${slug}.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(
      fullPath,
      serializeMarkdown(fm, 'Body text referencing a remote media ULID.'),
      'utf8',
    );
    return relPath;
  }

  function seedTrackedArticle(slug: string, remoteFeatured: unknown): void {
    cache.saveEntry({
      id: validUlid,
      collection: 'posts',
      slug,
      status: 'draft',
      title: 'Featured Image Payload Test',
      rev: 'rev_v1',
      rawJson: JSON.stringify({
        item: {
          id: validUlid,
          collection: 'posts',
          slug,
          data: { featured_image: remoteFeatured },
        },
      }),
      updatedAt: Date.now(),
    });
    cache.saveSyncState({
      id: validUlid,
      localFilePath: `posts/draft/${todayPrefix}${validUlid}-${slug}.md`,
      localHash: 'hash_old',
      remoteRev: 'rev_v1',
      status: 'draft',
      slug,
      lastSyncedAt: 1730500000,
    });
  }

  function pushMock() {
    let captured: Record<string, any> | null = null;
    const fetchFn = vi
      .fn()
      .mockImplementation((url: string, init: { method?: string; body?: string }) => {
        const urlStr = String(url);
        if (init.method === 'POST') {
          if (!urlStr.includes('/terms/') && !urlStr.includes('/lock')) {
            captured = JSON.parse(String(init.body));
          }
          return Promise.resolve({
            ok: true,
            json: async () => ({
              enabled: true,
              holder: null,
              heldByCaller: true,
              id: validUlid,
              _rev: 'rev_v2',
            }),
          });
        }
        if (init.method === 'PUT') {
          captured = JSON.parse(String(init.body));
          return Promise.resolve({
            ok: true,
            json: async () => ({ id: validUlid, _rev: 'rev_v2' }),
          });
        }
        if (init.method === 'DELETE') {
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { bylines: [] } }),
        });
      });
    return { fetchFn: fetchFn as unknown as typeof fetch, payload: () => captured };
  }

  it('resends the exact cached remote featured_image object when the ULID matches', async () => {
    seedTrackedArticle('featured-preserve', remoteFeaturedExternal);
    const relPath = writeArticle('featured-preserve', mediaUlid);
    const { fetchFn, payload } = pushMock();

    const res = await pushArticle(relPath, { ...options, workspaceRoot: tempDir, cache, fetchFn });

    expect(res.success).toBe(true);
    expect(payload()).not.toBeNull();
    expect(payload()!.data.featured_image).toEqual(remoteFeaturedExternal);
    expect(res.warnings.filter((w) => w.includes('featuredImage'))).toHaveLength(0);
  });

  it('preserves provider and storageKey for remote "local" media records', async () => {
    seedTrackedArticle('featured-preserve-local', remoteFeaturedLocal);
    const relPath = writeArticle('featured-preserve-local', mediaUlid);
    const { fetchFn, payload } = pushMock();

    await pushArticle(relPath, { ...options, workspaceRoot: tempDir, cache, fetchFn });

    expect(payload()!.data.featured_image).toEqual(remoteFeaturedLocal);
  });

  it('normalizes a lowercase featuredImage before matching the cached remote object', async () => {
    seedTrackedArticle('featured-lowercase', remoteFeaturedExternal);
    const relPath = writeArticle('featured-lowercase', mediaUlid.toLowerCase());
    const { fetchFn, payload } = pushMock();

    const res = await pushArticle(relPath, { ...options, workspaceRoot: tempDir, cache, fetchFn });

    expect(res.success).toBe(true);
    expect(payload()!.data.featured_image).toEqual(remoteFeaturedExternal);
  });

  it('sends a canonical bare media id (never fabricated metadata) when the hero is swapped', async () => {
    seedTrackedArticle('featured-swap', remoteFeaturedExternal);
    // A mirrored workspace (media/ exists) but with no entry for the new hero.
    fs.mkdirSync(path.join(tempDir, 'media'), { recursive: true });
    const relPath = writeArticle('featured-swap', otherMediaUlid);
    const { fetchFn, payload } = pushMock();

    const res = await pushArticle(relPath, { ...options, workspaceRoot: tempDir, cache, fetchFn });

    expect(payload()!.data.featured_image).toEqual({ id: otherMediaUlid });
    expect(res.warnings.some((w) => w.includes('no companion metadata'))).toBe(true);
  });

  it('sends an explicit null when featuredImage is null', async () => {
    seedTrackedArticle('featured-null', remoteFeaturedExternal);
    const relPath = writeArticle('featured-null', null);
    const { fetchFn, payload } = pushMock();

    await pushArticle(relPath, { ...options, workspaceRoot: tempDir, cache, fetchFn });

    expect(payload()!.data.featured_image).toBeNull();
  });

  it('omits featured_image entirely when frontmatter has no featuredImage', async () => {
    seedTrackedArticle('featured-omitted', remoteFeaturedExternal);
    const relPath = writeArticle('featured-omitted');
    const { fetchFn, payload } = pushMock();

    await pushArticle(relPath, { ...options, workspaceRoot: tempDir, cache, fetchFn });

    expect(payload()!.data.featured_image).toBeUndefined();
  });

  it('canonicalizes featured_image on the new-article POST path as well', async () => {
    // No sync state cached, so pushArticle takes the POST (create) path.
    const relPath = writeArticle('featured-new-article', mediaUlid.toLowerCase());
    const { fetchFn, payload } = pushMock();

    const res = await pushArticle(relPath, { ...options, workspaceRoot: tempDir, cache, fetchFn });

    expect(res.success).toBe(true);
    expect(payload()!.data.featured_image).toEqual({ id: mediaUlid });
  });

  it('resolves a remote media URL featuredImage to the canonical ULID with a warning', async () => {
    seedTrackedArticle('featured-url', remoteFeaturedExternal);
    const relPath = writeArticle('featured-url', `/_emdash/api/media/file/${mediaUlid}.jpg`);
    const { fetchFn, payload } = pushMock();

    const res = await pushArticle(relPath, { ...options, workspaceRoot: tempDir, cache, fetchFn });

    expect(res.warnings.some((w) => w.includes('canonical media ULID'))).toBe(true);
    expect(payload()!.data.featured_image).toEqual(remoteFeaturedExternal);
  });

  it('blocks a local file path or malformed media id in featuredImage (G10)', async () => {
    const relPath = writeArticle('featured-bad-path', './hero.png');
    const { fetchFn } = pushMock();

    const err = await pushArticle(relPath, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      fetchFn,
    }).catch((e: unknown) => e as PushValidationError);

    expect(err).toBeInstanceOf(PushValidationError);
    expect((err as PushValidationError).errors.map((e) => e.code)).toContain(
      'INVALID_FEATURED_IMAGE',
    );
  });

  it('ignores a companion YAML whose id describes a different media item (anchored lookup)', async () => {
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    // Another media item whose filename happens to mention the target ULID.
    fs.writeFileSync(
      path.join(mediaDir, `${todayPrefix}_${otherMediaUlid}-copy-of-${mediaUlid}.yaml`),
      `id: ${otherMediaUlid}\nfilename: copy.jpg\nmimeType: image/jpeg\nwidth: 10\nheight: 10\n`,
      'utf8',
    );

    seedTrackedArticle('featured-anchored', null);
    const relPath = writeArticle('featured-anchored', mediaUlid);
    const { fetchFn, payload } = pushMock();

    const res = await pushArticle(relPath, { ...options, workspaceRoot: tempDir, cache, fetchFn });

    expect(payload()!.data.featured_image).toEqual({ id: mediaUlid });
    expect(res.warnings.some((w) => w.includes('no companion metadata'))).toBe(true);
    expect(res.warnings.some((w) => w.includes('describes a different media ID'))).toBe(false);
  });

  it('accepts a matching companion YAML as verification without altering the payload', async () => {
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(
      path.join(mediaDir, `${todayPrefix}_${mediaUlid}-hero.jpg.yaml`),
      `id: ${mediaUlid}\nfilename: hero.jpg\nmimeType: image/jpeg\nwidth: 1600\nheight: 900\n`,
      'utf8',
    );

    seedTrackedArticle('featured-companion', null);
    const relPath = writeArticle('featured-companion', mediaUlid);
    const { fetchFn, payload } = pushMock();

    const res = await pushArticle(relPath, { ...options, workspaceRoot: tempDir, cache, fetchFn });

    expect(payload()!.data.featured_image).toEqual({ id: mediaUlid });
    expect(res.warnings.filter((w) => w.includes('companion metadata'))).toHaveLength(0);
  });

  it('rewrites the local file with the canonical uppercase ULID after pushing lowercase input', async () => {
    seedTrackedArticle('featured-selfheal', null);
    const relPath = writeArticle('featured-selfheal', mediaUlid.toLowerCase());
    const { fetchFn } = pushMock();

    const res = await pushArticle(relPath, { ...options, workspaceRoot: tempDir, cache, fetchFn });

    expect(res.success).toBe(true);
    // Push rewrites the canonical file (renamed from the frontmatter title), so locate
    // whatever file currently exists under posts/draft.
    const draftDir = path.join(tempDir, 'posts', 'draft');
    const files = fs.readdirSync(draftDir);
    expect(files).toHaveLength(1);
    const contentOnDisk = fs.readFileSync(path.join(draftDir, files[0]), 'utf8');
    expect(contentOnDisk).toContain(`featuredImage: "${mediaUlid}"`);
    expect(contentOnDisk).not.toContain(mediaUlid.toLowerCase());
  });
});
