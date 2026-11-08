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
import { program } from '../src/bin/emit.js';
import { formatPullStatusBreakdown, formatPullWindowLabel } from '../src/cli/commands/pull.js';
import { resolveInitPlan } from '../src/cli/commands/status.js';
import { resolveOriginPriority } from '../src/cli/context.js';
import { DEFAULT_ORIGIN, initWorkspace } from '../src/utils/config.js';
import { loadProfilesFile, setProfile } from '../src/utils/profile.js';

describe('Emit CLI (Commander)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-cli-test-'));
    initWorkspace(tempDir, { origin: 'https://aroooy.net' });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('defines all required commands', () => {
    const commandNames = program.commands.map((c) => c.name());
    expect(commandNames).toContain('init');
    expect(commandNames).toContain('guide');
    expect(commandNames).toContain('new');
    expect(commandNames).toContain('status');
    expect(commandNames).toContain('diff');
    expect(commandNames).toContain('pull');
    expect(commandNames).toContain('push');
    expect(commandNames).toContain('delete');
    expect(commandNames).toContain('mcp');
    expect(commandNames).toContain('profile');
  });

  it('delete command exposes safety options', () => {
    const deleteCmd = program.commands.find((c) => c.name() === 'delete');
    expect(deleteCmd).toBeDefined();
    const optionNames = deleteCmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain('--allow-delete-published');
    expect(optionNames).toContain('--dry-run');
    expect(optionNames).toContain('--yes');
    expect(optionNames).toContain('--profile');
  });

  it('diff command exposes --id and --profile options', () => {
    const diffCmd = program.commands.find((c) => c.name() === 'diff');
    expect(diffCmd).toBeDefined();
    const optionNames = diffCmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain('--id');
    expect(optionNames).toContain('--profile');
  });

  it('new command exposes --byline option', () => {
    const newCmd = program.commands.find((c) => c.name() === 'new');
    expect(newCmd).toBeDefined();
    const optionNames = newCmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain('--byline');
  });

  it('push command description mentions auto-uploading media/drafts/* images', () => {
    const pushCmd = program.commands.find((c) => c.name() === 'push');
    expect(pushCmd).toBeDefined();
    expect(pushCmd?.description()).toContain('media/drafts/*');
  });

  it('pull command enforces window concept without --limit or --all options', () => {
    const pullCmd = program.commands.find((c) => c.name() === 'pull');
    expect(pullCmd).toBeDefined();
    const optionNames = pullCmd?.options.map((o) => o.long || o.short) || [];
    expect(optionNames).not.toContain('--limit');
    expect(optionNames).not.toContain('-l');
    expect(optionNames).not.toContain('--all');
  });

  it('pull command exposes unified sync options (--posts-only, --media, --metadata-only)', () => {
    const pullCmd = program.commands.find((c) => c.name() === 'pull');
    expect(pullCmd).toBeDefined();
    const optionNames = pullCmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain('--posts-only');
    expect(optionNames).toContain('--media');
    expect(optionNames).toContain('--metadata-only');
  });

  it('executes emit guide cleanly', () => {
    const guideCmd = program.commands.find((c) => c.name() === 'guide');
    expect(guideCmd).toBeDefined();
  });
  it('formats profile command failures as one actionable line instead of a raw stack trace', async () => {
    // Profile subcommands read/write ~/.config/emit/profiles.yaml, so point HOME at a throwaway
    // directory; os.homedir() prefers process.env.HOME on POSIX.
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-cli-home-'));
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;

    const errLines: string[] = [];
    const originalError = console.error;
    const originalExit = process.exit;
    const EXIT_SENTINEL = Symbol('emit-test-exit');
    let exitCode: number | undefined;

    const runCli = async (args: string[]) => {
      exitCode = undefined;
      errLines.length = 0;
      try {
        await program.parseAsync(['node', 'emit', ...args]);
      } catch (error) {
        if (error !== EXIT_SENTINEL) throw error;
      }
    };

    console.error = (...args: unknown[]) => {
      errLines.push(args.map(String).join(' '));
    };
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw EXIT_SENTINEL;
    }) as typeof process.exit;

    try {
      await runCli(['profile', 'use', 'ghost']);
      expect(exitCode).toBe(1);
      expect(errLines.join('\n')).toContain('❌ Profile "ghost" not found');
      expect(errLines.join('\n')).not.toContain('    at ');

      await runCli(['profile', 'remove', 'ghost']);
      expect(exitCode).toBe(1);
      expect(errLines.join('\n')).toContain('❌ Profile "ghost" does not exist.');
      expect(errLines.join('\n')).not.toContain('    at ');

      // Two profiles, neither matching the current directory: "current" must report the ambiguity.
      setProfile('site-a', { origin: 'https://site-a.example.com', token: 'tok-a' });
      setProfile('site-b', { origin: 'https://site-b.example.com', token: 'tok-b' });
      await runCli(['profile', 'current']);
      expect(exitCode).toBe(1);
      expect(errLines.join('\n')).toContain('❌ Multiple profiles are configured');
      expect(errLines.join('\n')).toContain('site-a');
      expect(errLines.join('\n')).not.toContain('    at ');
    } finally {
      console.error = originalError;
      process.exit = originalExit;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('profile add preserves an existing token and workspace link when those options are omitted', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-cli-home-'));
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;

    const logLines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    };

    try {
      const run = async (...args: string[]) => {
        logLines.length = 0;
        await program.parseAsync(['node', 'emit', 'profile', 'add', ...args]);
      };

      await run(
        'demo',
        '--origin',
        'https://old.example.com',
        '--token',
        'tok-secret',
        '--workspace',
        '/tmp/emit-ws-1',
      );
      let profile = loadProfilesFile().profiles['demo'];
      expect(profile.token).toBe('tok-secret');
      expect(profile.workspace).toBe('/tmp/emit-ws-1');

      // Re-running add to change only the origin must not silently wipe credentials or the
      // workspace link that "emit init" established.
      await run('demo', '--origin', 'https://new.example.com');
      profile = loadProfilesFile().profiles['demo'];
      expect(profile.origin).toBe('https://new.example.com');
      expect(profile.token).toBe('tok-secret');
      expect(profile.workspace).toBe('/tmp/emit-ws-1');
      expect(logLines.join('\n')).toContain('updated');
      expect(logLines.join('\n')).toContain('Kept the existing token and workspace link');

      // Explicit flags always win.
      await run(
        'demo',
        '--origin',
        'https://new.example.com',
        '--token',
        'tok-rotated',
        '--workspace',
        '/tmp/emit-ws-2',
      );
      profile = loadProfilesFile().profiles['demo'];
      expect(profile.token).toBe('tok-rotated');
      expect(profile.workspace).toBe('/tmp/emit-ws-2');
      expect(logLines.join('\n')).not.toContain('Kept the existing');

      // An explicit empty --token is honored as an intentional clear.
      await run('demo', '--origin', 'https://new.example.com', '--token', '');
      profile = loadProfilesFile().profiles['demo'];
      expect(profile.token).toBe('');
    } finally {
      console.log = originalLog;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('resolveInitPlan inherits profile origin and enforces 3-guard auto-link rules', () => {
    const baseProfile = {
      name: 'aroooy.net',
      source: 'single' as const,
      config: {
        origin: 'https://aroooy.net',
        token: 'pat_123',
      },
    };

    // Default: inherits origin from profile and links workspace when unset
    expect(resolveInitPlan({}, baseProfile)).toEqual({
      effectiveOrigin: 'https://aroooy.net',
      shouldLinkProfile: true,
      warning: null,
    });

    // Guard 1: --no-link (options.link === false) prevents linking
    expect(resolveInitPlan({ link: false }, baseProfile)).toEqual({
      effectiveOrigin: 'https://aroooy.net',
      shouldLinkProfile: false,
      warning: null,
    });

    // Guard 2: profile already has a workspace configured -> do not overwrite
    expect(
      resolveInitPlan(
        {},
        {
          ...baseProfile,
          config: { ...baseProfile.config, workspace: '/existing/ws' },
        },
      ),
    ).toEqual({
      effectiveOrigin: 'https://aroooy.net',
      shouldLinkProfile: false,
      warning: null,
    });

    // Guard 3: explicit --origin differs from resolved profile origin -> do not link to wrong profile
    expect(resolveInitPlan({ origin: 'https://other.example.com' }, baseProfile)).toEqual({
      effectiveOrigin: 'https://other.example.com',
      shouldLinkProfile: false,
      warning: null,
    });

    // No profile resolved -> falls back to envOrigin and does not link
    expect(resolveInitPlan({}, null, 'https://env.example.com')).toEqual({
      effectiveOrigin: 'https://env.example.com',
      shouldLinkProfile: false,
      warning: null,
    });

    // Trailing-slash-only difference still counts as a match (link allowed, silent)
    expect(
      resolveInitPlan(
        { origin: 'https://aroooy.net/' },
        { ...baseProfile, config: { ...baseProfile.config, origin: 'https://aroooy.net' } },
      ),
    ).toEqual({
      effectiveOrigin: 'https://aroooy.net/',
      shouldLinkProfile: true,
      warning: null,
    });
  });

  it('formats pull window label (N/status for all) and status breakdown accurately', () => {
    expect(formatPullWindowLabel('all', 100)).toBe('100/status');
    expect(formatPullWindowLabel('published', 100)).toBe('100');
    expect(formatPullWindowLabel('draft', 50)).toBe('50');

    const sampleItems = [
      { status: 'published' },
      { status: 'published' },
      { status: 'draft' },
      { status: 'published', deleted: true },
    ];
    expect(formatPullStatusBreakdown('all', sampleItems)).toBe(' [2 published, 1 draft]');
    expect(formatPullStatusBreakdown('published', sampleItems)).toBe('');
  });

  it('resolveOriginPriority ranks sources and surfaces every override as a warning', () => {
    // Same origin (ignoring trailing slash) -> no warning
    expect(
      resolveOriginPriority({
        configuredOrigin: 'https://aroooy.net/',
        autoProfileOrigin: 'https://aroooy.net',
        autoProfileName: 'aroooy.net',
      }),
    ).toEqual({ origin: 'https://aroooy.net', warning: null });

    // Auto-resolved profile differs from workspace .emit/config.json origin -> emits warning
    const autoWarn = resolveOriginPriority({
      configuredOrigin: 'https://other.example.com',
      autoProfileOrigin: 'https://solo.example.com',
      autoProfileName: 'solo',
    });
    expect(autoWarn.origin).toBe('https://solo.example.com');
    expect(autoWarn.warning).toContain('https://other.example.com');
    expect(autoWarn.warning).toContain('"solo"');
    expect(autoWarn.warning).toContain('https://solo.example.com');

    // EMDASH_ORIGIN outranks an auto-resolved profile (CI / staging override must take effect)
    const envWarn = resolveOriginPriority({
      envOrigin: 'https://staging.example.com',
      configuredOrigin: 'https://aroooy.net',
      autoProfileOrigin: 'https://aroooy.net',
      autoProfileName: 'aroooy.net',
    });
    expect(envWarn.origin).toBe('https://staging.example.com');
    expect(envWarn.warning).toContain('EMDASH_ORIGIN (https://staging.example.com)');
    expect(envWarn.warning).toContain('https://aroooy.net');
    // The warning names the real source: never labels the env value as config.json content.
    expect(envWarn.warning).not.toContain('.emit/config.json origin (https://staging.example.com)');

    // EMDASH_ORIGIN matching the profile -> override is not a conflict, so stay silent
    expect(
      resolveOriginPriority({
        envOrigin: 'https://aroooy.net',
        configuredOrigin: 'https://aroooy.net',
        autoProfileOrigin: 'https://aroooy.net/',
        autoProfileName: 'aroooy.net',
      }).warning,
    ).toBeNull();

    // Explicit --profile outranks EMDASH_ORIGIN, but the ignored override is reported
    const explicitWarn = resolveOriginPriority({
      explicitProfileName: 'solo',
      explicitProfileOrigin: 'https://solo.example.com',
      envOrigin: 'https://staging.example.com',
    });
    expect(explicitWarn.origin).toBe('https://solo.example.com');
    expect(explicitWarn.warning).toContain(
      'EMDASH_ORIGIN (https://staging.example.com) is ignored',
    );

    // Explicit --profile with no conflict -> no warning
    expect(
      resolveOriginPriority({
        explicitProfileName: 'solo',
        explicitProfileOrigin: 'https://solo.example.com',
        configuredOrigin: 'https://solo.example.com',
      }).warning,
    ).toBeNull();

    // No profile/env -> auth origin, then workspace config, then the sentinel default
    expect(
      resolveOriginPriority({ authOrigin: 'https://auth.example.com', configuredOrigin: undefined })
        .origin,
    ).toBe('https://auth.example.com');
    expect(resolveOriginPriority({ configuredOrigin: 'https://cfg.example.com' }).origin).toBe(
      'https://cfg.example.com',
    );
    expect(resolveOriginPriority({}).origin).toBe(DEFAULT_ORIGIN);
  });

  it('emit init ranks EMDASH_ORIGIN above the auto-resolved profile and skips mismatched linking', () => {
    const baseProfile = {
      name: 'aroooy.net',
      source: 'single' as const,
      config: { origin: 'https://aroooy.net', token: 'pat_123' },
    };

    // EMDASH_ORIGIN overrides the auto-resolved profile, so linking to it would be wrong
    const envOverride = resolveInitPlan({}, baseProfile, 'https://staging.example.com');
    expect(envOverride.effectiveOrigin).toBe('https://staging.example.com');
    expect(envOverride.shouldLinkProfile).toBe(false);
    expect(envOverride.warning).toContain('EMDASH_ORIGIN (https://staging.example.com)');
    expect(envOverride.warning).toContain('https://aroooy.net');
    expect(envOverride.warning).toContain('"aroooy.net"');

    // EMDASH_ORIGIN matching the profile keeps the auto-link behaviour (silent)
    expect(resolveInitPlan({}, baseProfile, 'https://aroooy.net')).toEqual({
      effectiveOrigin: 'https://aroooy.net',
      shouldLinkProfile: true,
      warning: null,
    });
    expect(resolveInitPlan({}, baseProfile, 'https://aroooy.net/').shouldLinkProfile).toBe(true);

    // Explicit --origin still outranks EMDASH_ORIGIN (deliberate, so no warning)
    expect(
      resolveInitPlan(
        { origin: 'https://manual.example.com' },
        baseProfile,
        'https://env.example.com',
      ),
    ).toEqual({
      effectiveOrigin: 'https://manual.example.com',
      shouldLinkProfile: false,
      warning: null,
    });
  });
});
