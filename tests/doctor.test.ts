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
import { initWorkspace, loadConfig } from '../src/utils/config.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';
import { calculateHash } from '../src/sync/pull.js';
import { runWorkspaceDoctor } from '../src/sync/doctor.js';

describe('Workspace Doctor Diagnostics (emit doctor / sync_doctor)', () => {
  let tempDir: string;
  let cache: CacheDatabase;
  const articleId = '01M67DOCTOR000000000000001';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-doctor-test-'));
    initWorkspace(tempDir, {
      origin: 'https://aroooy.net',
      createdWithVersion: '0.1.9',
      lastSyncedVersion: '0.1.10',
    });
    const dbPath = path.join(tempDir, '.emit', 'cache.db');
    cache = new CacheDatabase(dbPath);
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function setupHealthyArticle() {
    const frontmatter: Frontmatter = {
      id: articleId,
      slug: 'doctor-healthy-post',
      title: 'Doctor Healthy Post',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: { categories: ['tech'] },
      bylines: [],
    };
    const body = 'Healthy Content\n';
    const content = serializeMarkdown(frontmatter, body);
    const relPath = path.join('posts', 'draft', `20261108_${articleId}-doctor-healthy-post.md`);
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');

    const hash = calculateHash(content);
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: hash,
      remoteRev: 'rev-1',
      status: 'draft',
      slug: 'doctor-healthy-post',
      lastSyncedAt: 1700000000,
    });
    cache.saveBaseSnapshot({
      id: articleId,
      rev: 'rev-1',
      frontmatterYaml: JSON.stringify(frontmatter),
      bodyMarkdown: body,
      hash,
      savedAt: 1700000000,
    });
    return { relPath, fullPath };
  }

  it('reports healthy status for a clean, consistent workspace', async () => {
    setupHealthyArticle();
    const config = loadConfig(tempDir);

    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config,
      profileName: 'default',
      profileOrigin: 'https://aroooy.net',
    });

    expect(report.overallStatus).toBe('healthy');
    expect(report.createdWithVersion).toBe('0.1.9');
    expect(report.lastSyncedVersion).toBe('0.1.10');

    const vCheck = report.checks.find((c) => c.id === 'version_compatibility');
    expect(vCheck?.status).toBe('ok');

    const oCheck = report.checks.find((c) => c.id === 'origin_consistency');
    expect(oCheck?.status).toBe('ok');

    const fCheck = report.checks.find((c) => c.id === 'frontmatter_integrity');
    expect(fCheck?.status).toBe('ok');

    const cCheck = report.checks.find((c) => c.id === 'conflicts_quarantine');
    expect(cCheck?.status).toBe('ok');
  });

  it('detects origin mismatch and quarantined files as warnings', async () => {
    setupHealthyArticle();

    // Create a quarantined conflict file
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    fs.mkdirSync(conflictsDir, { recursive: true });
    fs.writeFileSync(
      path.join(conflictsDir, `20261108_${articleId}-doctor-healthy-post.conflict.md`),
      'conflict',
      'utf8',
    );

    const config = loadConfig(tempDir);
    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config,
      profileName: 'staging',
      profileOrigin: 'https://staging.example.com', // mismatch with config origin
    });

    expect(report.overallStatus).toBe('warnings');

    const oCheck = report.checks.find((c) => c.id === 'origin_consistency');
    expect(oCheck?.status).toBe('warning');
    expect(oCheck?.message).toContain('Config origin (https://aroooy.net) differs');

    const cCheck = report.checks.find((c) => c.id === 'conflicts_quarantine');
    expect(cCheck?.status).toBe('warning');
    expect(cCheck?.message).toContain('1 quarantined file(s) found');
  });

  it('detects unrecoverable frontmatter syntax errors as error', async () => {
    const draftDir = path.join(tempDir, 'posts', 'draft');
    fs.mkdirSync(draftDir, { recursive: true });
    // Write invalid yaml that cannot be repaired
    fs.writeFileSync(
      path.join(draftDir, '20261108_01M67CORRUPT0000000000001-broken.md'),
      '---\n:::invalid yaml:::\n---\nbody\n',
      'utf8',
    );

    const config = loadConfig(tempDir);
    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config,
    });

    expect(report.overallStatus).toBe('errors');
    const fCheck = report.checks.find((c) => c.id === 'frontmatter_integrity');
    expect(fCheck?.status).toBe('error');
    expect(fCheck?.message).toContain('unrecoverable frontmatter syntax errors');
  });

  it('detects missing referenced media files as warnings', async () => {
    const draftDir = path.join(tempDir, 'posts', 'draft');
    fs.mkdirSync(draftDir, { recursive: true });

    const frontmatter: Frontmatter = {
      id: articleId,
      slug: 'media-ref-post',
      title: 'Media Ref Post',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const body = 'Check this image: ![img](../../media/20261108_missing_image.png)\n';
    fs.writeFileSync(
      path.join(draftDir, `20261108_${articleId}-media-ref-post.md`),
      serializeMarkdown(frontmatter, body),
      'utf8',
    );

    const config = loadConfig(tempDir);
    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config,
    });

    const mCheck = report.checks.find((c) => c.id === 'media_references');
    expect(mCheck?.status).toBe('warning');
    expect(mCheck?.message).toContain('missing from disk');
  });
});
