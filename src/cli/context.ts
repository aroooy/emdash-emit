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

import { CacheDatabase } from '../db/cache.js';
import { resolveAuth, type ResolvedAuth } from '../client/auth.js';
import {
  findWorkspaceRoot,
  getWorkspacePaths,
  requireWorkspaceRoot,
  type WorkspacePaths,
} from '../utils/workspace.js';
import { DEFAULT_ORIGIN, loadConfig, type EmitConfig } from '../utils/config.js';
import {
  findProfileByDirectory,
  loadProfilesFile,
  AmbiguousProfileError,
} from '../utils/profile.js';

export interface CliContext {
  root: string;
  paths: WorkspacePaths;
  cache: CacheDatabase;
  config: EmitConfig;
  auth: ResolvedAuth;
  origin: string;
}

export type CliContextResolver = (profileName?: string) => CliContext;

export function createCliContextResolver(): CliContextResolver {
  return (profileName?: string): CliContext => {
    const profilesData = loadProfilesFile();
    const explicitProf = profileName ? profilesData.profiles[profileName] : undefined;
    const cwdProf = !profileName ? findProfileByDirectory(process.cwd()) : null;
    const nearestEmitRoot = !profileName ? findWorkspaceRoot(process.cwd()) : null;

    const preResolvedWorkspace =
      explicitProf?.workspace ||
      cwdProf?.config.workspace ||
      nearestEmitRoot ||
      process.env.EMDASH_WORKSPACE;

    const preConfig = preResolvedWorkspace ? loadConfig(preResolvedWorkspace) : undefined;
    const preOriginHint =
      preConfig && preConfig.origin !== DEFAULT_ORIGIN ? preConfig.origin : undefined;

    let auth: ResolvedAuth;
    try {
      const resolved = resolveAuth({
        profile: profileName,
        cwd: preResolvedWorkspace || process.cwd(),
        origin: preOriginHint,
      });
      if (!resolved) {
        console.error('❌ Error: No authentication found.');
        console.error('   Please run "emit profile add <name> --origin <url> --token <token>"');
        console.error('   or set EMDASH_TOKEN environment variable.');
        process.exit(1);
      }
      auth = resolved;
    } catch (err: unknown) {
      if (err instanceof AmbiguousProfileError) {
        console.error(`\n❌ Error: ${err.message}`);
        console.error('   Please specify a profile with --profile <name>.');
        console.error(`   Available profiles: ${err.availableProfiles.join(', ')}\n`);
        process.exit(1);
      }
      throw err;
    }

    const resolvedProf =
      explicitProf ||
      (auth.profileName ? profilesData.profiles[auth.profileName] : undefined) ||
      cwdProf?.config;

    let workspaceRoot: string;
    try {
      workspaceRoot =
        preResolvedWorkspace || resolvedProf?.workspace || auth.workspace || requireWorkspaceRoot();
    } catch {
      console.error('❌ Error: Current directory is not inside an Emit workspace.');
      console.error('   Run "emit init" to initialize this directory, or "cd" into a workspace.');
      process.exit(1);
    }

    const paths = getWorkspacePaths(workspaceRoot);
    const cache = new CacheDatabase(paths.dbPath);
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
}
