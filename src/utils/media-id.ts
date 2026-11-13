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

import { isCanonicalUlid } from './ulid.js';

/**
 * EmDash media record primary key (D1 database record ID).
 * Always a 26-character canonical Crockford Base32 ULID.
 */
export type MediaRecordId = string & { readonly __brand: 'MediaRecordId' };

/**
 * EmDash public R2 storage key (object key on Cloudflare R2).
 * Formatted as `<ulid>.<ext>` or `<ulid1>.<ulid2>.<ext>`.
 */
export type StorageKey = string & { readonly __brand: 'StorageKey' };

export function asMediaRecordId(value: string): MediaRecordId {
  return value as MediaRecordId;
}

export function asStorageKey(value: string): StorageKey {
  return value as StorageKey;
}

export function isMediaRecordId(value: unknown): value is MediaRecordId {
  return isCanonicalUlid(value);
}
