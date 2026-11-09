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

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export interface CachedEntry {
  id: string;
  collection: string;
  slug: string;
  status: string;
  title: string;
  rev: string;
  publishedAt?: string | null;
  rawJson: string;
  updatedAt: number;
}

export interface BaseSnapshot {
  id: string;
  rev: string;
  bodyMarkdown: string;
  frontmatterYaml: string;
  hash: string;
  savedAt: number;
}

export interface SyncState {
  id: string;
  localFilePath: string;
  localHash: string;
  remoteRev: string;
  status: string;
  slug: string;
  lastSyncedAt: number;
  conflictPending?: number;
  deletePending?: number;
  conflictCopyHash?: string | null;
  conflictCopyPath?: string | null;
  conflictAt?: number | null;
}

export interface BylineRecord {
  id: string;
  slug: string;
  displayName: string;
  isGuest?: boolean;
  rawJson?: string;
  updatedAt?: number;
}

export type MediaStateStatus = 'pending' | 'ready' | 'failed' | 'uploaded';

export interface MediaStateRecord {
  localHash: string;
  mediaId: string;
  storageKey: string;
  url: string;
  workspacePath?: string | null;
  status: MediaStateStatus;
  uploadedAt?: number | null;
}

export const CURRENT_CACHE_SCHEMA_VERSION = 1;

export class CacheDatabase {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    const parentDir = path.dirname(dbPath);
    if (dbPath !== ':memory:' && !fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  private init(): void {
    // Enable WAL mode for better concurrency and write performance
    this.db.exec('PRAGMA journal_mode = WAL;');

    // 1. entries table: remote state cache
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        collection TEXT NOT NULL,
        slug TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        rev TEXT NOT NULL,
        published_at TEXT,
        raw_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entries_collection ON entries (collection);
      CREATE INDEX IF NOT EXISTS idx_entries_slug ON entries (slug);
    `);

    // 2. base_snapshots table: baseline state for 3-way merge
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS base_snapshots (
        id TEXT PRIMARY KEY,
        rev TEXT NOT NULL,
        body_markdown TEXT NOT NULL,
        frontmatter_yaml TEXT NOT NULL,
        hash TEXT NOT NULL,
        saved_at INTEGER NOT NULL
      );
    `);

    // 3. sync_state table: local path tracking & dirty change detection
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        id TEXT PRIMARY KEY,
        local_file_path TEXT NOT NULL,
        local_hash TEXT NOT NULL,
        remote_rev TEXT NOT NULL,
        status TEXT NOT NULL,
        slug TEXT NOT NULL,
        last_synced_at INTEGER NOT NULL,
        conflict_pending INTEGER NOT NULL DEFAULT 0,
        delete_pending INTEGER NOT NULL DEFAULT 0,
        conflict_copy_hash TEXT,
        conflict_copy_path TEXT,
        conflict_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sync_state_file_path ON sync_state (local_file_path);
    `);

    // 4. bylines table: local cache for author/byline resolution
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bylines (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        is_guest INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bylines_slug ON bylines (slug);
    `);

    // 5. media_state table: local draft media upload tracking & idempotency
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media_state (
        local_hash TEXT PRIMARY KEY,
        media_id TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        url TEXT NOT NULL,
        workspace_path TEXT,
        status TEXT NOT NULL,
        uploaded_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_media_state_media_id ON media_state (media_id);
      CREATE INDEX IF NOT EXISTS idx_media_state_status ON media_state (status);
    `);

    // Run schema migrations for existing databases
    this.runMigrations();

    // Create indexes that depend on migrated columns
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sync_state_conflict ON sync_state (conflict_pending);
    `);
  }

  private runMigrations(): void {
    const versionRow = this.db.prepare('PRAGMA user_version;').get() as
      Record<string, unknown> | undefined;
    const currentVersion = Number(versionRow?.user_version || 0);

    // Guard against opening a database created by a newer version of emdash-emit
    if (currentVersion > CURRENT_CACHE_SCHEMA_VERSION) {
      throw new Error(
        `[CACHE_SCHEMA_MISMATCH] Cache database at ${this.dbPath} was created with schema version ${currentVersion}, but current emit supports up to ${CURRENT_CACHE_SCHEMA_VERSION}. Please upgrade emdash-emit.`,
      );
    }

    if (currentVersion < CURRENT_CACHE_SCHEMA_VERSION) {
      // 1. Flush WAL completely to main database file before backing up
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {
        // Ignore checkpoint failure in in-memory or constrained environments
      }

      // 2. Backup database before running migration if physical file exists (keep up to 3 recent backups)
      if (this.dbPath !== ':memory:' && fs.existsSync(this.dbPath)) {
        try {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const bakPath = `${this.dbPath}.bak-0.1.11-${timestamp}`;
          fs.copyFileSync(this.dbPath, bakPath);

          // Prune backups: retain only 3 newest .bak-* files
          const dbDir = path.dirname(this.dbPath);
          const dbBase = path.basename(this.dbPath);
          const backupFiles = fs
            .readdirSync(dbDir)
            .filter((f) => f.startsWith(`${dbBase}.bak-`))
            .map((f) => path.join(dbDir, f))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

          if (backupFiles.length > 3) {
            for (const oldBak of backupFiles.slice(3)) {
              try {
                fs.unlinkSync(oldBak);
              } catch {
                // Ignore unlink errors
              }
            }
          }
        } catch {
          // Ignore backup copy failure in constrained test environments
        }
      }

      // Migration 1: add conflict_pending, delete_pending, conflict_copy_hash, conflict_copy_path, conflict_at to sync_state if missing
      const columns = this.db.prepare("PRAGMA table_info('sync_state');").all() as Array<
        Record<string, unknown>
      >;
      const columnNames = new Set(columns.map((c) => String(c.name)));

      if (!columnNames.has('conflict_pending')) {
        this.db.exec(
          'ALTER TABLE sync_state ADD COLUMN conflict_pending INTEGER NOT NULL DEFAULT 0;',
        );
      }
      if (!columnNames.has('delete_pending')) {
        this.db.exec(
          'ALTER TABLE sync_state ADD COLUMN delete_pending INTEGER NOT NULL DEFAULT 0;',
        );
      }
      if (!columnNames.has('conflict_copy_hash')) {
        this.db.exec('ALTER TABLE sync_state ADD COLUMN conflict_copy_hash TEXT;');
      }
      if (!columnNames.has('conflict_copy_path')) {
        this.db.exec('ALTER TABLE sync_state ADD COLUMN conflict_copy_path TEXT;');
      }
      if (!columnNames.has('conflict_at')) {
        this.db.exec('ALTER TABLE sync_state ADD COLUMN conflict_at INTEGER;');
      }
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_sync_state_conflict ON sync_state (conflict_pending);',
      );
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_sync_state_delete ON sync_state (delete_pending);',
      );

      this.db.exec(`PRAGMA user_version = ${CURRENT_CACHE_SCHEMA_VERSION};`);
    }
  }

  public getSchemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version;').get() as
      Record<string, unknown> | undefined;
    return Number(row?.user_version || 0);
  }

  // --- entries operations ---

  public saveEntry(entry: CachedEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO entries (id, collection, slug, status, title, rev, published_at, raw_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        collection = excluded.collection,
        slug = excluded.slug,
        status = excluded.status,
        title = excluded.title,
        rev = excluded.rev,
        published_at = excluded.published_at,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      entry.id,
      entry.collection,
      entry.slug,
      entry.status,
      entry.title,
      entry.rev,
      entry.publishedAt ?? null,
      entry.rawJson,
      entry.updatedAt,
    );
  }

  public getEntry(id: string): CachedEntry | null {
    const stmt = this.db.prepare('SELECT * FROM entries WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      collection: String(row.collection),
      slug: String(row.slug),
      status: String(row.status),
      title: String(row.title),
      rev: String(row.rev),
      publishedAt: row.published_at ? String(row.published_at) : null,
      rawJson: String(row.raw_json),
      updatedAt: Number(row.updated_at),
    };
  }

  public getEntryBySlug(slug: string, collection?: string): CachedEntry | null {
    const query = collection
      ? 'SELECT * FROM entries WHERE slug = ? AND collection = ? LIMIT 1'
      : 'SELECT * FROM entries WHERE slug = ? LIMIT 1';
    const stmt = this.db.prepare(query);
    const row = (collection ? stmt.get(slug, collection) : stmt.get(slug)) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      collection: String(row.collection),
      slug: String(row.slug),
      status: String(row.status),
      title: String(row.title),
      rev: String(row.rev),
      publishedAt: row.published_at ? String(row.published_at) : null,
      rawJson: String(row.raw_json),
      updatedAt: Number(row.updated_at),
    };
  }

  public listEntries(collection?: string): CachedEntry[] {
    const query = collection
      ? 'SELECT * FROM entries WHERE collection = ? ORDER BY updated_at DESC'
      : 'SELECT * FROM entries ORDER BY updated_at DESC';
    const stmt = this.db.prepare(query);
    const rows = (collection ? stmt.all(collection) : stmt.all()) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: String(row.id),
      collection: String(row.collection),
      slug: String(row.slug),
      status: String(row.status),
      title: String(row.title),
      rev: String(row.rev),
      publishedAt: row.published_at ? String(row.published_at) : null,
      rawJson: String(row.raw_json),
      updatedAt: Number(row.updated_at),
    }));
  }

  // --- base_snapshots operations ---

  public saveBaseSnapshot(snapshot: BaseSnapshot): void {
    const stmt = this.db.prepare(`
      INSERT INTO base_snapshots (id, rev, body_markdown, frontmatter_yaml, hash, saved_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        rev = excluded.rev,
        body_markdown = excluded.body_markdown,
        frontmatter_yaml = excluded.frontmatter_yaml,
        hash = excluded.hash,
        saved_at = excluded.saved_at
    `);
    stmt.run(
      snapshot.id,
      snapshot.rev,
      snapshot.bodyMarkdown,
      snapshot.frontmatterYaml,
      snapshot.hash,
      snapshot.savedAt,
    );
  }

  public getBaseSnapshot(id: string): BaseSnapshot | null {
    const stmt = this.db.prepare('SELECT * FROM base_snapshots WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      rev: String(row.rev),
      bodyMarkdown: String(row.body_markdown),
      frontmatterYaml: String(row.frontmatter_yaml),
      hash: String(row.hash),
      savedAt: Number(row.saved_at),
    };
  }

  public deleteBaseSnapshot(id: string): void {
    const stmt = this.db.prepare('DELETE FROM base_snapshots WHERE id = ?');
    stmt.run(id);
  }

  // --- sync_state operations ---

  public saveSyncState(state: SyncState): void {
    const stmt = this.db.prepare(`
      INSERT INTO sync_state (id, local_file_path, local_hash, remote_rev, status, slug, last_synced_at, conflict_pending, delete_pending, conflict_copy_hash, conflict_copy_path, conflict_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        local_file_path = excluded.local_file_path,
        local_hash = excluded.local_hash,
        remote_rev = excluded.remote_rev,
        status = excluded.status,
        slug = excluded.slug,
        last_synced_at = excluded.last_synced_at,
        conflict_pending = excluded.conflict_pending,
        delete_pending = excluded.delete_pending,
        conflict_copy_hash = excluded.conflict_copy_hash,
        conflict_copy_path = excluded.conflict_copy_path,
        conflict_at = excluded.conflict_at
    `);
    stmt.run(
      state.id,
      state.localFilePath,
      state.localHash,
      state.remoteRev,
      state.status,
      state.slug,
      state.lastSyncedAt,
      state.conflictPending ?? 0,
      state.deletePending ?? 0,
      state.conflictCopyHash ?? null,
      state.conflictCopyPath ?? null,
      state.conflictAt ?? null,
    );
  }

  public setConflictPending(
    id: string,
    pending: boolean,
    copyHash?: string | null,
    copyPath?: string | null,
  ): void {
    if (pending) {
      const stmt = this.db.prepare(
        'UPDATE sync_state SET conflict_pending = 1, conflict_copy_hash = ?, conflict_copy_path = ?, conflict_at = ? WHERE id = ?',
      );
      stmt.run(copyHash ?? null, copyPath ?? null, Math.floor(Date.now() / 1000), id);
    } else {
      const stmt = this.db.prepare(
        'UPDATE sync_state SET conflict_pending = 0, conflict_copy_hash = NULL, conflict_copy_path = NULL, conflict_at = NULL WHERE id = ?',
      );
      stmt.run(id);
    }
  }

  public setDeletePending(id: string, pending: boolean): void {
    const stmt = this.db.prepare('UPDATE sync_state SET delete_pending = ? WHERE id = ?');
    stmt.run(pending ? 1 : 0, id);
  }

  public getSyncState(id: string): SyncState | null {
    const stmt = this.db.prepare('SELECT * FROM sync_state WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      localFilePath: String(row.local_file_path),
      localHash: String(row.local_hash),
      remoteRev: String(row.remote_rev),
      status: String(row.status),
      slug: String(row.slug),
      lastSyncedAt: Number(row.last_synced_at),
      conflictPending: Number(row.conflict_pending || 0),
      deletePending: Number(row.delete_pending || 0),
      conflictCopyHash: row.conflict_copy_hash ? String(row.conflict_copy_hash) : null,
      conflictCopyPath: row.conflict_copy_path ? String(row.conflict_copy_path) : null,
      conflictAt: row.conflict_at ? Number(row.conflict_at) : null,
    };
  }

  public getSyncStateByPath(filePath: string): SyncState | null {
    const stmt = this.db.prepare('SELECT * FROM sync_state WHERE local_file_path = ?');
    const row = stmt.get(filePath) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      localFilePath: String(row.local_file_path),
      localHash: String(row.local_hash),
      remoteRev: String(row.remote_rev),
      status: String(row.status),
      slug: String(row.slug),
      lastSyncedAt: Number(row.last_synced_at),
      conflictPending: Number(row.conflict_pending || 0),
      deletePending: Number(row.delete_pending || 0),
      conflictCopyHash: row.conflict_copy_hash ? String(row.conflict_copy_hash) : null,
      conflictCopyPath: row.conflict_copy_path ? String(row.conflict_copy_path) : null,
      conflictAt: row.conflict_at ? Number(row.conflict_at) : null,
    };
  }

  public getSyncStateBySlug(slug: string): SyncState | null {
    const stmt = this.db.prepare('SELECT * FROM sync_state WHERE slug = ? LIMIT 1');
    const row = stmt.get(slug) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      localFilePath: String(row.local_file_path),
      localHash: String(row.local_hash),
      remoteRev: String(row.remote_rev),
      status: String(row.status),
      slug: String(row.slug),
      lastSyncedAt: Number(row.last_synced_at),
      conflictPending: Number(row.conflict_pending || 0),
      deletePending: Number(row.delete_pending || 0),
      conflictCopyHash: row.conflict_copy_hash ? String(row.conflict_copy_hash) : null,
      conflictCopyPath: row.conflict_copy_path ? String(row.conflict_copy_path) : null,
      conflictAt: row.conflict_at ? Number(row.conflict_at) : null,
    };
  }

  public deleteSyncState(id: string): void {
    const stmt = this.db.prepare('DELETE FROM sync_state WHERE id = ?');
    stmt.run(id);
  }

  public getAllSyncStates(): SyncState[] {
    const stmt = this.db.prepare('SELECT * FROM sync_state');
    const rows = stmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      localFilePath: String(row.local_file_path),
      localHash: String(row.local_hash),
      remoteRev: String(row.remote_rev),
      status: String(row.status),
      slug: String(row.slug),
      lastSyncedAt: Number(row.last_synced_at),
      conflictPending: Number(row.conflict_pending || 0),
      deletePending: Number(row.delete_pending || 0),
      conflictCopyHash: row.conflict_copy_hash ? String(row.conflict_copy_hash) : null,
      conflictCopyPath: row.conflict_copy_path ? String(row.conflict_copy_path) : null,
      conflictAt: row.conflict_at ? Number(row.conflict_at) : null,
    }));
  }

  public deleteEntry(id: string): void {
    this.db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM base_snapshots WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM sync_state WHERE id = ?').run(id);
  }

  // --- bylines operations ---

  public saveBylines(bylines: BylineRecord[], pruneMissing = false): void {
    if (bylines.length === 0 && !pruneMissing) return;
    const stmt = this.db.prepare(`
      INSERT INTO bylines (id, slug, display_name, is_guest, raw_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug,
        display_name = excluded.display_name,
        is_guest = excluded.is_guest,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `);
    const now = Math.floor(Date.now() / 1000);
    this.db.exec('BEGIN TRANSACTION;');
    try {
      if (pruneMissing) {
        const activeIds = new Set(bylines.map((b) => b.id));
        const existing = this.getBylines();
        const deleteStmt = this.db.prepare('DELETE FROM bylines WHERE id = ?');
        for (const ex of existing) {
          if (!activeIds.has(ex.id)) {
            deleteStmt.run(ex.id);
          }
        }
      }
      for (const b of bylines) {
        stmt.run(
          b.id,
          b.slug,
          b.displayName,
          b.isGuest ? 1 : 0,
          b.rawJson || '{}',
          b.updatedAt || now,
        );
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  public getBylines(): BylineRecord[] {
    const stmt = this.db.prepare('SELECT * FROM bylines ORDER BY slug ASC');
    const rows = stmt.all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      slug: String(r.slug),
      displayName: String(r.display_name),
      isGuest: Boolean(r.is_guest),
      rawJson: String(r.raw_json),
      updatedAt: Number(r.updated_at),
    }));
  }

  public getBylineMaps(): { slugToId: Record<string, string>; idToSlug: Record<string, string> } {
    const bylines = this.getBylines();
    const slugToId: Record<string, string> = {};
    const idToSlug: Record<string, string> = {};
    for (const b of bylines) {
      if (b.slug && b.id) {
        slugToId[b.slug] = b.id;
        idToSlug[b.id] = b.slug;
      }
    }
    return { slugToId, idToSlug };
  }

  // --- media_state operations ---

  public saveMediaState(record: MediaStateRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO media_state (local_hash, media_id, storage_key, url, workspace_path, status, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(local_hash) DO UPDATE SET
        media_id = excluded.media_id,
        storage_key = excluded.storage_key,
        url = excluded.url,
        workspace_path = COALESCE(excluded.workspace_path, media_state.workspace_path),
        status = excluded.status,
        uploaded_at = excluded.uploaded_at
    `);
    stmt.run(
      record.localHash,
      record.mediaId,
      record.storageKey,
      record.url,
      record.workspacePath ?? null,
      record.status,
      record.uploadedAt ?? Math.floor(Date.now() / 1000),
    );
  }

  public getMediaState(localHash: string): MediaStateRecord | null {
    const stmt = this.db.prepare('SELECT * FROM media_state WHERE local_hash = ?');
    const row = stmt.get(localHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapMediaStateRow(row);
  }

  public getMediaStateByMediaId(mediaId: string): MediaStateRecord | null {
    const stmt = this.db.prepare(
      'SELECT * FROM media_state WHERE media_id = ? ORDER BY uploaded_at DESC LIMIT 1',
    );
    const row = stmt.get(mediaId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapMediaStateRow(row);
  }

  public deleteMediaState(localHash: string): void {
    const stmt = this.db.prepare('DELETE FROM media_state WHERE local_hash = ?');
    stmt.run(localHash);
  }

  public listMediaStates(status?: MediaStateStatus): MediaStateRecord[] {
    const stmt = status
      ? this.db.prepare('SELECT * FROM media_state WHERE status = ? ORDER BY uploaded_at DESC')
      : this.db.prepare('SELECT * FROM media_state ORDER BY uploaded_at DESC');
    const rows = (status ? stmt.all(status) : stmt.all()) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapMediaStateRow(r));
  }

  private mapMediaStateRow(row: Record<string, unknown>): MediaStateRecord {
    return {
      localHash: String(row.local_hash),
      mediaId: String(row.media_id),
      storageKey: String(row.storage_key),
      url: String(row.url),
      workspacePath:
        row.workspace_path !== null && row.workspace_path !== undefined
          ? String(row.workspace_path)
          : null,
      status: String(row.status) as MediaStateStatus,
      uploadedAt:
        row.uploaded_at !== null && row.uploaded_at !== undefined ? Number(row.uploaded_at) : null,
    };
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore if already closed
    }
  }
}
