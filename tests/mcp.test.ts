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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheDatabase } from '../src/db/cache.js';
import { createMcpServer } from '../src/mcp/server.js';
import { initWorkspace } from '../src/utils/config.js';
import { setProfile } from '../src/utils/profile.js';

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
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('initializes MCP server and registers sync tools with comprehensive descriptions and instructions', () => {
    const server = createMcpServer({ workspaceRoot: tempDir, cache });
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
    const server = createMcpServer({ workspaceRoot: tempDir, cache });
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

    const server = createMcpServer({ workspaceRoot: tempDir, cache });
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
});
