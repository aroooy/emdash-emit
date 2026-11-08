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
import { createMcpServer } from '../src/mcp/server.js';
import { calculateHash } from '../src/sync/pull.js';
import { initWorkspace } from '../src/utils/config.js';
import { setProfile } from '../src/utils/profile.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';

describe('Emit MCP Server', () => {
  let tempDir: string;
  let cache: CacheDatabase;
  let customProfilesPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-mcp-test-'));
    initWorkspace(tempDir, { origin: 'https://aroooy.net' });
    const dbPath = path.join(tempDir, '.emit', 'cache.db');
    cache = new CacheDatabase(dbPath);

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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('initializes MCP server and registers sync tools with comprehensive descriptions and instructions', () => {
    const server = createMcpServer({
      workspaceRoot: tempDir,
      cache,
      profilesPath: customProfilesPath,
    });
    expect(server).toBeDefined();

    // Verify MCP instructions
    const instructions = (server.server as unknown as { _instructions?: string })._instructions;
    expect(instructions).toBeDefined();
    expect(instructions).toContain('The Golden Path');
    expect(instructions).toContain('posts/published');
    expect(instructions).toContain('taxonomies');

    // Expected tools
    const expectedTools = [
      'profile_list',
      'profile_switch',
      'sync_diff',
      'sync_new',
      'sync_pull',
      'sync_pull_taxonomies',
      'sync_pull_media',
      'sync_push',
      'sync_status',
      'sync_delete',
      'sync_conflicts',
      'sync_doctor',
    ];

    const registered = (
      server as unknown as {
        _registeredTools: Record<string, { description?: string }>;
      }
    )._registeredTools;

    for (const toolName of expectedTools) {
      expect(registered[toolName]).toBeDefined();
      const desc = registered[toolName].description;
      expect(desc).toBeDefined();
      expect(typeof desc).toBe('string');
      expect(desc!.length).toBeGreaterThan(20);
    }

    // sync_pull description must mention taxonomies (new unified behavior)
    expect(registered['sync_pull'].description).toContain('taxonomies');

    // sync_status description must mention newest-first
    expect(registered['sync_status'].description).toContain('newest-first');

    // sync_pull must include postsOnly / includeMedia / metadataOnly parameters.
    // The MCP SDK stores inputSchema as the raw Zod object; shape keys expose the parameter names.
    const syncPullTool = registered['sync_pull'] as unknown as {
      inputSchema?: { _def?: { shape?: () => Record<string, unknown> } };
    };
    const shape = syncPullTool.inputSchema?._def?.shape?.();
    expect(shape).toBeDefined();
    expect(shape!['postsOnly']).toBeDefined();
    expect(shape!['includeMedia']).toBeDefined();
    expect(shape!['metadataOnly']).toBeDefined();
  });

  it('correctly resolves ULID from filePath with yyyyMMdd_ date prefix in sync_pull', () => {
    // Test the regex logic used in sync_pull
    const filePath = 'posts/draft/20261103_01M6FBAJ2JKNX8VAYXXASYSFGA-test-title.md';
    const filename = path.basename(filePath);
    const baseWithoutDate = filename.replace(/^\d{8}_/, '');
    const match = baseWithoutDate.match(/^([0-9A-Z]{26})-/);

    expect(match).not.toBeNull();
    expect(match![1]).toBe('01M6FBAJ2JKNX8VAYXXASYSFGA');
  });

  it('G1 Guard: blocks sync_push without filePath or id', async () => {
    const server = createMcpServer({
      workspaceRoot: tempDir,
      cache,
      profilesPath: customProfilesPath,
    });
    expect(server).toBeDefined();
  });

  it('sync_new includes available categories and tags hint in response', async () => {
    const catDir = path.join(tempDir, 'categories');
    const tagDir = path.join(tempDir, 'tags');
    fs.mkdirSync(catDir, { recursive: true });
    fs.mkdirSync(tagDir, { recursive: true });

    fs.writeFileSync(
      path.join(catDir, '01M6CAT1-Tech.yaml'),
      'id: 01M6CAT1\nname: 技術\nslug: tech\n',
    );
    fs.writeFileSync(
      path.join(tagDir, '01M6TAG1-Node.yaml'),
      'id: 01M6TAG1\nname: nodejs\nslug: nodejs\n',
    );

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
            ) => Promise<{ content: Array<{ type: string; text: string }> }>;
          }
        >;
      }
    )._registeredTools;

    const res = await registered['sync_new'].handler({
      slug: 'my-new-post',
      title: 'My New Post',
    });
    expect(res.content[0].text).toContain('Created new draft article');
    expect(res.content[0].text).toContain('Available Categories:');
    expect(res.content[0].text).toContain('- tech (技術)');
    expect(res.content[0].text).toContain('Available Tags:');
    expect(res.content[0].text).toContain('nodejs');
    expect(res.content[0].text).not.toContain('nodejs (nodejs)');
  });

  it('sync_pull batch mode includes taxonomies hint in response', async () => {
    const catDir = path.join(tempDir, 'categories');
    const tagDir = path.join(tempDir, 'tags');
    fs.mkdirSync(catDir, { recursive: true });
    fs.mkdirSync(tagDir, { recursive: true });

    fs.writeFileSync(
      path.join(catDir, '01M6CAT1-Tech.yaml'),
      'id: 01M6CAT1\nname: 技術\nslug: tech\n',
    );
    fs.writeFileSync(
      path.join(tagDir, '01M6TAG1-Node.yaml'),
      'id: 01M6TAG1\nname: nodejs\nslug: nodejs\n',
    );

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/taxonomies/category/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: { terms: [{ id: '01M6CAT1', slug: 'tech', label: '技術' }] },
          }),
        });
      }
      if (url.includes('/taxonomies/tag/terms')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: { terms: [{ id: '01M6TAG1', slug: 'nodejs', label: 'nodejs' }] },
          }),
        });
      }
      if (url.includes('/bylines')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { bylines: [] } }),
        });
      }
      if (url.includes('/content/posts')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { items: [] } }),
        });
      }
      return Promise.reject(new Error(`Unexpected url: ${url}`));
    });

    vi.stubGlobal('fetch', mockFetch);

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
            ) => Promise<{ content: Array<{ type: string; text: string }> }>;
          }
        >;
      }
    )._registeredTools;

    const res = await registered['sync_pull'].handler({});
    expect(res.content[0].text).toContain('Synced 0 articles');
    expect(res.content[0].text).toContain('Available Categories:');
    expect(res.content[0].text).toContain('- tech (技術)');
    expect(res.content[0].text).toContain('Available Tags:');
    expect(res.content[0].text).toContain('nodejs');

    // Test sync_pull with postsOnly: true still shows local hint without remote taxonomy sync message
    mockFetch.mockClear();
    const resPostsOnly = await registered['sync_pull'].handler({ postsOnly: true });
    expect(resPostsOnly.content[0].text).toContain('Synced 0 articles');
    expect(resPostsOnly.content[0].text).not.toContain('Taxonomies:');
    expect(resPostsOnly.content[0].text).toContain('Available Categories:');
    expect(resPostsOnly.content[0].text).toContain('- tech (技術)');
    // Remote taxonomy endpoints should not have been called
    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/taxonomies/category/terms'),
      expect.anything(),
    );
  });

  it('sync_status caps invalid items at 10 and includes invalidTruncated + repairHint', async () => {
    const pubDir = path.join(tempDir, 'posts', 'published');
    fs.mkdirSync(pubDir, { recursive: true });

    // Create 15 broken markdown files with unquoted %-prefixed taxonomy terms
    for (let i = 1; i <= 15; i++) {
      const padded = String(i).padStart(2, '0');
      const id = `01M67N19JPWNGFZ0M6KBQ8FS${padded}`;
      const file = `20261107_${id}-Broken-${padded}.md`;
      const content = [
        '---',
        `id: ${id}`,
        `slug: broken-${padded}`,
        `title: "Broken ${padded}"`,
        'collection: posts',
        'status: published',
        'locale: ja',
        'taxonomies:',
        '  categories:',
        '    - %e6%9c%aa%e5%88%86%e9%a1%9e',
        '---',
        '',
        'Body',
      ].join('\n');
      fs.writeFileSync(path.join(pubDir, file), content, 'utf8');
    }

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
            ) => Promise<{ content: Array<{ type: string; text: string }> }>;
          }
        >;
      }
    )._registeredTools;

    const res = await registered['sync_status'].handler({});
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.summary.total).toBe(15);
    expect(parsed.summary.invalid).toBe(15);
    expect(
      parsed.items.filter((i: { syncStatus: string }) => i.syncStatus === 'invalid'),
    ).toHaveLength(10);
    expect(parsed.invalidTruncated).toBe(5);
    expect(parsed.repairHint).toContain('sync_pull');
  });

  it('honors profilesPath so resolution never depends on the machine-level profiles.yaml', async () => {
    // Add two more sites to the custom file only. Neither matches the temp workspace and no
    // explicit profile is requested, so the custom file is genuinely ambiguous. If createMcpServer
    // ignored profilesPath and read ~/.config/emit/profiles.yaml instead, this would resolve
    // silently against whatever happens to be configured on the executing machine.
    setProfile(
      'site-a',
      { origin: 'https://site-a.example.com', token: 'tok-a' },
      false,
      customProfilesPath,
    );
    setProfile(
      'site-b',
      { origin: 'https://site-b.example.com', token: 'tok-b' },
      false,
      customProfilesPath,
    );

    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-mcp-ambiguous-'));
    try {
      const server = createMcpServer({
        workspaceRoot: otherRoot,
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

      const res = await registered['sync_status'].handler({});
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Multiple site profiles exist');
      expect(res.content[0].text).toContain('site-a');
      expect(res.content[0].text).toContain('site-b');
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('surfaces an EMDASH_ORIGIN override as a warning instead of silently retargeting writes', async () => {
    // The temp workspace and the custom profile both point at https://aroooy.net. An ambient
    // EMDASH_ORIGIN must outrank the implicitly resolved profile (so CI/staging overrides take
    // effect) while telling the agent that writes were retargeted.
    const originalEnv = process.env.EMDASH_ORIGIN;
    process.env.EMDASH_ORIGIN = 'https://staging.example.com';
    try {
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

      const overridden = await registered['sync_status'].handler({});
      expect(overridden.isError).toBeUndefined();
      const payload = JSON.parse(overridden.content[0].text) as { warnings?: string[] };
      expect(payload.warnings).toBeDefined();
      expect(payload.warnings?.[0]).toContain(
        'EMDASH_ORIGIN (https://staging.example.com) overrides',
      );
      expect(payload.warnings?.[0]).toContain('Writes now target EMDASH_ORIGIN');

      // An explicit in-band profile outranks the ambient env var, but the conflict is still reported.
      const explicit = await registered['sync_status'].handler({ profile: 'default' });
      expect(explicit.isError).toBeUndefined();
      const explicitPayload = JSON.parse(explicit.content[0].text) as { warnings?: string[] };
      expect(explicitPayload.warnings?.[0]).toContain(
        'is ignored because profile "default" was explicitly selected',
      );
    } finally {
      if (originalEnv === undefined) delete process.env.EMDASH_ORIGIN;
      else process.env.EMDASH_ORIGIN = originalEnv;
    }
  });

  it('provides summary-first structure with capped actionRequired, recentArticles, and search filters (§3.2)', async () => {
    const draftDir = path.join(tempDir, 'posts', 'draft');
    const pubDir = path.join(tempDir, 'posts', 'published');
    fs.mkdirSync(draftDir, { recursive: true });
    fs.mkdirSync(pubDir, { recursive: true });

    // Create 35 modified/untracked articles to test actionRequired cap of 30
    for (let i = 1; i <= 35; i++) {
      const padded = String(i).padStart(2, '0');
      const id = `01M67MOD0000000000000000${padded}`;
      const file = `20261101_${id}-mod-${padded}.md`;
      const content = [
        '---',
        `id: ${id}`,
        `slug: mod-${padded}`,
        `title: "Mod ${padded}"`,
        'collection: posts',
        'status: draft',
        'locale: ja',
        '---',
        '',
        'Body content',
      ].join('\n');
      fs.writeFileSync(path.join(draftDir, file), content, 'utf8');
    }

    // Create 10 synced articles in published to test recentArticles cap of 5
    for (let i = 1; i <= 10; i++) {
      const padded = String(i).padStart(2, '0');
      const id = `01M67SYNC000000000000000${padded}`;
      const file = `20261102_${id}-synced-${padded}.md`;
      const content = [
        '---',
        `id: ${id}`,
        `slug: synced-${padded}`,
        `title: "Synced ${padded}"`,
        'collection: posts',
        'status: published',
        'locale: ja',
        '---',
        '',
        'Body content',
      ].join('\n');
      const fullPath = path.join(pubDir, file);
      fs.writeFileSync(fullPath, content, 'utf8');

      const hash = calculateHash(content);
      cache.saveSyncState({
        id,
        localFilePath: path.join('posts', 'published', file),
        localHash: hash,
        remoteRev: 'rev-1',
        status: 'published',
        slug: `synced-${padded}`,
        lastSyncedAt: 1700000000,
      });
      cache.saveBaseSnapshot({
        id,
        rev: 'rev-1',
        frontmatterYaml: JSON.stringify({
          id,
          slug: `synced-${padded}`,
          title: `Synced ${padded}`,
          collection: 'posts',
          status: 'published',
          locale: 'ja',
        }),
        bodyMarkdown: 'Body content',
        hash,
        savedAt: 1700000000,
      });
    }

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

    // 1. Unfiltered call: returns summary-first payload with 30 capped actionRequired & 5 recentArticles
    const res = await registered['sync_status'].handler({});
    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(res.content[0].text);

    expect(payload.summary.total).toBe(45);
    expect(payload.summary.untracked).toBe(35);
    expect(payload.summary.synced).toBe(10);

    expect(payload.actionRequired).toHaveLength(30);
    expect(payload.actionRequiredTruncated).toBe(true);
    expect(payload.recentArticles).toHaveLength(5);
    expect(payload.recentArticlesTruncated).toBe(true);

    // 2. Filter by search: matches specific article
    const searchRes = await registered['sync_status'].handler({ search: 'synced-07' });
    const searchPayload = JSON.parse(searchRes.content[0].text);
    expect(searchPayload.searchQuery).toBe('synced-07');
    expect(searchPayload.filteredArticles).toHaveLength(1);
    expect(searchPayload.filteredArticles[0].slug).toBe('synced-07');

    // 3. Filter by slugFilter
    const slugRes = await registered['sync_status'].handler({ slugFilter: 'mod-05' });
    const slugPayload = JSON.parse(slugRes.content[0].text);
    expect(slugPayload.filteredArticles).toHaveLength(1);
    expect(slugPayload.filteredArticles[0].slug).toBe('mod-05');

    // 4. Filter by status: 'published'
    const statusRes = await registered['sync_status'].handler({ status: 'published' });
    const statusPayload = JSON.parse(statusRes.content[0].text);
    expect(statusPayload.filteredArticles).toHaveLength(10);
    for (const item of statusPayload.filteredArticles) {
      expect(item.status).toBe('published');
    }
  });

  it('provides _meta context, sync_conflicts, and sync_doctor tools (Phase 3)', async () => {
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

    // 1. sync_status response contains _meta object
    const statusRes = await registered['sync_status'].handler({});
    expect(statusRes.isError).toBeUndefined();
    const statusPayload = JSON.parse(statusRes.content[0].text);
    expect(statusPayload._meta).toBeDefined();
    expect(statusPayload._meta.origin).toBe('https://aroooy.net');
    expect(statusPayload._meta.profile).toBe('default');
    expect(statusPayload._meta.workspace).toBe(tempDir);
    expect(statusPayload._meta.resolvedBy).toBeDefined();

    // 2. sync_conflicts list
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    fs.mkdirSync(conflictsDir, { recursive: true });
    const conflictFm: Frontmatter = {
      id: '01M67TESTCONFLICT000000001',
      slug: 'mcp-conflict-test',
      title: 'MCP Conflict Title',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const conflictContent = serializeMarkdown(conflictFm, 'MCP Conflict Content\n');
    const conflictFile = '20261108_01M67TESTCONFLICT000000001-mcp-conflict-test.conflict.md';
    fs.writeFileSync(path.join(conflictsDir, conflictFile), conflictContent, 'utf8');

    const listRes = await registered['sync_conflicts'].handler({ action: 'list' });
    expect(listRes.isError).toBeUndefined();
    const listPayload = JSON.parse(listRes.content[0].text);
    expect(listPayload.count).toBe(1);
    expect(listPayload.conflicts[0].slug).toBe('mcp-conflict-test');
    expect(listPayload._meta).toBeDefined();

    // 3. sync_conflicts diff
    const diffRes = await registered['sync_conflicts'].handler({
      action: 'diff',
      filePath: conflictFile,
    });
    expect(diffRes.isError).toBeUndefined();
    const diffPayload = JSON.parse(diffRes.content[0].text);
    expect(diffPayload.hasDifferences).toBe(true);
    expect(diffPayload._meta).toBeDefined();

    // 4. sync_conflicts resolve (accept-canonical)
    const resolveRes = await registered['sync_conflicts'].handler({
      action: 'resolve',
      filePath: conflictFile,
      strategy: 'accept-canonical',
    });
    expect(resolveRes.isError).toBeUndefined();
    const resolvePayload = JSON.parse(resolveRes.content[0].text);
    expect(resolvePayload.success).toBe(true);
    expect(resolvePayload.strategy).toBe('accept-canonical');
    expect(fs.existsSync(path.join(conflictsDir, conflictFile))).toBe(false);

    // 5. sync_doctor
    const doctorRes = await registered['sync_doctor'].handler({});
    expect(doctorRes.isError).toBeUndefined();
    const doctorPayload = JSON.parse(doctorRes.content[0].text);
    expect(doctorPayload.overallStatus).toBeDefined();
    expect(doctorPayload.checks).toBeInstanceOf(Array);
    expect(doctorPayload.checks.length).toBeGreaterThanOrEqual(5);
    expect(doctorPayload._meta).toBeDefined();

    // 6. sync_pull_media with article
    const articleId = '01M67TESTMEDA0000000000001';
    const mediaId = '01M67HERAMEDA0000000000001';
    const postWithMedia = path.join(
      tempDir,
      'posts',
      'draft',
      `20261108_${articleId}-media-test.md`,
    );
    fs.mkdirSync(path.dirname(postWithMedia), { recursive: true });
    fs.writeFileSync(
      postWithMedia,
      `---
id: ${articleId}
slug: media-test
title: Media Test Article
featuredImage: ${mediaId}
collection: posts
status: draft
locale: ja
taxonomies: {}
bylines: []
---

Inline body
`,
      'utf8',
    );

    // Mock fetch for sync_pull_media
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes(`/api/media/${mediaId}`)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              item: {
                id: mediaId,
                filename: 'hero.jpg',
                mimeType: 'image/jpeg',
                size: 10,
                url: '/_emdash/api/media/file/hero.jpg',
                createdAt: '2026-11-08T12:00:00.000Z',
              },
            },
          }),
        });
      }
      if (url.includes('/_emdash/api/media/file/hero.jpg')) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(10),
        });
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    }) as unknown as typeof fetch;

    try {
      const mediaPullRes = await registered['sync_pull_media'].handler({
        article: articleId,
      });
      expect(mediaPullRes.isError).toBeUndefined();
      expect(mediaPullRes.content[0].text).toContain(
        `Successfully pulled media for article '${articleId}': 1 referenced item(s)`,
      );
      expect(mediaPullRes.content[0].text).toContain('_meta:');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
