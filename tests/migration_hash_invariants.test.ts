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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheDatabase } from '../src/db/cache.js';
import {
  createBaseSnapshot,
  readBaseline,
  readBaselineFrontmatter,
  baselineMarkdown,
} from '../src/db/baseline.js';
import { calculateHash } from '../src/sync/pull.js';
import { getWorkspaceStatus } from '../src/sync/status.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';

describe('Migration Hash Invariants & Workspace Upgrade Safety', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-migration-invariants-'));
    cache = new CacheDatabase(path.join(tempDir, 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps healthy articles byte-identical and prevents false modified status when upgrading workspace without re-pull', () => {
    const articles = [
      {
        id: '01M67MP2W0VKCK2DFWM166CR24',
        slug: 'tech-article',
        title: 'Tech Article',
        category: 'tech',
      },
      {
        id: '01M67MP2W0VKCK2DFWM166CR25',
        slug: 'diary-post',
        title: 'Diary Post',
        category: 'diary',
      },
      {
        id: '01M67MP2W0VKCK2DFWM166CR26',
        slug: 'gadget-review',
        title: 'Gadget Review',
        category: 'gadget',
      },
      {
        id: '01M67MP2W0VKCK2DFWM166CR27',
        slug: '%e5%8f%b0%e6%b9%be-travel',
        title: 'Taiwan Travel',
        category: '%e6%9c%aa%e5%88%86%e9%a1%9e',
      },
    ];

    for (const a of articles) {
      const relPath = `posts/published/20261101_${a.id}-${a.slug}.md`;
      const fullPath = path.join(tempDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });

      const fm: Frontmatter = {
        id: a.id,
        slug: a.slug,
        title: a.title,
        collection: 'posts',
        status: 'published',
        publishedAt: '2026-11-01T00:00:00.000Z',
        locale: 'ja',
        taxonomies: { categories: [a.category] },
        bylines: [],
      };

      const content = serializeMarkdown(fm, `Content for ${a.title}.\n`);
      fs.writeFileSync(fullPath, content, 'utf8');

      const hash = calculateHash(content);

      // Baseline snapshot and sync state matching 0.1.8/0.1.9 serializer (epoch seconds for lastSyncedAt)
      cache.saveSyncState({
        id: a.id,
        localFilePath: relPath,
        localHash: hash,
        remoteRev: 'rev_1',
        status: 'published',
        slug: a.slug,
        lastSyncedAt: Math.floor(Date.now() / 1000),
      });

      cache.saveBaseSnapshot({
        id: a.id,
        rev: 'rev_1',
        bodyMarkdown: `Content for ${a.title}.\n`,
        frontmatterYaml: JSON.stringify(fm),
        hash,
        savedAt: Math.floor(Date.now() / 1000),
      });
    }

    // Checking status on upgrade without pulling MUST report 100% synced, 0 modified, 0 invalid
    const status = getWorkspaceStatus(tempDir, cache, 'posts');
    expect(status.summary.total).toBe(4);
    expect(status.summary.synced).toBe(4);
    expect(status.summary.modified).toBe(0);
    expect(status.summary.invalid).toBe(0);
    expect(status.summary.untracked).toBe(0);
  });

  it('guarantees bidirectional byte-identical baseline reconstruction (pull output and push write paths)', () => {
    const fm: Frontmatter = {
      id: '01M67MP2W0VKCK2DFWM166CR30',
      slug: 'baseline-invariant-article',
      title: 'Baseline Invariant Article',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: {
        categories: ['tech'],
        tags: ['typescript', 'sqlite'],
      },
      bylines: ['author-1'],
    };
    const body = '# Heading 2\n\nArticle body with paragraph and list:\n\n- item 1\n- item 2\n';

    // 1. Simulate pull writing to disk
    const diskContent = serializeMarkdown(fm, body);
    const diskHash = calculateHash(diskContent);

    // 2. Save snapshot via createBaseSnapshot (pull / push write pattern)
    const snapshot = createBaseSnapshot({
      id: fm.id,
      rev: 'rev_pull_100',
      bodyMarkdown: body,
      frontmatter: fm,
      hash: diskHash,
    });
    cache.saveBaseSnapshot(snapshot);

    // 3. Read back from database and decode
    const retrieved = cache.getBaseSnapshot(fm.id);
    expect(retrieved).not.toBeNull();
    const decoded = readBaseline(retrieved!);
    expect(decoded.frontmatter).toEqual(fm);
    expect(decoded.body).toBe(body);

    const decodedFm = readBaselineFrontmatter(retrieved!);
    expect(decodedFm).toEqual(fm);

    // 4. Assert bidirectional byte-identical reconstruction
    const reconstructed = baselineMarkdown(retrieved!);
    expect(reconstructed).toBe(diskContent);
    expect(calculateHash(reconstructed)).toBe(diskHash);
    expect(calculateHash(reconstructed)).toBe(retrieved!.hash);

    // 5. Simulate push update: modifying frontmatter and updating baseline
    const updatedFm: Frontmatter = {
      ...fm,
      title: 'Updated Title',
      status: 'published',
      publishedAt: '2026-11-13T00:00:00.000Z',
    };
    const updatedDiskContent = serializeMarkdown(updatedFm, body);
    const updatedDiskHash = calculateHash(updatedDiskContent);

    const pushSnapshot = createBaseSnapshot({
      id: fm.id,
      rev: 'rev_push_200',
      bodyMarkdown: body,
      frontmatter: updatedFm,
      hash: updatedDiskHash,
    });
    cache.saveBaseSnapshot(pushSnapshot);

    const pushRetrieved = cache.getBaseSnapshot(fm.id);
    expect(pushRetrieved).not.toBeNull();
    const pushReconstructed = baselineMarkdown(pushRetrieved!);
    expect(pushReconstructed).toBe(updatedDiskContent);
    expect(calculateHash(pushReconstructed)).toBe(updatedDiskHash);
    expect(calculateHash(pushReconstructed)).toBe(pushRetrieved!.hash);
  });
});
