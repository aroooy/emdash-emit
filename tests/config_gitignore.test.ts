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

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EMIT_GITIGNORE_TEMPLATE,
  ensureEmitGitignore,
  initWorkspace,
} from '../src/utils/config.js';

/**
 * v0.1.38 P3 — T3-1: `emit init` must ship ignore rules for its own cache database, because first-time
 * users otherwise commit machine-local SQLite. The patterns are checked against real Git semantics rather
 * than string equality alone, since a rule that does not match the file it names protects nothing.
 */
describe('ensureEmitGitignore (v0.1.38 P3)', () => {
  let tempDir: string;
  let tempRepoDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-gitignore-test-'));
    tempRepoDir = path.join(tempDir, 'repo');
  });

  afterEach(() => {
    // The throwaway repository holds a `.git/` directory; removing the parent clears it with the rest.
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates .emit/.gitignore with the cache patterns', () => {
    const emitDir = path.join(tempDir, '.emit');
    fs.mkdirSync(emitDir);

    const result = ensureEmitGitignore(emitDir);
    expect(result.created).toBe(true);
    expect(result.path).toBe(path.join(emitDir, '.gitignore'));
    expect(fs.readFileSync(result.path, 'utf8')).toBe(EMIT_GITIGNORE_TEMPLATE);

    for (const pattern of ['cache.db', 'cache.db-wal', 'cache.db-shm', 'mcp_state.json']) {
      expect(EMIT_GITIGNORE_TEMPLATE).toContain(pattern);
    }
    // A backup rotation writes cache.db.bak-<n>, so the glob must be a glob and not one literal name.
    expect(EMIT_GITIGNORE_TEMPLATE).toContain('cache.db.bak-*');
  });

  it('matches every cache file through real Git ignore semantics', () => {
    const emitDir = path.join(tempDir, '.emit');
    fs.mkdirSync(emitDir);
    ensureEmitGitignore(emitDir);

    // `git check-ignore` resolves the shipped patterns exactly as a clone would, so a typo surfaces here
    // instead of as a committed database months later. The temp directory is not itself a repository, and
    // outside one Git refuses the command rather than answering — hence the throwaway repo whose only
    // content is the file Emit wrote.
    fs.mkdirSync(tempRepoDir);
    execFileSync('git', ['init', '-q', tempRepoDir], { stdio: 'ignore' });
    fs.copyFileSync(path.join(emitDir, '.gitignore'), path.join(tempRepoDir, '.gitignore'));

    const isIgnored = (file: string): boolean => {
      fs.writeFileSync(path.join(tempRepoDir, file), 'x');
      const status = spawnSync('git', ['check-ignore', '-q', file], {
        cwd: tempRepoDir,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
      return status.status === 0;
    };

    for (const file of ['cache.db', 'cache.db-wal', 'cache.db-shm', 'cache.db.bak-20261119']) {
      expect(isIgnored(file), `${file} must be ignored`).toBe(true);
    }

    // config.json is safe to commit (tokens live in ~/.config/emit/profiles.yaml), so the template must not
    // swallow it — an over-broad rule would silently drop the workspace's own configuration.
    expect(isIgnored('config.json')).toBe(false);
  });

  it('never rewrites an existing file, byte for byte', () => {
    const emitDir = path.join(tempDir, '.emit');
    fs.mkdirSync(emitDir);
    const gitignorePath = path.join(emitDir, '.gitignore');
    const custom = '# written by the user\ncache.db\n';
    fs.writeFileSync(gitignorePath, custom, 'utf8');

    const result = ensureEmitGitignore(emitDir);
    expect(result.created).toBe(false);
    expect(fs.readFileSync(gitignorePath, 'utf8')).toBe(custom);
  });

  it('writes nothing outside .emit/', () => {
    initWorkspace(tempDir, { origin: 'https://aroooy.net' });
    // Repository-level Git policy stays the user's (X-1): Emit only ever writes inside `.emit/`.
    expect(fs.existsSync(path.join(tempDir, '.gitignore'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, '.emit', '.gitignore'))).toBe(true);
  });
});
