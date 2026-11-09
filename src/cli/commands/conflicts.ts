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
import {
  listConflicts,
  diffConflict,
  resolveConflict,
  pruneConflicts,
  CanonicalHasUnpushedEditsError,
  QuarantinedPathRequiredError,
} from '../../sync/conflicts.js';
import type { CliContextResolver } from '../context.js';

export function registerConflictsCommand(
  program: Command,
  resolveContext: CliContextResolver,
): void {
  const reportActionFailure = (error: unknown): never => {
    if (error instanceof CanonicalHasUnpushedEditsError) {
      console.error(`❌ ${error.message}`);
      console.error(`💡 Suggestion: ${error.suggestion}`);
    } else if (error instanceof QuarantinedPathRequiredError) {
      console.error(`❌ Error: [QUARANTINED_PATH_REQUIRED] ${error.message}`);
      console.error(`💡 Suggestion: ${error.suggestion}`);
    } else if (error instanceof ApiError) {
      console.error(error.toActionableString());
    } else if (error instanceof Error) {
      console.error(`❌ Error: ${error.message}`);
    } else {
      console.error(`❌ Error: ${String(error)}`);
    }
    process.exit(1);
  };

  const conflicts = program
    .command('conflicts')
    .description(
      'Manage quarantined sync conflict copies and deletion rescue backups in posts/conflicts/',
    );

  // emit conflicts list
  conflicts
    .command('list')
    .description('List all quarantined conflict and deleted backup files')
    .option('-c, --collection <collection>', 'Target collection (defaults to "posts")')
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (options) => {
      try {
        const ctx = resolveContext(options.profile, { optionalAuth: true });
        const collection = options.collection || ctx.config.defaultCollection || 'posts';
        const items = listConflicts(ctx.root, collection);

        if (items.length === 0) {
          console.log(`✅ No conflicts or rescue backups found in ${collection}/conflicts/.`);
          return;
        }

        console.log(`📁 Quarantined Files in ${collection}/conflicts/ (${items.length} total):\n`);
        for (const item of items) {
          const typeLabel =
            item.type === 'conflict'
              ? '⚠️  [SYNC CONFLICT]'
              : item.type === 'deleted'
                ? '🗑️  [DELETED RESCUE]'
                : '❓ [UNKNOWN]';
          const titleStr = item.title ? ` - "${item.title}"` : '';
          const canonicalStr = item.canonicalPath
            ? ` (canonical: ${item.canonicalPath})`
            : ' (canonical: absent)';
          console.log(`  ${typeLabel} ${item.filePath}${titleStr}${canonicalStr}`);
          console.log(
            `     ID: ${item.id || 'unknown'} | Slug: ${item.slug || 'unknown'} | Size: ${item.sizeBytes} B | Created: ${item.createdAt}\n`,
          );
        }

        console.log('Commands:');
        console.log('  emit conflicts diff <filePath>                 Inspect differences');
        console.log(
          '  emit conflicts resolve <filePath> --accept-local      Apply quarantined copy to canonical',
        );
        console.log(
          '  emit conflicts resolve <filePath> --accept-canonical  Discard quarantined copy\n',
        );
      } catch (err) {
        reportActionFailure(err);
      }
    });

  // emit conflicts diff <filePath>
  conflicts
    .command('diff <filePath>')
    .description('Inspect differences between a quarantined copy and the canonical article')
    .option('-c, --collection <collection>', 'Target collection (defaults to "posts")')
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (filePath, options) => {
      try {
        const ctx = resolveContext(options.profile, { optionalAuth: true });
        const collection = options.collection || ctx.config.defaultCollection || 'posts';
        const result = diffConflict({
          workspaceRoot: ctx.root,
          filePath,
          collection,
        });

        console.log(`🔍 Diff for ${result.conflictFilePath} (${result.type}):`);
        if (result.canonicalFilePath) {
          console.log(`   Canonical: ${result.canonicalFilePath}`);
          console.log(`   Changes: +${result.additions} / -${result.deletions} lines\n`);
        } else {
          console.log(`   Canonical: None (article was deleted or absent)\n`);
        }

        console.log(result.diffText);
      } catch (err) {
        reportActionFailure(err);
      }
    });

  // emit conflicts resolve <filePath>
  conflicts
    .command('resolve <filePath>')
    .description(
      'Resolve a quarantined conflict by accepting the local/quarantined copy or the canonical version',
    )
    .option(
      '--accept-local',
      'Replace canonical article with quarantined copy and delete quarantine',
    )
    .option('--accept-canonical', 'Discard the quarantined copy and keep canonical article')
    .option(
      '-f, --force',
      'Force overwrite canonical article even if it has unpushed local modifications',
    )
    .option('-c, --collection <collection>', 'Target collection (defaults to "posts")')
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (filePath, options) => {
      try {
        if (!options.acceptLocal && !options.acceptCanonical) {
          console.error('❌ Error: Must specify either --accept-local or --accept-canonical');
          process.exit(1);
        }

        const strategy = options.acceptLocal ? 'accept-local' : 'accept-canonical';
        const ctx = resolveContext(options.profile, { optionalAuth: true });
        const collection = options.collection || ctx.config.defaultCollection || 'posts';

        const result = resolveConflict({
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          filePath,
          strategy,
          force: options.force,
          collection,
        });

        console.log(`✅ ${result.message}`);
        if (result.warnings && result.warnings.length > 0) {
          for (const w of result.warnings) {
            console.log(`⚠️ Warning: ${w}`);
          }
        }
      } catch (err) {
        reportActionFailure(err);
      }
    });

  // emit conflicts prune
  conflicts
    .command('prune')
    .description(
      'Clean up old quarantined conflict copies and deletion backups in posts/conflicts/',
    )
    .option('--older-than <duration>', 'Prune copies older than specified duration (e.g. 7d, 24h)')
    .option('--dry-run', 'Preview files that would be pruned without deleting')
    .option('-y, --yes', 'Confirm pruning without interactive prompt')
    .option(
      '--allow-orphan-rescues',
      'Allow pruning orphan rescue backups that have no canonical article (e.g. .deleted.md)',
    )
    .option('-c, --collection <collection>', 'Target collection (defaults to "posts")')
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (options) => {
      try {
        const ctx = resolveContext(options.profile, { optionalAuth: true });
        const collection = options.collection || ctx.config.defaultCollection || 'posts';

        const result = pruneConflicts({
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          collection,
          olderThan: options.olderThan,
          dryRun: options.dryRun,
          allowOrphanRescues: options.allowOrphanRescues,
        });

        const prefix = result.dryRun ? '🔍 [DRY-RUN] Would prune' : '🗑️  Pruned';
        if (result.pruned.length === 0 && result.skipped.length === 0) {
          console.log(`✅ No conflict copies found to prune in ${collection}/conflicts/.`);
          return;
        }

        if (result.pruned.length > 0) {
          console.log(`${prefix} ${result.pruned.length} quarantined file(s):`);
          for (const f of result.pruned) {
            console.log(`   - ${f}`);
          }
        }

        if (result.skipped.length > 0) {
          console.log(`\n🛡️  Skipped ${result.skipped.length} quarantined file(s) for safety:`);
          for (const s of result.skipped) {
            console.log(`   - ${s.filePath}: ${s.reason}`);
          }
        }
      } catch (err) {
        reportActionFailure(err);
      }
    });
}
