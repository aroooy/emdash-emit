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
import { FrontmatterParseError } from '../../utils/frontmatter.js';
import { persistLocalMediaRefs } from '../../utils/config.js';
import type { CliContextResolver } from '../context.js';

export function registerPushCommand(program: Command, resolveContext: CliContextResolver): void {
  program
    .command('push [file]')
    .description(
      'Push local markdown article(s) to remote EmDash (auto-uploads media/drafts/* images)',
    )
    .option('--allow-publish', 'Confirm publishing live to remote')
    .option('--all', 'Push all modified files in workspace')
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
      'Keep mirrored body images as workspace-relative "media/<storageKey>" references on disk while pushing the canonical URL. Remembered in .emit/config.json.',
    )
    .option(
      '--no-local-media-refs',
      'Disable a remembered local-media-ref preference and store canonical EmDash URLs on disk again.',
    )
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (file, options) => {
      const ctx = resolveContext(options.profile);

      // Same workspace-preference rule as pull: honour the remembered setting, persist an explicit flag, and
      // let `--no-local-media-refs` clear a previously remembered preference.
      const localMediaRefs =
        options.localMediaRefs === false
          ? false
          : options.localMediaRefs === true
            ? true
            : ctx.config.localMediaRefs;
      if (options.localMediaRefs === true && ctx.config.localMediaRefs !== true) {
        persistLocalMediaRefs(ctx.root, true);
      } else if (options.localMediaRefs === false && ctx.config.localMediaRefs === true) {
        persistLocalMediaRefs(ctx.root, false);
      }

      try {
        if (options.all) {
          const pushResult = await pushAll({
            workspaceRoot: ctx.root,
            cache: ctx.cache,
            origin: ctx.origin,
            token: ctx.auth.token,
            refreshToken: ctx.auth.refreshToken,
            allowPublish: options.allowPublish,
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
            if (res.previousId) {
              console.log(`   🆔 Server assigned ULID: ${res.previousId} -> ${res.id}`);
            }
            if (res.previousFilePath) {
              console.log(`   📄 Renamed local file: ${res.previousFilePath} -> ${res.filePath}`);
            }
            if (res.resolvedTaxonomies) {
              for (const [tax, items] of Object.entries(res.resolvedTaxonomies)) {
                if (Array.isArray(items)) {
                  for (const item of items) {
                    if (item.input !== item.resolved) {
                      console.log(
                        `   🏷️ Canonicalized ${tax}: '${item.input}' -> '${item.resolved}'`,
                      );
                    }
                  }
                }
              }
            }
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
              `      emit push ${file} --resolve-taxonomy=union    (clean union of all terms)`,
            );
            console.warn(
              `      emit push ${file} --resolve-taxonomy=local    (accept your local terms)`,
            );
            console.warn(
              `      emit push ${file} --resolve-taxonomy=remote   (accept remote terms)`,
            );
          } else {
            console.warn(`   Conflict markers have been written to ${res.filePath}.`);
            console.warn(
              `   Please resolve the conflict manually or let AI resolve it, then re-push.`,
            );
          }
        } else {
          console.log(`✅ Successfully pushed ${res.id} -> ${res.filePath} (rev: ${res.rev})`);
          if (res.previousId) {
            console.log(`   🆔 Server assigned ULID: ${res.previousId} -> ${res.id}`);
          }
          if (res.previousFilePath) {
            console.log(`   📄 Renamed local file: ${res.previousFilePath} -> ${res.filePath}`);
          }
          if (res.resolvedTaxonomies) {
            for (const [tax, items] of Object.entries(res.resolvedTaxonomies)) {
              if (Array.isArray(items)) {
                for (const item of items) {
                  if (item.input !== item.resolved) {
                    console.log(
                      `   🏷️ Canonicalized ${tax}: '${item.input}' -> '${item.resolved}'`,
                    );
                  }
                }
              }
            }
          }
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
        if (err instanceof FrontmatterParseError) {
          console.error(`\n❌ Error: [${err.code}] ${err.message}`);
          if (err.suggestion) {
            console.error(`   💡 Suggestion: ${err.suggestion}`);
          }
          process.exit(1);
        }
        if (err instanceof ApiError) {
          console.error(`\n${err.toActionableString()}`);
          process.exit(1);
        }
        if (err instanceof Error) {
          console.error(`\n❌ Error: ${err.message}`);
          process.exit(1);
        }
        console.error(`\n❌ Error: ${String(err)}`);
        process.exit(1);
      }
    });
}
