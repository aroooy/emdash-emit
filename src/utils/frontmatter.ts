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
import matter from 'gray-matter';
import { z } from 'zod';

export const FrontmatterSeoSchema = z.object({
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  canonical: z.string().url().nullable().optional(),
  noIndex: z.boolean().optional(),
  image: z.string().nullable().optional(),
});

export const FrontmatterSchema = z.object({
  id: z.string().length(26, 'ID must be a 26-character ULID'),
  slug: z.string().min(1, 'Slug cannot be empty'),
  title: z.string().min(1, 'Title cannot be empty'),
  collection: z.string().default('posts'),
  status: z.enum(['draft', 'published']).default('draft'),
  publishedAt: z.string().nullable().optional(),
  locale: z.string().default('ja'),
  taxonomies: z.record(z.array(z.string())).optional().default({}),
  seo: FrontmatterSeoSchema.optional(),
  bylines: z.array(z.string()).optional().default([]),
});

export type Frontmatter = z.infer<typeof FrontmatterSchema>;

export interface TaxonomyCandidates {
  categories?: string[];
  tags?: string[];
  bylines?: string[];
  [key: string]: string[] | undefined;
}

export interface ParsedMarkdown {
  frontmatter: Frontmatter;
  body: string;
  rawYaml: string;
}

/**
 * Parses markdown text into validated frontmatter and body.
 */
export function parseMarkdown(content: string): ParsedMarkdown {
  const parsed = matter(content);
  const validated = FrontmatterSchema.parse(parsed.data);

  return {
    frontmatter: validated,
    body: parsed.content,
    rawYaml: matter.stringify('', parsed.data).trim(),
  };
}

/**
 * Formats a frontmatter object into clean YAML with helpful candidate comments.
 */
export function formatFrontmatterYaml(data: Frontmatter, candidates?: TaxonomyCandidates): string {
  const lines: string[] = ['---'];

  lines.push(`id: ${data.id}`);
  lines.push(`slug: ${data.slug}`);
  lines.push(`title: ${JSON.stringify(data.title)}`);
  lines.push(`collection: ${data.collection}`);
  lines.push(`status: ${data.status}`);
  lines.push(`publishedAt: ${data.publishedAt ? JSON.stringify(data.publishedAt) : 'null'}`);
  lines.push(`locale: ${data.locale}`);

  // Taxonomies
  lines.push('taxonomies:');
  const taxonomies = data.taxonomies || {};
  const allTaxKeys = Array.from(new Set([...Object.keys(taxonomies), 'categories', 'tags']));

  for (const taxKey of allTaxKeys) {
    lines.push(`  ${taxKey}:`);

    const terms = taxonomies[taxKey] || [];
    if (terms.length === 0) {
      lines.push('    []');
    } else {
      for (const term of terms) {
        lines.push(`    - ${term}`);
      }
    }
  }

  // SEO
  if (data.seo) {
    lines.push('seo:');
    if (data.seo.title !== undefined) lines.push(`  title: ${JSON.stringify(data.seo.title)}`);
    if (data.seo.description !== undefined)
      lines.push(`  description: ${JSON.stringify(data.seo.description)}`);
    if (data.seo.canonical !== undefined)
      lines.push(`  canonical: ${JSON.stringify(data.seo.canonical)}`);
    if (data.seo.noIndex !== undefined) lines.push(`  noIndex: ${data.seo.noIndex}`);
    if (data.seo.image !== undefined) lines.push(`  image: ${JSON.stringify(data.seo.image)}`);
  }

  // Bylines
  lines.push('bylines:');
  const bylines = data.bylines || [];
  if (bylines.length === 0) {
    lines.push('  []');
  } else {
    for (const byline of bylines) {
      lines.push(`  - ${byline}`);
    }
  }

  lines.push('---');
  return lines.join('\n');
}

/**
 * Serializes frontmatter and markdown body into a full document.
 */
export function serializeMarkdown(
  frontmatter: Frontmatter,
  body: string,
  candidates?: TaxonomyCandidates,
): string {
  const yaml = formatFrontmatterYaml(frontmatter, candidates);
  const cleanBody = body.startsWith('\n') ? body : `\n${body}`;
  return `${yaml}${cleanBody.endsWith('\n') ? cleanBody : cleanBody + '\n'}`;
}

export {
  formatDatePrefix,
  extractDatePrefixFromPath,
  computeArticleRelativePath,
  sanitizeTitleForFilename,
  DEFAULT_MAX_TITLE_BYTES,
  truncateUtf8Bytes,
} from './naming.js';
