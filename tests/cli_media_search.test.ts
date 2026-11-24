import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMediaSearchCommand } from '../src/cli/commands/media.js';
import { registerPullCommands } from '../src/cli/commands/pull.js';
import { createCliContextResolver } from '../src/cli/context.js';
import { CacheDatabase } from '../src/db/cache.js';
import { createMcpServer } from '../src/mcp/server.js';
import { initWorkspace } from '../src/utils/config.js';
import { setProfile } from '../src/utils/profile.js';

describe('CLI: emit media-search & targeted pull (v0.1.16)', () => {
  let tempDir: string;
  let homeDir: string;
  let originalCwd: string;
  let stdoutLogs: string[] = [];
  let stderrLogs: string[] = [];
  let exitCode: number | null = null;
  const originalEnv = { ...process.env };
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-cli-search-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-cli-search-home-'));
    process.env.HOME = homeDir;
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    originalCwd = process.cwd();
    process.chdir(tempDir);
    initWorkspace(tempDir, { origin: 'https://emdash.test' });

    stdoutLogs = [];
    stderrLogs = [];
    exitCode = null;

    console.log = (...args: unknown[]) => {
      stdoutLogs.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]) => {
      stderrLogs.push(args.map(String).join(' '));
    };
    process.exit = ((code?: string | number | null | undefined) => {
      exitCode = Number(code ?? 0);
      throw new Error(`process.exit(${code})`);
    }) as unknown as typeof process.exit;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = { ...originalEnv };
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  function createProgram(): Command {
    const prog = new Command();
    const resolveContext = createCliContextResolver();
    registerPullCommands(prog, resolveContext);
    registerMediaSearchCommand(prog, resolveContext);
    return prog;
  }

  // Helper to seed snapshot_media in tempDir/.emit/cache.db
  function seedMediaSnapshot(
    records: Array<{
      mediaId: string;
      storageKey?: string | null;
      filename?: string | null;
      mimeType?: string | null;
      size?: number | null;
      alt?: string | null;
      caption?: string | null;
      createdAt?: string | null;
    }>,
    capturedAt = Date.now(),
  ): void {
    const cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
    try {
      cache.saveSnapshotMeta({
        collection: 'posts',
        capturedAt,
        articleCount: 0,
        mediaCount: records.length,
        taxonomyFetchedCount: 0,
        taxonomyReusedCount: 0,
        articleSingleGetCount: 0,
        durationMs: 1,
      });
      cache.upsertSnapshotMediaBatch({
        walkComplete: true,
        records: records.map((r) => ({ ...r, capturedAt })),
      });
    } finally {
      cache.close();
    }
  }

  // T3-1: デフォルト検索（ローカル + Snapshot、0 HTTP）
  it('T3-1: searches local + snapshot media with 0 HTTP calls and prints storageKey and mirror status', async () => {
    seedMediaSnapshot([
      {
        mediaId: '01M67P08DXFTYDPFRTJCC4XMP8',
        filename: 'sunset.jpg',
        mimeType: 'image/jpeg',
        size: 102400,
        alt: '夕焼け空',
        storageKey: '01M67P07X2VPW0MYRRRGMA6T5A.jpg',
      },
    ]);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('media-search must not issue HTTP requests');
    });

    const prog = createProgram();
    await prog.parseAsync(['node', 'emit', 'media-search', '夕焼け']);

    expect(fetchSpy).not.toHaveBeenCalled();
    const stdout = stdoutLogs.join('\n');
    expect(stdout).toContain('Media search (local + snapshot');
    expect(stdout).toContain('01M67P08DXFTYDPFRTJCC4XMP8');
    expect(stdout).toContain('01M67P07X2VPW0MYRRRGMA6T5A.jpg');
    expect(stdout).toContain('[snapshot]');
    expect(stdout).toContain('100 KB');
    expect(stdout).toContain('💡 To use a hit:');
    expect(exitCode).toBeNull();
  });

  // T3-2: 未認証（token なし）でも動作する
  it('T3-2: runs without authentication token and reports missing snapshot framing', async () => {
    const prog = createProgram();
    await prog.parseAsync(['node', 'emit', 'media-search', 'sunset']);

    expect(exitCode).toBeNull();
    const stdout = stdoutLogs.join('\n');
    expect(stdout).toContain('local mirrors only — no snapshot');
    expect(stdout).toContain('emit snapshot capture');
  });

  // T3-3: stale snapshot (>7d) 警告表示
  it('T3-3: warns when snapshot is stale (>= 7 days old)', async () => {
    const tenDaysAgo = Date.now() - 10 * 86_400_000;
    seedMediaSnapshot(
      [
        {
          mediaId: '01M6ITEM000000000000000001',
          filename: 'beach.png',
          mimeType: 'image/png',
          size: 2000,
          storageKey: 'beach.png',
        },
      ],
      tenDaysAgo,
    );

    const prog = createProgram();
    await prog.parseAsync(['node', 'emit', 'media-search', 'beach']);

    const stdout = stdoutLogs.join('\n');
    expect(stdout).toContain('[STALE_SNAPSHOT: 10d old]');
    expect(stdout).toContain('10-day-old snapshot');
    expect(stdout).toContain('emit snapshot capture');
  });

  // T3-4: --suggest-keywords
  it('T3-4: suggests top 10 tag slugs without categories', async () => {
    setProfile('default', { origin: 'https://emdash.test', token: 'valid-token' });

    // Create local tags
    const tagsDir = path.join(tempDir, 'tags');
    fs.mkdirSync(tagsDir, { recursive: true });
    for (let i = 1; i <= 12; i++) {
      fs.writeFileSync(
        path.join(tagsDir, `01M6TAG${String(i).padStart(19, '0')}-tag${i}.yaml`),
        yaml.dump({
          id: `01M6TAG${String(i).padStart(19, '0')}`,
          slug: `tag-${i}`,
          name: `Tag ${i}`,
          count: i,
        }),
        'utf8',
      );
    }
    // Create categories (must NOT be shown)
    const catDir = path.join(tempDir, 'categories');
    fs.mkdirSync(catDir, { recursive: true });
    fs.writeFileSync(
      path.join(catDir, '01M6CAT0000000000000000001-news.yaml'),
      yaml.dump({ id: '01M6CAT0000000000000000001', slug: 'secret-category', name: 'Secret' }),
      'utf8',
    );

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [],
          nextCursor: null,
        },
      }),
    } as Response);

    const prog = createProgram();
    await prog.parseAsync(['node', 'emit', 'media-search', 'test', '--suggest-keywords']);

    const stdout = stdoutLogs.join('\n');
    expect(stdout).toContain('Tag search hints:');
    expect(stdout).toContain('#tag-12'); // highest count
    expect(stdout).not.toContain('secret-category');
    // Ensure capped at 10 (tag-1 and tag-2 should be excluded because tag-12..tag-3 make 10 tags)
    expect(stdout).not.toContain('#tag-1,');
  });

  // T3-5: --mirrored-only と --limit の組み合わせ
  it('T3-5: respects --mirrored-only and --limit options', async () => {
    seedMediaSnapshot([
      {
        mediaId: '01M6ITEM000000000000000001',
        filename: 'remote-1.png',
        mimeType: 'image/png',
        size: 2000,
        storageKey: 'remote-1.png',
      },
    ]);

    const prog = createProgram();
    await prog.parseAsync([
      'node',
      'emit',
      'media-search',
      'remote',
      '--mirrored-only',
      '--limit',
      '5',
    ]);

    const stdout = stdoutLogs.join('\n');
    expect(stdout).toContain('No matching media found');
  });

  // T3-6: --max-scan / --offline 削除（unknown option 拒否）
  it('T3-6: rejects removed --max-scan and --offline flags on media-search', async () => {
    const prog1 = createProgram();
    await expect(
      prog1.parseAsync(['node', 'emit', 'media-search', 'test', '--max-scan', '10']),
    ).rejects.toThrow();

    const prog2 = createProgram();
    await expect(
      prog2.parseAsync(['node', 'emit', 'media-search', 'test', '--offline']),
    ).rejects.toThrow();
  });

  // T5-4: --article / --all との排他
  it('T5-4: rejects --storage-key when combined with --article or --all', async () => {
    setProfile('default', { origin: 'https://emdash.test', token: 'valid-token' });

    const prog = createProgram();
    await expect(
      prog.parseAsync(['node', 'emit', 'pull-media', '--storage-key', 'foo.png', '--all']),
    ).rejects.toThrow('process.exit(1)');

    expect(exitCode).toBe(1);
    expect(stderrLogs.join('\n')).toContain(
      '❌ Error: --storage-key cannot be combined with --article or --all.',
    );
  });

  // Minor-3: emit pull-media --storage-key <key> fails when storageKey cannot be resolved
  it('Minor-3: exits 1 when targeted storageKey cannot be resolved on remote', async () => {
    setProfile('default', { origin: 'https://emdash.test', token: 'valid-token' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [],
          nextCursor: null,
          totalCount: 0,
        },
      }),
    } as Response);

    const prog = createProgram();
    await expect(
      prog.parseAsync(['node', 'emit', 'pull-media', '--storage-key', 'nonexistent.png']),
    ).rejects.toThrow('process.exit(1)');

    expect(exitCode).toBe(1);
    const stderr = stderrLogs.join('\n');
    expect(stderr).toContain(
      '❌ Error: Could not resolve targeted storageKey(s) on remote: nonexistent.png',
    );
  });

  it('reports a confirmed-but-not-downloaded targeted storageKey without claiming a sync (R1)', async () => {
    setProfile('default', { origin: 'https://emdash.test', token: 'valid-token' });

    // The library reports nothing, but the workspace already mirrors this key with companion metadata, so
    // Emit must say "confirmed locally, not downloaded" instead of either a fake success or an error.
    const confirmedKey = '01MJZZKCAKNAY9999999999999.jpg';
    fs.mkdirSync(path.join(tempDir, 'media'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'media', '01MJZZKCAKNAY9999999999999.yaml'),
      `id: 01MJZZMIRRNAME9999999999993\nfilename: hero.jpg\nstorageKey: ${confirmedKey}\nsize: 7\n`,
      'utf8',
    );

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { items: [], nextCursor: null, totalCount: 0 } }),
    } as Response);

    const prog = createProgram();
    await prog.parseAsync(['node', 'emit', 'pull-media', '--storage-key', confirmedKey]);

    expect(exitCode).toBeNull();
    const stdout = stdoutLogs.join('\n');
    expect(stdout).toContain('ℹ️ Targeted storageKey(s) not downloaded');
    expect(stdout).toContain('confirmed by local mirror metadata already in media/');
    expect(stdout).not.toContain('✅ Media sync complete');
    expect(stderrLogs.join('\n')).not.toContain('❌');
  });

  // Minor-A: CLI と MCP の同一クエリにおける完全な hits / storageKey パリティ
  it('Minor-A: verifies exact parity of hits and storageKeys between CLI and MCP', async () => {
    setProfile('default', { origin: 'https://emdash.test', token: 'valid-token' });

    seedMediaSnapshot([
      {
        mediaId: '01M6PARITY0000000000000001',
        filename: 'landscape.jpg',
        mimeType: 'image/jpeg',
        size: 5000,
        alt: '風景写真',
        storageKey: '01M6KEY000000000000000001.jpg',
      },
      {
        mediaId: '01M6PARITY0000000000000002',
        filename: 'mountain.png',
        mimeType: 'image/png',
        size: 8000,
        caption: '山と風景のパノラマ',
        storageKey: '01M6KEY000000000000000002.png',
      },
    ]);

    // 1. Run CLI
    const prog = createProgram();
    await prog.parseAsync(['node', 'emit', 'media-search', '風景']);

    const cliStdout = stdoutLogs.join('\n');
    expect(cliStdout).toContain('Media search (local + snapshot');
    expect(cliStdout).toContain('01M6KEY000000000000000001.jpg');
    expect(cliStdout).toContain('01M6KEY000000000000000002.png');

    // 2. Run MCP
    const cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
    try {
      const server = createMcpServer({
        workspaceRoot: tempDir,
        cache,
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

      const mcpRes = await registered['sync_media_search'].handler({ query: '風景' });
      const mcpPayload = JSON.parse(mcpRes.content[0].text);

      expect(mcpPayload.totalCount).toBe(2);
      expect(mcpPayload.snapshotStatus).toBe('fresh');
      expect(mcpPayload.absenceGuaranteed).toBe(true);
      expect(mcpPayload.hits).toHaveLength(2);
      const mcpKeys = mcpPayload.hits.map((h: { storageKey: string }) => h.storageKey);
      // Snapshot rows are listed newest-first (ORDER BY created_at DESC), so the
      // newer mountain.png precedes the older landscape.jpg.
      expect(mcpKeys).toEqual(['01M6KEY000000000000000002.png', '01M6KEY000000000000000001.jpg']);

      // Cross-check: CLI output contains every storageKey from MCP payload
      for (const key of mcpKeys) {
        expect(cliStdout).toContain(key);
      }
    } finally {
      cache.close();
    }
  });

  // P0 Characterization Snapshots for CLI media-search output
  describe('P0 Characterization Snapshots: emit media-search output', () => {
    it('P0-1: fresh snapshot hit output', async () => {
      seedMediaSnapshot([
        {
          mediaId: '01M67P08DXFTYDPFRTJCC4XMP8',
          filename: 'sunset.jpg',
          mimeType: 'image/jpeg',
          size: 102400,
          alt: '夕焼け空',
          caption: 'Sea view',
          storageKey: '01M67P07X2VPW0MYRRRGMA6T5A.jpg',
        },
      ]);

      const prog = createProgram();
      await prog.parseAsync(['node', 'emit', 'media-search', '夕焼け']);

      expect(stdoutLogs[0]).toContain('Media search (local + snapshot @');
      expect(stdoutLogs[0]).toContain('searched 1 asset(s), 1 in snapshot');
      expect(stdoutLogs.slice(1)).toEqual([
        '  1.  01M67P08DXFTYDPFRTJCC4XMP8  storageKey 01M67P07X2VPW0MYRRRGMA6T5A.jpg  [snapshot]',
        '     alt: 夕焼け空   caption: Sea view   image/jpeg   100 KB',
        '\n💡 To use a hit: write /_emdash/api/media/file/<storageKey> into the article body — pull/push mirrors it',
        '   automatically. For an offline copy first: emit pull-media --storage-key <storageKey>.',
        '   Fleet-scale listing stays on the official EmDash MCP / Admin Dashboard.',
      ]);
    });

    it('P0-2: fresh snapshot empty result', async () => {
      seedMediaSnapshot([
        {
          mediaId: '01M67P08DXFTYDPFRTJCC4XMP8',
          filename: 'sunset.jpg',
          storageKey: '01M67P07X2VPW0MYRRRGMA6T5A.jpg',
        },
      ]);

      const prog = createProgram();
      await prog.parseAsync(['node', 'emit', 'media-search', 'nonexistent']);

      expect(stdoutLogs[0]).toContain('Media search (local + snapshot @');
      expect(stdoutLogs[1]).toBe('\nNo matching media found (1 local/snapshot asset(s) searched).');
    });

    it('P0-3: limit-truncated hit output', async () => {
      seedMediaSnapshot([
        {
          mediaId: '01M6ITEM000000000000000001',
          filename: 'beach.png',
          mimeType: 'image/png',
          size: 2000,
          storageKey: 'beach.png',
        },
        {
          mediaId: '01M6ITEM000000000000000002',
          filename: 'beach2.png',
          mimeType: 'image/png',
          size: 3000,
          storageKey: 'beach2.png',
        },
      ]);

      const prog = createProgram();
      await prog.parseAsync(['node', 'emit', 'media-search', 'beach', '--limit', '1']);

      expect(stdoutLogs[0]).toContain('[truncated at limit]');
      expect(stdoutLogs).toContain('\nℹ️ Showing top 1 of 2 match(es); raise --limit to see more.');
    });

    it('P0-4: missing snapshot empty output', async () => {
      const prog = createProgram();
      await prog.parseAsync(['node', 'emit', 'media-search', 'missing-snap']);

      expect(stdoutLogs).toEqual([
        'Media search (local mirrors only — no snapshot): "missing-snap" (searched 0 asset(s))',
        '\nNo matching media found in local workspace (no snapshot captured yet).',
        '\n⚠️ No matching items found in local workspace files. Full-library snapshot has not been captured yet, so older remote items were not searched.',
        '💡 Run sync_snapshot(action: "capture") / "emit snapshot capture" to index the full remote media library.',
      ]);
    });
  });
});
