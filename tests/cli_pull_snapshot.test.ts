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

import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPullCommands } from '../src/cli/commands/pull.js';
import type { CliContext } from '../src/cli/context.js';
import { CacheDatabase } from '../src/db/cache.js';
import { calculateHash } from '../src/sync/workspace/hash.js';
import { initWorkspace, loadConfig } from '../src/utils/config.js';

/**
 * Characterization snapshot suite for the `emit pull` batch handler (v0.1.37 Phase 1 Part C).
 *
 * The batch branch of the pull action (`!targetId`) is ~140 lines of presentation code with 44
 * console calls and no coverage today. These tests capture its exact stdout/stderr for a fixed
 * orchestrator outcome so the split into helper functions can be proven byte-identical. Snapshots
 * must only change with a deliberate, reviewed output change.
 */

interface CapturedOutput {
  out: string[];
  err: string[];
  raw: string[];
  exitCode: number | undefined;
}

/** Normalizes volatile fragments (absolute temp paths, package versions) for snapshot stability. */
function normalizeLines(lines: string[], workspaceRoot: string): string[] {
  return lines.map((line) =>
    line
      .split(workspaceRoot)
      .join('<WORKSPACE_ROOT>')
      .replace(/v?\d+\.\d+\.\d+/g, '<VERSION>'),
  );
}

describe('CLI Batch Pull Characterization Snapshots (v0.1.37 Phase 1 Part C)', () => {
  let tempDir: string;
  let cache: CacheDatabase;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-cli-pull-snap-'));
    initWorkspace(tempDir, { origin: 'https://example.com' });
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeContext(): CliContext {
    return {
      root: tempDir,
      paths: {
        root: tempDir,
        emitDir: path.join(tempDir, '.emit'),
        configPath: path.join(tempDir, '.emit', 'config.json'),
        dbPath: path.join(tempDir, '.emit', 'cache.db'),
        postsDir: path.join(tempDir, 'posts'),
      },
      cache,
      config: loadConfig(tempDir),
      auth: { source: 'env', token: 'test-token', origin: 'https://example.com' },
      origin: 'https://example.com',
    };
  }

  /** Runs `emit pull` with console/exit captured, returning normalized output lines. */
  async function runPullCapture(args: string[]): Promise<CapturedOutput> {
    const out: string[] = [];
    const err: string[] = [];
    const raw: string[] = [];
    let exitCode: number | undefined;

    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalExit = process.exit;
    const EXIT_SENTINEL = Symbol('emit-pull-snap-exit');

    console.log = (...a: unknown[]) => out.push(a.map(String).join(' '));
    console.error = (...a: unknown[]) => err.push(a.map(String).join(' '));
    console.warn = (...a: unknown[]) => err.push(a.map(String).join(' '));
    process.stdout.write = ((chunk: string | Uint8Array) => {
      raw.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw EXIT_SENTINEL;
    }) as typeof process.exit;

    try {
      // A fresh program per run: commander caches parsed argv on a shared instance, so reusing one
      // across captures makes the second parseAsync() a no-op.
      const probe = new Command();
      probe.exitOverride();
      registerPullCommands(probe, makeContext);
      await probe.parseAsync(['node', 'emit', ...args]);
    } catch (error) {
      if (error !== EXIT_SENTINEL) throw error;
    } finally {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
      process.stdout.write = originalWrite;
      process.exit = originalExit;
    }

    return {
      out: normalizeLines(out, tempDir),
      err: normalizeLines(err, tempDir),
      raw: normalizeLines(raw, tempDir),
      exitCode,
    };
  }

  /**
   * A fetch stub covering every endpoint a batch pull touches. Each scenario is expressed as data so
   * the recorded stdout stays a property of the presentation code, not of ad-hoc response shapes.
   */
  function publishedPost(id: string, slug: string): Record<string, unknown> {
    return {
      id,
      slug,
      status: 'published',
      title: `Article ${slug}`,
      _rev: '1:2026-01-01T00:00:00.000Z',
      version: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      publishedAt: '2026-01-01T00:00:00.000Z',
      data: {
        title: `Article ${slug}`,
        slug,
        type: 'doc',
        content: [{ type: 'paragraph', children: [{ type: 'text', text: 'body' }] }],
      },
    };
  }

  /** A published article whose body carries a canonical media file route image block. */
  function imagePost(id: string, slug: string, storageKey: string): Record<string, unknown> {
    const post = publishedPost(id, slug);
    (post.data as Record<string, unknown>).content = [
      {
        _type: 'image',
        _key: 'img1',
        alt: 'Hero',
        asset: { url: `/_emdash/api/media/file/${storageKey}` },
      },
    ];
    return post;
  }

  /**
   * A fetch stub covering every endpoint a batch pull touches. `status=all` lists fire one request per
   * status, so `postsByStatus` keeps published/draft fixtures independent — a single shared item list
   * would make both statuses return the same article and double-count it.
   */
  function stubBatchFetch(scenario: {
    categories?: unknown[];
    tags?: unknown[];
    taxonomiesFail?: boolean;
    publishedPosts?: Array<Record<string, unknown>>;
    draftPosts?: Array<Record<string, unknown>>;
    bylines?: unknown[];
    mediaLibrary?: unknown[];
  }): void {
    const jsonResponse = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes('/taxonomies/category/terms')) {
        return scenario.taxonomiesFail
          ? new Response('Internal Server Error', { status: 500 })
          : jsonResponse({ terms: scenario.categories ?? [] });
      }
      if (url.includes('/taxonomies/tag/terms')) {
        return scenario.taxonomiesFail
          ? new Response('Internal Server Error', { status: 500 })
          : jsonResponse({ terms: scenario.tags ?? [] });
      }
      if (url.includes('/bylines')) {
        return jsonResponse({ bylines: scenario.bylines ?? [] });
      }
      if (url.includes('/_emdash/api/media')) {
        const items = scenario.mediaLibrary ?? [];
        // fetchMediaListPage reads `totalCount`, not `total`.
        return jsonResponse({ items, totalCount: items.length });
      }
      if (url.includes('/posts')) {
        const isDraft = url.includes('status=draft');
        const items = isDraft ? (scenario.draftPosts ?? []) : (scenario.publishedPosts ?? []);
        return jsonResponse({ items, total: items.length });
      }
      return jsonResponse({});
    });

    vi.stubGlobal('fetch', fetchMock);
  }

  it('batch pull with an empty remote prints the no-articles path verbatim', async () => {
    stubBatchFetch({ publishedPosts: [], draftPosts: [] });

    const captured = await runPullCapture(['pull']);

    expect(captured.exitCode).toBeUndefined();
    expect({ ...captured }).toMatchSnapshot();
  });

  it('batch pull renders taxonomy summary, per-item progress and media coverage line', async () => {
    stubBatchFetch({
      categories: [
        { id: '01M67MY23GDT9X8QMY0G5SEQ6M', slug: 'camera', label: 'camera', count: 12 },
      ],
      tags: [
        { id: '01M65FEDZNS9GN01GD3JJRZFT2', slug: 'webdev', label: 'webdev', count: 3 },
        { id: '01M65FEDZNS9GN01GD3JJRZF00', slug: 'camera', label: 'camera', count: 1 },
      ],
      publishedPosts: [
        publishedPost('01M67P0MBMJQQXH2K95HHCYRYA', 'alpha'),
        publishedPost('01M67P0MBMJQQXH2K95HHCYRYB', 'beta'),
      ],
      draftPosts: [],
      mediaLibrary: [],
    });

    const captured = await runPullCapture(['pull']);

    expect(captured.exitCode).toBeUndefined();
    expect({ ...captured }).toMatchSnapshot();
  });

  it('batch pull skips pruning and warns when a windowed-out article has unpushed edits (non-blocking)', async () => {
    stubBatchFetch({
      taxonomiesFail: true,
      publishedPosts: [publishedPost('01M67P0MBMJQQXH2K95HHCYRYA', 'alpha')],
      draftPosts: [],
      mediaLibrary: [],
    });

    // A tracked article outside the sync window with a non-matching local hash is kept untouched
    // and reported as a warning without aborting the rest of the batch pull.
    const relPath = 'posts/ja/published/20260101_01M67OLDARTICLE0000000000-gamma.md';
    fs.mkdirSync(path.join(tempDir, 'posts', 'ja', 'published'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, relPath),
      '---\nid: 01M67OLDARTICLE0000000000\n---\nbody\n',
      'utf8',
    );
    cache.saveEntry({
      id: '01M67OLDARTICLE0000000000',
      collection: 'posts',
      slug: 'gamma',
      status: 'published',
      title: 'Article gamma',
      rev: '1:2026-01-01T00:00:00.000Z',
      publishedAt: '2026-01-01T00:00:00.000Z',
      rawJson: JSON.stringify(publishedPost('01M67OLDARTICLE0000000000', 'gamma')),
      updatedAt: 1767225600,
    });
    cache.saveSyncState({
      id: '01M67OLDARTICLE0000000000',
      localFilePath: relPath,
      remoteRev: '1:2026-01-01T00:00:00.000Z',
      localHash: 'deadbeef',
      status: 'published',
      slug: 'gamma',
      lastSyncedAt: 1767225600,
    });

    const captured = await runPullCapture(['pull']);

    expect(captured.exitCode).toBeUndefined();
    expect({ ...captured }).toMatchSnapshot();
  });

  it('batch pull prunes a windowed-out article cleanly and renders the 🗑️ progress line', async () => {
    stubBatchFetch({
      publishedPosts: [publishedPost('01M67P0MBMJQQXH2K95HHCYRYA', 'alpha')],
      draftPosts: [],
      mediaLibrary: [],
    });

    // Same windowed-out article, but its local hash matches the recorded sync state, so pruning
    // proceeds and the 🗑️ Pruned progress branch plus the ", N pruned" summary render.
    const relPath = 'posts/ja/published/20260101_01M67OLDARTICLE0000000000-gamma.md';
    fs.mkdirSync(path.join(tempDir, 'posts', 'ja', 'published'), { recursive: true });
    const diskContent = '---\nid: 01M67OLDARTICLE0000000000\n---\nbody\n';
    fs.writeFileSync(path.join(tempDir, relPath), diskContent, 'utf8');
    const localHash = calculateHash(diskContent);
    cache.saveEntry({
      id: '01M67OLDARTICLE0000000000',
      collection: 'posts',
      slug: 'gamma',
      status: 'published',
      title: 'Article gamma',
      rev: '1:2026-01-01T00:00:00.000Z',
      publishedAt: '2026-01-01T00:00:00.000Z',
      rawJson: JSON.stringify(publishedPost('01M67OLDARTICLE0000000000', 'gamma')),
      updatedAt: 1767225600,
    });
    cache.saveSyncState({
      id: '01M67OLDARTICLE0000000000',
      localFilePath: relPath,
      remoteRev: '1:2026-01-01T00:00:00.000Z',
      localHash,
      status: 'published',
      slug: 'gamma',
      lastSyncedAt: 1767225600,
    });

    const captured = await runPullCapture(['pull']);

    expect(captured.exitCode).toBeUndefined();
    expect({ ...captured }).toMatchSnapshot();
  });

  it('batch pull with --posts-only skips taxonomy sync lines entirely', async () => {
    stubBatchFetch({ publishedPosts: [publishedPost('01M67P0MBMJQQXH2K95HHCYRYA', 'alpha')] });
    const captured = await runPullCapture(['pull', '--posts-only']);

    expect(captured.exitCode).toBeUndefined();
    expect({ ...captured }).toMatchSnapshot();
  });

  it('batch pull mirrors a body-referenced storageKey and reports the coverage line', async () => {
    // storageKeys are Crockford base32: I, L-free alphabet — never use letters I/O or lowercase l.
    const storageKey = '01M67P0MBMJQQXH2K95HHC0LMG.png';
    stubBatchFetch({
      publishedPosts: [imagePost('01M67P0MBMJQQXH2K95HHCYRYA', 'alpha', storageKey)],
      draftPosts: [],
      mediaLibrary: [
        {
          id: '01M67P0MBMJQQXH2K95HHC0RECD',
          filename: 'hero.png',
          mimeType: 'image/png',
          size: 4,
          storageKey,
          url: `/_emdash/api/media/file/${storageKey}`,
        },
      ],
    });

    // Binary download for the mirrored asset.
    const originalFetch = globalThis.fetch;
    const wrapped = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes('/_emdash/api/media/file/')) {
        return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200 });
      }
      return originalFetch(input as string, init);
    });
    vi.stubGlobal('fetch', wrapped);

    const captured = await runPullCapture(['pull']);

    expect(captured.exitCode).toBeUndefined();
    // The batch session walk indexes by record id; the body storageKey resolves through the
    // matched record, so the asset mirrors even though the walk itself matches by id.
    expect(
      fs.existsSync(path.join(tempDir, 'media', `${storageKey.replace('.png', '')}.png`)),
    ).toBe(true);
    expect({ ...captured }).toMatchSnapshot();
  });
});
