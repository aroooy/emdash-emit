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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CacheDatabase } from '../src/db/cache.js';
import {
  calculateHash,
  CONFLICTS_SUBDIR,
  formatQuarantineNotice,
  isQuarantinedRelativePath,
  pullArticle,
  extractCanonicalRemoteTitle,
  resolveCanonicalArticlePath,
} from '../src/sync/pull.js';
import { pullBatch } from '../src/sync/orchestrator.js';
import { pushArticle, PushValidationError } from '../src/sync/push.js';
import { countQuarantinedCopies, getWorkspaceStatus } from '../src/sync/status.js';
import { parseMarkdown, serializeMarkdown } from '../src/utils/frontmatter.js';

/**
 * Data-safety regression suite for pull: divergent local content must never be silently
 * discarded, and preserved unpushed local edits must be reported as preserved rather than
 * "up-to-date".
 */
describe('Pull Data Safety: Quarantine of Divergent Local Copies', () => {
  let tempDir: string;
  let cache: CacheDatabase;
  const ulid = '01M67N0TNFS6F3PJX4T96NKPKT';
  const options = { origin: 'https://example.com', token: 'fake-token' };
  const brokenRelPath = `posts/published/20190405_${ulid}-Broken-Title.md`;

  const remoteItem = (overrides: Record<string, unknown> = {}) => ({
    id: ulid,
    slug: 'remote-title',
    collection: 'posts',
    status: 'published',
    locale: 'ja',
    publishedAt: '2019-04-05T00:00:00.000Z',
    _rev: 'rev_remote_202',
    data: { title: 'Remote Title', content: 'Canonical remote body.' },
    taxonomies: { categories: ['%e6%9c%aa%e5%88%86%e9%a1%9e'], tags: ['tech'] },
    ...overrides,
  });

  /** Remote taxonomy assignment responses, matching the live EmDash terms endpoint shape. */
  const termsResponse = (taxonomy: 'category' | 'tag') => {
    const terms =
      taxonomy === 'category'
        ? [{ id: '01M6CAT00000000000000000000001', slug: '%e6%9c%aa%e5%88%86%e9%a1%9e' }]
        : [{ id: '01M6TAG00000000000000000000001', slug: 'tech' }];
    return { ok: true, json: async () => ({ data: { terms } }) };
  };

  /** Broken frontmatter exactly as the pre-v0.1.9 serializer wrote it (unquoted %-slug). */
  const brokenFileContent = (body: string) =>
    [
      '---',
      `id: ${ulid}`,
      'slug: broken-title',
      'title: "Broken Title"',
      'collection: posts',
      'status: published',
      'locale: ja',
      'taxonomies:',
      '  categories:',
      '    - %e6%9c%aa%e5%88%86%e9%a1%9e',
      'bylines:',
      '  - aroooy',
      '---',
      '',
      body,
    ].join('\n');

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-quarantine-test-'));
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const writeBrokenFile = (body: string) => {
    const fullPath = path.join(tempDir, brokenRelPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, brokenFileContent(body), 'utf8');
    return fullPath;
  };

  it('preserves an uncached divergent local file under posts/conflicts/ before repairing it', async () => {
    const localValue = 'VALUABLE UNPUSHED LOCAL REWRITING that never reached the remote.';
    const brokenFullPath = writeBrokenFile(localValue);

    // Uncached: no sync_state and no base snapshot exist for this article.
    expect(cache.getSyncState(ulid)).toBeNull();

    const mockFetch = vi.fn().mockImplementation((urlStr: string) => {
      const url = new URL(urlStr);
      if (url.pathname.endsWith('/terms/category')) {
        return Promise.resolve(termsResponse('category'));
      }
      if (url.pathname.endsWith('/terms/tag')) {
        return Promise.resolve(termsResponse('tag'));
      }
      return Promise.resolve({ ok: true, json: async () => remoteItem() });
    }) as unknown as typeof fetch;

    const res = await pullArticle('posts', ulid, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch,
      bylineIdToSlug: {},
    });

    expect(res.updated).toBe(true);
    expect(res.filePath).toBe(`posts/published/20190405_${ulid}-Remote-Title.md`);
    expect(res.quarantined).toHaveLength(1);
    expect(res.quarantined?.[0].sourceFilePath).toBe(brokenRelPath);
    expect(res.quarantined?.[0].reason).toBe('no-cache-baseline');
    expect(res.quarantined?.[0].quarantineFilePath).toBe(
      `posts/${CONFLICTS_SUBDIR}/20190405_${ulid}-Broken-Title.conflict.md`,
    );

    // The divergent content is retrievable byte-for-byte from the rescue copy.
    const quarantineFull = path.join(tempDir, res.quarantined![0].quarantineFilePath);
    expect(fs.existsSync(quarantineFull)).toBe(true);
    expect(fs.readFileSync(quarantineFull, 'utf8')).toBe(brokenFileContent(localValue));

    // The canonical file was repaired into valid, parseable frontmatter.
    const repaired = fs.readFileSync(path.join(tempDir, res.filePath), 'utf8');
    expect(() => parseMarkdown(repaired)).not.toThrow();
    expect(repaired).toContain('"%e6%9c%aa%e5%88%86%e9%a1%9e"');
    expect(repaired).toContain('Canonical remote body.');

    // The stale broken path is gone; the rescue copy is not counted as an article.
    expect(fs.existsSync(brokenFullPath)).toBe(false);
    expect(countQuarantinedCopies(tempDir)).toBe(1);

    const status = getWorkspaceStatus(tempDir, cache);
    expect(status.summary.conflicts).toBe(1);
    expect(status.items.some((i) => i.filePath.includes(CONFLICTS_SUBDIR))).toBe(false);

    const notice = formatQuarantineNotice(res.quarantined);
    expect(notice).toContain('divergent local copy(ies) preserved');
    expect(notice).toContain(brokenRelPath);
    expect(notice).toContain('never pushed or pruned');
  });

  it('repairs a cached broken file (baseline hash matches) without creating a rescue copy', async () => {
    const brokenContent = brokenFileContent('Original remote body.');
    writeBrokenFile('Original remote body.');

    // Cached exactly as the broken serializer wrote it: the differential-skip trap.
    cache.saveSyncState({
      id: ulid,
      localFilePath: brokenRelPath,
      localHash: calculateHash(brokenContent),
      remoteRev: 'rev_remote_202',
      status: 'published',
      slug: 'broken-title',
      lastSyncedAt: 1700000000,
    });

    // Self-heal must not require re-fetching the article itself: taxonomy lookups are the only
    // permitted network calls (and are tolerated even when they fail).
    const neverFetch = vi.fn().mockImplementation(() => Promise.reject(new Error('no fetch')));

    const res = await pullArticle('posts', ulid, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      fetchFn: neverFetch as unknown as typeof fetch,
      rawItem: remoteItem(),
      bylineIdToSlug: {},
    });

    expect(res.updated).toBe(true);
    expect(res.filePath).toBe(`posts/published/20190405_${ulid}-Remote-Title.md`);
    expect(res.quarantined).toBeUndefined();
    expect(countQuarantinedCopies(tempDir)).toBe(0);
    const articleFetches = neverFetch.mock.calls.filter(
      (call: unknown[]) => !String(call[0]).includes('/terms/'),
    );
    expect(articleFetches).toHaveLength(0);
    const repaired = fs.readFileSync(path.join(tempDir, res.filePath), 'utf8');
    expect(() => parseMarkdown(repaired)).not.toThrow();
    expect(repaired).toContain('"%e6%9c%aa%e5%88%86%e9%a1%9e"');
  });

  it('preserves a cached-but-divergent local copy when the canonical path changes', async () => {
    const baselineContent = serializeMarkdown(
      {
        id: ulid,
        slug: 'old-title',
        title: 'Old Title',
        collection: 'posts',
        status: 'published',
        publishedAt: '2019-04-05T00:00:00.000Z',
        locale: 'ja',
        taxonomies: {},
        bylines: [],
      },
      'Original remote body.',
    );
    const staleRelPath = `posts/published/20190405_${ulid}-Old-Title.md`;
    const staleFull = path.join(tempDir, staleRelPath);
    fs.mkdirSync(path.dirname(staleFull), { recursive: true });
    fs.writeFileSync(staleFull, baselineContent, 'utf8');

    cache.saveSyncState({
      id: ulid,
      localFilePath: staleRelPath,
      localHash: calculateHash(baselineContent),
      remoteRev: 'rev_remote_202',
      status: 'published',
      slug: 'old-title',
      lastSyncedAt: 1700000000,
    });

    // Local edits exist AND the remote renamed the article: both copies would disappear.
    const edited = `${baselineContent}\n\nHand-written local paragraph.`;
    fs.writeFileSync(staleFull, edited, 'utf8');

    const res = await pullArticle('posts', ulid, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      rawItem: remoteItem({ publishedAt: '2019-04-06T00:00:00.000Z' }),
      bylineIdToSlug: {},
    });

    expect(res.updated).toBe(true);
    expect(res.filePath).toBe(`posts/published/20190406_${ulid}-Remote-Title.md`);
    expect(res.quarantined?.[0].reason).toBe('diverged-from-baseline');
    expect(
      fs.readFileSync(path.join(tempDir, res.quarantined![0].quarantineFilePath), 'utf8'),
    ).toBe(edited);
    expect(fs.existsSync(staleFull)).toBe(false);

    // A rescue copy now holds unpushed writing: body_conflict_pending must stay 1 and point at it.
    const syncState = cache.getSyncState(ulid);
    expect(syncState?.bodyConflictPending).toBe(1);
    expect(syncState?.conflictPending).toBe(1);
    expect(syncState?.conflictCopyPath).toBe(
      res.quarantined![res.quarantined!.length - 1].quarantineFilePath,
    );
    expect(fs.existsSync(path.join(tempDir, syncState?.conflictCopyPath ?? ''))).toBe(true);
    // Every quarantined copy in this pull must remain reachable from disk while pending is set.
    for (const q of res.quarantined!) {
      expect(fs.existsSync(path.join(tempDir, q.quarantineFilePath))).toBe(true);
    }
  });

  it('quarantines an uncached divergent local copy during batch pull and counts it in the summary', async () => {
    const brokenFullPath = writeBrokenFile('VALUABLE LOCAL REWRITE that never reached the remote.');

    const mockFetch = vi.fn().mockImplementation((urlStr: string) => {
      const url = new URL(urlStr);
      if (url.pathname === '/_emdash/api/openapi.json') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            paths: {
              '/_emdash/api/content/{collection}': {
                get: { parameters: [{ name: 'limit', schema: { maximum: 100 } }] },
              },
            },
          }),
        });
      }
      if (url.pathname === '/_emdash/api/content/posts') {
        const items = url.searchParams.get('status') === 'published' ? [remoteItem()] : [];
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, data: { items, nextCursor: null } }),
        });
      }
      if (url.pathname.endsWith('/terms/category')) {
        return Promise.resolve(termsResponse('category'));
      }
      if (url.pathname.endsWith('/terms/tag')) {
        return Promise.resolve(termsResponse('tag'));
      }
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: {} }) });
    }) as unknown as typeof fetch;

    const batch = await pullBatch({
      collection: 'posts',
      workspaceRoot: tempDir,
      cache,
      origin: options.origin,
      token: options.token,
      limit: 10,
      fetchFn: mockFetch,
    });

    expect(batch.total).toBe(1);
    expect(batch.updated).toBe(1);
    expect(batch.quarantined).toBe(1);

    // The canonical file was repaired and the stale broken copy is gone.
    const repaired = fs.readFileSync(
      path.join(tempDir, `posts/published/20190405_${ulid}-Remote-Title.md`),
      'utf8',
    );
    expect(() => parseMarkdown(repaired)).not.toThrow();
    expect(repaired).toContain('"%e6%9c%aa%e5%88%86%e9%a1%9e"');
    expect(fs.existsSync(brokenFullPath)).toBe(false);

    const status = getWorkspaceStatus(tempDir, cache);
    expect(status.summary.invalid).toBe(0);
    expect(status.summary.conflicts).toBe(1);
  });

  it('classifies only <collection>/conflicts/ paths as rescue copies', () => {
    expect(
      isQuarantinedRelativePath(`posts/${CONFLICTS_SUBDIR}/20190405_${ulid}-X.conflict.md`),
    ).toBe(true);
    expect(isQuarantinedRelativePath('notes/conflicts/20190405_x.conflict.md')).toBe(true);
    expect(isQuarantinedRelativePath(`posts/published/20190405_${ulid}-X.md`)).toBe(false);
    // A slug that merely contains the word "conflicts" must not be mistaken for a rescue copy.
    expect(isQuarantinedRelativePath(`posts/draft/20190405_${ulid}-conflicts.md`)).toBe(false);
    expect(isQuarantinedRelativePath(`${CONFLICTS_SUBDIR}/orphan.md`)).toBe(false);
  });

  it('refuses to push a rescue copy so stale divergent content cannot overwrite the canonical article', async () => {
    const brokenFullPath = writeBrokenFile('STALE DIVERGENT RESCUE CONTENT that must never win.');

    const mockFetch = vi.fn().mockImplementation((urlStr: string) => {
      const url = new URL(urlStr);
      if (url.pathname.endsWith('/terms/category')) {
        return Promise.resolve(termsResponse('category'));
      }
      if (url.pathname.endsWith('/terms/tag')) {
        return Promise.resolve(termsResponse('tag'));
      }
      return Promise.resolve({ ok: true, json: async () => remoteItem() });
    }) as unknown as typeof fetch;

    const res = await pullArticle('posts', ulid, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch,
      bylineIdToSlug: {},
    });

    const conflictRel = res.quarantined![0].quarantineFilePath;
    const rescueContent = fs.readFileSync(path.join(tempDir, conflictRel), 'utf8');
    const canonicalBefore = fs.readFileSync(path.join(tempDir, res.filePath), 'utf8');

    // The guard must reject the push before a single network request is attempted.
    const neverFetch = vi.fn() as unknown as typeof fetch;
    let captured: PushValidationError | undefined;
    try {
      await pushArticle(conflictRel, {
        ...options,
        workspaceRoot: tempDir,
        cache,
        fetchFn: neverFetch,
      });
    } catch (err: unknown) {
      captured = err as PushValidationError;
    }

    expect(captured).toBeInstanceOf(PushValidationError);
    expect(captured?.errors[0].code).toBe('QUARANTINED_COPY_NOT_PUSHABLE');
    expect(captured?.errors[0].suggestion).toContain('canonical');
    expect(neverFetch).not.toHaveBeenCalled();

    // Both files survive untouched: the rescue copy keeps its content and the canonical article
    // keeps its repaired remote state. The stale original path stays gone.
    expect(fs.readFileSync(path.join(tempDir, conflictRel), 'utf8')).toBe(rescueContent);
    expect(fs.readFileSync(path.join(tempDir, res.filePath), 'utf8')).toBe(canonicalBefore);
    expect(fs.existsSync(brokenFullPath)).toBe(false);
    expect(countQuarantinedCopies(tempDir)).toBe(1);
  });

  it('T3-2: pull <id> --force quarantines unpushed local edits to .local-dropped.md on remote 404', async () => {
    const articleId = '01M6TESTT32FORCE0000000001';
    const relPath = `posts/draft/20261109_${articleId}-t32.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const localContent = `---
id: ${articleId}
slug: t32-test
title: T32 Test
collection: posts
status: draft
publishedAt: null
locale: ja
taxonomies: {}
---

Unpushed edits to be preserved
`;
    fs.writeFileSync(fullPath, localContent, 'utf8');

    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: 'baseline_hash',
      remoteRev: '1',
      status: 'draft',
      slug: 't32-test',
      lastSyncedAt: 1700000000,
    });
    cache.saveBaseSnapshot({
      id: articleId,
      rev: '1',
      frontmatterYaml: JSON.stringify({
        id: articleId,
        slug: 't32-test',
        title: 'T32 Test',
        collection: 'posts',
        status: 'draft',
        taxonomies: {},
      }),
      bodyMarkdown: 'Baseline body\n',
      hash: 'baseline_hash',
      savedAt: 1700000000,
    });

    const mockFetch404 = vi.fn().mockImplementation(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => 'Not Found',
    }));

    // 1. Without force: local edits preserved, returns orphan
    const resNoForce = await pullArticle('posts', articleId, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      fetchFn: mockFetch404 as unknown as typeof fetch,
    });
    expect(resNoForce.orphan).toBe(true);
    expect(resNoForce.localEditsPreserved).toBe(true);
    expect(fs.existsSync(fullPath)).toBe(true);
    expect(cache.getSyncState(articleId)).not.toBeNull();

    // 2. With force: true: moves to .local-dropped.md, unlinks canonical, deletes cache entry
    const resForce = await pullArticle('posts', articleId, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'fake-token',
      force: true,
      fetchFn: mockFetch404 as unknown as typeof fetch,
    });

    expect(resForce.deleted).toBe(true);
    expect(resForce.quarantined).toBeDefined();
    expect(resForce.quarantineFilePath).toBeDefined();
    expect(resForce.quarantineFilePath).toContain('.local-dropped.md');

    // Canonical file removed
    expect(fs.existsSync(fullPath)).toBe(false);
    // Cache entry removed
    expect(cache.getSyncState(articleId)).toBeNull();

    // Quarantined file exists with localContent
    const quarantinedFull = path.join(tempDir, resForce.quarantineFilePath!);
    expect(fs.existsSync(quarantinedFull)).toBe(true);
    expect(fs.readFileSync(quarantinedFull, 'utf8')).toBe(localContent);
  });

  it('pull records body_conflict_pending = 1 and keeps conflict copy metadata when divergent local copy is quarantined (P4/R4)', async () => {
    const baselineContent = serializeMarkdown(
      {
        id: ulid,
        slug: 'broken-title',
        title: 'Broken Title',
        collection: 'posts',
        status: 'published',
        publishedAt: '2019-04-05T00:00:00.000Z',
        locale: 'ja',
        taxonomies: {},
        bylines: [],
      },
      'Original remote body.',
    );
    const staleRelPath = `posts/published/20190405_${ulid}-Broken-Title.md`;
    const staleFull = path.join(tempDir, staleRelPath);
    fs.mkdirSync(path.dirname(staleFull), { recursive: true });
    fs.writeFileSync(staleFull, baselineContent, 'utf8');

    cache.saveSyncState({
      id: ulid,
      localFilePath: staleRelPath,
      localHash: calculateHash(baselineContent),
      remoteRev: 'rev_remote_202',
      status: 'published',
      slug: 'broken-title',
      lastSyncedAt: 1700000000,
    });

    // Write unpushed local edits that diverge from cache baseline
    fs.writeFileSync(
      staleFull,
      `${baselineContent}\n\nDIVERGENT CONTENT THAT CAUSES QUARANTINE`,
      'utf8',
    );

    const mockFetch = vi.fn().mockImplementation((urlStr: string) => {
      const url = new URL(urlStr);
      if (url.pathname.endsWith('/terms/category')) {
        return Promise.resolve(termsResponse('category'));
      }
      if (url.pathname.endsWith('/terms/tag')) {
        return Promise.resolve(termsResponse('tag'));
      }
      return Promise.resolve({ ok: true, json: async () => remoteItem() });
    }) as unknown as typeof fetch;

    const res = await pullArticle('posts', ulid, {
      ...options,
      workspaceRoot: tempDir,
      cache,
      fetchFn: mockFetch,
      bylineIdToSlug: {},
    });

    expect(res.quarantined).toBeDefined();
    expect(res.quarantined!.length).toBeGreaterThan(0);

    // Verify cache has body_conflict_pending = 1 and conflictCopyPath matching the quarantined copy
    const syncState = cache.getSyncState(ulid);
    expect(syncState).not.toBeNull();
    expect(syncState?.bodyConflictPending).toBe(1);
    expect(syncState?.conflictPending).toBe(1);
    expect(syncState?.conflictCopyPath).toBe(res.quarantined![0].quarantineFilePath);
  });

  it('guarantees deterministic title precedence symmetry between fast-path and full-pull (v0.1.14 backlog §1)', () => {
    // 1. Data payload with nested data.title
    const itemWithDataTitle = {
      id: '01M6TESTTITLEPRECEDENCE01',
      slug: 'sample-slug',
      title: 'Top-Level Title',
      data: { title: 'Nested Data Title' },
    };
    expect(extractCanonicalRemoteTitle(itemWithDataTitle)).toBe('Nested Data Title');

    // 2. Data payload with top-level title only
    const itemWithTopTitle = {
      id: '01M6TESTTITLEPRECEDENCE02',
      slug: 'sample-slug',
      title: 'Top-Level Title',
      data: {},
    };
    expect(extractCanonicalRemoteTitle(itemWithTopTitle)).toBe('Top-Level Title');

    // 3. Data payload with no title but slug
    const itemWithSlugOnly = {
      id: '01M6TESTTITLEPRECEDENCE03',
      slug: 'sample-slug',
      data: {},
    };
    expect(extractCanonicalRemoteTitle(itemWithSlugOnly)).toBe('sample-slug');

    // 4. Data payload with nothing
    const itemEmpty = {
      id: '01M6TESTTITLEPRECEDENCE04',
      data: {},
    };
    expect(extractCanonicalRemoteTitle(itemEmpty)).toBe('Untitled');

    // 5. Symmetric canonical path resolution across dates
    const path1 = resolveCanonicalArticlePath(
      'posts',
      'draft',
      '01M6TESTTITLEPRECEDENCE01',
      extractCanonicalRemoteTitle(itemWithDataTitle),
      { publishedAt: null, createdAt: '2026-11-01T00:00:00.000Z' },
    );
    expect(path1).toBe('posts/draft/20261101_01M6TESTTITLEPRECEDENCE01-Nested-Data-Title.md');
  });
});
