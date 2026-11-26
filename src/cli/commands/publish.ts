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
import { publishArticle } from '../../sync/orchestrator.js';
import { resolveAndPersistLocalMediaRefs, type CliContextResolver } from '../context.js';
import { reportActionFailure } from '../report-failure.js';

export function registerPublishCommand(program: Command, resolveContext: CliContextResolver): void {
  program
    .command('publish <target>')
    .description('Promote a staged remote draft (or draft article) to live published status')
    .option(
      '--local-media-refs',
      'Keep mirrored body images as article-relative "../../media/<storageKey>" references on disk',
    )
    .option('--no-local-media-refs', 'Store canonical EmDash URLs on disk')
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (target: string, options: { localMediaRefs?: boolean; profile?: string }) => {
      try {
        const ctx = resolveContext(options.profile);
        const localMediaRefs = resolveAndPersistLocalMediaRefs(ctx, options.localMediaRefs);
        const res = await publishArticle(target, {
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          origin: ctx.origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
          collection: ctx.config.defaultCollection,
          localMediaRefs,
        });

        if (res.alreadyPublished) {
          console.log(
            `ℹ️ Article ${res.id} (${res.filePath}) is already published with no pending draft.`,
          );
        } else {
          console.log(`✅ Published ${res.id} -> ${res.filePath} (rev: ${res.rev})`);
          if (res.previousFilePath) {
            console.log(`   📄 Moved local file: ${res.previousFilePath} -> ${res.filePath}`);
          }
        }
        console.log(`   🛠️ Admin: ${res.adminUrl}`);
      } catch (err: unknown) {
        reportActionFailure(err);
      }
    });
}
