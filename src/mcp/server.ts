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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveAuth } from '../client/auth.js';
import { CacheDatabase } from '../db/cache.js';
import { resolveOriginPriority } from '../cli/context.js';
import { DEFAULT_ORIGIN, getEnvOrigin, loadConfig } from '../utils/config.js';
import { findWorkspaceRoot, getWorkspacePaths, requireWorkspaceRoot } from '../utils/workspace.js';
import {
  findProfileByDirectory,
  loadProfilesFile,
  AmbiguousProfileError,
} from '../utils/profile.js';
import type { ServerContext, ContextResolver, McpMeta } from './context.js';
import { registerProfileTools } from './tools/profile.js';
import { registerSyncNewTool } from './tools/sync-new.js';
import { registerSyncPullTools } from './tools/sync-pull.js';
import { registerSyncPushTool } from './tools/sync-push.js';
import { registerSyncStatusTool } from './tools/sync-status.js';
import { registerSyncDiffTool } from './tools/sync-diff.js';
import { registerSyncDeleteTool } from './tools/sync-delete.js';
import { registerSyncConflictsTool } from './tools/sync-conflicts.js';
import { registerSyncDoctorTool } from './tools/sync-doctor.js';
import { getPackageVersion } from '../utils/version.js';

export interface CreateMcpServerOptions {
  workspaceRoot?: string;
  cache?: CacheDatabase;
  /**
   * Optional custom profiles.yaml path. When provided, every profile lookup performed by this
   * server (explicit profile, cwd-matched profile, and auth resolution) reads only this file
   * instead of the user-level ~/.config/emit/profiles.yaml. This keeps embedded usage and CI
   * runs deterministic: results no longer depend on which sites happen to be configured on the
   * machine executing the process.
   */
  profilesPath?: string;
}

export const EMIT_MCP_INSTRUCTIONS = `
# Emit - AI-First Local Workspace & Sync Engine for EmDash

Emit manages articles, taxonomies, and media as plain files on your local filesystem, backed by a local SQLite cache.

## Local Directory Structure
- posts/published/YYYYMMDD_<ulid>-<title>.md : Published articles in Markdown
- posts/draft/YYYYMMDD_<ulid>-<title>.md : Draft articles in Markdown
- posts/conflicts/<name>.conflict.md : Preserved divergent local copies (read-only rescue content; never an article)
- categories/<id>-<name>.yaml : Category definitions
- tags/<id>-<name>.yaml : Tag definitions
- media/<yyyyMMdd>_<id>-<name>.<ext> & .yaml : Media assets & companion metadata
- media/drafts/<filename> : Staging folder for offline draft images (auto-uploaded on sync_push)

## Rescue Copy Rule (posts/conflicts/)
- sync_pull moves a local file whose content diverged from the remote into posts/conflicts/ before overwriting it, so unpushed writing is never discarded.
- Read rescue copies and merge any valuable content into the canonical article, then delete the copy.
- Never pass a posts/conflicts/ path to sync_push: it is refused with QUARANTINED_COPY_NOT_PUSHABLE because it would overwrite the canonical article with stale content.

## Media & Image Rules (Two Distinct ID Spaces)
- Frontmatter featuredImage uses the 26-character media record id (e.g. "01M67P0MBMJQQXH2K95HHCYRYB") or null.
- Markdown body images use the storageKey-based URL: ![alt](/_emdash/api/media/file/<storageKey>). Never put a media record id in /_emdash/api/media/file/.
- For new local images, place the file in media/drafts/<filename> and reference it on a standalone line: ![alt](../../media/drafts/<filename>). sync_push will automatically upload it, rewrite the Markdown URL, and promote the file into media/.

## AI Workflow (The Golden Path)
1. [CHECK]: Use sync_status to inspect locally tracked articles. Returns a summary-first payload (actionRequired capped at 30 items, recentArticles 5 items). To locate specific articles across the full workspace, use search (title/slug/id/filePath) or slugFilter. If articles are already present locally, do NOT query remote CMS APIs (e.g. emdash MCP tools like content_list).
2. [PULL]: Use sync_pull to sync articles AND taxonomies (categories/tags) from EmDash remote. Batch mode automatically pulls both and returns available taxonomy hints (also returned with postsOnly:true). Use postsOnly:true to skip taxonomies. Use includeMedia:true to also pull media assets.
3. [READ & EDIT]: Read and edit the local Markdown files directly using your standard filesystem tools. Full article content and metadata (title, slug, status, bylines, taxonomies) are stored in the Markdown files.
4. [PUSH]: Use sync_push with filePath to sync your changes to the remote EmDash CMS. If transitioning status from draft to published, pass allowPublish: true.
5. [NEW]: Use sync_new to scaffold a new draft file in posts/draft/ (it returns available categories/tags hints). Rejects duplicates if slug already exists locally or in cache.
6. [DELETE]: Use sync_delete to permanently delete an article from both local workspace and remote CMS. Strictly refuses deletion if unpushed local modifications exist. Requires allowDeletePublished: true for published articles. Automatically saves a rescue copy in posts/conflicts/<file>.deleted.md and preserves referenced media files in media/.
7. [CONFLICTS]: Use sync_conflicts to inspect quarantined sync conflict copies (.conflict.md) and deletion rescue backups (.deleted.md) in posts/conflicts/ (action: 'list' | 'diff' | 'resolve', strategy: 'accept-local' | 'accept-canonical').
8. [DOCTOR]: Use sync_doctor to diagnose workspace health (version compatibility, origin consistency, frontmatter integrity, conflicts/quarantine, and media references).
All tool responses include "_meta" context describing profile, workspace directory, origin, and resolution mechanism.
`.trim();

export function createMcpServer(options?: CreateMcpServerOptions): McpServer {
  let activeProfileOverride: string | undefined;

  // Helper to resolve workspace context based on optional profile
  const resolveContext: ContextResolver = (targetProfile?: string): ServerContext => {
    const profileToUse = targetProfile || activeProfileOverride;
    const profilesData = loadProfilesFile(options?.profilesPath);
    const explicitProf = profileToUse ? profilesData.profiles[profileToUse] : undefined;
    const cwdProf = !profileToUse
      ? findProfileByDirectory(process.cwd(), options?.profilesPath)
      : null;
    const nearestEmitRoot = !profileToUse ? findWorkspaceRoot(process.cwd()) : null;
    const envOrigin = getEnvOrigin();

    const preResolvedWorkspace =
      options?.workspaceRoot ||
      explicitProf?.workspace ||
      cwdProf?.config.workspace ||
      nearestEmitRoot ||
      process.env.EMDASH_WORKSPACE;

    const preConfig = preResolvedWorkspace ? loadConfig(preResolvedWorkspace) : undefined;
    const preConfiguredOrigin =
      preConfig && preConfig.origin !== DEFAULT_ORIGIN ? preConfig.origin : undefined;
    // An explicit EMDASH_ORIGIN is also a valid disambiguation hint for multi-profile setups.
    const preOriginHint = preConfiguredOrigin || envOrigin;

    let auth;
    try {
      auth = resolveAuth({
        profile: profileToUse,
        cwd: preResolvedWorkspace || process.cwd(),
        origin: preOriginHint,
        customProfilesPath: options?.profilesPath,
      });
      if (!auth) {
        throw new Error(
          'No authentication token found. Please run emit profile add or set EMDASH_TOKEN.',
        );
      }
    } catch (err: unknown) {
      if (err instanceof AmbiguousProfileError) {
        throw new Error(
          `Multiple site profiles exist. Please specify a "profile" parameter for this tool. Available profiles: ${err.availableProfiles.join(', ')}`,
        );
      }
      throw err;
    }

    const resolvedProf =
      explicitProf ||
      (auth.profileName ? profilesData.profiles[auth.profileName] : undefined) ||
      cwdProf?.config;
    // An auto-resolved profile may only override the workspace config when none was requested.
    const autoProf = profileToUse ? undefined : resolvedProf;

    const workspaceRoot =
      preResolvedWorkspace || resolvedProf?.workspace || auth.workspace || requireWorkspaceRoot();

    const paths = getWorkspacePaths(workspaceRoot);
    const cache = options?.cache || new CacheDatabase(paths.dbPath);
    const config =
      preConfig && preResolvedWorkspace === workspaceRoot ? preConfig : loadConfig(workspaceRoot);
    const configuredOrigin = config.origin !== DEFAULT_ORIGIN ? config.origin : undefined;
    const resolution = resolveOriginPriority({
      explicitProfileName: profileToUse,
      explicitProfileOrigin: explicitProf?.origin,
      envOrigin,
      configuredOrigin,
      autoProfileOrigin: autoProf?.origin,
      autoProfileName: auth.profileName || cwdProf?.name,
      authOrigin: auth.origin,
    });

    let resolvedBy = 'default';
    if (auth.source === 'env') {
      resolvedBy = 'env';
    } else if (profileToUse) {
      resolvedBy = 'explicit-profile-argument';
    } else if (cwdProf) {
      resolvedBy = 'workspace-directory-match';
    } else if (auth.workspace) {
      resolvedBy = 'workspace-origin-match';
    } else if (auth.source === 'profile') {
      resolvedBy = 'single-profile-fallback';
    } else {
      resolvedBy = auth.source;
    }

    const meta: McpMeta = {
      profile: auth.profileName || activeProfileOverride || 'default',
      workspace: workspaceRoot,
      origin: resolution.origin,
      resolvedBy,
    };

    return {
      root: workspaceRoot,
      paths,
      cache,
      config,
      auth,
      origin: resolution.origin,
      originWarning: resolution.warning || undefined,
      meta,
    };
  };

  const server = new McpServer(
    {
      name: 'emit',
      version: getPackageVersion(),
    },
    {
      instructions: EMIT_MCP_INSTRUCTIONS,
    },
  );

  // Register modular tools
  registerProfileTools(server, {
    getActiveOverride: () => activeProfileOverride,
    setActiveOverride: (name) => {
      activeProfileOverride = name;
    },
    profilesPath: options?.profilesPath,
  });
  registerSyncNewTool(server, resolveContext);
  registerSyncPullTools(server, resolveContext);
  registerSyncPushTool(server, resolveContext);
  registerSyncStatusTool(server, resolveContext);
  registerSyncDiffTool(server, resolveContext);
  registerSyncDeleteTool(server, resolveContext);
  registerSyncConflictsTool(server, resolveContext);
  registerSyncDoctorTool(server, resolveContext);

  return server;
}

/**
 * Runs the MCP server via stdio transport.
 */
export async function runMcpServer(options?: CreateMcpServerOptions): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Auto-run if executed directly as entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  runMcpServer().catch((err) => {
    console.error('Fatal MCP Server error:', err);
    process.exit(1);
  });
}
