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

import type { Command } from 'commander';
import type { ProfileConfig } from '../../utils/profile.js';
import {
  loadProfilesFile,
  setProfile,
  setActiveProfile,
  removeProfile,
  resolveTargetProfile,
  findProfileByDirectory,
} from '../../utils/profile.js';
import {
  ACTIVE_DEFAULT_MARKER,
  CWD_MATCH_MARKER,
  cwdMatchedProfileName,
  formatResolutionRationale,
  toResolutionSource,
} from '../../utils/profile-resolution.js';

export function registerProfileCommands(program: Command): void {
  /**
   * Profile management is local-file work, and its failures (unknown profile name, ambiguous
   * multi-profile resolution) are user-correctable. Report them as one actionable line with a
   * non-zero exit instead of leaking a raw Node stack trace, matching how pull/push already
   * format errors.
   */
  const reportProfileFailure = (error: unknown): never => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ ${message}`);
    process.exit(1);
  };

  const profileCmd = program
    .command('profile')
    .description('Manage EmDash site connection profiles (multi-site support)');

  // emit profile list
  profileCmd
    .command('list')
    .description('List all configured site profiles')
    .action(() => {
      const data = loadProfilesFile();
      const names = Object.keys(data.profiles);
      if (names.length === 0) {
        console.log(
          'No profiles configured. Use "emit profile add <name> --origin <url>" to create one.',
        );
        return;
      }
      /**
       * v0.1.38 P1: `(active)` used to be the only marker, which read as "this is what commands will
       * use" — but a profile whose registered workspace contains the current directory silently wins
       * over `data.active`. Label both honestly instead of changing resolution: the `active` field is
       * still just the fallback, and saying so removes the incentive to run a needless `profile use`.
       */
      const cwd = process.cwd();
      const matchedName = cwdMatchedProfileName(names, (name) => {
        const workspace = data.profiles[name].workspace;
        if (!workspace) return false;
        return findProfileByDirectory(cwd)?.name === name;
      });
      console.log(
        '\nConfigured profiles (a registered workspace matching the current directory always wins; "active" is only the fallback):',
      );
      for (const name of names) {
        const p = data.profiles[name];
        let marker = '';
        if (name === matchedName) {
          marker = ` ${CWD_MATCH_MARKER}`;
        } else if (name === data.active) {
          marker = ` ${ACTIVE_DEFAULT_MARKER}`;
        }
        const bullet = name === matchedName || name === data.active ? '*' : '-';
        console.log(`  ${bullet} ${name}${marker}`);
        console.log(`      origin:    ${p.origin}`);
        if (p.workspace) console.log(`      workspace: ${p.workspace}`);
        if (p.token) console.log(`      token:     [configured]`);
      }
      console.log();
    });

  // emit profile add <name>
  profileCmd
    .command('add <name>')
    .description('Add or update a site profile')
    .requiredOption(
      '--origin <url>',
      'Origin URL of the EmDash instance (e.g. https://your-blog.example.com)',
    )
    .option('--token <token>', 'Personal access token (PAT)')
    .option('--workspace <path>', 'Default local workspace directory for this site')
    .option('--active', 'Set this profile as active immediately')
    .action((name, options) => {
      try {
        /**
         * `add` doubles as "update", so unspecified options must fall back to what is already
         * stored. Re-running `emit profile add <name> --origin <new>` used to rebuild the entry
         * from scratch, silently wiping a stored token and the workspace link that `emit init`
         * created - the next command then failed with "No authentication found" and directory
         * based profile resolution broke.
         */
        const existing = loadProfilesFile().profiles[name];
        const token = options.token ?? existing?.token ?? '';
        const workspace = options.workspace ?? existing?.workspace;
        const profileConfig: ProfileConfig = {
          origin: options.origin,
          token,
          ...(workspace ? { workspace } : {}),
          ...(existing?.defaultCollection ? { defaultCollection: existing.defaultCollection } : {}),
          ...(existing?.defaultLocale ? { defaultLocale: existing.defaultLocale } : {}),
        };
        setProfile(name, profileConfig);
        if (options.active) {
          setActiveProfile(name);
        }
        const kept: string[] = [];
        if (!options.token && existing?.token) kept.push('token');
        if (!options.workspace && workspace) kept.push('workspace link');
        console.log(
          `✅ Profile "${name}" ${existing ? 'updated' : 'configured'} successfully.` +
            (kept.length
              ? ` Kept the existing ${kept.join(' and ')}; pass --token/--workspace to replace them.`
              : ''),
        );
      } catch (error) {
        reportProfileFailure(error);
      }
    });

  // emit profile use <name>
  profileCmd
    .command('use <name>')
    .description('Set active default profile')
    .action((name) => {
      try {
        setActiveProfile(name);
        console.log(`✅ Active profile set to "${name}".`);
      } catch (error) {
        reportProfileFailure(error);
      }
    });

  // emit profile remove <name>
  profileCmd
    .command('remove <name>')
    .description('Remove a profile')
    .action((name) => {
      try {
        removeProfile(name);
        console.log(`✅ Profile "${name}" removed.`);
      } catch (error) {
        reportProfileFailure(error);
      }
    });

  // emit profile current
  profileCmd
    .command('current')
    .description('Show currently resolved profile and origin')
    .option('-p, --profile <name>', 'Explicit profile name to inspect')
    .action((options) => {
      let resolved: ReturnType<typeof resolveTargetProfile>;
      try {
        resolved = resolveTargetProfile({ profile: options.profile });
      } catch (error) {
        reportProfileFailure(error);
        return;
      }
      if (!resolved) {
        console.log('No profile resolved (relying on environment variables or defaults).');
        return;
      }
      /**
       * v0.1.38 P1: name the resolution path, not just the winner. Multi-site users otherwise assume a
       * manual `profile use` is required when directory-based auto-resolution has already picked the
       * right site — and the wrong assumption is what pushes to the wrong instance.
       */
      const cwd = process.cwd();
      const cwdMatched = findProfileByDirectory(cwd)?.name === resolved.name;
      const source = toResolutionSource(resolved, cwdMatched);
      console.log(`Active Profile: ${resolved.name}`);
      console.log(`  Origin:       ${resolved.config.origin}`);
      if (resolved.config.workspace) console.log(`  Workspace:    ${resolved.config.workspace}`);
      console.log(
        `  Resolved by:  ${formatResolutionRationale(source, {
          profileName: resolved.name,
          workspacePath: resolved.config.workspace,
          cwd,
        })}`,
      );
    });
}
