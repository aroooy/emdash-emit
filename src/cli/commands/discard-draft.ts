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
import { discardDraftArticle } from '../../sync/orchestrator.js';
import { resolveAndPersistLocalMediaRefs, type CliContextResolver } from '../context.js';
import { reportActionFailure } from '../report-failure.js';

export function registerDiscardDraftCommand(
  program: Command,
  resolveContext: CliContextResolver,
): void {
  program
    .command('discard-draft <target>')
    .description(
      'Discard a staged remote draft on a published article and re-pull the live version',
    )
    .option('-f, --force', 'Quarantine unpushed local edits to posts/conflicts/ and proceed')
    .option(
      '--local-media-refs',
      'Keep mirrored body images as article-relative "../../media/<storageKey>" references on disk',
    )
    .option('--no-local-media-refs', 'Store canonical EmDash URLs on disk')
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(
      async (
        target: string,
        options: { force?: boolean; localMediaRefs?: boolean; profile?: string },
      ) => {
        try {
          const ctx = resolveContext(options.profile);
          const localMediaRefs = resolveAndPersistLocalMediaRefs(ctx, options.localMediaRefs);
          const res = await discardDraftArticle(target, {
            workspaceRoot: ctx.root,
            cache: ctx.cache,
            origin: ctx.origin,
            token: ctx.auth.token,
            refreshToken: ctx.auth.refreshToken,
            collection: ctx.config.defaultCollection,
            localMediaRefs,
            force: Boolean(options.force),
          });

          if (res.noDraftPending) {
            console.log(`ℹ️ Article ${res.id} (${res.filePath}) has no pending remote draft.`);
          } else {
            console.log(
              `✅ Discarded remote draft for ${res.id} and synced live version -> ${res.filePath} (rev: ${res.rev})`,
            );
            if (res.rescueFilePath) {
              console.log(`   🛟 Local edits quarantined to: ${res.rescueFilePath}`);
            }
          }
          console.log(`   🛠️ Admin: ${res.adminUrl}`);
        } catch (err: unknown) {
          reportActionFailure(err);
        }
      },
    );
}
