import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CacheDatabase } from '../src/db/cache.js';
import { getWorkspaceStatus } from '../src/sync/status.js';
import {
  createLocalDraftTerm,
  loadLocalTaxonomyCandidates,
  promoteAllDraftTerms,
} from '../src/sync/taxonomies.js';
import { serializeMarkdown } from '../src/utils/frontmatter.js';
import { isLocalFileUnmodified } from '../src/sync/baseline-reconstruction.js';
import { resolveNoTaxonomyAuditOption, loadConfig } from '../src/utils/config.js';
import { pushArticle } from '../src/sync/push/index.js';
import { computeTaxonomyHash } from '../src/sync/terms.js';

const tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-v024-'));
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

describe('v0.2.4 DX, draft term promotion, byLocale comments, and taxonomy perf', () => {
  it('Feature 1: getWorkspaceStatus reports pending draftTerms under categories/drafts and tags/drafts', () => {
    const root = makeTempWorkspace();
    const cache = new CacheDatabase(path.join(root, '.emit', 'cache.db'));

    createLocalDraftTerm({
      workspaceRoot: root,
      taxonomy: 'category',
      slug: 'guides',
      name: 'Guides',
      locale: 'en',
    });
    createLocalDraftTerm({
      workspaceRoot: root,
      taxonomy: 'tag',
      slug: 'ai',
      name: 'AI',
      locale: 'ja',
    });
    createLocalDraftTerm({
      workspaceRoot: root,
      taxonomy: 'tag',
      slug: 'ai',
      name: 'AI',
      locale: 'en',
    });

    const status = getWorkspaceStatus(root, cache);
    expect(status.summary.draftTerms).toBeDefined();
    expect(status.summary.draftTerms?.categories).toBe(1);
    expect(status.summary.draftTerms?.tags).toBe(2);
    expect(status.summary.draftTerms?.total).toBe(3);
    expect(status.summary.draftTerms?.items.length).toBe(3);
    cache.close();
  });

  it('Feature 2: promoteAllDraftTerms promotes parent-before-child and makes 0 HTTP calls when empty', async () => {
    const root = makeTempWorkspace();
    const emptyFetch = vi.fn() as unknown as typeof fetch;
    const emptyRes = await promoteAllDraftTerms({
      workspaceRoot: root,
      origin: 'https://example.test',
      token: 'tok',
      fetchFn: emptyFetch,
    });
    expect(emptyRes).toEqual([]);
    expect(emptyFetch).not.toHaveBeenCalled();

    const parent = createLocalDraftTerm({
      workspaceRoot: root,
      taxonomy: 'category',
      slug: 'parent-cat',
      name: 'Parent',
      locale: 'ja',
    });
    createLocalDraftTerm({
      workspaceRoot: root,
      taxonomy: 'category',
      slug: 'child-cat',
      name: 'Child',
      locale: 'ja',
      parent: parent.id,
    });

    const order: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      order.push(body.slug);
      const id =
        body.slug === 'parent-cat' ? '01ARZ3NDEKTSV4RRFFQ69G5FA0' : '01ARZ3NDEKTSV4RRFFQ69G5FA1';
      if (body.slug === 'child-cat') {
        expect(body.parentId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FA0');
      }
      return new Response(
        JSON.stringify({
          term: {
            id,
            slug: body.slug,
            label: body.label,
            parentId: body.parentId ?? null,
            locale: body.locale,
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const promoted = await promoteAllDraftTerms({
      workspaceRoot: root,
      origin: 'https://example.test',
      token: 'tok',
      fetchFn: fetchMock,
    });

    expect(order).toEqual(['parent-cat', 'child-cat']);
    expect(promoted).toHaveLength(2);
    expect(fs.existsSync(parent.fullPath)).toBe(false);
  });

  it('Feature 3: serializeMarkdown and baseline-reconstruction use byLocale # <Name> comments and detect legacy comment transition', () => {
    const root = makeTempWorkspace();
    const jaId = '01ARZ3NDEKTSV4RRFFQ69G5FB1';
    const enId = '01ARZ3NDEKTSV4RRFFQ69G5FB2';
    fs.writeFileSync(
      path.join(root, 'tags', 'ja', `${jaId}-ツール.yaml`),
      `id: "${jaId}"\nname: "ツール"\nslug: "tools"\ntaxonomy: "tag"\nparentId: null\ncount: 10\nlocale: "ja"\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'tags', 'en', `${enId}-ToolBox.yaml`),
      `id: "${enId}"\nname: "ToolBox"\nslug: "tools"\ntaxonomy: "tag"\nparentId: null\ncount: 1\nlocale: "en"\n`,
      'utf8',
    );

    const candidates = loadLocalTaxonomyCandidates(root);
    const jaFm = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FC1',
      collection: 'posts',
      locale: 'ja',
      title: 'JA',
      slug: 'ja-post',
      status: 'draft' as const,
      bylines: [],
      taxonomies: { tags: ['tools'] },
    };
    const enFm = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FC2',
      collection: 'posts',
      locale: 'en',
      title: 'EN',
      slug: 'en-post',
      status: 'draft' as const,
      bylines: [],
      taxonomies: { tags: ['tools'] },
    };

    const jaMd = serializeMarkdown(jaFm, 'Body', candidates);
    const enMd = serializeMarkdown(enFm, 'Body', candidates);
    expect(jaMd).toContain('- tools # ツール');
    expect(enMd).toContain('- tools # ToolBox');

    // Newly written path matches baseline reconstruction
    const cache = new CacheDatabase(path.join(root, '.emit', 'cache.db'));
    cache.saveBaseSnapshot({
      id: enFm.id,
      rev: 'r1',
      frontmatterYaml: JSON.stringify(enFm),
      bodyMarkdown: 'Body',
      hash: 'h1',
      savedAt: Date.now(),
    });
    cache.saveSyncState({
      id: enFm.id,
      localFilePath: 'posts/en/draft/en-post.md',
      slug: 'en-post',
      status: 'draft',
      remoteRev: '1@draft:d1',
      localHash: 'different-hash-to-force-reconstruct',
      lastSyncedAt: Date.now(),
    });
    expect(
      isLocalFileUnmodified({
        workspaceRoot: root,
        cache,
        id: enFm.id,
        relPath: 'posts/en/draft/en-post.md',
        localContent: enMd,
        candidates,
      }),
    ).toBe(true);

    // Upgrade transition: pre-existing disk file with legacy cross-locale comment (# ツール)
    const legacyEnDisk = enMd.replace('# ToolBox', '# ツール');
    expect(
      isLocalFileUnmodified({
        workspaceRoot: root,
        cache,
        id: enFm.id,
        relPath: 'posts/en/draft/en-post.md',
        localContent: legacyEnDisk,
        candidates,
      }),
    ).toBe(false);
    cache.close();
  });

  it('Feature 4 (Plan A & B): skips POST /terms when taxonomies unchanged while preserving remoteTaxonomyHash, and honors noTaxonomyAudit config precedence', async () => {
    // Pure Layer 0 resolver unit checks
    expect(resolveNoTaxonomyAuditOption({})).toBe(false);
    expect(resolveNoTaxonomyAuditOption({ configValue: true })).toBe(true);
    expect(resolveNoTaxonomyAuditOption({ cliFlag: false, configValue: true })).toBe(false);
    expect(resolveNoTaxonomyAuditOption({ cliFlag: true, configValue: false })).toBe(true);

    const root = makeTempWorkspace();
    fs.writeFileSync(
      path.join(root, '.emit', 'config.json'),
      JSON.stringify({
        origin: 'https://example.test',
        defaultCollection: 'posts',
        defaultLocale: 'ja',
        noTaxonomyAudit: true,
      }),
      'utf8',
    );
    expect(loadConfig(root).noTaxonomyAudit).toBe(true);

    const cache = new CacheDatabase(path.join(root, '.emit', 'cache.db'));
    const tagId = '01ARZ3NDEKTSV4RRFFQ69G5FD1';
    fs.writeFileSync(
      path.join(root, 'tags', 'ja', `${tagId}-News.yaml`),
      `id: "${tagId}"\nname: "News"\nslug: "news"\ntaxonomy: "tag"\nparentId: null\ncount: 1\nlocale: "ja"\n`,
      'utf8',
    );

    const postId = '01ARZ3NDEKTSV4RRFFQ69G5FE1';
    const postRel = `posts/ja/draft/${postId}-post.md`;
    const postAbs = path.join(root, postRel);
    const fm = {
      id: postId,
      collection: 'posts',
      locale: 'ja',
      title: 'Title v1',
      slug: 'post',
      status: 'draft' as const,
      bylines: [],
      taxonomies: { tags: ['news'] },
    };
    const origTaxHash = computeTaxonomyHash(undefined, ['news']);
    cache.saveBaseSnapshot({
      id: postId,
      rev: 'r1',
      frontmatterYaml: JSON.stringify(fm),
      bodyMarkdown: 'Body v1',
      hash: 'h1',
      savedAt: Date.now(),
    });
    cache.saveSyncState({
      id: postId,
      localFilePath: postRel,
      slug: 'post',
      status: 'draft',
      remoteRev: '1@draft:d1',
      localHash: 'oldhash',
      remoteTaxonomyHash: origTaxHash,
      lastSyncedAt: Date.now(),
    });
    fs.writeFileSync(
      postAbs,
      `---\nid: "${postId}"\ncollection: "posts"\nlocale: "ja"\ntitle: "Title v2"\nslug: "post"\nstatus: "draft"\ntaxonomies:\n  tags:\n    - news\n---\nBody v2\n`,
      'utf8',
    );

    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method || 'GET';
      calls.push(`${method} ${url}`);
      if (url.includes('/_emdash/api/bylines')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (url.includes('/terms/category')) {
        return new Response(JSON.stringify({ terms: [] }), { status: 200 });
      }
      if (url.includes('/terms/tag')) {
        return new Response(JSON.stringify({ terms: [{ id: tagId, slug: 'news' }] }), {
          status: 200,
        });
      }
      if (url.endsWith(`/_emdash/api/content/posts/${postId}`) && method === 'PUT') {
        return new Response(
          JSON.stringify({
            item: {
              id: postId,
              slug: 'post',
              status: 'draft',
              locale: 'ja',
              version: 2,
              _rev: 'r2',
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    // 1. Default (noTaxonomyAudit: false) with unchanged taxonomies: GET /terms runs (G16), POST /terms skipped (0 calls)
    await pushArticle(postAbs, {
      workspaceRoot: root,
      cache,
      origin: 'https://example.test',
      token: 'tok',
      noTaxonomyAudit: false,
      fetchFn: fetchMock,
    });
    expect(calls.some((c) => c.startsWith('GET ') && c.includes('/terms/'))).toBe(true);
    expect(calls.some((c) => c.startsWith('POST ') && c.includes('/terms/'))).toBe(false);
    // remoteTaxonomyHash must NOT be nulled
    expect(cache.getSyncState(postId)?.remoteTaxonomyHash).toBe(origTaxHash);

    // 2. With noTaxonomyAudit: true (Plan B) + unchanged taxonomies: BOTH GET /terms and POST /terms skipped!
    calls.length = 0;
    fs.writeFileSync(
      postAbs,
      `---\nid: "${postId}"\ncollection: "posts"\nlocale: "ja"\ntitle: "Title v3"\nslug: "post"\nstatus: "draft"\ntaxonomies:\n  tags:\n    - news\n---\nBody v3\n`,
      'utf8',
    );
    await pushArticle(postAbs, {
      workspaceRoot: root,
      cache,
      origin: 'https://example.test',
      token: 'tok',
      noTaxonomyAudit: true,
      fetchFn: fetchMock,
    });
    expect(calls.some((c) => c.includes('/terms/'))).toBe(false);
    expect(cache.getSyncState(postId)?.remoteTaxonomyHash).toBe(origTaxHash);
    cache.close();
  });
});
