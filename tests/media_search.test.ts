import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheDatabase } from '../src/db/cache.js';
import { asMediaRecordId, asStorageKey } from '../src/utils/media-id.js';
import {
  collectLocalMirrorIndex,
  mediaRecordIdForStem,
  pullMedia,
  searchLocalMirrorMedia,
} from '../src/sync/media/index.js';

describe('Media Search Engine & Local Mirror Index (Snapshot-First)', () => {
  let tempDir: string;
  let cache: CacheDatabase;
  const mockOrigin = 'https://emdash.test';
  const mockToken = 'test-token';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-media-search-'));
    cache = new CacheDatabase(path.join(tempDir, 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // T2-1: collectLocalMirrorIndex() が pruning を改変しない
  it('T2-1: ensures collectLocalMirrorIndex does not make existing mirrors self-exempt in pruning', async () => {
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    const staleId = '01M6STALERECORD00000000001';
    const staleStem = '01M6STALESTORAGEKEY000001';
    fs.writeFileSync(
      path.join(mediaDir, `${staleStem}.yaml`),
      yaml.dump({
        id: staleId,
        filename: 'stale.jpg',
        storageKey: `${staleStem}.jpg`,
      }),
      'utf8',
    );
    fs.writeFileSync(path.join(mediaDir, `${staleStem}.jpg`), 'old-binary');

    const mirrorIndex = collectLocalMirrorIndex(tempDir, undefined);
    expect(mirrorIndex.has(`${staleStem}.jpg`)).toBe(true);

    const activeId = '01M6ACTIVERECORD0000000001';
    const activeStem = '01M6ACTIVESTORAGEKEY00001';
    const mockFetch = vi.fn().mockImplementation((urlStr: string) => {
      if (urlStr.includes('/_emdash/api/media/file/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(8),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            items: [
              {
                id: activeId,
                filename: 'active.jpg',
                mimeType: 'image/jpeg',
                size: 8,
                storageKey: `${activeStem}.jpg`,
              },
            ],
            nextCursor: null,
          },
        }),
      });
    });

    const pullResult = await pullMedia({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      prune: true,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(pullResult.deleted).toBe(2);
    expect(fs.existsSync(path.join(mediaDir, `${staleStem}.jpg`))).toBe(false);
  });

  // T2-2: legacy_* companion の除外
  it('T2-2: excludes legacy_* companions from mirror index', () => {
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    fs.writeFileSync(
      path.join(mediaDir, 'legacy_01M6RESIDUE0000000000.yaml'),
      yaml.dump({
        id: '01M6RESIDUE00000000000000',
        filename: 'residue.jpg',
        storageKey: 'residue.jpg',
      }),
      'utf8',
    );

    const mirrorIndex = collectLocalMirrorIndex(tempDir, undefined);
    expect(mirrorIndex.has('residue.jpg')).toBe(false);
  });

  // T2-3: 相補 id: 以外からの record id 復元を行わない
  it('T2-3: returns null from mediaRecordIdForStem when companion lacks valid id:', () => {
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    const fakeUlidStem = '01M6FAKEULIDSTEM0000000001';
    fs.writeFileSync(
      path.join(mediaDir, `${fakeUlidStem}.yaml`),
      yaml.dump({
        filename: 'fake.png',
        storageKey: 'fake.png',
      }),
      'utf8',
    );

    expect(mediaRecordIdForStem(mediaDir, fakeUlidStem)).toBeNull();

    const mirrorIndex = collectLocalMirrorIndex(tempDir, undefined);
    const entry = mirrorIndex.get('fake.png');
    expect(entry?.mediaId).toBe('');
  });

  // T2-4: cache 無し workspace
  it('T2-4: builds mirror index in cache-less workspace from companion files', () => {
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    const mediaId = asMediaRecordId('01M6TESTCACHELESS000000001');
    const storageKey = asStorageKey('cacheless-photo.jpg');
    fs.writeFileSync(
      path.join(mediaDir, 'cacheless-photo.yaml'),
      yaml.dump({
        id: mediaId,
        filename: 'original-name.jpg',
        alt: 'キャッシュなし写真',
        caption: '説明文',
        storageKey,
      }),
      'utf8',
    );
    fs.writeFileSync(path.join(mediaDir, 'cacheless-photo.jpg'), 'binary');

    const mirrorIndex = collectLocalMirrorIndex(tempDir, undefined);
    expect(mirrorIndex.has(storageKey)).toBe(true);
    const entry = mirrorIndex.get(storageKey);
    expect(entry?.mediaId).toBe(mediaId);
    expect(entry?.localPath).toBe('media/cacheless-photo.jpg');
    expect(entry?.alt).toBe('キャッシュなし写真');
    expect(entry?.caption).toBe('説明文');
  });

  // T2-5: cache 駆動で既定 stem に companion が無い場合でも fallback 走査で metadata を解決 (Minor-B)
  it('T2-5: resolves companion metadata via fallback scan when companion has collision suffix', () => {
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    const mediaId = asMediaRecordId('01M6COLLISIONRECORD0000001');
    const storageKey = asStorageKey('photo.jpg');
    const collisionStem = `photo--${mediaId}`;

    cache.saveMediaState({
      mediaId,
      storageKey,
      url: `https://emdash.test/_emdash/api/media/file/${storageKey}`,
      status: 'ready',
      workspacePath: `media/${collisionStem}.jpg`,
    });

    fs.writeFileSync(path.join(mediaDir, `${collisionStem}.jpg`), 'binary');
    fs.writeFileSync(
      path.join(mediaDir, `${collisionStem}.yaml`),
      yaml.dump({
        id: mediaId,
        filename: 'collision-photo.jpg',
        alt: '衝突サフィックス付き画像',
        caption: 'フォールバック走査のテスト',
        url: `https://emdash.test/_emdash/api/media/file/${storageKey}`,
      }),
      'utf8',
    );

    const mirrorIndex = collectLocalMirrorIndex(tempDir, cache);
    expect(mirrorIndex.has(storageKey)).toBe(true);
    const entry = mirrorIndex.get(storageKey);
    expect(entry?.mediaId).toBe(mediaId);
    expect(entry?.localPath).toBe(`media/${collisionStem}.jpg`);
    expect(entry?.filename).toBe('collision-photo.jpg');
    expect(entry?.alt).toBe('衝突サフィックス付き画像');
    expect(entry?.caption).toBe('フォールバック走査のテスト');
  });

  describe('Date-Range and Local Media Search', () => {
    it('D-2: searchLocalMirrorMedia rejects rolled-over invalid date boundary with DATE_BOUNDARY_INVALID', () => {
      const db = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
      try {
        const index = collectLocalMirrorIndex(tempDir, db);
        expect(() =>
          searchLocalMirrorMedia({
            until: '2026-02-31',
            mirrorIndex: index,
          }),
        ).toThrowError(/Invalid date boundary: "2026-02-31"/);
        try {
          searchLocalMirrorMedia({ until: '2026-02-31', mirrorIndex: index });
        } catch (err: unknown) {
          expect(err).toMatchObject({ code: 'DATE_BOUNDARY_INVALID', status: 400 });
        }
      } finally {
        db.close();
      }
    });

    it('T2-1 & T2-2: searchLocalMirrorMedia searches local mirrors without network requests', () => {
      const mediaDir = path.join(tempDir, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });

      fs.writeFileSync(path.join(mediaDir, 'logo.png'), 'png bytes');
      fs.writeFileSync(
        path.join(mediaDir, 'logo.yaml'),
        [
          'id: 01M67P08DXFTYDPFRTJCC4XMP1',
          'storageKey: uploads/logo.png',
          'filename: company-logo.png',
          'alt: Company Logo',
          'createdAt: 2026-11-20T10:00:00.000Z',
          '',
        ].join('\n'),
      );

      fs.writeFileSync(path.join(mediaDir, 'banner.webp'), 'webp bytes');
      fs.writeFileSync(
        path.join(mediaDir, 'banner.yaml'),
        [
          'id: 01M67P08DXFTYDPFRTJCC4XMP2',
          'storageKey: uploads/banner.webp',
          'filename: hero-banner.webp',
          'alt: Hero Banner',
          'createdAt: 2026-11-15T10:00:00.000Z',
          '',
        ].join('\n'),
      );

      cache.saveMediaState({
        localHash: 'hash-logo',
        mediaId: asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMP1'),
        storageKey: asStorageKey('uploads/logo.png'),
        url: '/_emdash/api/media/file/uploads/logo.png',
        workspacePath: 'media/logo.png',
        markdownRef: 'media/logo',
        status: 'ready',
      });
      cache.saveMediaState({
        localHash: 'hash-banner',
        mediaId: asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMP2'),
        storageKey: asStorageKey('uploads/banner.webp'),
        url: '/_emdash/api/media/file/uploads/banner.webp',
        workspacePath: 'media/banner.webp',
        markdownRef: 'media/banner',
        status: 'ready',
      });

      const mirrorIndex = collectLocalMirrorIndex(tempDir, cache);

      const resKeyword = searchLocalMirrorMedia({ query: 'logo', mirrorIndex });
      expect(resKeyword.hits).toHaveLength(1);
      expect(resKeyword.hits[0].filename).toBe('company-logo.png');

      const resDate = searchLocalMirrorMedia({ since: '2026-11-18', mirrorIndex });
      expect(resDate.hits).toHaveLength(1);
      expect(resDate.hits[0].filename).toBe('company-logo.png');

      const resSameDay = searchLocalMirrorMedia({
        since: '2026-11-15',
        until: '2026-11-15',
        mirrorIndex,
      });
      expect(resSameDay.hits).toHaveLength(1);
      expect(resSameDay.hits[0].filename).toBe('hero-banner.webp');

      const resAll = searchLocalMirrorMedia({ mirrorIndex });
      expect(resAll.hits).toHaveLength(2);
    });
  });

  describe('v0.1.47 & v0.1.55: Snapshot integration in media search', () => {
    it('merges snapshot_media into search, gives mirrorIndex precedence, handles null storageKey, and respects mirroredOnly', async () => {
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-media-snap-'));
      fs.mkdirSync(path.join(wsDir, '.emit'), { recursive: true });
      const wsCache = new CacheDatabase(path.join(wsDir, '.emit', 'cache.db'));
      try {
        const mirroredId = '01M67P08DXFTYDPFRTJCC4XMB1';
        const mirroredKey = '01M67P08DXFTYDPFRTJCC4XMB1.jpg';
        const snapOnlyId = '01M67P08DXFTYDPFRTJCC4XMB2';
        const snapOnlyKey = '01M67P08DXFTYDPFRTJCC4XMB2.webp';
        const nullKeyId = '01M67P08DXFTYDPFRTJCC4XMB3';

        const mirrorIndex = new Map([
          [
            mirroredKey,
            {
              mediaId: mirroredId,
              storageKey: mirroredKey,
              localPath: `media/${mirroredKey}`,
              filename: 'mirrored-photo.jpg',
              alt: 'Mirrored Sunset',
              caption: null,
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        ]);

        const oldCapturedAt = Date.now() - 8 * 86_400_000;
        wsCache.saveSnapshotMeta({
          collection: 'posts',
          capturedAt: oldCapturedAt,
          articleCount: 0,
          mediaCount: 3,
          taxonomyFetchedCount: 0,
          taxonomyReusedCount: 0,
          articleSingleGetCount: 0,
          durationMs: 10,
        });
        wsCache.upsertSnapshotMediaBatch({
          walkComplete: true,
          records: [
            {
              mediaId: mirroredId,
              storageKey: mirroredKey,
              filename: 'stale-duplicate.jpg',
              mimeType: 'image/jpeg',
              size: 100,
              alt: 'Duplicate',
              caption: null,
              createdAt: '2026-01-01T00:00:00.000Z',
              capturedAt: oldCapturedAt,
            },
            {
              mediaId: snapOnlyId,
              storageKey: snapOnlyKey,
              filename: 'camera-gear.webp',
              mimeType: 'image/webp',
              size: 2048,
              alt: 'Camera Gear',
              caption: null,
              createdAt: '2026-01-02T00:00:00.000Z',
              capturedAt: oldCapturedAt,
            },
            {
              mediaId: nullKeyId,
              storageKey: null,
              filename: 'legacy-camera.png',
              mimeType: 'image/png',
              size: 512,
              alt: null,
              caption: null,
              createdAt: '2026-01-03T00:00:00.000Z',
              capturedAt: oldCapturedAt,
            },
          ],
        });

        const res = searchLocalMirrorMedia({
          query: 'camera',
          mirrorIndex,
          cache: wsCache,
        });
        expect(res.hits).toHaveLength(2);
        expect(res.hits[0].mirrored).toBe(false);
        expect(res.hits[0].fromSnapshot).toBe(true);
        expect(res.hits.some((h) => h.mediaId === nullKeyId && h.storageKey === null)).toBe(true);
        expect(res.snapshot?.stale).toBe(true);

        const mirroredOnlyRes = searchLocalMirrorMedia({
          query: 'camera',
          mirrorIndex,
          cache: wsCache,
          mirroredOnly: true,
        });
        expect(mirroredOnlyRes.hits).toHaveLength(0);

        const { formatMediaSearchHeader, formatMediaSearchHit } =
          await import('../src/presentation/media_report.js');
        expect(formatMediaSearchHeader(res, { subject: '"camera"' })).toContain('STALE_SNAPSHOT');
        expect(formatMediaSearchHit(res.hits[0], 0)[0]).toContain('[snapshot]');
      } finally {
        wsCache.close();
        fs.rmSync(wsDir, { recursive: true, force: true });
      }
    });

    it('finds site-wide snapshot_media via getLatestSnapshotMeta even when snapshot was captured under a non-posts collection', () => {
      const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-media-snap-pages-'));
      fs.mkdirSync(path.join(wsDir, '.emit'), { recursive: true });
      const wsCache = new CacheDatabase(path.join(wsDir, '.emit', 'cache.db'));
      try {
        const now = Date.now();
        wsCache.saveSnapshotMeta({
          collection: 'pages',
          capturedAt: now,
          articleCount: 2,
          mediaCount: 1,
          taxonomyFetchedCount: 0,
          taxonomyReusedCount: 0,
          articleSingleGetCount: 0,
          durationMs: 10,
        });
        wsCache.upsertSnapshotMediaBatch({
          walkComplete: true,
          records: [
            {
              mediaId: '01M6P08DXFTYDPFRTJCC4XMB99',
              storageKey: '01M6P08DXFTYDPFRTJCC4XMB99.png',
              filename: 'pages-banner.png',
              mimeType: 'image/png',
              size: 1024,
              alt: 'Banner',
              caption: null,
              createdAt: '2026-01-01T00:00:00.000Z',
              capturedAt: now,
            },
          ],
        });

        const res = searchLocalMirrorMedia({
          query: 'pages-banner',
          mirrorIndex: new Map(),
          cache: wsCache,
        });
        expect(res.hits).toHaveLength(1);
        expect(res.hits[0].fromSnapshot).toBe(true);
        expect(res.snapshot?.mediaCount).toBe(1);
      } finally {
        wsCache.close();
        fs.rmSync(wsDir, { recursive: true, force: true });
      }
    });
  });
});
