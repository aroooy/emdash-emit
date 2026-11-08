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
import { DEFAULT_ORIGIN, getEnvOrigin, loadConfig, type EmitConfig } from '../utils/config.js';
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

/** Compares origins ignoring surrounding whitespace and trailing slashes. */
export const normalizeOrigin = (value: string): string => value.trim().replace(/\/+$/, '');
export const sameOrigin = (a: string, b: string): boolean =>
  normalizeOrigin(a) === normalizeOrigin(b);

export interface OriginSources {
  /** Explicitly selected profile name (`--profile` / MCP `profile` parameter), if any. */
  explicitProfileName?: string;
  /** Origin of the explicitly selected profile. */
  explicitProfileOrigin?: string;
  /** `EMDASH_ORIGIN` override, kept separate from the workspace config value. */
  envOrigin?: string;
  /** Origin written in `.emit/config.json` (already filtered to undefined when DEFAULT_ORIGIN). */
  configuredOrigin?: string;
  /** Origin of the automatically resolved profile (cwd match / unique origin match / single). */
  autoProfileOrigin?: string;
  autoProfileName?: string;
  /** Origin carried by the resolved auth (env token, emdash-cli auth.json, emit credentials). */
  authOrigin?: string;
}

export interface OriginResolution {
  origin: string;
  warning: string | null;
}

/**
 * Resolves the effective origin and returns an actionable warning whenever a higher-precedence
 * source silently overrides a lower one.
 *
 * Precedence (most explicit first):
 *   explicit --profile > EMDASH_ORIGIN > auto-resolved profile > resolved auth origin
 *   > .emit/config.json > DEFAULT_ORIGIN
 *
 * `EMDASH_ORIGIN` outranks an *implicitly* resolved profile so CI/staging overrides actually take
 * effect, while an *explicitly* selected profile outranks the ambient env var because it is a
 * deliberate in-band instruction. Every conflict is surfaced instead of swallowed.
 */
export function resolveOriginPriority(sources: OriginSources): OriginResolution {
  const {
    explicitProfileName,
    explicitProfileOrigin,
    envOrigin,
    configuredOrigin,
    autoProfileOrigin,
    autoProfileName,
    authOrigin,
  } = sources;
  const profileLabel = autoProfileName ? `"${autoProfileName}"` : 'the resolved profile';

  // 1. Explicitly selected profile wins, but a conflicting override must still be reported.
  if (explicitProfileOrigin) {
    if (envOrigin && !sameOrigin(envOrigin, explicitProfileOrigin)) {
      return {
        origin: explicitProfileOrigin,
        warning: `⚠️ Warning: EMDASH_ORIGIN (${envOrigin}) is ignored because profile "${explicitProfileName}" was explicitly selected (origin ${explicitProfileOrigin}). Unset EMDASH_ORIGIN if this is unintended.`,
      };
    }
    if (configuredOrigin && !sameOrigin(configuredOrigin, explicitProfileOrigin)) {
      return {
        origin: explicitProfileOrigin,
        warning: `⚠️ Warning: Workspace .emit/config.json origin (${configuredOrigin}) differs from explicitly selected profile "${explicitProfileName}" origin (${explicitProfileOrigin}). Using profile origin; drop --profile to target the workspace instead.`,
      };
    }
    return { origin: explicitProfileOrigin, warning: null };
  }

  // 2. EMDASH_ORIGIN override beats an auto-resolved profile / workspace config.
  if (envOrigin) {
    if (autoProfileOrigin && !sameOrigin(envOrigin, autoProfileOrigin)) {
      return {
        origin: envOrigin,
        warning: `⚠️ Warning: EMDASH_ORIGIN (${envOrigin}) overrides ${profileLabel} origin (${autoProfileOrigin}). Writes now target EMDASH_ORIGIN; unset it or pass --profile <name> to use ${autoProfileOrigin}.`,
      };
    }
    if (configuredOrigin && !sameOrigin(envOrigin, configuredOrigin)) {
      return {
        origin: envOrigin,
        warning: `⚠️ Warning: EMDASH_ORIGIN (${envOrigin}) overrides Workspace .emit/config.json origin (${configuredOrigin}). Unset EMDASH_ORIGIN if this is unintended.`,
      };
    }
    return { origin: envOrigin, warning: null };
  }

  // 3. Auto-resolved profile wins over the workspace config, with a mismatch warning.
  if (autoProfileOrigin) {
    if (configuredOrigin && !sameOrigin(configuredOrigin, autoProfileOrigin)) {
      return {
        origin: autoProfileOrigin,
        warning: `⚠️ Warning: Workspace .emit/config.json origin (${configuredOrigin}) differs from resolved profile ${profileLabel} origin (${autoProfileOrigin}). Using profile origin (${autoProfileOrigin}); pass --profile <name> or update .emit/config.json if this is unintended.`,
      };
    }
    return { origin: autoProfileOrigin, warning: null };
  }

  // 4. Auth-carried origin (emdash-cli / emit credentials / env token without EMDASH_ORIGIN).
  if (authOrigin) {
    return { origin: authOrigin, warning: null };
  }

  // 5. Workspace config, then the sentinel default.
  if (configuredOrigin) {
    return { origin: configuredOrigin, warning: null };
  }
  return { origin: DEFAULT_ORIGIN, warning: null };
}

export function createCliContextResolver(): CliContextResolver {
  return (profileName?: string): CliContext => {
    const profilesData = loadProfilesFile();
    const explicitProf = profileName ? profilesData.profiles[profileName] : undefined;
    const cwdProf = !profileName ? findProfileByDirectory(process.cwd()) : null;
    const nearestEmitRoot = !profileName ? findWorkspaceRoot(process.cwd()) : null;
    const envOrigin = getEnvOrigin();

    const preResolvedWorkspace =
      explicitProf?.workspace ||
      cwdProf?.config.workspace ||
      nearestEmitRoot ||
      process.env.EMDASH_WORKSPACE;

    const preConfig = preResolvedWorkspace ? loadConfig(preResolvedWorkspace) : undefined;
    const preConfiguredOrigin =
      preConfig && preConfig.origin !== DEFAULT_ORIGIN ? preConfig.origin : undefined;
    // An explicit EMDASH_ORIGIN is also a valid disambiguation hint for multi-profile setups.
    const preOriginHint = preConfiguredOrigin || envOrigin;

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
    // An auto-resolved profile may only override the workspace config when none was requested.
    const autoProf = profileName ? undefined : resolvedProf;

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
    const resolution = resolveOriginPriority({
      explicitProfileName: profileName,
      explicitProfileOrigin: explicitProf?.origin,
      envOrigin,
      configuredOrigin,
      autoProfileOrigin: autoProf?.origin,
      autoProfileName: auth.profileName || cwdProf?.name,
      authOrigin: auth.origin,
    });
    if (resolution.warning) {
      console.warn(resolution.warning);
    }

    return {
      root: workspaceRoot,
      paths,
      cache,
      config,
      auth,
      origin: resolution.origin,
    };
  };
}
