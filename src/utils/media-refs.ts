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
 * Canonical media reference parsing and fence policy definitions.
 *
 * This module consolidates:
 * 1. Root-relative media route prefix definition.
 * 2. Fence handling policy (backtick-only for authoring guards, backtick-or-tilde for diagnostics).
 * 3. Unified scanning of markdown and HTML image references across article bodies.
 */

/** Canonical root-relative media route prefix EmDash writes into Portable Text image blocks. */
export const MEDIA_FILE_ROUTE_PREFIX = '/_emdash/api/media/file/';

/**
 * Valid storageKey format: dot-separated 26-char ULID segments with a supported image extension.
 */
export const VALID_MEDIA_FILE_KEY =
  /^[0-9A-HJ-NP-Z]{26}(\.[0-9A-HJ-NP-Z]{26})*\.(jpg|jpeg|png|gif|webp|avif|svg)$/i;

/**
 * Fence policy declared explicitly:
 * - guard: 'backtick-only' (G5/G11 preflight guards strictly exempt only backtick code fences).
 * - diagnostic: 'backtick-or-tilde' (doctor diagnosis treats both ``` and ~~~ as code fences).
 */
export const FENCE_POLICY = {
  guard: 'backtick-only',
  diagnostic: 'backtick-or-tilde',
} as const;

export type FencePolicyType = (typeof FENCE_POLICY)[keyof typeof FENCE_POLICY];

/**
 * Checks whether a trimmed line starts a code fence according to the specified policy.
 * - 'backtick-only': recognizes runs of 3 or more backticks (```).
 * - 'backtick-or-tilde': recognizes runs of 3 or more backticks (```) or tildes (~~~).
 */
export function isCodeFenceDelimiter(line: string, policy: FencePolicyType): string | null {
  const trimmed = line.trim();
  if (policy === FENCE_POLICY.diagnostic) {
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      return trimmed.slice(0, 3);
    }
    return null;
  }
  if (trimmed.startsWith('```')) {
    return trimmed.slice(0, 3);
  }
  return null;
}

export interface ParsedMediaRefMatch {
  raw: string;
  url: string;
  isMarkdownImage: boolean;
  isHtmlImage: boolean;
  line: number;
}

/** Any storageKey-style ULID appearing inside a media file URL. */
const MEDIA_ULID_IN_URL = /[0-9A-HJ-NP-Z]{26}/g;

/** True when the captured image markup sits inside an inline code span on the same line. */
export function isInlineCodeSpan(line: string, matchText: string, matchIndex: number): boolean {
  if (line.includes('`' + matchText)) return true;
  const first = line.indexOf('`');
  return first !== -1 && first < matchIndex && matchIndex < line.lastIndexOf('`');
}

/**
 * Classifies a captured media URL. Anything that cannot name a real asset (template placeholders, or
 * a key polluted by leaked markup) is reported separately so it never counts as missing media.
 */
export function classifyMediaUrl(url: string): 'valid' | 'placeholder' | 'invalid' {
  if (url.includes('<') || url.includes('>') || url.includes('${')) return 'placeholder';
  const keyMatch = url.match(/(?:^|\/)media\/file\/([^?#]*)/);
  if (!keyMatch) return 'valid'; // a plain local path: resolved by filesystem checks instead
  if (VALID_MEDIA_FILE_KEY.test(keyMatch[1])) return 'valid';
  // A ULID is present but the captured key is polluted by leaked markup, as in the real legacy
  // body line `![alt](/_emdash/api/media/file/<ULID>.jpg" control=true)`. The asset itself still
  // resolves through the ULID, so only the surrounding capture is treated as residue.
  return MEDIA_ULID_IN_URL.test(keyMatch[1]) ? 'valid' : 'invalid';
}

export interface ClassifiedMediaRef {
  url: string;
  kind: 'normal' | 'informational' | 'invalid';
}

/**
 * Unified scanner for Markdown images, HTML <img> tags, and optional legacy/informational
 * containers with classification. Filters out opaque block fences (`<!--ec:block ... -->`).
 */
export function scanClassifiedMediaReferences(
  bodyMarkdown: string,
  options?: {
    fencePolicy?: FencePolicyType;
    includeInformational?: boolean;
    classify?: (url: string) => 'valid' | 'placeholder' | 'invalid';
  },
): ClassifiedMediaRef[] {
  const fencePolicy = options?.fencePolicy ?? FENCE_POLICY.guard;
  const includeInformational = options?.includeInformational ?? false;
  const classify = options?.classify ?? classifyMediaUrl;

  const seen = new Map<string, 'normal' | 'informational' | 'invalid'>();
  const record = (url: string, kind: 'normal' | 'informational' | 'invalid'): void => {
    const existing = seen.get(url);
    if (!existing || kind === 'normal') {
      seen.set(url, kind);
    }
  };

  const lines = bodyMarkdown.split('\n');
  let inFence = false;
  let fenceDelimiter = '';
  let inOpaqueFence = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();

    // Check opaque fences (<!--ec:block ... -->)
    if (/^<!--ec:block\s/.test(trimmed)) {
      inOpaqueFence = !/^.*-->$/.test(trimmed);
      continue;
    }
    if (inOpaqueFence) {
      if (/^.*-->$/.test(trimmed)) {
        inOpaqueFence = false;
      }
      continue;
    }

    // Check code fences
    const delim = isCodeFenceDelimiter(trimmed, fencePolicy);
    if (delim) {
      if (!inFence) {
        inFence = true;
        fenceDelimiter = delim;
        continue;
      } else if (trimmed.startsWith(fenceDelimiter)) {
        inFence = false;
        continue;
      }
    }
    if (inFence && !includeInformational) continue;

    // 1. Markdown image syntax: ![alt](url)
    const mdRegex = /!\[.*?\]\(([^)\s]+)(?:\s+["'].*?["'])?\)/g;
    let match: RegExpExecArray | null;
    while ((match = mdRegex.exec(line)) !== null) {
      const url = match[1].trim();
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('data:')) {
        if (!includeInformational) {
          record(url, 'normal');
        } else {
          const urlKind = classify(url);
          if (urlKind === 'invalid') {
            record(url, 'invalid');
          } else if (
            inFence ||
            isInlineCodeSpan(line, match[0], match.index) ||
            urlKind === 'placeholder'
          ) {
            record(url, 'informational');
          } else {
            record(url, 'normal');
          }
        }
      }
    }

    // 2. HTML <img> tags: <img src="...">
    const htmlRegex = /<img[^>]+src=["']([^"']+)["']/gi;
    while ((match = htmlRegex.exec(line)) !== null) {
      const url = match[1].trim();
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('data:')) {
        if (!includeInformational) {
          record(url, 'normal');
        } else {
          const urlKind = classify(url);
          if (urlKind === 'invalid') {
            record(url, 'invalid');
          } else if (inFence || urlKind === 'placeholder' || line.includes('<!--')) {
            record(url, 'informational');
          } else {
            record(url, 'normal');
          }
        }
      }
    }

    // 3. Legacy WordPress-derived custom container lines (e.g. `[dimage url="..." control=true]`)
    if (includeInformational) {
      const legacyContainerRegex = /\[([a-z]+)\s+url=["']?([^"'\s\]]+)["']?[^\]]*\]/gi;
      while ((match = legacyContainerRegex.exec(line)) !== null) {
        const url = match[2].trim();
        if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('data:')) {
          record(url, 'informational');
        }
      }
    }
  }

  return Array.from(seen.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([url, kind]) => ({ url, kind }));
}

/**
 * Unified scanner for Markdown images (![alt](url)) and HTML <img> tags in content.
 * Filters out references located inside code fences (according to fencePolicy)
 * or inside opaque block fences (<!--ec:block ... -->).
 */
export function scanRawMediaReferences(
  bodyMarkdown: string,
  fencePolicy: FencePolicyType = FENCE_POLICY.guard,
): string[] {
  return scanClassifiedMediaReferences(bodyMarkdown, {
    fencePolicy,
    includeInformational: false,
  }).map((entry) => entry.url);
}
