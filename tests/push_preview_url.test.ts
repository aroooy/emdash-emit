import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Command } from 'commander';
import { CacheDatabase } from '../src/db/cache.js';
import { pushArticle } from '../src/sync/push/index.js';
import { previewArticle } from '../src/sync/orchestrator.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';
import { registerPreviewCommand } from '../src/cli/commands/preview.js';
import { createCliContextResolver } from '../src/cli/context.js';

describe('Push Admin/Preview URL & emit preview (v0.1.63)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-preview-test-'));
    fs.mkdirSync(path.join(tempDir, '.emit'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, '.emit', 'config.json'),
      JSON.stringify({ origin: 'https://example.com', defaultCollection: 'posts' }),
    );
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeDraftArticle(id: string, slug: string, title: string): string {
    const relPath = `posts/draft/20261126_${id}-${slug}.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const fm: Frontmatter = {
      id,
      slug,
      title,
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: { categories: [], tags: [] },
      bylines: [],
    };
    fs.writeFileSync(fullPath, serializeMarkdown(fm, 'Hello preview world.\n'), 'utf8');
    return relPath;
  }

  it('includes adminUrl and hasDraftRevision in PushResult', async () => {
    const id = '01M7BZH06K515A5NQWZ36QK7N1';
    const relPath = writeDraftArticle(id, 'preview-push', 'Preview Push');

    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/lock')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ heldByCaller: true }),
        });
      }
      if (url.includes('/_emdash/api/content/posts') && (!init?.method || init.method === 'GET')) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }
      if (url.includes('/_emdash/api/content/posts') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              id,
              slug: 'preview-push',
              status: 'draft',
              version: 1,
              draftRevisionId: '01M7DRAFTREV00000000000001',
              _rev: 'rev-1',
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { items: [] } }),
      });
    });

    const res = await pushArticle(relPath, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.success).toBe(true);
    expect(res.adminUrl).toBe(`https://example.com/_emdash/admin/content/posts/${id}`);
  });

  it('returns signed previewUrl when endpoint succeeds and falls back to adminUrl on 404', async () => {
    const id = '01M7BZH06K515A5NQWZ36QK7N2';
    const relPath = writeDraftArticle(id, 'preview-cmd', 'Preview Cmd');

    const okFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { url: '/posts/preview-cmd?_preview=hmac-token-123' },
      }),
    });

    const resWithPreview = await previewArticle(relPath, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      fetchFn: okFetch as unknown as typeof fetch,
    });

    expect(resWithPreview.previewUrl).toBe(
      'https://example.com/posts/preview-cmd?_preview=hmac-token-123',
    );
    expect(resWithPreview.adminUrl).toBe(`https://example.com/_emdash/admin/content/posts/${id}`);
    expect(resWithPreview.url).toBe(resWithPreview.previewUrl);

    const notFoundFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const resFallback = await previewArticle(id, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      fetchFn: notFoundFetch as unknown as typeof fetch,
    });

    expect(resFallback.previewUrl).toBeUndefined();
    expect(resFallback.url).toBe(`https://example.com/_emdash/admin/content/posts/${id}`);
  });

  it('supports emit preview CLI --no-open without launching browser', async () => {
    const id = '01M7BZH06K515A5NQWZ36QK7N3';
    const relPath = writeDraftArticle(id, 'preview-cli', 'Preview CLI');
    const openSpy = vi.fn();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    process.env.EMDASH_TOKEN = 'fake-token';
    process.env.EMDASH_ORIGIN = 'https://example.com';
    const prevCwd = process.cwd();
    process.chdir(tempDir);

    try {
      const program = new Command();
      registerPreviewCommand(program, createCliContextResolver(), openSpy);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404 } as Response);

      await program.parseAsync(['node', 'emit', 'preview', relPath, '--no-open']);
      expect(openSpy).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain(`https://example.com/_emdash/admin/content/posts/${id}`);
    } finally {
      process.chdir(prevCwd);
      delete process.env.EMDASH_TOKEN;
      delete process.env.EMDASH_ORIGIN;
    }
  });
});
