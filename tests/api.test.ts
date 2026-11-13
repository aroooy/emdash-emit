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

import { describe, it, expect } from 'vitest';
import { unwrapEnvelope, unwrapItem, extractRev, normalizeRev } from '../src/client/api.js';
import {
  articleContentEndpoint,
  articleLockEndpoint,
  articleStatusTransitionEndpoint,
  articleTermsEndpoint,
  authTokenEndpoint,
  mcpEndpoint,
  mediaConfirmEndpoint,
  mediaDetailEndpoint,
  mediaFileEndpoint,
  mediaListEndpoint,
  mediaUploadUrlEndpoint,
  openApiEndpoint,
  taxonomiesTermsEndpoint,
} from '../src/client/endpoints.js';

describe('api unwrap utils', () => {
  it('unwraps data envelope when wrapped in { data: ... }', () => {
    const raw = { success: true, data: { id: '123', title: 'Hello' } };
    expect(unwrapEnvelope(raw)).toEqual({ id: '123', title: 'Hello' });
  });

  it('unwraps data envelope when raw is already unwrapped', () => {
    const raw = { id: '123', title: 'Hello' };
    expect(unwrapEnvelope(raw)).toEqual({ id: '123', title: 'Hello' });
  });

  it('unwraps nested item in { data: { item: ... } }', () => {
    const raw = { data: { item: { id: 'abc', title: 'Nested' } } };
    expect(unwrapItem(raw)).toEqual({ id: 'abc', title: 'Nested' });
  });

  it('unwraps nested item in { item: ... }', () => {
    const raw = { item: { id: 'abc', title: 'Direct Item' } };
    expect(unwrapItem(raw)).toEqual({ id: 'abc', title: 'Direct Item' });
  });

  it('extracts rev prioritizing data._rev over item._rev or version', () => {
    const responseWithBoth = {
      data: {
        _rev: 'rev-data-top',
        item: { _rev: 'rev-item-sub', version: 'v1' },
      },
    };
    expect(extractRev(responseWithBoth)).toBe('rev-item-sub'); // item._rev is checked on the item itself first

    const responseWithDataOnly = {
      data: {
        _rev: 'rev-data-top',
        item: { id: '123' },
      },
    };
    expect(extractRev(responseWithDataOnly)).toBe('rev-data-top');

    const responseWithFallback = {
      data: {
        item: { id: '123', version: '42' },
      },
    };
    expect(extractRev(responseWithFallback)).toBe('42');
  });

  it('normalizes rev tokens (pure number, base64 encoded, colon delimited)', () => {
    expect(normalizeRev('1')).toBe('1');
    expect(normalizeRev(5)).toBe('5');
    expect(normalizeRev('1:2026-10-31T00:16:28.950Z')).toBe('1');
    // "1:2026-10-31T00:16:28.950Z" in Base64 is "MToyMDI2LTEwLTMxVDAwOjE2OjI4Ljk1MFo="
    expect(normalizeRev('MToyMDI2LTEwLTMxVDAwOjE2OjI4Ljk1MFo=')).toBe('1');
    // "5:2026-11-09T08:00:00.000Z" in Base64
    const b64Rev5 = Buffer.from('5:2026-11-09T08:00:00.000Z').toString('base64');
    expect(normalizeRev(b64Rev5)).toBe('5');
    // Opaque fallback
    expect(normalizeRev('custom-opaque-rev')).toBe('custom-opaque-rev');
    expect(normalizeRev(null)).toBe('1');
    expect(normalizeRev('')).toBe('1');
  });
});

/**
 * Endpoint wiring lock.
 *
 * `src/client/endpoints.ts` is the single place EmDash REST URLs are spelled, so every builder must be
 * byte-identical to the inline `new URL(...)` construction it replaces — one divergent character (a query
 * separator, a trailing slash, an encoded segment) turns into a live 404/500. Each case pins the exact string
 * a real call site produces today, then asserts the builder matches it.
 */
describe('EmDash endpoint builders', () => {
  const ORIGIN = 'https://blog.example.workers.dev';
  const COLLECTION = 'posts';
  const ARTICLE_ID = '01M6ARTICLEID000000000000AA';
  const MEDIA_ID = '01M67P0MBMJQQXH2K95HHCYRYB';
  const STORAGE_KEY = '01M6ASSETFILE00000000000AA.jpg';

  /** Mirrors `src/sync/pull.ts` / `src/sync/media/*`: a URL object plus searchParams for pagination. */
  function inlineListUrl(path: string, params: Record<string, string>): string {
    const url = new URL(path, ORIGIN);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  it('matches the inline spelling used by push POST, merge GET, media pull_article and delete', () => {
    // src/sync/push/index.ts:179 (create) and src/sync/media/pull_article.ts:79
    expect(articleContentEndpoint(ORIGIN, COLLECTION)).toBe(
      new URL(`/_emdash/api/content/${COLLECTION}`, ORIGIN).toString(),
    );
    // src/sync/push/index.ts:296 (PUT), merge_stage.ts:108 (conflict GET), delete.ts:178/:202, pull.ts:749
    expect(articleContentEndpoint(ORIGIN, COLLECTION, ARTICLE_ID)).toBe(
      new URL(`/_emdash/api/content/${COLLECTION}/${ARTICLE_ID}`, ORIGIN).toString(),
    );
  });

  it('leaves the delete verification cache-buster to the caller, never inventing a query string', () => {
    const base = articleContentEndpoint(ORIGIN, COLLECTION, ARTICLE_ID);
    expect(base).not.toContain('?');

    // src/sync/delete.ts:202-204 appends `_cb` itself; the builder must stay usable as that base.
    const verifyUrl = new URL(base);
    verifyUrl.searchParams.set('_cb', '1731456000000');
    expect(verifyUrl.toString()).toBe(
      `${ORIGIN}/_emdash/api/content/posts/${ARTICLE_ID}?_cb=1731456000000`,
    );
  });

  it('builds publish/unpublish transitions exactly as push/transport.ts spells them', () => {
    // src/sync/push/transport.ts:40-42 picks the action segment from the target status.
    expect(articleStatusTransitionEndpoint(ORIGIN, COLLECTION, ARTICLE_ID, 'publish')).toBe(
      new URL(`/_emdash/api/content/${COLLECTION}/${ARTICLE_ID}/publish`, ORIGIN).toString(),
    );
    expect(articleStatusTransitionEndpoint(ORIGIN, COLLECTION, ARTICLE_ID, 'unpublish')).toBe(
      new URL(`/_emdash/api/content/${COLLECTION}/${ARTICLE_ID}/unpublish`, ORIGIN).toString(),
    );
  });

  it('builds the lock endpoint identically for GET, POST and DELETE', () => {
    // src/client/lock.ts:70, :100, :132 spell the same path for three different verbs.
    expect(articleLockEndpoint(ORIGIN, COLLECTION, ARTICLE_ID)).toBe(
      new URL(`/_emdash/api/content/${COLLECTION}/${ARTICLE_ID}/lock`, ORIGIN).toString(),
    );
  });

  it('builds article term endpoints identically for the GET read and the POST write', () => {
    // src/sync/terms.ts:54-56 (GET) and src/sync/push/taxonomy_plan.ts:168-170 (POST).
    for (const taxonomy of ['category', 'tag'] as const) {
      expect(articleTermsEndpoint(ORIGIN, COLLECTION, ARTICLE_ID, taxonomy)).toBe(
        new URL(
          `/_emdash/api/content/${COLLECTION}/${ARTICLE_ID}/terms/${taxonomy}`,
          ORIGIN,
        ).toString(),
      );
    }
  });

  it('builds media record, list, upload-url and file-route endpoints', () => {
    // src/client/media.ts:197/:265/:294 and src/sync/media/pull_article.ts:151
    expect(mediaDetailEndpoint(ORIGIN, MEDIA_ID)).toBe(
      new URL(`/_emdash/api/media/${MEDIA_ID}`, ORIGIN).toString(),
    );
    // src/sync/media/remote_index.ts:53 and src/sync/media/pull_library.ts:141
    expect(mediaListEndpoint(ORIGIN)).toBe(new URL('/_emdash/api/media', ORIGIN).toString());
    // src/client/media.ts:345
    expect(mediaUploadUrlEndpoint(ORIGIN)).toBe(
      new URL('/_emdash/api/media/upload-url', ORIGIN).toString(),
    );
    // src/client/media.ts:642 confirm stage of the 4-stage upload flow
    expect(mediaConfirmEndpoint(ORIGIN, MEDIA_ID)).toBe(
      new URL(`/_emdash/api/media/${MEDIA_ID}/confirm`, ORIGIN).toString(),
    );
    // src/sync/doctor.ts:706 probes MEDIA_FILE_ROUTE_PREFIX + key
    expect(mediaFileEndpoint(ORIGIN, STORAGE_KEY)).toBe(
      new URL(`/_emdash/api/media/file/${STORAGE_KEY}`, ORIGIN).toString(),
    );
  });

  it('keeps pagination query spelling identical to the inline builder', () => {
    // src/sync/pull.ts:298-303 and src/sync/media/pull_library.ts:141-145 set limit/cursor on a URL object.
    const mediaFromBuilder = new URL(mediaListEndpoint(ORIGIN));
    mediaFromBuilder.searchParams.set('limit', '100');
    mediaFromBuilder.searchParams.set('cursor', 'abc123');
    expect(mediaFromBuilder.toString()).toBe(
      inlineListUrl('/_emdash/api/media', { limit: '100', cursor: 'abc123' }),
    );

    const articlesFromBuilder = new URL(articleContentEndpoint(ORIGIN, COLLECTION));
    articlesFromBuilder.searchParams.set('status', 'draft');
    articlesFromBuilder.searchParams.set('limit', '30');
    expect(articlesFromBuilder.toString()).toBe(
      inlineListUrl('/_emdash/api/content/posts', { status: 'draft', limit: '30' }),
    );
  });

  it('builds mcp, openapi and auth token endpoints', () => {
    // src/sync/bylines.ts:90, src/sync/pull.ts:249, src/client/auth.ts:174
    expect(mcpEndpoint(ORIGIN)).toBe(new URL('/_emdash/api/mcp', ORIGIN).toString());
    expect(openApiEndpoint(ORIGIN)).toBe(new URL('/_emdash/api/openapi.json', ORIGIN).toString());
    expect(authTokenEndpoint(ORIGIN)).toBe(new URL('/_emdash/api/auth/token', ORIGIN).toString());
  });

  it('agrees with the inline builder for every origin spelling a call site may pass', () => {
    for (const origin of [ORIGIN, `${ORIGIN}/`]) {
      expect(articleContentEndpoint(origin, COLLECTION, ARTICLE_ID)).toBe(
        new URL(`/_emdash/api/content/${COLLECTION}/${ARTICLE_ID}`, origin).toString(),
      );
      expect(mediaDetailEndpoint(origin, MEDIA_ID)).toBe(
        new URL(`/_emdash/api/media/${MEDIA_ID}`, origin).toString(),
      );
    }
  });

  it('agrees with the inline builder for a storageKey that carries multiple ULID segments', () => {
    // Migrated corpora bake keys shaped `<ulid1>.<ulid2>.<ext>`; the builder must not split or encode them.
    const multiSegmentKey = '01M6AAAABBBBCCCCDDDDEEEE.01M6FFFFGGGGHHHHJJJJKKKK.avif';
    expect(mediaFileEndpoint(ORIGIN, multiSegmentKey)).toBe(
      new URL(`/_emdash/api/media/file/${multiSegmentKey}`, ORIGIN).toString(),
    );
  });
});
