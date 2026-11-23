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
import { ApiError } from '../../client/error.js';
import type { CacheDatabase } from '../../db/cache.js';
import {
  asMediaRecordId,
  toMediaRecordId,
  type MediaRecordId,
  type StorageKey,
} from '../../utils/media-id.js';
import { collectLocalMediaMirrorCandidates, collectLocalMirrorIndex } from './companions.js';
import type { MEDIA_BINARY_EXTENSIONS } from './types.js';
import { MEDIA_BINARY_EXTENSIONS as BINARY_EXTS } from './types.js';

export function expandHomePath(raw: string): string {
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

export function isExplicitLocalPathTarget(raw: string): boolean {
  const trimmed = raw.trim();
  return (
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('~/') ||
    trimmed.startsWith('media/') ||
    trimmed.includes('\\') ||
    trimmed.endsWith('.yaml') ||
    trimmed.endsWith('.yml')
  );
}

export function isInsideMediaDrafts(absPath: string, workspaceRoot: string): boolean {
  const draftsDir = path.resolve(workspaceRoot, 'media', 'drafts');
  const normalized = path.resolve(absPath);
  return normalized.startsWith(draftsDir + path.sep);
}

export function isDirectChildOfMediaDir(absPath: string, workspaceRoot: string): boolean {
  const mediaDir = path.resolve(workspaceRoot, 'media');
  return path.dirname(path.resolve(absPath)) === mediaDir;
}

export function findCompanionBinaryRelPath(
  _workspaceRoot: string,
  mediaDir: string,
  stem: string,
): string | undefined {
  for (const ext of BINARY_EXTS as readonly (typeof MEDIA_BINARY_EXTENSIONS)[number][]) {
    const candidate = path.join(mediaDir, `${stem}${ext}`);
    if (fs.existsSync(candidate)) {
      return path.posix.join('media', path.relative(mediaDir, candidate).split(path.sep).join('/'));
    }
  }
  return undefined;
}

export function readCompanionYamlDoc(yamlAbsPath: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = yaml.load(fs.readFileSync(yamlAbsPath, 'utf8'));
  } catch (err) {
    throw new ApiError({
      message: `Failed to parse companion YAML "${yamlAbsPath}": ${(err as Error).message}`,
      code: 'INVALID_MEDIA_COMPANION',
      suggestion: 'Fix the YAML syntax in the media companion file or run "emit pull-media".',
    });
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ApiError({
      message: `Companion YAML "${yamlAbsPath}" does not contain a valid YAML mapping.`,
      code: 'INVALID_MEDIA_COMPANION',
      suggestion: 'Run "emit pull-media" to restore valid media companion metadata.',
    });
  }
  return doc as Record<string, unknown>;
}

export function findLocalYamlByMediaId(
  mediaDir: string,
  mediaId: MediaRecordId,
  cache?: CacheDatabase,
): string | null {
  const candidates = collectLocalMediaMirrorCandidates(mediaDir);
  const candidate = candidates.get(mediaId);
  if (candidate) {
    const abs = path.join(mediaDir, candidate.metaFile);
    if (fs.existsSync(abs)) return abs;
  }
  const state = cache?.getMediaStateByMediaId(mediaId);
  if (state?.markdownRef) {
    const abs = path.join(path.dirname(mediaDir), `${state.markdownRef}.yaml`);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

export function findLocalYamlByStorageKey(
  workspaceRoot: string,
  mediaDir: string,
  storageKey: StorageKey,
  cache?: CacheDatabase,
): { mediaId: MediaRecordId; yamlAbsPath: string | null } | null {
  const state = cache?.getMediaStateByStorageKey(storageKey);
  if (state?.mediaId) {
    const mediaId = toMediaRecordId(state.mediaId) ?? asMediaRecordId(state.mediaId);
    let yamlAbsPath: string | null = null;
    if (state.markdownRef) {
      const candidate = path.join(workspaceRoot, `${state.markdownRef}.yaml`);
      if (fs.existsSync(candidate)) yamlAbsPath = candidate;
    }
    if (!yamlAbsPath) {
      yamlAbsPath = findLocalYamlByMediaId(mediaDir, mediaId, cache);
    }
    return { mediaId, yamlAbsPath };
  }

  const mirrorIndex = collectLocalMirrorIndex(workspaceRoot, cache);
  const entry = mirrorIndex.get(storageKey);
  if (entry?.mediaId) {
    const mediaId = toMediaRecordId(entry.mediaId) ?? asMediaRecordId(entry.mediaId);
    const yamlAbsPath = findLocalYamlByMediaId(mediaDir, mediaId, cache);
    return { mediaId, yamlAbsPath };
  }

  return null;
}
