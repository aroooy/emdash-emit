import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheDatabase } from '../src/db/cache.js';
import { syncRemoteBylines, loadLocalBylineMaps } from '../src/sync/bylines.js';

describe('Byline Cache & Sync System', () => {
  let tmpDir: string;
  let dbPath: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-bylines-test-'));
    dbPath = path.join(tmpDir, 'cache.db');
    cache = new CacheDatabase(dbPath);
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves and retrieves bylines in SQLite cache', () => {
    cache.saveBylines([
      {
        id: '01M67MY3691HMDHDPS4HF5GBB0',
        slug: 'aroooy',
        displayName: 'aroooy',
        isGuest: false,
      },
      {
        id: '01M65FEE30X98KF114R36G3PBK',
        slug: 'guest-contributor',
        displayName: 'Guest Contributor',
        isGuest: true,
      },
    ]);

    const bylines = cache.getBylines();
    expect(bylines).toHaveLength(2);
    expect(bylines[0].slug).toBe('aroooy');
    expect(bylines[0].isGuest).toBe(false);

    const maps = cache.getBylineMaps();
    expect(maps.slugToId['aroooy']).toBe('01M67MY3691HMDHDPS4HF5GBB0');
    expect(maps.idToSlug['01M67MY3691HMDHDPS4HF5GBB0']).toBe('aroooy');
    expect(maps.slugToId['guest-contributor']).toBe('01M65FEE30X98KF114R36G3PBK');
    expect(maps.idToSlug['01M65FEE30X98KF114R36G3PBK']).toBe('guest-contributor');
  });

  it('saveBylines prunes stale bylines when pruneMissing is true', () => {
    cache.saveBylines([
      { id: '01AUTHOR_1', slug: 'author-1', displayName: 'Author 1' },
      { id: '01AUTHOR_2', slug: 'author-2', displayName: 'Author 2' },
    ]);
    expect(cache.getBylines()).toHaveLength(2);

    // Save with only author 1 and pruneMissing = true
    cache.saveBylines([{ id: '01AUTHOR_1', slug: 'author-1', displayName: 'Author 1' }], true);

    const updated = cache.getBylines();
    expect(updated).toHaveLength(1);
    expect(updated[0].slug).toBe('author-1');
  });

  it('syncRemoteBylines parses MCP JSON-RPC SSE response and updates cache', async () => {
    const mockMcpSseResponse =
      'event: message\n' +
      'data: ' +
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                items: [
                  {
                    id: '01M67MY3691HMDHDPS4HF5GBB0',
                    slug: 'aroooy',
                    displayName: 'aroooy',
                    isGuest: false,
                  },
                ],
              }),
            },
          ],
        },
      });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => mockMcpSseResponse,
    });

    const maps = await syncRemoteBylines({
      origin: 'https://test.aroooy.net',
      token: 'test_token',
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(maps.slugToId['aroooy']).toBe('01M67MY3691HMDHDPS4HF5GBB0');
    expect(maps.idToSlug['01M67MY3691HMDHDPS4HF5GBB0']).toBe('aroooy');

    const cached = cache.getBylines();
    expect(cached).toHaveLength(1);
    expect(cached[0].slug).toBe('aroooy');
  });

  it('syncRemoteBylines gracefully falls back to existing cache if remote fetch fails', async () => {
    cache.saveBylines([
      {
        id: '01CACHED_ID',
        slug: 'cached-author',
        displayName: 'Cached Author',
      },
    ]);

    const mockFetch = vi.fn().mockRejectedValue(new Error('Network offline'));

    const maps = await syncRemoteBylines({
      origin: 'https://test.aroooy.net',
      token: 'test_token',
      cache,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(maps.slugToId['cached-author']).toBe('01CACHED_ID');
    expect(loadLocalBylineMaps(cache).idToSlug['01CACHED_ID']).toBe('cached-author');
  });
});
