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
import {
  deleteArticle,
  scanArticleMediaReferences,
  UnpushedModificationsError,
  PublishedArticleDeletionForbiddenError,
} from '../src/sync/delete.js';
import { calculateHash } from '../src/sync/pull.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';
import { ApiError } from '../src/client/error.js';
import { createMcpServer } from '../src/mcp/server.js';
import { initWorkspace } from '../src/utils/config.js';
import { setProfile } from '../src/utils/profile.js';

describe('deleteArticle & sync_delete (§4)', () => {
  let tempDir: string;
  let cache: CacheDatabase;
  const articleId = '01M67DELETE000000000000001';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-delete-test-'));
    initWorkspace(tempDir, { origin: 'https://aroooy.net' });
    const dbPath = path.join(tempDir, '.emit', 'cache.db');
    cache = new CacheDatabase(dbPath);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function setupArticle(options: {
    status?: 'draft' | 'published';
    body?: string;
    isModified?: boolean;
  }) {
    const status = options.status || 'draft';
    const body = options.body || 'Line 1\nLine 2\n';
    const frontmatter: Frontmatter = {
      id: articleId,
      slug: 'test-article-delete',
      title: 'Test Article Delete',
      collection: 'posts',
      status,
      publishedAt: status === 'published' ? '2026-11-01T00:00:00Z' : null,
      locale: 'ja',
      taxonomies: { categories: [], tags: [] },
      bylines: [],
    };

    const serialized = serializeMarkdown(frontmatter, body);
    const relPath = path.join('posts', status, `20261108_${articleId}-test-article-delete.md`);
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, serialized, 'utf8');

    const pristineHash = calculateHash(serialized);
    const localHash = options.isModified ? 'divergent_local_hash' : pristineHash;

    cache.saveBaseSnapshot({
      id: articleId,
      rev: 'rev-1',
      frontmatterYaml: JSON.stringify(frontmatter),
      bodyMarkdown: body,
      hash: pristineHash,
      savedAt: 1700000000,
    });
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash,
      remoteRev: 'rev-1',
      status,
      slug: 'test-article-delete',
      lastSyncedAt: 1700000000,
    });
    cache.saveEntry({
      id: articleId,
      collection: 'posts',
      slug: 'test-article-delete',
      status,
      title: 'Test Article Delete',
      rev: 'rev-1',
      publishedAt: status === 'published' ? '2026-11-01T00:00:00Z' : null,
      rawJson: '{}',
      updatedAt: 1700000000,
    });

    return { relPath, fullPath, serialized };
  }

  describe('scanArticleMediaReferences', () => {
    it('detects Markdown images and HTML img tags pointing to local media', () => {
      const body = [
        'Intro text',
        '![Hero Image](media/01M6_hero.jpg)',
        'Some paragraph with external image: ![Ext](https://example.com/logo.png)',
        '<img src="media/banner.png" alt="Banner" width="600" />',
        'Another ref to same image: ![Again](media/01M6_hero.jpg)',
      ].join('\n');

      const refs = scanArticleMediaReferences(body);
      expect(refs).toEqual(['media/01M6_hero.jpg', 'media/banner.png']);
    });
  });

  describe('Safety Guards', () => {
    it('Guard 1: rejects deletion if unpushed local modifications exist', async () => {
      const { fullPath } = setupArticle({ isModified: true });

      await expect(
        deleteArticle({
          workspaceRoot: tempDir,
          cache,
          id: articleId,
        }),
      ).rejects.toThrow(UnpushedModificationsError);

      // Local file must still exist
      expect(fs.existsSync(fullPath)).toBe(true);
      // Cache records must still exist
      expect(cache.getSyncState(articleId)).not.toBeNull();
    });

    it('Guard 2: rejects deleting published article without allowDeletePublished: true', async () => {
      const { fullPath } = setupArticle({ status: 'published', isModified: false });

      await expect(
        deleteArticle({
          workspaceRoot: tempDir,
          cache,
          id: articleId,
          allowDeletePublished: false,
        }),
      ).rejects.toThrow(PublishedArticleDeletionForbiddenError);

      expect(fs.existsSync(fullPath)).toBe(true);
    });

    it('Guard 2: allows deleting published article when allowDeletePublished: true is supplied', async () => {
      const { fullPath } = setupArticle({ status: 'published', isModified: false });

      const res = await deleteArticle({
        workspaceRoot: tempDir,
        cache,
        id: articleId,
        allowDeletePublished: true,
      });

      expect(res.success).toBe(true);
      expect(fs.existsSync(fullPath)).toBe(false);
      expect(cache.getSyncState(articleId)).toBeNull();
    });
  });

  describe('Dry-run & Rescue Backup', () => {
    it('Dry-run reports metadata and media references without modifying files or cache', async () => {
      const { fullPath } = setupArticle({
        status: 'draft',
        body: 'Intro text\n![Pic](media/photo.jpg)\n',
      });

      const res = await deleteArticle({
        workspaceRoot: tempDir,
        cache,
        id: articleId,
        dryRun: true,
      });

      expect(res.dryRun).toBe(true);
      expect(res.referencedMedia).toEqual(['media/photo.jpg']);
      expect(res.bodyLineCount).toBe(3);
      expect(fs.existsSync(fullPath)).toBe(true);
      expect(cache.getSyncState(articleId)).not.toBeNull();
    });

    it('creates automatic rescue copy in posts/conflicts/<filename>.deleted.md upon actual deletion', async () => {
      const { fullPath, serialized } = setupArticle({
        status: 'draft',
        body: 'Valuable draft content\n',
      });

      const res = await deleteArticle({
        workspaceRoot: tempDir,
        cache,
        id: articleId,
      });

      expect(res.success).toBe(true);
      expect(fs.existsSync(fullPath)).toBe(false);
      expect(res.rescueFilePath).toBeDefined();

      const rescueFullPath = path.join(tempDir, res.rescueFilePath!);
      expect(fs.existsSync(rescueFullPath)).toBe(true);
      expect(fs.readFileSync(rescueFullPath, 'utf8')).toBe(serialized);
    });
  });

  describe('Remote Deletion Integration', () => {
    it('calls remote DELETE endpoint with auth header and cleans local state on 200/204', async () => {
      const { fullPath } = setupArticle({ status: 'draft' });

      let capturedUrl = '';
      let capturedMethod = '';
      let capturedAuth = '';

      const mockFetch = async (input: string | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          capturedUrl = String(input);
          capturedMethod = init?.method || '';
          capturedAuth = (init?.headers as Record<string, string>)?.Authorization || '';
          return new Response(null, { status: 204 });
        }
        // Verification GET returns 404
        return new Response(null, { status: 404 });
      };

      const res = await deleteArticle({
        workspaceRoot: tempDir,
        cache,
        id: articleId,
        origin: 'https://aroooy.net',
        token: 'test-token-123',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(res.success).toBe(true);
      expect(res.remoteDeleted).toBe(true);
      expect(capturedUrl).toBe(`https://aroooy.net/_emdash/api/content/posts/${articleId}`);
      expect(capturedMethod).toBe('DELETE');
      expect(capturedAuth).toBe('Bearer test-token-123');
      expect(fs.existsSync(fullPath)).toBe(false);
    });

    it('aborts, preserves local file, and avoids creating rescue copy if remote returns 500 error', async () => {
      const { fullPath } = setupArticle({ status: 'draft' });

      const failingFetch = async () =>
        new Response('Database failure', {
          status: 500,
          statusText: 'Internal Server Error',
        });

      await expect(
        deleteArticle({
          workspaceRoot: tempDir,
          cache,
          id: articleId,
          origin: 'https://aroooy.net',
          token: 'test-token-123',
          fetchFn: failingFetch as unknown as typeof fetch,
        }),
      ).rejects.toThrow(ApiError);

      // Local file and cache must be preserved
      expect(fs.existsSync(fullPath)).toBe(true);
      expect(cache.getSyncState(articleId)).not.toBeNull();

      // No orphan rescue file must be created (Minor 2)
      const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
      if (fs.existsSync(conflictsDir)) {
        const files = fs.readdirSync(conflictsDir).filter((f) => f.endsWith('.deleted.md'));
        expect(files).toHaveLength(0);
      }
    });

    it('normalizes network fetch exceptions to ApiError with REMOTE_DELETE_FAILED', async () => {
      const { fullPath } = setupArticle({ status: 'draft' });

      const unreachableFetch = async () => {
        throw new TypeError('fetch failed');
      };

      try {
        await deleteArticle({
          workspaceRoot: tempDir,
          cache,
          id: articleId,
          origin: 'https://aroooy.net',
          token: 'test-token-123',
          fetchFn: unreachableFetch as unknown as typeof fetch,
        });
        expect.unreachable('Should have thrown ApiError');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.code).toBe('REMOTE_DELETE_FAILED');
        expect(apiErr.message).toContain('Network error during remote DELETE: fetch failed');
        expect(apiErr.suggestion).toContain('Verify network connectivity');
      }

      // Local file preserved and no rescue copy created
      expect(fs.existsSync(fullPath)).toBe(true);
      const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
      if (fs.existsSync(conflictsDir)) {
        const files = fs.readdirSync(conflictsDir).filter((f) => f.endsWith('.deleted.md'));
        expect(files).toHaveLength(0);
      }
    });

    it('detects false success when remote DELETE returns 200/204 but GET still returns 200 (REMOTE_DELETE_UNCONFIRMED)', async () => {
      const { fullPath } = setupArticle({ status: 'draft' });

      const fakeSuccessFetch = async (_url: string | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          return new Response(null, { status: 204 });
        }
        // Verification GET returns 200 OK (server failed to actually delete)
        return new Response(JSON.stringify({ id: articleId }), { status: 200 });
      };

      try {
        await deleteArticle({
          workspaceRoot: tempDir,
          cache,
          id: articleId,
          origin: 'https://aroooy.net',
          token: 'test-token-123',
          fetchFn: fakeSuccessFetch as unknown as typeof fetch,
        });
        expect.unreachable('Should have thrown ApiError');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).code).toBe('REMOTE_DELETE_UNCONFIRMED');
      }

      // Local file must be preserved and marked as delete_pending
      expect(fs.existsSync(fullPath)).toBe(true);
      const state = cache.getSyncState(articleId);
      expect(state).not.toBeNull();
      expect(state?.deletePending).toBe(1);
    });

    it('treats 410 Gone verification as valid remote deletion', async () => {
      const { fullPath } = setupArticle({ status: 'draft' });

      const goneFetch = async (_url: string | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 410 });
      };

      const res = await deleteArticle({
        workspaceRoot: tempDir,
        cache,
        id: articleId,
        origin: 'https://aroooy.net',
        token: 'test-token-123',
        fetchFn: goneFetch as unknown as typeof fetch,
      });

      expect(res.success).toBe(true);
      expect(res.remoteDeleted).toBe(true);
      expect(fs.existsSync(fullPath)).toBe(false);
    });

    it('handles 409 ENTRY_LOCKED with actionable suggestion', async () => {
      setupArticle({ status: 'draft' });

      const lockedFetch = async () => new Response('Locked', { status: 409 });

      try {
        await deleteArticle({
          workspaceRoot: tempDir,
          cache,
          id: articleId,
          origin: 'https://aroooy.net',
          token: 'test-token-123',
          fetchFn: lockedFetch as unknown as typeof fetch,
        });
        expect.unreachable('Should have thrown ApiError');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).code).toBe('ENTRY_LOCKED');
      }
    });
  });

  describe('MCP sync_delete tool', () => {
    let customProfilesPath: string;

    beforeEach(() => {
      customProfilesPath = path.join(tempDir, 'profiles.yaml');
      setProfile(
        'default',
        {
          origin: 'https://aroooy.net',
          token: 'test-pat-123',
          workspace: tempDir,
        },
        true,
        customProfilesPath,
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init) => {
          if (init?.method === 'DELETE') {
            return new Response(null, { status: 204 });
          }
          return new Response(null, { status: 404 });
        }),
      );
    });

    it('executes via MCP server and returns structured result', async () => {
      setupArticle({ status: 'draft' });

      const server = createMcpServer({
        workspaceRoot: tempDir,
        cache,
        profilesPath: customProfilesPath,
      });
      const registered = (
        server as unknown as {
          _registeredTools: Record<
            string,
            {
              handler: (
                args: Record<string, unknown>,
              ) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;
            }
          >;
        }
      )._registeredTools;

      // 1. Dry run via MCP
      const dryRes = await registered['sync_delete'].handler({ id: articleId, dryRun: true });
      expect(dryRes.isError).toBeUndefined();
      const dryParsed = JSON.parse(dryRes.content[0].text);
      expect(dryParsed.dryRun).toBe(true);

      // 2. Actual delete via MCP
      const delRes = await registered['sync_delete'].handler({ id: articleId });
      expect(delRes.isError).toBeUndefined();
      const delParsed = JSON.parse(delRes.content[0].text);
      expect(delParsed.success).toBe(true);
      expect(delParsed.rescueFilePath).toContain('.deleted.md');
    });

    it('returns structured error when published article is targeted without allowDeletePublished', async () => {
      setupArticle({ status: 'published' });

      const server = createMcpServer({
        workspaceRoot: tempDir,
        cache,
        profilesPath: customProfilesPath,
      });
      const registered = (
        server as unknown as {
          _registeredTools: Record<
            string,
            {
              handler: (
                args: Record<string, unknown>,
              ) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;
            }
          >;
        }
      )._registeredTools;

      const res = await registered['sync_delete'].handler({ id: articleId });
      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.error).toBe('PUBLISHED_ARTICLE_PROTECTION');
      expect(parsed.suggestion).toContain('allowDeletePublished');
    });

    it('T3-3: deleteArticle with discardLocalEdits: true allows deleting unpushed edits on remote 404', async () => {
      const art = setupArticle({ status: 'draft', isModified: true });

      // Remote returns 404
      const mockFetch404 = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        const method = (init?.method || 'GET').toUpperCase();
        if (url.includes('/lock')) return { ok: true, status: 200, json: async () => ({}) };
        return { ok: false, status: 404, statusText: 'Not Found', text: async () => 'Not Found' };
      });

      // 1. Without discardLocalEdits: throws UnpushedModificationsError
      await expect(
        deleteArticle({
          workspaceRoot: tempDir,
          cache,
          filePath: art.relPath,
          origin: 'https://example.com',
          token: 'token',
          fetchFn: mockFetch404 as unknown as typeof fetch,
        }),
      ).rejects.toThrowError(/unpushed local modifications/i);

      // 2. With discardLocalEdits: true: succeeds, creates .deleted.md rescue copy, deletes canonical and cache
      const res = await deleteArticle({
        workspaceRoot: tempDir,
        cache,
        filePath: art.relPath,
        origin: 'https://example.com',
        token: 'token',
        discardLocalEdits: true,
        fetchFn: mockFetch404 as unknown as typeof fetch,
      });

      expect(res.success).toBe(true);
      expect(res.rescueFilePath).toBeDefined();
      expect(res.rescueFilePath).toContain('.deleted.md');
      expect(fs.existsSync(art.fullPath)).toBe(false);
      expect(cache.getSyncState(articleId)).toBeNull();
    });
  });
});
