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
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheDatabase } from '../src/db/cache.js';
import { createArticleScaffold, DuplicateSlugError } from '../src/sync/new.js';
import { parseMarkdown } from '../src/utils/frontmatter.js';

describe('createArticleScaffold (emit new / sync_new)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-scaffold-test-'));
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('scaffolds a canonical ULID filename under <collection>/draft and keeps id/filename consistent', () => {
    const res = createArticleScaffold({ workspaceRoot: tempDir, slug: 'My-Slug', cache });
    const parsed = parseMarkdown(fs.readFileSync(res.fullPath, 'utf8'));

    expect(res.id).toHaveLength(26);
    expect(res.slug).toBe('my-slug');
    expect(res.filePath).toMatch(/^posts\/draft\/\d{8}_[0-9A-HJ-NP-Z]{26}-my-slug\.md$/);
    expect(parsed.frontmatter.id).toBe(res.id);
    expect(parsed.frontmatter.slug).toBe('my-slug');
    expect(parsed.frontmatter.status).toBe('draft');
    // Guard G2: filename ULID must equal frontmatter id
    expect(res.filePath).toContain(res.id);
  });

  it('falls back to the slug for the title and to ja for the locale', () => {
    const res = createArticleScaffold({ workspaceRoot: tempDir, slug: 'title-fallback', cache });
    const parsed = parseMarkdown(fs.readFileSync(res.fullPath, 'utf8'));
    expect(parsed.frontmatter.title).toBe('title-fallback');
    expect(parsed.frontmatter.locale).toBe('ja');

    const titled = createArticleScaffold({
      workspaceRoot: tempDir,
      slug: 'with-title',
      title: 'Explicit Title',
      locale: 'en',
      collection: 'notes',
      cache,
    });
    const titledParsed = parseMarkdown(fs.readFileSync(titled.fullPath, 'utf8'));
    expect(titledParsed.frontmatter.title).toBe('Explicit Title');
    expect(titledParsed.frontmatter.locale).toBe('en');
    expect(titled.filePath).toMatch(/^notes\/draft\/\d{8}_[0-9A-HJ-NP-Z]{26}-Explicit-Title\.md$/);
  });

  it('uses the first cached non-guest byline by slug ASC as the default author', () => {
    cache.saveBylines(
      [
        {
          id: '01M6BZZZ000000000000000000Z1',
          slug: 'zzz-author',
          displayName: 'Zzz',
          isGuest: false,
          rawJson: '{}',
        },
        {
          id: '01M6BGUEST00000000000000000G',
          slug: 'aaa-guest',
          displayName: 'Guest',
          isGuest: true,
          rawJson: '{}',
        },
        {
          id: '01M6BAROOY00000000000000000R',
          slug: 'aroooy',
          displayName: 'Aroooy',
          isGuest: false,
          rawJson: '{}',
        },
      ],
      true,
    );

    const res = createArticleScaffold({ workspaceRoot: tempDir, slug: 'default-byline', cache });
    const parsed = parseMarkdown(fs.readFileSync(res.fullPath, 'utf8'));
    expect(parsed.frontmatter.bylines).toEqual(['aroooy']);
  });

  it('honours an explicit byline slug and leaves bylines empty without a cache', () => {
    const explicit = createArticleScaffold({
      workspaceRoot: tempDir,
      slug: 'explicit-byline',
      byline: 'zzz-author',
      cache,
    });
    const explicitParsed = parseMarkdown(fs.readFileSync(explicit.fullPath, 'utf8'));
    expect(explicitParsed.frontmatter.bylines).toEqual(['zzz-author']);

    const uncached = createArticleScaffold({ workspaceRoot: tempDir, slug: 'no-cache-byline' });
    const uncachedParsed = parseMarkdown(fs.readFileSync(uncached.fullPath, 'utf8'));
    expect(uncachedParsed.frontmatter.bylines).toEqual([]);
  });

  describe('Duplicate Slug Guard (§3.1)', () => {
    it('aborts with DuplicateSlugError if the same slug exists on disk in draft or published', () => {
      createArticleScaffold({ workspaceRoot: tempDir, slug: 'taiwan-travel', cache });

      expect(() => {
        createArticleScaffold({ workspaceRoot: tempDir, slug: 'taiwan-travel', cache });
      }).toThrow(DuplicateSlugError);

      try {
        createArticleScaffold({ workspaceRoot: tempDir, slug: 'TAIWAN-TRAVEL', cache });
        expect.unreachable('Should have thrown DuplicateSlugError');
      } catch (err) {
        expect(err).toBeInstanceOf(DuplicateSlugError);
        const dupErr = err as DuplicateSlugError;
        expect(dupErr.code).toBe('DUPLICATE_SLUG_CONFLICT');
        expect(dupErr.slug).toBe('taiwan-travel');
        expect(dupErr.existingFilePath).toContain('taiwan-travel.md');
        expect(dupErr.message).toContain(
          "Conflict: An article with slug 'taiwan-travel' already exists!",
        );
        expect(dupErr.suggestion).toBe('Edit the existing file, or pick a unique slug.');
      }
    });

    it('aborts with DuplicateSlugError if slug exists in cache.db entries', () => {
      cache.saveEntry({
        id: '01M67REMOTE0000000000000001',
        collection: 'posts',
        slug: 'cached-remote-post',
        status: 'published',
        title: 'Cached Remote Post',
        rev: 'rev-1',
        publishedAt: '2026-11-01T00:00:00Z',
        rawJson: '{}',
        updatedAt: Math.floor(Date.now() / 1000),
      });

      expect(() => {
        createArticleScaffold({ workspaceRoot: tempDir, slug: 'cached-remote-post', cache });
      }).toThrow(DuplicateSlugError);
    });

    it('never touches the network when scaffolding (zero-communication local-first)', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        const res = createArticleScaffold({
          workspaceRoot: tempDir,
          slug: 'offline-scaffold',
          cache,
        });
        expect(res).toBeDefined();
        expect(res.slug).toBe('offline-scaffold');
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
