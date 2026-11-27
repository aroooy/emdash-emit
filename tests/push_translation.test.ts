import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheDatabase } from '../src/db/cache.js';
import { createArticleScaffold, DuplicateSlugError } from '../src/sync/new.js';
import { pushArticle } from '../src/sync/push/index.js';
import { apiResponseToLocal } from '../src/client/mapper.js';
import { parseMarkdown, serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';

describe('i18n Translation Lifecycle (v0.1.66)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-i18n-test-'));
    cache = new CacheDatabase(path.join(tempDir, 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('preserves byte-for-byte frontmatter for single-locale articles and round-trips translationOf/translationGroup', () => {
    const baseFm: Frontmatter = {
      id: '01M7S6TX8RPWADQJVVNHAV6F6F',
      slug: 'single-locale-post',
      title: 'Single Locale Post',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: { categories: [], tags: [] },
      bylines: [],
    };
    const serializedBase = serializeMarkdown(baseFm, 'Body\n');
    expect(serializedBase).not.toContain('translationOf:');
    expect(serializedBase).not.toContain('translationGroup:');

    const translatedFm: Frontmatter = {
      ...baseFm,
      id: '01M8DC4G4ETTGNRH3K0P7V8K1Z',
      locale: 'en',
      translationOf: '01M7S6TX8RPWADQJVVNHAV6F6F',
      translationGroup: '01M7S6TX8RPWADQJVVNHAV6F6F',
    };
    const serializedTrans = serializeMarkdown(translatedFm, 'English Body\n');
    expect(serializedTrans).toContain('translationOf: 01M7S6TX8RPWADQJVVNHAV6F6F');
    expect(serializedTrans).toContain('translationGroup: 01M7S6TX8RPWADQJVVNHAV6F6F');

    const reparsed = parseMarkdown(serializedTrans);
    expect(reparsed.frontmatter.translationOf).toBe('01M7S6TX8RPWADQJVVNHAV6F6F');
    expect(reparsed.frontmatter.translationGroup).toBe('01M7S6TX8RPWADQJVVNHAV6F6F');
  });

  it('supports --translation-of inheritance, allows same slug across locales, and enforces G18 per (collection, locale, slug)', () => {
    const jaRes = createArticleScaffold({
      workspaceRoot: tempDir,
      slug: 'shared-slug',
      title: '日本語タイトル',
      locale: 'ja',
      byline: 'aroooy',
      featuredImage: '01M67P0MBMJQQXH2K95HHCYRYB',
      categories: ['tech'],
      cache,
    });

    // Same slug + same locale (case-insensitive) -> Guard G18 DUPLICATE_SLUG_CONFLICT
    expect(() =>
      createArticleScaffold({
        workspaceRoot: tempDir,
        slug: 'shared-slug',
        locale: 'JA',
        cache,
      }),
    ).toThrow(DuplicateSlugError);

    // Same locale as source with --translation-of -> rejected
    expect(() =>
      createArticleScaffold({
        workspaceRoot: tempDir,
        translationOf: jaRes.filePath,
        locale: 'ja',
        cache,
      }),
    ).toThrow(/already has locale "ja"/);

    // Missing source -> helpful emit pull hint
    expect(() =>
      createArticleScaffold({
        workspaceRoot: tempDir,
        translationOf: '01M9M1SS1NG000000000000000',
        locale: 'en',
        cache,
      }),
    ).toThrow(/emit pull 01M9M1SS1NG000000000000000/);

    // Different locale with --translation-of (omitting slug) -> inherits slug, featuredImage, bylines; leaves taxonomies empty with warning
    const enRes = createArticleScaffold({
      workspaceRoot: tempDir,
      translationOf: jaRes.id,
      locale: 'en',
      title: 'English Title',
      cache,
    });

    expect(enRes.slug).toBe('shared-slug');
    expect(enRes.assigned.featuredImage).toBe('01M67P0MBMJQQXH2K95HHCYRYB');
    expect(enRes.assigned.categories).toEqual([]);
    expect(enRes.warnings.some((w) => w.includes('Skipped category'))).toBe(true);

    const parsedEn = parseMarkdown(fs.readFileSync(enRes.fullPath, 'utf8'));
    expect(parsedEn.frontmatter.locale).toBe('en');
    expect(parsedEn.frontmatter.translationOf).toBe(jaRes.id);
    expect(parsedEn.frontmatter.bylines).toEqual(['aroooy']);

    // Duplicate (posts, en, shared-slug) now blocked by G18
    expect(() =>
      createArticleScaffold({
        workspaceRoot: tempDir,
        slug: 'shared-slug',
        locale: 'EN',
        cache,
      }),
    ).toThrow(DuplicateSlugError);
  });

  it('sends translationOf on create push and writes returned translationGroup back to disk while clearing translationOf', async () => {
    const sourceId = '01M7S6TX8RPWADQJVVNHAV6F6F';
    const groupId = '01M7GROUP00000000000000001';
    const jaRes = createArticleScaffold({
      workspaceRoot: tempDir,
      slug: 'bilingual-post',
      title: '日本語記事',
      locale: 'ja',
      cache,
    });

    // Replace source ID with deterministic ULID for clarity
    const jaRaw = fs.readFileSync(jaRes.fullPath, 'utf8').replace(jaRes.id, sourceId);
    const jaNewPath = jaRes.fullPath.replace(jaRes.id, sourceId);
    fs.writeFileSync(jaNewPath, jaRaw, 'utf8');
    fs.unlinkSync(jaRes.fullPath);

    const enRes = createArticleScaffold({
      workspaceRoot: tempDir,
      translationOf: sourceId,
      locale: 'en',
      title: 'English Post',
      cache,
    });

    let capturedPayload: Record<string, unknown> | undefined;
    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/_emdash/api/content/posts') && init?.method === 'POST') {
        capturedPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              item: {
                id: enRes.id,
                slug: 'bilingual-post',
                status: 'draft',
                locale: 'en',
                translationGroup: groupId,
                version: 1,
                draftRevisionId: '01M8DRAFT00000000000000001',
              },
              _rev: 'MToyMDI2LTExLTI3VDAwOjAwOjAwLjAwMFo=',
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: { items: [] } }),
      });
    });

    const pushRes = await pushArticle(enRes.filePath, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(pushRes.success).toBe(true);
    expect(capturedPayload?.locale).toBe('en');
    expect(capturedPayload?.translationOf).toBe(sourceId);

    const updatedDisk = parseMarkdown(
      fs.readFileSync(path.join(tempDir, pushRes.filePath), 'utf8'),
    );
    expect(updatedDisk.frontmatter.translationGroup).toBe(groupId);
    expect(updatedDisk.frontmatter.translationOf).toBeUndefined();
  });

  it('maps remote translation_group / translationGroup into frontmatter via apiResponseToLocal', () => {
    const mapped = apiResponseToLocal({
      success: true,
      data: {
        item: {
          id: '01M8DC4G4ETTGNRH3K0P7V8K1Z',
          slug: 'bilingual-post',
          collection: 'posts',
          status: 'published',
          locale: 'en',
          translation_group: '01M7GROUP00000000000000001',
          data: { title: 'English Post', content: [] },
        },
        _rev: 'rev-1',
      },
    });
    expect(mapped.frontmatter.translationGroup).toBe('01M7GROUP00000000000000001');
  });
});
