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

import { z } from 'zod';

/**
 * Zod schemas for EmDash API responses.
 *
 * NOTE: All object schemas use .passthrough() to ensure resilience against
 * server-side additions (e.g. new CMS fields, custom blocks, metadata extensions)
 * without breaking existing client-side sync.
 */

export const ContentItemDataSchema = z
  .object({
    title: z.string().optional(),
    content: z.unknown().optional(),
    body: z.unknown().optional(),
  })
  .passthrough();

export const ContentItemSchema = z
  .object({
    id: z.string().optional(),
    slug: z.string().optional(),
    collection: z.string().optional(),
    status: z.enum(['draft', 'published']).optional(),
    locale: z.string().optional(),
    _rev: z.string().optional(),
    rev: z.string().optional(),
    version: z.union([z.string(), z.number()]).optional(),
    publishedAt: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    taxonomies: z.record(z.array(z.string())).optional(),
    seo: z.record(z.unknown()).optional(),
    bylines: z.array(z.unknown()).optional(),
    data: ContentItemDataSchema.optional(),
  })
  .passthrough();

export const ContentEnvelopeSchema = z
  .object({
    success: z.boolean().optional(),
    _rev: z.string().optional(),
    rev: z.string().optional(),
    data: z
      .object({
        item: ContentItemSchema.optional(),
        _rev: z.string().optional(),
        rev: z.string().optional(),
      })
      .passthrough()
      .or(ContentItemSchema)
      .optional(),
    item: ContentItemSchema.optional(),
  })
  .passthrough();

export const ContentListResponseSchema = z
  .object({
    items: z.array(ContentItemSchema).optional(),
    nextCursor: z.string().nullable().optional(),
  })
  .passthrough();

export const TaxonomyTermSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().optional(),
  })
  .passthrough();

export const TaxonomyListResponseSchema = z
  .object({
    terms: z.array(TaxonomyTermSchema).optional(),
  })
  .passthrough();

export const MediaItemSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    mimeType: z.string().optional(),
    size: z.number().optional(),
    url: z.string().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

export const MediaListResponseSchema = z
  .object({
    items: z.array(MediaItemSchema).optional(),
    nextCursor: z.string().nullable().optional(),
  })
  .passthrough();

export const LockHolderSchema = z
  .object({
    userId: z.string(),
    userName: z.string(),
    acquiredAt: z.string(),
    expiresAt: z.string(),
  })
  .passthrough();

export const LockResponseSchema = z
  .object({
    enabled: z.boolean().optional(),
    holder: LockHolderSchema.nullable().optional(),
    heldByCaller: z.boolean().optional(),
  })
  .passthrough();

export type LockHolder = z.infer<typeof LockHolderSchema>;
export type LockResponse = z.infer<typeof LockResponseSchema>;

export type ContentItem = z.infer<typeof ContentItemSchema>;
export type ContentEnvelope = z.infer<typeof ContentEnvelopeSchema>;
export type ContentListResponse = z.infer<typeof ContentListResponseSchema>;
export type TaxonomyTerm = z.infer<typeof TaxonomyTermSchema>;
export type MediaItem = z.infer<typeof MediaItemSchema>;
