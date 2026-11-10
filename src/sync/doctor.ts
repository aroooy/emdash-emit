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
import type { EmitConfig } from '../utils/config.js';
import { getPackageVersion } from '../utils/version.js';
import { parseMarkdown, lenientRepairMarkdownFrontmatter } from '../utils/frontmatter.js';
import { listConflicts } from './conflicts.js';
import { getWorkspaceStatus } from './status.js';
import { scanArticleMediaReferences } from './delete.js';
import { calculateHash } from './pull.js';
import { checkMcpProcess } from '../mcp/heartbeat.js';

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
  collection?: string;
  strictMedia?: boolean;
}

export interface ScannedMediaReferences {
  normalRefs: string[];
  informationalRefs: string[];
}

/**
 * Scans article markdown to separate standard body image references from
 * informational references (code blocks, inline code, HTML comments, or placeholder URLs).
 */
export function scanArticleMediaDetailed(bodyMarkdown: string): ScannedMediaReferences {
  const normalRefs = new Set<string>();
  const informationalRefs = new Set<string>();

  const lines = bodyMarkdown.split('\n');
  let inFence = false;
  let fenceDelimiter = '';

  for (const line of lines) {
    const trimmed = line.trim();
    // Note: Doctor treats both backticks and tildes (~~~) as fences for diagnostic
    // reporting to avoid false warnings on code examples, whereas push guards (G5/G11)
    // strictly exempt only backtick fences per AGENTS.md.
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      if (!inFence) {
        inFence = true;
        fenceDelimiter = trimmed.slice(0, 3);
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
        const isPlaceholder = url.includes('<') && url.includes('>');
        const isInlineCode =
          line.includes('`' + match[0]) ||
          (line.indexOf('`') !== -1 &&
            line.indexOf('`') < match.index &&
            match.index < line.lastIndexOf('`'));
        if (inFence || isInlineCode || isPlaceholder) {
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
        const isPlaceholder = url.includes('<') && url.includes('>');
        if (inFence || isPlaceholder || line.includes('<!--')) {
          informationalRefs.add(url);
        } else {
          normalRefs.add(url);
        }
      }
    }
  }

  return {
    normalRefs: Array.from(normalRefs).sort(),
    informationalRefs: Array.from(informationalRefs).sort(),
  };
}

/**
 * Runs a comprehensive health diagnostic across the workspace.
 */
export async function runWorkspaceDoctor(
  options: RunWorkspaceDoctorOptions,
): Promise<DoctorReport> {
  const collection = options.collection || options.config.defaultCollection || 'posts';
  const checks: DoctorCheckResult[] = [];
  const currentVersion = getPackageVersion();

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
  const conflictItems = listConflicts(options.workspaceRoot, collection);
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
  const allStates = options.cache.getAllSyncStates();
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
      hasDivergence = diskHash !== state.localHash;
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
        options.cache.clearConflictsByKind(state.id, 'body');
        autoClearedBodySlugs.push(state.slug);
      } else {
        manualBodySlugs.push(state.slug);
      }
    }

    // Check taxonomy conflict pending
    if (state.taxonomyConflictPending === 1) {
      const hasConflictCopy = conflictItems.some((c) => c.id === state.id || c.slug === state.slug);
      if (!hasConflictCopy && !hasDivergence) {
        options.cache.clearConflictsByKind(state.id, 'taxonomy');
        autoClearedTaxSlugs.push(state.slug);
      } else {
        manualTaxSlugs.push(state.slug);
      }
    }
  }

  const totalAutoCleared = autoClearedBodySlugs.length + autoClearedTaxSlugs.length;
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
  const wsStatus = getWorkspaceStatus(options.workspaceRoot, options.cache, collection);
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

  // 6. Media References Integrity Check
  // Index all local media companion YAMLs and files to resolve both local paths and storageKey URLs (D1)
  const mediaDir = path.join(options.workspaceRoot, 'media');
  const knownStorageKeys = new Set<string>();
  const knownMediaIds = new Set<string>();
  const knownLocalFiles = new Set<string>();

  if (fs.existsSync(mediaDir)) {
    const mediaFiles = fs.readdirSync(mediaDir);
    for (const f of mediaFiles) {
      knownLocalFiles.add(f);
      knownLocalFiles.add(path.posix.join('media', f));
      if (f.endsWith('.yaml')) {
        try {
          const doc = yaml.load(fs.readFileSync(path.join(mediaDir, f), 'utf8')) as Record<
            string,
            unknown
          > | null;
          if (doc) {
            if (typeof doc.storageKey === 'string' && doc.storageKey) {
              knownStorageKeys.add(doc.storageKey);
            }
            if (typeof doc.id === 'string' && doc.id) {
              knownMediaIds.add(doc.id);
            }
          }
        } catch {
          // ignore corrupted individual yaml
        }
      }
    }
    const draftsDir = path.join(mediaDir, 'drafts');
    if (fs.existsSync(draftsDir)) {
      for (const df of fs.readdirSync(draftsDir)) {
        knownLocalFiles.add(path.posix.join('media', 'drafts', df));
        knownLocalFiles.add(path.posix.join('../../media', 'drafts', df));
      }
    }
  }

  const missingMedia: string[] = [];
  const informationalUnresolved: string[] = [];
  for (const status of ['draft', 'published']) {
    const dir = path.join(options.workspaceRoot, collection, status);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        const detailed = scanArticleMediaDetailed(content);

        const checkRef = (ref: string): boolean => {
          // Check 1: EmDash public storageKey route: /_emdash/api/media/file/<storageKey>
          const storageKeyMatch = ref.match(/(?:^|\/)media\/file\/([^?#]+)/);
          if (storageKeyMatch) {
            const key = storageKeyMatch[1];
            return knownStorageKeys.has(key);
          }
          // Check 2: Direct relative or local filesystem path
          const cleanRef = ref.replace(/^[./]+/, '');
          const directFull = path.isAbsolute(ref) ? ref : path.join(options.workspaceRoot, ref);
          return (
            fs.existsSync(directFull) || knownLocalFiles.has(ref) || knownLocalFiles.has(cleanRef)
          );
        };

        for (const ref of detailed.normalRefs) {
          if (!checkRef(ref)) {
            missingMedia.push(`${ref} (referenced by ${path.join(collection, status, file)})`);
          }
        }

        for (const ref of detailed.informationalRefs) {
          if (!checkRef(ref)) {
            informationalUnresolved.push(
              `${ref} (code-example/placeholder in ${path.join(collection, status, file)})`,
            );
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  if (missingMedia.length > 0) {
    checks.push({
      id: 'media_references',
      name: 'Media References',
      status: 'warning',
      message: `${missingMedia.length} referenced media file(s) are missing from disk.`,
      details: missingMedia,
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
    const infoNote =
      informationalUnresolved.length > 0
        ? ` (${informationalUnresolved.length} informational/placeholder reference(s) ignored)`
        : '';
    checks.push({
      id: 'media_references',
      name: 'Media References',
      status: 'ok',
      message: `All referenced local media files exist on disk.${infoNote}`,
      ...(informationalUnresolved.length > 0 ? { details: informationalUnresolved } : {}),
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

  // Determine overall status
  const hasErrors = checks.some((c) => c.status === 'error');
  const hasWarnings = checks.some((c) => c.status === 'warning');
  const overallStatus = hasErrors ? 'errors' : hasWarnings ? 'warnings' : 'healthy';

  return {
    workspace: options.workspaceRoot,
    emitVersion: currentVersion,
    createdWithVersion: createdWith,
    lastSyncedVersion: lastSynced,
    overallStatus,
    checks,
  };
}
