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
 * Parses a media-search date boundary into an absolute instant.
 *
 * Only three spellings are accepted — `today`, `yesterday`, and an ISO calendar date (`YYYY-MM-DD`) — because
 * every other natural-language form ("last week", "3 days ago") invites a silent misreading of which day the
 * user meant, and a wrong boundary silently drops or keeps records. The returned instant is local-midnight,
 * so `since` names the start of that day and `until` is compared against the start of the following day
 * (see the caller), keeping both ends inclusive of the named calendar day.
 *
 * Returns null for anything else, including a bare time, a weekday name, or an out-of-range calendar date.
 */
export function parseSearchDateBoundary(
  raw: string,
  now: Date = new Date(),
): { since?: number; until?: number } | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;

  const base = startOfLocalDay(now);

  if (value === 'today') {
    return { since: base.getTime() };
  }
  if (value === 'yesterday') {
    const yesterday = new Date(base);
    yesterday.setDate(yesterday.getDate() - 1);
    return { since: yesterday.getTime(), until: base.getTime() };
  }

  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!isoMatch) return null;
  const [, yearPart, monthPart, dayPart] = isoMatch;
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const parsed = new Date(year, month - 1, day);
  // A rejected rollover (`2026-02-31`) must not silently become a March boundary.
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  return { since: parsed.getTime() };
}

/** One calendar day in milliseconds, used to make an `until` boundary inclusive of that day. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight of the day `date` falls in — the anchor every boundary is measured from. */
function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
