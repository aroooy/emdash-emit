import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalDraftTerm,
  loadLocalTaxonomyMaps,
  resolveTermIdForLocale,
} from '../src/sync/taxonomies.js';
import {
  canonicalizeFrontmatterTaxonomies,
  promoteDraftTaxonomiesForArticle,
  syncArticleTaxonomies,
} from '../src/sync/push/taxonomy_plan.js';
import { pushAll } from '../src/sync/orchestrator.js';
import { pushArticle } from '../src/sync/push/index.js';
import { CacheDatabase } from '../src/db/cache.js';

const tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-locale-tax-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'categories', 'ja'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'categories', 'en'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tags', 'ja'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tags', 'en'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'posts', 'ja', 'draft'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'posts', 'en', 'draft'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.emit'), { recursive: true });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('locale-scoped taxonomyMaps (v0.2.3)', () => {
  it('promotes drafts/en/ term even when ja already has the same slug with higher count, and sends en termId', async () => {
    const root = makeTempWorkspace();
    const jaAiId = '01ARZ3NDEKTSV4RRFFQ69G5FA1';
    const enAiServerId = '01ARZ3NDEKTSV4RRFFQ69G5FB9';

    fs.writeFileSync(
      path.join(root, 'tags', 'ja', `${jaAiId}-AI.yaml`),
      `id: "${jaAiId}"\nname: "AI（日本語）"\nslug: "ai"\ntaxonomy: "tag"\nparentId: null\ncount: 5\nlocale: "ja"\n`,
      'utf8',
    );

    const draft = createLocalDraftTerm({
      workspaceRoot: root,
      taxonomy: 'tag',
      slug: 'ai',
      name: 'AI',
      locale: 'en',
      translationOf: jaAiId,
    });

    const taxonomyMaps = loadLocalTaxonomyMaps(root);
    // Global slugToId is shadowed by ja (count: 5), but byLocale.en points to the en draft
    expect(taxonomyMaps.slugToId.tag['ai']).toBe(jaAiId);
    expect(taxonomyMaps.byLocale.en?.slugToId.tag['ai']).toBe(draft.id);
    expect(resolveTermIdForLocale(taxonomyMaps, 'tag', 'ai', 'en')).toBe(draft.id);
    expect(resolveTermIdForLocale(taxonomyMaps, 'tag', 'ai', 'ja')).toBe(jaAiId);

    const parsed = {
      frontmatter: {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FC1',
        collection: 'posts',
        title: 'English AI Post',
        slug: 'english-ai-post',
        status: 'draft' as const,
        locale: 'en',
        bylines: [],
        taxonomies: { tags: ['ai'] },
      },
      body: 'Hello',
      rawYaml: '',
    };

    const { resolvedTaxonomies } = canonicalizeFrontmatterTaxonomies(parsed, taxonomyMaps);
    let postedCreateBody: Record<string, unknown> | undefined;
    let postedTermIds: string[] = [];

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/_emdash/api/taxonomies/tag/terms') && init?.method === 'POST') {
        postedCreateBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            term: {
              id: enAiServerId,
              slug: 'ai',
              label: 'AI',
              locale: 'en',
              translationGroup: jaAiId,
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/terms/tag') && init?.method === 'POST') {
        postedTermIds = JSON.parse(String(init.body)).termIds;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    const promoted = await promoteDraftTaxonomiesForArticle({
      parsed,
      taxonomyMaps,
      options: { workspaceRoot: root, origin: 'https://example.test', token: 'tok' } as never,
      fetchFn: fetchMock,
    });

    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.id).toBe(enAiServerId);
    expect(postedCreateBody?.locale).toBe('en');
    expect(postedCreateBody?.translationOf).toBe(jaAiId);
    // ja map must remain intact!
    expect(taxonomyMaps.byLocale.ja?.slugToId.tag['ai']).toBe(jaAiId);
    expect(taxonomyMaps.byLocale.en?.slugToId.tag['ai']).toBe(enAiServerId);

    const failures = await syncArticleTaxonomies({
      articleId: '01ARZ3NDEKTSV4RRFFQ69G5FC1',
      collection: 'posts',
      parsed,
      taxonomyMaps,
      resolvedTaxonomies,
      baseSnapshot: null,
      options: { workspaceRoot: root, origin: 'https://example.test', token: 'tok' } as never,
      fetchFn: fetchMock,
      warnings: [],
    });

    expect(failures).toEqual([]);
    expect(postedTermIds).toEqual([enAiServerId]);
  });

  it('pushAll routes ja and en articles with same slug "ai" to their respective locale termIds', async () => {
    const root = makeTempWorkspace();
    const cache = new CacheDatabase(path.join(root, '.emit', 'cache.db'));
    const jaAiId = '01ARZ3NDEKTSV4RRFFQ69G5FA1';
    const enAiServerId = '01ARZ3NDEKTSV4RRFFQ69G5FB9';

    fs.writeFileSync(
      path.join(root, 'tags', 'ja', `${jaAiId}-AI.yaml`),
      `id: "${jaAiId}"\nname: "AI"\nslug: "ai"\ntaxonomy: "tag"\nparentId: null\ncount: 5\nlocale: "ja"\n`,
      'utf8',
    );
    createLocalDraftTerm({
      workspaceRoot: root,
      taxonomy: 'tag',
      slug: 'ai',
      name: 'AI',
      locale: 'en',
      translationOf: jaAiId,
    });

    const jaPostId = '01ARZ3NDEKTSV4RRFFQ69G5FD1';
    const enPostId = '01ARZ3NDEKTSV4RRFFQ69G5FD2';
    fs.writeFileSync(
      path.join(root, 'posts', 'ja', 'draft', `${jaPostId}-ja.md`),
      `---\nid: "${jaPostId}"\ncollection: "posts"\nlocale: "ja"\ntitle: "JA Post"\nslug: "ja-post"\nstatus: "draft"\ntaxonomies:\n  tags:\n    - ai\n---\nJA body\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'posts', 'en', 'draft', `${enPostId}-en.md`),
      `---\nid: "${enPostId}"\ncollection: "posts"\nlocale: "en"\ntitle: "EN Post"\nslug: "en-post"\nstatus: "draft"\ntaxonomies:\n  tags:\n    - ai\n---\nEN body\n`,
      'utf8',
    );

    const assignedByPost: Record<string, string[]> = {};
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || 'GET';
      if (url.endsWith('/_emdash/api/taxonomies/category/terms') && method === 'GET') {
        return new Response(JSON.stringify({ terms: [] }), { status: 200 });
      }
      if (url.endsWith('/_emdash/api/taxonomies/tag/terms') && method === 'GET') {
        return new Response(
          JSON.stringify({
            terms: [{ id: jaAiId, slug: 'ai', label: 'AI', locale: 'ja', count: 5 }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/_emdash/api/taxonomies/tag/terms') && method === 'POST') {
        return new Response(
          JSON.stringify({
            term: {
              id: enAiServerId,
              slug: 'ai',
              label: 'AI',
              locale: 'en',
              translationGroup: jaAiId,
            },
          }),
          { status: 201 },
        );
      }
      if (url.includes('/_emdash/api/bylines') && method === 'GET') {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (
        url.includes('/_emdash/api/content/posts/') &&
        url.endsWith('/terms/tag') &&
        method === 'POST'
      ) {
        const postId = url.split('/posts/')[1]!.split('/')[0]!;
        assignedByPost[postId] = JSON.parse(String(init?.body)).termIds;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.includes('/_emdash/api/content/posts/') && method === 'GET') {
        return new Response('Not Found', { status: 404 });
      }
      if (url.endsWith('/_emdash/api/content/posts') && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        const id = body.id;
        return new Response(
          JSON.stringify({
            item: {
              id,
              slug: body.slug,
              status: 'draft',
              locale: body.locale,
              version: 1,
              _rev: 'r1',
            },
          }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    await pushAll({
      workspaceRoot: root,
      cache,
      origin: 'https://example.test',
      token: 'tok',
      fetchFn: fetchMock,
    });

    expect(assignedByPost[jaPostId]).toEqual([jaAiId]);
    expect(assignedByPost[enPostId]).toEqual([enAiServerId]);
    cache.close();
  });

  it('emits non-blocking fallback warning when en has its own tags but uses a ja-only tag, and passes silently when en tags are empty', async () => {
    const root = makeTempWorkspace();
    const cache = new CacheDatabase(path.join(root, '.emit', 'cache.db'));
    const jaOnlyId = '01ARZ3NDEKTSV4RRFFQ69G5FE1';
    const enOtherId = '01ARZ3NDEKTSV4RRFFQ69G5FE2';
    const enPostId = '01ARZ3NDEKTSV4RRFFQ69G5FE9';

    fs.writeFileSync(
      path.join(root, 'tags', 'ja', `${jaOnlyId}-JaOnly.yaml`),
      `id: "${jaOnlyId}"\nname: "JaOnly"\nslug: "ja-only"\ntaxonomy: "tag"\nparentId: null\ncount: 1\nlocale: "ja"\n`,
      'utf8',
    );
    const enPostPath = path.join(root, 'posts', 'en', 'draft', `${enPostId}-en.md`);
    fs.writeFileSync(
      enPostPath,
      `---\nid: "${enPostId}"\ncollection: "posts"\nlocale: "en"\ntitle: "EN Post"\nslug: "en-fallback"\nstatus: "draft"\ntaxonomies:\n  tags:\n    - ja-only\n---\nBody\n`,
      'utf8',
    );

    const makeFetch = () =>
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const method = init?.method || 'GET';
        if (url.includes('/_emdash/api/bylines')) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        if (url.includes('/_emdash/api/content/posts/') && method === 'GET') {
          return new Response('Not Found', { status: 404 });
        }
        if (url.endsWith('/_emdash/api/content/posts') && method === 'POST') {
          return new Response(
            JSON.stringify({
              item: {
                id: enPostId,
                slug: 'en-fallback',
                status: 'draft',
                locale: 'en',
                version: 1,
                _rev: 'r1',
              },
            }),
            { status: 201 },
          );
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }) as unknown as typeof fetch;

    // 1. Anchor: tags/en/ is empty -> global fallback passes without locale-fallback warning
    const resEmpty = await pushArticle(enPostPath, {
      workspaceRoot: root,
      cache,
      origin: 'https://example.test',
      token: 'tok',
      fetchFn: makeFetch(),
    });
    expect(resEmpty.warnings.some((w) => w.includes('not found in locale "en"'))).toBe(false);

    // 2. Now tags/en/ has another tag -> warns non-blockingly about fallback
    fs.writeFileSync(
      path.join(root, 'tags', 'en', `${enOtherId}-Other.yaml`),
      `id: "${enOtherId}"\nname: "Other"\nslug: "other"\ntaxonomy: "tag"\nparentId: null\ncount: 1\nlocale: "en"\n`,
      'utf8',
    );
    fs.writeFileSync(
      enPostPath,
      `---\nid: "${enPostId}"\ncollection: "posts"\nlocale: "en"\ntitle: "EN Post v2"\nslug: "en-fallback"\nstatus: "draft"\ntaxonomies:\n  tags:\n    - ja-only\n---\nBody v2\n`,
      'utf8',
    );
    const resNonEmpty = await pushArticle(enPostPath, {
      workspaceRoot: root,
      cache,
      origin: 'https://example.test',
      token: 'tok',
      fetchFn: makeFetch(),
    });
    expect(resNonEmpty.warnings.some((w) => w.includes('not found in locale "en"'))).toBe(true);
    cache.close();
  });
});
