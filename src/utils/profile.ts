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
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

export interface ProfileConfig {
  origin: string;
  token: string;
  workspace?: string;
  defaultCollection?: string;
  defaultLocale?: string;
}

export interface ProfilesFile {
  active?: string;
  profiles: Record<string, ProfileConfig>;
}

export function getDefaultProfilesPath(): string {
  return path.join(os.homedir(), '.config', 'emit', 'profiles.yaml');
}

/**
 * Loads the profiles configuration from ~/.config/emit/profiles.yaml.
 * If the file does not exist, returns an empty structure.
 */
export function loadProfilesFile(customPath?: string): ProfilesFile {
  const filePath = customPath || getDefaultProfilesPath();

  if (!fs.existsSync(filePath)) {
    return { profiles: {} };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = yaml.load(raw) as Partial<ProfilesFile> | null;
    if (!parsed || typeof parsed !== 'object') {
      return { profiles: {} };
    }
    const rawProfiles =
      parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {};
    const profiles: Record<string, ProfileConfig> = {};

    for (const [key, prof] of Object.entries(rawProfiles)) {
      if (!prof || typeof prof !== 'object') continue;
      const clean: ProfileConfig = {
        origin: typeof prof.origin === 'string' ? prof.origin : '',
        token: typeof prof.token === 'string' ? prof.token : '',
      };
      if (typeof prof.workspace === 'string' && prof.workspace.trim().length > 0) {
        clean.workspace = prof.workspace.trim();
      }
      if (typeof prof.defaultCollection === 'string' && prof.defaultCollection.trim().length > 0) {
        clean.defaultCollection = prof.defaultCollection.trim();
      }
      if (typeof prof.defaultLocale === 'string' && prof.defaultLocale.trim().length > 0) {
        clean.defaultLocale = prof.defaultLocale.trim();
      }
      profiles[key] = clean;
    }

    return {
      active:
        typeof parsed.active === 'string' && parsed.active.trim().length > 0
          ? parsed.active.trim()
          : undefined,
      profiles,
    };
  } catch (err) {
    throw new Error(`Failed to parse profiles file at ${filePath}: ${(err as Error).message}`);
  }
}

/**
 * Saves the profiles configuration to ~/.config/emit/profiles.yaml with restricted permissions (0600).
 * Explicitly strips undefined/empty optional properties before dumping because js-yaml serializes
 * `{ workspace: undefined }` as `workspace: !<tag:yaml.org,2002:js/undefined> ''` even when skipInvalid: true is set.
 */
export function saveProfilesFile(data: ProfilesFile, customPath?: string): void {
  const filePath = customPath || getDefaultProfilesPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const sanitizedProfiles: Record<string, Record<string, string>> = {};
  for (const [key, prof] of Object.entries(data.profiles)) {
    if (!prof || typeof prof !== 'object') continue;
    const clean: Record<string, string> = {
      origin: prof.origin,
    };
    if (typeof prof.token === 'string' && prof.token.length > 0) {
      clean.token = prof.token;
    }
    if (typeof prof.workspace === 'string' && prof.workspace.trim().length > 0) {
      clean.workspace = prof.workspace.trim();
    }
    if (typeof prof.defaultCollection === 'string' && prof.defaultCollection.trim().length > 0) {
      clean.defaultCollection = prof.defaultCollection.trim();
    }
    if (typeof prof.defaultLocale === 'string' && prof.defaultLocale.trim().length > 0) {
      clean.defaultLocale = prof.defaultLocale.trim();
    }
    sanitizedProfiles[key] = clean;
  }

  const cleanFile: Record<string, unknown> = {};
  if (typeof data.active === 'string' && data.active.trim().length > 0) {
    cleanFile.active = data.active.trim();
  }
  cleanFile.profiles = sanitizedProfiles;

  const dump = yaml.dump(cleanFile, { indent: 2, lineWidth: -1 });
  fs.writeFileSync(filePath, dump, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Discovers which profile matches the given directory (or cwd) based on configured workspace paths.
 * Selects the deepest (longest path) match so nested workspaces are not absorbed by ancestor profiles.
 */
/**
 * Resolves a directory to its physical path so that directory-driven profile detection also works
 * when either side of the comparison goes through a symlink (e.g. macOS `/tmp` -> `/private/tmp`,
 * `/var` -> `/private/var`, or a symlinked `~/blogs` mount).
 *
 * When the path does not exist yet (a profile registered before `emit init`, or a subfolder such as
 * `posts/draft` that has not been created), the deepest existing ancestor is resolved and the
 * remaining segments are re-appended. Mixing `realpath` results with plain `path.resolve` results
 * would otherwise compare `/private/var/...` against `/var/...` and silently lose the match.
 */
function resolveDirectoryForComparison(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    const missingSegments: string[] = [];
    let existingAncestor = resolved;
    while (!fs.existsSync(existingAncestor)) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) return resolved;
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
    try {
      return path.join(fs.realpathSync(existingAncestor), ...missingSegments);
    } catch {
      return resolved;
    }
  }
}

export function findProfileByDirectory(
  dir: string = process.cwd(),
  customPath?: string,
): { name: string; config: ProfileConfig } | null {
  const file = loadProfilesFile(customPath);
  const normalizedTarget = resolveDirectoryForComparison(dir);

  let bestMatch: { name: string; config: ProfileConfig; length: number } | null = null;

  for (const [name, p] of Object.entries(file.profiles)) {
    if (!p.workspace) continue;
    const normalizedWs = resolveDirectoryForComparison(p.workspace);
    // Exact match or subpath of the profile's workspace
    if (normalizedTarget === normalizedWs || normalizedTarget.startsWith(normalizedWs + path.sep)) {
      if (!bestMatch || normalizedWs.length > bestMatch.length) {
        bestMatch = { name, config: p, length: normalizedWs.length };
      }
    }
  }

  return bestMatch ? { name: bestMatch.name, config: bestMatch.config } : null;
}

export interface ResolveProfileOptions {
  profile?: string;
  cwd?: string;
  origin?: string;
  customPath?: string;
}

export interface ResolveProfileResult {
  name: string;
  config: ProfileConfig;
  source: 'explicit' | 'workspace' | 'single' | 'active';
}

/**
 * Robustly resolves a profile:
 * 1. If explicit `options.profile` is passed, returns it (or throws if not found).
 * 2. Checks if `options.cwd` (or process.cwd()) falls inside a profile's `workspace`.
 * 3. If there is exactly one profile defined, auto-selects it.
 * 4. If multiple profiles exist and neither directory nor explicit name matched:
 *    - Throws an AmbiguousProfileError listing available profiles so the caller/AI can specify.
 */
export class AmbiguousProfileError extends Error {
  public availableProfiles: string[];
  constructor(available: string[]) {
    super(
      `Multiple profiles are configured (${available.join(', ')}), but no specific profile was requested and current directory does not match any profile workspace. Please specify the target profile.`,
    );
    this.name = 'AmbiguousProfileError';
    this.availableProfiles = available;
  }
}

export function resolveTargetProfile(options?: ResolveProfileOptions): ResolveProfileResult | null {
  const file = loadProfilesFile(options?.customPath);
  const profileNames = Object.keys(file.profiles);

  if (profileNames.length === 0) {
    return null;
  }

  // 1. Explicit profile specified
  if (options?.profile) {
    const prof = file.profiles[options.profile];
    if (!prof) {
      throw new Error(
        `Profile "${options.profile}" not found. Available profiles: ${profileNames.join(', ')}`,
      );
    }
    return { name: options.profile, config: prof, source: 'explicit' };
  }

  // 2. Auto-match by workspace directory
  const byDir = findProfileByDirectory(options?.cwd, options?.customPath);
  if (byDir) {
    return { name: byDir.name, config: byDir.config, source: 'workspace' };
  }

  // 3. Auto-match by workspace origin (e.g. from .emit/config.json) when unique
  if (options?.origin) {
    const normalizeUrl = (u: string): string => u.trim().replace(/\/+$/, '');
    const targetOrigin = normalizeUrl(options.origin);
    const matchingByOrigin = profileNames.filter(
      (name) => normalizeUrl(file.profiles[name].origin || '') === targetOrigin,
    );
    if (matchingByOrigin.length === 1) {
      const matchedName = matchingByOrigin[0];
      return { name: matchedName, config: file.profiles[matchedName], source: 'workspace' };
    }
  }

  // 4. Exactly one profile exists
  if (profileNames.length === 1) {
    const singleName = profileNames[0];
    return { name: singleName, config: file.profiles[singleName], source: 'single' };
  }

  // 4. Multiple profiles exist and cannot disambiguate automatically
  throw new AmbiguousProfileError(profileNames);
}

/**
 * Gets a specific profile by name, or the active profile if no name is given.
 */
export function getProfile(
  name?: string,
  customPath?: string,
): { name: string; config: ProfileConfig } | null {
  const file = loadProfilesFile(customPath);
  const targetName = name || file.active;

  if (!targetName || !file.profiles[targetName]) {
    return null;
  }

  return {
    name: targetName,
    config: file.profiles[targetName],
  };
}

/**
 * Adds or updates a profile in ~/.config/emit/profiles.yaml.
 * Sets as active if it's the first profile or if makeActive is true.
 */
export function setProfile(
  name: string,
  config: ProfileConfig,
  makeActive = false,
  customPath?: string,
): ProfilesFile {
  const file = loadProfilesFile(customPath);
  file.profiles[name] = config;

  if (makeActive || !file.active || Object.keys(file.profiles).length === 1) {
    file.active = name;
  }

  saveProfilesFile(file, customPath);
  return file;
}

/**
 * Sets the active profile name.
 */
export function setActiveProfile(name: string, customPath?: string): ProfilesFile {
  const file = loadProfilesFile(customPath);
  if (!file.profiles[name]) {
    throw new Error(
      `Profile "${name}" not found. Available profiles: ${Object.keys(file.profiles).join(', ') || 'none'}`,
    );
  }

  file.active = name;
  saveProfilesFile(file, customPath);
  return file;
}

/**
 * Removes a profile. If the removed profile was active, active is cleared or set to another.
 */
export function removeProfile(name: string, customPath?: string): ProfilesFile {
  const file = loadProfilesFile(customPath);
  if (!file.profiles[name]) {
    throw new Error(`Profile "${name}" does not exist.`);
  }

  delete file.profiles[name];
  if (file.active === name) {
    const remaining = Object.keys(file.profiles);
    file.active = remaining.length > 0 ? remaining[0] : undefined;
  }

  saveProfilesFile(file, customPath);
  return file;
}
