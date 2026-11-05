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
import { loadConfig } from '../utils/config.js';
import { getWorkspacePaths, requireWorkspaceRoot } from '../utils/workspace.js';
import { loadProfilesFile, AmbiguousProfileError } from '../utils/profile.js';
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

export function createMcpServer(options?: CreateMcpServerOptions): McpServer {
  let activeProfileOverride: string | undefined;

  // Helper to resolve workspace context based on optional profile
  const resolveContext: ContextResolver = (targetProfile?: string): ServerContext => {
    const profileToUse = targetProfile || activeProfileOverride;
    let auth;
    try {
      auth = resolveAuth({ profile: profileToUse });
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

    const profilesData = loadProfilesFile();
    const activeProf = profileToUse ? profilesData.profiles[profileToUse] : undefined;
    const origin = activeProf?.origin || auth.origin || 'https://example.com';

    const workspaceRoot =
      options?.workspaceRoot ||
      activeProf?.workspace ||
      process.env.EMDASH_WORKSPACE ||
      requireWorkspaceRoot();

    const paths = getWorkspacePaths(workspaceRoot);
    const cache = options?.cache || new CacheDatabase(paths.dbPath);
    const config = loadConfig(paths.configPath);

    return {
      root: workspaceRoot,
      paths,
      cache,
      config,
      auth,
      origin,
    };
  };

  const server = new McpServer({
    name: 'emit',
    version: getPackageVersion(),
  });

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
