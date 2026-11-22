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
import { formatSnapshotAge, formatSnapshotTimestamp } from '../../presentation/article_report.js';
import type { CliContextResolver } from '../context.js';
import { sameOrigin } from '../context.js';
import type { ResolveProfileResult, WorkspaceLinkDrift } from '../../utils/profile.js';

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

/**
 * Whether `emit init` should (re-)register the resolved profile's workspace path.
 *
 * `resolveInitPlan()`'s guard deliberately refuses to link a profile that already carries a workspace — on a
 * first init that prevents one folder from stealing another's link. But the same guard makes `emit init`
 * useless for the repair case (v0.1.38 P2): after a folder move, the stale path is exactly what is registered,
 * so the plain rule would leave the drift in place while telling the user to run this very command.
 *
 * An explicitly named profile (`emit init --profile <name>`) resolves that contradiction: naming the profile
 * is the intent, so re-pointing its workspace at the current directory is what was asked for. `--no-link`
 * still wins — an explicit refusal outranks everything. A drift-free auto-resolved init keeps the original
 * guard-2 behaviour unchanged.
 */
export function resolveInitRelink(
  options: { link?: boolean },
  resolvedProfile: ResolveProfileResult | null,
  drift: WorkspaceLinkDrift | null,
): boolean {
  if (options.link === false) return false;
  if (!resolvedProfile) return false;
  // Only a profile the user named by hand may have an existing link moved. An auto-resolved profile that
  // carries a workspace cannot be the one being repaired — it matched by directory, which means its
  // registered path already contains this one.
  if (resolvedProfile.source === 'explicit' && drift) return true;
  return !resolvedProfile.config.workspace;
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
          icon = item.healable ? '🟠' : '🔴';
          label = item.healable ? 'healable' : 'invalid ';
        } else if (item.hasUnpublishedDraft) {
          icon = '🟣';
        }

        const titleDisplay = item.title ? ` (${item.title})` : '';
        const cacheTag =
          item.syncStatus === 'invalid' && item.cached === false ? ' [uncached]' : '';
        const draftTag = item.hasUnpublishedDraft ? ' [has unpublished draft]' : '';
        const errorDisplay = item.error ? ` — ${item.error}` : '';
        const statusDisplay = item.hasUnpublishedDraft ? 'published*' : item.status || '';
        const paddedStatus = statusDisplay.padEnd(9, ' ');
        console.log(
          `  ${icon} [${label}] ${paddedStatus} ${item.filePath}${titleDisplay}${cacheTag}${draftTag}${errorDisplay}`,
        );
      }

      const invalidSuffix = status.summary.invalid > 0 ? `, ${status.summary.invalid} invalid` : '';
      const healableSuffix =
        status.summary.healableInvalid > 0 ? ` (${status.summary.healableInvalid} healable)` : '';
      console.log(
        `\nSummary: ${status.summary.total} total (${status.summary.synced} synced, ${status.summary.modified} modified, ${status.summary.untracked} untracked${invalidSuffix}${healableSuffix})\n`,
      );
      if (
        status.summary.flags &&
        (status.summary.flags.conflictPending > 0 ||
          status.summary.flags.orphan > 0 ||
          status.summary.flags.deletePending > 0 ||
          status.summary.flags.taxonomyApplyPending > 0)
      ) {
        const parts: string[] = [];
        if (status.summary.flags.conflictPending > 0) {
          parts.push(`${status.summary.flags.conflictPending} conflict pending`);
        }
        if (status.summary.flags.orphan > 0) {
          parts.push(`${status.summary.flags.orphan} orphan`);
        }
        if (status.summary.flags.deletePending > 0) {
          parts.push(`${status.summary.flags.deletePending} delete pending`);
        }
        if (status.summary.flags.taxonomyApplyPending > 0) {
          parts.push(`${status.summary.flags.taxonomyApplyPending} taxonomy apply pending`);
        }
        console.log(`Flags: ${parts.join(', ')}\n`);
      }
      if (status.summary.invalid > 0) {
        const uncachedInvalid = status.items.filter(
          (i) => i.syncStatus === 'invalid' && i.cached === false,
        );
        const unrecoverableInvalid = status.items.filter(
          (i) => i.syncStatus === 'invalid' && !i.healable,
        );
        if (uncachedInvalid.length > 0) {
          const exampleId = uncachedInvalid.find((i) => i.id && i.id !== 'unknown')?.id || '<ULID>';
          console.log(
            `💡 Hint: Run "emit pull" to automatically repair cached invalid frontmatter (local body is strictly preserved). For ${uncachedInvalid.length} uncached file(s) outside the sync window, run "emit pull ${exampleId}".\n`,
          );
        } else if (unrecoverableInvalid.length > 0) {
          console.log(
            `💡 Hint: ${status.summary.healableInvalid} invalid file(s) will be repaired automatically by "emit pull" (syntax-only re-quoting; local body is strictly preserved). ` +
              `${unrecoverableInvalid.length} file(s) need manual frontmatter editing — "emit pull" cannot fix them.\n`,
          );
        } else {
          console.log(
            '💡 Hint: Run "emit pull" to automatically repair invalid frontmatter syntax (syntax-only re-quoting; local body is strictly preserved). No network access is needed for cached articles whose remote revision is unchanged.\n',
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

      const snapMeta = ctx.cache.getSnapshotMeta(collection);
      if (snapMeta) {
        const snapIso = new Date(snapMeta.capturedAt).toISOString();
        const snapStale =
          Date.now() - snapMeta.capturedAt >= 7 * 86_400_000
            ? ' ⚠️ [STALE_SNAPSHOT: >7d old — run "emit snapshot"]'
            : '';
        console.log(
          `📸 Snapshot: ${formatSnapshotTimestamp(snapIso)} (${formatSnapshotAge(snapIso)}) · ${snapMeta.articleCount} articles · ${snapMeta.mediaCount} media${snapStale}\n`,
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
                          (--check-media-library compares the remote library to the local mirror count)
  - emit media-search ... Search remote media library by keyword (--limit, --max-scan)
  - emit pull-media   ... Download remote media assets (--article <id> or --storage-key <key>;
                          --all is a maintenance/full-backup run, referenced media mirrors on pull)
  - emit mcp          ... Launch stdio MCP server for AI agents (Antigravity, Claude Code)

■ Collaboration Rules with AI (AGENTS.md)
  - Strict prohibition against creating throwaway temporary files (e.g. temp.md).
  - Never manually rename (mv) cached files; update the frontmatter slug/status instead.
  - Media uses two different ULIDs: featuredImage uses the media record id, while body URLs
    and local mirrors use the storageKey. They never match — see docs/media-id-spaces.md.
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
    .option(
      '-p, --profile <name>',
      'Initialize against this named profile, re-pointing its workspace here if it has moved',
    )
    .action(async (options: { origin?: string; link?: boolean; profile?: string }) => {
      const root = process.cwd();
      const { initWorkspace } = await import('../../utils/config.js');
      const { getWorkspacePaths } = await import('../../utils/workspace.js');
      const { resolveTargetProfile, setProfile, detectWorkspaceLinkDrift } =
        await import('../../utils/profile.js');

      let resolvedProfile = null;
      try {
        // An explicit --profile pins the resolution: it must not lose to a current-directory match, since
        // the profile being repaired is precisely the one whose registered path no longer contains here.
        resolvedProfile = resolveTargetProfile({ cwd: root, profile: options.profile });
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

      const drift = detectWorkspaceLinkDrift(
        resolvedProfile?.name,
        resolvedProfile?.config.workspace,
        root,
      );
      const shouldRelinkProfile = resolveInitRelink(options, resolvedProfile, drift);

      const gitignore = initWorkspace(
        root,
        effectiveOrigin ? { origin: effectiveOrigin } : undefined,
      );
      const paths = getWorkspacePaths(root);

      console.log(`✅ Initialized Emit workspace at: ${root}`);
      console.log(`   Config: ${paths.configPath}`);
      console.log(`   Database: ${paths.dbPath}`);
      /**
       * v0.1.38 P3: the cache database is machine-local SQLite, and first-time users commit it because
       * nothing told them not to. Report what this run did, and point at README §6 for the repository-level
       * rules Emit deliberately does not own (whether `media/` is tracked is the user's call).
       */
      if (gitignore.gitignoreCreated) {
        console.log(
          '   Git:      .emit/.gitignore created (excludes the local SQLite cache)\n' +
            '             If this workspace is a Git repo, see README §6 "Recommended .gitignore".',
        );
      } else {
        console.log('   Git:      .emit/.gitignore already exists — left untouched');
      }
      /**
       * v0.1.38 P4-B discoverability: a freshly initialized workspace is where a wrong or missing PAT first
       * bites, and the fix is one flag on a command the user already knows. No `profile verify` verb is added.
       */
      console.log(
        '\nTip: verify credentials with "emit doctor --check-auth" before the first push.',
      );

      if (shouldLinkProfile && resolvedProfile) {
        setProfile(resolvedProfile.name, {
          ...resolvedProfile.config,
          workspace: root,
        });
        console.log(`🔗 Linked profile "${resolvedProfile.name}" -> workspace ${root}`);
      } else if (shouldRelinkProfile && resolvedProfile && drift) {
        setProfile(resolvedProfile.name, {
          ...resolvedProfile.config,
          workspace: root,
        });
        console.log(
          `🔗 Re-linked profile "${resolvedProfile.name}": ${drift.registeredWorkspace} -> ${root}`,
        );
      }
    });
}
