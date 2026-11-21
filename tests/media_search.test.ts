import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheDatabase } from '../src/db/cache.js';
import { asMediaRecordId, asStorageKey } from '../src/utils/media-id.js';
import { createMcpServer } from '../src/mcp/server.js';
import { initWorkspace } from '../src/utils/config.js';
import { setProfile } from '../src/utils/profile.js';
import { formatMediaSearchHitLimitNotice } from '../src/presentation/media_report.js';
import {
  collectLocalMirrorIndex,
  collectRemoteStorageKeys,
  mediaRecordIdForStem,
  pullMedia,
  searchLocalMirrorMedia,
  searchRemoteMedia,
  type EmDashMediaItem,
} from '../src/sync/media/index.js';

describe('Media Search Engine & Local Mirror Index (v0.1.16)', () => {
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

  // T1-1: remote にのみ存在する資産（media_state なし・companion なし）を検索
  it('T1-1: searches remote-only asset returning mirrored: false and localPath: null', async () => {
    const remoteItem: EmDashMediaItem = {
      id: asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMP8'),
      filename: 'remote-sunset.jpg',
      mimeType: 'image/jpeg',
      size: 10240,
      alt: '夕焼け空',
      caption: '綺麗な夕焼け',
      storageKey: asStorageKey('01M67P07X2VPW0MYRRRGMA6T5A.jpg'),
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [remoteItem],
          nextCursor: null,
          totalCount: 1,
        },
      }),
    });

    const result = await searchRemoteMedia({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: '夕焼け',
      mirrorIndex: collectLocalMirrorIndex(tempDir, cache),
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0];
    expect(hit.mirrored).toBe(false);
    expect(hit.localPath).toBeNull();
    expect(hit.alt).toBe('夕焼け空');
    expect(hit.matchedOn).toContain('alt');
    expect(hit.matchedOn).toContain('caption');
    expect(result.walkComplete).toBe(true);
    expect(result.scannedCount).toBe(1);
  });

  // T1-2: filename が ULID のみの移行資産を alt で検索
  it('T1-2: matches migrated asset by alt when filename is bare ULID', async () => {
    const migratedItem: EmDashMediaItem = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      filename: '01ARZ3NDEKTSV4RRFFQ69G5FAV.jpg',
      mimeType: 'image/jpeg',
      size: 2048,
      alt: 'harbour sunset view',
      caption: null,
      storageKey: asStorageKey('01ARZ3NDEKTSV4RRFFQ69G5FAV.jpg'),
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [migratedItem],
          nextCursor: null,
        },
      }),
    });

    // Searching by 'harbour' hits alt, not filename
    const result = await searchRemoteMedia({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'harbour',
      mirrorIndex: collectLocalMirrorIndex(tempDir, cache),
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].matchedOn).toEqual(['alt']);

    // Searching by non-existent keyword yields 0 hits
    const emptyResult = await searchRemoteMedia({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'mountain',
      mirrorIndex: collectLocalMirrorIndex(tempDir, cache),
      fetchFn: mockFetch as unknown as typeof fetch,
    });
    expect(emptyResult.hits).toHaveLength(0);
  });

  // T1-3: storageKey の一部で検索
  it('T1-3: matches by partial storageKey with matchedOn = ["storageKey"]', async () => {
    const item: EmDashMediaItem = {
      id: '01M67P08DXFTYDPFRTJCC4XMP8',
      filename: 'unrelated.png',
      mimeType: 'image/png',
      size: 4096,
      storageKey: asStorageKey('uploads/2026/09/dusk_harbour.png'),
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [item],
          nextCursor: null,
        },
      }),
    });

    const result = await searchRemoteMedia({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'dusk_harbour',
      mirrorIndex: collectLocalMirrorIndex(tempDir, cache),
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].matchedOn).toContain('storageKey');
  });

  // T1-4: mirror 済み資産（schema v5 media_state + companion YAML）
  it('T1-4: decorates mirrored asset with companion metadata and localPath', async () => {
    const storageKey = asStorageKey('01M67P07X2VPW0MYRRRGMA6T5A.jpg');
    const mediaId = asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMP8');

    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(
      path.join(mediaDir, '01M67P07X2VPW0MYRRRGMA6T5A.yaml'),
      yaml.dump({
        id: mediaId,
        filename: 'sunset.jpg',
        alt: 'ローカル設定の夕焼け',
        caption: '綺麗な日没',
        storageKey,
      }),
      'utf8',
    );
    fs.writeFileSync(path.join(mediaDir, '01M67P07X2VPW0MYRRRGMA6T5A.jpg'), 'binary');

    cache.saveMediaState({
      localHash: `media-record:${mediaId}`,
      mediaId,
      storageKey,
      url: `/_emdash/api/media/file/${storageKey}`,
      workspacePath: 'media/01M67P07X2VPW0MYRRRGMA6T5A.jpg',
      markdownRef: 'media/01M67P07X2VPW0MYRRRGMA6T5A',
      status: 'ready',
    });

    const remoteItem: EmDashMediaItem = {
      id: mediaId,
      filename: 'sunset.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
      alt: null, // remote lacks alt, but companion has it
      storageKey,
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [remoteItem],
          nextCursor: null,
        },
      }),
    });

    const mirrorIndex = collectLocalMirrorIndex(tempDir, cache);
    expect(mirrorIndex.has(storageKey)).toBe(true);

    const result = await searchRemoteMedia({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'ローカル設定',
      mirrorIndex,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0];
    expect(hit.mirrored).toBe(true);
    expect(hit.localPath).toBe('media/01M67P07X2VPW0MYRRRGMA6T5A.jpg');
    expect(hit.alt).toBe('ローカル設定の夕焼け');
    expect(hit.caption).toBe('綺麗な日没');
    expect(hit.matchedOn).toContain('alt');
  });

  // T1-5: media_state 行はあるが companion YAML が無い資産
  it('T1-5: returns null metadata and localPath: null when companion YAML and binary are missing', async () => {
    const storageKey = asStorageKey('01M67P07X2VPW0MYRRRGMA6T5B.jpg');
    const mediaId = asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMP9');

    cache.saveMediaState({
      localHash: `media-record:${mediaId}`,
      mediaId,
      storageKey,
      url: `/_emdash/api/media/file/${storageKey}`,
      workspacePath: null,
      markdownRef: 'media/01M67P07X2VPW0MYRRRGMA6T5B',
      status: 'ready',
    });

    const mirrorIndex = collectLocalMirrorIndex(tempDir, cache);
    const entry = mirrorIndex.get(storageKey);
    expect(entry).toBeDefined();
    expect(entry?.filename).toBeNull();
    expect(entry?.alt).toBeNull();
    expect(entry?.caption).toBeNull();
    expect(entry?.localPath).toBeNull();
  });

  // T1-6: 旧式 mirror を持つ workspace
  it('T1-6: recovers legacy mirror via companion storageKey without guessing filename', async () => {
    const storageKey = asStorageKey('01M6LEGACYSTORAGEKEY000001.png');
    const mediaId = asMediaRecordId('01M6LEGACYREC0000000000001');
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    // Legacy mirror naming: <yyyyMMdd>_<id>-<name>
    const legacyStem = `20261109_${mediaId}-hero`;
    fs.writeFileSync(
      path.join(mediaDir, `${legacyStem}.yaml`),
      yaml.dump({
        id: mediaId,
        filename: 'hero.png',
        alt: 'Legacy Hero',
        url: `/_emdash/api/media/file/${storageKey}`,
      }),
      'utf8',
    );
    fs.writeFileSync(path.join(mediaDir, `${legacyStem}.png`), 'binary');

    // Index without cache: collects from media/*.yaml
    const mirrorIndex = collectLocalMirrorIndex(tempDir, undefined);
    expect(mirrorIndex.has(storageKey)).toBe(true);
    const entry = mirrorIndex.get(storageKey);
    expect(entry?.localPath).toBe(`media/${legacyStem}.png`);
    expect(entry?.alt).toBe('Legacy Hero');
  });

  // T1-7: query に正規表現メタ文字を含む
  it('T1-7: treats regex meta characters as literal strings', async () => {
    const item: EmDashMediaItem = {
      id: '01M67P08DXFTYDPFRTJCC4XMP8',
      filename: 'chart (2026) [v1].png',
      mimeType: 'image/png',
      size: 1024,
      alt: 'test.*[a-z]+(group)',
      storageKey: asStorageKey('chart.png'),
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [item],
          nextCursor: null,
        },
      }),
    });

    const result = await searchRemoteMedia({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: '.*[a-z]+',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].matchedOn).toContain('alt');
  });

  // T1-8: 空 / 空白のみの query は拒否（日付範囲も offline も無い場合は検索条件がゼロになる）
  it('T1-8: rejects empty query with MEDIA_SEARCH_QUERY_REQUIRED', async () => {
    await expect(
      searchRemoteMedia({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        query: '   ',
      }),
    ).rejects.toMatchObject({
      code: 'MEDIA_SEARCH_QUERY_REQUIRED',
      status: 400,
    });
  });

  // T1-9: limit: 100 を指定 -> 50 に clamp され truncated: true
  it('T1-9: clamps limit to 50 and marks truncated when more matches exist', async () => {
    const items: EmDashMediaItem[] = [];
    for (let i = 0; i < 60; i++) {
      items.push({
        id: `01M6MATCH${String(i).padStart(19, '0')}`,
        filename: `match-${i}.png`,
        mimeType: 'image/png',
        size: 100,
        storageKey: asStorageKey(`match-${i}.png`),
      });
    }

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items,
          nextCursor: null,
        },
      }),
    });

    const result = await searchRemoteMedia({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'match',
      limit: 100,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.hits).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  // T1-10: fetch stub が受け取る URL に q= が存在しない
  it('T1-10: verifies request URL contains limit and cursor only, never q=', async () => {
    const urlsCalled: string[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      urlsCalled.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            items: [],
            nextCursor: null,
          },
        }),
      });
    });

    await searchRemoteMedia({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'sunset',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(urlsCalled).toHaveLength(1);
    const parsed = new URL(urlsCalled[0]);
    expect(parsed.searchParams.has('q')).toBe(false);
    expect(parsed.searchParams.has('limit')).toBe(true);
  });

  // T1-11: サーバーが 500 を返す
  it('T1-11: throws ApiError MEDIA_LIST_FAILED when server returns 500', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(
      searchRemoteMedia({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        query: 'error-test',
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: 'MEDIA_LIST_FAILED',
      status: 500,
    });
  });

  // T1-12: maxScan: 200 でライブラリ 350 件
  it('T1-12: stops at maxScan reporting walkComplete: false', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation((urlStr: string) => {
      callCount++;
      const url = new URL(urlStr);
      const cursor = url.searchParams.get('cursor');

      if (!cursor) {
        // Page 1: 100 items
        const items = Array.from({ length: 100 }, (_, i) => ({
          id: `01M6P1${String(i).padStart(20, '0')}`,
          filename: `img-${i}.jpg`,
          mimeType: 'image/jpeg',
          size: 100,
          storageKey: `img-${i}.jpg`,
        }));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: { items, nextCursor: 'cur-2' } }),
        });
      } else if (cursor === 'cur-2') {
        // Page 2: 100 items
        const items = Array.from({ length: 100 }, (_, i) => ({
          id: `01M6P2${String(i).padStart(20, '0')}`,
          filename: `img-${100 + i}.jpg`,
          mimeType: 'image/jpeg',
          size: 100,
          storageKey: `img-${100 + i}.jpg`,
        }));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: { items, nextCursor: 'cur-3' } }),
        });
      } else {
        // Page 3: 150 items
        const items = Array.from({ length: 150 }, (_, i) => ({
          id: `01M6P3${String(i).padStart(20, '0')}`,
          filename: `img-${200 + i}.jpg`,
          mimeType: 'image/jpeg',
          size: 100,
          storageKey: `img-${200 + i}.jpg`,
        }));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: { items, nextCursor: null } }),
        });
      }
    });

    const result = await searchRemoteMedia({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'img-10',
      maxScan: 200,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.scannedCount).toBe(200);
    expect(result.walkComplete).toBe(false);
    expect(callCount).toBe(2);
  });

  // T1-13: maxScan: 0（完全 walk）
  it('T1-13: maxScan: 0 walks completely with walkComplete: true', async () => {
    const mockFetch = vi.fn().mockImplementation((urlStr: string) => {
      const url = new URL(urlStr);
      const cursor = url.searchParams.get('cursor');
      if (!cursor) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              items: [
                {
                  id: '01M6PAGE10000000000000000',
                  filename: 'test.png',
                  mimeType: 'image/png',
                  size: 10,
                  storageKey: 'test.png',
                },
              ],
              nextCursor: 'cur-next',
            },
          }),
        });
      } else {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              items: [
                {
                  id: '01M6PAGE20000000000000000',
                  filename: 'test2.png',
                  mimeType: 'image/png',
                  size: 20,
                  storageKey: 'test2.png',
                },
              ],
              nextCursor: null,
            },
          }),
        });
      }
    });

    const result = await searchRemoteMedia({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'test',
      maxScan: 0,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.walkComplete).toBe(true);
    expect(result.scannedCount).toBe(2);
    expect(result.hits).toHaveLength(2);
  });

  // T1-14: ヒット 0 件 + walkComplete: false
  it('T1-14: reports 0 hits with walkComplete: false without asserting absence', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [
            {
              id: '01M6PAGE10000000000000000',
              filename: 'other.png',
              mimeType: 'image/png',
              size: 10,
              storageKey: 'other.png',
            },
          ],
          nextCursor: 'has-more',
        },
      }),
    });

    const result = await searchRemoteMedia({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'nonexistent',
      maxScan: 1,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.hits).toHaveLength(0);
    expect(result.walkComplete).toBe(false);
    expect(result.scannedCount).toBe(1);
  });

  // T1-15: mirroredOnly: true
  it('T1-15: mirroredOnly filters hits to mirrored assets while scanning full remote window', async () => {
    const storageKeyMirrored = asStorageKey('mirrored.png');
    const storageKeyRemoteOnly = asStorageKey('remote.png');

    cache.saveMediaState({
      localHash: 'hash-1',
      mediaId: asMediaRecordId('01M6MIRRORED0000000000000'),
      storageKey: storageKeyMirrored,
      url: `/_emdash/api/media/file/${storageKeyMirrored}`,
      workspacePath: 'media/mirrored.png',
      markdownRef: 'media/mirrored',
      status: 'ready',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [
            {
              id: '01M6MIRRORED0000000000000',
              filename: 'photo-mirrored.png',
              mimeType: 'image/png',
              size: 10,
              storageKey: storageKeyMirrored,
            },
            {
              id: '01M6REMOTE00000000000000',
              filename: 'photo-remote.png',
              mimeType: 'image/png',
              size: 20,
              storageKey: storageKeyRemoteOnly,
            },
          ],
          nextCursor: null,
        },
      }),
    });

    const mirrorIndex = collectLocalMirrorIndex(tempDir, cache);
    const result = await searchRemoteMedia({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'photo',
      mirroredOnly: true,
      mirrorIndex,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.scannedCount).toBe(2);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].storageKey).toBe(storageKeyMirrored);
    expect(result.hits[0].mirrored).toBe(true);
  });

  // T2-1: collectLocalMirrorIndex() が pruning を改変しない
  it('T2-1: ensures collectLocalMirrorIndex does not make existing mirrors self-exempt in pruning', async () => {
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    // Local mirror for a deleted record (26-char ULID)
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

    // Build mirror index (display only)
    const mirrorIndex = collectLocalMirrorIndex(tempDir, undefined);
    expect(mirrorIndex.has(`${staleStem}.jpg`)).toBe(true);

    // Remote pullMedia with prune: remote has only an active record (26-char ULID)
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

    // Stale mirror must be deleted by pruning!
    expect(pullResult.deleted).toBe(2); // yaml + binary
    expect(fs.existsSync(path.join(mediaDir, `${staleStem}.jpg`))).toBe(false);
  });

  // T2-2: legacy_* companion の除外
  it('T2-2: excludes legacy_* companions from mirror index', async () => {
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
  it('T2-3: returns null from mediaRecordIdForStem when companion lacks valid id:', async () => {
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    // Stem looks like a 26-char ULID, but companion lacks id:
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

    // Cache-less mirror index must not attribute record id from filename stem
    const mirrorIndex = collectLocalMirrorIndex(tempDir, undefined);
    const entry = mirrorIndex.get('fake.png');
    expect(entry?.mediaId).toBe('');
  });

  // T2-4: cache 無し workspace
  it('T2-4: builds mirror index in cache-less workspace from companion files', async () => {
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
  it('T2-5: resolves companion metadata via fallback scan when companion has collision suffix', async () => {
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    const mediaId = asMediaRecordId('01M6COLLISIONRECORD0000001');
    const storageKey = asStorageKey('photo.jpg');
    const collisionStem = `photo--${mediaId}`;

    // Register media state with standard storageKey, but no direct photo.yaml
    cache.saveMediaState({
      mediaId,
      storageKey,
      url: `https://emdash.test/_emdash/api/media/file/${storageKey}`,
      status: 'ready',
      workspacePath: `media/${collisionStem}.jpg`,
    });

    // Write binary and companion with collision suffix
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

  // T7-1: searchRemoteMedia の決定性保証（同一クエリでの hits/vocabulary 一致）
  it('T7-1: guarantees deterministic search results for identical queries (backend determinism)', async () => {
    const itemA: EmDashMediaItem = {
      id: '01M6PARITYA00000000000001',
      filename: 'sample-a.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
      storageKey: asStorageKey('sample-a.jpg'),
      alt: '共通検索テスト',
    };
    const itemB: EmDashMediaItem = {
      id: '01M6PARITYB00000000000002',
      filename: 'sample-b.png',
      mimeType: 'image/png',
      size: 2048,
      storageKey: asStorageKey('sample-b.png'),
      alt: '共通検索テストB',
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [itemA, itemB],
          nextCursor: null,
          totalCount: 2,
        },
      }),
    });

    const mirrorIndex = collectLocalMirrorIndex(tempDir, cache);

    const call1 = await searchRemoteMedia({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: '共通検索',
      mirrorIndex,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const call2 = await searchRemoteMedia({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: '共通検索',
      mirrorIndex,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(call1.hits).toEqual(call2.hits);
    expect(call1.scannedCount).toBe(call2.scannedCount);
    expect(call1.walkComplete).toBe(call2.walkComplete);
  });

  // T7-2: 検索機能が本文 hash および base_snapshots を改変しない（Baseline Invariant）
  it('T7-2: guarantees search operations do not modify article files, sync_state, or base_snapshots', async () => {
    const postsDir = path.join(tempDir, 'posts', 'draft');
    fs.mkdirSync(postsDir, { recursive: true });

    const articleId = '01M6HASHINVARIANTPRESERVE1';
    const filePath = path.join(postsDir, `20261112_${articleId}-test.md`);
    const initialContent = [
      '---',
      `id: ${articleId}`,
      'slug: hash-preserve-test',
      'title: "Hash Preserve Test"',
      'status: draft',
      '---',
      '',
      'Original body content with image ![Sample](/_emdash/api/media/file/sample.png)',
    ].join('\n');

    fs.writeFileSync(filePath, initialContent, 'utf8');

    // Register initial sync_state and base_snapshot
    cache.saveSyncState({
      id: articleId,
      localFilePath: `posts/draft/20261112_${articleId}-test.md`,
      localHash: 'hash-initial-12345',
      remoteRev: 'rev-initial-1',
      status: 'synced',
      slug: 'test',
      lastSyncedAt: 1700000000000,
    });
    cache.saveBaseSnapshot({
      id: articleId,
      rev: 'rev-initial-1',
      bodyMarkdown:
        'Original body content with image ![Sample](/_emdash/api/media/file/sample.png)',
      frontmatterYaml: 'id: ' + articleId,
      hash: 'hash-initial-12345',
      savedAt: 1700000000000,
    });

    // Mock fetch for searchRemoteMedia
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [
            {
              id: '01M6TESTMEDIAITEM00000001',
              filename: 'sample.png',
              mimeType: 'image/png',
              size: 512,
              storageKey: 'sample.png',
            },
          ],
          nextCursor: null,
        },
      }),
    });

    // Execute search
    await searchRemoteMedia({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'sample',
      mirrorIndex: collectLocalMirrorIndex(tempDir, cache),
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    // Verify disk content unchanged
    expect(fs.readFileSync(filePath, 'utf8')).toBe(initialContent);

    // Verify cache unchanged
    const syncState = cache.getSyncState(articleId);
    expect(syncState?.localHash).toBe('hash-initial-12345');
    expect(syncState?.remoteRev).toBe('rev-initial-1');

    const baseSnapshot = cache.getBaseSnapshot(articleId);
    expect(baseSnapshot?.hash).toBe('hash-initial-12345');
    expect(baseSnapshot?.bodyMarkdown).toBe(
      'Original body content with image ![Sample](/_emdash/api/media/file/sample.png)',
    );
  });

  // T7-3: doctor / search / collectRemoteStorageKeys の walk 整合性
  it('T7-3: guarantees walk pagination consistency between searchRemoteMedia and collectRemoteStorageKeys', async () => {
    const mockFetch = vi.fn().mockImplementation((urlStr: string) => {
      const url = new URL(urlStr);
      const cursor = url.searchParams.get('cursor');

      if (!cursor) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              items: [
                {
                  id: '01M6PAGE1REC000000000001',
                  filename: 'walk1.png',
                  mimeType: 'image/png',
                  size: 100,
                  storageKey: 'walk1.png',
                },
              ],
              nextCursor: 'cursor-p2',
              totalCount: 2,
            },
          }),
        });
      } else {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              items: [
                {
                  id: '01M6PAGE2REC000000000002',
                  filename: 'walk2.png',
                  mimeType: 'image/png',
                  size: 200,
                  storageKey: 'walk2.png',
                },
              ],
              nextCursor: null,
              totalCount: 2,
            },
          }),
        });
      }
    });

    const searchResult = await searchRemoteMedia({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      query: 'walk',
      maxScan: 0,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const collectResult = await collectRemoteStorageKeys({
      workspaceRoot: tempDir,
      origin: mockOrigin,
      token: mockToken,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(searchResult.scannedCount).toBe(2);
    expect(searchResult.walkComplete).toBe(true);
    expect(collectResult.scannedCount).toBe(2);
    expect(collectResult.complete).toBe(true);
    expect(searchResult.hits.map((h) => h.storageKey)).toEqual(
      Array.from(collectResult.storageKeys),
    );
  });

  describe('Date-Range and Offline Media Search (v0.1.42 P1 & P2)', () => {
    it('T1-1: browse recent media without query returns all items within limit', async () => {
      const items: EmDashMediaItem[] = [
        {
          id: asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMP1'),
          filename: 'recent-1.jpg',
          mimeType: 'image/jpeg',
          size: 100,
          storageKey: asStorageKey('recent-1.jpg'),
          createdAt: '2026-11-20T10:00:00.000Z',
        },
        {
          id: asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMP2'),
          filename: 'recent-2.jpg',
          mimeType: 'image/jpeg',
          size: 200,
          storageKey: asStorageKey('recent-2.jpg'),
          createdAt: '2026-11-19T10:00:00.000Z',
        },
      ];

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { items, nextCursor: null } }),
      });

      const result = await searchRemoteMedia({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result.hits).toHaveLength(2);
      expect(result.hits[0].filename).toBe('recent-1.jpg');
      expect(result.hits[1].filename).toBe('recent-2.jpg');
      expect(result.walkComplete).toBe(true);
    });

    it('T1-2 & T1-3: filters items within date range, including same-day since/until boundary', async () => {
      const items: EmDashMediaItem[] = [
        {
          id: asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMP1'),
          filename: 'today.jpg',
          mimeType: 'image/jpeg',
          size: 100,
          storageKey: asStorageKey('today.jpg'),
          createdAt: '2026-11-20T12:00:00.000Z',
        },
        {
          id: asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMP2'),
          filename: 'yesterday.jpg',
          mimeType: 'image/jpeg',
          size: 200,
          storageKey: asStorageKey('yesterday.jpg'),
          createdAt: '2026-11-19T12:00:00.000Z',
        },
        {
          id: asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMP3'),
          filename: 'older.jpg',
          mimeType: 'image/jpeg',
          size: 300,
          storageKey: asStorageKey('older.jpg'),
          createdAt: '2026-11-18T12:00:00.000Z',
        },
      ];

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { items, nextCursor: null } }),
      });

      // Same-day boundary: since 2026-11-19, until 2026-11-19
      const result = await searchRemoteMedia({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        since: '2026-11-19',
        until: '2026-11-19',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result.hits).toHaveLength(1);
      expect(result.hits[0].filename).toBe('yesterday.jpg');
    });

    it('T1-4: stops walk on reaching since boundary (early-exit) with walkComplete: true', async () => {
      const page1: EmDashMediaItem[] = [
        {
          id: asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMP1'),
          filename: 'nov21.jpg',
          mimeType: 'image/jpeg',
          size: 100,
          storageKey: asStorageKey('nov21.jpg'),
          createdAt: '2026-11-21T10:00:00.000Z',
        },
        {
          id: asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMP2'),
          filename: 'nov19.jpg',
          mimeType: 'image/jpeg',
          size: 200,
          storageKey: asStorageKey('nov19.jpg'),
          createdAt: '2026-11-19T10:00:00.000Z',
        },
      ];

      const mockFetch = vi.fn().mockImplementation((url: string) => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: { items: page1, nextCursor: 'has-more-pages' },
          }),
        });
      });

      const result = await searchRemoteMedia({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        since: '2026-11-20',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      // Encountered nov19 (older than since 2026-11-20 local midnight) -> stopped early
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0].filename).toBe('nov21.jpg');
      expect(result.walkComplete).toBe(true);
    });

    it('T1-6 & D-1: rejects invalid date boundary with DATE_BOUNDARY_INVALID', async () => {
      await expect(
        searchRemoteMedia({
          workspaceRoot: tempDir,
          origin: mockOrigin,
          token: mockToken,
          since: 'last-week',
        }),
      ).rejects.toMatchObject({
        code: 'DATE_BOUNDARY_INVALID',
        status: 400,
        suggestion: expect.stringContaining('2026-11-01'),
      });
    });

    it('D-2: searchLocalMirrorMedia rejects rolled-over invalid date boundary with DATE_BOUNDARY_INVALID', () => {
      const cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
      try {
        const index = collectLocalMirrorIndex(tempDir, cache);
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
        cache.close();
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

      // Search with keyword
      const resKeyword = searchLocalMirrorMedia({
        query: 'logo',
        mirrorIndex,
      });
      expect(resKeyword.hits).toHaveLength(1);
      expect(resKeyword.hits[0].filename).toBe('company-logo.png');

      // Search with date range
      const resDate = searchLocalMirrorMedia({
        since: '2026-11-18',
        mirrorIndex,
      });
      expect(resDate.hits).toHaveLength(1);
      expect(resDate.hits[0].filename).toBe('company-logo.png');

      // Search with same-day boundary
      const resSameDay = searchLocalMirrorMedia({
        since: '2026-11-15',
        until: '2026-11-15',
        mirrorIndex,
      });
      expect(resSameDay.hits).toHaveLength(1);
      expect(resSameDay.hits[0].filename).toBe('hero-banner.webp');

      // Browse all without query
      const resAll = searchLocalMirrorMedia({
        mirrorIndex,
      });
      expect(resAll.hits).toHaveLength(2);
    });
  });

  describe('v0.1.44 P1: Media Search Hit-Limit Early-Exit', () => {
    // M-1 & M-2: limit: 2 with 3+ hits stops in current page, does not fetch next page, walkComplete: false, truncated: true
    it('M-1 & M-2: breaks immediately when limit is reached without fetching subsequent pages', async () => {
      const page1Items = [
        {
          id: asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMA1'),
          filename: 'photo1.jpg',
          storageKey: asStorageKey('01M67P08DXFTYDPFRTJCC4XMA1.jpg'),
        },
        {
          id: asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMA2'),
          filename: 'photo2.jpg',
          storageKey: asStorageKey('01M67P08DXFTYDPFRTJCC4XMA2.jpg'),
        },
        {
          id: asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMA3'),
          filename: 'photo3.jpg',
          storageKey: asStorageKey('01M67P08DXFTYDPFRTJCC4XMA3.jpg'),
        },
      ];

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('cursor=page2')) {
          throw new Error('Subsequent page should NOT have been fetched when limit is reached');
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              items: page1Items,
              nextCursor: 'page2',
              totalCount: 100,
            },
          }),
        };
      });

      const result = await searchRemoteMedia({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        limit: 2,
        maxScan: 100,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result.hits).toHaveLength(2);
      expect(result.walkComplete).toBe(false);
      expect(result.truncated).toBe(true);
      expect(result.scannedCount).toBe(2);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // M-3: since boundary stop reports walkComplete: true
    it('M-3: since boundary stop reports walkComplete: true (not confused with hit-limit)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            items: [
              {
                id: asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMB1'),
                filename: 'recent.jpg',
                createdAt: '2026-11-20T10:00:00Z',
                storageKey: asStorageKey('01M67P08DXFTYDPFRTJCC4XMB1.jpg'),
              },
              {
                id: asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMB2'),
                filename: 'old.jpg',
                createdAt: '2026-11-01T10:00:00Z',
                storageKey: asStorageKey('01M67P08DXFTYDPFRTJCC4XMB2.jpg'),
              },
            ],
            nextCursor: 'next-page',
          },
        }),
      });

      const result = await searchRemoteMedia({
        workspaceRoot: tempDir,
        origin: mockOrigin,
        token: mockToken,
        since: '2026-11-15',
        limit: 10,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(result.hits).toHaveLength(1);
      expect(result.walkComplete).toBe(true);
      expect(result.truncated).toBe(false);
    });

    // M-4: hit limit notice uses raise limit on MCP (not CLI flag --limit)
    it('M-4: hit limit notice in MCP note uses raise limit without CLI flag prefix', async () => {
      const customProfiles = path.join(tempDir, 'profiles.yaml');
      initWorkspace(tempDir, { origin: mockOrigin });
      setProfile(
        'default',
        { origin: mockOrigin, token: mockToken, workspace: tempDir },
        true,
        customProfiles,
      );

      const server = createMcpServer({
        workspaceRoot: tempDir,
        cache,
        profilesPath: customProfiles,
      });
      const registered = (
        server as unknown as {
          _registeredTools: Record<
            string,
            {
              handler: (
                args: Record<string, unknown>,
              ) => Promise<{ content: Array<{ text: string }> }>;
            }
          >;
        }
      )._registeredTools;

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            items: [
              {
                id: asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMB1'),
                filename: 'photo1.jpg',
                storageKey: asStorageKey('01M67P08DXFTYDPFRTJCC4XMB1.jpg'),
              },
              {
                id: asMediaRecordId('01M67P08DXFTYDPFRTJCC4XMB2'),
                filename: 'photo2.jpg',
                storageKey: asStorageKey('01M67P08DXFTYDPFRTJCC4XMB2.jpg'),
              },
            ],
            nextCursor: 'next-page',
          },
        }),
      } as Response);

      const res = await registered['sync_media_search'].handler({ limit: 2 });
      const payload = JSON.parse(res.content[0].text);
      expect(payload.hits).toHaveLength(2);
      expect(payload.truncated).toBe(true);
      expect(payload.walkComplete).toBe(false);
      expect(payload.note).toContain('Hit limit reached at 2; raise limit to see more matches');
      expect(payload.note).not.toContain('raise --limit');

      // Verify presentation helper parity between CLI and MCP
      const cliNotice = formatMediaSearchHitLimitNotice(2);
      expect(cliNotice).toBe(
        'Hit limit reached at 2; raise --limit to see more matches from the same walk.',
      );
      const mcpNotice = formatMediaSearchHitLimitNotice(2, { isMcp: true });
      expect(mcpNotice).toBe(
        'Hit limit reached at 2; raise limit to see more matches from the same walk.',
      );
      expect(payload.note).toContain(mcpNotice);
    });
  });
});
