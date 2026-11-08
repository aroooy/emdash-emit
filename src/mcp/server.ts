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
import { DEFAULT_ORIGIN, loadConfig } from '../utils/config.js';
import { findWorkspaceRoot, getWorkspacePaths, requireWorkspaceRoot } from '../utils/workspace.js';
import {
  findProfileByDirectory,
  loadProfilesFile,
  AmbiguousProfileError,
} from '../utils/profile.js';
import type { ServerContext, ContextResolver } from './context.js';
import { registerProfileTools } from './tools/profile.js';
import { registerSyncNewTool } from './tools/sync-new.js';
import { registerSyncPullTools } from './tools/sync-pull.js';
import { registerSyncPushTool } from './tools/sync-push.js';
import { registerSyncStatusTool } from './tools/sync-status.js';
import { registerSyncDiffTool } from './tools/sync-diff.js';
import { getPackageVersion } from '../utils/version.js';

export interface CreateMcpServerOptions {
  workspaceRoot?: string;
  cache?: CacheDatabase;
}

export const EMIT_MCP_INSTRUCTIONS = `
# Emit - AI-First Local Workspace & Sync Engine for EmDash

Emit manages articles, taxonomies, and media as plain files on your local filesystem, backed by a local SQLite cache.

## Local Directory Structure
- posts/published/YYYYMMDD_<ulid>-<title>.md : Published articles in Markdown
- posts/draft/YYYYMMDD_<ulid>-<title>.md : Draft articles in Markdown
- categories/<id>-<name>.yaml : Category definitions
- tags/<id>-<name>.yaml : Tag definitions
- media/<yyyyMMdd>_<id>-<name>.<ext> & .yaml : Media assets & companion metadata
- media/drafts/<filename> : Staging folder for offline draft images (auto-uploaded on sync_push)

## Media & Image Rules (Two Distinct ID Spaces)
- Frontmatter featuredImage uses the 26-character media record id (e.g. "01M67P0MBMJQQXH2K95HHCYRYB") or null.
- Markdown body images use the storageKey-based URL: ![alt](/_emdash/api/media/file/<storageKey>). Never put a media record id in /_emdash/api/media/file/.
- For new local images, place the file in media/drafts/<filename> and reference it on a standalone line: ![alt](../../media/drafts/<filename>). sync_push will automatically upload it, rewrite the Markdown URL, and promote the file into media/.

## AI Workflow (The Golden Path)
1. [CHECK]: Use sync_status to list locally tracked articles and their file paths (returned newest-first, descending by date). If articles are already present locally, do NOT query remote CMS APIs (e.g. emdash MCP tools like content_list).
2. [PULL]: Use sync_pull to sync articles AND taxonomies (categories/tags) from EmDash remote. Batch mode automatically pulls both and returns available taxonomy hints (also returned with postsOnly:true). Use postsOnly:true to skip taxonomies. Use includeMedia:true to also pull media assets.
3. [READ & EDIT]: Read and edit the local Markdown files directly using your standard filesystem tools. Full article content and metadata (title, slug, status, bylines, taxonomies) are stored in the Markdown files.
4. [PUSH]: Use sync_push with filePath to sync your changes to the remote EmDash CMS. If transitioning status from draft to published, pass allowPublish: true.
5. [NEW]: Use sync_new to scaffold a new draft file in posts/draft/ (it returns available categories/tags hints), edit it locally, and push when ready.
`.trim();

export function createMcpServer(options?: CreateMcpServerOptions): McpServer {
  let activeProfileOverride: string | undefined;

  // Helper to resolve workspace context based on optional profile
  const resolveContext: ContextResolver = (targetProfile?: string): ServerContext => {
    const profileToUse = targetProfile || activeProfileOverride;
    const profilesData = loadProfilesFile();
    const explicitProf = profileToUse ? profilesData.profiles[profileToUse] : undefined;
    const cwdProf = !profileToUse ? findProfileByDirectory(process.cwd()) : null;
    const nearestEmitRoot = !profileToUse ? findWorkspaceRoot(process.cwd()) : null;

    const preResolvedWorkspace =
      options?.workspaceRoot ||
      explicitProf?.workspace ||
      cwdProf?.config.workspace ||
      nearestEmitRoot ||
      process.env.EMDASH_WORKSPACE;

    const preConfig = preResolvedWorkspace ? loadConfig(preResolvedWorkspace) : undefined;
    const preOriginHint =
      preConfig && preConfig.origin !== DEFAULT_ORIGIN ? preConfig.origin : undefined;

    let auth;
    try {
      auth = resolveAuth({
        profile: profileToUse,
        cwd: preResolvedWorkspace || process.cwd(),
        origin: preOriginHint,
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

    const workspaceRoot =
      preResolvedWorkspace || resolvedProf?.workspace || auth.workspace || requireWorkspaceRoot();

    const paths = getWorkspacePaths(workspaceRoot);
    const cache = options?.cache || new CacheDatabase(paths.dbPath);
    const config =
      preConfig && preResolvedWorkspace === workspaceRoot ? preConfig : loadConfig(workspaceRoot);
    const configuredOrigin = config.origin !== DEFAULT_ORIGIN ? config.origin : undefined;
    const origin = resolvedProf?.origin || auth.origin || configuredOrigin || DEFAULT_ORIGIN;

    return {
      root: workspaceRoot,
      paths,
      cache,
      config,
      auth,
      origin,
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
  });
  registerSyncNewTool(server, resolveContext);
  registerSyncPullTools(server, resolveContext);
  registerSyncPushTool(server, resolveContext);
  registerSyncStatusTool(server, resolveContext);
  registerSyncDiffTool(server, resolveContext);

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
