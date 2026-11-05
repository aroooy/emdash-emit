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

import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulidx';
import {
  computeArticleRelativePath,
  serializeMarkdown,
  type Frontmatter,
  type TaxonomyCandidates,
} from '../utils/frontmatter.js';
import { loadLocalTaxonomyCandidates } from './taxonomies.js';
import type { CacheDatabase } from '../db/cache.js';

export interface CreateArticleOptions {
  workspaceRoot: string;
  slug: string;
  title?: string;
  collection?: string;
  locale?: string;
  byline?: string;
  cache?: CacheDatabase;
  candidates?: TaxonomyCandidates;
}

export interface CreateArticleResult {
  id: string;
  slug: string;
  filePath: string;
  fullPath: string;
}

/**
 * Creates a brand-new article scaffold in <collection>/draft/<ulid>-<slug>.md.
 * Assigns a client-side ULID immediately to guarantee ID/filename consistency (G2).
 */
export function createArticleScaffold(options: CreateArticleOptions): CreateArticleResult {
  const id = ulid();
  const collection = options.collection || 'posts';
  const slug = options.slug.trim().toLowerCase();
  const title = options.title || slug;
  const locale = options.locale || 'ja';

  let initialBylines: string[] = [];
  if (options.byline) {
    initialBylines = [options.byline];
  } else if (options.cache) {
    const cached = options.cache.getBylines().filter((b) => !b.isGuest);
    if (cached.length > 0 && cached[0].slug) {
      initialBylines = [cached[0].slug];
    }
  }

  const frontmatter: Frontmatter = {
    id,
    slug,
    title,
    collection,
    status: 'draft',
    publishedAt: null,
    locale,
    taxonomies: {
      categories: [],
      tags: [],
    },
    bylines: initialBylines,
  };

  const initialBody = 'Write article body content here...\n';
  const candidates = options.candidates || loadLocalTaxonomyCandidates(options.workspaceRoot);
  const markdownContent = serializeMarkdown(frontmatter, initialBody, candidates);

  const relPath = computeArticleRelativePath(collection, 'draft', id, title || slug, new Date());
  const fullPath = path.join(options.workspaceRoot, relPath);

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, markdownContent, 'utf8');

  return {
    id,
    slug,
    filePath: relPath,
    fullPath,
  };
}
