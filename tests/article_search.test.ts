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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchLocalArticles, searchRemoteArticles } from '../src/sync/article_search/index.js';
import { CacheDatabase } from '../src/db/cache.js';
import { createMcpServer } from '../src/mcp/server.js';
import {
  buildSnapshotSearchFraming,
  formatArticleSearchEmptyNotice,
  formatArticleSearchHeader,
  formatArticleSearchHit,
} from '../src/presentation/article_report.js';
import { initWorkspace } from '../src/utils/config.js';
import { parseMarkdownLenient } from '../src/utils/frontmatter.js';
import { clampSearchLimit } from '../src/utils/search-options.js';

function writeArticleFile(
  workspaceRoot: string,
  relPath: string,
  frontmatterLines: string[],
  body: string,
): void {
  const fullPath = path.join(workspaceRoot, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const content = ['---', ...frontmatterLines, '---', '', body].join('\n');
  fs.writeFileSync(fullPath, content, 'utf8');
}

describe('Article Search & Snapshot-First Engine (v0.1.55)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-article-search-'));
    initWorkspace(tempDir, { origin: 'https://emdash.test' });
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('T1: default search runs 0-HTTP across local workspace + snapshot with tag, category, status, slug, and date filters', async () => {
    writeArticleFile(
      tempDir,
      'posts/published/20261110_01M7ART0000000000000000001-local-pub.md',
      [
        'id: 01M7ART0000000000000000001',
        'slug: local-pub',
        'title: Local Published Tech',
        'collection: posts',
        'status: published',
        'publishedAt: "2026-11-10T00:00:00.000Z"',
        'locale: ja',
        'taxonomies:',
        '  categories:',
        '    - tech',
        '  tags:',
        '    - typescript',
      ],
      'Body mentioning TypeScript patterns.',
    );

    const now = Date.now();
    cache.saveSnapshotMeta({
      collection: 'posts',
      capturedAt: now,
      articleCount: 2,
      mediaCount: 0,
      taxonomyFetchedCount: 0,
      taxonomyReusedCount: 0,
      articleSingleGetCount: 0,
      durationMs: 5,
    });
    cache.upsertSnapshotArticlesBatch({
      collection: 'posts',
      walkComplete: true,
      records: [
        {
          id: '01M7ART0000000000000000001',
          collection: 'posts',
          slug: 'local-pub',
          title: 'Stale Snapshot Title',
          status: 'published',
          publishedAt: '2026-11-10T00:00:00.000Z',
          comparisonRev: '1@live:01L1',
          bodyMarkdown: 'Snapshot body',
          bodySource: 'list-live',
          categoriesJson: JSON.stringify(['tech']),
          tagsJson: JSON.stringify(['typescript']),
          taxonomyVerified: 1,
          locale: 'ja',
          capturedAt: now,
        },
        {
          id: '01M7ART0000000000000000002',
          collection: 'posts',
          slug: 'snap-only-draft',
          title: 'Snapshot Only Draft',
          status: 'draft',
          createdAt: '2026-11-12T00:00:00.000Z',
          comparisonRev: '1@draft:01D2',
          bodyMarkdown: 'Hidden gem in snapshot body.',
          bodySource: 'single-get',
          categoriesJson: JSON.stringify(['diary']),
          tagsJson: JSON.stringify(['ai']),
          taxonomyVerified: 1,
          locale: 'ja',
          capturedAt: now,
        },
      ],
    });

    const throwingFetch = vi.fn(() => {
      throw new Error('Default search must not issue HTTP requests');
    });

    // 1. Disk precedes snapshot on duplicate ID
    const resTech = await searchRemoteArticles({
      query: 'TypeScript',
      tag: 'typescript',
      category: 'tech',
      status: 'published',
      since: '2026-11-01',
      until: '2026-11-15',
      workspaceRoot: tempDir,
      origin: 'https://emdash.test',
      cache,
      fetchFn: throwingFetch as unknown as typeof fetch,
    });
    expect(throwingFetch).not.toHaveBeenCalled();
    expect(resTech.searchMode).toBe('local');
    expect(resTech.walkComplete).toBe(true);
    expect(resTech.hits).toHaveLength(1);
    expect(resTech.hits[0].title).toBe('Local Published Tech');
    expect(resTech.hits[0].isLocal).toBe(true);
    expect(resTech.hits[0].fromSnapshot).toBeUndefined();

    // 2. Snapshot-only draft hit
    const resSnap = await searchRemoteArticles({
      query: 'Hidden gem',
      status: 'draft',
      workspaceRoot: tempDir,
      origin: 'https://emdash.test',
      cache,
      fetchFn: throwingFetch as unknown as typeof fetch,
    });
    expect(resSnap.hits).toHaveLength(1);
    expect(resSnap.hits[0].id).toBe('01M7ART0000000000000000002');
    expect(resSnap.hits[0].fromSnapshot).toBe(true);
    expect(formatArticleSearchHit(resSnap.hits[0], 0)).toContain('[snapshot]');
  });

  it('T2: excludes list-stale snapshot body from keyword match while keeping title/slug match', () => {
    const now = Date.now();
    cache.saveSnapshotMeta({
      collection: 'posts',
      capturedAt: now,
      articleCount: 1,
      mediaCount: 0,
      taxonomyFetchedCount: 0,
      taxonomyReusedCount: 0,
      articleSingleGetCount: 0,
      durationMs: 5,
    });
    cache.upsertSnapshotArticlesBatch({
      collection: 'posts',
      walkComplete: true,
      records: [
        {
          id: '01M7STALEBODY0000000000001',
          collection: 'posts',
          slug: 'stale-body-slug',
          title: 'Stale Body Article',
          status: 'draft',
          comparisonRev: '1@draft:01D1',
          bodyMarkdown: 'secret-stale-creation-text',
          bodySource: 'list-stale',
          categoriesJson: '[]',
          tagsJson: '[]',
          taxonomyVerified: 1,
          locale: 'ja',
          capturedAt: now,
        },
      ],
    });

    const bodySearch = searchLocalArticles({
      query: 'secret-stale-creation-text',
      workspaceRoot: tempDir,
      origin: 'https://emdash.test',
      cache,
    });
    expect(bodySearch.hits).toHaveLength(0);

    const titleSearch = searchLocalArticles({
      query: 'Stale Body',
      workspaceRoot: tempDir,
      origin: 'https://emdash.test',
      cache,
    });
    expect(titleSearch.hits).toHaveLength(1);
    expect(titleSearch.hits[0].bodyUnverified).toBe(true);
    expect(formatArticleSearchHit(titleSearch.hits[0], 0)).toContain('[body unverified]');
  });

  it('T3: excludes posts/conflicts/ by default and includes/flags them with includeConflicts', () => {
    writeArticleFile(
      tempDir,
      'posts/conflicts/20261110_01M7CONF000000000000000001-rescue.conflict.md',
      [
        'id: 01M7CONF000000000000000001',
        'slug: rescue-post',
        'title: Rescue Copy',
        'collection: posts',
        'status: draft',
      ],
      'Unique rescue keyword.',
    );

    const excluded = searchLocalArticles({
      query: 'Unique rescue',
      workspaceRoot: tempDir,
      origin: 'https://emdash.test',
      cache,
    });
    expect(excluded.hits).toHaveLength(0);

    const included = searchLocalArticles({
      query: 'Unique rescue',
      includeConflicts: true,
      workspaceRoot: tempDir,
      origin: 'https://emdash.test',
      cache,
    });
    expect(included.hits).toHaveLength(1);
    expect(included.hits[0].quarantined).toBe(true);
    expect(formatArticleSearchHit(included.hits[0], 0)).toContain('[quarantined — never push]');
  });

  it('T4: live:true queries FTS endpoint, preserves snapshot enrichment & nextCursor truncation, and rejects unsupported filters', async () => {
    const now = Date.now();
    cache.saveSnapshotMeta({
      collection: 'posts',
      capturedAt: now,
      articleCount: 2,
      mediaCount: 0,
      taxonomyFetchedCount: 0,
      taxonomyReusedCount: 0,
      articleSingleGetCount: 0,
      durationMs: 5,
    });
    cache.upsertSnapshotArticlesBatch({
      collection: 'posts',
      walkComplete: true,
      records: [
        {
          id: '01M7FTS0000000000000000001',
          collection: 'posts',
          slug: 'fts-verified',
          title: 'FTS Verified',
          status: 'published',
          publishedAt: '2026-11-15T00:00:00.000Z',
          comparisonRev: '3@live:01L3',
          bodyMarkdown: 'Body 1',
          bodySource: 'list-live',
          categoriesJson: '[]',
          tagsJson: '[]',
          taxonomyVerified: 1,
          locale: 'ja',
          capturedAt: now,
        },
        {
          id: '01M7FTS0000000000000000002',
          collection: 'posts',
          slug: 'fts-stale-rev',
          title: 'FTS Stale Rev',
          status: 'draft',
          comparisonRev: '1@draft:01D1',
          bodyMarkdown: 'Body 2',
          bodySource: 'single-get',
          categoriesJson: '[]',
          tagsJson: '[]',
          taxonomyVerified: 1,
          locale: 'ja',
          capturedAt: now,
        },
      ],
    });

    // Rejects unsupported filters in live mode without making HTTP calls
    const neverFetch = vi.fn(() => {
      throw new Error('Should not fetch when filter is unsupported');
    });
    await expect(
      searchRemoteArticles({
        query: 'typescript',
        tag: 'tech',
        live: true,
        workspaceRoot: tempDir,
        origin: 'https://emdash.test',
        token: 'tok',
        cache,
        fetchFn: neverFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_SEARCH_UNSUPPORTED_FILTER', status: 400 });

    await expect(
      searchRemoteArticles({
        live: true,
        workspaceRoot: tempDir,
        origin: 'https://emdash.test',
        token: 'tok',
        cache,
        fetchFn: neverFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_SEARCH_UNSUPPORTED_FILTER', status: 400 });
    expect(neverFetch).not.toHaveBeenCalled();

    // Valid live FTS call with snapshot enrichment + nextCursor truncation
    const ftsFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [
            {
              id: '01M7FTS0000000000000000001',
              slug: 'fts-verified',
              title: 'FTS Verified',
              _rev: '3',
              version: 3,
              liveRevisionId: '01L3',
            },
            {
              id: '01M7FTS0000000000000000002',
              slug: 'fts-stale-rev',
              title: 'FTS Stale Rev',
              _rev: '2',
              version: 2,
              draftRevisionId: '01D2',
            },
          ],
          nextCursor: 'more-fts',
        },
      }),
    });

    const ftsRes = await searchRemoteArticles({
      query: 'FTS',
      live: true,
      limit: 2,
      workspaceRoot: tempDir,
      origin: 'https://emdash.test',
      token: 'tok',
      cache,
      fetchFn: ftsFetch as unknown as typeof fetch,
    });

    expect(ftsRes.searchMode).toBe('fts');
    expect(ftsRes.walkComplete).toBe(false);
    expect(ftsRes.truncated).toBe(true);
    expect(ftsRes.snapshotEnrichedCount).toBe(2);
    expect(ftsRes.hits[0].enrichedFromSnapshot).toBe(true);
    expect(ftsRes.hits[0].enrichmentStale).toBeUndefined();
    expect(ftsRes.hits[1].enrichedFromSnapshot).toBe(true);
    expect(ftsRes.hits[1].enrichmentStale).toBe(true);
    expect(formatArticleSearchHeader(ftsRes, { live: true, query: 'FTS' })).toContain(
      'Article search (live FTS)',
    );

    // HTTP 500 throws ARTICLE_SEARCH_FAILED (no scan fallback)
    const errFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(
      searchRemoteArticles({
        query: 'FTS',
        live: true,
        workspaceRoot: tempDir,
        origin: 'https://emdash.test',
        token: 'tok',
        cache,
        fetchFn: errFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'ARTICLE_SEARCH_FAILED', status: 500 });
  });

  it('T5: buildSnapshotSearchFraming handles missing/stale/fresh/live short query and truncatedHint', () => {
    const missing = buildSnapshotSearchFraming({
      hitCount: 0,
      kind: 'article',
      isMcp: true,
    });
    expect(missing.snapshotStatus).toBe('missing');
    expect(missing.absenceGuaranteed).toBe(false);
    expect(missing.recommendedAction).toContain('sync_snapshot');

    const stale = buildSnapshotSearchFraming({
      snapshot: { capturedAt: new Date().toISOString(), ageDays: 10, stale: true },
      hitCount: 0,
      kind: 'article',
      isMcp: false,
    });
    expect(stale.snapshotStatus).toBe('stale');
    expect(stale.absenceGuaranteed).toBe(false);
    expect(stale.userNotice).toContain('10-day-old snapshot');

    const freshTrunc = buildSnapshotSearchFraming({
      snapshot: { capturedAt: new Date().toISOString(), ageDays: 1, stale: false },
      hitCount: 20,
      totalCount: 55,
      truncated: true,
      kind: 'article',
      isMcp: false,
    });
    expect(freshTrunc.snapshotStatus).toBe('fresh');
    expect(freshTrunc.absenceGuaranteed).toBe(true);
    expect(freshTrunc.truncatedHint).toContain('Showing top 20 of 55');

    const shortLive = buildSnapshotSearchFraming({
      hitCount: 0,
      walkComplete: true,
      isLive: true,
      query: '猫',
      kind: 'article',
      isMcp: true,
    });
    expect(shortLive.absenceGuaranteed).toBe(false);
    expect(shortLive.userNotice).toContain('trigram');
  });

  it('T6: DATE_BOUNDARY_INVALID, parseMarkdownLenient, clampSearchLimit, and empty notices', () => {
    expect(() =>
      searchLocalArticles({
        since: 'not-a-date',
        workspaceRoot: tempDir,
        origin: 'https://emdash.test',
        cache,
      }),
    ).toThrowError(/Invalid date boundary/);

    expect(clampSearchLimit(undefined)).toBe(20);
    expect(clampSearchLimit(0)).toBe(1);
    expect(clampSearchLimit(999)).toBe(50);

    const brokenMd = [
      '---',
      'id: 01M7LENIENT000000000000001',
      'slug: %e6%97%a5%e6%9c%ac%e8%aa%9e',
      'title: Lenient Test',
      'collection: posts',
      'status: draft',
      'taxonomies:',
      '  categories:',
      '    - %e6%9c%aa%e5%88%86%e9%a1%9e',
      '---',
      '',
      'Body text.',
    ].join('\n');
    const parsed = parseMarkdownLenient(brokenMd);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.title).toBe('Lenient Test');

    expect(
      formatArticleSearchEmptyNotice({
        hits: [],
        searchMode: 'fts',
        scannedCount: 0,
        totalCount: null,
        walkComplete: true,
        truncated: false,
        normalizedQuery: 'x',
        taxonomyFetchCount: 0,
        taxonomyCacheHitCount: 0,
      }),
    ).toContain('live FTS index');
  });

  it('T7: MCP sync_article_search returns snapshotStatus framing for missing/fresh snapshots', async () => {
    const server = createMcpServer({ workspaceRoot: tempDir, cache });
    const registered = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (args: Record<string, unknown>) => Promise<{
              isError?: boolean;
              content: Array<{ text: string }>;
            }>;
          }
        >;
      }
    )._registeredTools;

    const missingRes = await registered['sync_article_search'].handler({ query: 'anything' });
    const missingPayload = JSON.parse(missingRes.content[0].text);
    expect(missingPayload.snapshotStatus).toBe('missing');
    expect(missingPayload.absenceGuaranteed).toBe(false);
    expect(missingPayload.userNotice).toContain('not been captured yet');
  });
});
