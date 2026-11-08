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

export interface EmitConfig {
  origin: string;
  defaultCollection: string;
  defaultLocale: string;
  syncLimit?: number; // legacy fallback for posts
  postsSyncLimit?: number;
  mediaSyncLimit?: number;
  concurrency?: number;
}

export const DEFAULT_ORIGIN = 'https://example.com';

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

  const config: EmitConfig = {
    ...DEFAULT_CONFIG,
    ...initialConfig,
  };

  fs.writeFileSync(paths.configPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Loads the EmitConfig from the active workspace.
 */
export function loadConfig(workspaceRoot?: string): EmitConfig {
  const root = workspaceRoot || requireWorkspaceRoot();
  const paths = getWorkspacePaths(root);

  if (!fs.existsSync(paths.configPath)) {
    return {
      ...DEFAULT_CONFIG,
      origin: process.env.EMDASH_ORIGIN || DEFAULT_CONFIG.origin,
    };
  }

  try {
    const raw = fs.readFileSync(paths.configPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<EmitConfig>;
    return {
      origin: process.env.EMDASH_ORIGIN || parsed.origin || DEFAULT_CONFIG.origin,
      defaultCollection: parsed.defaultCollection || DEFAULT_CONFIG.defaultCollection,
      defaultLocale: parsed.defaultLocale || DEFAULT_CONFIG.defaultLocale,
      postsSyncLimit: parsed.postsSyncLimit || DEFAULT_CONFIG.postsSyncLimit,
      mediaSyncLimit: parsed.mediaSyncLimit || DEFAULT_CONFIG.mediaSyncLimit,
      concurrency: parsed.concurrency || DEFAULT_CONFIG.concurrency,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}
