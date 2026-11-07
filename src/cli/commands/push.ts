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
import { pushArticle, PushValidationError } from '../../sync/push.js';
import { pushAll } from '../../sync/orchestrator.js';
import { ApiError } from '../../client/error.js';
import type { CliContextResolver } from '../context.js';

export function registerPushCommand(program: Command, resolveContext: CliContextResolver): void {
  program
    .command('push [file]')
    .description(
      'Push local markdown article(s) to remote EmDash (auto-uploads media/drafts/* images)',
    )
    .option('--allow-publish', 'Confirm publishing live to remote')
    .option('--all', 'Push all modified files in workspace')
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (file, options) => {
      const ctx = resolveContext(options.profile);

      try {
        if (options.all) {
          const pushResult = await pushAll({
            workspaceRoot: ctx.root,
            cache: ctx.cache,
            origin: ctx.origin,
            token: ctx.auth.token,
            refreshToken: ctx.auth.refreshToken,
            allowPublish: options.allowPublish,
          });

          if (pushResult.total === 0) {
            console.log('✨ All articles are already in sync. Nothing to push.');
            return;
          }

          for (const res of pushResult.results) {
            console.log(`✅ Pushed ${res.id} (${res.filePath})`);
            if (res.warnings && res.warnings.length > 0) {
              console.warn(`   ⚠️ Warnings (${res.warnings.length}):`);
              for (const w of res.warnings) {
                console.warn(`     👉 ${w}`);
              }
            }
          }
          return;
        }

        if (!file) {
          console.error('❌ Error: Please specify a file to push, or use --all.');
          console.error('   Example: emit push posts/draft/20261103_01M67...-my-article.md');
          process.exit(1);
        }

        console.log(`Pushing ${file}...`);
        const res = await pushArticle(file, {
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          origin: ctx.origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
          allowPublish: options.allowPublish,
        });

        if (res.conflict) {
          console.warn(`\n⚠️ Conflict encountered!`);
          console.warn(`   Conflict markers have been written to ${res.filePath}.`);
          console.warn(
            `   Please resolve the conflict manually or let AI resolve it, then re-push.`,
          );
        } else {
          console.log(`✅ Successfully pushed ${res.id} -> ${res.filePath} (rev: ${res.rev})`);
          if (res.warnings && res.warnings.length > 0) {
            console.warn(`\n⚠️ Warnings (${res.warnings.length}):`);
            for (const w of res.warnings) {
              console.warn(`   👉 ${w}`);
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof PushValidationError) {
          console.error(`\n❌ Push blocked by Preflight Guards (${err.errors.length} error(s)):`);
          for (const e of err.errors) {
            console.error(`   - [${e.code}] ${e.message}`);
            if (e.suggestion) {
              console.error(`     👉 Suggestion: ${e.suggestion}`);
            }
          }
          process.exit(1);
        }
        if (err instanceof ApiError) {
          console.error(`\n${err.toActionableString()}`);
          process.exit(1);
        }
        throw err;
      }
    });
}
