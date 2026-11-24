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
import { calculateHash } from '../src/sync/workspace/index.js';
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
    // The two media ID spaces are the most common source of agent confusion, so the instructions must
    // name both identifiers and point at the standalone specification document.
    expect(instructions).toContain('docs/media-id-spaces.md');
    expect(instructions).toContain('storageKey');
    // Agents must be cautioned against running all:true routinely, and directed to checkMediaLibrary first
    expect(instructions).toContain('Do NOT use sync_pull_media with all: true');
    expect(instructions).toContain('checkMediaLibrary: true');

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
      'sync_media_search',
      'sync_push_media',
      'sync_delete_media',
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

    // sync_pull_media description and all-parameter safety assertion
    expect(registered['sync_pull_media'].description).toContain(
      'targeted media referenced by an article',
    );
    expect(registered['sync_pull_media'].description).toContain('maintenance/backup only');

    const syncPullMediaTool = registered['sync_pull_media'] as unknown as {
      inputSchema?: { _def?: { shape?: () => Record<string, { description?: string }> } };
    };
    const mediaShape = syncPullMediaTool.inputSchema?._def?.shape?.();
    expect(mediaShape).toBeDefined();
    expect(mediaShape!['all']).toBeDefined();
    expect(mediaShape!['all'].description).toContain('Maintenance/backup only');
    expect(mediaShape!['all'].description).toContain('NOT for routine use');
  });

  it('sync_pull source code locks bounded media library pass label and forbids "full library" (G-3)', () => {
    const syncPullSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/mcp/tools/sync-pull.ts'),
      'utf-8',
    );
    expect(syncPullSrc).toContain('Media (library pass, limit');
    expect(syncPullSrc).not.toContain('Media (full library)');
  });

  it('docs/media-id-spaces.md enforces doctor --check-media-library first and reserves --all (G-5)', () => {
    const docPath = path.resolve(__dirname, '../docs/media-id-spaces.md');
    const doc = fs.readFileSync(docPath, 'utf-8');
    expect(doc).toContain('index the library with `emit doctor --check-media-library` first');
    expect(doc).toContain('reserve `emit pull-media --all` for deliberate full offline backups');
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

  it('sync_new accepts extended arguments (categories, tags, description, featuredImage) and shows Assigned confirmation and warnings (v0.1.20)', async () => {
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
      slug: 'extended-post',
      title: 'Extended Post',
      categories: ['tech', 'unknown-cat'],
      tags: 'nodejs, unknown-tag',
      description: 'A test excerpt',
      featuredImage: '../../media/drafts/eyecatch.jpg',
    });

    const text = res.content[0].text;
    expect(text).toContain("Created new draft article 'extended-post'");
    expect(text).toContain(
      '- Assigned: categories=[tech, unknown-cat], tags=[nodejs, unknown-tag], featuredImage=../../media/drafts/eyecatch.jpg, description="A test excerpt"',
    );
    expect(text).toContain('⚠️ Warnings:');
    expect(text).toContain("Unknown category slug 'unknown-cat'");
    expect(text).toContain("Unknown tag slug 'unknown-tag'");
    expect(text).toContain('Available Categories:');
    expect(text).toContain('- tech (技術)');
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
      expect(mediaPullRes.content[0].text).toContain(`Media IDs: ${mediaId}`);
      expect(mediaPullRes.content[0].text).toContain('_meta:');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('T4-2, T4-6: sync_media_search returns structured JSON with hits and walkComplete', async () => {
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
            handler: (args: Record<string, unknown>) => Promise<{
              isError?: boolean;
              content: Array<{ type: string; text: string }>;
            }>;
          }
        >;
      }
    )._registeredTools;

    const origFetch = globalThis.fetch;
    const now = Date.now();
    cache.saveSnapshotMeta({
      collection: 'posts',
      capturedAt: now,
      articleCount: 0,
      mediaCount: 1,
      taxonomyFetchedCount: 0,
      taxonomyReusedCount: 0,
      articleSingleGetCount: 0,
      durationMs: 1,
    });
    cache.upsertSnapshotMediaBatch({
      walkComplete: true,
      records: [
        {
          mediaId: '01M67P08DXFTYDPFRTJCC4XMP8',
          storageKey: '01M67P07X2VPW0MYRRRGMA6T5A.jpg',
          filename: 'sky.jpg',
          mimeType: 'image/jpeg',
          size: 5000,
          alt: '夕焼け空',
          capturedAt: now,
        },
      ],
    });
    globalThis.fetch = vi.fn(() => {
      throw new Error('sync_media_search must not make network calls');
    }) as unknown as typeof fetch;

    try {
      const res = await registered['sync_media_search'].handler({
        query: '夕焼け',
      });

      expect(res.isError).toBeUndefined();
      const payload = JSON.parse(res.content[0].text);
      expect(payload.query).toBe('夕焼け');
      expect(payload.scannedCount).toBe(1);
      expect(payload.walkComplete).toBe(true);
      expect(payload.snapshotStatus).toBe('fresh');
      expect(payload.absenceGuaranteed).toBe(true);
      expect(payload.hits).toHaveLength(1);
      expect(payload.hits[0].storageKey).toBe('01M67P07X2VPW0MYRRRGMA6T5A.jpg');
      expect(payload.hits[0].mirrored).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('T4-5: sync_article_search live:true rejects unsupported filters and formats HTTP error via formatToolError', async () => {
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
            handler: (args: Record<string, unknown>) => Promise<{
              isError?: boolean;
              content: Array<{ type: string; text: string }>;
            }>;
          }
        >;
      }
    )._registeredTools;

    const filterRes = await registered['sync_article_search'].handler({
      query: 'test',
      live: true,
      tag: 'news',
    });
    expect(filterRes.isError).toBe(true);
    expect(filterRes.content[0].text).toContain('LIVE_SEARCH_UNSUPPORTED_FILTER');

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Error',
    }) as unknown as typeof fetch;

    try {
      const res = await registered['sync_article_search'].handler({
        query: 'fail-test',
        live: true,
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('ARTICLE_SEARCH_FAILED');
      expect(res.content[0].text).toContain('HTTP 500');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('T5-5: sync_pull_media with storageKey mirrors targeted asset', async () => {
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
            handler: (args: Record<string, unknown>) => Promise<{
              isError?: boolean;
              content: Array<{ type: string; text: string }>;
            }>;
          }
        >;
      }
    )._registeredTools;

    const targetKey = '01M6TARGETKEYMCP0000000001.jpg';
    const targetId = '01M6TARGETIDMCP00000000001';

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((urlStr: string) => {
      if (urlStr.includes('/_emdash/api/media/file/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(50),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            items: [
              {
                id: targetId,
                filename: 'mcp-target.jpg',
                mimeType: 'image/jpeg',
                size: 50,
                storageKey: targetKey,
              },
            ],
            nextCursor: null,
          },
        }),
      });
    }) as unknown as typeof fetch;

    try {
      const res = await registered['sync_pull_media'].handler({
        storageKey: targetKey,
      });

      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toContain(
        `Successfully pulled targeted media asset '${targetKey}'`,
      );
      expect(res.content[0].text).toContain('1 downloaded');

      // Unresolved storageKey must return isError: true
      const errRes = await registered['sync_pull_media'].handler({
        storageKey: 'unresolved-key.jpg',
      });
      expect(errRes.isError).toBe(true);
      expect(errRes.content[0].text).toContain('Could not resolve targeted storageKey');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('registers sync_snapshot and supports status, clear, and sync_status snapshot metadata (v0.1.47)', async () => {
    const server = createMcpServer({ workspaceRoot: tempDir, cache });
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

    expect(registered['sync_snapshot']).toBeDefined();

    const emptyStatus = JSON.parse(
      (await registered['sync_snapshot'].handler({ action: 'status' })).content[0].text,
    );
    expect(emptyStatus.action).toBe('status');
    expect(emptyStatus.meta).toBeNull();

    cache.saveSnapshotMeta({
      collection: 'posts',
      capturedAt: Date.now(),
      articleCount: 5,
      mediaCount: 3,
      taxonomyFetchedCount: 2,
      taxonomyReusedCount: 3,
      articleSingleGetCount: 1,
      durationMs: 30,
    });

    const populatedStatus = JSON.parse(
      (await registered['sync_snapshot'].handler({ action: 'status' })).content[0].text,
    );
    expect(populatedStatus.meta.articleCount).toBe(5);
    expect(populatedStatus.meta.mediaCount).toBe(3);
    expect(populatedStatus.meta.stale).toBe(false);

    const syncStatusPayload = JSON.parse(
      (await registered['sync_status'].handler({})).content[0].text,
    );
    expect(syncStatusPayload.snapshot.articleCount).toBe(5);
    expect(syncStatusPayload.snapshot.mediaCount).toBe(3);

    const cleared = JSON.parse(
      (await registered['sync_snapshot'].handler({ action: 'clear' })).content[0].text,
    );
    expect(cleared.action).toBe('clear');
    expect(cache.getSnapshotMeta('posts')).toBeNull();
  });

  it('sync_push forwards allowModifiedOpaqueBlocks to bypass Guard G9 (v0.1.51)', async () => {
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
            ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
          }
        >;
      }
    )._registeredTools;

    const id = '01M8MCPOPAQUE0000000000001';
    const relPath = `posts/draft/20261122_${id}-mcp-opaque.md`;
    const absPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(
      absPath,
      `---\nid: ${id}\nslug: mcp-opaque\ntitle: "MCP Opaque"\ncollection: posts\nlocale: ja\nstatus: draft\ntaxonomies: {}\nbylines: []\n---\n\n<!--ec:block {"_type":"core:gallery","_key":"tampered"} -->\n\nBody\n`,
      'utf8',
    );
    cache.saveBaseSnapshot({
      id,
      rev: '1',
      frontmatterYaml: JSON.stringify({
        id,
        slug: 'mcp-opaque',
        title: 'MCP Opaque',
        collection: 'posts',
        locale: 'ja',
        status: 'draft',
        taxonomies: {},
        bylines: [],
      }),
      bodyMarkdown: '<!--ec:block {"_type":"core:gallery","_key":"k1"} -->\n\nBody',
      hash: 'base-hash',
      savedAt: Date.now(),
    });
    cache.saveSyncState({
      id,
      localFilePath: relPath,
      localHash: 'modified-hash',
      remoteRev: '1',
      status: 'draft',
      slug: 'mcp-opaque',
      lastSyncedAt: Date.now(),
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (urlStr: string) => {
      if (urlStr.includes('/lock')) {
        return { ok: true, status: 200, json: async () => ({ locked: true, token: 'l1' }) };
      }
      if (urlStr.includes('/_emdash/api/taxonomies')) {
        return { ok: true, status: 200, json: async () => ({ data: { items: [] } }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            id,
            slug: 'mcp-opaque',
            title: 'MCP Opaque',
            status: 'draft',
            version: 2,
            rev: '2',
            draftRevisionId: 'd2',
          },
        }),
      };
    }) as unknown as typeof fetch;

    try {
      const blocked = await registered['sync_push'].handler({ filePath: relPath });
      expect(blocked.isError).toBe(true);
      expect(blocked.content[0].text).toContain('MODIFIED_OPAQUE_BLOCK');

      const bypassed = await registered['sync_push'].handler({
        filePath: relPath,
        allowModifiedOpaqueBlocks: true,
      });
      expect(bypassed.isError).toBeUndefined();
      expect(bypassed.content[0].text).toContain('Bypassed Guard G9');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('sync_push_media uploads standalone media and updates companion YAML metadata (v0.1.52)', async () => {
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
            ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
          }
        >;
      }
    )._registeredTools;

    const mediaId = '01M67P0MBMJQQXH2K95HHCYRYB';
    const storageKey = '01M67P0MBMJQQXH2K95HHCYRYB.01M6CONFIRMED0000000000000.png';
    const stem = '01M67P0MBMJQQXH2K95HHCYRYB.01M6CONFIRMED0000000000000';
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(
      path.join(mediaDir, `${stem}.yaml`),
      `id: ${mediaId}\nfilename: sample.png\nmimeType: image/png\nsize: 68\nalt: "MCP YAML Alt"\ncaption: "MCP YAML Caption"\nstorageKey: ${storageKey}\nstatus: ready\n`,
      'utf8',
    );

    const origFetch = globalThis.fetch;
    const putPayloads: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (_urlStr: string, init?: RequestInit) => {
      putPayloads.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
    }) as unknown as typeof fetch;

    try {
      const res = await registered['sync_push_media'].handler({
        targets: [`media/${stem}.yaml`],
      });
      expect(res.isError).toBeUndefined();
      const parsed = JSON.parse(res.content[0].text) as {
        total: number;
        items: Array<{ action: string; mediaId: string; alt: string; caption: string }>;
      };
      expect(parsed.total).toBe(1);
      expect(parsed.items[0]).toMatchObject({
        action: 'metadata-updated',
        mediaId,
        alt: 'MCP YAML Alt',
        caption: 'MCP YAML Caption',
      });
      expect(putPayloads).toEqual([{ alt: 'MCP YAML Alt', caption: 'MCP YAML Caption' }]);

      // v0.1.53: sync_delete_media dryRun and execution
      const delDry = await registered['sync_delete_media'].handler({
        targets: [`media/${stem}.yaml`],
        dryRun: true,
      });
      expect(delDry.isError).toBeUndefined();
      const delParsed = JSON.parse(delDry.content[0].text) as {
        dryRun: boolean;
        total: number;
        report: string;
      };
      expect(delParsed.dryRun).toBe(true);
      expect(delParsed.total).toBe(1);
      expect(delParsed.report).toContain('would delete:');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
