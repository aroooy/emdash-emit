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

import readline from 'node:readline/promises';
import type { Command } from 'commander';
import { pushArticle, type PushResult } from '../../sync/push/index.js';
import { pushAll } from '../../sync/orchestrator.js';
import { getWorkspaceStatus, selectPushCandidates } from '../../sync/status.js';
import { resolveAndPersistLocalMediaRefs, type CliContextResolver } from '../context.js';
import { reportActionFailure } from '../report-failure.js';

/**
 * Prompts for a single-line confirmation answer on the given stdin/stdout streams.
 * Mirrors `readSecretLine` (`profile.ts`) I/O injection so CLI tests can mock TTY prompts cleanly.
 */
export async function readConfirmLine(
  prompt: string,
  io: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream } = {},
): Promise<string> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(prompt);
    return answer.trim();
  } finally {
    rl.close();
  }
}

function printPushArticleDetails(
  res: PushResult,
  warningHeaderPrefix = '   ⚠️',
  warningItemPrefix = '     👉',
): void {
  if (res.previousId) {
    console.log(`   🆔 Server assigned ULID: ${res.previousId} -> ${res.id}`);
  }
  if (res.previousFilePath) {
    console.log(`   📄 Renamed local file: ${res.previousFilePath} -> ${res.filePath}`);
  }
  if (res.adminUrl) {
    console.log(`   🛠️ Admin: ${res.adminUrl}`);
  }
  if (res.resolvedTaxonomies) {
    for (const [tax, items] of Object.entries(res.resolvedTaxonomies)) {
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item.input !== item.resolved) {
            console.log(`   🏷️ Canonicalized ${tax}: '${item.input}' -> '${item.resolved}'`);
          }
        }
      }
    }
  }
  if (res.warnings && res.warnings.length > 0) {
    console.warn(`${warningHeaderPrefix} Warnings (${res.warnings.length}):`);
    for (const w of res.warnings) {
      console.warn(`${warningItemPrefix} ${w}`);
    }
  }
}

export function registerPushCommand(program: Command, resolveContext: CliContextResolver): void {
  program
    .command('push [file]')
    .description(
      'Push local markdown article(s) to remote EmDash (auto-uploads media/drafts/* images)',
    )
    .option('--allow-publish', 'Confirm publishing live to remote')
    .option(
      '--allow-modified-opaque-blocks',
      'Bypass Guard G9 when <!--ec:block ... --> opaque block JSON/structure was modified',
    )
    .option('--all', 'Push all modified files in workspace')
    .option('-y, --yes', 'Skip confirmation prompt when auto-targeting a single modified article')
    .option(
      '--resolve-taxonomy <strategy>',
      'Resolve taxonomy conflict during 3-way merge: "union", "local", or "remote"',
    )
    .option('--allow-wipe-taxonomies', 'Explicitly confirm wiping all remote taxonomy assignments')
    .option(
      '--allow-unapplied-taxonomies',
      'Allow push even if previous taxonomy sync failed (bypasses Guard G17)',
    )
    .option('--no-taxonomy-audit', 'Skip remote taxonomy pre-audit check before pushing')
    .option('--revive', 'Intentionally revive and push a delete-pending article')
    .option('-f, --force', 'Force push and overwrite conflicting taxonomy states')
    .option(
      '--local-media-refs',
      'Keep mirrored body images as article-relative "../../media/<storageKey>" references on disk while pushing the canonical URL. Remembered in .emit/config.json.',
    )
    .option(
      '--no-local-media-refs',
      'Disable a remembered local-media-ref preference and store canonical EmDash URLs on disk again.',
    )
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (file, options) => {
      const ctx = resolveContext(options.profile);
      const localMediaRefs = resolveAndPersistLocalMediaRefs(ctx, options.localMediaRefs);

      try {
        if (options.all) {
          const pushResult = await pushAll({
            workspaceRoot: ctx.root,
            cache: ctx.cache,
            origin: ctx.origin,
            token: ctx.auth.token,
            refreshToken: ctx.auth.refreshToken,
            allowPublish: options.allowPublish,
            allowModifiedOpaqueBlocks: options.allowModifiedOpaqueBlocks,
            localMediaRefs,
          });

          if (pushResult.invalid > 0) {
            console.warn(
              `⚠️ Skipped ${pushResult.invalid} file(s) with invalid YAML frontmatter (run "emit status" or "emit pull" to inspect/repair).`,
            );
          }

          if (pushResult.skippedItems && pushResult.skippedItems.length > 0) {
            console.warn(
              `⚠️ Skipped ${pushResult.skippedItems.length} article(s) with pending flags (conflict_pending, delete_pending, or taxonomy_apply_pending):`,
            );
            for (const item of pushResult.skippedItems) {
              console.warn(`   - ${item.filePath} (${item.reason})`);
            }
          }

          if (pushResult.total === 0) {
            console.log('✨ All valid articles are already in sync. Nothing to push.');
            return;
          }

          for (const res of pushResult.results) {
            console.log(`✅ Pushed ${res.id} (${res.filePath})`);
            printPushArticleDetails(res);
          }
          return;
        }

        let targetFile: string | undefined = file;
        if (!targetFile) {
          const disallowedInAutoTarget = [
            options.allowPublish ? '--allow-publish' : null,
            options.revive ? '--revive' : null,
            options.allowWipeTaxonomies ? '--allow-wipe-taxonomies' : null,
            options.allowUnappliedTaxonomies ? '--allow-unapplied-taxonomies' : null,
            options.resolveTaxonomy ? '--resolve-taxonomy' : null,
            options.force ? '--force' : null,
            options.allowModifiedOpaqueBlocks ? '--allow-modified-opaque-blocks' : null,
          ].filter((flag): flag is string => flag !== null);

          if (disallowedInAutoTarget.length > 0) {
            console.error(
              `❌ Error: ${disallowedInAutoTarget.join(', ')} cannot be used without specifying a target file path.`,
            );
            console.error('   Pass the target file explicitly: emit push <file> ...');
            process.exit(1);
          }

          const status = getWorkspaceStatus(ctx.root, ctx.cache, ctx.config.defaultCollection);
          const { toPush, skipped } = selectPushCandidates(status);

          if (toPush.length === 0) {
            if (skipped.length > 0) {
              console.warn(
                `⚠️ Skipped ${skipped.length} article(s) with pending flags (conflict_pending, delete_pending, or taxonomy_apply_pending):`,
              );
              for (const item of skipped) {
                console.warn(`   - ${item.filePath} (${item.reason})`);
              }
            }
            console.log('✨ All valid articles are already in sync. Nothing to push.');
            return;
          }

          if (toPush.length > 1) {
            console.error(
              `❌ Found ${toPush.length} push-ready articles in workspace. Please specify a file path or use --all:`,
            );
            for (const item of toPush.slice(0, 10)) {
              console.error(`   - ${item.filePath}`);
            }
            if (toPush.length > 10) {
              console.error(`   ... and ${toPush.length - 10} more`);
            }
            process.exit(1);
          }

          const singleTarget = toPush[0]!.filePath;
          if (!options.yes) {
            const isTty = Boolean(
              (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY &&
              (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY,
            );
            if (!isTty) {
              console.error(
                `❌ Found 1 push-ready article (${singleTarget}), but stdin/stdout is not an interactive TTY.`,
              );
              console.error(
                `   Re-run with "emit push ${singleTarget}" or "emit push --yes" to confirm.`,
              );
              process.exit(1);
            }
            const answer = await readConfirmLine(`Push "${singleTarget}"? [y/N] `);
            if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
              console.log('Push cancelled.');
              return;
            }
          }

          targetFile = singleTarget;
        }

        console.log(`Pushing ${targetFile}...`);
        const res = await pushArticle(targetFile, {
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          origin: ctx.origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
          allowPublish: options.allowPublish,
          allowModifiedOpaqueBlocks: options.allowModifiedOpaqueBlocks,
          resolveTaxonomy: options.resolveTaxonomy,
          allowWipeTaxonomies: options.allowWipeTaxonomies,
          allowUnappliedTaxonomies: options.allowUnappliedTaxonomies,
          noTaxonomyAudit: options.taxonomyAudit === false || Boolean(options.noTaxonomyAudit),
          revive: options.revive,
          force: options.force,
          localMediaRefs,
        });

        if (res.conflict) {
          console.warn(`\n⚠️ Conflict encountered!`);
          if (res.warnings && res.warnings.length > 0) {
            console.warn(`   Warnings:`);
            for (const w of res.warnings) {
              console.warn(`     👉 ${w}`);
            }
          }
          if (res.taxonomyConflict) {
            console.warn(
              `\n   Taxonomy conflict encountered: local and remote categories/tags diverged.`,
            );
            console.warn(
              `   No conflict markers were written into the article body because the body was cleanly merged.`,
            );
            console.warn(`   💡 To resolve and push, choose a resolution strategy:`);
            console.warn(
              `      emit push ${targetFile} --resolve-taxonomy=union    (clean union of all terms)`,
            );
            console.warn(
              `      emit push ${targetFile} --resolve-taxonomy=local    (accept your local terms)`,
            );
            console.warn(
              `      emit push ${targetFile} --resolve-taxonomy=remote   (accept remote terms)`,
            );
          } else {
            console.warn(`   Conflict markers have been written to ${res.filePath}.`);
            console.warn(
              `   Please resolve the conflict manually or let AI resolve it, then re-push.`,
            );
          }
        } else {
          console.log(`✅ Successfully pushed ${res.id} -> ${res.filePath} (rev: ${res.rev})`);
          printPushArticleDetails(res, '\n⚠️', '   👉');
        }
      } catch (err: unknown) {
        reportActionFailure(err);
      }
    });
}
