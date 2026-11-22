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

import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import { program } from '../src/bin/emit.js';
import { formatPullStatusBreakdown, formatPullWindowLabel } from '../src/cli/commands/pull.js';
import { readSecretLine, readTokenFromStdin } from '../src/cli/commands/profile.js';
import {
  registerStatusInitCommands,
  resolveInitPlan,
  resolveInitRelink,
} from '../src/cli/commands/status.js';
import { resolveOriginPriority, resolveExplicitBooleanOption } from '../src/cli/context.js';
import { createCliContextResolver } from '../src/cli/context.js';
import { DEFAULT_ORIGIN, initWorkspace } from '../src/utils/config.js';
import { CacheDatabase } from '../src/db/cache.js';
import { loadProfilesFile, setProfile } from '../src/utils/profile.js';

describe('Emit CLI (Commander)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-cli-test-'));
    initWorkspace(tempDir, { origin: 'https://aroooy.net' });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
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
    expect(commandNames).toContain('conflicts');
    expect(commandNames).toContain('doctor');
    expect(commandNames).toContain('mcp');
    expect(commandNames).toContain('profile');
    expect(commandNames).toContain('media-search');
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

  it('pull-media command exposes targeted --article option for media optimization (Phase 4)', () => {
    const pullMediaCmd = program.commands.find((c) => c.name() === 'pull-media');
    expect(pullMediaCmd).toBeDefined();
    const optionNames = pullMediaCmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain('--article');
    expect(optionNames).toContain('--all');
    const allOpt = pullMediaCmd?.options.find((o) => o.long === '--all');
    expect(allOpt).toBeDefined();
    expect(allOpt?.description).toContain('maintenance only');
    expect(optionNames).toContain('--limit');
    expect(optionNames).toContain('--prune');
    expect(optionNames).toContain('--no-prune');
    expect(optionNames).toContain('--metadata-only');
    expect(optionNames).toContain('--profile');
  });

  it('doctor command exposes --check-media-library so library coverage is measurable locally', () => {
    const doctorCmd = program.commands.find((c) => c.name() === 'doctor');
    expect(doctorCmd).toBeDefined();
    const optionNames = doctorCmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain('--check-media-urls');
    expect(optionNames).toContain('--check-media-library');
    const libOpt = doctorCmd?.options.find((o) => o.long === '--check-media-library');
    expect(libOpt?.description).toContain('metadata only');
    expect(libOpt?.description).toContain('no binary downloads');
  });

  /**
   * v0.1.38 P4-B — T4-4: the auth probe must be discoverable as an opt-in, because a doctor that reaches the
   * network by default would break the offline-by-default contract every other check depends on.
   */
  it('doctor command exposes --check-auth and states that it is opt-in', () => {
    const doctorCmd = program.commands.find((c) => c.name() === 'doctor');
    expect(doctorCmd).toBeDefined();
    const optionNames = doctorCmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain('--check-auth');

    const authOpt = doctorCmd?.options.find((o) => o.long === '--check-auth');
    expect(authOpt?.description).toContain('Opt-in');
    expect(authOpt?.description).toContain('plain doctor stays offline without this flag');
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

  it('emit guide action prints the two media ID spaces and points at the specification document', async () => {
    const cwd = process.cwd();
    process.chdir(tempDir);
    // Vitest's console spy records nothing for output produced inside a commander action, so capture
    // by direct reassignment. A fresh probe program is required because commander caches parsed argv
    // on the shared `program` instance, making a second parseAsync() a no-op.
    let printed = '';
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      printed += args.map(String).join(' ') + '\n';
    };
    try {
      const probe = new Command();
      registerStatusInitCommands(probe, () => {
        throw new Error('guide must not resolve a workspace context');
      });
      await probe.parseAsync(['node', 'emit', 'guide']);
    } finally {
      console.log = originalLog;
      process.chdir(cwd);
    }
    expect(printed).toContain('docs/media-id-spaces.md');
    expect(printed).toContain('storageKey');
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

  /**
   * v0.1.38 P4-A — T4-1: `emit profile set-token` replaces only the token, so rotating a credential must not
   * disturb the origin or workspace link that carry the site identity. The stdout assertions are the security
   * half of the test: neither the old nor the new secret may appear in any printed line.
   */
  describe('profile set-token (v0.1.38 P4-A)', () => {
    let homeDir: string;
    let originalHome: string | undefined;
    const logLines: string[] = [];
    const errLines: string[] = [];

    beforeEach(() => {
      homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emit-set-token-home-')));
      originalHome = process.env.HOME;
      process.env.HOME = homeDir;
      vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    });

    afterEach(() => {
      console.log = originalLog;
      console.error = originalError;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      vi.restoreAllMocks();
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    const originalLog = console.log;
    const originalError = console.error;

    const runCli = async (args: string[]) => {
      logLines.length = 0;
      errLines.length = 0;
      console.log = (...a: unknown[]) => logLines.push(a.map(String).join(' '));
      console.error = (...a: unknown[]) => errLines.push(a.map(String).join(' '));
      await program.parseAsync(['node', 'emit', ...args]);
    };

    it('replaces only the token, keeping origin and workspace link', async () => {
      setProfile('demo', {
        origin: 'https://demo.example.com',
        token: 'tok-old',
        workspace: '/tmp/emit-ws-1',
      });

      await runCli(['profile', 'set-token', 'demo', '--token', 'tok-new']);

      const profile = loadProfilesFile().profiles['demo'];
      expect(profile.token).toBe('tok-new');
      expect(profile.origin).toBe('https://demo.example.com');
      expect(profile.workspace).toBe('/tmp/emit-ws-1');

      const printed = [...logLines, ...errLines].join('\n');
      expect(printed).toContain('Token updated for profile "demo"');
      // The overwrite is announced before the write so a wrong-profile habit is visible, but no value is quoted.
      expect(printed).toContain('Replaces the existing token');
      expect(printed).not.toContain('tok-old');
      expect(printed).not.toContain('tok-new');
    });

    it('honors an explicit empty --token as an intentional clear', async () => {
      setProfile('demo', { origin: 'https://demo.example.com', token: 'tok-old' });

      await runCli(['profile', 'set-token', 'demo', '--token', '']);

      // The written YAML carries no `token:` key at all (`saveProfilesFile` drops an empty one), and
      // `loadProfilesFile()` normalizes the absent field to '' — which is what makes every later auth path
      // fall through to the environment instead of sending a blank bearer.
      expect(loadProfilesFile().profiles['demo'].token).toBe('');
      const rawProfiles = yaml.load(
        fs.readFileSync(path.join(homeDir, '.config/emit/profiles.yaml'), 'utf8'),
      ) as {
        profiles: Record<string, Record<string, string>>;
      };
      expect(rawProfiles.profiles['demo']).not.toHaveProperty('token');
      const printed = [...logLines, ...errLines].join('\n');
      expect(printed).toContain('Token cleared for profile "demo"');
      expect(printed).not.toContain('tok-old');
    });

    it('rejects an unknown profile name with one actionable line', async () => {
      const originalExit = process.exit;
      const EXIT_SENTINEL = Symbol('emit-test-exit');
      let exitCode: number | undefined;
      process.exit = ((code?: number) => {
        exitCode = code ?? 0;
        throw EXIT_SENTINEL;
      }) as typeof process.exit;

      try {
        try {
          await runCli(['profile', 'set-token', 'ghost', '--token', 'tok-x']);
        } catch (error) {
          if (error !== EXIT_SENTINEL) throw error;
        }
        expect(exitCode).toBe(1);
        expect(errLines.join('\n')).toContain('❌ Profile "ghost" not found');
        expect(errLines.join('\n')).not.toContain('    at ');
      } finally {
        process.exit = originalExit;
      }
    });

    it('reads the token from a piped stdin without echoing it', async () => {
      setProfile('demo', { origin: 'https://demo.example.com', token: 'tok-old' });

      // `--stdin` is what makes keychain piping and CI work; the value never reaches argv, so shell history
      // stays clean, and it must not surface in the command output either. The action reads process.stdin,
      // so the pipe is installed there for the duration of the call.
      const originalStdin = process.stdin;
      Object.defineProperty(process, 'stdin', {
        value: Readable.from(['tok-piped\n']),
        configurable: true,
      });
      try {
        await runCli(['profile', 'set-token', 'demo', '--stdin']);
      } finally {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
      }

      expect(loadProfilesFile().profiles['demo'].token).toBe('tok-piped');
      const printed = [...logLines, ...errLines].join('\n');
      expect(printed).toContain('Token updated for profile "demo"');
      expect(printed).not.toContain('tok-piped');
      expect(printed).not.toContain('tok-old');
    });

    it('prefers an explicit --token over --stdin when both are given', async () => {
      setProfile('demo', { origin: 'https://demo.example.com', token: 'tok-old' });

      // A flag the user typed is the more specific intent than a pipe that may be left attached by a wrapper
      // script, so precedence order decides — never the arrival order of the two sources.
      const originalStdin = process.stdin;
      Object.defineProperty(process, 'stdin', {
        value: Readable.from(['tok-from-pipe\n']),
        configurable: true,
      });
      try {
        await runCli(['profile', 'set-token', 'demo', '--stdin', '--token', 'tok-flag']);
      } finally {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
      }

      expect(loadProfilesFile().profiles['demo'].token).toBe('tok-flag');
    });

    it('fails an empty pipe instead of blanking the credential', async () => {
      const piped = Readable.from(['   \n']) as unknown as NodeJS.ReadStream;
      await expect(readTokenFromStdin(piped)).rejects.toThrow(/Nothing was piped into --stdin/);
    });

    /**
     * T4-2: the terminal must come back exactly as it was found. A process that leaves raw mode on breaks
     * the user's shell for the rest of the session, so both the enable and the restore are asserted against a
     * fake stream rather than inferred from the code path — including the case where the read itself fails.
     */
    function fakeTtyStdin(chunks: string[]) {
      const calls: Array<'on' | 'restore'> = [];
      let rawMode = false;
      const stdin = Readable.from(chunks) as unknown as NodeJS.ReadStream & {
        isTTY?: boolean;
        isRaw?: boolean;
        setRawMode?: (mode: boolean) => void;
      };
      stdin.isTTY = true;
      stdin.isRaw = false;
      stdin.setRawMode = (mode: boolean) => {
        rawMode = mode;
        calls.push(mode ? 'on' : 'restore');
        return stdin;
      };
      return { stdin, calls, wasRawMode: () => rawMode };
    }

    it('masks input on a TTY and restores the terminal state afterwards', async () => {
      const tty = fakeTtyStdin(['tok-typed\n']);
      const out: string[] = [];
      const stdout = new Writable({
        write(chunk, _enc, cb) {
          out.push(String(chunk));
          cb();
        },
      }) as unknown as NodeJS.WriteStream;

      const token = await readSecretLine('Token: ', { stdin: tty.stdin, stdout });

      expect(token).toBe('tok-typed');
      // Echo was disabled for the read and re-enabled afterwards — never left on.
      expect(tty.calls).toEqual(['on', 'restore']);
      expect(tty.wasRawMode()).toBe(false);
    });

    it('restores the terminal when an interrupted read closes stdin', async () => {
      // Ctrl-C during the prompt: the CLI installs no SIGINT handler of its own, so Node raises the default one
      // and the process dies. An abandoned readline promise therefore never settles — which is precisely why the
      // restore cannot be written as a `finally` block around the await; it has to run the moment the stream
      // ends. This test drives that path: the prompt is interrupted while live, and the terminal must already be
      // back in cooked mode when the stream closes.
      const stdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream & {
        isTTY?: boolean;
        isRaw?: boolean;
        setRawMode?: (mode: boolean) => void;
      };
      stdin.isTTY = true;
      stdin.isRaw = false;
      const rawModes: boolean[] = [];
      stdin.setRawMode = (mode: boolean) => {
        rawModes.push(mode);
        stdin.isRaw = mode;
        return stdin;
      };

      const stdout = new Writable({
        write(_chunk, _enc, cb) {
          cb();
        },
      }) as unknown as NodeJS.WriteStream;

      const closed = new Promise<void>((resolve) => stdin.once('close', () => resolve()));
      // readline attaches synchronously inside createInterface, so this interrupt lands on a live prompt
      // rather than arriving before the read starts.
      queueMicrotask(() => stdin.destroy());

      void readSecretLine('Token: ', { stdin, stdout });
      await closed;

      expect(rawModes[0]).toBe(true);
      expect(stdin.isRaw).toBe(false);
    });

    it('refuses an interactive prompt when stdin is not readable instead of hanging', async () => {
      const stdin = Readable.from([]) as unknown as NodeJS.ReadStream;
      Object.defineProperty(stdin, 'readable', { value: false });
      await expect(readSecretLine('Token: ', { stdin })).rejects.toThrow(
        /No input available for the token prompt/,
      );
    });

    it('registers set-token with --token and --stdin', () => {
      const profileCmd = program.commands.find((c) => c.name() === 'profile') as Command;
      const setToken = profileCmd.commands.find((c) => c.name() === 'set-token');
      expect(setToken).toBeDefined();
      expect(setToken?.registeredArguments.map((a) => a.name())).toEqual(['name']);
      expect(setToken?.options.map((o) => o.long)).toContain('--token');
      expect(setToken?.options.map((o) => o.long)).toContain('--stdin');
    });
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
  /**
   * v0.1.38 P2 — T2-3: the re-link decision that lets `emit init --profile` repair a moved folder, without
   * weakening `resolveInitPlan()`'s original guards. The drift case only ever arises for a profile the user
   * named explicitly, so an auto-resolved profile that already carries a workspace must still be left alone.
   */
  it('re-links only an explicitly named drifted profile, never an auto-resolved one', () => {
    const drifted = {
      profileName: 'aroooy.net',
      registeredWorkspace: '/old/location/my-blog',
      actualWorkspace: '/new/location/my-blog',
    };
    const explicitDrifted = {
      name: 'aroooy.net',
      source: 'explicit' as const,
      config: {
        origin: 'https://aroooy.net',
        token: 'pat_123',
        workspace: '/old/location/my-blog',
      },
    };

    // The repair case: naming the profile is the intent, so its stale link moves here.
    expect(resolveInitRelink({}, explicitDrifted, drifted)).toBe(true);
    // --no-link still outranks everything.
    expect(resolveInitRelink({ link: false }, explicitDrifted, drifted)).toBe(false);

    // An auto-resolved profile that already owns a workspace is not the one being repaired — guard 2 holds.
    const autoLinked = { ...explicitDrifted, source: 'workspace' as const };
    expect(resolveInitRelink({}, autoLinked, drifted)).toBe(false);
    // No drift and no existing link keeps the original auto-link behaviour.
    expect(
      resolveInitRelink(
        {},
        {
          name: 'aroooy.net',
          source: 'single',
          config: { origin: 'https://aroooy.net', token: 't' },
        },
        null,
      ),
    ).toBe(true);
    // Nothing resolved, nothing to link.
    expect(resolveInitRelink({}, null, drifted)).toBe(false);
  });

  /**
   * v0.1.38 P2 — T2-3 (end-to-end): `emit init --profile <name>` must be a non-destructive repair for a moved
   * workspace folder. The pre-v0.1.38 behaviour is pinned in the characterization suite, where re-init dropped
   * keys written elsewhere; this asserts the opposite — every unrelated key and `createdWithVersion` survive,
   * only `origin` changes, and the profile link follows. `--no-link` must still refuse to touch the link even
   * when a drift is present, because an explicit refusal outranks the repair.
   *
   * HOME points at a throwaway directory so the machine-level profiles.yaml cannot leak into resolution:
   * without that isolation a developer's own registered workspace would decide these outcomes on some machines.
   */
  it('emit init --profile re-links a drifted profile and preserves unrelated config keys', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-init-home-'));
    const originalHome = process.env.HOME;
    const originalCwd = process.cwd();
    process.env.HOME = homeDir;
    // `init` writes profiles through the default path, so homedir must be pinned for this to be hermetic.
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);

    const workspaceDir = path.join(tempDir, 'moved-blog');
    fs.mkdirSync(workspaceDir, { recursive: true });
    initWorkspace(workspaceDir, { origin: 'https://aroooy.net' });

    // A key written by another code path (e.g. `persistLocalMediaRefs`) plus a non-default limit and the
    // version that first created this workspace — all of them must survive the repair.
    const configPath = path.join(workspaceDir, '.emit', 'config.json');
    const seeded = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    seeded.createdWithVersion = '0.1.30';
    seeded.postsSyncLimit = 250;
    seeded.localMediaRefs = false;
    seeded.customMarker = 'must-survive-reinit';
    fs.writeFileSync(configPath, JSON.stringify(seeded, null, 2), 'utf8');

    const profilesPath = path.join(homeDir, '.config', 'emit', 'profiles.yaml');
    fs.mkdirSync(path.dirname(profilesPath), { recursive: true });
    setProfile(
      'a',
      {
        origin: 'https://new.example.com',
        token: 'pat_keep_me',
        workspace: path.join(tempDir, 'old-location', 'my-blog'),
      },
      false,
      profilesPath,
    );

    const logLines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    };
    // The throwaway HOME is removed in `finally`, so the profiles.yaml content must be captured while it exists.
    let profilesYaml = '';
    try {
      process.chdir(workspaceDir);
      await program.parseAsync(['node', 'emit', 'init', '--profile', 'a']);
      profilesYaml = fs.readFileSync(profilesPath, 'utf8');
    } finally {
      console.log = originalLog;
      process.chdir(originalCwd);
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(homeDir, { recursive: true, force: true });
    }

    const printed = logLines.join('\n');
    expect(printed).toContain('Re-linked profile "a"');

    // The link now points at the folder actually being operated on. `init` stores the resolved cwd, which
    // differs from the raw `/var/...` temp path on macOS (`/private/var/...`), so both sides go through realpath.
    const profiles = yaml.load(profilesYaml) as {
      profiles: Record<string, { workspace?: string; token?: string }>;
    };
    expect(profiles.profiles.a.workspace).toBe(fs.realpathSync(workspaceDir));
    // Credentials and origin are carried over, never dropped by a re-link.
    expect(profiles.profiles.a.token).toBe('pat_keep_me');

    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(after.origin).toBe('https://new.example.com');
    expect(after.createdWithVersion).toBe('0.1.30');
    expect(after.postsSyncLimit).toBe(250);
    expect(after.localMediaRefs).toBe(false);
    expect(after.customMarker).toBe('must-survive-reinit');
  });

  it('emit init --profile --no-link leaves a drifted link untouched', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-init-nolink-home-'));
    const originalHome = process.env.HOME;
    const originalCwd = process.cwd();
    process.env.HOME = homeDir;
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);

    const workspaceDir = path.join(tempDir, 'nolink-blog');
    fs.mkdirSync(workspaceDir, { recursive: true });
    initWorkspace(workspaceDir, { origin: 'https://aroooy.net' });

    const stalePath = path.join(tempDir, 'old-location', 'my-blog');
    const profilesPath = path.join(homeDir, '.config', 'emit', 'profiles.yaml');
    fs.mkdirSync(path.dirname(profilesPath), { recursive: true });
    setProfile(
      'a',
      { origin: 'https://new.example.com', token: 'pat_keep_me', workspace: stalePath },
      false,
      profilesPath,
    );

    const originalLog = console.log;
    console.log = () => {};
    let profilesYaml = '';
    try {
      process.chdir(workspaceDir);
      await program.parseAsync(['node', 'emit', 'init', '--profile', 'a', '--no-link']);
      profilesYaml = fs.readFileSync(profilesPath, 'utf8');
    } finally {
      console.log = originalLog;
      process.chdir(originalCwd);
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(homeDir, { recursive: true, force: true });
    }

    // Explicit refusal outranks the repair: the registered path is exactly as stale as before. The stale
    // path is registered verbatim (it never exists on disk), so it needs no realpath normalization.
    const profiles = yaml.load(profilesYaml) as {
      profiles: Record<string, { workspace?: string }>;
    };
    expect(profiles.profiles.a.workspace).toBe(stalePath);
  });

  describe('workspace link drift warning (v0.1.38 P2)', () => {
    let homeDir: string;
    let originalHome: string | undefined;
    let originalCwd: string;

    beforeEach(() => {
      homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-drift-home-'));
      originalHome = process.env.HOME;
      originalCwd = process.cwd();
      process.env.HOME = homeDir;
      // `os.homedir()` does not reliably follow `process.env.HOME` on every platform, so it is pinned too.
      // That isolation is what keeps a developer's own machine-level profiles.yaml out of these resolutions:
      // an ambient registration would otherwise decide the drift outcome on some machines only.
      vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    });

    afterEach(() => {
      process.chdir(originalCwd);
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      vi.restoreAllMocks();
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    function resolveWithCapturedWarnings(cwd: string): string {
      const warnLines: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnLines.push(args.map(String).join(' '));
      };
      try {
        process.chdir(cwd);
        createCliContextResolver()(undefined, { optionalAuth: true });
      } finally {
        console.warn = originalWarn;
      }
      return warnLines.join('\n');
    }

    it('warns when a profile workspace link has drifted after a folder move', () => {
      const workspaceDir = path.join(tempDir, 'moved-blog');
      fs.mkdirSync(workspaceDir, { recursive: true });
      initWorkspace(workspaceDir, { origin: 'https://aroooy.net' });

      // Registered to a path that no longer exists — the folder moved into `moved-blog`.
      setProfile('aroooy.net', {
        origin: 'https://aroooy.net',
        token: 'test-token',
        workspace: path.join(tempDir, 'old-location', 'my-blog'),
      });

      const warning = resolveWithCapturedWarnings(workspaceDir);
      expect(warning).toContain('Profile "aroooy.net" is registered to');
      expect(warning).toContain(path.join(tempDir, 'old-location', 'my-blog'));
      expect(warning).toContain(workspaceDir);
      // Points at the one command that can repair it.
      expect(warning).toContain('emit init --profile aroooy.net');
    });

    it('stays silent when the profile link matches, including from a nested directory', () => {
      initWorkspace(tempDir, { origin: 'https://aroooy.net' });
      setProfile('aroooy.net', {
        origin: 'https://aroooy.net',
        token: 'test-token',
        workspace: tempDir,
      });

      // Running from posts/draft inside the linked workspace is normal, not drift.
      const warning = resolveWithCapturedWarnings(path.join(tempDir, 'posts', 'draft'));
      expect(warning).not.toContain('is registered to');
    });
  });

  it('formats new and delete command failures cleanly without raw stack traces (Major 1 & 2)', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-cli-home-'));
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;

    const configDir = path.join(homeDir, '.config', 'emit');
    fs.mkdirSync(configDir, { recursive: true });
    setProfile(
      'default',
      {
        origin: 'https://aroooy.net',
        token: 'test-token',
        workspace: tempDir,
      },
      true,
      path.join(configDir, 'profiles.yaml'),
    );

    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const originalCwd = process.cwd();
    process.chdir(tempDir);

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
      // 1. Create initial article
      await runCli(['new', 'duplicate-cli-test']);
      expect(exitCode).toBeUndefined();
      // emit new must be completely offline / zero-communication
      expect(fetchMock).not.toHaveBeenCalled();

      // 2. emit new with duplicate slug must report clean error without stack trace
      await runCli(['new', 'duplicate-cli-test']);
      expect(exitCode).toBe(1);
      const newErr = errLines.join('\n');
      expect(newErr).toContain(
        "Conflict: An article with slug 'duplicate-cli-test' already exists!",
      );
      expect(newErr).not.toContain('    at ');
      expect(newErr).not.toContain('file://');

      // 3. emit delete on non-existent article must report clean error without stack trace
      await runCli(['delete', 'non-existent-target.md', '--yes']);
      expect(exitCode).toBe(1);
      const delErr = errLines.join('\n');
      expect(delErr).toContain('Local file not found: non-existent-target.md');
      expect(delErr).not.toContain('    at ');
      expect(delErr).not.toContain('file://');

      // 4. emit push on invalid frontmatter must report clean error without stack trace (D4)
      const brokenFilePath = path.join(tempDir, 'posts', 'draft', '20261109_01M6TEST-broken.md');
      fs.writeFileSync(brokenFilePath, '---\n:::invalid yaml:::\n---\nbody\n', 'utf8');
      await runCli(['push', brokenFilePath]);
      expect(exitCode).toBe(1);
      const pushErr = errLines.join('\n');
      expect(pushErr).toContain('Error:');
      expect(pushErr).not.toContain('    at ');
      expect(pushErr).not.toContain('file://');

      // 5. emit status on future schema database must report clean [CACHE_SCHEMA_MISMATCH] (EMIT-006 / R4)
      const dbPath = path.join(tempDir, '.emit', 'cache.db');
      const { DatabaseSync } = await import('node:sqlite');
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec('PRAGMA user_version = 999;');
      rawDb.close();

      await runCli(['status']);
      expect(exitCode).toBe(1);
      const schemaErr = errLines.join('\n');
      expect(schemaErr).toContain('[CACHE_SCHEMA_MISMATCH]');
      expect(schemaErr).not.toContain('    at ');
      expect(schemaErr).not.toContain('file://');
    } finally {
      vi.unstubAllGlobals();
      console.error = originalError;
      process.exit = originalExit;
      process.chdir(originalCwd);
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('executes emit conflicts list and emit doctor commands cleanly (Phase 3)', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-cli-home-'));
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;

    const configDir = path.join(homeDir, '.config', 'emit');
    fs.mkdirSync(configDir, { recursive: true });
    setProfile(
      'default',
      {
        origin: 'https://aroooy.net',
        token: 'test-token',
        workspace: tempDir,
      },
      true,
      path.join(configDir, 'profiles.yaml'),
    );

    const originalCwd = process.cwd();
    process.chdir(tempDir);

    const logLines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    };

    try {
      // 1. emit conflicts list in clean workspace
      logLines.length = 0;
      await program.parseAsync(['node', 'emit', 'conflicts', 'list']);
      const confOut = logLines.join('\n');
      expect(confOut).toContain('No conflicts or rescue backups found');

      // 1b. emit conflicts (no args) defaults to list (v0.1.39 P2)
      logLines.length = 0;
      await program.parseAsync(['node', 'emit', 'conflicts']);
      const confBareOut = logLines.join('\n');
      expect(confBareOut).toContain('No conflicts or rescue backups found');

      // 2. emit doctor in clean workspace
      logLines.length = 0;
      await program.parseAsync(['node', 'emit', 'doctor']);
      const docOut = logLines.join('\n');
      expect(docOut).toContain('Emit Workspace Doctor');
      expect(docOut).toContain('Overall Status: HEALTHY');

      // 3. emit guide in clean workspace (Handy Commands must lock maintenance-only stance)
      logLines.length = 0;
      await program.parseAsync(['node', 'emit', 'guide']);
      const guideOut = logLines.join('\n');
      expect(guideOut).toContain('maintenance/full-backup run');
      expect(guideOut).toContain('local mirrors use the storageKey');
      expect(guideOut).toContain('emit media-search');
      expect(guideOut).not.toMatch(/--all[^.]*how every remote storageKey gets indexed/);
    } finally {
      console.log = originalLog;
      process.chdir(originalCwd);
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('reportActionFailure guarantees leading ❌ without double-prefixing ❌ Error: ❌ (v0.1.27 P3)', async () => {
    const { reportActionFailure } = await import('../src/cli/report-failure.js');
    const { DuplicateSlugError } = await import('../src/sync/new.js');
    const { QuarantinedPathRequiredError } = await import('../src/sync/conflicts.js');

    const errLines: string[] = [];
    const originalError = console.error;
    const originalExit = process.exit;
    const EXIT_SENTINEL = Symbol('emit-test-exit');
    let exitCode: number | undefined;

    console.error = (...args: unknown[]) => {
      errLines.push(args.map(String).join(' '));
    };
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw EXIT_SENTINEL;
    }) as typeof process.exit;

    const invokeFailure = (err: unknown) => {
      errLines.length = 0;
      exitCode = undefined;
      try {
        reportActionFailure(err);
      } catch (caught) {
        if (caught !== EXIT_SENTINEL) throw caught;
      }
    };

    try {
      // 1. Pre-prefixed error (DuplicateSlugError) keeps single ❌ and does NOT double-prefix
      invokeFailure(
        new DuplicateSlugError({
          slug: 'dup-slug',
          existingId: '01M6ABCDEF1234567890123456',
          existingFilePath: 'posts/draft/dup-slug.md',
          existingStatus: 'draft',
          source: 'workspace',
        }),
      );
      expect(exitCode).toBe(1);
      expect(errLines[0].startsWith('❌ Conflict:')).toBe(true);
      expect(errLines.join('\n')).not.toContain('❌ Error: ❌');

      // 2. Plain Error gets ❌ Error: prefix
      invokeFailure(new Error('unexpected filesystem failure'));
      expect(exitCode).toBe(1);
      expect(errLines[0]).toBe('❌ Error: unexpected filesystem failure');

      // 3. QuarantinedPathRequiredError uses dynamic error.code and suggestion
      invokeFailure(
        new QuarantinedPathRequiredError({
          filePath: 'posts/draft/some.md',
          collection: 'posts',
        }),
      );
      expect(exitCode).toBe(1);
      expect(errLines[0]).toContain('❌ Error: [QUARANTINED_PATH_REQUIRED]');
      expect(errLines[1]).toContain('💡 Suggestion:');

      // 4. PushValidationError formats preflight guard errors and suggestions (v0.1.28 H3)
      const { PushValidationError } = await import('../src/sync/push/index.js');
      invokeFailure(
        new PushValidationError('Push blocked by Preflight Guards (1 error(s)).', [
          {
            code: 'INVALID_TAXONOMY_ERROR',
            message: 'Unknown category "ghost"',
            suggestion: 'Run emit pull first.',
          },
        ]),
      );
      expect(exitCode).toBe(1);
      expect(errLines.join('\n')).toContain('❌ Push blocked by Preflight Guards (1 error(s)):');
      expect(errLines.join('\n')).toContain('[INVALID_TAXONOMY_ERROR] Unknown category "ghost"');
      expect(errLines.join('\n')).toContain('👉 Suggestion: Run emit pull first.');

      // 5. SyncPruneConflictError formats window prune conflict message (v0.1.28 H3)
      const { SyncPruneConflictError } = await import('../src/sync/orchestrator.js');
      invokeFailure(
        new SyncPruneConflictError('Pull aborted: 1 file(s) have unpushed local edits!', [
          { id: '01M6ABCDEF1234567890123456', slug: 'old-post', filePath: 'posts/draft/old.md' },
        ]),
      );
      expect(exitCode).toBe(1);
      expect(errLines.join('\n')).toContain(
        '❌ Pull aborted: 1 file(s) have unpushed local edits!',
      );
    } finally {
      console.error = originalError;
      process.exit = originalExit;
    }
  });

  it('T10: resolves pull article target by filePath or ID, and rejects invalid targets (v0.1.29 P4)', async () => {
    const { resolveArticleTarget } = await import('../src/sync/diff.js');

    const sampleUlid = '01M6ABCDEF1234567890123456';
    const canonicalRelPath = `posts/draft/20261115_${sampleUlid}-sample-title.md`;

    // 1. Resolve by lexical path containing ULID
    const resFromLexical = resolveArticleTarget({
      workspaceRoot: tempDir,
      filePath: canonicalRelPath,
    });
    expect(resFromLexical.id).toBe(sampleUlid);

    // 2. Resolve by ID directly
    const resFromId = resolveArticleTarget({
      workspaceRoot: tempDir,
      id: sampleUlid,
    });
    expect(resFromId.id).toBe(sampleUlid);

    // 3. Resolve by disk frontmatter when filename does not have ULID
    const nonUlidRelPath = 'posts/draft/custom-named-post.md';
    const nonUlidFullPath = path.join(tempDir, nonUlidRelPath);
    fs.mkdirSync(path.dirname(nonUlidFullPath), { recursive: true });
    fs.writeFileSync(
      nonUlidFullPath,
      `---\nid: ${sampleUlid}\nslug: custom-post\ntitle: "Custom"\nstatus: draft\n---\nBody`,
      'utf8',
    );

    const resFromDisk = resolveArticleTarget({
      workspaceRoot: tempDir,
      filePath: nonUlidRelPath,
    });
    expect(resFromDisk.id).toBe(sampleUlid);

    // 4. Unresolved path returns undefined id
    const resUnresolved = resolveArticleTarget({
      workspaceRoot: tempDir,
      filePath: 'posts/draft/does-not-exist.md',
    });
    expect(resUnresolved.id).toBeUndefined();

    // 5. CLI pull command invocation with invalid target rejects with ARTICLE_TARGET_UNRESOLVED
    const errLines: string[] = [];
    const originalError = console.error;
    const originalExit = process.exit;
    const EXIT_SENTINEL = Symbol('emit-test-exit');
    let exitCode: number | undefined;

    console.error = (...args: unknown[]) => {
      errLines.push(args.map(String).join(' '));
    };
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw EXIT_SENTINEL;
    }) as typeof process.exit;

    try {
      const prevCwd = process.cwd();
      process.chdir(tempDir);
      try {
        await program.parseAsync(['node', 'emit', 'pull', 'posts/draft/does-not-exist.md']);
      } catch (err) {
        if (err !== EXIT_SENTINEL) throw err;
      } finally {
        process.chdir(prevCwd);
      }

      expect(exitCode).toBe(1);
      const out = errLines.join('\n');
      expect(out).toContain('[ARTICLE_TARGET_UNRESOLVED]');
      expect(out).toContain('Could not resolve article target: "posts/draft/does-not-exist.md"');
      expect(out).not.toContain('    at ');
    } finally {
      console.error = originalError;
      process.exit = originalExit;
    }
  });

  describe('resolveExplicitBooleanOption (v0.1.30 T7)', () => {
    function createTestCommand() {
      const cmd = new Command();
      cmd
        .option('--media', 'Mirror media')
        .option('--no-media', 'Skip media')
        .action(() => {});
      return cmd;
    }

    it('returns undefined when neither option was passed', () => {
      const cmd = createTestCommand();
      cmd.parse([], { from: 'user' });
      expect(resolveExplicitBooleanOption(cmd, 'media')).toBeUndefined();
    });

    it('returns true when --media was passed', () => {
      const cmd = createTestCommand();
      cmd.parse(['--media'], { from: 'user' });
      expect(resolveExplicitBooleanOption(cmd, 'media')).toBe(true);
    });

    it('returns false when --no-media was passed', () => {
      const cmd = createTestCommand();
      cmd.parse(['--no-media'], { from: 'user' });
      expect(resolveExplicitBooleanOption(cmd, 'media')).toBe(false);
    });

    it('resolves conflicting flags in last-wins order', () => {
      const cmd1 = createTestCommand();
      cmd1.parse(['--media', '--no-media'], { from: 'user' });
      expect(resolveExplicitBooleanOption(cmd1, 'media')).toBe(false);

      const cmd2 = createTestCommand();
      cmd2.parse(['--no-media', '--media'], { from: 'user' });
      expect(resolveExplicitBooleanOption(cmd2, 'media')).toBe(true);
    });
  });

  describe('emit snapshot (v0.1.47)', () => {
    it('supports --status and --clear offline without remote requests', async () => {
      const logLines: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => logLines.push(args.map(String).join(' '));
      const prevCwd = process.cwd();
      process.chdir(tempDir);
      try {
        await program.parseAsync(['node', 'emit', 'snapshot', '--status']);
        expect(logLines.join('\n')).toContain('Snapshot (posts): none');

        const localCache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
        try {
          localCache.saveSnapshotMeta({
            collection: 'posts',
            capturedAt: Date.now(),
            articleCount: 4,
            mediaCount: 2,
            taxonomyFetchedCount: 1,
            taxonomyReusedCount: 3,
            articleSingleGetCount: 1,
            durationMs: 25,
          });
        } finally {
          localCache.close();
        }

        logLines.length = 0;
        await program.parseAsync(['node', 'emit', 'snapshot', '--status']);
        expect(logLines.join('\n')).toContain('4 article(s) · 2 media record(s)');

        logLines.length = 0;
        await program.parseAsync(['node', 'emit', 'snapshot', '--clear']);
        expect(logLines.join('\n')).toContain('Cleared snapshot for "posts"');

        const verifyCache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
        try {
          expect(verifyCache.getSnapshotMeta('posts')).toBeNull();
        } finally {
          verifyCache.close();
        }
      } finally {
        process.chdir(prevCwd);
        console.log = origLog;
      }
    });
  });

  describe('status and diff failure presentation (v0.1.48 Axis 8)', () => {
    it('routes status and diff profile resolution errors through reportActionFailure without raw stack traces', async () => {
      const errLines: string[] = [];
      let exitCode: number | undefined;
      const EXIT_SENTINEL = new Error('PROCESS_EXIT');
      const origError = console.error;
      const origExit = process.exit;
      console.error = (...args: unknown[]) => errLines.push(args.map(String).join(' '));
      process.exit = ((code?: number) => {
        exitCode = code ?? 0;
        throw EXIT_SENTINEL;
      }) as never;

      const prevCwd = process.cwd();
      process.chdir(tempDir);
      try {
        await expect(
          program.parseAsync(['node', 'emit', 'status', '--profile', 'nonexistent-profile-xyz']),
        ).rejects.toThrow(EXIT_SENTINEL);
        expect(exitCode).toBe(1);
        expect(errLines.join('\n')).toContain('nonexistent-profile-xyz');
        expect(errLines.join('\n')).not.toContain('    at ');

        errLines.length = 0;
        exitCode = undefined;
        await expect(
          program.parseAsync(['node', 'emit', 'diff', '--profile', 'nonexistent-profile-xyz']),
        ).rejects.toThrow(EXIT_SENTINEL);
        expect(exitCode).toBe(1);
        expect(errLines.join('\n')).toContain('nonexistent-profile-xyz');
        expect(errLines.join('\n')).not.toContain('    at ');
      } finally {
        process.chdir(prevCwd);
        console.error = origError;
        process.exit = origExit;
      }
    });
  });
});
