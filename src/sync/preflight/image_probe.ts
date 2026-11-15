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
import { MAX_MEDIA_UPLOAD_BYTES, resolveImageMimeType } from '../../client/media.js';

export type LocalImageProbeFailureReason =
  | { code: 'MISSING_LOCAL_IMAGE_FILE'; reason: 'not_found' | 'not_regular_file' }
  | { code: 'INVALID_LOCAL_IMAGE_TYPE' }
  | { code: 'LOCAL_IMAGE_SIZE_EXCEEDED'; sizeBytes: number; maxBytes: number };

export type LocalImageProbeResult =
  { ok: true; sizeBytes: number } | { ok: false; failure: LocalImageProbeFailureReason };

/**
 * Probes a local draft image path for existence, regular file type, supported image MIME extension,
 * and upload size limit (`MAX_MEDIA_UPLOAD_BYTES`, default 50 MiB).
 *
 * Callers that need to check `findAlreadyPromotedMedia` on missing files (such as `runPreflightChecks`)
 * may check `fs.existsSync(absPath)` before invoking this helper; if `absPath` does not exist when
 * `statSync` runs, `ENOENT` is caught and returned as `{ code: 'MISSING_LOCAL_IMAGE_FILE', reason: 'not_found' }`.
 */
export function probeLocalImageFile(
  absPath: string,
  filename: string,
  maxBytes: number = MAX_MEDIA_UPLOAD_BYTES,
  customFs: typeof fs = fs,
): LocalImageProbeResult {
  let stat: fs.Stats;
  try {
    stat = customFs.statSync(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {
        ok: false,
        failure: { code: 'MISSING_LOCAL_IMAGE_FILE', reason: 'not_found' },
      };
    }
    throw err;
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      failure: { code: 'MISSING_LOCAL_IMAGE_FILE', reason: 'not_regular_file' },
    };
  }
  if (!resolveImageMimeType(filename)) {
    return {
      ok: false,
      failure: { code: 'INVALID_LOCAL_IMAGE_TYPE' },
    };
  }
  if (stat.size > maxBytes) {
    return {
      ok: false,
      failure: {
        code: 'LOCAL_IMAGE_SIZE_EXCEEDED',
        sizeBytes: stat.size,
        maxBytes,
      },
    };
  }
  return { ok: true, sizeBytes: stat.size };
}
