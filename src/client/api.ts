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
 * Safe unwrap utilities for EmDash API response envelopes and revision extraction.
 */

import { ContentEnvelopeSchema, ContentItemSchema } from './schemas.js';

export interface UnwrappedEnvelope<T = Record<string, unknown>> {
  data: T;
  rev: string;
}

/**
 * Validates and safely extracts the primary data object from an API response envelope.
 * Handles { success: true, data: T } or plain T responses.
 * Note: If raw itself has an `id` field (already an item), do not unwrap `raw.data` (which is content data).
 */
export function unwrapEnvelope<T = Record<string, unknown>>(raw: unknown): T {
  if (!raw || typeof raw !== 'object') {
    return {} as T;
  }

  // Parse against envelope schema if possible
  const parsedEnvelope = ContentEnvelopeSchema.safeParse(raw);
  const obj = (parsedEnvelope.success ? parsedEnvelope.data : raw) as Record<string, unknown>;

  if ('data' in obj && obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
    // If obj already has top-level `id` or `slug`, obj is already the content item, not an API envelope!
    if ('id' in obj || 'slug' in obj) {
      return obj as T;
    }
    return obj.data as T;
  }
  return obj as T;
}

/**
 * Validates and safely extracts the item from a response or nested envelope ({ item: T }, { data: { item: T } } or T).
 */
export function unwrapItem<T = Record<string, unknown>>(raw: unknown): T {
  if (!raw || typeof raw !== 'object') {
    return {} as T;
  }

  const parsedEnvelope = ContentEnvelopeSchema.safeParse(raw);
  const root = (parsedEnvelope.success ? parsedEnvelope.data : raw) as Record<string, unknown>;

  // If root has data.item
  if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) {
    const dataObj = root.data as Record<string, unknown>;
    if (dataObj.item && typeof dataObj.item === 'object') {
      const parsedItem = ContentItemSchema.safeParse(dataObj.item);
      return (parsedItem.success ? parsedItem.data : dataObj.item) as T;
    }
    if (dataObj.id) {
      const parsedItem = ContentItemSchema.safeParse(dataObj);
      return (parsedItem.success ? parsedItem.data : dataObj) as T;
    }
  }

  // If root has item
  if (root.item && typeof root.item === 'object') {
    const parsedItem = ContentItemSchema.safeParse(root.item);
    return (parsedItem.success ? parsedItem.data : root.item) as T;
  }

  const parsedItem = ContentItemSchema.safeParse(root);
  return (parsedItem.success ? parsedItem.data : root) as T;
}

/**
 * Extracts revision string from an API response, prioritizing data._rev over item._rev, rev, version.
 */
export function extractRev(raw: unknown, fallback = '1'): string {
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }

  const root = raw as Record<string, unknown>;
  let envelopeRev = '';

  if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) {
    const dataObj = root.data as Record<string, unknown>;
    if (dataObj._rev) envelopeRev = String(dataObj._rev);
    else if (dataObj.rev) envelopeRev = String(dataObj.rev);
  }

  const item = unwrapItem<Record<string, unknown>>(raw);
  const rev =
    item._rev || envelopeRev || root._rev || item.rev || root.rev || item.version || root.version;

  return rev ? String(rev) : fallback;
}

/**
 * Extracts comparison revision key (Track 2), prioritizing draftRevisionId / liveRevisionId
 * so draft content changes on server are never skipped during pull.
 * Format: `<version>@draft:<ULID>` or `<version>@live:<ULID>` or fallback.
 */
export function extractComparisonRev(raw: unknown, fallback = '1'): string {
  if (!raw || typeof raw !== 'object') {
    return fallback ? String(fallback) : '1';
  }

  const root = raw as Record<string, unknown>;
  const item = unwrapItem<Record<string, unknown>>(raw);
  const rawRevCandidate = String(
    item._rev || root._rev || item.rev || root.rev || item.version || root.version || '',
  );
  const normalizedCandidate = rawRevCandidate ? normalizeRev(rawRevCandidate) : '';
  const candidateVersion = /^\d+$/.test(normalizedCandidate) ? normalizedCandidate : '';
  const normalizedFallback = fallback ? normalizeRev(fallback) : '';
  const fallbackVersion = /^\d+$/.test(normalizedFallback) ? normalizedFallback : '1';

  const resolvedVersion =
    (item.version !== undefined && item.version !== null ? String(item.version) : '') ||
    (root.version !== undefined && root.version !== null ? String(root.version) : '') ||
    candidateVersion ||
    fallbackVersion ||
    '1';
  const version = String(resolvedVersion);
  const draftRevisionId = item.draftRevisionId || root.draftRevisionId;
  const liveRevisionId = item.liveRevisionId || root.liveRevisionId;

  if (draftRevisionId && typeof draftRevisionId === 'string' && draftRevisionId.trim()) {
    return `${version}@draft:${draftRevisionId.trim()}`;
  }
  if (liveRevisionId && typeof liveRevisionId === 'string' && liveRevisionId.trim()) {
    return `${version}@live:${liveRevisionId.trim()}`;
  }

  // Fallback to raw token (e.g. Base64 or plain version)
  return extractRev(raw, fallback);
}

/**
 * Compares two revision keys for equality.
 * Supports:
 * - Exact match
 * - Composite keys (`<version>@draft:<ULID>` / `<version>@live:<ULID>`)
 * - Safe migration: Legacy pure numbers vs Composite keys always return false (triggering upgrade pull)
 * - Strict Base64 comparison with round-trip verification for legacy cached tokens
 */
export function isSameRev(trackedRev: unknown, remoteRev: unknown): boolean {
  if (
    trackedRev === null ||
    trackedRev === undefined ||
    remoteRev === null ||
    remoteRev === undefined
  ) {
    return false;
  }
  const a = String(trackedRev).trim();
  const b = String(remoteRev).trim();
  if (a === b) {
    return true;
  }

  const isCompositeA = a.includes('@draft:') || a.includes('@live:');
  const isCompositeB = b.includes('@draft:') || b.includes('@live:');

  // Both are composite keys: must match exactly (already checked a === b, so false here)
  if (isCompositeA && isCompositeB) {
    return false;
  }

  // One is composite and one is legacy/raw token: always treat as different to trigger migration
  if (isCompositeA !== isCompositeB) {
    return false;
  }

  // Both are non-composite (legacy numbers, colon-delimited, or Base64 tokens)
  const isStrictB64 = (s: string): boolean => {
    try {
      return Buffer.from(s, 'base64').toString('base64') === s && /^[A-Za-z0-9+/=]+$/.test(s);
    } catch {
      return false;
    }
  };

  if (isStrictB64(a) && isStrictB64(b)) {
    try {
      const decodedA = Buffer.from(a, 'base64').toString('utf8');
      const decodedB = Buffer.from(b, 'base64').toString('utf8');
      return decodedA === decodedB;
    } catch {
      return false;
    }
  }

  // Pure numeric fallback comparison
  return normalizeRev(a) === normalizeRev(b);
}

/**
 * Formats a revision token/key for human display in CLI and diff headers.
 * Truncates composite keys (`3@draft:01M7...`) to their version number (`3`).
 */
export function formatRevForDisplay(rev: string | null | undefined): string {
  if (!rev) return '';
  const s = String(rev).trim();
  const atIdx = s.indexOf('@');
  if (atIdx > 0) {
    return s.slice(0, atIdx);
  }
  return normalizeRev(s);
}

/**
 * Normalizes revision representation (pure number, base64-encoded token, or colon-delimited)
 * to its canonical numeric string when possible, allowing reliable parity comparisons.
 * e.g. "1", "1:2026-10-31...", "MToyMDI2LTEwLTMxVDAwOjE2OjI4Ljk1MFo=" all normalize to "1".
 */
export function normalizeRev(rev: unknown): string {
  if (rev === null || rev === undefined) return '1';
  const s = String(rev).trim();
  if (!s) return '1';

  // If already pure digits
  if (/^\d+$/.test(s)) {
    return s;
  }

  // Check if string contains colon directly (e.g. "1:2026-10-31...")
  const colonMatch = s.match(/^(\d+):(?:\d{4}-\d{2}-\d{2})/);
  if (colonMatch) {
    return colonMatch[1];
  }

  // Check if Base64 encoded (e.g. "MToyMDI2...")
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length >= 8) {
    try {
      const decoded = Buffer.from(s, 'base64').toString('utf8');
      const decodedColon = decoded.match(/^(\d+):(?:\d{4}-\d{2}-\d{2})/);
      if (decodedColon) {
        return decodedColon[1];
      }
    } catch {
      // Ignore decode failure
    }
  }

  return s;
}
