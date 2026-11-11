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
import { runWorkspaceDoctor, scanArticleMediaDetailed } from '../src/sync/doctor.js';
import { collectArticleStorageKeys } from '../src/sync/media.js';

describe('Workspace Doctor Diagnostics (emit doctor / sync_doctor)', () => {
  let tempDir: string;
  let cache: CacheDatabase;
  let origHome: string | undefined;
  const articleId = '01M67DOCTOR000000000000001';

  beforeEach(() => {
    origHome = process.env.HOME;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-doctor-test-'));
    process.env.HOME = tempDir;
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
    if (origHome !== undefined) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
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

  it('reports healable frontmatter syntax errors as a pull-repairable warning', async () => {
    const draftDir = path.join(tempDir, 'posts', 'draft');
    fs.mkdirSync(draftDir, { recursive: true });
    // Legacy unquoted percent-encoded taxonomy slug: invalid YAML but leniently repairable
    fs.writeFileSync(
      path.join(draftDir, '20261108_01M67HEALABLE0000000000001-legacy.md'),
      [
        '---',
        'id: 01M67HEALABLE0000000000001',
        'slug: legacy-quoting',
        'title: "Legacy Quoting"',
        'collection: posts',
        'status: draft',
        'locale: ja',
        'taxonomies:',
        '  categories:',
        '    - %e6%9c%aa%e5%88%86%e9%a1%9e',
        '---',
        '',
        'Legacy body.',
      ].join('\n'),
      'utf8',
    );

    const config = loadConfig(tempDir);
    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config,
    });

    expect(report.overallStatus).toBe('warnings');
    const fCheck = report.checks.find((c) => c.id === 'frontmatter_integrity');
    expect(fCheck?.status).toBe('warning');
    expect(fCheck?.message).toContain('repair automatically');
    expect(fCheck?.message).toContain('emit pull');
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
    // A missing local mirror is not a broken reference: the warning must teach the two ID spaces and
    // point at the standalone specification so neither humans nor agents chase a phantom data loss.
    expect(mCheck?.message).toContain('docs/media-id-spaces.md');
    expect(mCheck?.message).toContain('storage keys');
  });

  it('correctly resolves canonical storageKey media references against companion YAML (D1)', async () => {
    const draftDir = path.join(tempDir, 'posts', 'draft');
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(draftDir, { recursive: true });
    fs.mkdirSync(mediaDir, { recursive: true });

    // Companion YAML in media/
    const companionYaml = [
      'id: 01M67MEDIA000000000000001',
      'filename: sample.png',
      'storageKey: uploads/2026/11/sample.png',
      'mimeType: image/png',
    ].join('\n');
    fs.writeFileSync(
      path.join(mediaDir, '20261108_01M67MEDIA000000000000001-sample.yaml'),
      companionYaml,
      'utf8',
    );

    const frontmatter: Frontmatter = {
      id: articleId,
      slug: 'media-ref-canonical-post',
      title: 'Media Ref Canonical Post',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    // Reference by canonical EmDash media URL
    const body =
      'Check this image: ![img](https://aroooy.net/_emdash/api/media/file/uploads/2026/11/sample.png)\n';
    fs.writeFileSync(
      path.join(draftDir, `20261108_${articleId}-media-ref-canonical-post.md`),
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
    expect(mCheck?.status).toBe('ok');
    expect(mCheck?.message).toContain('All referenced local media files exist on disk');
  });

  it('classifies code-span, code-fence, and placeholder media references as informational without triggering warnings (Phase 5)', async () => {
    const draftDir = path.join(tempDir, 'posts', 'draft');
    fs.mkdirSync(draftDir, { recursive: true });

    const frontmatter: Frontmatter = {
      id: articleId,
      slug: 'media-code-examples-post',
      title: 'Media Code Examples Post',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    // Content with placeholder and code-fenced references
    const body = [
      'Here is an explanation of media URLs:',
      'Inline code: `![alt](/_emdash/api/media/file/<id>.png)`',
      'Placeholder: `/_emdash/api/media/file/<storageKey>`',
      '',
      '```markdown',
      '![Fenced image](../../media/drafts/sample-shot.jpg)',
      '```',
    ].join('\n');

    const content = serializeMarkdown(frontmatter, body);
    fs.writeFileSync(
      path.join(draftDir, `20261108_${articleId}-media-code-examples-post.md`),
      content,
      'utf8',
    );

    const hash = calculateHash(content);
    const relPath = `posts/draft/20261108_${articleId}-media-code-examples-post.md`;
    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: hash,
      remoteRev: 'rev-1',
      status: 'draft',
      slug: 'media-code-examples-post',
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

    const config = loadConfig(tempDir);
    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config,
    });

    const mCheck = report.checks.find((c) => c.id === 'media_references');
    expect(mCheck?.status).toBe('ok');
    expect(mCheck?.message).toContain('informational/custom-block reference(s) ignored');
    expect(report.overallStatus).toBe('healthy');
  });

  // --- Media diagnostic resolution fallbacks (Phase A) and fence classification (Phase B) ---

  it('resolves a media file reference when the companion YAML lacks a storageKey field (A-1 filename tail)', async () => {
    const draftDir = path.join(tempDir, 'posts', 'draft');
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(draftDir, { recursive: true });
    fs.mkdirSync(mediaDir, { recursive: true });

    // Promoted asset whose YAML companion never recorded storageKey (legacy corpus shape)
    fs.writeFileSync(
      path.join(mediaDir, '20261108_01M67MEDIA0000000000000AA-hero-shot.jpg'),
      'binary',
      'utf8',
    );
    fs.writeFileSync(
      path.join(mediaDir, '20261108_01M67MEDIA0000000000000AA-hero-shot.yaml'),
      ['id: 01M67MEDIA0000000000000AA', 'filename: hero-shot.jpg', 'mimeType: image/jpeg'].join(
        '\n',
      ),
      'utf8',
    );

    const frontmatter: Frontmatter = {
      id: articleId,
      slug: 'media-yaml-no-storagekey',
      title: 'Media YAML No StorageKey',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const body = '![Hero](/_emdash/api/media/file/01M67MEDIA0000000000000BB.hero-shot.jpg)\n';
    fs.writeFileSync(
      path.join(draftDir, `20261108_${articleId}-media-yaml-no-storagekey.md`),
      serializeMarkdown(frontmatter, body),
      'utf8',
    );

    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config: loadConfig(tempDir),
    });
    const mCheck = report.checks.find((c) => c.id === 'media_references');
    expect(mCheck?.status).toBe('ok');
  });

  it('resolves a media reference from a media_state record even with no local file (A-2)', async () => {
    const draftDir = path.join(tempDir, 'posts', 'draft');
    fs.mkdirSync(draftDir, { recursive: true });

    cache.saveMediaState({
      localHash: 'c'.repeat(64),
      mediaId: '01M67MEDIA0000000000000CC',
      storageKey: '01M67MEDIDDD00000000000000.png',
      url: '/_emdash/api/media/file/01M67MEDIDDD00000000000000.png',
      workspacePath: null,
      status: 'ready',
      uploadedAt: 1700000000,
    });

    const frontmatter: Frontmatter = {
      id: articleId,
      slug: 'media-state-resolved',
      title: 'Media State Resolved',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const body = '![State](/_emdash/api/media/file/01M67MEDIDDD00000000000000.png)\n';
    fs.writeFileSync(
      path.join(draftDir, `20261108_${articleId}-media-state-resolved.md`),
      serializeMarkdown(frontmatter, body),
      'utf8',
    );

    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config: loadConfig(tempDir),
    });
    const mCheck = report.checks.find((c) => c.id === 'media_references');
    expect(mCheck?.status).toBe('ok');
  });

  it('resolves a reference via featured_image meta.storageKey stored in the base snapshot (A-3)', async () => {
    const draftDir = path.join(tempDir, 'posts', 'draft');
    fs.mkdirSync(draftDir, { recursive: true });

    const body = '![Featured](/_emdash/api/media/file/01M67MEDIFEE00000000000000.jpg)\n';
    const frontmatter: Frontmatter = {
      id: articleId,
      slug: 'media-featured-snapshot',
      title: 'Media Featured Snapshot',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
      featuredImage: '01M67MEDIA0000000000000FF',
    };
    const content = serializeMarkdown(frontmatter, body);
    const relPath = `posts/draft/20261108_${articleId}-media-featured-snapshot.md`;
    fs.writeFileSync(path.join(tempDir, relPath), content, 'utf8');

    cache.saveSyncState({
      id: articleId,
      localFilePath: relPath,
      localHash: calculateHash(content),
      remoteRev: 'rev-1',
      status: 'draft',
      slug: 'media-featured-snapshot',
      lastSyncedAt: 1700000000,
    });
    // The remote baseline preserves the full featured_image object including meta.storageKey
    cache.saveBaseSnapshot({
      id: articleId,
      rev: 'rev-1',
      frontmatterYaml: JSON.stringify({
        ...frontmatter,
        featuredImage: {
          id: '01M67MEDIA0000000000000FF',
          provider: 'local',
          meta: { storageKey: '01M67MEDIFEE00000000000000.jpg' },
        },
      }),
      bodyMarkdown: body,
      hash: calculateHash(content),
      savedAt: 1700000000,
    });

    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config: loadConfig(tempDir),
    });
    const mCheck = report.checks.find((c) => c.id === 'media_references');
    expect(mCheck?.status).toBe('ok');
  });

  it('never reports media URLs embedded in opaque custom-block fences as missing (B-1)', async () => {
    const draftDir = path.join(tempDir, 'posts', 'draft');
    fs.mkdirSync(draftDir, { recursive: true });

    const frontmatter: Frontmatter = {
      id: articleId,
      slug: 'media-opaque-fence',
      title: 'Media Opaque Fence',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const body = [
      'Text before.',
      '<!--ec:block {"type":"custom","src":"/_emdash/api/media/file/01M67MEDIA0000000000000JJ.jpg"} -->',
      'Text after.',
    ].join('\n');
    fs.writeFileSync(
      path.join(draftDir, `20261108_${articleId}-media-opaque-fence.md`),
      serializeMarkdown(frontmatter, body),
      'utf8',
    );

    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config: loadConfig(tempDir),
    });
    const mCheck = report.checks.find((c) => c.id === 'media_references');
    expect(mCheck?.status).toBe('ok');
    // The opaque fence payload is not even attempted as a reference
    expect(JSON.stringify(mCheck?.details ?? '')).not.toContain('01M67MEDIA0000000000000JJ');
  });

  it('classifies legacy WordPress container lines as informational without warning (B-2)', async () => {
    const draftDir = path.join(tempDir, 'posts', 'draft');
    fs.mkdirSync(draftDir, { recursive: true });

    const frontmatter: Frontmatter = {
      id: articleId,
      slug: 'media-legacy-container',
      title: 'Media Legacy Container',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const body = [
      '[dimage url="/_emdash/api/media/file/01M67MEDIA0000000000000KK.jpg" control=true]',
      '![broken](/_emdash/api/media/file/01M67MEDIA0000000000000LL.jpg" control=true)',
    ].join('\n');
    fs.writeFileSync(
      path.join(draftDir, `20261108_${articleId}-media-legacy-container.md`),
      serializeMarkdown(frontmatter, body),
      'utf8',
    );

    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config: loadConfig(tempDir),
    });
    const mCheck = report.checks.find((c) => c.id === 'media_references');
    expect(mCheck?.status).toBe('ok');

    // Unit-level contract for the scanner itself. The legacy container line is captured as an
    // informational reference, and a markdown image line polluted by leaked markup resolves through
    // its ULID instead of being reported as a missing asset.
    const scanned = scanArticleMediaDetailed(body);
    expect(scanned.normalRefs).toEqual([]);
    expect(scanned.informationalRefs).toContain(
      '/_emdash/api/media/file/01M67MEDIA0000000000000KK.jpg',
    );

    // A markdown image line polluted by leaked markup is absorbed by the optional title group and
    // therefore never captured as a reference at all: the real asset resolves through its ULID, so
    // the line must not produce a missing-media warning either way.
    const pollutedOnly = scanArticleMediaDetailed(
      '![broken](/_emdash/api/media/file/01M67MEDIA0000000000000LL.jpg" control=true)\n',
    );
    expect(pollutedOnly.normalRefs).toEqual([]);
    expect(pollutedOnly.invalidRefs).toEqual([]);

    // A capture with no ULID at all is genuine garbage and must be reported as malformed
    const garbage = scanArticleMediaDetailed('![x](/_emdash/api/media/file/placeholder-key.png)\n');
    expect(garbage.invalidRefs).toContain('/_emdash/api/media/file/placeholder-key.png');
  });

  const writeLegacyArticle = (slug: string, key: string): void => {
    const draftDir = path.join(tempDir, 'posts', 'draft');
    fs.mkdirSync(draftDir, { recursive: true });
    const frontmatter: Frontmatter = {
      id: articleId,
      slug,
      title: 'Legacy File Route Article',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const body = `![legacy](/_emdash/api/media/file/${key})\n`;
    fs.writeFileSync(
      path.join(draftDir, `20210620_${articleId}-${slug}.md`),
      serializeMarkdown(frontmatter, body),
      'utf8',
    );
  };

  it('reports a legacy file-route-only asset as missing when doctor runs offline (C-1)', async () => {
    writeLegacyArticle('legacy-offline', '01M67LEGACYX0000000000000D.jpg');

    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config: loadConfig(tempDir),
    });
    const mCheck = report.checks.find((c) => c.id === 'media_references');
    expect(mCheck?.status).toBe('warning');
    expect(JSON.stringify(mCheck?.details ?? '')).toContain('01M67LEGACYX0000000000000D.jpg');
  });

  it('downgrades a legacy asset that the remote file route still serves to an ok note (C-2)', async () => {
    writeLegacyArticle('legacy-online', '01M67LEGACYX0000000000000E.jpg');

    const fetchCalls: string[] = [];
    const fetchFn = async (url: string | URL) => {
      fetchCalls.push(String(url));
      return new Response(null, { status: 200 });
    };

    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config: loadConfig(tempDir),
      profileOrigin: 'https://aroooy.net',
      checkMediaUrls: true,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const mCheck = report.checks.find((c) => c.id === 'media_references');
    expect(fetchCalls).toContain(
      'https://aroooy.net/_emdash/api/media/file/01M67LEGACYX0000000000000E.jpg',
    );
    expect(mCheck?.status).toBe('ok');
    // A file-route hit proves only that the R2 object is served; the note must never claim the media
    // record is absent, because the probe addresses the storageKey and not the primary key.
    expect(mCheck?.message).toContain(
      'served by the remote file route that no local mirror or record lookup matched',
    );
    expect(mCheck?.message ?? '').not.toContain('without a media record');
    expect(JSON.stringify(mCheck?.details ?? '')).toContain(
      'served by the file route but matched by no local mirror or record lookup',
    );
  });

  it('keeps reporting a reference as missing when the remote file route also fails (C-3)', async () => {
    writeLegacyArticle('legacy-dead', '01M67LEGACYX0000000000000F.jpg');

    const fetchFn = async () => new Response(null, { status: 404 });

    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config: loadConfig(tempDir),
      profileOrigin: 'https://aroooy.net',
      checkMediaUrls: true,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const mCheck = report.checks.find((c) => c.id === 'media_references');
    expect(mCheck?.status).toBe('warning');
    expect(JSON.stringify(mCheck?.details ?? '')).toContain('01M67LEGACYX0000000000000F.jpg');
    // The suggestion must demand storageKey-based verification before any write, and must never imply
    // that a missing record has been proven or instruct a blind INSERT.
    expect(mCheck?.suggestion).toContain('admin UI');
    expect(mCheck?.suggestion).toContain('wrangler d1 SELECT');
    expect(mCheck?.suggestion).toContain('blind INSERT can duplicate an existing record');
    expect(mCheck?.suggestion).toContain('never repairs server data');
    expect(mCheck?.suggestion ?? '').not.toContain('pull-media');
  });

  it('reports a leftover legacy_* mirror as missing because Emit no longer recognizes it (C-4)', async () => {
    // The removed file-route fallback wrote media/legacy_<storageKey> pairs that never backed a real
    // media record. A leftover pair must not silently satisfy the reference: doctor still reports it
    // so the user can fix the missing record on EmDash and delete the residue. Recognition used to
    // go through a `legacy_` stem in the known-storageKey set; that recognition is gone, so neither
    // the YAML storageKey field nor the mirrored binary file may resolve the reference anymore.
    writeLegacyArticle('legacy-residue', '01M67LEGACYX0000000000000H.jpg');
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'legacy_01M67LEGACYX0000000000000H.jpg'), 'legacy bytes');
    fs.writeFileSync(
      path.join(mediaDir, 'legacy_01M67LEGACYX0000000000000H.yaml'),
      [
        'id: null',
        'filename: legacy_01M67LEGACYX0000000000000H.jpg',
        'storageKey: 01M67LEGACYX0000000000000H.jpg',
        'synthesized: true',
        'source: direct-file-route',
        '',
      ].join('\n'),
      'utf8',
    );

    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config: loadConfig(tempDir),
    });
    const mCheck = report.checks.find((c) => c.id === 'media_references');
    expect(mCheck?.status).toBe('warning');
    expect(JSON.stringify(mCheck?.details ?? '')).toContain('01M67LEGACYX0000000000000H.jpg');
  });

  it('resolves a body storageKey that differs from the media record id (C-6)', async () => {
    // Two distinct ID spaces, and they are not interchangeable: `GET /_emdash/api/media/{id}` keys on
    // the D1 primary key while the body URL carries the storageKey. A migrated WordPress import can
    // store a record whose storageKey ULID is NOT its record id, so such an asset must resolve
    // through its canonical companion YAML (or media_state), never by guessing the first ULID segment
    // of the body URL. Doctor must stay silent here: the reference is genuinely satisfied.
    const draftDir = path.join(tempDir, 'posts', 'draft');
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(draftDir, { recursive: true });
    fs.mkdirSync(mediaDir, { recursive: true });

    writeLegacyArticle('mixed-id-space', '01M67STRGKEYX0000000123456.jpg');
    fs.writeFileSync(
      path.join(mediaDir, '20210620_01M67ARTCLEDXY000000012345-wp-import-photo.jpg'),
      'binary',
      'utf8',
    );
    fs.writeFileSync(
      path.join(mediaDir, '20210620_01M67ARTCLEDXY000000012345-wp-import-photo.yaml'),
      [
        'id: 01M67ARTCLEDXY000000012345',
        'filename: wp-import-photo.jpg',
        'storageKey: 01M67STRGKEYX0000000123456.jpg',
        'mimeType: image/jpeg',
        '',
      ].join('\n'),
      'utf8',
    );

    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config: loadConfig(tempDir),
    });
    const mCheck = report.checks.find((c) => c.id === 'media_references');
    expect(mCheck?.status).toBe('ok');
    expect(JSON.stringify(mCheck?.details ?? '')).not.toContain('01M67STRGKEYX0000000123456.jpg');
  });

  it('collects real legacy workspace storageKeys from migrated article bodies (C-5)', async () => {
    const wsRoot = '/Volumes/ext/github/emdash.aroooy.net';
    if (!fs.existsSync(wsRoot)) return; // only runs on the developer machine that mirrors the live site

    const body = fs.readFileSync(
      path.join(
        wsRoot,
        'posts/published/20210620_01M67N0ZG3F9N0WH6D30EA3J5A-GoPro-Maxを一年くらい使ってみての雑なレビュー.md',
      ),
      'utf8',
    );
    const keys = collectArticleStorageKeys(body);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(keys.map((k) => k.storageKey)).toEqual([
      '01M67NT2GZ9NRA7RS6PZ8D0VMQ.jpg',
      '01M67NT2SM005Z6EZ32D7SR899.jpg',
    ]);
  });

  // --- v0.1.14 Specific Test Cases (R5) ---

  it('T5-1: detects taxonomy_apply_pending = 1 with remote check suggestion', async () => {
    const art = setupHealthyArticle();
    cache.setTaxonomyApplyPending(articleId, true);

    const config = loadConfig(tempDir);
    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config,
    });

    const check = report.checks.find((c) => c.id === 'taxonomy_apply_pending');
    expect(check).toBeDefined();
    expect(check?.status).toBe('warning');
    expect(check?.message).toContain('unapplied taxonomy terms');
    expect(check?.suggestion).toContain('verify the terms exist on remote');
    expect(check?.suggestion).toContain('permission errors');
  });

  it('T5-2: detects delete_pending = 1 with cleanup and revive suggestions', async () => {
    const art = setupHealthyArticle();
    cache.setDeletePending(articleId, true);

    const config = loadConfig(tempDir);
    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config,
    });

    const check = report.checks.find((c) => c.id === 'delete_pending');
    expect(check).toBeDefined();
    expect(check?.status).toBe('warning');
    expect(check?.message).toContain('marked as delete_pending');
    expect(check?.suggestion).toContain('emit delete');
    expect(check?.suggestion).toContain('--revive');
  });

  it('T5-3: auto-clears taxonomy pending by kind when rescue copy is removed manually and no divergence exists', async () => {
    const art = setupHealthyArticle();
    // Initially pending taxonomy conflict
    cache.setConflictPending(articleId, 'taxonomy', true);

    const beforeState = cache.getSyncState(articleId);
    expect(beforeState?.taxonomyConflictPending).toBe(1);
    expect(beforeState?.conflictPending).toBe(1);

    const config = loadConfig(tempDir);
    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config,
    });

    const autoclearCheck = report.checks.find((c) => c.id === 'conflict_pending_autoclear');
    expect(autoclearCheck).toBeDefined();
    expect(autoclearCheck?.status).toBe('ok');

    const afterState = cache.getSyncState(articleId);
    expect(afterState?.taxonomyConflictPending).toBe(0);
    expect(afterState?.conflictPending).toBe(0);
  });
});
