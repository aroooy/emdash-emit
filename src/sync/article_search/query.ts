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

export interface ParsedArticleDates {
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string | null;
}

function parseDateValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return null;
}

/**
 * Extracts date fields from a raw article item or frontmatter object.
 * Checks top-level properties first, falling back to nested `data` object.
 */
export function parseArticleDates(rawObj: Record<string, unknown>): ParsedArticleDates {
  const data = (rawObj.data && typeof rawObj.data === 'object' ? rawObj.data : {}) as Record<
    string,
    unknown
  >;

  const createdAt = parseDateValue(rawObj.createdAt) ?? parseDateValue(data.createdAt) ?? undefined;
  const updatedAt = parseDateValue(rawObj.updatedAt) ?? parseDateValue(data.updatedAt) ?? undefined;
  const publishedAt =
    parseDateValue(rawObj.publishedAt) ??
    parseDateValue(data.publishedAt) ??
    parseDateValue(rawObj.date) ??
    parseDateValue(data.date) ??
    (rawObj.publishedAt === null || data.publishedAt === null ? null : undefined);

  return { createdAt, updatedAt, publishedAt };
}

/**
 * Resolves the comparison date string according to the requested dateField policy.
 * Defaults:
 *   - published articles: publishedAt ?? createdAt
 *   - draft articles: createdAt ?? updatedAt
 */
export function resolveArticleDateField(
  dates: ParsedArticleDates,
  status?: string,
  dateField?: 'publishedAt' | 'updatedAt' | 'createdAt',
): string | undefined {
  if (dateField) {
    const val = dates[dateField];
    return val ?? undefined;
  }
  if (status === 'published') {
    return dates.publishedAt ?? dates.createdAt;
  }
  if (status === 'draft') {
    return dates.createdAt ?? dates.updatedAt;
  }
  return dates.publishedAt ?? dates.createdAt;
}

/**
 * Returns true if the given date string falls within [sinceBoundary, untilBoundary).
 */
export function inArticleDateRange(
  dateStr: string | undefined,
  sinceBoundary: number | null,
  untilBoundary: number | null,
): boolean {
  if (sinceBoundary === null && untilBoundary === null) return true;
  if (!dateStr) return false;
  const instant = Date.parse(dateStr);
  if (!Number.isFinite(instant)) return false;
  if (sinceBoundary !== null && instant < sinceBoundary) return false;
  if (untilBoundary !== null && instant >= untilBoundary) return false;
  return true;
}

/**
 * Matches keyword against article text attributes.
 */
export function matchesArticleKeyword(
  item: { title?: string; slug?: string | null; excerpt?: string; body?: string },
  normalizedQuery: string,
): Array<'title' | 'slug' | 'excerpt' | 'body'> {
  if (!normalizedQuery) return [];
  const matchedOn: Array<'title' | 'slug' | 'excerpt' | 'body'> = [];

  if (item.title && item.title.toLowerCase().includes(normalizedQuery)) {
    matchedOn.push('title');
  }
  if (item.slug && item.slug.toLowerCase().includes(normalizedQuery)) {
    matchedOn.push('slug');
  }
  if (item.excerpt && item.excerpt.toLowerCase().includes(normalizedQuery)) {
    matchedOn.push('excerpt');
  }
  if (item.body && item.body.toLowerCase().includes(normalizedQuery)) {
    matchedOn.push('body');
  }

  return matchedOn;
}
