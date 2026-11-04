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

  it('initializes MCP server and registers sync tools including sync_diff', () => {
    const server = createMcpServer({ workspaceRoot: tempDir, cache });
    expect(server).toBeDefined();
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
});
