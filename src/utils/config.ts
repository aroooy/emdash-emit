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
import { getWorkspacePaths, requireWorkspaceRoot } from './workspace.js';
import { getPackageVersion } from './version.js';

export interface EmitConfig {
  /** Origin written in `.emit/config.json`, or DEFAULT_ORIGIN when unset. Never mixed with env. */
  origin: string;
  defaultCollection: string;
  defaultLocale: string;
  syncLimit?: number; // legacy fallback for posts
  postsSyncLimit?: number;
  mediaSyncLimit?: number;
  concurrency?: number;
  /**
   * Package version that initialized this workspace.
   */
  createdWithVersion?: string;
  /**
   * Package version of the most recent successful pull or push operation.
   */
  lastSyncedVersion?: string;
  /**
   * Runtime-only view of `EMDASH_ORIGIN`, kept separate from `origin` so diagnostics can state
   * which source a value came from. Never persisted by `initWorkspace`.
   */
  envOrigin?: string;
}

export const DEFAULT_ORIGIN = 'https://example.com';

/**
 * Returns the trimmed `EMDASH_ORIGIN` override, or undefined when unset.
 */
export function getEnvOrigin(): string | undefined {
  const value = process.env.EMDASH_ORIGIN?.trim();
  return value ? value : undefined;
}

const DEFAULT_CONFIG: EmitConfig = {
  origin: DEFAULT_ORIGIN,
  defaultCollection: 'posts',
  defaultLocale: 'ja',
  postsSyncLimit: 100,
  mediaSyncLimit: 300,
  concurrency: 8,
};

/**
 * Initializes a new .emit workspace directory with default config.
 */
export function initWorkspace(workspaceRoot: string, initialConfig?: Partial<EmitConfig>): void {
  const paths = getWorkspacePaths(workspaceRoot);

  if (!fs.existsSync(paths.emitDir)) {
    fs.mkdirSync(paths.emitDir, { recursive: true });
  }

  const postsDraftDir = path.join(paths.postsDir, 'draft');
  const postsPublishedDir = path.join(paths.postsDir, 'published');
  fs.mkdirSync(postsDraftDir, { recursive: true });
  fs.mkdirSync(postsPublishedDir, { recursive: true });

  const currentVersion = getPackageVersion();
  const config: EmitConfig = {
    ...DEFAULT_CONFIG,
    createdWithVersion: currentVersion,
    lastSyncedVersion: currentVersion,
    ...initialConfig,
  };

  fs.writeFileSync(paths.configPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Updates `lastSyncedVersion` in `.emit/config.json` after a successful sync operation.
 */
export function updateConfigSyncedVersion(workspaceRoot: string, version?: string): void {
  try {
    const paths = getWorkspacePaths(workspaceRoot);
    if (!fs.existsSync(paths.configPath)) return;

    const raw = fs.readFileSync(paths.configPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const currentVersion = version || getPackageVersion();
    parsed.lastSyncedVersion = currentVersion;
    if (!parsed.createdWithVersion) {
      parsed.createdWithVersion = currentVersion;
    }
    fs.writeFileSync(paths.configPath, JSON.stringify(parsed, null, 2), 'utf8');
  } catch {
    // Non-fatal if config update fails
  }
}

/**
 * Loads the EmitConfig from the active workspace.
 */
export function loadConfig(workspaceRoot?: string): EmitConfig {
  const root = workspaceRoot || requireWorkspaceRoot();
  const paths = getWorkspacePaths(root);
  const envOrigin = getEnvOrigin();

  if (!fs.existsSync(paths.configPath)) {
    return {
      ...DEFAULT_CONFIG,
      envOrigin,
    };
  }

  try {
    const raw = fs.readFileSync(paths.configPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<EmitConfig>;
    return {
      origin: parsed.origin || DEFAULT_CONFIG.origin,
      defaultCollection: parsed.defaultCollection || DEFAULT_CONFIG.defaultCollection,
      defaultLocale: parsed.defaultLocale || DEFAULT_CONFIG.defaultLocale,
      postsSyncLimit: parsed.postsSyncLimit || DEFAULT_CONFIG.postsSyncLimit,
      mediaSyncLimit: parsed.mediaSyncLimit || DEFAULT_CONFIG.mediaSyncLimit,
      concurrency: parsed.concurrency || DEFAULT_CONFIG.concurrency,
      createdWithVersion: parsed.createdWithVersion,
      lastSyncedVersion: parsed.lastSyncedVersion,
      envOrigin,
    };
  } catch {
    return { ...DEFAULT_CONFIG, envOrigin };
  }
}
