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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pushArticle, PushValidationError } from '../src/sync/push.js';
import { CacheDatabase } from '../src/db/cache.js';
import { runPreflightChecks } from '../src/sync/preflight.js';
import { parseMarkdown } from '../src/utils/frontmatter.js';

describe('Push Guard Evaluation Order & T2-1 Regression Lock (B3)', () => {
  let tmpDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-guard-order-test-'));
    fs.mkdirSync(path.join(tmpDir, '.emit'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'posts', 'draft'), { recursive: true });
    cache = new CacheDatabase(path.join(tmpDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('T2-1 Regression Lock: G6 (UNRESOLVED_CONFLICT_MARKERS) fires BEFORE G16 (TAXONOMY_CONFLICT_PENDING)', async () => {
    const articleId = '01M6TESTLOCKORDER000000000';
    const relPath = `posts/draft/20261113_${articleId}-conflict-marker.md`;
    const fullPath = path.join(tmpDir, relPath);

    // Article body contains conflict markers
    const content = `---
id: ${articleId}
slug: conflict-marker
title: Conflict Marker
collection: posts
status: draft
---
<<<<<<< LOCAL
Local divergent content
=======
Remote incoming content
>>>>>>> REMOTE
`;
    fs.writeFileSync(fullPath, content, 'utf8');

    // SyncState has taxonomyConflictPending: 1
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: 'hash-abc',
      remoteRev: '1',
      status: 'draft',
      slug: 'conflict-marker',
      lastSyncedAt: 1000,
      conflictPending: 1,
      bodyConflictPending: 0,
      taxonomyConflictPending: 1,
      conflictCopyHash: null,
      conflictCopyPath: null,
      conflictAt: null,
      remoteTaxonomyHash: null,
      taxonomyApplyPending: 0,
    });

    // Attempt push without resolveTaxonomy:
    // If G16 fired first, ApiError('TAXONOMY_CONFLICT_PENDING') would be thrown.
    // However, per T2-1 / AGENTS.md §9, Preflight Guard G6 MUST fire first!
    let caughtError: unknown = null;
    try {
      await pushArticle(relPath, {
        workspaceRoot: tmpDir,
        cache,
        origin: 'https://example.com',
        token: 'test-token',
        fetchFn: async () => new Response('{}', { status: 200 }),
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(PushValidationError);
    const validationErr = caughtError as PushValidationError;
    expect(validationErr.errors.some((e) => e.code === 'UNRESOLVED_CONFLICT_MARKERS')).toBe(true);
    expect(validationErr.errors.some((e) => e.code === 'TAXONOMY_CONFLICT_PENDING')).toBe(false);
  });

  it('preflight internal ordering: G6 conflict markers are evaluated and reported in preflight', () => {
    const filePath = 'posts/draft/test.md';
    const raw = `---
id: 01M6TESTPREFLIGHTORDER0000
slug: test
title: Test Title
collection: posts
status: draft
taxonomies:
  categories:
    - non-existent-cat
---
<<<<<<< LOCAL
local
=======
remote
>>>>>>> REMOTE
`;
    const parsed = parseMarkdown(raw, filePath);
    const result = runPreflightChecks(filePath, parsed, {
      knownTaxonomies: { categories: ['tech', 'design'] },
      workspaceRoot: tmpDir,
      cache,
    });

    expect(result.valid).toBe(false);
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain('UNRESOLVED_CONFLICT_MARKERS');
    expect(codes).toContain('INVALID_TAXONOMY_ERROR');
  });
});
