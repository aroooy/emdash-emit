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

import {
  markdownToPortableText,
  portableTextToMarkdown,
  type PortableTextBlock,
} from './portable-text.js';
import { unwrapEnvelope, unwrapItem, extractRev } from './api.js';
import type { Frontmatter, ParsedMarkdown } from '../utils/frontmatter.js';
import { isCanonicalUlid, toCanonicalUlid } from '../utils/ulid.js';

export interface ContentBylineInput {
  bylineId: string;
  roleLabel?: string | null;
}

export interface ContentUpdatePayload {
  id?: string;
  collection: string;
  slug?: string;
  status?: 'draft' | 'published';
  publishedAt?: string | null;
  locale?: string;
  data: Record<string, unknown>;
  taxonomies?: Record<string, string[]>;
  seo?: Record<string, unknown>;
  bylines?: ContentBylineInput[];
  _rev?: string;
  overrideLock?: boolean;
}

export interface MapperOptions {
  allowPublish?: boolean;
  bylineSlugToId?: Record<string, string>;
  bylineIdToSlug?: Record<string, string>;
}

/**
 * Derives a canonical 26-character media ULID from a featured_image representation.
 * Supports:
 * - Direct 26-char ULID string (normalized to uppercase)
 * - { provider: 'local', id: '<ULID>', ... }
 * - { provider: 'external', src: '/_emdash/api/media/file/<ULID>[.<ext>]', ... }
 * - URL strings containing /_emdash/api/media/file/<ULID>[.<ext>]
 *
 * Note on charset: Uses [0-9A-HJ-NP-Z] (case-insensitive) which strictly excludes 'I' and 'O',
 * while permissively accepting 'L' and 'U' to avoid false rejections on custom/legacy identifiers.
 */
export function extractMediaUlid(val: unknown): string | null {
  if (val === null) return null;
  if (!val) return null;

  if (typeof val === 'string') {
    const trimmed = val.trim();
    const canonical = toCanonicalUlid(trimmed);
    if (canonical) {
      return canonical;
    }
    const match = trimmed.match(/\/([0-9A-HJ-NP-Z]{26})(?:\.[a-zA-Z0-9]+)?(?:$|\?)/i);
    if (match) return match[1].toUpperCase();
    return null;
  }

  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    // 1. Direct ULID id field (provider: 'local')
    if (isCanonicalUlid(obj.id)) {
      return (obj.id as string).trim().toUpperCase();
    }
    // 2. src URL in object (provider: 'external')
    if (typeof obj.src === 'string') {
      const match = obj.src.match(/\/([0-9A-HJ-NP-Z]{26})(?:\.[a-zA-Z0-9]+)?(?:$|\?)/i);
      if (match) return match[1].toUpperCase();
    }
    // 3. url field fallback
    if (typeof obj.url === 'string') {
      const match = obj.url.match(/\/([0-9A-HJ-NP-Z]{26})(?:\.[a-zA-Z0-9]+)?(?:$|\?)/i);
      if (match) return match[1].toUpperCase();
    }
  }

  return null;
}

/**
 * Converts local markdown representation into EmDash REST API update payload.
 */
export function localToApiPayload(
  parsed: ParsedMarkdown,
  rev: string,
  options?: MapperOptions,
): ContentUpdatePayload {
  const { frontmatter, body } = parsed;

  const ptBody = markdownToPortableText(body);
  const payload: ContentUpdatePayload = {
    id: frontmatter.id,
    collection: frontmatter.collection,
    slug: frontmatter.slug,
    locale: frontmatter.locale,
    data: {
      title: frontmatter.title,
      content: ptBody,
      ...(frontmatter.featuredImage !== undefined
        ? {
            featured_image:
              frontmatter.featuredImage === null ? null : { id: frontmatter.featuredImage },
          }
        : {}),
    },
    _rev: rev,
  };

  // Note: In EmDash, publishing/unpublishing is performed via dedicated
  // /publish and /unpublish endpoints rather than in PUT payloads.
  // We omit status here to comply with EmDash PUT endpoint validation.

  if (frontmatter.publishedAt !== undefined) {
    payload.publishedAt = frontmatter.publishedAt;
  }

  if (frontmatter.seo) {
    payload.seo = {
      title: frontmatter.seo.title ?? null,
      description: frontmatter.seo.description ?? null,
      canonical: frontmatter.seo.canonical ?? null,
      noIndex: frontmatter.seo.noIndex ?? false,
      image: frontmatter.seo.image ?? null,
    };
  }

  if (frontmatter.bylines !== undefined && Array.isArray(frontmatter.bylines)) {
    const slugMap = options?.bylineSlugToId || {};
    const validBylines: ContentBylineInput[] = [];
    for (const slug of frontmatter.bylines) {
      const mappedId = slugMap[slug];
      if (mappedId) {
        validBylines.push({ bylineId: mappedId, roleLabel: null });
      } else if (/^[0-9A-Za-z_-]{16,36}$/.test(slug)) {
        validBylines.push({ bylineId: slug, roleLabel: null });
      }
    }
    if (validBylines.length > 0 || frontmatter.bylines.length === 0) {
      payload.bylines = validBylines;
    }
  }

  return payload;
}

/**
 * Converts remote EmDash content API response item into local frontmatter & markdown body.
 */
export function apiResponseToLocal(
  raw: Record<string, unknown>,
  options?: MapperOptions,
): { frontmatter: Frontmatter; body: string; rev: string } {
  const item = unwrapItem<Record<string, unknown>>(raw);
  const rev = extractRev(raw);

  const id = String(item.id || '');
  const slug = String(item.slug || '');
  const collection = String(item.collection || item.type || 'posts');
  const status = (item.status === 'published' ? 'published' : 'draft') as 'draft' | 'published';
  const locale = String(item.locale || 'ja');
  const publishedAt = item.publishedAt ? String(item.publishedAt) : null;

  const data = (item.data || {}) as Record<string, unknown>;
  const title = String(data.title || item.title || 'Untitled');

  const rawBody = data.content ?? data.body;
  let body = '';
  if (Array.isArray(rawBody)) {
    body = portableTextToMarkdown(rawBody as PortableTextBlock[]);
  } else if (typeof rawBody === 'string') {
    body = rawBody;
  }

  // Taxonomies
  const taxonomies = (item.taxonomies || {}) as Record<string, string[]>;

  // SEO
  const rawSeo = (item.seo || {}) as Record<string, unknown>;
  const seo =
    Object.keys(rawSeo).length > 0
      ? {
          title: rawSeo.title ? String(rawSeo.title) : null,
          description: rawSeo.description ? String(rawSeo.description) : null,
          canonical: rawSeo.canonical ? String(rawSeo.canonical) : null,
          noIndex: Boolean(rawSeo.noIndex),
          image: rawSeo.image ? String(rawSeo.image) : null,
        }
      : undefined;

  // Bylines (support nested byline.slug, byline.id, or bylineId)
  const idMap = options?.bylineIdToSlug || {};
  const rawBylines = (item.bylines || []) as Array<{
    bylineId?: string;
    byline?: { id?: string; slug?: string };
  }>;
  let bylines = rawBylines
    .map((b) => {
      const slugOrId = b.byline?.slug || b.bylineId || b.byline?.id;
      return slugOrId ? idMap[slugOrId] || slugOrId : null;
    })
    .filter((b): b is string => Boolean(b));

  if (bylines.length === 0 && item.byline && typeof item.byline === 'object') {
    const singleByline = item.byline as { slug?: string; id?: string };
    const slugOrId = singleByline.slug || singleByline.id;
    if (slugOrId) bylines = [idMap[slugOrId] || slugOrId];
  }

  if (bylines.length === 0 && item.primaryBylineId && typeof item.primaryBylineId === 'string') {
    const slugOrId = item.primaryBylineId;
    bylines = [idMap[slugOrId] || slugOrId];
  }

  const rawFeaturedImage =
    data.featured_image !== undefined
      ? data.featured_image
      : data.featuredImage !== undefined
        ? data.featuredImage
        : item.featured_image !== undefined
          ? item.featured_image
          : item.featuredImage;
  const featuredImage =
    rawFeaturedImage === null
      ? null
      : rawFeaturedImage !== undefined
        ? (extractMediaUlid(rawFeaturedImage) ?? undefined)
        : undefined;

  const frontmatter: Frontmatter = {
    id,
    slug,
    title,
    collection,
    status,
    publishedAt,
    locale,
    ...(featuredImage !== undefined ? { featuredImage } : {}),
    taxonomies,
    seo,
    bylines,
  };

  return { frontmatter, body, rev };
}
