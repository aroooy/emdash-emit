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
});
