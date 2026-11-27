import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalDraftTerm,
  loadLocalTaxonomyTerms,
  updateTaxonomyTerm,
} from '../src/sync/taxonomies.js';
import { promoteDraftTaxonomiesForArticle } from '../src/sync/push/taxonomy_plan.js';
import { loadLocalTaxonomyMaps } from '../src/sync/taxonomies.js';

const tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-update-term-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'categories', 'ja'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'categories', 'en'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tags', 'ja'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'posts', 'ja', 'draft'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'posts', 'ja', 'conflicts'), { recursive: true });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('updateTaxonomyTerm', () => {
  it('updates a remote term via PUT, persists description, and refreshes local YAML mirror', async () => {
    const root = makeTempWorkspace();
    const oldCatId = '01ARZ3NDEKTSV4RRFFQ69G5FA1';
    const parentCatId = '01ARZ3NDEKTSV4RRFFQ69G5FA0';
    fs.writeFileSync(
      path.join(root, 'categories', 'ja', `${parentCatId}-Parent.yaml`),
      `id: "${parentCatId}"\nname: "Parent"\nslug: "parent"\ntaxonomy: "category"\nparentId: null\ncount: 1\nlocale: "ja"\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'categories', 'ja', `${oldCatId}-OldName.yaml`),
      `id: "${oldCatId}"\nname: "OldName"\nslug: "old-slug"\ntaxonomy: "category"\nparentId: null\ncount: 2\nlocale: "ja"\n`,
      'utf8',
    );

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (
        init?.method === 'PUT' &&
        url.includes('/_emdash/api/taxonomies/category/terms/old-slug')
      ) {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({
          label: 'NewName',
          slug: 'new-slug',
          parentId: parentCatId,
          description: 'Updated description',
        });
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              term: {
                id: oldCatId,
                name: 'category',
                slug: 'new-slug',
                label: 'NewName',
                parentId: parentCatId,
                description: 'Updated description',
                locale: 'ja',
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/_emdash/api/taxonomies/category/terms')) {
        return new Response(
          JSON.stringify({
            terms: [
              {
                id: parentCatId,
                slug: 'parent',
                label: 'Parent',
                parentId: null,
                locale: 'ja',
                count: 1,
              },
              {
                id: oldCatId,
                slug: 'new-slug',
                label: 'NewName',
                parentId: parentCatId,
                description: 'Updated description',
                locale: 'ja',
                count: 2,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/_emdash/api/taxonomies/tag/terms')) {
        return new Response(JSON.stringify({ terms: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    const res = await updateTaxonomyTerm({
      workspaceRoot: root,
      origin: 'https://example.test',
      token: 'tok',
      fetchFn: fetchMock,
      taxonomy: 'category',
      target: 'old-slug',
      name: 'NewName',
      slug: 'new-slug',
      parent: 'parent',
      description: 'Updated description',
    });

    expect(res.id).toBe(oldCatId);
    expect(res.name).toBe('NewName');
    expect(res.slug).toBe('new-slug');
    expect(res.parentId).toBe(parentCatId);
    expect(res.description).toBe('Updated description');
    expect(res.isDraft).toBe(false);
    // Old YAML file pruned, new YAML file exists with description
    expect(fs.existsSync(path.join(root, 'categories', 'ja', `${oldCatId}-OldName.yaml`))).toBe(
      false,
    );
    const terms = loadLocalTaxonomyTerms(root);
    const updated = terms.find((t) => t.id === oldCatId);
    expect(updated?.slug).toBe('new-slug');
    expect(updated?.description).toBe('Updated description');
  });

  it('disambiguates translations sharing a slug via --locale and supports --clear-parent', async () => {
    const root = makeTempWorkspace();
    const jaId = '01ARZ3NDEKTSV4RRFFQ69G5FA2';
    const enId = '01ARZ3NDEKTSV4RRFFQ69G5FA3';
    const parentId = '01ARZ3NDEKTSV4RRFFQ69G5FA0';
    fs.writeFileSync(
      path.join(root, 'categories', 'ja', `${jaId}-News.yaml`),
      `id: "${jaId}"\nname: "ニュース"\nslug: "news"\ntaxonomy: "category"\nparentId: "${parentId}"\ncount: 0\nlocale: "ja"\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'categories', 'en', `${enId}-News.yaml`),
      `id: "${enId}"\nname: "News"\nslug: "news"\ntaxonomy: "category"\nparentId: "${parentId}"\ncount: 0\nlocale: "en"\n`,
      'utf8',
    );

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === 'PUT') {
        expect(url).toContain('locale=en');
        expect(JSON.parse(String(init.body))).toEqual({ parentId: null });
        return new Response(
          JSON.stringify({
            term: { id: enId, slug: 'news', label: 'News', parentId: null, locale: 'en' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ terms: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await expect(
      updateTaxonomyTerm({
        workspaceRoot: root,
        origin: 'https://example.test',
        token: 'tok',
        fetchFn: fetchMock,
        taxonomy: 'category',
        target: 'news',
        clearParent: true,
      }),
    ).rejects.toThrow(/Specify --locale/);

    const okRes = await updateTaxonomyTerm({
      workspaceRoot: root,
      origin: 'https://example.test',
      token: 'tok',
      fetchFn: fetchMock,
      taxonomy: 'category',
      target: 'news',
      locale: 'en',
      clearParent: true,
    });
    expect(okRes.id).toBe(enId);
    expect(okRes.parentId).toBeNull();
  });

  it('fails fast with DUPLICATE_TERM_SLUG on rename collision and warns on old slug refs (including conflicts/)', async () => {
    const root = makeTempWorkspace();
    const id1 = '01ARZ3NDEKTSV4RRFFQ69G5FB1';
    const id2 = '01ARZ3NDEKTSV4RRFFQ69G5FB2';
    fs.writeFileSync(
      path.join(root, 'tags', 'ja', `${id1}-未分類.yaml`),
      `id: "${id1}"\nname: "未分類"\nslug: "未分類"\ncanonicalSlug: "%e6%9c%aa%e5%88%86%e9%a1%9e"\ntaxonomy: "tag"\nparentId: null\ncount: 0\nlocale: "ja"\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'tags', 'ja', `${id2}-Existing.yaml`),
      `id: "${id2}"\nname: "Existing"\nslug: "existing"\ntaxonomy: "tag"\nparentId: null\ncount: 0\nlocale: "ja"\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'posts', 'ja', 'draft', 'post-a.md'),
      `---\nid: "01ARZ3NDEKTSV4RRFFQ69G5FE1"\ncollection: "posts"\nlocale: "ja"\ntitle: "Post A"\nslug: "post-a"\nstatus: "draft"\ntaxonomies:\n  tags:\n    - 未分類\n---\nBody\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'posts', 'ja', 'conflicts', 'post-b.md'),
      `---\nid: "01ARZ3NDEKTSV4RRFFQ69G5FE2"\ncollection: "posts"\nlocale: "ja"\ntitle: "Post B"\nslug: "post-b"\nstatus: "draft"\ntaxonomies:\n  tags:\n    - "%e6%9c%aa%e5%88%86%e9%a1%9e"\n---\nBody\n`,
      'utf8',
    );

    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return new Response(
          JSON.stringify({
            term: { id: id1, slug: 'general', label: 'General', parentId: null, locale: 'ja' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ terms: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await expect(
      updateTaxonomyTerm({
        workspaceRoot: root,
        origin: 'https://example.test',
        token: 'tok',
        fetchFn: fetchMock,
        taxonomy: 'tag',
        target: id1,
        slug: 'existing',
      }),
    ).rejects.toThrow(/DUPLICATE_TERM_SLUG/);

    const renamed = await updateTaxonomyTerm({
      workspaceRoot: root,
      origin: 'https://example.test',
      token: 'tok',
      fetchFn: fetchMock,
      taxonomy: 'tag',
      target: id1,
      slug: 'general',
      name: 'General',
    });
    expect(renamed.warnings.length).toBe(1);
    expect(renamed.warnings[0]).toContain('posts/ja/draft/post-a.md');
    expect(renamed.warnings[0]).toContain('posts/ja/conflicts/post-b.md');
  });

  it('updates drafts/ terms offline and forwards description on push promotion', async () => {
    const root = makeTempWorkspace();
    const draft = createLocalDraftTerm({
      workspaceRoot: root,
      taxonomy: 'tag',
      slug: 'offline-tag',
      name: 'Offline Tag',
      locale: 'ja',
    });

    const updated = await updateTaxonomyTerm({
      workspaceRoot: root,
      origin: 'https://example.test',
      token: 'tok',
      taxonomy: 'tag',
      target: draft.filePath,
      name: 'Offline Tag v2',
      description: 'Draft description preserved on push',
    });
    expect(updated.isDraft).toBe(true);
    expect(updated.description).toBe('Draft description preserved on push');

    let postedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          term: {
            id: '01ARZ3NDEKTSV4RRFFQ69G5FC9',
            slug: 'offline-tag',
            label: 'Offline Tag v2',
            description: 'Draft description preserved on push',
            locale: 'ja',
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const maps = loadLocalTaxonomyMaps(root);
    await promoteDraftTaxonomiesForArticle({
      parsed: {
        frontmatter: {
          id: '01ARZ3NDEKTSV4RRFFQ69G5FC0',
          collection: 'posts',
          title: 'Test',
          slug: 'test',
          status: 'draft',
          locale: 'ja',
          bylines: [],
          taxonomies: { tags: ['offline-tag'] },
        },
        body: '',
        rawYaml: '',
      },
      taxonomyMaps: maps,
      options: {
        workspaceRoot: root,
        origin: 'https://example.test',
        token: 'tok',
      } as never,
      fetchFn: fetchMock,
    });

    expect(postedBody?.description).toBe('Draft description preserved on push');
  });

  it('throws TAXONOMY_UPDATE_FAILED on remote HTTP error without mutating local YAML', async () => {
    const root = makeTempWorkspace();
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FD1';
    const yamlPath = path.join(root, 'tags', 'ja', `${id}-Keep.yaml`);
    const originalYaml = `id: "${id}"\nname: "Keep"\nslug: "keep"\ntaxonomy: "tag"\nparentId: null\ncount: 0\nlocale: "ja"\n`;
    fs.writeFileSync(yamlPath, originalYaml, 'utf8');

    const fetchMock = vi.fn(
      async () => new Response('Conflict', { status: 409 }),
    ) as unknown as typeof fetch;

    await expect(
      updateTaxonomyTerm({
        workspaceRoot: root,
        origin: 'https://example.test',
        token: 'tok',
        fetchFn: fetchMock,
        taxonomy: 'tag',
        target: 'keep',
        slug: 'taken',
      }),
    ).rejects.toMatchObject({ code: 'TAXONOMY_UPDATE_FAILED' });

    expect(fs.readFileSync(yamlPath, 'utf8')).toBe(originalYaml);
  });
});
