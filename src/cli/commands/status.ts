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
import { getWorkspaceStatus, filterStatusItems } from '../../sync/status.js';
import { inspectArticleDiff } from '../../sync/diff.js';
import type { CliContextResolver } from '../context.js';
import { sameOrigin } from '../context.js';
import type { ResolveProfileResult } from '../../utils/profile.js';

export interface InitPlanResult {
  effectiveOrigin?: string;
  shouldLinkProfile: boolean;
  /** Actionable warning when a higher-precedence origin source silently overrides a lower one. */
  warning: string | null;
}

/**
 * Determines the effective origin for `emit init` and whether the resolved profile
 * should be automatically linked to the workspace (3-guard check: link enabled,
 * profile workspace unset, and profile origin matches effective origin).
 *
 * Origin precedence mirrors runtime resolution (`resolveOriginPriority`):
 * explicit `--origin` > `EMDASH_ORIGIN` > auto-resolved profile.
 */
export function resolveInitPlan(
  options: { origin?: string; link?: boolean },
  resolvedProfile: ResolveProfileResult | null,
  envOrigin?: string,
): InitPlanResult {
  const effectiveOrigin = options.origin || envOrigin || resolvedProfile?.config.origin;
  const shouldLinkProfile = Boolean(
    options.link !== false &&
    resolvedProfile &&
    !resolvedProfile.config.workspace &&
    sameOrigin(resolvedProfile.config.origin, effectiveOrigin || ''),
  );

  let warning: string | null = null;
  if (envOrigin && resolvedProfile && !sameOrigin(envOrigin, resolvedProfile.config.origin)) {
    warning = options.origin
      ? null
      : `⚠️ Warning: EMDASH_ORIGIN (${envOrigin}) overrides resolved profile "${resolvedProfile.name}" origin (${resolvedProfile.config.origin}). The workspace was initialized for EMDASH_ORIGIN and was not linked to that profile.`;
  }

  return { effectiveOrigin, shouldLinkProfile, warning };
}

export function registerStatusInitCommands(
  program: Command,
  resolveContext: CliContextResolver,
): void {
  // emit status
  program
    .command('status')
    .description('Show sync status of articles in local workspace')
    .option('-c, --collection <collection>', 'Collection to check (default: posts)')
    .option('-s, --search <term>', 'Filter articles by search term (title, slug, ID, filePath)')
    .option('--slug <slug>', 'Filter articles by slug')
    .option('--status <status>', 'Filter by publication status (draft or published)')
    .option('--sync-status <status>', 'Filter by sync state (synced, modified, untracked, invalid)')
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action((options) => {
      const ctx = resolveContext(options.profile);
      const collection = options.collection || ctx.config.defaultCollection;
      const status = getWorkspaceStatus(ctx.root, ctx.cache, collection);

      const isFiltered = Boolean(
        options.search || options.slug || options.status || options.syncStatus,
      );
      const displayItems = isFiltered
        ? filterStatusItems(status.items, {
            search: options.search,
            slugFilter: options.slug,
            status: options.status,
            syncStatus: options.syncStatus,
          })
        : status.items;

      console.log(`\n--- Workspace Status (${collection} | origin: ${ctx.origin}) ---`);
      if (isFiltered) {
        console.log(
          `   (Filtered: showing ${displayItems.length} of ${status.items.length} articles)\n`,
        );
      }
      for (const item of displayItems) {
        let icon = '🟢';
        let label = 'synced  ';
        if (item.conflictPending) {
          icon = '⚠️ ';
          label = 'conflict';
        } else if (item.syncStatus === 'modified') {
          icon = '🟡';
          label = 'modified';
        } else if (item.syncStatus === 'untracked') {
          icon = '⚪';
          label = 'untracked';
        } else if (item.syncStatus === 'invalid') {
          icon = '🔴';
          label = 'invalid ';
        }

        const titleDisplay = item.title ? ` (${item.title})` : '';
        const cacheTag =
          item.syncStatus === 'invalid' && item.cached === false ? ' [uncached]' : '';
        const errorDisplay = item.error ? ` — ${item.error}` : '';
        const paddedStatus = (item.status || '').padEnd(9, ' ');
        console.log(
          `  ${icon} [${label}] ${paddedStatus} ${item.filePath}${titleDisplay}${cacheTag}${errorDisplay}`,
        );
      }

      const invalidSuffix = status.summary.invalid > 0 ? `, ${status.summary.invalid} invalid` : '';
      console.log(
        `\nSummary: ${status.summary.total} total (${status.summary.synced} synced, ${status.summary.modified} modified, ${status.summary.untracked} untracked${invalidSuffix})\n`,
      );
      if (
        status.summary.flags &&
        (status.summary.flags.conflictPending > 0 ||
          status.summary.flags.orphan > 0 ||
          status.summary.flags.deletePending > 0)
      ) {
        console.log(
          `Flags: ${status.summary.flags.conflictPending} conflict pending, ${status.summary.flags.orphan} orphan, ${status.summary.flags.deletePending} delete pending\n`,
        );
      }
      if (status.summary.invalid > 0) {
        const uncachedInvalid = status.items.filter(
          (i) => i.syncStatus === 'invalid' && i.cached === false,
        );
        if (uncachedInvalid.length > 0) {
          const exampleId = uncachedInvalid.find((i) => i.id && i.id !== 'unknown')?.id || '<ULID>';
          console.log(
            `💡 Hint: Run "emit pull" to automatically repair cached invalid frontmatter (local body is strictly preserved). For ${uncachedInvalid.length} uncached file(s) outside the sync window, run "emit pull ${exampleId}".\n`,
          );
        } else {
          console.log(
            '💡 Hint: Run "emit pull" to automatically re-serialize and repair frontmatter syntax (local body is strictly preserved).\n',
          );
        }
      }
      if (status.summary.conflicts > 0) {
        console.log(
          `🩹 ${status.summary.conflicts} preserved local copy(ies) in ${collection}/conflicts/ ` +
            `(rescue copies created when a pull found divergent content).`,
        );
        console.log(
          '   Review each copy, merge any valuable content into the canonical article, then delete it. ' +
            'They are never pushed or pruned; pushing one directly is refused (QUARANTINED_COPY_NOT_PUSHABLE).\n',
        );
      }
    });

  // emit diff [filePath]
  program
    .command('diff [filePath]')
    .description('Display line-by-line differences between local edits and baseline snapshot')
    .option('-i, --id <id>', 'Article ID (ULID) to inspect')
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action((filePath: string | undefined, options: { id?: string; profile?: string }) => {
      const ctx = resolveContext(options.profile);
      const inspection = inspectArticleDiff({
        workspaceRoot: ctx.root,
        cache: ctx.cache,
        filePath,
        id: options.id,
      });

      if (!inspection.ok) {
        console.error(inspection.formattedOutput);
        process.exit(1);
      }

      console.log(inspection.formattedOutput);
    });

  // emit guide
  program
    .command('guide')
    .description('Display the Golden Path workflow and tips for humans & AI')
    .action(() => {
      console.log(`
========================================================================
  Emit - The Golden Path Workflow for Humans & AI
========================================================================

■ 4-Step Article Authoring Flow
  1. Scaffold:      emit new <slug> --title "Article Title"
                    --> Automatically generates posts/draft/<yyyyMMdd>_<ulid>-<title>.md
  2. Write & Edit:  Freely edit posts/draft/*.md with editor or AI.
                    --> No need to write a redundant # Title header in the body.
                    --> Reference frontmatter taxonomies for categories and tags.
                    --> Place offline images in media/drafts/<file> and reference them on a
                        standalone line: ![alt](../../media/drafts/<file>)
  3. Push Draft:    emit push <file>
                    --> Auto-uploads media/drafts/* images, rewrites URLs, and syncs draft.
  4. Publish Live:  Update frontmatter status to "published", then run:
                    emit push <file> --allow-publish

■ Handy Commands
  - emit status       ... View local editing status and diff against remote
  - emit pull [id]    ... Sync remote articles + taxonomies into local workspace
  - emit delete <id>  ... Safely delete article locally & remotely (saves .deleted.md rescue copy)
  - emit conflicts    ... List, diff, and resolve quarantined copies in posts/conflicts/
  - emit doctor       ... Diagnose workspace health, version, origin, and media references
  - emit pull-media   ... Download remote media assets (supports --article <id> for targeted sync)
  - emit mcp          ... Launch stdio MCP server for AI agents (Antigravity, Claude Code)

■ Collaboration Rules with AI (AGENTS.md)
  - Strict prohibition against creating throwaway temporary files (e.g. temp.md).
  - Never manually rename (mv) cached files; update the frontmatter slug/status instead.
========================================================================
`);
    });

  // emit init
  program
    .command('init')
    .description('Initialize current directory as an Emit local workspace')
    .option('--origin <url>', 'EmDash instance origin URL')
    .option(
      '--no-link',
      'Do not automatically link this workspace directory to the resolved profile',
    )
    .action(async (options: { origin?: string; link?: boolean }) => {
      const root = process.cwd();
      const { initWorkspace } = await import('../../utils/config.js');
      const { getWorkspacePaths } = await import('../../utils/workspace.js');
      const { resolveTargetProfile, setProfile } = await import('../../utils/profile.js');

      let resolvedProfile = null;
      try {
        resolvedProfile = resolveTargetProfile({ cwd: root });
      } catch {
        // Ignore AmbiguousProfileError during init; user can pass --origin explicitly
      }

      const { effectiveOrigin, shouldLinkProfile, warning } = resolveInitPlan(
        options,
        resolvedProfile,
        process.env.EMDASH_ORIGIN,
      );

      if (warning) {
        console.warn(warning);
      }

      initWorkspace(root, effectiveOrigin ? { origin: effectiveOrigin } : undefined);
      const paths = getWorkspacePaths(root);

      console.log(`✅ Initialized Emit workspace at: ${root}`);
      console.log(`   Config: ${paths.configPath}`);
      console.log(`   Database: ${paths.dbPath}`);

      if (shouldLinkProfile && resolvedProfile) {
        setProfile(resolvedProfile.name, {
          ...resolvedProfile.config,
          workspace: root,
        });
        console.log(`🔗 Linked profile "${resolvedProfile.name}" -> workspace ${root}`);
      }
    });
}
