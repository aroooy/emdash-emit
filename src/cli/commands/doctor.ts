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
import { ApiError } from '../../client/error.js';
import { runWorkspaceDoctor } from '../../sync/doctor.js';
import type { CliContextResolver } from '../context.js';

export function registerDoctorCommand(program: Command, resolveContext: CliContextResolver): void {
  const reportActionFailure = (error: unknown): never => {
    if (error instanceof ApiError) {
      console.error(error.toActionableString());
    } else if (error instanceof Error) {
      console.error(`❌ Error: ${error.message}`);
    } else {
      console.error(`❌ Error: ${String(error)}`);
    }
    process.exit(1);
  };

  program
    .command('doctor')
    .description(
      'Run comprehensive diagnostics on workspace configuration, cache, and content integrity',
    )
    .option('-c, --collection <collection>', 'Target collection (defaults to "posts")')
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .option(
      '--strict-media',
      'Enforce strict media verification (fail on unpromoted or unverified references)',
    )
    .option(
      '--check-media-urls',
      'Probe the remote media file route for references with no local mirror, downgrading legacy assets that are still served remotely to informational notes',
    )
    .option(
      '--check-media-library',
      'Walk the remote media library and report how many records it holds against how many this workspace mirrors (mediaSyncLimit truncates the local window)',
    )
    .action(async (options) => {
      try {
        const ctx = resolveContext(options.profile, { optionalAuth: true });
        const collection = options.collection || ctx.config.defaultCollection || 'posts';

        const report = await runWorkspaceDoctor({
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          config: ctx.config,
          profileName: ctx.auth?.profileName,
          profileOrigin: ctx.auth?.origin,
          collection,
          strictMedia: Boolean(options.strictMedia),
          checkMediaUrls: Boolean(options.checkMediaUrls),
          checkMediaLibrary: Boolean(options.checkMediaLibrary),
          token: ctx.auth?.token,
          refreshToken: ctx.auth?.refreshToken,
        });

        console.log(`🩺 Emit Workspace Doctor`);
        console.log(`   Workspace: ${report.workspace}`);
        console.log(
          `   Version:   v${report.emitVersion}${report.createdWithVersion ? ` (created with v${report.createdWithVersion})` : ''}\n`,
        );

        for (const check of report.checks) {
          const badge =
            check.status === 'ok'
              ? '✅ [PASS]'
              : check.status === 'warning'
                ? '⚠️  [WARN]'
                : '❌ [FAIL]';
          console.log(`  ${badge} ${check.name}: ${check.message}`);
          if (check.suggestion) {
            console.log(`       💡 Suggestion: ${check.suggestion}`);
          }
        }

        console.log('');
        if (report.overallStatus === 'healthy') {
          console.log('🎉 Overall Status: HEALTHY — Workspace is in good condition.');
        } else if (report.overallStatus === 'warnings') {
          console.log(
            '⚠️  Overall Status: WARNINGS — Workspace is functional but has items to review.',
          );
        } else {
          console.log('❌ Overall Status: ERRORS — Issues detected that need attention.');
          process.exit(1);
        }
      } catch (err) {
        reportActionFailure(err);
      }
    });
}
