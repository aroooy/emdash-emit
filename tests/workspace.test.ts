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
import {
  findWorkspaceRoot,
  getWorkspacePaths,
  requireWorkspaceRoot,
} from '../src/utils/workspace.js';
import { DEFAULT_ORIGIN, initWorkspace, loadConfig } from '../src/utils/config.js';

describe('Workspace Utils', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds workspace root when .emit is in the current directory', () => {
    const emitDir = path.join(tempDir, '.emit');
    fs.mkdirSync(emitDir);

    const root = findWorkspaceRoot(tempDir);
    expect(root).toBe(tempDir);
  });

  it('recursively finds workspace root from deeply nested subdirectories', () => {
    const emitDir = path.join(tempDir, '.emit');
    fs.mkdirSync(emitDir);

    const deepSubdir = path.join(tempDir, 'posts', 'draft', 'sub-topic', 'archive');
    fs.mkdirSync(deepSubdir, { recursive: true });

    const root = findWorkspaceRoot(deepSubdir);
    expect(root).toBe(tempDir);
  });

  it('returns null when no .emit directory exists in ancestor tree', () => {
    const root = findWorkspaceRoot(tempDir);
    expect(root).toBeNull();
  });

  it('throws an error with actionable guidance in requireWorkspaceRoot when not in workspace', () => {
    expect(() => requireWorkspaceRoot(tempDir)).toThrowError(/Not inside an Emit workspace/i);
  });

  it('resolves correct workspace paths', () => {
    const paths = getWorkspacePaths(tempDir);

    expect(paths.root).toBe(tempDir);
    expect(paths.emitDir).toBe(path.join(tempDir, '.emit'));
    expect(paths.configPath).toBe(path.join(tempDir, '.emit', 'config.json'));
    expect(paths.dbPath).toBe(path.join(tempDir, '.emit', 'cache.db'));
    expect(paths.postsDir).toBe(path.join(tempDir, 'posts'));
  });

  it('initWorkspace writes .emit/config.json with defaults and respects custom limits (L1)', () => {
    // 1. Default configuration round-trip
    initWorkspace(tempDir);
    const defaultLoaded = loadConfig(tempDir);
    expect(defaultLoaded.postsSyncLimit).toBe(30);
    expect(defaultLoaded.mediaSyncLimit).toBe(300);

    // 2. Custom configuration overrides
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-custom-test-'));
    try {
      initWorkspace(customDir, {
        origin: 'https://aroooy.net',
        postsSyncLimit: 250,
      });

      const loaded = loadConfig(customDir);
      expect(loaded.origin).toBe('https://aroooy.net');
      expect(loaded.postsSyncLimit).toBe(250);
      expect(loaded.defaultCollection).toBe('posts');
      expect(DEFAULT_ORIGIN).toBe('https://example.com');
    } finally {
      fs.rmSync(customDir, { recursive: true, force: true });
    }
  });

  it('loadConfig keeps EMDASH_ORIGIN separate from the file value so diagnostics stay truthful', () => {
    initWorkspace(tempDir, { origin: 'https://aroooy.net' });
    const original = process.env.EMDASH_ORIGIN;
    process.env.EMDASH_ORIGIN = 'https://staging.example.com';
    try {
      const loaded = loadConfig(tempDir);
      // `origin` must remain exactly what .emit/config.json says, never the env override.
      expect(loaded.origin).toBe('https://aroooy.net');
      expect(loaded.envOrigin).toBe('https://staging.example.com');
      // The override must not be persisted back into the workspace file.
      const raw = JSON.parse(
        fs.readFileSync(path.join(tempDir, '.emit', 'config.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(raw.envOrigin).toBeUndefined();
      expect(raw.origin).toBe('https://aroooy.net');
    } finally {
      if (original === undefined) delete process.env.EMDASH_ORIGIN;
      else process.env.EMDASH_ORIGIN = original;
    }
  });
});
