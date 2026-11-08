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
import { deleteArticle } from '../../sync/delete.js';
import { ApiError } from '../../client/error.js';
import type { CliContextResolver } from '../context.js';

export function registerDeleteCommand(program: Command, resolveContext: CliContextResolver): void {
  const reportActionFailure = (error: unknown): never => {
    if (error instanceof ApiError) {
      console.error(error.toActionableString());
    } else if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }
    process.exit(1);
  };

  program
    .command('delete <target>')
    .description('Safely delete an article from both local workspace and remote EmDash server')
    .option('--allow-delete-published', 'Explicitly confirm deletion of a live published article')
    .option('--dry-run', 'Preview deletion metadata without deleting anything')
    .option('-y, --yes', 'Confirm deletion without interactive prompt')
    .option('-c, --collection <collection>', 'Target collection (defaults to "posts")')
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (target, options) => {
      try {
        // In non-interactive CLI environments, require --yes or treat as dry-run
        const isDryRun = Boolean(options.dryRun || !options.yes);
        const ctx = resolveContext(options.profile, { optionalAuth: isDryRun });
        const collection = options.collection || ctx.config.defaultCollection;
        const result = await deleteArticle({
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          filePath: target.endsWith('.md') || target.includes('/') ? target : undefined,
          id: !target.endsWith('.md') && !target.includes('/') ? target : undefined,
          collection,
          allowDeletePublished: Boolean(options.allowDeletePublished),
          dryRun: isDryRun,
          origin: ctx.origin,
          token: ctx.auth?.token,
          refreshToken: ctx.auth?.refreshToken,
        });

        if (result.dryRun) {
          console.log(`\n🔍 [DRY-RUN PREVIEW]`);
          console.log(`   ID:        ${result.id}`);
          console.log(`   Slug:      ${result.slug}`);
          console.log(`   Title:     ${result.title}`);
          console.log(`   Status:    ${result.status}`);
          console.log(`   File Path: ${result.filePath}`);
          console.log(`   Lines:     ${result.bodyLineCount} lines`);
          if (result.referencedMedia.length > 0) {
            console.log(
              `   Referenced Media (${result.referencedMedia.length} files preserved in media/):`,
            );
            for (const m of result.referencedMedia) {
              console.log(`     - ${m}`);
            }
          }
          console.log(`\n⚠️  To permanently delete this article, run again with --yes:`);
          const pubFlag = result.status === 'published' ? ' --allow-delete-published' : '';
          console.log(`   emit delete ${target}${pubFlag} --yes\n`);
          return;
        }

        console.log(`\n${result.message}\n`);
      } catch (error) {
        reportActionFailure(error);
      }
    });
}
