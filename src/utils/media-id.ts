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

/**
 * Unvalidated cast kept only for call sites that have already proven the value is a record id through
 * confirmed metadata (a `media_state` row written by Emit, or a companion YAML `id:`). New code should go
 * through `toMediaRecordId`, which refuses anything that is not a canonical ULID.
 */
export function asMediaRecordId(value: string): MediaRecordId {
  return value as MediaRecordId;
}

/**
 * Unvalidated cast for storage keys, mirroring `asMediaRecordId`: the brand is granted without checking the
 * key shape. During gradual adoption it is used where a value already flows from a source Emit trusts (an
 * upload target, a cached `media_state` row) and strict validation would abort otherwise-safe pushes; those
 * sites are scheduled to move to `toStorageKey` in a later pass. New code should prefer `toStorageKey`.
 */
export function asStorageKey(value: string): StorageKey {
  return value as StorageKey;
}

export function isMediaRecordId(value: unknown): value is MediaRecordId {
  return isCanonicalUlid(value);
}

/** Image extensions a storageKey may carry, matching the mirror naming rule. */
const STORAGE_KEY_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg']);

/**
 * Validates and normalizes a raw value into a `StorageKey`.
 *
 * A storageKey is the R2 object key that a canonical body URL addresses: exactly one path segment ending in
 * a known image extension, with ULID-shaped segments (`<ulid>.<ext>` or `<ulid1>.<ulid2>.<ext>`). Migrated
 * corpora also carry path-shaped keys (`uploads/2026/11/sample.png`), which are accepted as-is because they
 * are the key the server itself reports. Returns null for anything with no usable key at all — an empty or
 * whitespace-only value, a multi-segment value that is not a plain key, or a key carrying no extension Emit
 * recognizes as media.
 */
export function toStorageKey(value: unknown): StorageKey | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/[?#]/.test(trimmed)) return null;
  const segments = trimmed.replace(/\\/g, '/').split('/');
  if (segments.some((segment) => !segment)) return null;
  const last = segments[segments.length - 1];
  const extMatch = last.match(/\.[A-Za-z0-9]+$/);
  if (!extMatch) return null;
  if (!STORAGE_KEY_EXTENSIONS.has(extMatch[0].toLowerCase())) return null;
  return trimmed as StorageKey;
}

/**
 * Validates a raw value and returns it as a `MediaRecordId`, or null when it is not a canonical 26-character
 * ULID. Unlike `asMediaRecordId`, this never trusts the caller: the brand is only granted to values that are
 * provably record ids, so a storageKey-shaped or truncated value cannot be laundered into one.
 */
export function toMediaRecordId(value: unknown): MediaRecordId | null {
  if (!isCanonicalUlid(value)) return null;
  return (value as string).trim().toUpperCase() as MediaRecordId;
}
