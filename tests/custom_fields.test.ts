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
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheDatabase, CURRENT_CACHE_SCHEMA_VERSION } from '../src/db/cache.js';
import { createBaseSnapshot, readBaselineExtraData } from '../src/db/baseline.js';
import { initWorkspace } from '../src/utils/config.js';
import {
  formatFrontmatterYaml,
  parseMarkdown,
  parseMarkdownLenient,
  serializeMarkdown,
  type Frontmatter,
} from '../src/utils/frontmatter.js';
import { apiResponseToLocal, localToApiPayload } from '../src/client/mapper.js';
import { mergeFrontmatter } from '../src/sync/merge.js';
import { runPreflightChecks } from '../src/sync/preflight.js';
import { GUARD_REGISTRY, remediationFor } from '../src/sync/guards.js';
import { commitArticleSnapshot } from '../src/sync/workspace/index.js';
import { publishArticle } from '../src/sync/orchestrator.js';

describe('Custom Fields Support (v0.2.0 Part 2: Opaque Pass-Through & Simple fields:)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-custom-fields-'));
    initWorkspace(tempDir);
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('SQLite Schema v9 migration (base_snapshots.extra_data_json)', () => {
    it('upgrades a v8 cache database to v9 and preserves extra_data_json', () => {
      const dbPath = path.join(tempDir, '.emit', 'v8-legacy.db');
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE base_snapshots (
          id TEXT PRIMARY KEY,
          rev TEXT NOT NULL,
          body_markdown TEXT NOT NULL,
          frontmatter_yaml TEXT NOT NULL,
          hash TEXT NOT NULL,
          saved_at INTEGER NOT NULL
        );
        PRAGMA user_version = 8;
      `);
      rawDb.close();

      expect(CURRENT_CACHE_SCHEMA_VERSION).toBe(9);
      const upgraded = new CacheDatabase(dbPath);
      try {
        const fm: Frontmatter = {
          id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          slug: 'product-a',
          title: 'Product A',
          collection: 'products',
          status: 'draft',
          publishedAt: null,
          locale: 'ja',
          taxonomies: {},
          bylines: [],
        };
        const snap = createBaseSnapshot({
          id: fm.id,
          rev: 'r1',
          bodyMarkdown: 'Body\n',
          frontmatter: fm,
          hash: 'h1',
          extraDataJson: JSON.stringify({
            specs: { weight: 120 },
            richNotes: [{ _type: 'block' }],
          }),
        });
        upgraded.saveBaseSnapshot(snap);
        const loaded = upgraded.getBaseSnapshot(fm.id);
        expect(readBaselineExtraData(loaded)).toEqual({
          specs: { weight: 120 },
          richNotes: [{ _type: 'block' }],
        });
      } finally {
        upgraded.close();
      }
    });
  });

  describe('Frontmatter fields: serialization, byte-identity, and Axis 7 lenient parse', () => {
    it('omits fields: completely when absent or empty (byte-identical for standard posts)', () => {
      const fm: Frontmatter = {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        slug: 'standard-post',
        title: 'Standard Post',
        collection: 'posts',
        status: 'draft',
        publishedAt: null,
        locale: 'ja',
        taxonomies: { categories: [], tags: [] },
        bylines: [],
      };
      const yamlWithout = formatFrontmatterYaml(fm);
      const yamlEmpty = formatFrontmatterYaml({ ...fm, fields: {} });
      expect(yamlWithout).not.toContain('fields:');
      expect(yamlEmpty).toBe(yamlWithout);
    });

    it('serializes simple custom fields deterministically sorted by key and survives parseMarkdown + parseMarkdownLenient', () => {
      const fm: Frontmatter = {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        slug: 'camera-x',
        title: 'Camera X',
        collection: 'products',
        status: 'draft',
        publishedAt: null,
        locale: 'ja',
        taxonomies: { categories: [], tags: [] },
        bylines: [],
        fields: {
          zeta: ['one', 'two'],
          alpha: 'hello: world',
          price: 19800,
          inStock: true,
          discontinuedAt: null,
        },
      };

      const md = serializeMarkdown(fm, 'Product description\n');
      const alphaIdx = md.indexOf('  alpha:');
      const priceIdx = md.indexOf('  price:');
      const zetaIdx = md.indexOf('  zeta:');
      expect(alphaIdx).toBeGreaterThan(0);
      expect(alphaIdx).toBeLessThan(priceIdx);
      expect(priceIdx).toBeLessThan(zetaIdx);

      const strictParsed = parseMarkdown(md);
      expect(strictParsed.frontmatter.fields).toEqual(fm.fields);

      // Axis 7: parseMarkdownLenient preserves nested fields: map intact
      const lenientParsed = parseMarkdownLenient(md);
      expect(lenientParsed).not.toBeNull();
      expect(lenientParsed?.frontmatter.fields).toEqual(fm.fields);
    });
  });

  describe('Mapper 2-tier classification & non-destructive pass-through', () => {
    it('splits simple fields into frontmatter.fields and complex fields into opaqueExtraData, then merges cleanly on push', () => {
      const rawItem = {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        slug: 'gadget-1',
        collection: 'products',
        status: 'draft',
        locale: 'en',
        _rev: 'rev-1',
        data: {
          title: 'Gadget 1',
          content: [
            {
              _type: 'block',
              _key: 'k1',
              style: 'normal',
              children: [{ _type: 'span', _key: 's1', text: 'Hello gadget', marks: [] }],
              markDefs: [],
            },
          ],
          price: 299,
          available: true,
          subtitle: 'Compact',
          highlights: ['lightweight', 'usb-c'],
          nestedSpecs: { weightGrams: 180, waterproof: true },
          secondaryRichText: [{ _type: 'block', _key: 'r1', children: [] }],
        },
      };

      const local = apiResponseToLocal(rawItem);
      expect(local.frontmatter.fields).toEqual({
        price: 299,
        available: true,
        subtitle: 'Compact',
        highlights: ['lightweight', 'usb-c'],
      });
      expect(local.opaqueExtraData).toEqual({
        nestedSpecs: { weightGrams: 180, waterproof: true },
        secondaryRichText: [{ _type: 'block', _key: 'r1', children: [] }],
      });

      // Local edit to simple field `price` only
      const edited: Frontmatter = {
        ...local.frontmatter,
        fields: {
          ...local.frontmatter.fields,
          price: 249,
        },
      };
      const payload = localToApiPayload(
        { frontmatter: edited, body: local.body, rawYaml: '' },
        'rev-1',
        { opaqueExtraData: local.opaqueExtraData },
      );

      expect(payload.data.title).toBe('Gadget 1');
      expect(payload.data.price).toBe(249);
      expect(payload.data.available).toBe(true);
      expect(payload.data.nestedSpecs).toEqual({ weightGrams: 180, waterproof: true });
      expect(payload.data.secondaryRichText).toEqual([
        { _type: 'block', _key: 'r1', children: [] },
      ]);
    });
  });

  describe('Leaf-level 3-Way Merge on fields.<key> (mergeFrontmatter)', () => {
    it('merges non-overlapping edits (remote changes A, local changes B) without losing either', () => {
      const base: Frontmatter = {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        slug: 'item',
        title: 'Item',
        collection: 'products',
        status: 'draft',
        publishedAt: null,
        locale: 'ja',
        taxonomies: {},
        bylines: [],
        fields: { a: 'base-a', b: 'base-b', c: 1 },
      };
      const remote: Frontmatter = {
        ...base,
        fields: { a: 'remote-a', b: 'base-b', c: 1 },
      };
      const local: Frontmatter = {
        ...base,
        fields: { a: 'base-a', b: 'local-b', c: 1 },
      };

      const res = mergeFrontmatter(local, base, remote);
      expect(res.merged.fields).toEqual({ a: 'remote-a', b: 'local-b', c: 1 });
      expect(res.warnings).toEqual([]);
    });

    it('prefers remote and emits warning on true leaf conflict on the same key', () => {
      const base: Frontmatter = {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        slug: 'item',
        title: 'Item',
        collection: 'products',
        status: 'draft',
        publishedAt: null,
        locale: 'ja',
        taxonomies: {},
        bylines: [],
        fields: { a: 'base-a' },
      };
      const remote: Frontmatter = { ...base, fields: { a: 'remote-a' } };
      const local: Frontmatter = { ...base, fields: { a: 'local-a' } };

      const res = mergeFrontmatter(local, base, remote);
      expect(res.merged.fields).toEqual({ a: 'remote-a' });
      expect(res.warnings.some((w) => w.includes('fields.a'))).toBe(true);
    });
  });

  describe('Guard G24 (RESERVED_CUSTOM_FIELD_KEY)', () => {
    it('is registered in GUARD_REGISTRY with remediation and rejects reserved keys in preflight', () => {
      expect(
        GUARD_REGISTRY.some((g) => g.id === 24 && g.name === 'RESERVED_CUSTOM_FIELD_KEY'),
      ).toBe(true);
      expect(remediationFor('RESERVED_CUSTOM_FIELD_KEY')).toBeTruthy();

      const fm: Frontmatter = {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        slug: 'bad-fields',
        title: 'Bad Fields',
        collection: 'products',
        status: 'draft',
        publishedAt: null,
        locale: 'ja',
        taxonomies: {},
        bylines: [],
        fields: { title: 'hijack', price: 100 },
      };

      const check = runPreflightChecks('posts/ja/draft/01ARZ3NDEKTSV4RRFFQ69G5FAV-bad.md', {
        frontmatter: fm,
        body: 'Hello\n',
        rawYaml: '',
      });
      expect(check.valid).toBe(false);
      expect(check.errors.some((e) => e.code === 'RESERVED_CUSTOM_FIELD_KEY')).toBe(true);
    });
  });

  describe('P1 Regression: extra_data_json preservation across re-commits and publish', () => {
    it('preserves existing extra_data_json when commitArticleSnapshot omits extraDataJson, and clears only on explicit null', () => {
      const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
      const relPath = `posts/ja/published/20261127_${id}-opaque-keep.md`;
      const fm: Frontmatter = {
        id,
        slug: 'opaque-keep',
        title: 'Opaque Keep',
        collection: 'posts',
        status: 'published',
        publishedAt: '2026-11-27T00:00:00Z',
        locale: 'ja',
        taxonomies: { categories: [], tags: [] },
        bylines: [],
      };
      const md = serializeMarkdown(fm, 'Body\n');
      const opaque = { complexMeta: { nested: [1, 2, 3] } };

      // Initial pull saves extraDataJson
      commitArticleSnapshot(cache, tempDir, {
        id,
        relPath,
        diskContent: md,
        frontmatter: fm,
        bodyMarkdown: 'Body\n',
        revForTransport: 'rev-1',
        revForComparison: '1@live:L1',
        extraDataJson: JSON.stringify(opaque),
      });
      expect(readBaselineExtraData(cache.getBaseSnapshot(id))).toEqual(opaque);

      // Re-commit without specifying extraDataJson (e.g. fast_path / snapshot_pull) preserves existing value
      commitArticleSnapshot(cache, tempDir, {
        id,
        relPath,
        diskContent: md,
        frontmatter: fm,
        bodyMarkdown: 'Body\n',
        revForTransport: 'rev-1',
        revForComparison: '1@live:L1',
        skipDiskWrite: true,
      });
      expect(readBaselineExtraData(cache.getBaseSnapshot(id))).toEqual(opaque);

      // Explicit null clears extra_data_json (e.g. authoritative full GET confirms no opaque fields remain)
      commitArticleSnapshot(cache, tempDir, {
        id,
        relPath,
        diskContent: md,
        frontmatter: fm,
        bodyMarkdown: 'Body\n',
        revForTransport: 'rev-2',
        revForComparison: '2@live:L2',
        extraDataJson: null,
        skipDiskWrite: true,
      });
      expect(readBaselineExtraData(cache.getBaseSnapshot(id))).toBeUndefined();
    });

    it('preserves base_snapshots.extra_data_json across publishArticle()', async () => {
      const id = '01ARZ3NDEKTSV4RRFFQ69G5FBW';
      const draftRel = `posts/ja/draft/20261127_${id}-pub-opaque.md`;
      const fm: Frontmatter = {
        id,
        slug: 'pub-opaque',
        title: 'Pub Opaque',
        collection: 'posts',
        status: 'draft',
        publishedAt: null,
        locale: 'ja',
        taxonomies: { categories: [], tags: [] },
        bylines: [],
      };
      const md = serializeMarkdown(fm, 'Body\n');
      const opaque = { layoutGrid: { cols: 3 } };

      commitArticleSnapshot(cache, tempDir, {
        id,
        relPath: draftRel,
        diskContent: md,
        frontmatter: fm,
        bodyMarkdown: 'Body\n',
        revForTransport: 'rev-1',
        revForComparison: '1@draft:D1',
        extraDataJson: JSON.stringify(opaque),
      });

      let published = false;
      const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method || 'GET';
        if (url.includes('/lock')) {
          return new Response(JSON.stringify({ acquired: true, token: 'lock-1' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/publish') && method === 'POST') {
          published = true;
          return new Response(
            JSON.stringify({
              data: {
                _rev: 'rev-2',
                item: {
                  id,
                  slug: 'pub-opaque',
                  collection: 'posts',
                  status: 'published',
                  locale: 'ja',
                  version: 2,
                  liveRevisionId: 'L2',
                  publishedAt: '2026-11-27T05:00:00Z',
                  data: { title: 'Pub Opaque', content: [] },
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        // GET /content/posts/:id (pre-publish returns rev-1 / draft D1; post-publish returns rev-2 / live L2)
        return new Response(
          JSON.stringify({
            data: {
              _rev: published ? 'rev-2' : 'rev-1',
              item: published
                ? {
                    id,
                    slug: 'pub-opaque',
                    collection: 'posts',
                    status: 'published',
                    locale: 'ja',
                    version: 2,
                    liveRevisionId: 'L2',
                    publishedAt: '2026-11-27T05:00:00Z',
                    data: { title: 'Pub Opaque', content: [] },
                  }
                : {
                    id,
                    slug: 'pub-opaque',
                    collection: 'posts',
                    status: 'draft',
                    locale: 'ja',
                    version: 1,
                    draftRevisionId: 'D1',
                    publishedAt: null,
                    data: { title: 'Pub Opaque', content: [] },
                  },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch;

      const pubRes = await publishArticle(id, {
        workspaceRoot: tempDir,
        cache,
        origin: 'https://example.test',
        token: 'tok',
        collection: 'posts',
        fetchFn: mockFetch,
      });
      expect(pubRes.success).toBe(true);
      expect(readBaselineExtraData(cache.getBaseSnapshot(id))).toEqual(opaque);
    });
  });
});
