/**
 * Canonical media reference parsing and fence policy definitions.
 *
 * This module consolidates:
 * 1. Root-relative media route prefix definition.
 * 2. Fence handling policy (backtick-only for authoring guards, backtick-or-tilde for diagnostics).
 * 3. Unified scanning of markdown and HTML image references across article bodies.
 */

import { MEDIA_FILE_ROUTE_PREFIX } from './media-body-refs.js';

export { MEDIA_FILE_ROUTE_PREFIX };

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

/**
 * Unified scanner for Markdown images (![alt](url)) and HTML <img> tags in content.
 * Filters out references located inside code fences (according to fencePolicy)
 * or inside opaque block fences (<!--ec:block ... -->).
 */
export function scanRawMediaReferences(
  bodyMarkdown: string,
  fencePolicy: FencePolicyType = FENCE_POLICY.guard,
): string[] {
  const references = new Set<string>();
  const lines = bodyMarkdown.split('\n');
  let inFence = false;
  let fenceDelimiter = '';
  let inOpaqueFence = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.replace(/\r$/, '').trim();

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
    if (inFence) continue;

    // 1. Markdown image syntax: ![alt](url)
    const mdRegex = /!\[.*?\]\(([^)\s]+)(?:\s+["'].*?["'])?\)/g;
    let match: RegExpExecArray | null;
    while ((match = mdRegex.exec(trimmed)) !== null) {
      const url = match[1].trim();
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('data:')) {
        references.add(url);
      }
    }

    // 2. HTML <img> tags: <img src="...">
    const htmlRegex = /<img[^>]+src=["']([^"']+)["']/gi;
    while ((match = htmlRegex.exec(trimmed)) !== null) {
      const url = match[1].trim();
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('data:')) {
        references.add(url);
      }
    }
  }

  return Array.from(references).sort();
}
