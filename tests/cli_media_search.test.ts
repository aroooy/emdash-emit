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

  // T3-1: emit media-search <kw> (正常)
  it('T3-1: searches remote media and prints storageKey and mirror status', async () => {
    setProfile('default', { origin: 'https://emdash.test', token: 'valid-token' });

    const mockItem = {
      id: '01M67P08DXFTYDPFRTJCC4XMP8',
      filename: 'sunset.jpg',
      mimeType: 'image/jpeg',
      size: 102400,
      alt: '夕焼け空',
      storageKey: '01M67P07X2VPW0MYRRRGMA6T5A.jpg',
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [mockItem],
          nextCursor: null,
          totalCount: 1,
        },
      }),
    } as Response);

    const prog = createProgram();
    await prog.parseAsync(['node', 'emit', 'media-search', '夕焼け']);

    expect(fetchSpy).toHaveBeenCalled();
    const stdout = stdoutLogs.join('\n');
    expect(stdout).toContain('Media search: "夕焼け"');
    expect(stdout).toContain('01M67P08DXFTYDPFRTJCC4XMP8');
    expect(stdout).toContain('01M67P07X2VPW0MYRRRGMA6T5A.jpg');
    expect(stdout).toContain('[not mirrored]');
    expect(stdout).toContain('100 KB');
    expect(stdout).toContain('💡 To use a hit:');
    expect(exitCode).toBeNull();
  });

  // T3-2: 未認証（token 解決不可）
  it('T3-2: exits 1 with clean error message when authentication token is missing', async () => {
    const prog = createProgram();
    await expect(prog.parseAsync(['node', 'emit', 'media-search', 'sunset'])).rejects.toThrow(
      'process.exit(1)',
    );

    expect(exitCode).toBe(1);
    const stderr = stderrLogs.join('\n');
    expect(stderr).toContain('❌');
    expect(stderr).toContain('No authentication found');
    expect(stderr).toContain('emit profile add');
    expect(stderr).not.toContain('file://');
    expect(stderr).not.toContain('    at ');
  });

  // T3-3: --max-scan 打ち切り時
  it('T3-3: prints [WALK_INCOMPLETE] warning when stopped at maxScan', async () => {
    setProfile('default', { origin: 'https://emdash.test', token: 'valid-token' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [
            {
              id: '01M6ITEM000000000000000001',
              filename: 'beach.png',
              mimeType: 'image/png',
              size: 2000,
              storageKey: 'beach.png',
            },
          ],
          nextCursor: 'cursor-has-more',
        },
      }),
    } as Response);

    const prog = createProgram();
    await prog.parseAsync(['node', 'emit', 'media-search', 'beach', '--max-scan', '1']);

    const stdout = stdoutLogs.join('\n');
    expect(stdout).toContain('[WALK_INCOMPLETE]');
    expect(stdout).toContain('absence is not proven');
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
    setProfile('default', { origin: 'https://emdash.test', token: 'valid-token' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [
            {
              id: '01M6ITEM000000000000000001',
              filename: 'remote-1.png',
              mimeType: 'image/png',
              size: 2000,
              storageKey: 'remote-1.png',
            },
          ],
          nextCursor: null,
        },
      }),
    } as Response);

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
    expect(stdout).toContain('No match found');
  });

  // T3-6: -p <profile> 解決
  it('T3-6: resolves specific profile with -p option', async () => {
    setProfile('custom-site', { origin: 'https://custom.test', token: 'custom-token' });

    let requestedOrigin = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation((urlStr: string | URL | Request) => {
      requestedOrigin = new URL(urlStr.toString()).origin;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: { items: [], nextCursor: null },
        }),
      } as Response);
    });

    const prog = createProgram();
    await prog.parseAsync(['node', 'emit', 'media-search', 'test', '-p', 'custom-site']);

    expect(requestedOrigin).toBe('https://custom.test');
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

  // Minor-A: CLI と MCP の同一クエリにおける完全な hits / storageKey パリティ
  it('Minor-A: verifies exact parity of hits and storageKeys between CLI and MCP', async () => {
    setProfile('default', { origin: 'https://emdash.test', token: 'valid-token' });

    const items = [
      {
        id: '01M6PARITY0000000000000001',
        filename: 'landscape.jpg',
        mimeType: 'image/jpeg',
        size: 5000,
        alt: '風景写真',
        storageKey: '01M6KEY000000000000000001.jpg',
      },
      {
        id: '01M6PARITY0000000000000002',
        filename: 'mountain.png',
        mimeType: 'image/png',
        size: 8000,
        caption: '山と風景のパノラマ',
        storageKey: '01M6KEY000000000000000002.png',
      },
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items,
          nextCursor: null,
          totalCount: 2,
        },
      }),
    } as Response);

    // 1. Run CLI
    const prog = createProgram();
    await prog.parseAsync(['node', 'emit', 'media-search', '風景']);

    const cliStdout = stdoutLogs.join('\n');
    expect(cliStdout).toContain('Media search: "風景"');
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
      expect(mcpPayload.hits).toHaveLength(2);
      const mcpKeys = mcpPayload.hits.map((h: { storageKey: string }) => h.storageKey);
      expect(mcpKeys).toEqual(['01M6KEY000000000000000001.jpg', '01M6KEY000000000000000002.png']);

      // Cross-check: CLI output contains every storageKey from MCP payload
      for (const key of mcpKeys) {
        expect(cliStdout).toContain(key);
      }
    } finally {
      cache.close();
    }
  });
});
