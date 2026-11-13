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
import { extractFilenameUlid } from './ulid.js';

/**
 * Default maximum UTF-8 byte length for the title portion in generated filenames.
 * Standard article filename: <yyyyMMdd_ (9B)><ulid (26B)>-<title (<=120B)>.md (3B) = <=158B,
 * which comfortably fits within the 255-byte POSIX NAME_MAX limit on Linux/ext4.
 */
export const DEFAULT_MAX_TITLE_BYTES = 120;

/**
 * Truncates a string to at most `maxBytes` UTF-8 bytes without splitting multi-byte Unicode code points.
 */
export function truncateUtf8Bytes(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) {
    return str;
  }
  let result = '';
  for (const char of str) {
    if (Buffer.byteLength(result + char, 'utf8') > maxBytes) {
      break;
    }
    result += char;
  }
  return result;
}

/**
 * Sanitizes a title or slug for safe, cross-platform inclusion in a filename.
 * Decodes basic HTML entities, removes invalid filesystem characters, collapses hyphens,
 * and cleanly truncates to `maxBytes` UTF-8 bytes without breaking multi-byte characters.
 */
export function sanitizeTitleForFilename(
  title: string,
  maxBytes: number = DEFAULT_MAX_TITLE_BYTES,
): string {
  if (!title || !title.trim()) {
    return 'untitled';
  }

  // Basic HTML entity decoding (e.g. &amp; -> &, &quot; -> ", &#8211; -> -)
  let clean = title
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#8211;/g, '-')
    .replace(/&#8212;/g, '-');

  // Remove filesystem-invalid characters and control characters
  clean = clean
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .trim()
    .replace(/\s+/g, '-');

  // Collapse consecutive hyphens and trim leading/trailing hyphens
  clean = clean.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');

  // Truncate cleanly on UTF-8 code point boundary
  clean = truncateUtf8Bytes(clean, maxBytes);

  // Clean up trailing hyphens left by truncation
  clean = clean.replace(/-+$/, '');

  return clean || 'untitled';
}

/**
 * Formats a date into a yyyyMMdd_ prefix.
 * If no valid date is provided, defaults to current date.
 */
export function formatDatePrefix(dateInput?: string | Date | null): string {
  if (!dateInput) {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_`;
  }

  if (typeof dateInput === 'string') {
    const match = dateInput.match(/^(\d{4})(\d{2})(\d{2})_?$/);
    if (match) {
      return `${match[1]}${match[2]}${match[3]}_`;
    }
  }

  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const validDate = isNaN(d.getTime()) ? new Date() : d;
  const yyyy = validDate.getFullYear();
  const mm = String(validDate.getMonth() + 1).padStart(2, '0');
  const dd = String(validDate.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}_`;
}

/**
 * Extracts an existing yyyyMMdd_ prefix from a file path if present.
 */
export function extractDatePrefixFromPath(filePath: string): string | null {
  const base = path.basename(filePath);
  const match = base.match(/^(\d{8})_/);
  return match ? `${match[1]}_` : null;
}

/**
 * Strips any leading yyyyMMdd_ date prefix from a filename or path.
 */
export function stripDatePrefix(filenameOrPath: string): string {
  const base = path.basename(filenameOrPath);
  return base.replace(/^\d{8}_/, '');
}

/**
 * Maximum UTF-8 byte length for a mirrored media filename stem. Media mirrors keep the storageKey's
 * own basename, which can be a long migrated path, so the stem is capped well below the 255-byte POSIX
 * NAME_MAX to leave room for the extension and any collision suffix.
 */
export const DEFAULT_MAX_MEDIA_REF_BYTES = 180;

/**
 * Derives the canonical local mirror name (`markdownRef`) from an EmDash media `storageKey`.
 *
 * A mirror is named after the storageKey — the identifier the article body actually references — so a
 * Markdown image URL resolves to a file of the same name on disk, and the binary plus its companion YAML
 * form one visibly matching pair. The record id is deliberately NOT part of the name: migrated storageKeys
 * are arbitrary paths rather than ULIDs, so an id can never be recovered from a filename, and Emit reads
 * it from the companion YAML (`id:`) and `media_state.media_id` instead.
 *
 * Sanitizing rules (cross-platform, no symlinks):
 * - Only the storageKey's basename is used; migrated keys such as `uploads/2026/11/sample.png` collapse
 *   to their final path segment.
 * - Filesystem-invalid characters and control characters are removed, whitespace collapses to `-`.
 * - Multi-ULID keys (`<ulid1>.<ulid2>.jpg`) keep their dot separators so the key stays recognizable.
 * - The storageKey's own trailing extension is stripped, because callers append the extension they write:
 *   a storageKey already ends in one, and re-appending it would produce `<key>.jpg.jpg`.
 * - The result is truncated on a UTF-8 code point boundary.
 * Returns `null` when the storageKey carries no usable name at all.
 */
export function storageKeyToMarkdownRef(
  storageKey: string,
  maxBytes: number = DEFAULT_MAX_MEDIA_REF_BYTES,
): string | null {
  if (!storageKey || !storageKey.trim()) return null;

  const basename = storageKey.replace(/\\/g, '/').split('/').pop() || '';
  let clean = basename
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, '-')
    .trim();

  // A leading dot would create a hidden file (or `.` / `..`), which no mirror may be.
  clean = clean.replace(/^\.+/, '');
  if (!clean) return null;

  // Drop the storageKey's own extension: the stem is shared by the binary and its `.yaml` companion, so
  // every caller appends the extension it actually writes and a key that already ends in one must not
  // produce `<key>.jpg.jpg`.
  clean = clean.replace(/\.[A-Za-z0-9]{1,11}$/, '');
  if (!clean) return null;

  // Trailing whitespace collapses to hyphens before the extension is known, so trim what the removal leaves.
  clean = clean.replace(/^[-.\s]+|[-.\s]+$/g, '');
  if (!clean) return null;

  clean = truncateUtf8Bytes(clean, maxBytes).replace(/[.\s-]+$/, '');
  return clean || null;
}

/**
 * Disambiguates two storageKeys that sanitize to the same basename by appending the media record id.
 * Deterministic: the same key and id always produce the same name, so re-running a pull never churns.
 */
export function collisionSuffixedMarkdownRef(markdownRef: string, mediaId: string): string {
  const id = mediaId.trim().toUpperCase();
  return `${markdownRef}--${id}`;
}

/**
 * Extracts the 26-character ULID from a filename or path, stripping any date prefix.
 * Returns null if no valid ULID is present.
 */
export function extractUlidFromFilename(filenameOrPath: string): string | null {
  const baseWithoutDate = stripDatePrefix(filenameOrPath);
  const match = extractFilenameUlid(baseWithoutDate);
  if (match) return match;

  const firstHyphen = baseWithoutDate.indexOf('-');
  const candidate = firstHyphen !== -1 ? baseWithoutDate.slice(0, firstHyphen) : baseWithoutDate;
  if (candidate.length === 26) {
    return candidate;
  }
  return null;
}

/**
 * Computes standard relative path for an article file: <collection>/<status>/<yyyyMMdd>_<ulid>-<title>.md
 */
export function computeArticleRelativePath(
  collection: string,
  status: string,
  id: string,
  titleOrSlug: string,
  dateInput?: string | Date | null,
): string {
  const prefix = formatDatePrefix(dateInput);
  const safeTitle = sanitizeTitleForFilename(titleOrSlug);
  return `${collection}/${status}/${prefix}${id}-${safeTitle}.md`;
}

/**
 * Comparator for sorting article file paths descending by filename (newest first).
 * Uses deterministic ordinal comparison on basenames (YYYYMMDD_<ulid>-<title>.md).
 */
export function compareArticleFilenameDesc(aPath: string, bPath: string): number {
  const a = path.basename(aPath);
  const b = path.basename(bPath);
  return b < a ? -1 : b > a ? 1 : 0;
}
