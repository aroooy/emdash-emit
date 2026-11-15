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
import {
  asMediaRecordId,
  toStorageKey,
  type MediaRecordId,
  type StorageKey,
} from '../utils/media-id.js';
import { CURRENT_CACHE_SCHEMA_VERSION, runCacheMigrations } from './migrations.js';

export { CURRENT_CACHE_SCHEMA_VERSION, runCacheMigrations };

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
  bodyConflictPending?: number;
  taxonomyConflictPending?: number;
  deletePending?: number;
  conflictCopyHash?: string | null;
  conflictCopyPath?: string | null;
  conflictAt?: number | null;
  remoteTaxonomyHash?: string | null;
  taxonomyApplyPending?: number;
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
  /**
   * Primary local content hash (SHA-256) when mirrored from a local file/upload,
   * or synthetic identifier for compatibility.
   */
  localHash?: string;
  localContentHash?: string | null;
  remoteRecordRef?: string | null;
  mediaId: MediaRecordId;
  storageKey: StorageKey;
  url: string;
  workspacePath?: string | null;
  /**
   * Workspace-relative path of the mirror named after the storageKey (`media/<markdownRef><ext>`), i.e.
   * the file a Markdown body URL actually resolves to. Kept beside `workspace_path` because pruning and
   * lookups need both: the record id addresses the remote row, the markdown ref addresses the article body.
   */
  markdownRef?: string | null;
  status: MediaStateStatus;
  uploadedAt?: number | null;
}

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
    runCacheMigrations(this.db, this.dbPath);
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

  private rowToSyncState(row: Record<string, unknown>): SyncState {
    const bodyConflictPending = Number(row.body_conflict_pending || 0);
    const taxonomyConflictPending = Number(row.taxonomy_conflict_pending || 0);
    const conflictPending = Math.max(
      Number(row.conflict_pending || 0),
      bodyConflictPending,
      taxonomyConflictPending,
    );
    return {
      id: String(row.id),
      localFilePath: String(row.local_file_path),
      localHash: String(row.local_hash),
      remoteRev: String(row.remote_rev),
      status: String(row.status),
      slug: String(row.slug),
      lastSyncedAt: Number(row.last_synced_at),
      conflictPending,
      bodyConflictPending,
      taxonomyConflictPending,
      deletePending: Number(row.delete_pending || 0),
      conflictCopyHash: row.conflict_copy_hash ? String(row.conflict_copy_hash) : null,
      conflictCopyPath: row.conflict_copy_path ? String(row.conflict_copy_path) : null,
      conflictAt: row.conflict_at ? Number(row.conflict_at) : null,
      remoteTaxonomyHash: row.remote_taxonomy_hash ? String(row.remote_taxonomy_hash) : null,
      taxonomyApplyPending: Number(row.taxonomy_apply_pending || 0),
    };
  }

  public saveSyncState(state: SyncState): void {
    const bodyConflictPending =
      state.bodyConflictPending ?? (state.conflictPending === 0 ? 0 : (state.conflictPending ?? 0));
    const taxonomyConflictPending =
      state.taxonomyConflictPending ?? (state.conflictPending === 0 ? 0 : 0);
    const conflictPending = Math.max(
      state.conflictPending ?? 0,
      bodyConflictPending,
      taxonomyConflictPending,
    );

    const stmt = this.db.prepare(`
      INSERT INTO sync_state (
        id, local_file_path, local_hash, remote_rev, status, slug, last_synced_at,
        conflict_pending, body_conflict_pending, taxonomy_conflict_pending, delete_pending,
        conflict_copy_hash, conflict_copy_path, conflict_at,
        remote_taxonomy_hash, taxonomy_apply_pending
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        local_file_path = excluded.local_file_path,
        local_hash = excluded.local_hash,
        remote_rev = excluded.remote_rev,
        status = excluded.status,
        slug = excluded.slug,
        last_synced_at = excluded.last_synced_at,
        body_conflict_pending = excluded.body_conflict_pending,
        taxonomy_conflict_pending = excluded.taxonomy_conflict_pending,
        conflict_pending = MAX(excluded.body_conflict_pending, excluded.taxonomy_conflict_pending),
        delete_pending = excluded.delete_pending,
        conflict_copy_hash = CASE WHEN excluded.conflict_copy_path IS NOT NULL THEN excluded.conflict_copy_hash
                                  WHEN COALESCE(excluded.body_conflict_pending, 0) + COALESCE(excluded.taxonomy_conflict_pending, 0) = 0 THEN NULL
                                  ELSE sync_state.conflict_copy_hash END,
        conflict_copy_path = CASE WHEN excluded.conflict_copy_path IS NOT NULL THEN excluded.conflict_copy_path
                                  WHEN COALESCE(excluded.body_conflict_pending, 0) + COALESCE(excluded.taxonomy_conflict_pending, 0) = 0 THEN NULL
                                  ELSE sync_state.conflict_copy_path END,
        conflict_at        = CASE WHEN excluded.conflict_copy_path IS NOT NULL THEN excluded.conflict_at
                                  WHEN COALESCE(excluded.body_conflict_pending, 0) + COALESCE(excluded.taxonomy_conflict_pending, 0) = 0 THEN NULL
                                  ELSE sync_state.conflict_at END,
        remote_taxonomy_hash = CASE WHEN excluded.remote_taxonomy_hash IS NOT NULL THEN excluded.remote_taxonomy_hash ELSE sync_state.remote_taxonomy_hash END,
        taxonomy_apply_pending = excluded.taxonomy_apply_pending
    `);
    stmt.run(
      state.id,
      state.localFilePath,
      state.localHash,
      state.remoteRev,
      state.status,
      state.slug,
      state.lastSyncedAt,
      conflictPending,
      bodyConflictPending,
      taxonomyConflictPending,
      state.deletePending ?? 0,
      state.conflictCopyHash ?? null,
      state.conflictCopyPath ?? null,
      state.conflictAt ?? null,
      state.remoteTaxonomyHash ?? null,
      state.taxonomyApplyPending ?? 0,
    );
  }

  public setConflictPending(
    id: string,
    kind: 'body' | 'taxonomy' | 'all',
    pending: boolean,
    copyHash?: string | null,
    copyPath?: string | null,
  ): void {
    if (!pending) {
      this.clearConflictsByKind(id, kind);
      return;
    }

    const actualHash = copyHash ?? null;
    const actualPath = copyPath ?? null;
    const now = Math.floor(Date.now() / 1000);

    if (kind === 'all') {
      const stmt = this.db.prepare(`
        UPDATE sync_state
        SET conflict_pending = 1,
            body_conflict_pending = 1,
            taxonomy_conflict_pending = 1,
            conflict_copy_hash = CASE WHEN ? IS NOT NULL THEN ? ELSE conflict_copy_hash END,
            conflict_copy_path = CASE WHEN ? IS NOT NULL THEN ? ELSE conflict_copy_path END,
            conflict_at = CASE WHEN (? IS NOT NULL OR ? IS NOT NULL) THEN ? ELSE conflict_at END
        WHERE id = ?
      `);
      stmt.run(actualHash, actualHash, actualPath, actualPath, actualHash, actualPath, now, id);
      return;
    }

    const col = kind === 'body' ? 'body_conflict_pending' : 'taxonomy_conflict_pending';
    const stmt = this.db.prepare(`
      UPDATE sync_state
      SET ${col} = 1,
          conflict_pending = 1,
          conflict_copy_hash = CASE WHEN ? IS NOT NULL THEN ? ELSE conflict_copy_hash END,
          conflict_copy_path = CASE WHEN ? IS NOT NULL THEN ? ELSE conflict_copy_path END,
          conflict_at = CASE WHEN (? IS NOT NULL OR ? IS NOT NULL) THEN ? ELSE conflict_at END
      WHERE id = ?
    `);
    stmt.run(actualHash, actualHash, actualPath, actualPath, actualHash, actualPath, now, id);
  }

  public clearConflictsByKind(id: string, kind: 'body' | 'taxonomy' | 'all'): void {
    if (kind === 'all') {
      this.db
        .prepare(
          `
        UPDATE sync_state
        SET conflict_pending = 0,
            body_conflict_pending = 0,
            taxonomy_conflict_pending = 0,
            conflict_copy_hash = NULL,
            conflict_copy_path = NULL,
            conflict_at = NULL
        WHERE id = ?
      `,
        )
        .run(id);
      return;
    }

    const current = this.getSyncState(id);
    if (!current) return;

    const newBody = kind === 'body' ? 0 : (current.bodyConflictPending ?? 0);
    const newTax = kind === 'taxonomy' ? 0 : (current.taxonomyConflictPending ?? 0);
    const bothCleared = newBody === 0 && newTax === 0;

    this.db
      .prepare(
        `
      UPDATE sync_state
      SET body_conflict_pending = ?,
          taxonomy_conflict_pending = ?,
          conflict_pending = ?,
          conflict_copy_hash = CASE WHEN ? = 1 THEN NULL ELSE conflict_copy_hash END,
          conflict_copy_path = CASE WHEN ? = 1 THEN NULL ELSE conflict_copy_path END,
          conflict_at = CASE WHEN ? = 1 THEN NULL ELSE conflict_at END
      WHERE id = ?
    `,
      )
      .run(
        newBody,
        newTax,
        bothCleared ? 0 : 1,
        bothCleared ? 1 : 0,
        bothCleared ? 1 : 0,
        bothCleared ? 1 : 0,
        id,
      );
  }

  public setDeletePending(id: string, pending: boolean): void {
    const stmt = this.db.prepare('UPDATE sync_state SET delete_pending = ? WHERE id = ?');
    stmt.run(pending ? 1 : 0, id);
  }

  public setTaxonomyApplyPending(id: string, pending: boolean): void {
    const stmt = this.db.prepare('UPDATE sync_state SET taxonomy_apply_pending = ? WHERE id = ?');
    stmt.run(pending ? 1 : 0, id);
  }

  public getSyncState(id: string): SyncState | null {
    const stmt = this.db.prepare('SELECT * FROM sync_state WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToSyncState(row);
  }

  public getSyncStateByPath(filePath: string): SyncState | null {
    const stmt = this.db.prepare('SELECT * FROM sync_state WHERE local_file_path = ?');
    const row = stmt.get(filePath) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToSyncState(row);
  }

  public getSyncStateBySlug(slug: string): SyncState | null {
    const stmt = this.db.prepare('SELECT * FROM sync_state WHERE slug = ? LIMIT 1');
    const row = stmt.get(slug) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToSyncState(row);
  }

  public deleteSyncState(id: string): void {
    const stmt = this.db.prepare('DELETE FROM sync_state WHERE id = ?');
    stmt.run(id);
  }

  public getAllSyncStates(): SyncState[] {
    const stmt = this.db.prepare('SELECT * FROM sync_state');
    const rows = stmt.all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToSyncState(r));
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
    const localContentHash =
      record.localContentHash ??
      (record.localHash && !record.localHash.startsWith('media-record:') ? record.localHash : null);
    const remoteRecordRef =
      record.remoteRecordRef ??
      (record.localHash && record.localHash.startsWith('media-record:') ? record.localHash : null);

    const stmt = this.db.prepare(`
      INSERT INTO media_state (storage_key, media_id, local_content_hash, remote_record_ref, url, workspace_path, markdown_ref, status, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(storage_key) DO UPDATE SET
        media_id = excluded.media_id,
        local_content_hash = COALESCE(excluded.local_content_hash, media_state.local_content_hash),
        remote_record_ref = COALESCE(excluded.remote_record_ref, media_state.remote_record_ref),
        url = excluded.url,
        workspace_path = COALESCE(excluded.workspace_path, media_state.workspace_path),
        markdown_ref = COALESCE(excluded.markdown_ref, media_state.markdown_ref),
        status = excluded.status,
        uploaded_at = excluded.uploaded_at
    `);
    stmt.run(
      record.storageKey,
      record.mediaId,
      localContentHash,
      remoteRecordRef,
      record.url,
      record.workspacePath ?? null,
      record.markdownRef ?? null,
      record.status,
      record.uploadedAt ?? Math.floor(Date.now() / 1000),
    );
  }

  public getMediaState(storageKey: string): MediaStateRecord | null {
    const stmt = this.db.prepare(
      'SELECT * FROM media_state WHERE storage_key = ? ORDER BY uploaded_at DESC LIMIT 1',
    );
    const row = stmt.get(storageKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapMediaStateRow(row);
  }

  public getMediaStateByContentHash(contentHash: string): MediaStateRecord | null {
    const stmt = this.db.prepare(
      'SELECT * FROM media_state WHERE local_content_hash = ? ORDER BY uploaded_at DESC LIMIT 1',
    );
    const row = stmt.get(contentHash) as Record<string, unknown> | undefined;
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

  public getMediaStateByStorageKey(storageKey: string): MediaStateRecord | null {
    return this.getMediaState(storageKey);
  }

  public deleteMediaState(storageKey: string): void {
    const stmt = this.db.prepare('DELETE FROM media_state WHERE storage_key = ?');
    stmt.run(storageKey);
  }

  public deleteMediaStateByContentHash(contentHash: string): void {
    const stmt = this.db.prepare('DELETE FROM media_state WHERE local_content_hash = ?');
    stmt.run(contentHash);
  }

  public listMediaStates(status?: MediaStateStatus): MediaStateRecord[] {
    const stmt = status
      ? this.db.prepare('SELECT * FROM media_state WHERE status = ? ORDER BY uploaded_at DESC')
      : this.db.prepare('SELECT * FROM media_state ORDER BY uploaded_at DESC');
    const rows = (status ? stmt.all(status) : stmt.all()) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapMediaStateRow(r));
  }

  private mapMediaStateRow(row: Record<string, unknown>): MediaStateRecord {
    const localContentHash =
      row.local_content_hash !== null && row.local_content_hash !== undefined
        ? String(row.local_content_hash)
        : null;
    const remoteRecordRef =
      row.remote_record_ref !== null && row.remote_record_ref !== undefined
        ? String(row.remote_record_ref)
        : null;
    const localHash = localContentHash || remoteRecordRef || undefined;
    return {
      localHash,
      localContentHash,
      remoteRecordRef,
      mediaId: asMediaRecordId(String(row.media_id)),
      storageKey: toStorageKey(String(row.storage_key)) ?? (String(row.storage_key) as StorageKey),
      url: String(row.url),
      workspacePath:
        row.workspace_path !== null && row.workspace_path !== undefined
          ? String(row.workspace_path)
          : null,
      markdownRef:
        row.markdown_ref !== null && row.markdown_ref !== undefined
          ? String(row.markdown_ref)
          : null,
      status: String(row.status) as MediaStateStatus,
      uploadedAt:
        row.uploaded_at !== null && row.uploaded_at !== undefined ? Number(row.uploaded_at) : null,
    };
  }

  /**
   * Executes a synchronous callback within a SQLite transaction.
   * Automatically commits on success and rolls back on error.
   */
  public runTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN TRANSACTION;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Ignore rollback failure if transaction already terminated
      }
      throw err;
    }
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore if already closed
    }
  }
}
