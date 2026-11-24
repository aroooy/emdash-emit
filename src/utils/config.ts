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
   * When true (the default), a pulled article writes mirrored body images as article-relative
   * `../../media/<storageKey>` references — the depth derived from the article's own path — so an editor
   * preview renders them from the local mirror. The cache baseline and every remote payload keep the canonical
   * `/_emdash/api/media/file/<storageKey>` URL regardless, so this only changes how the file on disk spells an
   * asset Emit already mirrors.
   */
  localMediaRefs?: boolean;
  /**
   * Opt-in offline media cache: when true, `emit snapshot` downloads remote media binaries
   * into `media/_cache/` (bounded by `snapshotMediaLimit` and `snapshotMediaMaxBytes`) so
   * `emit pull --from-snapshot` can materialize referenced images with 0 network calls.
   */
  snapshotMedia?: boolean;
  snapshotMediaLimit?: number;
  snapshotMediaMaxBytes?: number;
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

export const DEFAULT_CONFIG = {
  origin: DEFAULT_ORIGIN,
  defaultCollection: 'posts',
  defaultLocale: 'ja',
  postsSyncLimit: 30,
  // v0.1.42: the walk bound matches one API page (EmDash caps `limit` at 100), so a routine pull costs a
  // single round-trip instead of three. A workspace with a larger library raises this in `.emit/config.json`.
  mediaSyncLimit: 100,
  concurrency: 8,
  localMediaRefs: true,
  snapshotMedia: false,
  snapshotMediaLimit: 200,
  snapshotMediaMaxBytes: 512 * 1024 * 1024,
} as const satisfies EmitConfig;

/**
 * Initializes a new .emit workspace directory with default config.
 *
 * On a workspace that already has one, the existing values are merged rather than replaced: re-running
 * `emit init` to repair a stale profile link (v0.1.38 P2) must not silently reset limits, locale, or the
 * `localMediaRefs` spelling that `persistLocalMediaRefs` wrote, and it must not rewrite
 * `createdWithVersion` — that field records which release first created the workspace, and doctor's version
 * check reads it. Only the keys named in `initialConfig` change.
 *
 * Returns whether `.emit/.gitignore` was newly created (v0.1.38 P3) so `emit init` can say what it did for
 * Git hygiene without the CLI re-deriving the answer from the filesystem.
 */
export function initWorkspace(
  workspaceRoot: string,
  initialConfig?: Partial<EmitConfig>,
): { gitignoreCreated: boolean } {
  const paths = getWorkspacePaths(workspaceRoot);

  if (!fs.existsSync(paths.emitDir)) {
    fs.mkdirSync(paths.emitDir, { recursive: true });
  }

  const postsDraftDir = path.join(paths.postsDir, 'draft');
  const postsPublishedDir = path.join(paths.postsDir, 'published');
  fs.mkdirSync(postsDraftDir, { recursive: true });
  fs.mkdirSync(postsPublishedDir, { recursive: true });

  const currentVersion = getPackageVersion();

  let existing: Partial<EmitConfig> = {};
  if (fs.existsSync(paths.configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(paths.configPath, 'utf8')) as Partial<EmitConfig>;
    } catch {
      // An unreadable config falls back to defaults rather than aborting init; the rewrite below replaces it.
      existing = {};
    }
  }

  const config: EmitConfig = {
    ...DEFAULT_CONFIG,
    ...existing,
    createdWithVersion: existing.createdWithVersion ?? currentVersion,
    lastSyncedVersion: currentVersion,
    ...initialConfig,
  };

  fs.writeFileSync(paths.configPath, JSON.stringify(config, null, 2), 'utf8');

  // v0.1.38 P3: ship the ignore rules for Emit's own directory. Never touches a file that already exists,
  // and never writes outside `.emit/` — repository-level Git policy stays the user's.
  const { created } = ensureEmitGitignore(paths.emitDir);
  return { gitignoreCreated: created };
}

/**
 * The `.gitignore` Emit ships inside its own `.emit/` directory (v0.1.38 P3).
 *
 * The cache database is machine-local SQLite: committing it bloats the repository and, once a workspace is
 * used on two machines, produces a binary that merges badly and locks each clone to another host's state.
 * `mcp_state.json` does not live under `.emit/` today (it is written to `~/.config/emit/`), but it is
 * included so any future workspace-local persistence of the same kind is excluded by default.
 */
export const EMIT_GITIGNORE_TEMPLATE = [
  '# Emit local cache database (machine-local SQLite — never commit)',
  'cache.db',
  'cache.db-wal',
  'cache.db-shm',
  'cache.db.bak-*',
  'mcp_state.json',
  '',
].join('\n');

/**
 * Creates `.emit/.gitignore` with {@link EMIT_GITIGNORE_TEMPLATE}.
 *
 * An existing file is never touched — not rewritten, not appended to. A user who edited their own ignore
 * rules (or who already excluded these paths) keeps exactly what they wrote, and Emit stays out of Git
 * policy ownership: the repository-level `.gitignore` is deliberately never created or modified, because
 * whether `media/` itself is tracked is the user's call (README §6).
 */
export function ensureEmitGitignore(emitDir: string): { created: boolean; path: string } {
  const gitignorePath = path.join(emitDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    return { created: false, path: gitignorePath };
  }
  fs.writeFileSync(gitignorePath, EMIT_GITIGNORE_TEMPLATE, 'utf8');
  return { created: true, path: gitignorePath };
}

/**
 * Persists the `localMediaRefs` workspace preference into `.emit/config.json`.

 *
 * The setting decides how mirrored body images are spelled on disk, so it must survive across commands: a pull
 * that writes `media/<storageKey>` references has to be matched by every later push and diff. Only touches the
 * one key and leaves the rest of the config untouched.
 */
export function persistLocalMediaRefs(workspaceRoot: string, value: boolean): void {
  try {
    const paths = getWorkspacePaths(workspaceRoot);
    if (!fs.existsSync(paths.configPath)) return;

    const raw = fs.readFileSync(paths.configPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.localMediaRefs = value;
    fs.writeFileSync(paths.configPath, JSON.stringify(parsed, null, 2), 'utf8');
  } catch {
    // Non-fatal if config update fails
  }
}

/**
 * Persists the `snapshotMedia` opt-in preference into `.emit/config.json` (CLI only).
 */
export function persistSnapshotMedia(workspaceRoot: string, value: boolean): void {
  try {
    const paths = getWorkspacePaths(workspaceRoot);
    if (!fs.existsSync(paths.configPath)) return;

    const raw = fs.readFileSync(paths.configPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.snapshotMedia = value;
    fs.writeFileSync(paths.configPath, JSON.stringify(parsed, null, 2), 'utf8');
  } catch {
    // Non-fatal if config update fails
  }
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
      // Local-first media refs are default-ON: a mirrored body image is spelled as an article-relative
      // `../../media/<storageKey>` reference so preview resolves offline. Only an explicit `false` opts back out;
      // an absent key (a workspace predating the setting) now defaults to local refs rather than canonical URLs.
      localMediaRefs: parsed.localMediaRefs ?? DEFAULT_CONFIG.localMediaRefs,
      snapshotMedia: parsed.snapshotMedia ?? DEFAULT_CONFIG.snapshotMedia,
      snapshotMediaLimit: parsed.snapshotMediaLimit ?? DEFAULT_CONFIG.snapshotMediaLimit,
      snapshotMediaMaxBytes: parsed.snapshotMediaMaxBytes ?? DEFAULT_CONFIG.snapshotMediaMaxBytes,
      createdWithVersion: parsed.createdWithVersion,
      lastSyncedVersion: parsed.lastSyncedVersion,
      envOrigin,
    };
  } catch {
    return { ...DEFAULT_CONFIG, envOrigin };
  }
}
