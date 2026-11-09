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
import { initWorkspace } from '../src/utils/config.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';
import { calculateHash } from '../src/sync/pull.js';
import {
  listConflicts,
  diffConflict,
  resolveConflict,
  pruneConflicts,
  extractBaseArticleName,
  CanonicalHasUnpushedEditsError,
  QuarantinedPathRequiredError,
} from '../src/sync/conflicts.js';

describe('Conflict Management & Resolution (emit conflicts / sync_conflicts)', () => {
  let tempDir: string;
  let cache: CacheDatabase;
  const articleId = '01M67CONFLICT0000000000001';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-conflicts-test-'));
    initWorkspace(tempDir, { origin: 'https://aroooy.net' });
    const dbPath = path.join(tempDir, '.emit', 'cache.db');
    cache = new CacheDatabase(dbPath);
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function setupArticleFixture() {
    const frontmatter: Frontmatter = {
      id: articleId,
      slug: 'sample-conflict-article',
      title: 'Sample Canonical Title',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      taxonomies: { categories: ['tech'] },
      bylines: [],
    };
    const body = 'Canonical Line 1\nCanonical Line 2\n';
    const canonicalContent = serializeMarkdown(frontmatter, body);
    const relCanonical = path.join(
      'posts',
      'draft',
      `20261108_${articleId}-sample-conflict-article.md`,
    );
    const fullCanonical = path.join(tempDir, relCanonical);
    fs.mkdirSync(path.dirname(fullCanonical), { recursive: true });
    fs.writeFileSync(fullCanonical, canonicalContent, 'utf8');

    const hash = calculateHash(canonicalContent);
    cache.saveSyncState({
      id: articleId,
      localFilePath: relCanonical,
      localHash: hash,
      remoteRev: 'rev-1',
      status: 'draft',
      slug: 'sample-conflict-article',
      lastSyncedAt: 1700000000,
    });

    return { relCanonical, fullCanonical, canonicalContent };
  }

  it('extractBaseArticleName strips suffixes accurately', () => {
    expect(extractBaseArticleName('20261108_01M6...-slug.conflict.md')).toBe(
      '20261108_01M6...-slug',
    );
    expect(extractBaseArticleName('20261108_01M6...-slug.deleted.md')).toBe(
      '20261108_01M6...-slug',
    );
    expect(extractBaseArticleName('20261108_01M6...-slug.md')).toBe('20261108_01M6...-slug');
    expect(extractBaseArticleName('simple')).toBe('simple');
  });

  it('lists both .conflict.md and .deleted.md files with metadata and canonical detection', () => {
    const { relCanonical } = setupArticleFixture();
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    fs.mkdirSync(conflictsDir, { recursive: true });

    // 1. Create a .conflict.md file
    const conflictFm: Frontmatter = {
      id: articleId,
      slug: 'sample-conflict-article',
      title: 'Diverged Conflict Title',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const conflictContent = serializeMarkdown(conflictFm, 'Local Diverged Content\n');
    const conflictFileName = `20261108_${articleId}-sample-conflict-article.conflict.md`;
    fs.writeFileSync(path.join(conflictsDir, conflictFileName), conflictContent, 'utf8');

    // 2. Create a .deleted.md rescue file (where canonical does not exist)
    const deletedId = '01M67DELETE000000000000099';
    const deletedFm: Frontmatter = {
      id: deletedId,
      slug: 'deleted-rescue-article',
      title: 'Deleted Title',
      collection: 'posts',
      status: 'published',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const deletedContent = serializeMarkdown(deletedFm, 'Rescue Body Content\n');
    const deletedFileName = `20261108_${deletedId}-deleted-rescue-article.deleted.md`;
    fs.writeFileSync(path.join(conflictsDir, deletedFileName), deletedContent, 'utf8');

    // 3. Create a .local-dropped.md rescue file from pull --force
    const droppedId = '01M67DROPPED00000000000001';
    const droppedFm: Frontmatter = {
      id: droppedId,
      slug: 'forced-dropped-article',
      title: 'Dropped Title',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const droppedContent = serializeMarkdown(droppedFm, 'Dropped Body Content\n');
    const droppedFileName = `20261108_${droppedId}-forced-dropped-article.local-dropped.md`;
    fs.writeFileSync(path.join(conflictsDir, droppedFileName), droppedContent, 'utf8');

    const list = listConflicts(tempDir);
    expect(list).toHaveLength(3);

    const conflictItem = list.find((i) => i.type === 'conflict');
    expect(conflictItem).toBeDefined();
    expect(conflictItem?.fileName).toBe(conflictFileName);
    expect(conflictItem?.title).toBe('Diverged Conflict Title');
    expect(conflictItem?.canonicalPath).toBe(relCanonical);

    const deletedItem = list.find((i) => i.type === 'deleted');
    expect(deletedItem).toBeDefined();
    expect(deletedItem?.fileName).toBe(deletedFileName);
    expect(deletedItem?.title).toBe('Deleted Title');
    expect(deletedItem?.canonicalPath).toBeNull();

    const droppedItem = list.find((i) => i.type === 'dropped');
    expect(droppedItem).toBeDefined();
    expect(droppedItem?.fileName).toBe(droppedFileName);
    expect(droppedItem?.title).toBe('Dropped Title');
  });

  it('computes line-by-line diff against canonical article', () => {
    setupArticleFixture();
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    fs.mkdirSync(conflictsDir, { recursive: true });

    const conflictFm: Frontmatter = {
      id: articleId,
      slug: 'sample-conflict-article',
      title: 'Diverged Conflict Title',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const conflictContent = serializeMarkdown(conflictFm, 'Local Diverged Line\n');
    const conflictFileName = `20261108_${articleId}-sample-conflict-article.conflict.md`;
    fs.writeFileSync(path.join(conflictsDir, conflictFileName), conflictContent, 'utf8');

    const diffRes = diffConflict({
      workspaceRoot: tempDir,
      filePath: conflictFileName,
    });

    expect(diffRes.hasDifferences).toBe(true);
    expect(diffRes.canonicalFilePath).toContain('sample-conflict-article.md');
    expect(diffRes.diffText).toContain('--- canonical:');
    expect(diffRes.diffText).toContain('+++ quarantined:');
  });

  it('resolves conflict using accept-canonical by discarding quarantined file', () => {
    const { fullCanonical } = setupArticleFixture();
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    fs.mkdirSync(conflictsDir, { recursive: true });

    const conflictFileName = `20261108_${articleId}-sample-conflict-article.conflict.md`;
    const conflictFullPath = path.join(conflictsDir, conflictFileName);
    fs.writeFileSync(conflictFullPath, 'Diverged Content\n', 'utf8');

    const res = resolveConflict({
      workspaceRoot: tempDir,
      cache,
      filePath: conflictFileName,
      strategy: 'accept-canonical',
    });

    expect(res.success).toBe(true);
    expect(res.strategy).toBe('accept-canonical');
    expect(fs.existsSync(conflictFullPath)).toBe(false);
    expect(fs.existsSync(fullCanonical)).toBe(true);
  });

  it('resolves conflict using accept-local by overwriting canonical file and updating cache', () => {
    const { fullCanonical } = setupArticleFixture();
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    fs.mkdirSync(conflictsDir, { recursive: true });

    const conflictFm: Frontmatter = {
      id: articleId,
      slug: 'sample-conflict-article',
      title: 'Accepted Local Title',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const conflictContent = serializeMarkdown(conflictFm, 'Accepted Local Body\n');
    const conflictFileName = `20261108_${articleId}-sample-conflict-article.conflict.md`;
    const conflictFullPath = path.join(conflictsDir, conflictFileName);
    fs.writeFileSync(conflictFullPath, conflictContent, 'utf8');

    const res = resolveConflict({
      workspaceRoot: tempDir,
      cache,
      filePath: conflictFileName,
      strategy: 'accept-local',
    });

    expect(res.success).toBe(true);
    expect(res.strategy).toBe('accept-local');
    expect(fs.existsSync(conflictFullPath)).toBe(false);
    expect(fs.readFileSync(fullCanonical, 'utf8')).toBe(conflictContent);

    // Cache sync state hash must match the new local content
    const updatedSync = cache.getSyncState(articleId);
    expect(updatedSync?.localHash).toBe(calculateHash(conflictContent));
  });

  it('resolves .deleted.md rescue copy by restoring to draft/published directory', () => {
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    fs.mkdirSync(conflictsDir, { recursive: true });

    const rescueId = '01M67RESTORE00000000000001';
    const rescueFm: Frontmatter = {
      id: rescueId,
      slug: 'restored-deleted-post',
      title: 'Restored Post Title',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const rescueContent = serializeMarkdown(rescueFm, 'Restored Body\n');
    const rescueFileName = `20261108_${rescueId}-restored-deleted-post.deleted.md`;
    const rescueFullPath = path.join(conflictsDir, rescueFileName);
    fs.writeFileSync(rescueFullPath, rescueContent, 'utf8');

    const res = resolveConflict({
      workspaceRoot: tempDir,
      cache,
      filePath: rescueFileName,
      strategy: 'accept-local',
    });

    expect(res.success).toBe(true);
    expect(fs.existsSync(rescueFullPath)).toBe(false);

    const expectedRestored = path.join(
      tempDir,
      'posts',
      'draft',
      `20261108_${rescueId}-restored-deleted-post.md`,
    );
    expect(fs.existsSync(expectedRestored)).toBe(true);
    expect(fs.readFileSync(expectedRestored, 'utf8')).toBe(rescueContent);
  });

  it('rejects accept-local when canonical article has unpushed modifications (Major 1)', () => {
    const { fullCanonical } = setupArticleFixture();
    // Simulate unpushed local edit on canonical article
    fs.appendFileSync(fullCanonical, '\nNew unpushed paragraph on canonical\n', 'utf8');

    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    fs.mkdirSync(conflictsDir, { recursive: true });
    const conflictFileName = `20261108_${articleId}-sample-conflict-article.conflict.md`;
    fs.writeFileSync(path.join(conflictsDir, conflictFileName), 'Quarantined Content\n', 'utf8');

    expect(() =>
      resolveConflict({
        workspaceRoot: tempDir,
        cache,
        filePath: conflictFileName,
        strategy: 'accept-local',
      }),
    ).toThrowError(CanonicalHasUnpushedEditsError);
  });

  it('allows accept-local when canonical article has unpushed modifications if force: true is supplied (Major 1)', () => {
    const { fullCanonical } = setupArticleFixture();
    fs.appendFileSync(fullCanonical, '\nNew unpushed paragraph on canonical\n', 'utf8');

    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    fs.mkdirSync(conflictsDir, { recursive: true });
    const conflictFileName = `20261108_${articleId}-sample-conflict-article.conflict.md`;
    const conflictContent = 'Forced Quarantined Content\n';
    fs.writeFileSync(path.join(conflictsDir, conflictFileName), conflictContent, 'utf8');

    const res = resolveConflict({
      workspaceRoot: tempDir,
      cache,
      filePath: conflictFileName,
      strategy: 'accept-local',
      force: true,
    });

    expect(res.success).toBe(true);
    expect(fs.readFileSync(fullCanonical, 'utf8')).toBe(conflictContent);
  });

  it('rejects resolving files outside posts/conflicts/ (Minor A)', () => {
    const { relCanonical } = setupArticleFixture();

    expect(() =>
      resolveConflict({
        workspaceRoot: tempDir,
        cache,
        filePath: relCanonical,
        strategy: 'accept-local',
      }),
    ).toThrowError(QuarantinedPathRequiredError);
  });

  it('attaches warning when restoring .deleted.md copy without valid ULID (Minor B)', () => {
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    fs.mkdirSync(conflictsDir, { recursive: true });

    const corruptedDeletedFile = '20261108_corrupted-article.deleted.md';
    fs.writeFileSync(
      path.join(conflictsDir, corruptedDeletedFile),
      '---\nslug: corrupted-post\n---\nbody\n',
      'utf8',
    );

    const res = resolveConflict({
      workspaceRoot: tempDir,
      cache,
      filePath: corruptedDeletedFile,
      strategy: 'accept-local',
    });

    expect(res.success).toBe(true);
    expect(res.warnings).toBeDefined();
    expect(res.warnings?.[0]).toContain('no valid ULID');
  });

  it('pruneConflicts cleans up eligible files while guarding canonical edits and orphan rescues (acceptance condition 7)', () => {
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    fs.mkdirSync(conflictsDir, { recursive: true });

    // 1. Conflict copy with canonical article that has unpushed edits
    const { fullCanonical } = setupArticleFixture();
    fs.appendFileSync(fullCanonical, '\nNew unpushed paragraph');
    const conflictFileName = `20261108_${articleId}-sample-conflict-article.conflict.md`;
    const fullConflict = path.join(conflictsDir, conflictFileName);
    fs.writeFileSync(fullConflict, 'Quarantined Content\n', 'utf8');
    const relConflict = `posts/conflicts/${conflictFileName}`;

    // 2. Orphan rescue copy (.deleted.md) without canonical article
    const orphanFile = '20261108_01M67ORPHANRESCUE000000001-deleted.deleted.md';
    const orphanFull = path.join(conflictsDir, orphanFile);
    fs.writeFileSync(orphanFull, '---\nid: 01M67ORPHANRESCUE000000001\n---\nOrphan body');

    // 3. Normal conflict copy whose canonical article has NO unpushed edits
    const cleanId = '01M67CLEANARTICLE0000000001';
    const cleanCanonicalRel = `posts/draft/20261109_${cleanId}-clean.md`;
    const cleanCanonicalFull = path.join(tempDir, cleanCanonicalRel);
    const cleanContent = `---\nid: ${cleanId}\nslug: clean\ntitle: Clean\nstatus: draft\nlocale: ja\n---\nClean body\n`;
    fs.writeFileSync(cleanCanonicalFull, cleanContent);
    const cleanHash = calculateHash(cleanContent);
    cache.saveSyncState({
      id: cleanId,
      localFilePath: cleanCanonicalRel,
      localHash: cleanHash,
      remoteRev: '1',
      status: 'draft',
      slug: 'clean',
      lastSyncedAt: 1000,
    });
    const cleanConflictFile = `20261109_${cleanId}-clean.conflict.md`;
    const cleanConflictFull = path.join(conflictsDir, cleanConflictFile);
    fs.writeFileSync(cleanConflictFull, cleanContent);

    // Initial prune without allowOrphanRescues
    const res1 = pruneConflicts({
      workspaceRoot: tempDir,
      cache,
    });

    // Clean conflict copy should be pruned
    expect(res1.pruned).toContain(`posts/conflicts/${cleanConflictFile}`);
    expect(fs.existsSync(cleanConflictFull)).toBe(false);

    // Conflict with unpushed canonical edits must be skipped
    expect(res1.skipped.some((s) => s.filePath === relConflict)).toBe(true);
    expect(fs.existsSync(fullConflict)).toBe(true);

    // Orphan rescue without allowOrphanRescues must be skipped
    expect(res1.skipped.some((s) => s.filePath === `posts/conflicts/${orphanFile}`)).toBe(true);
    expect(fs.existsSync(orphanFull)).toBe(true);

    // Second prune with allowOrphanRescues
    const res2 = pruneConflicts({
      workspaceRoot: tempDir,
      cache,
      allowOrphanRescues: true,
    });
    expect(res2.pruned).toContain(`posts/conflicts/${orphanFile}`);
    expect(fs.existsSync(orphanFull)).toBe(false);
  });

  it('T4-2: resolveConflict accept-canonical clears cache conflict pending flag and metadata', () => {
    const { relCanonical } = setupArticleFixture();
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    fs.mkdirSync(conflictsDir, { recursive: true });

    const conflictFileName = `20261108_${articleId}-sample-conflict-article.conflict.md`;
    const fullConflict = path.join(conflictsDir, conflictFileName);
    const relConflict = `posts/conflicts/${conflictFileName}`;
    fs.writeFileSync(
      fullConflict,
      `---\nid: ${articleId}\nslug: sample-conflict-article\n---\nQuarantined\n`,
      'utf8',
    );

    // Set conflict pending in cache
    cache.setConflictPending(articleId, 'body', true, 'somehash', relConflict);
    const before = cache.getSyncState(articleId);
    expect(before?.conflictPending).toBe(1);
    expect(before?.bodyConflictPending).toBe(1);
    expect(before?.conflictCopyPath).toBe(relConflict);

    // Resolve with accept-canonical
    const res = resolveConflict({
      workspaceRoot: tempDir,
      cache,
      filePath: relConflict,
      strategy: 'accept-canonical',
    });

    expect(res.success).toBe(true);
    expect(fs.existsSync(fullConflict)).toBe(false);

    // Cache should have conflict pending and copy path cleared
    const after = cache.getSyncState(articleId);
    expect(after?.conflictPending).toBe(0);
    expect(after?.bodyConflictPending).toBe(0);
    expect(after?.conflictCopyPath).toBeNull();
  });

  it('T4-2b: resolveConflict accept-canonical extracts ULID from filename fallback when frontmatter is missing in quarantined file and clears cache', () => {
    const { relCanonical } = setupArticleFixture();
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    fs.mkdirSync(conflictsDir, { recursive: true });

    // Quarantined file has NO frontmatter at all (corrupted or body-only)
    const conflictFileName = `20261108_${articleId}-sample-conflict-article.conflict.md`;
    const fullConflict = path.join(conflictsDir, conflictFileName);
    const relConflict = `posts/conflicts/${conflictFileName}`;
    fs.writeFileSync(fullConflict, 'Just raw corrupted body without any frontmatter\n', 'utf8');

    // Set conflict pending in cache
    cache.setConflictPending(articleId, 'body', true, 'somehash', relConflict);
    const before = cache.getSyncState(articleId);
    expect(before?.conflictPending).toBe(1);
    expect(before?.bodyConflictPending).toBe(1);
    expect(before?.conflictCopyPath).toBe(relConflict);

    // Resolve with accept-canonical
    const res = resolveConflict({
      workspaceRoot: tempDir,
      cache,
      filePath: relConflict,
      strategy: 'accept-canonical',
    });

    expect(res.success).toBe(true);
    expect(fs.existsSync(fullConflict)).toBe(false);

    // Cache should have conflict pending and copy path cleared via filename ULID fallback
    const after = cache.getSyncState(articleId);
    expect(after?.conflictPending).toBe(0);
    expect(after?.bodyConflictPending).toBe(0);
    expect(after?.conflictCopyPath).toBeNull();
  });

  it('T4-3: resolveConflict accept-local explicitly clears all conflict flags and copy columns', () => {
    const { fullCanonical, relCanonical } = setupArticleFixture();
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    fs.mkdirSync(conflictsDir, { recursive: true });

    const conflictFileName = `20261108_${articleId}-sample-conflict-article.conflict.md`;
    const fullConflict = path.join(conflictsDir, conflictFileName);
    const relConflict = `posts/conflicts/${conflictFileName}`;
    const restoredContent = `---\nid: ${articleId}\nslug: sample-conflict-article\ntitle: Sample Canonical Title\nstatus: draft\nlocale: ja\ntaxonomies:\n  categories: [tech]\nbylines: []\n---\nRestored from local\n`;
    fs.writeFileSync(fullConflict, restoredContent, 'utf8');

    cache.setConflictPending(articleId, 'body', true, 'somehash', relConflict);

    const res = resolveConflict({
      workspaceRoot: tempDir,
      cache,
      filePath: relConflict,
      strategy: 'accept-local',
    });

    expect(res.success).toBe(true);
    expect(fs.existsSync(fullConflict)).toBe(false);

    const after = cache.getSyncState(articleId);
    expect(after?.conflictPending).toBe(0);
    expect(after?.bodyConflictPending).toBe(0);
    expect(after?.taxonomyConflictPending).toBe(0);
    expect(after?.conflictCopyPath).toBeNull();
    expect(after?.conflictCopyHash).toBeNull();
    expect(after?.conflictAt).toBeNull();
  });

  it('T3-6: observing accept-canonical effect on local conflict state and confirming escape behavior', () => {
    const { relCanonical } = setupArticleFixture();
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    fs.mkdirSync(conflictsDir, { recursive: true });

    const conflictFileName = `20261108_${articleId}-sample-conflict-article.conflict.md`;
    const fullConflict = path.join(conflictsDir, conflictFileName);
    const relConflict = `posts/conflicts/${conflictFileName}`;
    fs.writeFileSync(
      fullConflict,
      `---\nid: ${articleId}\nslug: sample-conflict-article\n---\nQuarantined\n`,
      'utf8',
    );

    cache.setConflictPending(articleId, 'body', true, 'somehash', relConflict);

    // Accept canonical clears the quarantined copy and cache state
    resolveConflict({
      workspaceRoot: tempDir,
      cache,
      filePath: relConflict,
      strategy: 'accept-canonical',
    });

    const state = cache.getSyncState(articleId);
    expect(state?.conflictPending).toBe(0);
    // Quarantined copy is removed
    expect(fs.existsSync(fullConflict)).toBe(false);
  });
});
