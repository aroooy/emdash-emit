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

/**
 * v0.1.38 P0 — characterization baseline.
 *
 * These snapshots pin the CURRENT observable behaviour of the surfaces v0.1.38 P1–P3 intend to change:
 * `emit profile list` / `profile current` output, the generated workspace file layout, and the doctor
 * report's check sequence. They are written before any behavior change lands, so a later diff shows
 * exactly which lines moved instead of hiding regressions inside new assertions.
 *
 * Nothing here claims the current spelling is desirable — `profile list` printing a bare `(active)`
 * while cwd-based resolution silently wins, and `initWorkspace` emitting no `.gitignore`, are precisely
 * the gaps P1/P3 fix. A snapshot update in those commits must be intentional and reviewed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { program } from '../src/bin/emit.js';
import { CacheDatabase } from '../src/db/cache.js';
import { runWorkspaceDoctor } from '../src/sync/doctor.js';
import { initWorkspace, loadConfig } from '../src/utils/config.js';
import { setProfile, setActiveProfile } from '../src/utils/profile.js';

/** Collapses the throwaway temp prefix so inline snapshots stay stable across machines. */
function scrubTempDir(text: string, dir: string): string {
  return text.split(dir).join('@TMPDIR@');
}

describe('v0.1.38 characterization: profile CLI output', () => {
  let homeDir: string;
  let workspaceDir: string;
  let originalHome: string | undefined;
  let originalCwd: string;

  const runCli = async (args: string[]): Promise<string> => {
    let printed = '';
    const originalLog = console.log;
    console.log = (...logArgs: unknown[]) => {
      printed += logArgs.map(String).join(' ') + '\n';
    };
    try {
      await program.parseAsync(['node', 'emit', ...args]);
    } finally {
      console.log = originalLog;
    }
    return printed;
  };

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-char-home-'));
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-char-ws-'));
    originalHome = process.env.HOME;
    originalCwd = process.cwd();
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('profile list labels the directory match and the active fallback separately', async () => {
    process.chdir(workspaceDir);
    setProfile('alpha', {
      origin: 'https://alpha.example.com',
      token: 'tok-alpha',
      workspace: path.join(workspaceDir, 'alpha-ws'),
    });
    setProfile('beta', { origin: 'https://beta.example.com', token: 'tok-beta' });
    // `active` is the LAST registered profile here and owns no directory, so it must read as a fallback
    // rather than as "the profile in use" — the ambiguity P1 removes.
    setActiveProfile('beta');

    const output = await runCli(['profile', 'list']);
    expect(scrubTempDir(output, workspaceDir)).toMatchInlineSnapshot(`
      "
      Configured profiles (a registered workspace matching the current directory always wins; "active" is only the fallback):
        - alpha
            origin:    https://alpha.example.com
            workspace: @TMPDIR@/alpha-ws
            token:     [configured]
        * beta (active default — used only outside registered workspaces)
            origin:    https://beta.example.com
            token:     [configured]

      "
    `);
  });

  it('profile list marks the profile that owns the current directory', async () => {
    const alphaWs = path.join(workspaceDir, 'alpha-ws');
    fs.mkdirSync(alphaWs);
    setProfile('alpha', {
      origin: 'https://alpha.example.com',
      token: 'tok-alpha',
      workspace: alphaWs,
    });
    setProfile('beta', { origin: 'https://beta.example.com', token: 'tok-beta' });
    setActiveProfile('beta');
    process.chdir(alphaWs);

    const output = await runCli(['profile', 'list']);
    expect(scrubTempDir(output, workspaceDir)).toMatchInlineSnapshot(`
      "
      Configured profiles (a registered workspace matching the current directory always wins; "active" is only the fallback):
        * alpha (matches current directory)
            origin:    https://alpha.example.com
            workspace: @TMPDIR@/alpha-ws
            token:     [configured]
        * beta (active default — used only outside registered workspaces)
            origin:    https://beta.example.com
            token:     [configured]

      "
    `);
  });

  it('profile current names the resolution path that chose the profile', async () => {
    // Two profiles, one of which owns the cwd. Resolution picks the workspace match, and P1 says so out
    // loud instead of leaving the user to guess whether a `profile use` is needed.
    const alphaWs = path.join(workspaceDir, 'alpha-ws');
    fs.mkdirSync(alphaWs);
    setProfile('alpha', {
      origin: 'https://alpha.example.com',
      token: 'tok-alpha',
      workspace: alphaWs,
    });
    setProfile('beta', { origin: 'https://beta.example.com', token: 'tok-beta' });
    process.chdir(alphaWs);

    const output = await runCli(['profile', 'current']);
    expect(scrubTempDir(output, workspaceDir)).toMatchInlineSnapshot(`
      "Active Profile: alpha
        Origin:       https://alpha.example.com
        Workspace:    @TMPDIR@/alpha-ws
        Resolved by:  current directory match (@TMPDIR@/alpha-ws)
      "
    `);
  });
});

describe('v0.1.38 characterization: initWorkspace generated files', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-char-init-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes .emit/.gitignore and nothing else — the SQLite cache is ignored (v0.1.38 P3)', () => {
    initWorkspace(tempDir, { origin: 'https://aroooy.net' });

    const emitted = fs.readdirSync(path.join(tempDir, '.emit')).sort();
    expect(emitted).toMatchInlineSnapshot(`
      [
        ".gitignore",
        "config.json",
      ]
    `);
    // This snapshot was flipped deliberately in P3: pre-v0.1.38 `.emit/` held only `config.json`, which is
    // how the cache database ended up committed. The repository-level file stays Emit's business — only the
    // one inside `.emit/` is ever written (X-1).
    expect(fs.existsSync(path.join(tempDir, '.gitignore'))).toBe(false);

    // The config key set is pinned so a merge-on-reinit (P2) cannot silently drop keys.
    const config = JSON.parse(fs.readFileSync(path.join(tempDir, '.emit', 'config.json'), 'utf8'));
    expect(Object.keys(config).sort()).toMatchInlineSnapshot(`
      [
        "concurrency",
        "createdWithVersion",
        "defaultCollection",
        "defaultLocale",
        "lastSyncedVersion",
        "localMediaRefs",
        "mediaSyncLimit",
        "origin",
        "postsSyncLimit",
      ]
    `);
  });

  it('reports a re-init as leaving an existing .gitignore untouched', () => {
    const first = initWorkspace(tempDir, { origin: 'https://aroooy.net' });
    expect(first.gitignoreCreated).toBe(true);

    // A repair run (`emit init --profile`, P2) must not rewrite the file a user may have edited.
    fs.appendFileSync(path.join(tempDir, '.emit', '.gitignore'), '# mine\n', 'utf8');
    const second = initWorkspace(tempDir, { origin: 'https://other.example.com' });
    expect(second.gitignoreCreated).toBe(false);
    expect(fs.readFileSync(path.join(tempDir, '.emit', '.gitignore'), 'utf8')).toContain('# mine');
  });

  it('re-running init preserves unrelated keys instead of overwriting config wholesale (v0.1.38 P2 fix)', () => {
    initWorkspace(tempDir, { origin: 'https://aroooy.net', postsSyncLimit: 250 });
    const configPath = path.join(tempDir, '.emit', 'config.json');

    // A key written by another code path (e.g. `persistLocalMediaRefs`) must survive a re-init: repair via
    // `emit init --profile` is the whole point of P2, and silently resetting limits/locale would make it a
    // destructive command. This snapshot was flipped deliberately in P2 — before that, re-init dropped it.
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    parsed.customMarker = 'must-survive-reinit';
    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf8');

    initWorkspace(tempDir, { origin: 'https://other.example.com' });
    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(after.customMarker).toBe('must-survive-reinit');
    expect(after.origin).toBe('https://other.example.com');
    // The previously written limit is kept too — only the keys named in `initialConfig` change.
    expect(loadConfig(tempDir).postsSyncLimit).toBe(250);
  });
});

describe('v0.1.38 characterization: doctor check sequence', () => {
  let tempDir: string;
  let cache: CacheDatabase;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-char-doctor-'));
    process.env.HOME = tempDir;
    initWorkspace(tempDir, { origin: 'https://aroooy.net' });
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('runs offline by default and reports the pre-v0.1.38 check order', async () => {
    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config: loadConfig(tempDir),
      profileName: 'default',
      profileOrigin: 'https://aroooy.net',
    });

    // Conditional checks (`sync_status`, `conflict_pending_*`, `taxonomy_apply_pending`, `delete_pending`
    // and `mcp_process`) are absent on a clean workspace, so this pins the unconditional spine. Note that
    // `media_references` lands last even though it is check 6: the media group is awaited after the
    // synchronous environment group, which owns checks 1, 2 and 7. Any new check must land in a known
    // position relative to these two.
    expect(report.checks.map((c) => c.id)).toMatchInlineSnapshot(`
      [
        "version_compatibility",
        "origin_consistency",
        "frontmatter_integrity",
        "conflicts_quarantine",
        "sync_status",
        "media_references",
      ]
    `);
    expect(report.overallStatus).toBe('healthy');
  });

  it('registers every subcommand and option that P1–P4 extend', () => {
    const profileCmd = program.commands.find((c) => c.name() === 'profile') as Command;
    expect(profileCmd.commands.map((c) => c.name()).sort()).toMatchInlineSnapshot(`
      [
        "add",
        "current",
        "list",
        "remove",
        "use",
      ]
    `);

    const doctorCmd = program.commands.find((c) => c.name() === 'doctor') as Command;
    expect(doctorCmd.options.map((o) => o.long).sort()).toMatchInlineSnapshot(`
      [
        "--check-media-library",
        "--check-media-urls",
        "--collection",
        "--profile",
        "--strict-media",
      ]
    `);
  });
});
