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

/**
 * Canonical 26-character Crockford Base32 pattern for ULIDs:
 * Excludes I, L, O, and U to prevent human transcription errors.
 */
export const CANONICAL_ULID_PATTERN = '[0-9A-HJ-NP-Z]{26}';

/**
 * Case-insensitive regular expression validating a 26-character canonical ULID string.
 */
export const CANONICAL_ULID_REGEX = /^[0-9A-HJ-NP-Z]{26}$/i;

/**
 * Case-sensitive (uppercase only) regular expression validating a 26-character canonical ULID string.
 */
export const CANONICAL_ULID_EXACT_REGEX = /^[0-9A-HJ-NP-Z]{26}$/;

/**
 * Global matcher for finding 26-character canonical ULIDs within URLs, storageKeys, or filenames.
 */
export const CANONICAL_ULID_GLOBAL_REGEX = /[0-9A-HJ-NP-Z]{26}/gi;

/**
 * Reports whether a value is a valid 26-character canonical Crockford Base32 ULID.
 */
export function isCanonicalUlid(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return CANONICAL_ULID_REGEX.test(value.trim());
}

/**
 * Normalizes a string to uppercase canonical ULID if valid, or returns null.
 */
export function toCanonicalUlid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return CANONICAL_ULID_REGEX.test(trimmed) ? trimmed.toUpperCase() : null;
}

/**
 * Extracts a 26-character ID from a filename stem.
 * Preserves permissive naming rules ([0-9A-Za-z_-]{26}) for legacy compatibility (EMIT naming.ts:203).
 */
export function extractFilenameUlid(filename: string): string | null {
  const baseWithoutDate = filename.replace(/^\d{8}_/, '');
  const match = baseWithoutDate.match(/^([0-9A-Za-z_-]{26})(?:-|\.|$)/);
  return match ? match[1] : null;
}
