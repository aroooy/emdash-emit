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
import {
  loadProfilesFile,
  setProfile,
  setActiveProfile,
  removeProfile,
  resolveTargetProfile,
} from '../../utils/profile.js';

export function registerProfileCommands(program: Command): void {
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
      console.log('\nConfigured profiles:');
      for (const name of names) {
        const p = data.profiles[name];
        const isCurrent = name === data.active;
        const marker = isCurrent ? ' (active)' : '';
        console.log(`  * ${name}${marker}`);
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
      const profileConfig = {
        origin: options.origin,
        token: options.token || '',
        ...(options.workspace ? { workspace: options.workspace } : {}),
      };
      setProfile(name, profileConfig);
      if (options.active) {
        setActiveProfile(name);
      }
      console.log(`✅ Profile "${name}" configured successfully.`);
    });

  // emit profile use <name>
  profileCmd
    .command('use <name>')
    .description('Set active default profile')
    .action((name) => {
      setActiveProfile(name);
      console.log(`✅ Active profile set to "${name}".`);
    });

  // emit profile remove <name>
  profileCmd
    .command('remove <name>')
    .description('Remove a profile')
    .action((name) => {
      removeProfile(name);
      console.log(`✅ Profile "${name}" removed.`);
    });

  // emit profile current
  profileCmd
    .command('current')
    .description('Show currently resolved profile and origin')
    .option('-p, --profile <name>', 'Explicit profile name to inspect')
    .action((options) => {
      const resolved = resolveTargetProfile({ profile: options.profile });
      if (!resolved) {
        console.log('No profile resolved (relying on environment variables or defaults).');
        return;
      }
      console.log(`Active Profile: ${resolved.name}`);
      console.log(`  Origin:       ${resolved.config.origin}`);
      if (resolved.config.workspace) console.log(`  Workspace:    ${resolved.config.workspace}`);
    });
}
