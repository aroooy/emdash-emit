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

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { CacheDatabase } from '../db/cache.js';
import { readBaselineFrontmatter } from '../db/baseline.js';
import type { EmitConfig } from '../utils/config.js';
import { getPackageVersion } from '../utils/version.js';
import { parseMarkdown, lenientRepairMarkdownFrontmatter } from '../utils/frontmatter.js';
import { storageKeyToMarkdownRef } from '../utils/naming.js';
import { listConflicts } from './conflicts.js';
import { getWorkspaceStatus } from './status.js';
import { isLocalFileUnmodified } from './baseline-reconstruction.js';
import { storageKeyFromMediaMeta } from '../utils/media-companion.js';
import { mediaFileEndpoint, articleContentEndpoint } from '../client/endpoints.js';
import { createAuthedFetch } from '../client/http.js';
import { calculateHash } from './workspace/index.js';
import { collectRemoteStorageKeys } from './media/index.js';
import { checkMcpProcess } from '../utils/mcp-heartbeat.js';
import { detectWorkspaceLinkDrift } from '../utils/profile.js';
import { workspaceLinkDriftLines } from '../utils/profile-resolution.js';
import { VALID_MEDIA_FILE_KEY, FENCE_POLICY, isCodeFenceDelimiter } from '../utils/media-refs.js';

export type CheckStatus = 'ok' | 'warning' | 'error';

export interface DoctorCheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  message: string;
  suggestion?: string;
  details?: Record<string, unknown> | Array<unknown>;
}

export interface DoctorReport {
  workspace: string;
  emitVersion: string;
  createdWithVersion?: string;
  lastSyncedVersion?: string;
  overallStatus: 'healthy' | 'warnings' | 'errors';
  checks: DoctorCheckResult[];
}

export interface RunWorkspaceDoctorOptions {
  workspaceRoot: string;
  cache: CacheDatabase;
  config: EmitConfig;
  profileName?: string;
  profileOrigin?: string;
  /**
   * The workspace path registered on the resolved profile (`profiles.yaml`), when there is one. Doctor
   * compares it against `workspaceRoot` for the v0.1.38 workspace link check; without it there is nothing
   * to compare and the check must stay silent rather than guess.
   */
  profileWorkspace?: string;
  collection?: string;
  strictMedia?: boolean;
  /**
   * Probe the public media file route (`HEAD /_emdash/api/media/file/<storageKey>`) for body
   * references that no local mirror, cache entry, or base snapshot can resolve. A reference that the
   * origin still serves is downgraded from a missing-file warning to an informational note: the image
   * renders in the browser even though Emit could not match it to a record, which is why `emit
   * pull-media` mirrors nothing for it. A served key never proves the D1 record is absent — body URLs
   * carry the R2 storageKey while `GET /_emdash/api/media/{id}` keys on the record id. Disabled by
   * default so doctor stays offline.
   */
  checkMediaUrls?: boolean;
  /** Bearer token used by the remote library census (only read when `checkMediaLibrary` is set). */
  token?: string;
  refreshToken?: string;
  /**
   * Walk the whole remote media library (`GET /_emdash/api/media`, cursor-paginated) and report how
   * many records it holds, so a missing-file count can be read as coverage ("N of M mirrored") instead
   * of being guessed. The list operation exposes no storageKey filter, so this census is the only way
   * Emit can reach migrated assets whose storageKey differs from the record id. Requires credentials and
   * is skipped silently when none are available, keeping plain `emit doctor` offline.
   */
  checkMediaLibrary?: boolean;
  /**
   * Probe credential validity against the resolved origin (`GET /_emdash/api/content/<collection>?limit=1`,
   * status only). Opt-in (v0.1.38 P4-B) so plain `emit doctor` stays offline, exactly like the media probes.
   * The probe addresses the same endpoint Emit actually pushes to, because the question this check answers is
   * whether Emit holds a token with the rights it needs — a taxonomy endpoint would report a false failure for
   * a token that can sync articles but not manage terms.
   */
  checkAuth?: boolean;
  /** Optional fetch override used by the file-route probe (tests inject stubs here). */
  fetchFn?: typeof fetch;
}

export interface ScannedMediaReferences {
  normalRefs: string[];
  informationalRefs: string[];
  /** References whose captured URL is malformed and therefore cannot name a real media asset. */
  invalidRefs: string[];
}

/**
 * Counts the media assets this workspace actually mirrors: canonical binaries under `media/`, excluding
 * `drafts/` staging and the `legacy_*` residue that backs no real record.
 */
function countMirroredMedia(mediaDir: string): number {
  if (!fs.existsSync(mediaDir)) return 0;
  let count = 0;
  for (const file of fs.readdirSync(mediaDir)) {
    if (file.endsWith('.yaml') || file.startsWith('legacy_')) continue;
    if (!fs.statSync(path.join(mediaDir, file)).isFile()) continue;
    count++;
  }
  return count;
}

/** Any storageKey-style ULID appearing inside a media file URL. */
const MEDIA_ULID_IN_URL = /[0-9A-HJ-NP-Z]{26}/g;

/** True when the captured image markup sits inside an inline code span on the same line. */
function isInlineCodeSpan(line: string, matchText: string, matchIndex: number): boolean {
  if (line.includes('`' + matchText)) return true;
  const first = line.indexOf('`');
  return first !== -1 && first < matchIndex && matchIndex < line.lastIndexOf('`');
}

/**
 * Classify a captured media URL. Anything that cannot name a real asset (template placeholders, or
 * a key polluted by leaked markup) is reported separately so it never counts as missing media.
 */
function classifyMediaUrl(url: string): 'valid' | 'placeholder' | 'invalid' {
  if (url.includes('<') || url.includes('>') || url.includes('${')) return 'placeholder';
  const keyMatch = url.match(/(?:^|\/)media\/file\/([^?#]*)/);
  if (!keyMatch) return 'valid'; // a plain local path: resolved by filesystem checks instead
  if (VALID_MEDIA_FILE_KEY.test(keyMatch[1])) return 'valid';
  // A ULID is present but the captured key is polluted by leaked markup, as in the real legacy
  // body line `![alt](/_emdash/api/media/file/<ULID>.jpg" control=true)`. The asset itself still
  // resolves through the ULID, so only the surrounding capture is treated as residue.
  return MEDIA_ULID_IN_URL.test(keyMatch[1]) ? 'valid' : 'invalid';
}

/**
 * Scans article markdown to separate standard body image references from
 * informational references (code blocks, inline code, HTML comments, opaque custom-block fences,
 * or placeholder URLs) and from structurally invalid captures.
 */
export function scanArticleMediaDetailed(bodyMarkdown: string): ScannedMediaReferences {
  const normalRefs = new Set<string>();
  const informationalRefs = new Set<string>();
  const invalidRefs = new Set<string>();

  const lines = bodyMarkdown.split('\n');
  let inFence = false;
  let fenceDelimiter = '';
  // EmDash serializes unknown Portable Text blocks as single-line opaque fences
  // (`<!--ec:block {...} -->`). Their embedded JSON may contain media URLs that belong to the
  // remote block, not to editable markdown, so they must never be reported as missing.
  let inOpaqueFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^<!--ec:block\s/.test(trimmed)) {
      inOpaqueFence = !/^.*-->$/.test(trimmed);
      continue;
    }
    if (inOpaqueFence) continue;

    // Note: Doctor treats both backticks and tildes (~~~) as fences for diagnostic
    // reporting to avoid false warnings on code examples, whereas push guards (G5/G11)
    // strictly exempt only backtick fences per AGENTS.md.
    const delim = isCodeFenceDelimiter(trimmed, FENCE_POLICY.diagnostic);
    if (delim) {
      if (!inFence) {
        inFence = true;
        fenceDelimiter = delim;
        continue;
      } else if (trimmed.startsWith(fenceDelimiter)) {
        inFence = false;
        continue;
      }
    }

    // Markdown image syntax: ![alt](url)
    const mdRegex = /!\[.*?\]\(([^)\s]+)(?:\s+["'].*?["'])?\)/g;
    let match: RegExpExecArray | null;
    while ((match = mdRegex.exec(line)) !== null) {
      const url = match[1].trim();
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('data:')) {
        const kind = classifyMediaUrl(url);
        if (kind === 'invalid') {
          invalidRefs.add(url);
        } else if (
          inFence ||
          isInlineCodeSpan(line, match[0], match.index) ||
          kind === 'placeholder'
        ) {
          informationalRefs.add(url);
        } else {
          normalRefs.add(url);
        }
      }
    }

    // HTML img tags: <img src="...">
    const htmlRegex = /<img[^>]+src=["']([^"']+)["']/gi;
    while ((match = htmlRegex.exec(line)) !== null) {
      const url = match[1].trim();
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('data:')) {
        const kind = classifyMediaUrl(url);
        if (kind === 'invalid') {
          invalidRefs.add(url);
        } else if (inFence || kind === 'placeholder' || line.includes('<!--')) {
          informationalRefs.add(url);
        } else {
          normalRefs.add(url);
        }
      }
    }

    // Legacy WordPress-derived custom container lines that survived the migration, e.g.
    // `[dimage url="/_emdash/api/media/file/<ULID>.jpg" control=true]`. The URL is quoted inside
    // the line, so the regexes above cannot capture it; a trailing attribute or bracket marks the
    // capture as markup residue rather than a real asset reference.
    const legacyContainerRegex = /\[([a-z]+)\s+url=["']?([^"'\s\]]+)["']?[^\]]*\]/gi;
    while ((match = legacyContainerRegex.exec(line)) !== null) {
      const url = match[2].trim();
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('data:')) {
        informationalRefs.add(url);
      }
    }
  }

  return {
    normalRefs: Array.from(normalRefs).sort(),
    informationalRefs: Array.from(informationalRefs).sort(),
    invalidRefs: Array.from(invalidRefs).sort(),
  };
}

/**
 * Shared read-only context threaded through the three check groups. `checks` is appended to in strict
 * id order, so the group call order inside `runWorkspaceDoctor` is what fixes the report's sequence.
 *
 * Deliberately carries no DB write authority: the conflict-pending auto-clear stays in the orchestrator,
 * and the slug classification it depends on is published back onto this context so later checks keep
 * observing exactly one shared array.
 */
interface DoctorCheckContext {
  options: RunWorkspaceDoctorOptions;
  collection: string;
  cache: CacheDatabase;
  checks: DoctorCheckResult[];
  /** Quarantined copies under `<collection>/conflicts/`, read once and reused by checks 4 and 4b. */
  conflictItems: ReturnType<typeof listConflicts>;
  /** Every `sync_state` row, read once for checks 4b–4d. */
  allStates: ReturnType<CacheDatabase['getAllSyncStates']>;
  /** Populated by `runContentIntegrityChecks`; consumed by the orchestrator's auto-clear writes. */
  pendingConflictSlugs?: {
    autoClearedBodySlugs: string[];
    autoClearedTaxSlugs: string[];
    manualBodySlugs: string[];
    manualTaxSlugs: string[];
  };
}

/**
 * Checks 1, 2 and 7 — the environment-level checks that read no article bodies.
 */
function runEnvironmentChecks(ctx: DoctorCheckContext, currentVersion: string): void {
  const { options, checks } = ctx;

  // 1. Version Compatibility Check
  const createdWith = options.config.createdWithVersion;
  const lastSynced = options.config.lastSyncedVersion;
  checks.push({
    id: 'version_compatibility',
    name: 'Version Compatibility',
    status: 'ok',
    message: createdWith
      ? `Workspace running v${currentVersion} (created with v${createdWith}, last synced with v${lastSynced || createdWith})`
      : `Workspace running v${currentVersion} (compatible)`,
    details: {
      currentVersion,
      createdWithVersion: createdWith,
      lastSyncedVersion: lastSynced,
    },
  });

  // 2. Origin & Profile Consistency Check
  const configOrigin = options.config.origin;
  const profileOrigin = options.profileOrigin;
  if (profileOrigin && configOrigin && configOrigin !== profileOrigin) {
    checks.push({
      id: 'origin_consistency',
      name: 'Origin Consistency',
      status: 'warning',
      message: `Config origin (${configOrigin}) differs from resolved profile origin (${profileOrigin}). Profile origin will be preferred for sync.`,
      details: { configOrigin, profileOrigin, profileName: options.profileName },
    });
  } else {
    checks.push({
      id: 'origin_consistency',
      name: 'Origin Consistency',
      status: 'ok',
      message: `Origins are consistent (${profileOrigin || configOrigin || 'default'}).`,
    });
  }

  // 2b. Workspace Link Consistency Check (v0.1.38 P2)
  //
  // Pushed only when a link is actually registered and stale: an unregistered profile has no link to have
  // gone wrong, and pushing an `ok` check for it would add a line to every healthy report without saying
  // anything. Runs after check 2 because the origin comparison above is what tells a user whether the
  // registered path even points at the right site.
  const linkDrift = detectWorkspaceLinkDrift(
    options.profileName,
    options.profileWorkspace,
    options.workspaceRoot,
  );
  if (linkDrift) {
    const lines = workspaceLinkDriftLines(linkDrift);
    checks.push({
      id: 'workspace_link_consistency',
      name: 'Workspace Link Consistency',
      status: 'warning',
      message: lines.headline,
      suggestion: `Re-link with "${lines.relinkCommand}" so the registered workspace path matches this directory.`,
      details: { ...linkDrift },
    });
  }

  // 7. MCP Process Check
  const mcpCheck = checkMcpProcess();
  if (mcpCheck.isOutdated) {
    checks.push({
      id: 'mcp_process',
      name: 'MCP Server Process',
      status: 'warning',
      message: mcpCheck.message || 'An MCP server process is running with an outdated version.',
      details: mcpCheck.state ? { ...mcpCheck.state } : undefined,
    });
  } else if (mcpCheck.status === 'alive') {
    checks.push({
      id: 'mcp_process',
      name: 'MCP Server Process',
      status: 'ok',
      message: `MCP server process is running healthy (PID ${mcpCheck.state?.pid}, v${mcpCheck.state?.version}).`,
    });
  }
}

/**
 * Check 2c — opt-in credential validity probe (v0.1.38 P4-B).
 *
 * Deliberately kept out of `runEnvironmentChecks()`, which is a pure synchronous function: every HTTP probe in
 * doctor lives in an awaited group, and the position of that `await` inside `runWorkspaceDoctor()` is what
 * fixes this check's place in the report (logical id order 2c sits after `workspace_link_consistency` and
 * before Check 3, while execution order puts it ahead of the content and media groups).
 *
 * The probe reads only the HTTP status — never a body — against `articleContentEndpoint(origin, collection)`,
 * the same resource Emit pushes to. That choice is what keeps a posts-only token from being reported as
 * broken: an endpoint that requires taxonomy management would return 403 for credentials Emit can sync with.
 */
async function runRemoteAuthCheck(ctx: DoctorCheckContext): Promise<void> {
  const { options, collection, checks } = ctx;
  if (!options.checkAuth) return;

  const origin = options.profileOrigin || options.config.origin;
  const token = options.token || '';
  const authSource = options.profileName
    ? `profile "${options.profileName}"`
    : 'resolved credentials';

  if (!token) {
    checks.push({
      id: 'auth_validity',
      name: 'Auth Validity',
      status: 'warning',
      message: `No token is configured for ${origin}, so credential validity could not be checked.`,
      suggestion:
        'Store one with "emit profile add <name> --origin <origin> --token <pat>", or rotate it later with "emit profile set-token <name>".',
    });
    return;
  }

  const probeFetch = createAuthedFetch({
    origin,
    token,
    refreshToken: options.refreshToken,
    fetchFn: options.fetchFn,
  });

  let status: number | null = null;
  try {
    const url = `${articleContentEndpoint(origin, collection)}?limit=1`;
    const res = await probeFetch(url, { method: 'GET' });
    status = res.status;
  } catch {
    // Unreachable origin: the token was never offered, so nothing about it is known.
  }

  if (status !== null && status >= 200 && status < 300) {
    checks.push({
      id: 'auth_validity',
      name: 'Auth Validity',
      status: 'ok',
      message: `Configured credentials are accepted by ${origin} (auth source: ${authSource}).`,
      details: { origin, collection, httpStatus: status },
    });
    return;
  }

  if (status === 401 || status === 403) {
    checks.push({
      id: 'auth_validity',
      name: 'Auth Validity',
      status: 'error',
      message:
        `Configured credentials were rejected by ${origin} (HTTP ${status}). ` +
        'The token may be revoked or lack the required scope.',
      suggestion:
        'Issue a new Personal Access Token in the EmDash admin, then run "emit profile set-token <name>". ' +
        'Verify again with "emit doctor --check-auth".',
      details: { origin, collection, httpStatus: status },
    });
    return;
  }

  if (status !== null) {
    checks.push({
      id: 'auth_validity',
      name: 'Auth Validity',
      status: 'warning',
      message:
        `Could not verify credentials against ${origin} (HTTP ${status}). ` +
        'This does not prove the token is invalid.',
      details: { origin, collection, httpStatus: status },
    });
    return;
  }

  checks.push({
    id: 'auth_validity',
    name: 'Auth Validity',
    status: 'warning',
    message: `Credential verification skipped: ${origin} unreachable.`,
    details: { origin, collection },
  });
}

/**
 * Checks 3, 4, 4b, 4c, 4d and 5 — workspace content and cache-flag integrity. Read-only except for the
 * `afterAutoClear` callback: the DB writes that clear stale pending flags belong to the orchestrator, so
 * this group classifies each pending record and then lets the caller dispatch the clears before the
 * `conflict_pending_autoclear` check is pushed (which is what preserves the original check order).
 */
function runContentIntegrityChecks(
  ctx: DoctorCheckContext,
  afterAutoClear: (slugs: NonNullable<DoctorCheckContext['pendingConflictSlugs']>) => void,
): void {
  const { options, collection, cache, checks, conflictItems, allStates } = ctx;

  // 3. Frontmatter Syntax & Schema Integrity Check
  const invalidFiles: string[] = [];
  const healableFiles: string[] = [];
  let totalArticles = 0;
  for (const status of ['draft', 'published']) {
    const dir = path.join(options.workspaceRoot, collection, status);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      totalArticles++;
      const fullPath = path.join(dir, file);
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        try {
          parseMarkdown(content);
        } catch {
          // Attempt lenient parse
          const healed = lenientRepairMarkdownFrontmatter(content);
          if (healed) {
            parseMarkdown(healed);
            healableFiles.push(path.join(collection, status, file));
          } else {
            throw new Error('Unrecoverable parse error');
          }
        }
      } catch {
        invalidFiles.push(path.join(collection, status, file));
      }
    }
  }

  if (invalidFiles.length > 0) {
    checks.push({
      id: 'frontmatter_integrity',
      name: 'Frontmatter Integrity',
      status: 'error',
      message: `${invalidFiles.length} article(s) have unrecoverable frontmatter syntax errors.`,
      details: invalidFiles,
    });
  } else if (healableFiles.length > 0) {
    checks.push({
      id: 'frontmatter_integrity',
      name: 'Frontmatter Integrity',
      status: 'warning',
      message: `${healableFiles.length} article(s) have invalid frontmatter YAML that Emit can repair automatically. Run "emit pull" (syntax-only re-quoting; local body is strictly preserved).`,
      details: healableFiles,
    });
  } else {
    checks.push({
      id: 'frontmatter_integrity',
      name: 'Frontmatter Integrity',
      status: 'ok',
      message: `All ${totalArticles} article(s) have valid frontmatter syntax.`,
    });
  }

  // 4. Conflicts & Quarantine Check
  if (conflictItems.length > 0) {
    const conflictCount = conflictItems.filter((i) => i.type === 'conflict').length;
    const deletedCount = conflictItems.filter((i) => i.type === 'deleted').length;
    checks.push({
      id: 'conflicts_quarantine',
      name: 'Conflicts & Quarantine',
      status: 'warning',
      message: `${conflictItems.length} quarantined file(s) found in ${collection}/conflicts/ (${conflictCount} sync conflicts, ${deletedCount} deletion rescue copies). Run "emit conflicts list" to inspect.`,
      details: conflictItems.map((c) => ({
        filePath: c.filePath,
        type: c.type,
        slug: c.slug,
      })),
    });
  } else {
    checks.push({
      id: 'conflicts_quarantine',
      name: 'Conflicts & Quarantine',
      status: 'ok',
      message: `No unresolved conflicts or rescue backups in ${collection}/conflicts/.`,
    });
  }

  // 4b. Conflict Pending Alignment & Auditing
  const autoClearedBodySlugs: string[] = [];
  const autoClearedTaxSlugs: string[] = [];
  const manualBodySlugs: string[] = [];
  const manualTaxSlugs: string[] = [];
  const conflictMarkerRegex = /^<{7}\s|^={7}$|^>{7}\s/m;

  for (const state of allStates) {
    const fullPath = path.join(options.workspaceRoot, state.localFilePath);
    let diskContent: string | null = null;
    let hasDivergence = true;
    let hasBodyMarkers = false;

    if (fs.existsSync(fullPath)) {
      diskContent = fs.readFileSync(fullPath, 'utf8');
      const diskHash = calculateHash(diskContent);
      hasDivergence = !isLocalFileUnmodified({
        workspaceRoot: options.workspaceRoot,
        cache,
        id: state.id,
        relPath: state.localFilePath,
        localContent: diskContent,
        currentHash: diskHash,
        syncState: state,
      });
      hasBodyMarkers = conflictMarkerRegex.test(diskContent);
    }

    // Check body conflict pending
    if (state.bodyConflictPending === 1) {
      const hasConflictCopy = conflictItems.some(
        (c) =>
          (c.id === state.id || c.slug === state.slug) &&
          (c.type === 'conflict' ||
            c.type === 'dropped' ||
            c.filePath.endsWith('.conflict.md') ||
            c.filePath.endsWith('.local-dropped.md')),
      );
      if (!hasConflictCopy && !hasDivergence && !hasBodyMarkers) {
        autoClearedBodySlugs.push(state.slug);
      } else {
        manualBodySlugs.push(state.slug);
      }
    }

    // Check taxonomy conflict pending
    if (state.taxonomyConflictPending === 1) {
      const hasConflictCopy = conflictItems.some((c) => c.id === state.id || c.slug === state.slug);
      if (!hasConflictCopy && !hasDivergence) {
        autoClearedTaxSlugs.push(state.slug);
      } else {
        manualTaxSlugs.push(state.slug);
      }
    }
  }

  const totalAutoCleared = autoClearedBodySlugs.length + autoClearedTaxSlugs.length;
  ctx.pendingConflictSlugs = {
    autoClearedBodySlugs,
    autoClearedTaxSlugs,
    manualBodySlugs,
    manualTaxSlugs,
  };
  // The orchestrator owns the DB writes; pushing this check after they land keeps the report sequence
  // byte-identical to the pre-split implementation.
  afterAutoClear(ctx.pendingConflictSlugs);
  if (totalAutoCleared > 0) {
    checks.push({
      id: 'conflict_pending_autoclear',
      name: 'Conflict Pending Auto-Clear',
      status: 'ok',
      message: `Automatically cleared stale conflict_pending flag for ${totalAutoCleared} pending record(s) (no conflict copies and no divergence).`,
      details: [...new Set([...autoClearedBodySlugs, ...autoClearedTaxSlugs])],
    });
  }

  if (manualBodySlugs.length > 0) {
    checks.push({
      id: 'body_conflict_pending_manual',
      name: 'Body Conflict Pending',
      status: 'warning',
      message: `${manualBodySlugs.length} article(s) have pending body conflicts. Resolve conflict markers in the file or run "emit conflicts diff / resolve".`,
      details: manualBodySlugs,
    });
  }

  if (manualTaxSlugs.length > 0) {
    checks.push({
      id: 'conflict_pending_manual',
      name: 'Taxonomy Conflict Pending',
      status: 'warning',
      message: `${manualTaxSlugs.length} article(s) have pending taxonomy conflicts with existing rescue copies or unpushed edits. Run "emit push <file> --resolve-taxonomy=union|local|remote" to resolve.`,
      details: manualTaxSlugs,
    });
  }

  // 4c. Taxonomy Apply Pending Check
  const taxApplyPendingStates = allStates.filter((s) => s.taxonomyApplyPending === 1);
  if (taxApplyPendingStates.length > 0) {
    checks.push({
      id: 'taxonomy_apply_pending',
      name: 'Taxonomy Apply Pending',
      status: 'warning',
      message: `${taxApplyPendingStates.length} article(s) have unapplied taxonomy terms from a previous failed sync.`,
      suggestion:
        'Run "emit pull-taxonomies", verify the terms exist on remote (missing terms or permission errors must be fixed there first), then "emit push <file>".',
      details: taxApplyPendingStates.map((s) => ({
        id: s.id,
        slug: s.slug,
        filePath: s.localFilePath,
      })),
    });
  }

  // 4d. Delete Pending Check
  const deletePendingStates = allStates.filter((s) => s.deletePending === 1);
  if (deletePendingStates.length > 0) {
    checks.push({
      id: 'delete_pending',
      name: 'Delete Pending Articles',
      status: 'warning',
      message: `${deletePendingStates.length} article(s) are marked as delete_pending (unconfirmed remote deletion).`,
      suggestion:
        'Confirm the remote deletion, then "emit delete <file>" to finish local cleanup, or "emit push <file> --revive" to intentionally revive.',
      details: deletePendingStates.map((s) => ({
        id: s.id,
        slug: s.slug,
        filePath: s.localFilePath,
      })),
    });
  }

  // 5. Sync Status & Pending Modifications Check
  const wsStatus = getWorkspaceStatus(options.workspaceRoot, cache, collection);
  if (wsStatus.summary.modified > 0 || wsStatus.summary.untracked > 0) {
    checks.push({
      id: 'sync_status',
      name: 'Sync Status',
      status: 'warning',
      message: `${wsStatus.summary.modified} modified and ${wsStatus.summary.untracked} untracked article(s) pending push.`,
      details: {
        total: wsStatus.summary.total,
        synced: wsStatus.summary.synced,
        modified: wsStatus.summary.modified,
        untracked: wsStatus.summary.untracked,
        invalid: wsStatus.summary.invalid,
      },
    });
  } else {
    checks.push({
      id: 'sync_status',
      name: 'Sync Status',
      status: 'ok',
      message: `All ${wsStatus.summary.synced} tracked article(s) in sync with base snapshots.`,
    });
  }
}

/**
 * Check 6 — media reference integrity, including the cache/baseline fallbacks, the optional live
 * file-route probe and the optional remote library census. Reads no DB state beyond `media_state`.
 */
async function runMediaIntegrityChecks(ctx: DoctorCheckContext): Promise<void> {
  const { options, collection, checks } = ctx;

  // 6. Media References Integrity Check
  // Index every local resolution source so a body URL can be matched even when the companion YAML
  // is missing its storageKey field, which is common for legacy corpora (D1)
  const mediaDir = path.join(options.workspaceRoot, 'media');
  const knownStorageKeys = new Set<string>();
  const knownMediaIds = new Set<string>();
  const knownLocalFiles = new Set<string>();
  // StorageKey-derived stems of mirrored assets. A body URL carries the storageKey, and a mirror is now
  // named after exactly that key, so the stem — not a filename tail parsed out of an id-based name — is
  // what lets `/_emdash/api/media/file/<storageKey>` resolve to a file on disk.
  const knownMediaStems = new Set<string>();

  interface LocalCompanionAsset {
    stem: string;
    yamlPath: string;
    storageKey?: string;
    mediaId?: string;
    binaryFile?: string;
  }
  const localCompanions = new Map<string, LocalCompanionAsset>();
  const nonYamlMediaFiles = new Set<string>();
  const localDraftFiles: string[] = [];

  if (fs.existsSync(mediaDir)) {
    const mediaFiles = fs.readdirSync(mediaDir);
    for (const f of mediaFiles) {
      knownLocalFiles.add(f);
      knownLocalFiles.add(path.posix.join('media', f));
      if (f.startsWith('legacy_')) {
        // Leftover mirrors from the removed file-route fallback must never feed the known-storageKey
        // or known-media-id sets: they back no real media record, so a body referencing them stays a
        // missing-file warning and `--check-media-urls` can still downgrade it to a served note.
        continue;
      }
      if (f.endsWith('.yaml')) {
        try {
          const doc = yaml.load(fs.readFileSync(path.join(mediaDir, f), 'utf8')) as Record<
            string,
            unknown
          > | null;
          if (doc) {
            const mediaId = typeof doc.id === 'string' && doc.id ? doc.id : undefined;
            if (mediaId) {
              knownMediaIds.add(mediaId);
            }
            // The storageKey field is missing on older mirrors, but their `url:` still names the key,
            // so both forms count as confirmed local metadata.
            const metaKey = storageKeyFromMediaMeta(doc);
            if (metaKey) knownStorageKeys.add(metaKey);
            const stem = f.slice(0, -5);
            localCompanions.set(stem, {
              stem,
              yamlPath: path.posix.join('media', f),
              storageKey: metaKey,
              mediaId,
            });
          }
        } catch {
          // ignore corrupted individual yaml
        }
      } else if (!f.startsWith('.')) {
        if (f !== 'drafts') {
          nonYamlMediaFiles.add(f);
        }
        // media/<markdownRef>.<ext>: the stem is the sanitized storageKey, so it is recorded whole and
        // matched against the key a body URL carries. Legacy id-based names stay readable too, because a
        // workspace that has not been re-pulled yet still holds them.
        const stem = f.replace(/\.[^.]+$/, '');
        knownMediaStems.add(stem);
        knownMediaStems.add(stem.replace(/^\d{8}_/, ''));
        const dash = stem.indexOf('-');
        if (dash !== -1) knownMediaStems.add(stem.slice(dash + 1));
      }
    }
    for (const [stem, comp] of localCompanions.entries()) {
      for (const bf of nonYamlMediaFiles) {
        if (bf.startsWith(stem + '.')) {
          comp.binaryFile = path.posix.join('media', bf);
          break;
        }
      }
    }
    const draftsDir = path.join(mediaDir, 'drafts');
    if (fs.existsSync(draftsDir)) {
      for (const df of fs.readdirSync(draftsDir)) {
        if (!df.startsWith('.')) {
          localDraftFiles.push(df);
          knownLocalFiles.add(path.posix.join('media', 'drafts', df));
          knownLocalFiles.add(path.posix.join('../../media', 'drafts', df));
        }
      }
    }
  }

  // Cache-backed fallbacks: media_state records the confirmed storageKey of every asset Emit
  // uploaded, and base snapshots preserve the remote featured_image object (which carries
  // meta.storageKey) for articles whose local frontmatter only holds the media record id.
  for (const record of options.cache.listMediaStates()) {
    if (record.storageKey) knownStorageKeys.add(record.storageKey);
    if (record.mediaId) knownMediaIds.add(record.mediaId);
  }
  const knownFeaturedStorageKeys = new Set<string>();
  for (const state of options.cache.getAllSyncStates()) {
    const snapshot = options.cache.getBaseSnapshot(state.id);
    const fm = readBaselineFrontmatter(snapshot) as Record<string, unknown> | null;
    if (!fm) continue;
    const fi = fm.featuredImage ?? fm.featured_image;
    const meta = (fi as Record<string, unknown> | null)?.meta as Record<string, unknown> | null;
    if (typeof meta?.storageKey === 'string' && meta.storageKey) {
      knownFeaturedStorageKeys.add(meta.storageKey);
    }
  }

  const missingMedia: string[] = [];
  // References that survived every local fallback yet are still served by the public file route. The
  // live HEAD (only when --check-media-urls is set) proves the R2 object exists; it says nothing about
  // whether a D1 record exists, because the probe addresses the storageKey and not the primary key.
  const verifiedFileRouteOnly: string[] = [];
  const unreachableFileRoute: string[] = [];
  const informationalUnresolved: string[] = [];
  const invalidMediaRefs: string[] = [];
  // Candidates that survived every local fallback; probed live only when checkMediaUrls is enabled.
  const pendingRemoteProbes: Array<{ ref: string; key: string; source: string }> = [];
  const probeKey = (ref: string): string | null => {
    const m = ref.match(/(?:^|\/)media\/file\/([^?#]+)/);
    if (!m) return null;
    return VALID_MEDIA_FILE_KEY.test(m[1]) ? m[1] : null;
  };
  const referencedStorageKeys = new Set<string>();
  const referencedMediaIds = new Set<string>();
  const referencedStems = new Set<string>();
  for (const k of knownFeaturedStorageKeys) referencedStorageKeys.add(k);

  for (const status of ['draft', 'published']) {
    const dir = path.join(options.workspaceRoot, collection, status);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        const detailed = scanArticleMediaDetailed(content);

        let featuredImg: string | undefined;
        try {
          const parsed = parseMarkdown(content);
          featuredImg = parsed.frontmatter.featuredImage ?? undefined;
        } catch {
          const match = content.match(/^featuredImage:\s*["']?([^"'\r\n]+)["']?/m);
          if (match) featuredImg = match[1].trim();
        }

        if (featuredImg) {
          referencedMediaIds.add(featuredImg.trim());
          const ulidMatch = featuredImg.match(/[0-9A-HJ-NP-Z]{26}/i);
          if (ulidMatch) referencedMediaIds.add(ulidMatch[0].toUpperCase());
          const m = featuredImg.match(/(?:^|\/)media\/file\/([^?#]+)/);
          if (m) referencedStorageKeys.add(m[1]);
          const stemMatch = featuredImg.match(/(?:^|\/)media\/(?:drafts\/)?([^/?#]+)/);
          if (stemMatch) referencedStems.add(stemMatch[1].replace(/\.[^.]+$/, ''));
        }

        for (const ref of [
          ...detailed.normalRefs,
          ...detailed.informationalRefs,
          ...detailed.invalidRefs,
        ]) {
          const m = ref.match(/(?:^|\/)media\/file\/([^?#]+)/);
          if (m) {
            referencedStorageKeys.add(m[1]);
            const stem = storageKeyToMarkdownRef(m[1]);
            if (stem) referencedStems.add(stem);
          }
          const localMatch = ref.match(/(?:^|\/)media\/(?:drafts\/)?([^/?#]+)/);
          if (localMatch) {
            const stem = localMatch[1].replace(/\.[^.]+$/, '');
            referencedStems.add(stem);
          }
          const ulidMatch = ref.match(/[0-9A-HJ-NP-Z]{26}/i);
          if (ulidMatch) referencedMediaIds.add(ulidMatch[0].toUpperCase());
        }

        const checkRef = (ref: string): boolean => {
          // Check 1: EmDash public storageKey route: /_emdash/api/media/file/<storageKey>
          const storageKeyMatch = ref.match(/(?:^|\/)media\/file\/([^?#]+)/);
          if (storageKeyMatch) {
            const key = storageKeyMatch[1];
            if (knownStorageKeys.has(key)) return true;
            // The body URL may carry the media record id instead of the storageKey, or a key whose
            // companion YAML lacks the field: resolve by ULID, then by the mirror stem that names the key.
            const ulidMatch = key.match(/[0-9A-HJ-NP-Z]{26}/);
            if (ulidMatch && knownMediaIds.has(ulidMatch[0].toUpperCase())) return true;
            const keyStem = storageKeyToMarkdownRef(key);
            if (keyStem && knownMediaStems.has(keyStem)) return true;
            for (const stem of knownMediaStems) {
              if (key.endsWith(stem)) return true;
            }
            return knownFeaturedStorageKeys.has(key);
          }
          // Check 2: Direct relative or local filesystem path
          const cleanRef = ref.replace(/^[./]+/, '');
          const directFull = path.isAbsolute(ref) ? ref : path.join(options.workspaceRoot, ref);
          if (
            fs.existsSync(directFull) ||
            knownLocalFiles.has(ref) ||
            knownLocalFiles.has(cleanRef)
          ) {
            return true;
          }
          // Check 3: A local mirror reference (`../../media/<storageKey>` or the older depth-free
          // `media/<storageKey>`) names the key outright, so a collision-suffixed or truncated mirror stem
          // leaves no file at that exact path. Resolve it through
          // the same confirmed-key and stem indexes Check 1 uses instead of reporting a mirrored asset missing.
          const localKeyMatch = cleanRef.match(/^media\/([^?#]+)/);
          if (localKeyMatch) {
            const key = localKeyMatch[1];
            if (knownStorageKeys.has(key)) return true;
            const keyStem = storageKeyToMarkdownRef(key);
            if (keyStem && knownMediaStems.has(keyStem)) return true;
          }
          return false;
        };

        for (const ref of detailed.normalRefs) {
          if (checkRef(ref)) continue;
          const source = path.join(collection, status, file);
          const key = options.checkMediaUrls ? probeKey(ref) : null;
          if (key) {
            pendingRemoteProbes.push({ ref, key, source });
          } else {
            missingMedia.push(`${ref} (referenced by ${source})`);
          }
        }

        for (const ref of detailed.informationalRefs) {
          if (!checkRef(ref)) {
            informationalUnresolved.push(
              `${ref} (code-example/custom-block in ${path.join(collection, status, file)})`,
            );
          }
        }

        for (const ref of detailed.invalidRefs) {
          invalidMediaRefs.push(
            `${ref} (malformed reference in ${path.join(collection, status, file)})`,
          );
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Live file-route probe: legacy migrated assets can still be served by /_emdash/api/media/file/
  // even though their media record returns 404, so confirm them against the origin instead of
  // reporting them as missing files that pull-media cannot fetch.
  if (options.checkMediaUrls && pendingRemoteProbes.length > 0) {
    const origin = options.profileOrigin || options.config.origin;
    const probeFetch = options.fetchFn || globalThis.fetch;
    const reachableByKey = new Map<string, boolean>();
    for (const candidate of pendingRemoteProbes) {
      if (reachableByKey.has(candidate.key)) continue;
      let reachable = false;
      try {
        const url = mediaFileEndpoint(origin, candidate.key);
        const res = await probeFetch(url, { method: 'HEAD' });
        reachable = res.ok;
      } catch {
        reachable = false;
      }
      reachableByKey.set(candidate.key, reachable);
    }
    for (const candidate of pendingRemoteProbes) {
      if (reachableByKey.get(candidate.key)) {
        verifiedFileRouteOnly.push(
          `${candidate.ref} (served by the file route but matched by no local mirror or record lookup; referenced by ${candidate.source})`,
        );
      } else {
        unreachableFileRoute.push(`${candidate.ref} (referenced by ${candidate.source})`);
      }
    }
  }

  missingMedia.push(...unreachableFileRoute);

  // Remote library census: the list operation is the only handle that reaches migrated assets, because
  // it is the one endpoint that reports each record's own storageKey and exposes no key filter. A
  // complete walk turns "447 references have no local file" into "the library holds M records, this
  // workspace mirrors K of them", which is what tells a user to widen the window instead of chase data
  // loss. Credentials are required, so plain doctor runs stay offline and skip this block.
  let remoteLibrary: {
    totalCount: number | null;
    complete: boolean;
    mirroredCount: number;
  } | null = null;
  if (options.checkMediaLibrary) {
    const origin = options.profileOrigin || options.config.origin;
    try {
      const index = await collectRemoteStorageKeys({
        workspaceRoot: options.workspaceRoot,
        origin,
        token: options.token || '',
        refreshToken: options.refreshToken,
        fetchFn: options.fetchFn,
      });
      // Live EmDash sends no `totalCount`, so the walk itself is the only library figure available.
      remoteLibrary = {
        totalCount: index.totalCount ?? (index.complete ? index.scannedCount : null),
        complete: index.complete,
        mirroredCount: countMirroredMedia(mediaDir),
      };
    } catch {
      // An unreachable or unauthenticated library is not a workspace defect; doctor stays silent.
    }
  }

  if (missingMedia.length > 0) {
    const coverage = remoteLibrary
      ? remoteLibrary.complete
        ? ` The remote library walk reached ${remoteLibrary.totalCount ?? 'no'} media record(s), and this workspace mirrors ${remoteLibrary.mirroredCount} of them, so most of these references were simply never downloaded.`
        : ` The remote library is larger than the walk that could be completed here, and this workspace mirrors ${remoteLibrary.mirroredCount} record(s), so most of these references were simply never downloaded.`
      : '';
    checks.push({
      id: 'media_references',
      name: 'Media References',
      status: 'warning',
      message:
        `${missingMedia.length} referenced media file(s) are missing from disk.${coverage} ` +
        `Run "emit pull-media --article <id>" for the specific article, or "emit doctor --check-media-library" ` +
        `to size the remote library (metadata-only walk). Reserve "emit pull-media --all" for deliberate full offline backups. ` +
        `Body URLs carry R2 storage keys, so a missing local file does not mean the remote asset is broken: see docs/media-id-spaces.md.`,
      suggestion: options.checkMediaUrls
        ? 'These keys are R2 storage keys, not media record ids, so a file-route hit proves only that the object exists. The full library index is reachable without binary downloads through "emit doctor --check-media-library" (or "emit pull-media --all" for complete offline backup), which reports every storageKey the server holds without any server-side query. Confirm by storageKey before registering anything — a blind INSERT can duplicate an existing record. Emit mirrors records, never repairs server data.'
        : undefined,
      details: missingMedia,
    });
  } else if (remoteLibrary) {
    const notes: string[] = [
      `Remote media library holds ${remoteLibrary.totalCount ?? 'an unknown number of'} record(s); this workspace mirrors ${remoteLibrary.mirroredCount}`,
    ];
    checks.push({
      id: 'media_references',
      name: 'Media References',
      status: 'ok',
      message: notes.join('; '),
    });
  } else if (options.strictMedia && informationalUnresolved.length > 0) {
    checks.push({
      id: 'media_references',
      name: 'Media References',
      status: 'warning',
      message: `${informationalUnresolved.length} informational media reference(s) missing from disk (--strict-media mode).`,
      details: informationalUnresolved,
    });
  } else {
    const notes: string[] = [];
    if (verifiedFileRouteOnly.length > 0) {
      notes.push(
        `${verifiedFileRouteOnly.length} reference(s) served by the remote file route that no local mirror or record lookup matched`,
      );
    }
    if (informationalUnresolved.length > 0) {
      notes.push(
        `${informationalUnresolved.length} informational/custom-block reference(s) ignored`,
      );
    }
    if (invalidMediaRefs.length > 0) {
      notes.push(
        `${invalidMediaRefs.length} malformed reference(s) skipped (not valid media file keys)`,
      );
    }
    checks.push({
      id: 'media_references',
      name: 'Media References',
      status: 'ok',
      message: `All referenced local media files exist on disk.${notes.length ? ` (${notes.join('; ')})` : ''}`,
      ...(verifiedFileRouteOnly.length > 0 ||
      informationalUnresolved.length > 0 ||
      invalidMediaRefs.length > 0
        ? { details: [...verifiedFileRouteOnly, ...informationalUnresolved, ...invalidMediaRefs] }
        : {}),
    });
  }

  // Check: Unreferenced / Isolated Media (v0.1.39 P3)
  const isolatedMedia: Array<{ filePath: string; storageKey?: string; id?: string }> = [];
  for (const [stem, comp] of localCompanions.entries()) {
    const isReferenced =
      (comp.mediaId && referencedMediaIds.has(comp.mediaId.toUpperCase())) ||
      (comp.storageKey && referencedStorageKeys.has(comp.storageKey)) ||
      referencedStems.has(stem);

    if (!isReferenced) {
      isolatedMedia.push({
        filePath: comp.binaryFile || comp.yamlPath,
        storageKey: comp.storageKey,
        id: comp.mediaId,
      });
    }
  }

  const unattributableFiles: string[] = [];
  for (const f of nonYamlMediaFiles) {
    const stem = f.replace(/\.[^.]+$/, '');
    if (!localCompanions.has(stem)) {
      unattributableFiles.push(path.posix.join('media', f));
    }
  }

  const unreferencedDraftFiles: string[] = [];
  for (const df of localDraftFiles) {
    const stem = df.replace(/\.[^.]+$/, '');
    if (!referencedStems.has(stem)) {
      unreferencedDraftFiles.push(path.posix.join('media', 'drafts', df));
    }
  }

  if (isolatedMedia.length > 0 || unreferencedDraftFiles.length > 0) {
    const messages: string[] = [];
    if (isolatedMedia.length > 0) {
      const fileNames = isolatedMedia.map((m) => path.basename(m.filePath));
      const fileListStr =
        fileNames.length <= 3
          ? fileNames.join(', ')
          : `${fileNames.slice(0, 3).join(', ')} and ${fileNames.length - 3} more`;
      messages.push(
        `${isolatedMedia.length} local media file(s) in media/ (${fileListStr}) are not referenced by any article or featuredImage.`,
      );
    }
    if (unreferencedDraftFiles.length > 0) {
      const fileNames = unreferencedDraftFiles.map((f) => path.basename(f));
      const fileListStr =
        fileNames.length <= 3
          ? fileNames.join(', ')
          : `${fileNames.slice(0, 3).join(', ')} and ${fileNames.length - 3} more`;
      messages.push(
        `${unreferencedDraftFiles.length} staging draft file(s) in media/drafts/ (${fileListStr}) are not referenced by any article or featuredImage.`,
      );
    }

    checks.push({
      id: 'media_isolated',
      name: 'Unreferenced Media',
      status: 'ok',
      message: messages.join(' '),
      suggestion:
        'These files exist in media/ with valid metadata or in media/drafts/ for staging, but are not currently embedded in any article body or frontmatter featuredImage. Emit never removes unreferenced files automatically.',
      details: {
        unreferenced: isolatedMedia,
        ...(unattributableFiles.length > 0 ? { unattributable: unattributableFiles } : {}),
        ...(unreferencedDraftFiles.length > 0
          ? {
              draftsStaging: {
                count: unreferencedDraftFiles.length,
                files: unreferencedDraftFiles,
              },
            }
          : {}),
      },
    });
  }
}

/**
 * Runs a comprehensive health diagnostic across the workspace.
 *
 * The three check groups are called in strict sequence, and each appends to the shared `checks` array in
 * the report's documented id order (1, 2, 2b, 2c, 3, 4, 4b, 4c, 4d, 5, 6, 7). Note that logical id order and
 * execution order are not identical: `mcp_process` (Check 7) is pushed inside the synchronous environment
 * group, while the awaited auth probe (2c) and the media group (6) run after it. The `await` positions in
 * this function are what fix the report sequence, so any new check must be placed deliberately. The only side
 * effect kept here is the stale pending-flag auto-clear, which must land between the classification in check
 * 4b and the `conflict_pending_autoclear` push so the sequence stays unchanged.
 */
export async function runWorkspaceDoctor(
  options: RunWorkspaceDoctorOptions,
): Promise<DoctorReport> {
  const collection = options.collection || options.config.defaultCollection || 'posts';
  const currentVersion = getPackageVersion();

  const ctx: DoctorCheckContext = {
    options,
    collection,
    cache: options.cache,
    checks: [],
    conflictItems: listConflicts(options.workspaceRoot, collection),
    allStates: options.cache.getAllSyncStates(),
  };

  runEnvironmentChecks(ctx, currentVersion);

  // Check 2c — the auth probe is awaited here, immediately after the synchronous environment group, which is
  // what places it in the report ahead of the content checks. It never runs unless `checkAuth` was requested,
  // so a plain `emit doctor` still performs zero HTTP requests.
  await runRemoteAuthCheck(ctx);

  runContentIntegrityChecks(ctx, ({ autoClearedBodySlugs, autoClearedTaxSlugs }) => {
    // The original loop cleared each record inline; resolving the slug back to its row reproduces the
    // identical per-kind `clearConflictsByKind` calls without giving the check group write authority.
    const stateForSlug = (slug: string) => ctx.allStates.find((s) => s.slug === slug);
    for (const slug of autoClearedBodySlugs) {
      const state = stateForSlug(slug);
      if (state) options.cache.clearConflictsByKind(state.id, 'body');
    }
    for (const slug of autoClearedTaxSlugs) {
      const state = stateForSlug(slug);
      if (state) options.cache.clearConflictsByKind(state.id, 'taxonomy');
    }
  });

  await runMediaIntegrityChecks(ctx);

  // Determine overall status
  const hasErrors = ctx.checks.some((c) => c.status === 'error');
  const hasWarnings = ctx.checks.some((c) => c.status === 'warning');
  const overallStatus = hasErrors ? 'errors' : hasWarnings ? 'warnings' : 'healthy';

  return {
    workspace: options.workspaceRoot,
    emitVersion: currentVersion,
    createdWithVersion: options.config.createdWithVersion,
    lastSyncedVersion: options.config.lastSyncedVersion,
    overallStatus,
    checks: ctx.checks,
  };
}
