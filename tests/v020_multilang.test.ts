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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheDatabase } from '../src/db/cache.js';
import { initWorkspace, loadConfig } from '../src/utils/config.js';
import { computeArticleRelativePath } from '../src/utils/naming.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';
import { pullTaxonomies, loadLocalTaxonomyTerms } from '../src/sync/taxonomies.js';
import { createArticleScaffold } from '../src/sync/new.js';
import { getWorkspaceStatus, buildTranslationCoverage } from '../src/sync/status.js';
import { runWorkspaceDoctor } from '../src/sync/doctor.js';
import { diffConflict, resolveConflict } from '../src/sync/conflicts.js';
import { resolveCanonicalArticlePath } from '../src/sync/workspace/index.js';

describe('v0.2.0 Multi-Language First Workspace & DX', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-v020-'));
    initWorkspace(tempDir);
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Step A: 3-tier locale layout & strict locale requirement', () => {
    it('computes 3-tier relative path and rejects empty locale', () => {
      const rel = computeArticleRelativePath(
        'posts',
        'published',
        '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        'hello-world',
        '2026-11-27T00:00:00Z',
        'en',
      );
      expect(rel).toBe('posts/en/published/20261127_01ARZ3NDEKTSV4RRFFQ69G5FAV-hello-world.md');

      expect(() =>
        computeArticleRelativePath(
          'posts',
          'draft',
          '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          'hello-world',
          null,
          '  ',
        ),
      ).toThrow(/locale/i);

      expect(() =>
        resolveCanonicalArticlePath(
          'posts',
          'draft',
          '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          'hello',
          {},
          undefined,
          '',
        ),
      ).toThrow(/locale/i);
    });

    it('emits legacy_flat_layout warning in emit doctor when 2-tier files exist', async () => {
      fs.mkdirSync(path.join(tempDir, 'posts', 'published'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'posts', 'published', '20261127_01ARZ3NDEKTSV4RRFFQ69G5FAV-legacy.md'),
        '# legacy',
        'utf8',
      );

      const report = await runWorkspaceDoctor({
        workspaceRoot: tempDir,
        cache,
        config: loadConfig(tempDir),
        collection: 'posts',
      });
      const legacyCheck = report.checks.find((c) => c.id === 'legacy_flat_layout');
      expect(legacyCheck).toBeDefined();
      expect(legacyCheck?.status).toBe('warning');
      expect(legacyCheck?.message).toContain('posts/published');
    });

    it('diffs and resolves quarantined conflict copy against 3-tier canonical path', () => {
      const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
      const canonicalRel = `posts/en/published/20261127_${id}-hello.md`;
      const conflictRel = `posts/conflicts/20261127_${id}-hello.conflict-1.md`;
      fs.mkdirSync(path.join(tempDir, 'posts', 'en', 'published'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'posts', 'conflicts'), { recursive: true });

      const fm: Frontmatter = {
        id,
        slug: 'hello',
        title: 'Hello',
        collection: 'posts',
        status: 'published',
        publishedAt: '2026-11-27T00:00:00Z',
        locale: 'en',
        taxonomies: { categories: [], tags: [] },
        bylines: [],
      };
      fs.writeFileSync(
        path.join(tempDir, canonicalRel),
        serializeMarkdown(fm, 'Canonical body\n'),
        'utf8',
      );
      fs.writeFileSync(
        path.join(tempDir, conflictRel),
        serializeMarkdown(fm, 'Conflict body\n'),
        'utf8',
      );

      const diff = diffConflict({
        workspaceRoot: tempDir,
        filePath: conflictRel,
        collection: 'posts',
      });
      expect(diff.canonicalFilePath).toBe(canonicalRel);
      expect(diff.diffText).toContain('Conflict body');

      const resolved = resolveConflict({
        workspaceRoot: tempDir,
        cache,
        filePath: conflictRel,
        strategy: 'accept-canonical',
        collection: 'posts',
      });
      expect(resolved.success).toBe(true);
      expect(fs.existsSync(path.join(tempDir, conflictRel))).toBe(false);
    });
  });

  describe('Step B: Taxonomy locale/translationGroup & --translation-of Auto-Map', () => {
    it('pullTaxonomies serializes locale & translationGroup and loadLocalTaxonomyTerms reads them', async () => {
      const mockFetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/categories/terms') || url.includes('/category/terms')) {
          return new Response(
            JSON.stringify({
              terms: [
                {
                  id: '01CATJA0000000000000000001',
                  slug: 'news-ja',
                  label: 'ニュース',
                  locale: 'ja',
                  translationGroup: '01GRP000000000000000000001',
                  count: 5,
                },
                {
                  id: '01CATEN0000000000000000002',
                  slug: 'news-en',
                  label: 'News',
                  locale: 'en',
                  translation_group: '01GRP000000000000000000001',
                  count: 2,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            terms: [
              { id: '01TAGJA0000000000000000001', slug: 'ai', label: 'AI', locale: 'ja', count: 3 },
              { id: '01TAGEN0000000000000000002', slug: 'ai', label: 'AI', locale: 'en', count: 1 },
              {
                id: '01TAGJA0000000000000000003',
                slug: 'only-ja',
                label: 'Only JA',
                locale: 'ja',
                count: 1,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch;

      const res = await pullTaxonomies({
        workspaceRoot: tempDir,
        origin: 'https://example.test',
        token: 'tok',
        fetchFn: mockFetch,
      });
      expect(res.categoriesCount).toBe(2);
      expect(res.tagsCount).toBe(3);

      expect(
        fs.existsSync(
          path.join(tempDir, 'categories', 'ja', '01CATJA0000000000000000001-ニュース.yaml'),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(tempDir, 'categories', 'en', '01CATEN0000000000000000002-News.yaml'),
        ),
      ).toBe(true);

      const terms = loadLocalTaxonomyTerms(tempDir);
      const newsEn = terms.find((t) => t.id === '01CATEN0000000000000000002');
      expect(newsEn?.locale).toBe('en');
      expect(newsEn?.translationGroup).toBe('01GRP000000000000000000001');
    });

    it('reads legacy flat YAML transparently and prunes it on next successful pullTaxonomies, warning on missing locale', async () => {
      const legacyFlat = path.join(tempDir, 'categories', '01LEGACY000000000000000001-legacy.yaml');
      fs.mkdirSync(path.dirname(legacyFlat), { recursive: true });
      fs.writeFileSync(
        legacyFlat,
        'id: 01LEGACY000000000000000001\nname: Legacy\nslug: legacy\ntaxonomy: category\nparentId: null\ncount: 0\n',
        'utf8',
      );
      // Read-only compatibility before pull
      expect(loadLocalTaxonomyTerms(tempDir).some((t) => t.slug === 'legacy')).toBe(true);

      const mockFetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/categories/terms') || url.includes('/category/terms')) {
          return new Response(
            JSON.stringify({
              terms: [{ id: '01CATNOLOC0000000000000001', slug: 'no-loc', label: 'NoLoc' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ terms: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const res = await pullTaxonomies({
        workspaceRoot: tempDir,
        origin: 'https://example.test',
        token: 'tok',
        fetchFn: mockFetch,
      });

      // Legacy flat file was pruned and term without locale defaulted to 'ja' with warning
      expect(fs.existsSync(legacyFlat)).toBe(false);
      expect(res.deletedCategoriesCount).toBe(1);
      expect(res.warnings?.some((w) => w.includes('defaulted to "ja"'))).toBe(true);
      expect(
        fs.existsSync(
          path.join(tempDir, 'categories', 'ja', '01CATNOLOC0000000000000001-NoLoc.yaml'),
        ),
      ).toBe(true);
    });

    it('auto-maps taxonomies by translationGroup then same-slug fallback, and supports --inherit-taxonomies / --no-taxonomies', async () => {
      // Seed local taxonomy files
      fs.mkdirSync(path.join(tempDir, 'categories'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'tags'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'categories', '01CATJA0000000000000000001-news.yaml'),
        'id: 01CATJA0000000000000000001\nname: ニュース\nslug: news-ja\ntaxonomy: category\nparentId: null\ncount: 5\nlocale: ja\ntranslationGroup: 01GRP000000000000000000001\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(tempDir, 'categories', '01CATEN0000000000000000002-news.yaml'),
        'id: 01CATEN0000000000000000002\nname: News\nslug: news-en\ntaxonomy: category\nparentId: null\ncount: 2\nlocale: en\ntranslationGroup: 01GRP000000000000000000001\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(tempDir, 'tags', '01TAGJA0000000000000000001-ai.yaml'),
        'id: 01TAGJA0000000000000000001\nname: AI\nslug: ai\ntaxonomy: tag\nparentId: null\ncount: 3\nlocale: ja\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(tempDir, 'tags', '01TAGEN0000000000000000002-ai.yaml'),
        'id: 01TAGEN0000000000000000002\nname: AI\nslug: ai\ntaxonomy: tag\nparentId: null\ncount: 1\nlocale: en\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(tempDir, 'tags', '01TAGJA0000000000000000003-only-ja.yaml'),
        'id: 01TAGJA0000000000000000003\nname: Only JA\nslug: only-ja\ntaxonomy: tag\nparentId: null\ncount: 1\nlocale: ja\n',
        'utf8',
      );

      const src = createArticleScaffold({
        workspaceRoot: tempDir,
        slug: 'my-guide',
        title: 'マイガイド',
        locale: 'ja',
        categories: ['news-ja'],
        tags: ['ai', 'only-ja'],
        cache,
      });

      // Default Auto-Map: news-ja -> news-en (via translationGroup), ai -> ai (same-slug), only-ja -> skipped with warning
      const autoEn = createArticleScaffold({
        workspaceRoot: tempDir,
        locale: 'en',
        translationOf: src.id,
        cache,
      });
      expect(autoEn.filePath).toMatch(/^posts\/en\/draft\//);
      expect(autoEn.assigned.categories).toEqual(['news-en']);
      expect(autoEn.assigned.tags).toEqual(['ai']);
      expect(autoEn.warnings.some((w) => w.includes('only-ja'))).toBe(true);

      // --inherit-taxonomies copies raw slugs directly
      const inheritFr = createArticleScaffold({
        workspaceRoot: tempDir,
        locale: 'fr',
        translationOf: src.id,
        inheritTaxonomies: true,
        cache,
      });
      expect(inheritFr.assigned.categories).toEqual(['news-ja']);
      expect(inheritFr.assigned.tags).toEqual(['ai', 'only-ja']);

      // --no-taxonomies skips mapping completely
      const noneDe = createArticleScaffold({
        workspaceRoot: tempDir,
        locale: 'de',
        translationOf: src.id,
        noTaxonomies: true,
        cache,
      });
      expect(noneDe.assigned.categories).toEqual([]);
      expect(noneDe.assigned.tags).toEqual([]);
    });
  });

  describe('Step B: Status translation coverage matrix (--i18n)', () => {
    it('populates locale & translationGroup on status items and computes missingPairs', () => {
      const groupA = '01TRGRP000000000000000000A';
      const writeArt = (id: string, locale: string, slug: string, translationGroup?: string) => {
        const rel = computeArticleRelativePath(
          'posts',
          'published',
          id,
          slug,
          '2026-11-27',
          locale,
        );
        const full = path.join(tempDir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        const fm: Frontmatter = {
          id,
          slug,
          title: `${slug}-${locale}`,
          collection: 'posts',
          status: 'published',
          publishedAt: '2026-11-27T00:00:00Z',
          locale,
          ...(translationGroup ? { translationGroup } : {}),
          taxonomies: { categories: [], tags: [] },
          bylines: [],
        };
        fs.writeFileSync(full, serializeMarkdown(fm, 'Body\n'), 'utf8');
      };

      writeArt('01ART000000000000000000001', 'ja', 'guide', groupA);
      writeArt('01ART000000000000000000002', 'en', 'guide', groupA);
      writeArt('01ART000000000000000000003', 'fr', 'french-only');

      const status = getWorkspaceStatus(tempDir, cache, 'posts');
      expect(status.items.find((i) => i.id === '01ART000000000000000000001')?.locale).toBe('ja');
      expect(
        status.items.find((i) => i.id === '01ART000000000000000000001')?.translationGroup,
      ).toBe(groupA);

      const coverage = buildTranslationCoverage(status.items);
      expect(coverage.locales).toEqual(['en', 'fr', 'ja']);
      expect(coverage.ungroupedCount).toBe(1);
      expect(coverage.groups).toHaveLength(1);
      expect(coverage.missingPairs).toEqual([
        {
          translationGroup: groupA,
          presentLocales: ['en', 'ja'],
          missingLocales: ['fr'],
        },
      ]);
    });
  });
});
