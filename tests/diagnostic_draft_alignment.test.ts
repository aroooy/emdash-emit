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
import { CacheDatabase } from '../src/db/cache.js';
import { getWorkspaceStatus } from '../src/sync/status.js';
import { inspectArticleDiff } from '../src/sync/diff.js';
import { runWorkspaceDoctor } from '../src/sync/doctor.js';
import { loadConfig } from '../src/utils/config.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';
import { commitArticleSnapshot } from '../src/sync/workspace/index.js';

describe('Diagnostic Alignment for Draft Revision (status vs diff vs doctor)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-diag-align-test-'));
    cache = new CacheDatabase(path.join(tempDir, 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('aligns status, diff, and doctor symmetrically with 0 phantom diffs when article has draft revision', async () => {
    const articleId = '01M77VFT15HSH2M1XW8MJPTCPQ';
    const relPath = `posts/published/20261113_${articleId}-kingfisher.md`;

    const fm: Frontmatter = {
      id: articleId,
      slug: 'kingfisher',
      title: 'カワセミ写真',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-13T10:00:00.000Z',
      locale: 'ja',
      taxonomies: { categories: ['野鳥'], tags: [] },
      bylines: ['aroooy'],
    };

    const body = 'Unpublished draft body content pulled from EmDash.\n';
    const diskContent = serializeMarkdown(fm, body, undefined, { hasDraftRevision: true });
    expect(diskContent).toContain('status: published # draft revision');

    // Commit snapshot via centralized commitArticleSnapshot
    commitArticleSnapshot(cache, tempDir, {
      id: articleId,
      relPath,
      diskContent,
      frontmatter: fm,
      bodyMarkdown: body,
      revForTransport: 'MTk6MjAyNi0xMS0xNFQwNzoxMDowMC4wMDBa',
      revForComparison: '19@draft:01M7CD9YGWNPAEP1Z7NC8600ZD',
    });

    // 1. Check getWorkspaceStatus
    const status = getWorkspaceStatus(tempDir, cache, 'posts');
    expect(status.summary.total).toBe(1);
    expect(status.summary.synced).toBe(1);
    expect(status.summary.modified).toBe(0);
    expect(status.items[0].syncStatus).toBe('synced');
    expect(status.items[0].hasUnpublishedDraft).toBe(true);

    // 2. Check inspectArticleDiff (MUST have 0 differences!)
    const diff = inspectArticleDiff({
      id: articleId,
      workspaceRoot: tempDir,
      cache,
    });
    expect(diff.status).toBe('synced');
    expect(diff.formattedOutput).toContain('In Sync with base snapshot');
    expect(diff.formattedOutput).toContain('No changes detected');

    // 3. Check runWorkspaceDoctor
    const config = loadConfig(tempDir);
    const doctor = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config,
    });
    expect(doctor.overallStatus).toBe('healthy');
    const fCheck = doctor.checks.find((c) => c.id === 'frontmatter_integrity');
    expect(fCheck?.status).toBe('ok');
  });
});
