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
import os from 'node:os';
import path from 'node:path';
import { CacheDatabase } from '../src/db/cache.js';
import { createBaseSnapshot, retrackLocalHashOnly } from '../src/db/baseline.js';
import { reconstructBaseline, isLocalFileUnmodified } from '../src/sync/baseline-reconstruction.js';
import { getWorkspaceStatus } from '../src/sync/status.js';
import { inspectArticleDiff } from '../src/sync/diff.js';
import { runWorkspaceDoctor } from '../src/sync/doctor.js';
import { deleteArticle } from '../src/sync/delete.js';
import { pullBatch } from '../src/sync/orchestrator.js';
import { resolveConflict } from '../src/sync/conflicts.js';
import { pullArticle } from '../src/sync/pull/index.js';
import { quarantineDivergentLocalCopies } from '../src/sync/pull/quarantine.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';
import { DEFAULT_CONFIG } from '../src/utils/config.js';
import { calculateHash } from '../src/sync/workspace/index.js';

const ARTICLE_ID = '01M6ABCDEF1234567890123456';
const MEDIA_RECORD_ID = '01M67PG2WTXPEJVMS4W5N3FC48';
const STORAGE_KEY_STEM = '01M67P2N0A44G4KHK6QZZGMRW7';
const STORAGE_KEY = `${STORAGE_KEY_STEM}.webp`;
const CANONICAL_URL = `/_emdash/api/media/file/${STORAGE_KEY}`;
const LOCAL_REF = `../../../media/${STORAGE_KEY}`;

describe('Baseline Reconstruction & Sync-State-Only Hash Retracking (v0.1.27 P1/P2)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-baseline-reconstruct-'));
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function setupLocalizedArticleWithStaleCanonicalHash(): {
    relPath: string;
    fullPath: string;
    canonicalBytes: string;
    localizedBytes: string;
    staleHash: string;
    localizedHash: string;
  } {
    // 1. Seed local media mirror under media/
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, STORAGE_KEY), 'fake-webp-bytes');
    fs.writeFileSync(
      path.join(mediaDir, `${STORAGE_KEY_STEM}.yaml`),
      [
        `id: "${MEDIA_RECORD_ID}"`,
        `filename: "${STORAGE_KEY}"`,
        `storageKey: "${STORAGE_KEY}"`,
        'mimeType: "image/webp"',
      ].join('\n'),
      'utf8',
    );

    // 2. Build canonical baseline and localized disk article
    const frontmatter: Frontmatter = {
      id: ARTICLE_ID,
      slug: 'localized-article',
      title: 'Localized Article',
      collection: 'posts',
      status: 'draft',
      publishedAt: null,
      locale: 'ja',
      featuredImage: null,
      taxonomies: {},
      bylines: ['aroooy'],
    };
    const canonicalBody = `Intro paragraph.\n\n![Sample Image](${CANONICAL_URL})\n`;
    const localizedBody = `Intro paragraph.\n\n![Sample Image](${LOCAL_REF})\n`;

    const canonicalBytes = serializeMarkdown(frontmatter, canonicalBody);
    const localizedBytes = serializeMarkdown(frontmatter, localizedBody);
    const staleHash = calculateHash(canonicalBytes);
    const localizedHash = calculateHash(localizedBytes);

    const relPath = `posts/ja/draft/20261115_${ARTICLE_ID}-Localized-Article.md`;
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, localizedBytes, 'utf8');

    cache.saveBaseSnapshot(
      createBaseSnapshot({
        id: ARTICLE_ID,
        rev: 'rev_transport_1',
        bodyMarkdown: canonicalBody,
        frontmatter,
        hash: staleHash,
        savedAt: 1700000000,
      }),
    );

    // Deliberately record stale canonical hash in sync_state.local_hash
    cache.saveSyncState({
      id: ARTICLE_ID,
      localFilePath: relPath,
      localHash: staleHash,
      remoteRev: '1@draft:01REV',
      status: 'draft',
      slug: 'localized-article',
      lastSyncedAt: 1700000000,
      conflictPending: 0,
      bodyConflictPending: 0,
      taxonomyConflictPending: 0,
    });

    return { relPath, fullPath, canonicalBytes, localizedBytes, staleHash, localizedHash };
  }

  it('retrackLocalHashOnly updates sync_state.local_hash while keeping base_snapshots untouched and returning null for untracked IDs', () => {
    // 1. Untracked ID returns null (no-op)
    expect(
      retrackLocalHashOnly(cache, {
        id: '01UNTRACKED000000000000000',
        diskContent: 'hello',
      }),
    ).toBeNull();

    // 2. Tracked article updates only local_hash, preserving base_snapshots and sync_state flags
    const { staleHash, localizedBytes, localizedHash } =
      setupLocalizedArticleWithStaleCanonicalHash();
    const beforeBase = cache.getBaseSnapshot(ARTICLE_ID)!;
    const beforeSync = cache.getSyncState(ARTICLE_ID)!;
    expect(beforeSync.localHash).toBe(staleHash);

    const res = retrackLocalHashOnly(cache, {
      id: ARTICLE_ID,
      diskContent: localizedBytes,
      touchSyncedAt: false,
    });

    expect(res).toEqual({ localHash: localizedHash });

    const afterBase = cache.getBaseSnapshot(ARTICLE_ID)!;
    expect(afterBase).toEqual(beforeBase); // base_snapshots is 100% untouched

    const afterSync = cache.getSyncState(ARTICLE_ID)!;
    expect(afterSync.localHash).toBe(localizedHash);
    expect(afterSync.remoteRev).toBe('1@draft:01REV');
    expect(afterSync.lastSyncedAt).toBe(1700000000);
  });

  it('inspectArticleDiff called BEFORE getWorkspaceStatus reports synced (🟢 In Sync) and heals local_hash when only media ref spelling differs (Discovery 1)', () => {
    const { staleHash, localizedHash } = setupLocalizedArticleWithStaleCanonicalHash();
    expect(cache.getSyncState(ARTICLE_ID)!.localHash).toBe(staleHash);

    // Call inspectArticleDiff FIRST (before getWorkspaceStatus has a chance to heal local_hash)
    const diffRes = inspectArticleDiff({
      workspaceRoot: tempDir,
      cache,
      id: ARTICLE_ID,
    });

    expect(diffRes.ok).toBe(true);
    expect(diffRes.diff?.hasChanges).toBe(false);
    // Must NOT self-contradict with status: 'modified' or '🟡 Modified'
    expect(diffRes.status).toBe('synced');
    expect(diffRes.formattedOutput).toContain('🟢 In Sync with base snapshot');
    expect(diffRes.formattedOutput).not.toContain('🟡 Modified');

    // And sync_state.local_hash is healed to match the localized bytes on disk
    expect(cache.getSyncState(ARTICLE_ID)!.localHash).toBe(localizedHash);
  });

  it('runWorkspaceDoctor and deleteArticle(dryRun) called BEFORE getWorkspaceStatus do not misclassify spelling-only differences as unpushed divergence (Discovery 2)', async () => {
    const { relPath, staleHash, localizedHash } = setupLocalizedArticleWithStaleCanonicalHash();

    // Mark stale taxonomyConflictPending=1 with no conflict copy so doctor's divergence check is directly exercised
    cache.saveSyncState({
      ...cache.getSyncState(ARTICLE_ID)!,
      localHash: staleHash,
      conflictPending: 1,
      taxonomyConflictPending: 1,
    });

    // 1. Run doctor BEFORE status: must recognize spelling match as non-diverged and auto-clear stale flag + heal hash
    const doctorRes = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config: DEFAULT_CONFIG,
    });
    const autoClearCheck = doctorRes.checks.find((c) => c.id === 'conflict_pending_autoclear');
    expect(autoClearCheck?.status).toBe('ok');
    expect(cache.getSyncState(ARTICLE_ID)!.localHash).toBe(localizedHash);

    // 2. Reset localHash back to staleHash and test deleteArticle(dryRun) BEFORE status
    cache.saveSyncState({
      ...cache.getSyncState(ARTICLE_ID)!,
      localHash: staleHash,
      conflictPending: 0,
      taxonomyConflictPending: 0,
    });

    const delRes = await deleteArticle({
      workspaceRoot: tempDir,
      cache,
      filePath: relPath,
      dryRun: true,
    });
    expect(delRes.success).toBe(true);
    expect(delRes.dryRun).toBe(true);
    expect(cache.getSyncState(ARTICLE_ID)!.localHash).toBe(localizedHash);

    // 3. Status agrees 100%
    const statusRes = getWorkspaceStatus(tempDir, cache, 'posts');
    expect(statusRes.summary.synced).toBe(1);
    expect(statusRes.summary.modified).toBe(0);
  });

  it('inspectArticleDiff returns status: "modified" for synthetic fixture where base_snapshots exists but sync_state is null (§5 #1 ③)', () => {
    const { relPath, localizedBytes, staleHash } = setupLocalizedArticleWithStaleCanonicalHash();

    // Remove sync_state while keeping base_snapshots (synthetic boundary fixture)
    cache.deleteSyncState(ARTICLE_ID);
    expect(cache.getSyncState(ARTICLE_ID)).toBeNull();
    expect(cache.getBaseSnapshot(ARTICLE_ID)?.hash).toBe(staleHash);

    // Verify reconstructBaseline still matches disk
    const reconstructed = reconstructBaseline({
      workspaceRoot: tempDir,
      snapshot: cache.getBaseSnapshot(ARTICLE_ID)!,
      localContent: localizedBytes,
      relPath,
      syncState: null,
    });
    expect(reconstructed.matchesDisk).toBe(true);

    // Because syncState is null, isLocalFileUnmodified is false and inspectArticleDiff preserves status: 'modified'
    expect(
      isLocalFileUnmodified({
        workspaceRoot: tempDir,
        cache,
        id: ARTICLE_ID,
        relPath,
        localContent: localizedBytes,
        syncState: null,
      }),
    ).toBe(false);

    const diffRes = inspectArticleDiff({
      workspaceRoot: tempDir,
      cache,
      filePath: relPath,
    });
    expect(diffRes.ok).toBe(true);
    expect(diffRes.status).toBe('modified');
  });

  it('H1-① pullBatch prune guard does not throw SyncPruneConflictError when a window-out article only differs by media ref spelling', async () => {
    const { fullPath, staleHash } = setupLocalizedArticleWithStaleCanonicalHash();
    expect(cache.getSyncState(ARTICLE_ID)!.localHash).toBe(staleHash);

    const fetchFn: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/bylines')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      // Return empty remote list so ARTICLE_ID is outside the sync window and becomes a prune candidate
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };

    const batchRes = await pullBatch({
      workspaceRoot: tempDir,
      cache,
      collection: 'posts',
      origin: 'https://example.com',
      token: 'token',
      prune: true,
      mediaSync: false,
      fetchFn,
    });

    expect(batchRes.deleted).toBe(1);
    expect(fs.existsSync(fullPath)).toBe(false);
    expect(cache.getSyncState(ARTICLE_ID)).toBeNull();
  });

  it('H1-② resolveConflict(accept-local) does not throw CanonicalHasUnpushedEditsError when canonical file only differs by media ref spelling', () => {
    const { localizedBytes, staleHash } = setupLocalizedArticleWithStaleCanonicalHash();

    // Create a quarantined conflict copy under posts/conflicts/
    const conflictRelPath = `posts/conflicts/20261115_${ARTICLE_ID}-Localized-Article.20261115100000.conflict.md`;
    const conflictFullPath = path.join(tempDir, conflictRelPath);
    fs.mkdirSync(path.dirname(conflictFullPath), { recursive: true });
    fs.writeFileSync(conflictFullPath, localizedBytes, 'utf8');

    cache.saveSyncState({
      ...cache.getSyncState(ARTICLE_ID)!,
      localHash: staleHash,
      conflictPending: 1,
      bodyConflictPending: 1,
      taxonomyConflictPending: 0,
      conflictCopyPath: conflictRelPath,
    });

    const res = resolveConflict({
      workspaceRoot: tempDir,
      cache,
      filePath: conflictRelPath,
      strategy: 'accept-local',
    });
    expect(res.success).toBe(true);
    expect(res.strategy).toBe('accept-local');
    expect(cache.getSyncState(ARTICLE_ID)?.bodyConflictPending).toBe(0);
  });

  it('H1-③ quarantineDivergentLocalCopies skips quarantining a local copy when only media ref spelling differs from baseline', () => {
    const { relPath, staleHash } = setupLocalizedArticleWithStaleCanonicalHash();
    const existingSync = cache.getSyncState(ARTICLE_ID)!;
    expect(existingSync.localHash).toBe(staleHash);

    // Create a duplicate ULID file with the same localized bytes (whose raw hash !== staleHash, but matches reconstructed baseline)
    const dupRelPath = `posts/ja/draft/20261115_${ARTICLE_ID}-Old-Title.md`;
    const dupFullPath = path.join(tempDir, dupRelPath);
    const localizedContent = fs.readFileSync(path.join(tempDir, relPath), 'utf8');
    fs.writeFileSync(dupFullPath, localizedContent, 'utf8');

    const quarantined = quarantineDivergentLocalCopies(
      {
        workspaceRoot: tempDir,
        cache,
        origin: 'https://example.com',
        token: 'token',
      },
      'posts',
      new Set([dupRelPath]),
      staleHash,
      'incoming-new-remote-content',
      null,
      existingSync,
    );

    expect(quarantined).toEqual([]);
  });

  it('H1-④ pullArticle 404 remote deletion cleans up local file (deleted: true) instead of setting deletePending when only media ref spelling differs', async () => {
    const { fullPath, staleHash } = setupLocalizedArticleWithStaleCanonicalHash();
    expect(cache.getSyncState(ARTICLE_ID)!.localHash).toBe(staleHash);

    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });

    const res = await pullArticle('posts', ARTICLE_ID, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'token',
      fetchFn,
    });

    expect(res.deleted).toBe(true);
    expect(res.localEditsPreserved).toBeUndefined();
    expect(fs.existsSync(fullPath)).toBe(false);
    expect(cache.getSyncState(ARTICLE_ID)).toBeNull();
  });

  it('H1-⑤ pullArticle tryFastPathOrHeal heals local_hash on skip when remote is unchanged and applies remote update (not localEditsPreserved) when remote advances', async () => {
    const { relPath, fullPath, staleHash, localizedHash } =
      setupLocalizedArticleWithStaleCanonicalHash();
    expect(cache.getSyncState(ARTICLE_ID)!.localHash).toBe(staleHash);

    // (a) Same remote rev ('1@draft:01REV'): skips and heals local_hash to localizedHash via retrackLocalHashOnly
    const sameRawItem = {
      id: ARTICLE_ID,
      slug: 'localized-article',
      title: 'Localized Article',
      status: 'draft',
      version: 1,
      draftRevisionId: '01REV',
      _rev: 'rev_transport_1',
      data: {
        title: 'Localized Article',
        content: [
          {
            _type: 'block',
            style: 'normal',
            children: [{ _type: 'span', text: 'Intro paragraph.' }],
          },
          {
            _type: 'image',
            alt: 'Sample Image',
            asset: { url: CANONICAL_URL, storageKey: STORAGE_KEY },
          },
        ],
      },
    };

    const skipRes = await pullArticle('posts', ARTICLE_ID, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'token',
      rawItem: sameRawItem,
      localMediaRefs: true,
    });

    expect(skipRes.skipped).toBe(true);
    expect(skipRes.updated).toBe(false);
    expect(skipRes.localEditsPreserved).toBeUndefined();
    expect(cache.getSyncState(ARTICLE_ID)!.localHash).toBe(localizedHash);

    // (b) Reset localHash back to staleHash and advance remote rev ('2@draft:01REV2'):
    // must NOT misclassify as localEditsPreserved; must fall through to full pull and update disk
    cache.saveSyncState({
      ...cache.getSyncState(ARTICLE_ID)!,
      localHash: staleHash,
    });

    const updatedRawItem = {
      ...sameRawItem,
      version: 2,
      draftRevisionId: '01REV2',
      _rev: 'rev_transport_2',
      data: {
        title: 'Localized Article',
        content: [
          {
            _type: 'block',
            style: 'normal',
            children: [{ _type: 'span', text: 'Updated remote paragraph.' }],
          },
          {
            _type: 'image',
            alt: 'Sample Image',
            asset: { url: CANONICAL_URL, storageKey: STORAGE_KEY },
          },
        ],
      },
    };

    const fetchFn: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes(`/posts/${ARTICLE_ID}/terms`)) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      return new Response(JSON.stringify(updatedRawItem), { status: 200 });
    };

    const updateRes = await pullArticle('posts', ARTICLE_ID, {
      workspaceRoot: tempDir,
      cache,
      origin: 'https://example.com',
      token: 'token',
      rawItem: updatedRawItem,
      localMediaRefs: true,
      fetchFn,
    });

    expect(updateRes.updated).toBe(true);
    expect(updateRes.skipped).toBeUndefined();
    expect(updateRes.localEditsPreserved).toBeUndefined();
    expect(updateRes.filePath).toBe(relPath);
    const updatedDisk = fs.readFileSync(fullPath, 'utf8');
    expect(updatedDisk).toContain('Updated remote paragraph.');
    expect(updatedDisk).toContain(`![Sample Image](${LOCAL_REF})`);
  });
});
