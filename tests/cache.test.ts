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
import { getPackageVersion } from '../src/utils/version.js';
import {
  CacheDatabase,
  CURRENT_CACHE_SCHEMA_VERSION,
  type BaseSnapshot,
  type CachedEntry,
  type SyncState,
} from '../src/db/cache.js';
import { asMediaRecordId, asStorageKey } from '../src/utils/media-id.js';

describe('SQLite CacheDatabase (node:sqlite)', () => {
  let tempDir: string;
  let dbPath: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-cache-test-'));
    dbPath = path.join(tempDir, '.emit', 'cache.db');
    cache = new CacheDatabase(dbPath);
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('initializes sqlite database file and directories', () => {
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('saves and retrieves entries with upsert support', () => {
    const entry: CachedEntry = {
      id: '01M67MP2W0VKCK2DFWM166CR24',
      collection: 'posts',
      slug: 'hello-world',
      status: 'draft',
      title: 'Hello World',
      rev: 'rev_123',
      publishedAt: null,
      rawJson: JSON.stringify({ body: 'content' }),
      updatedAt: 1730550000,
    };

    cache.saveEntry(entry);
    const retrieved = cache.getEntry(entry.id);
    expect(retrieved).toEqual(entry);

    // Update (upsert)
    const updated: CachedEntry = {
      ...entry,
      title: 'Hello World Updated',
      status: 'published',
      rev: 'rev_124',
    };
    cache.saveEntry(updated);
    const retrievedUpdated = cache.getEntry(entry.id);
    expect(retrievedUpdated?.title).toBe('Hello World Updated');
    expect(retrievedUpdated?.status).toBe('published');
    expect(retrievedUpdated?.rev).toBe('rev_124');

    // List entries
    const list = cache.listEntries('posts');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(entry.id);
  });

  it('saves and retrieves base snapshots for 3-way merge', () => {
    const snapshot: BaseSnapshot = {
      id: '01M67MP2W0VKCK2DFWM166CR24',
      rev: 'rev_base_1',
      bodyMarkdown: '# Base Content\n\nOriginal text.',
      frontmatterYaml: 'title: Base Title\nstatus: draft',
      hash: 'sha256_hash_abc',
      savedAt: 1730550100,
    };

    cache.saveBaseSnapshot(snapshot);
    const retrieved = cache.getBaseSnapshot(snapshot.id);
    expect(retrieved).toEqual(snapshot);
  });

  it('tracks sync state and path mappings', () => {
    const state: SyncState = {
      id: '01M67MP2W0VKCK2DFWM166CR24',
      localFilePath: 'posts/ja/draft/01M67MP2W0VKCK2DFWM166CR24-my-post.md',
      localHash: 'hash_local_123',
      remoteRev: 'rev_remote_456',
      status: 'draft',
      slug: 'my-post',
      lastSyncedAt: 1730550200,
      conflictPending: 0,
      bodyConflictPending: 0,
      taxonomyConflictPending: 0,
      deletePending: 0,
      conflictCopyHash: null,
      conflictCopyPath: null,
      conflictAt: null,
      remoteTaxonomyHash: null,
      taxonomyApplyPending: 0,
    };

    cache.saveSyncState(state);

    const byId = cache.getSyncState(state.id);
    expect(byId).toEqual(state);

    const byPath = cache.getSyncStateByPath(state.localFilePath);
    expect(byPath).toEqual(state);

    // Path lookup for non-existing path returns null
    expect(cache.getSyncStateByPath('posts/ja/draft/non-existing.md')).toBeNull();

    // Delete
    cache.deleteSyncState(state.id);
    expect(cache.getSyncState(state.id)).toBeNull();
  });

  it('tracks media_state records for local draft upload idempotency and orphan recovery', () => {
    const localHash = 'a'.repeat(64);
    const initialKey = asStorageKey('01M6TF1XXBSC06QQG9M648B4K3.png');
    const confirmedKey = asStorageKey('01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png');

    cache.saveMediaState({
      localHash,
      mediaId: asMediaRecordId('01M6TF1XXBS2KC9EVYG6RBT0J0'),
      storageKey: initialKey,
      url: `/_emdash/api/media/file/${initialKey}`,
      status: 'pending',
      uploadedAt: 1730550300,
    });

    const pending = cache.getMediaStateByContentHash(localHash);
    expect(pending?.status).toBe('pending');
    expect(pending?.mediaId).toBe('01M6TF1XXBS2KC9EVYG6RBT0J0');

    // Confirm transition in v5: old pending storageKey is purged, new confirmed storageKey is saved
    cache.deleteMediaState(initialKey);
    cache.saveMediaState({
      localHash,
      mediaId: asMediaRecordId('01M6TF1XXBS2KC9EVYG6RBT0J0'),
      storageKey: confirmedKey,
      url: `/_emdash/api/media/file/${confirmedKey}`,
      workspacePath: 'media/20261107_01M6TF1XXBS2KC9EVYG6RBT0J0-spike.png',
      status: 'ready',
      uploadedAt: 1730550310,
    });

    const ready = cache.getMediaStateByMediaId('01M6TF1XXBS2KC9EVYG6RBT0J0');
    expect(ready?.status).toBe('ready');
    expect(ready?.storageKey).toBe(confirmedKey);
    expect(ready?.workspacePath).toBe('media/20261107_01M6TF1XXBS2KC9EVYG6RBT0J0-spike.png');

    expect(cache.listMediaStates('ready')).toHaveLength(1);
    expect(cache.listMediaStates('pending')).toHaveLength(0);

    cache.deleteMediaState(confirmedKey);
    expect(cache.getMediaState(confirmedKey)).toBeNull();
    expect(cache.getMediaStateByContentHash(localHash)).toBeNull();
  });

  it('keeps workspace_path when a later media_state upsert omits it (R-5)', () => {
    const localHash = 'b'.repeat(64);
    const key = asStorageKey('01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png');
    cache.saveMediaState({
      localHash,
      mediaId: asMediaRecordId('01M6TF1XXBS2KC9EVYG6RBT0J0'),
      storageKey: asStorageKey(key),
      url: `/_emdash/api/media/file/${key}`,
      workspacePath: 'media/20261107_01M6TF1XXBS2KC9EVYG6RBT0J0-spike.png',
      status: 'ready',
      uploadedAt: 1730550310,
    });

    // A subsequent upsert (e.g. a deduplicated upload) provides no promoted path:
    // the previously promoted location must survive so findAlreadyPromotedMedia()
    // can still resolve the asset from media_state.
    cache.saveMediaState({
      localHash,
      mediaId: asMediaRecordId('01M6TF1XXBS2KC9EVYG6RBT0J0'),
      storageKey: asStorageKey(key),
      url: `/_emdash/api/media/file/${key}`,
      status: 'uploaded',
      uploadedAt: 1730550400,
    });

    const row = cache.getMediaStateByContentHash(localHash);
    expect(row?.status).toBe('uploaded');
    expect(row?.workspacePath).toBe('media/20261107_01M6TF1XXBS2KC9EVYG6RBT0J0-spike.png');

    // An explicit null does not wipe the promoted path either (COALESCE semantics):
    // clearing a media_state row is always done via deleteMediaState(), never via upsert.
    cache.saveMediaState({
      localHash,
      mediaId: asMediaRecordId('01M6TF1XXBS2KC9EVYG6RBT0J0'),
      storageKey: asStorageKey(key),
      url: `/_emdash/api/media/file/${key}`,
      workspacePath: null,
      status: 'uploaded',
    });
    expect(cache.getMediaStateByContentHash(localHash)?.workspacePath).toBe(
      'media/20261107_01M6TF1XXBS2KC9EVYG6RBT0J0-spike.png',
    );

    cache.deleteMediaState(key);
    expect(cache.getMediaState(key)).toBeNull();
  });

  it('records markdown_ref and resolves a mirror through the storage_key index', () => {
    const localHash = 'c'.repeat(64);
    const storageKey = asStorageKey('uploads/2026/11/sample.png');
    cache.saveMediaState({
      localHash,
      mediaId: asMediaRecordId('01M6TF1XXBS2KC9EVYG6RBT0J0'),
      storageKey,
      url: `/_emdash/api/media/file/${storageKey}`,
      workspacePath: 'media/sample.png',
      markdownRef: 'media/sample',
      status: 'ready',
      uploadedAt: 1730550500,
    });

    // A body URL carries the storageKey, so the index is what turns it into a mirror path without any
    // filename parsing. The COALESCE upsert keeps markdown_ref across a later status-only write.
    const byKey = cache.getMediaStateByStorageKey(storageKey);
    expect(byKey?.markdownRef).toBe('media/sample');
    expect(byKey?.workspacePath).toBe('media/sample.png');

    cache.saveMediaState({
      localHash,
      mediaId: asMediaRecordId('01M6TF1XXBS2KC9EVYG6RBT0J0'),
      storageKey,
      url: `/_emdash/api/media/file/${storageKey}`,
      status: 'uploaded',
      uploadedAt: 1730550600,
    });
    expect(cache.getMediaStateByContentHash(localHash)?.markdownRef).toBe('media/sample');

    // A record written without a mirror yet reports null rather than a fabricated path.
    cache.saveMediaState({
      localHash: 'd'.repeat(64),
      mediaId: asMediaRecordId('01M6TF1XXBS2KC9EVYG6RBT0J1'),
      storageKey: asStorageKey('pending-upload.png'),
      url: '/_emdash/api/media/file/pending-upload.png',
      status: 'pending',
    });
    expect(cache.getMediaStateByStorageKey('pending-upload.png')?.markdownRef).toBeNull();
  });

  it('runs schema migration 0 -> 1 on legacy database and creates atomic backup', () => {
    cache.close();

    // Create a legacy v0 database manually
    const legacyDbPath = path.join(tempDir, '.emit', 'legacy.db');
    const { DatabaseSync } = require('node:sqlite');
    const rawDb = new DatabaseSync(legacyDbPath);
    rawDb.exec('PRAGMA journal_mode = WAL;');
    rawDb.exec(`
      CREATE TABLE sync_state (
        id TEXT PRIMARY KEY,
        local_file_path TEXT NOT NULL,
        local_hash TEXT NOT NULL,
        remote_rev TEXT NOT NULL,
        status TEXT NOT NULL,
        slug TEXT NOT NULL,
        last_synced_at INTEGER NOT NULL
      );
      INSERT INTO sync_state VALUES ('test-id', 'posts/ja/draft/test.md', 'hash1', '1', 'draft', 'test', 12345);
      PRAGMA user_version = 0;
    `);
    rawDb.close();

    // Opening with CacheDatabase triggers migration to version 1
    const migratedCache = new CacheDatabase(legacyDbPath);
    expect(migratedCache.getSchemaVersion()).toBe(CURRENT_CACHE_SCHEMA_VERSION);

    // Verify backup was created (timestamped bak file)
    const dbDir = path.dirname(legacyDbPath);
    const dbBase = path.basename(legacyDbPath);
    const bakFiles = fs.readdirSync(dbDir).filter((f) => f.startsWith(`${dbBase}.bak-`));
    expect(bakFiles.length).toBeGreaterThan(0);

    // Verify existing data is preserved and new columns are accessible
    const state = migratedCache.getSyncState('test-id');
    expect(state).not.toBeNull();
    expect(state?.id).toBe('test-id');
    expect(state?.conflictPending).toBe(0);
    expect(state?.deletePending).toBe(0);
    expect(state?.conflictCopyHash).toBeNull();
    expect(state?.remoteTaxonomyHash).toBeNull();
    expect(state?.taxonomyApplyPending).toBe(0);

    // Update with new columns
    migratedCache.setConflictPending('test-id', 'all', true, 'copyhash123');
    const updated = migratedCache.getSyncState('test-id');
    expect(updated?.conflictPending).toBe(1);
    expect(updated?.conflictCopyHash).toBe('copyhash123');

    migratedCache.close();
  });

  it('rejects database created by newer schema version (future schema guard)', () => {
    cache.close();
    const futureDbPath = path.join(tempDir, '.emit', 'future.db');
    const { DatabaseSync } = require('node:sqlite');
    const rawDb = new DatabaseSync(futureDbPath);
    rawDb.exec('PRAGMA user_version = 999;');
    rawDb.close();

    expect(() => new CacheDatabase(futureDbPath)).toThrow(/\[CACHE_SCHEMA_MISMATCH\]/);
  });

  // --- v0.1.14 Specific Test Cases (R4, R6) ---

  it('T4-1: saveSyncState clears conflict copy columns when both body and taxonomy conflict pendings are 0', () => {
    const id = '01M67TESTT41000000000000000';
    // Initially set conflict pending and copy metadata
    cache.saveSyncState({
      id,
      localFilePath: 'posts/ja/draft/test.md',
      localHash: 'hash1',
      remoteRev: '1',
      status: 'draft',
      slug: 'test',
      lastSyncedAt: 1000,
      conflictPending: 1,
      bodyConflictPending: 1,
      taxonomyConflictPending: 0,
      conflictCopyPath: 'posts/conflicts/test.conflict.md',
      conflictCopyHash: 'copyhash',
      conflictAt: 1000,
    });

    const before = cache.getSyncState(id);
    expect(before?.conflictCopyPath).toBe('posts/conflicts/test.conflict.md');

    // Save with pending = 0
    cache.saveSyncState({
      id,
      localFilePath: 'posts/ja/draft/test.md',
      localHash: 'hash2',
      remoteRev: '2',
      status: 'draft',
      slug: 'test',
      lastSyncedAt: 2000,
      conflictPending: 0,
      bodyConflictPending: 0,
      taxonomyConflictPending: 0,
    });

    const after = cache.getSyncState(id);
    expect(after?.conflictPending).toBe(0);
    expect(after?.bodyConflictPending).toBe(0);
    expect(after?.taxonomyConflictPending).toBe(0);
    expect(after?.conflictCopyPath).toBeNull();
    expect(after?.conflictCopyHash).toBeNull();
    expect(after?.conflictAt).toBeNull();
  });

  it('T4-4: maintains 3-value set consistency for conflict copy metadata columns', () => {
    const id = '01M67TESTT44000000000000000';
    cache.saveSyncState({
      id,
      localFilePath: 'posts/ja/draft/test.md',
      localHash: 'hash1',
      remoteRev: '1',
      status: 'draft',
      slug: 'test',
      lastSyncedAt: 1000,
    });

    cache.setConflictPending(id, 'body', true, 'hash123', 'posts/conflicts/t.conflict.md');
    const state = cache.getSyncState(id);
    expect(state?.conflictCopyPath).toBe('posts/conflicts/t.conflict.md');
    expect(state?.conflictCopyHash).toBe('hash123');
    expect(state?.conflictAt).toBeGreaterThan(0);

    // Clear by kind
    cache.clearConflictsByKind(id, 'body');
    const cleared = cache.getSyncState(id);
    expect(cleared?.conflictCopyPath).toBeNull();
    expect(cleared?.conflictCopyHash).toBeNull();
    expect(cleared?.conflictAt).toBeNull();
  });

  it('T4-5: schema v2 to v3 migration allocates existing conflict rows accurately', () => {
    const v2DbPath = path.join(tempDir, '.emit', 'v2.db');
    const { DatabaseSync } = require('node:sqlite');
    const rawDb = new DatabaseSync(v2DbPath);
    rawDb.exec(`
      CREATE TABLE sync_state (
        id TEXT PRIMARY KEY,
        local_file_path TEXT NOT NULL,
        local_hash TEXT NOT NULL,
        remote_rev TEXT NOT NULL,
        status TEXT NOT NULL,
        slug TEXT NOT NULL,
        last_synced_at INTEGER NOT NULL,
        conflict_pending INTEGER DEFAULT 0,
        delete_pending INTEGER DEFAULT 0,
        conflict_copy_hash TEXT,
        conflict_copy_path TEXT,
        conflict_at INTEGER,
        remote_taxonomy_hash TEXT,
        taxonomy_apply_pending INTEGER DEFAULT 0
      );
      -- Row 1: has conflict_copy_path ending in .conflict.md (body conflict)
      INSERT INTO sync_state VALUES ('id-body', 'posts/ja/draft/b.md', 'h1', '1', 'draft', 'b', 1000, 1, 0, 'h', 'posts/conflicts/b.conflict.md', 1000, NULL, 0);
      -- Row 2: conflict_pending = 1 but no copy path and has remote_taxonomy_hash (taxonomy conflict)
      INSERT INTO sync_state VALUES ('id-tax', 'posts/ja/draft/t.md', 'h2', '1', 'draft', 't', 1000, 1, 0, NULL, NULL, NULL, 'taxhash', 0);
      -- Row 3: normal clean row
      INSERT INTO sync_state VALUES ('id-clean', 'posts/ja/draft/c.md', 'h3', '1', 'draft', 'c', 1000, 0, 0, NULL, NULL, NULL, NULL, 0);
      PRAGMA user_version = 2;
    `);
    rawDb.close();

    const migrated = new CacheDatabase(v2DbPath);
    expect(migrated.getSchemaVersion()).toBe(CURRENT_CACHE_SCHEMA_VERSION);

    const rowBody = migrated.getSyncState('id-body');
    expect(rowBody?.bodyConflictPending).toBe(1);
    expect(rowBody?.taxonomyConflictPending).toBe(0);
    expect(rowBody?.conflictPending).toBe(1);

    const rowTax = migrated.getSyncState('id-tax');
    expect(rowTax?.bodyConflictPending).toBe(0);
    expect(rowTax?.taxonomyConflictPending).toBe(1);
    expect(rowTax?.conflictPending).toBe(1);

    const rowClean = migrated.getSyncState('id-clean');
    expect(rowClean?.bodyConflictPending).toBe(0);
    expect(rowClean?.taxonomyConflictPending).toBe(0);
    expect(rowClean?.conflictPending).toBe(0);

    migrated.close();
  });

  it('T6-1 & T6-4: VACUUM INTO backup creates valid SQLite DB containing sync_state and version in filename', () => {
    const freshDbPath = path.join(tempDir, '.emit', 'fresh.db');
    const { DatabaseSync } = require('node:sqlite');
    const rawDb = new DatabaseSync(freshDbPath);
    rawDb.exec(`
      CREATE TABLE sync_state (
        id TEXT PRIMARY KEY,
        local_file_path TEXT NOT NULL,
        local_hash TEXT NOT NULL,
        remote_rev TEXT NOT NULL,
        status TEXT NOT NULL,
        slug TEXT NOT NULL,
        last_synced_at INTEGER NOT NULL
      );
      PRAGMA user_version = 0;
    `);
    rawDb.close();

    const db = new CacheDatabase(freshDbPath);
    expect(db.getSchemaVersion()).toBe(CURRENT_CACHE_SCHEMA_VERSION);
    db.close();

    const dbDir = path.dirname(freshDbPath);
    const dbBase = path.basename(freshDbPath);
    const bakFiles = fs.readdirSync(dbDir).filter((f) => f.startsWith(`${dbBase}.bak-`));
    expect(bakFiles.length).toBe(1);

    // T6-4: Filename contains package.json version
    expect(bakFiles[0]).toContain(`.bak-${getPackageVersion()}-`);

    // T6-1: Verify backup is valid SQLite with sync_state table
    const bakFull = path.join(dbDir, bakFiles[0]);
    const bakRaw = new DatabaseSync(bakFull);
    const tbl = bakRaw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_state'")
      .get();
    expect(tbl).toBeDefined();
    bakRaw.close();
  });

  it('T6-3: pruneBackups sweeps 0-byte backup files unconditionally', () => {
    const sweepDbPath = path.join(tempDir, '.emit', 'sweep.db');
    const dbDir = path.dirname(sweepDbPath);
    fs.mkdirSync(dbDir, { recursive: true });

    // Plant 0-byte backup files
    const zeroBak1 = path.join(dbDir, 'sweep.db.bak-0.1.14-001');
    const zeroBak2 = path.join(dbDir, 'sweep.db.bak-0.1.14-002');
    fs.writeFileSync(zeroBak1, '');
    fs.writeFileSync(zeroBak2, '');

    expect(fs.existsSync(zeroBak1)).toBe(true);
    expect(fs.existsSync(zeroBak2)).toBe(true);

    // Initializing CacheDatabase triggers runMigrations and pruneBackups
    const db = new CacheDatabase(sweepDbPath);
    db.close();

    // 0-byte backups must be swept
    expect(fs.existsSync(zeroBak1)).toBe(false);
    expect(fs.existsSync(zeroBak2)).toBe(false);
  });

  it('migrates schema v4 to v5, separating local_content_hash and remote_record_ref with storage_key as PK', () => {
    cache.close();
    const v4DbPath = path.join(tempDir, '.emit', 'v4.db');
    const { DatabaseSync } = require('node:sqlite');
    const rawDb = new DatabaseSync(v4DbPath);
    rawDb.exec('PRAGMA journal_mode = WAL;');
    rawDb.exec(`
      CREATE TABLE sync_state (
        id TEXT PRIMARY KEY,
        local_file_path TEXT NOT NULL,
        local_hash TEXT NOT NULL,
        remote_rev TEXT NOT NULL,
        status TEXT NOT NULL,
        slug TEXT NOT NULL,
        last_synced_at INTEGER NOT NULL
      );
      CREATE TABLE media_state (
        local_hash TEXT PRIMARY KEY,
        media_id TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        url TEXT NOT NULL,
        workspace_path TEXT,
        markdown_ref TEXT,
        status TEXT NOT NULL,
        uploaded_at INTEGER
      );
      -- Row 1: local draft image with SHA-256 hash
      INSERT INTO media_state VALUES (
        '1111111111111111111111111111111111111111111111111111111111111111',
        '01M6MEDIA00000000000000001',
        'key1.png',
        '/_emdash/api/media/file/key1.png',
        'media/key1.png',
        'media/key1',
        'ready',
        1730000001
      );
      -- Row 2: remote mirrored item with 'media-record:<id>'
      INSERT INTO media_state VALUES (
        'media-record:01M6MEDIA00000000000000002',
        '01M6MEDIA00000000000000002',
        'key2.jpg',
        '/_emdash/api/media/file/key2.jpg',
        'media/key2.jpg',
        'media/key2',
        'ready',
        1730000002
      );
      -- Row 3 & 4: duplicate storage_key (one local draft upload hash + one remote mirror record)
      INSERT INTO media_state VALUES (
        '3333333333333333333333333333333333333333333333333333333333333333',
        '01M6MEDIA00000000000000003',
        'shared.png',
        '/_emdash/api/media/file/shared.png',
        'media/shared.png',
        'media/shared',
        'ready',
        1730000003
      );
      INSERT INTO media_state VALUES (
        'media-record:01M6MEDIA00000000000000003',
        '01M6MEDIA00000000000000003',
        'shared.png',
        '/_emdash/api/media/file/shared.png',
        'media/shared.png',
        'media/shared',
        'ready',
        1730000004
      );
      PRAGMA user_version = 4;
    `);
    rawDb.close();

    const migrated = new CacheDatabase(v4DbPath);
    expect(migrated.getSchemaVersion()).toBe(CURRENT_CACHE_SCHEMA_VERSION);

    // Verify Row 1: local_content_hash separated
    const row1 = migrated.getMediaStateByStorageKey('key1.png');
    expect(row1).not.toBeNull();
    expect(row1?.localContentHash).toBe(
      '1111111111111111111111111111111111111111111111111111111111111111',
    );
    expect(row1?.remoteRecordRef).toBeNull();
    expect(row1?.mediaId).toBe('01M6MEDIA00000000000000001');

    // Verify Row 2: remote_record_ref separated
    const row2 = migrated.getMediaStateByStorageKey('key2.jpg');
    expect(row2).not.toBeNull();
    expect(row2?.localContentHash).toBeNull();
    expect(row2?.remoteRecordRef).toBe('media-record:01M6MEDIA00000000000000002');
    expect(row2?.mediaId).toBe('01M6MEDIA00000000000000002');

    // Verify Row 3 & 4: consolidated by storage_key with both hashes preserved
    const row3 = migrated.getMediaStateByStorageKey('shared.png');
    expect(row3).not.toBeNull();
    expect(row3?.localContentHash).toBe(
      '3333333333333333333333333333333333333333333333333333333333333333',
    );
    expect(row3?.remoteRecordRef).toBe('media-record:01M6MEDIA00000000000000003');
    expect(row3?.uploadedAt).toBe(1730000004);

    // Total unique storage_keys preserved (exactly 3)
    expect(migrated.listMediaStates()).toHaveLength(3);

    migrated.close();
  });

  it('v0.1.47 Phase 1: initializes fresh DB directly at current schema (v9) with snapshot tables', () => {
    expect(cache.getSchemaVersion()).toBe(9);
    expect(cache.getSnapshotMeta('posts')).toBeNull();
    expect(cache.listSnapshotArticles('posts')).toEqual([]);
    expect(cache.listSnapshotMedia()).toEqual([]);
  });

  it('v0.1.47 Phase 1: migrates Schema v5 DB to v6 without disturbing existing tables', () => {
    const v5DbPath = path.join(tempDir, '.emit', 'v5.db');
    const { DatabaseSync } = require('node:sqlite');
    const rawDb = new DatabaseSync(v5DbPath);
    rawDb.exec(`
      CREATE TABLE entries (id TEXT PRIMARY KEY, collection TEXT NOT NULL, slug TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, rev TEXT NOT NULL, published_at TEXT, raw_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE base_snapshots (id TEXT PRIMARY KEY, rev TEXT NOT NULL, body_markdown TEXT NOT NULL, frontmatter_yaml TEXT NOT NULL, hash TEXT NOT NULL, saved_at INTEGER NOT NULL);
      CREATE TABLE sync_state (id TEXT PRIMARY KEY, local_file_path TEXT NOT NULL, local_hash TEXT NOT NULL, remote_rev TEXT NOT NULL, status TEXT NOT NULL, slug TEXT NOT NULL, last_synced_at INTEGER NOT NULL, conflict_pending INTEGER NOT NULL DEFAULT 0, body_conflict_pending INTEGER NOT NULL DEFAULT 0, taxonomy_conflict_pending INTEGER NOT NULL DEFAULT 0, delete_pending INTEGER NOT NULL DEFAULT 0, conflict_copy_hash TEXT, conflict_copy_path TEXT, conflict_at INTEGER, remote_taxonomy_hash TEXT, taxonomy_apply_pending INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE bylines (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, is_guest INTEGER NOT NULL DEFAULT 0, raw_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL);
      CREATE TABLE media_state (storage_key TEXT PRIMARY KEY, media_id TEXT NOT NULL, local_content_hash TEXT, remote_record_ref TEXT, url TEXT NOT NULL, workspace_path TEXT, markdown_ref TEXT, status TEXT NOT NULL, uploaded_at INTEGER);
      INSERT INTO sync_state (id, local_file_path, local_hash, remote_rev, status, slug, last_synced_at)
      VALUES ('01M6KEEP000000000000000001', 'posts/ja/published/keep.md', 'h1', '1', 'published', 'keep', 1730000000);
      PRAGMA user_version = 5;
    `);
    rawDb.close();

    const migrated = new CacheDatabase(v5DbPath);
    expect(migrated.getSchemaVersion()).toBe(9);
    expect(migrated.getSyncState('01M6KEEP000000000000000001')?.slug).toBe('keep');
    expect(migrated.getSnapshotMeta('posts')).toBeNull();
    migrated.close();
  });

  it('lists snapshot_media newest-first (created_at DESC) so budgeted cache picks newest assets', () => {
    const ts1 = 1730000000000;
    // Insert deliberately oldest-first to prove the query orders, not insertion order.
    cache.upsertSnapshotMediaBatch({
      walkComplete: true,
      records: [
        {
          mediaId: '01M6OLD0000000000000000001',
          storageKey: '01M6OLD0000000000000000001.jpg',
          filename: 'ancient-2013.jpg',
          mimeType: 'image/jpeg',
          size: 10,
          alt: null,
          caption: null,
          createdAt: '2013-01-01T00:00:00.000Z',
          capturedAt: ts1,
        },
        {
          mediaId: '01M6MED0000000000000000002',
          storageKey: '01M6MED0000000000000000002.jpg',
          filename: 'recent.jpg',
          mimeType: 'image/jpeg',
          size: 20,
          alt: null,
          caption: null,
          createdAt: '2026-11-20T00:00:00.000Z',
          capturedAt: ts1,
        },
        {
          mediaId: '01M6NEW0000000000000000003',
          storageKey: '01M6NEW0000000000000000003.jpg',
          filename: 'newest.png',
          mimeType: 'image/png',
          size: 30,
          alt: null,
          caption: null,
          createdAt: '2026-11-24T00:00:00.000Z',
          capturedAt: ts1,
        },
        {
          mediaId: '01M6NULL0000000000000000004',
          storageKey: '01M6NULL0000000000000000004.jpg',
          filename: 'migrated-no-meta.jpg',
          mimeType: 'image/jpeg',
          size: 40,
          alt: null,
          caption: null,
          createdAt: null,
          capturedAt: ts1,
        },
      ],
    });

    const listed = cache.listSnapshotMedia();
    expect(listed.map((r) => r.mediaId)).toEqual([
      '01M6NEW0000000000000000003',
      '01M6MED0000000000000000002',
      '01M6OLD0000000000000000001',
      // NULL created_at sorts last in DESC — unknown-age migrated records fall
      // to the back of the budget instead of masquerading as newest.
      '01M6NULL0000000000000000004',
    ]);
    cache.close();
  });

  it('v0.1.47 Phase 1: upserts snapshot articles/media (including null storageKey) and prunes only when walkComplete is true', () => {
    const ts1 = 1730000000000;
    const res1 = cache.upsertSnapshotArticlesBatch({
      collection: 'posts',
      walkComplete: true,
      records: [
        {
          id: '01M6ART0000000000000000001',
          collection: 'posts',
          slug: 'first',
          title: 'First Post',
          status: 'published',
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
          publishedAt: '2026-11-01T00:00:00.000Z',
          comparisonRev: '1@live:01M6REV1',
          excerpt: 'First excerpt',
          bodyMarkdown: 'Hello first body',
          bodySource: 'list-live',
          categoriesJson: '["tech"]',
          tagsJson: '["ai"]',
          taxonomyVerified: 1,
          capturedAt: ts1,
        },
        {
          id: '01M6ART0000000000000000002',
          collection: 'posts',
          slug: 'second',
          title: 'Second Post',
          status: 'draft',
          createdAt: '2026-11-02T00:00:00.000Z',
          updatedAt: '2026-11-02T00:00:00.000Z',
          publishedAt: null,
          comparisonRev: '1@draft:01M6REV2',
          excerpt: null,
          bodyMarkdown: 'Second draft body',
          bodySource: 'single-get',
          categoriesJson: '[]',
          tagsJson: '[]',
          taxonomyVerified: 1,
          capturedAt: ts1,
        },
      ],
    });
    expect(res1).toEqual({ upserted: 2, pruned: 0 });

    // Partial walk (walkComplete: false) must NOT prune existing records
    const partialRes = cache.upsertSnapshotArticlesBatch({
      collection: 'posts',
      walkComplete: false,
      records: [cache.getSnapshotArticle('01M6ART0000000000000000001')!],
    });
    expect(partialRes).toEqual({ upserted: 1, pruned: 0 });
    expect(cache.listSnapshotArticles('posts')).toHaveLength(2);

    // Complete walk (walkComplete: true) prunes deleted record
    const completeRes = cache.upsertSnapshotArticlesBatch({
      collection: 'posts',
      walkComplete: true,
      records: [cache.getSnapshotArticle('01M6ART0000000000000000001')!],
    });
    expect(completeRes).toEqual({ upserted: 1, pruned: 1 });
    expect(cache.listSnapshotArticles('posts')).toHaveLength(1);

    // Media snapshot supports null storageKey (A-2) and prunes only on walkComplete: true
    const medRes = cache.upsertSnapshotMediaBatch({
      walkComplete: true,
      records: [
        {
          mediaId: '01M6MED0000000000000000001',
          storageKey: '01M6KEY0000000000000000001.jpg',
          filename: 'photo.jpg',
          mimeType: 'image/jpeg',
          size: 12345,
          alt: 'Sunset',
          caption: null,
          createdAt: '2026-11-01T00:00:00.000Z',
          capturedAt: ts1,
        },
        {
          mediaId: '01M6MED0000000000000000002',
          storageKey: null,
          filename: 'legacy-no-key.png',
          mimeType: 'image/png',
          size: 500,
          alt: null,
          caption: null,
          createdAt: '2026-11-01T00:00:00.000Z',
          capturedAt: ts1,
        },
      ],
    });
    expect(medRes).toEqual({ upserted: 2, pruned: 0 });
    expect(cache.listSnapshotMedia()).toHaveLength(2);

    cache.saveSnapshotMeta({
      collection: 'posts',
      capturedAt: ts1,
      articleCount: 1,
      mediaCount: 2,
      taxonomyFetchedCount: 2,
      taxonomyReusedCount: 0,
      articleSingleGetCount: 1,
      durationMs: 320,
    });
    expect(cache.getSnapshotMeta('posts')?.mediaCount).toBe(2);

    const cleared = cache.clearSnapshot('posts');
    expect(cleared).toEqual({ articlesCleared: 1, mediaCleared: 2 });
    expect(cache.getSnapshotMeta('posts')).toBeNull();
    expect(cache.listSnapshotArticles('posts')).toEqual([]);
    expect(cache.listSnapshotMedia()).toEqual([]);
  });

  it('preserves site-wide snapshot_media when clearing one collection while another remains in snapshot_meta', () => {
    const dbPath = path.join(tempDir, 'cache.db');
    const cache = new CacheDatabase(dbPath);
    const ts1 = 1_760_000_000_000;
    const ts2 = 1_760_000_100_000;

    cache.saveSnapshotMeta({
      collection: 'posts',
      capturedAt: ts1,
      articleCount: 1,
      mediaCount: 1,
      taxonomyFetchedCount: 0,
      taxonomyReusedCount: 0,
      articleSingleGetCount: 0,
      durationMs: 10,
    });
    cache.saveSnapshotMeta({
      collection: 'pages',
      capturedAt: ts2,
      articleCount: 1,
      mediaCount: 1,
      taxonomyFetchedCount: 0,
      taxonomyReusedCount: 0,
      articleSingleGetCount: 0,
      durationMs: 10,
    });
    cache.upsertSnapshotMediaBatch({
      walkComplete: true,
      records: [
        {
          mediaId: '01M6MED0000000000000000099',
          storageKey: '01M6MED0000000000000000099.png',
          filename: 'shared.png',
          mimeType: 'image/png',
          size: 100,
          alt: null,
          caption: null,
          createdAt: '2026-11-01T00:00:00.000Z',
          capturedAt: ts2,
        },
      ],
    });

    expect(cache.getLatestSnapshotMeta()?.collection).toBe('pages');

    const clearedPages = cache.clearSnapshot('pages');
    expect(clearedPages).toEqual({ articlesCleared: 0, mediaCleared: 0 });
    expect(cache.listSnapshotMedia()).toHaveLength(1);
    expect(cache.getLatestSnapshotMeta()?.collection).toBe('posts');

    const clearedPosts = cache.clearSnapshot('posts');
    expect(clearedPosts).toEqual({ articlesCleared: 0, mediaCleared: 1 });
    expect(cache.listSnapshotMedia()).toEqual([]);
    cache.close();
  });
});
