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

import path from 'node:path';
import { VALID_MEDIA_FILE_KEY } from './media-refs.js';

export const DEFAULT_SNAPSHOT_MEDIA_LIMIT = 200;
export const DEFAULT_SNAPSHOT_MEDIA_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Returns the path to Emit's owned offline media cache directory (`media/_cache`).
 */
export function mediaCacheDir(mediaDir: string): string {
  return path.join(mediaDir, '_cache');
}

/**
 * Single source of truth for reserved subdirectories under `media/` that must never be
 * treated as mirrored assets or unattributable media files by doctor/search/pruning.
 */
export function isReservedMediaSubdir(name: string): boolean {
  return name === 'drafts' || name === '_trash' || name === '_cache';
}

/**
 * Validates `storageKey` against `VALID_MEDIA_FILE_KEY` and returns its flat basename for
 * `media/_cache/<basename>`. Slash-bearing migrated keys fail validation and return `null`
 * (declared non-scope to avoid basename collisions).
 */
export function toMediaCacheFileName(storageKey: string | null | undefined): string | null {
  if (!storageKey) return null;
  const trimmed = storageKey.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) return null;
  if (!VALID_MEDIA_FILE_KEY.test(trimmed)) return null;
  return path.posix.basename(trimmed);
}
