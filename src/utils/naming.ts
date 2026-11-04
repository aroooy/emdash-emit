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

/**
 * Sanitizes a title or slug for safe inclusion in a filename.
 * Preserves alphanumeric characters, hyphens, underscores, and non-ASCII (e.g. Japanese kanji/kana).
 */
export function sanitizeTitleForFilename(title: string): string {
  return title
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .trim()
    .replace(/\s+/g, '-');
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
 * Extracts the 26-character ULID from a filename or path, stripping any date prefix.
 * Returns null if no valid ULID is present.
 */
export function extractUlidFromFilename(filenameOrPath: string): string | null {
  const baseWithoutDate = stripDatePrefix(filenameOrPath);
  const match = baseWithoutDate.match(/^([0-9A-Za-z_-]{26})(?:-|\.|$)/);
  if (match) return match[1];

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
