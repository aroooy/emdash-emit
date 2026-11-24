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

export type SnapshotBodySource = 'list-live' | 'single-get' | 'list-stale';

export interface SnapshotMetaRecord {
  collection: string;
  capturedAt: number;
  articleCount: number;
  mediaCount: number;
  taxonomyFetchedCount: number;
  taxonomyReusedCount: number;
  articleSingleGetCount: number;
  durationMs: number;
}

export interface SnapshotArticleRecord {
  id: string;
  collection: string;
  slug: string;
  title: string;
  status: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  publishedAt?: string | null;
  comparisonRev: string;
  excerpt?: string | null;
  bodyMarkdown: string;
  bodySource: SnapshotBodySource;
  categoriesJson: string;
  tagsJson: string;
  taxonomyVerified: number;
  featuredImage?: string | null;
  seoJson?: string;
  locale?: string | null;
  bylinesJson?: string;
  capturedAt: number;
}

export interface SnapshotMediaRecord {
  mediaId: string;
  storageKey?: string | null;
  filename?: string | null;
  mimeType?: string | null;
  size?: number | null;
  alt?: string | null;
  caption?: string | null;
  createdAt?: string | null;
  cachedAt?: number | null;
  cachePath?: string | null;
  contentHash?: string | null;
  capturedAt: number;
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

  // --- Snapshot Catalog Methods (Schema v6) ---

  public getSnapshotMeta(collection = 'posts'): SnapshotMetaRecord | null {
    const row = this.db
      .prepare('SELECT * FROM snapshot_meta WHERE collection = ?')
      .get(collection) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapSnapshotMetaRow(row);
  }

  public getLatestSnapshotMeta(): SnapshotMetaRecord | null {
    const row = this.db
      .prepare('SELECT * FROM snapshot_meta ORDER BY captured_at DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapSnapshotMetaRow(row);
  }

  private mapSnapshotMetaRow(row: Record<string, unknown>): SnapshotMetaRecord {
    return {
      collection: String(row.collection),
      capturedAt: Number(row.captured_at),
      articleCount: Number(row.article_count),
      mediaCount: Number(row.media_count),
      taxonomyFetchedCount: Number(row.taxonomy_fetched_count),
      taxonomyReusedCount: Number(row.taxonomy_reused_count),
      articleSingleGetCount: Number(row.article_single_get_count),
      durationMs: Number(row.duration_ms),
    };
  }

  public saveSnapshotMeta(meta: SnapshotMetaRecord): void {
    this.db
      .prepare(
        `
      INSERT INTO snapshot_meta (
        collection, captured_at, article_count, media_count,
        taxonomy_fetched_count, taxonomy_reused_count, article_single_get_count, duration_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(collection) DO UPDATE SET
        captured_at = excluded.captured_at,
        article_count = excluded.article_count,
        media_count = excluded.media_count,
        taxonomy_fetched_count = excluded.taxonomy_fetched_count,
        taxonomy_reused_count = excluded.taxonomy_reused_count,
        article_single_get_count = excluded.article_single_get_count,
        duration_ms = excluded.duration_ms
    `,
      )
      .run(
        meta.collection,
        meta.capturedAt,
        meta.articleCount,
        meta.mediaCount,
        meta.taxonomyFetchedCount,
        meta.taxonomyReusedCount,
        meta.articleSingleGetCount,
        meta.durationMs,
      );
  }

  public getSnapshotArticle(id: string): SnapshotArticleRecord | null {
    const row = this.db.prepare('SELECT * FROM snapshot_articles WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapSnapshotArticleRow(row);
  }

  public listSnapshotArticles(collection = 'posts'): SnapshotArticleRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM snapshot_articles WHERE collection = ?')
      .all(collection) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapSnapshotArticleRow(r));
  }

  public upsertSnapshotArticlesBatch(options: {
    collection: string;
    records: SnapshotArticleRecord[];
    walkComplete: boolean;
  }): { upserted: number; pruned: number } {
    return this.runTransaction(() => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO snapshot_articles (
          id, collection, slug, title, status,
          created_at, updated_at, published_at, comparison_rev,
          excerpt, body_markdown, body_source,
          categories_json, tags_json, taxonomy_verified,
          featured_image, seo_json, locale, bylines_json,
          captured_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const keepIds = new Set<string>();
      for (const rec of options.records) {
        keepIds.add(rec.id);
        stmt.run(
          rec.id,
          rec.collection,
          rec.slug,
          rec.title,
          rec.status,
          rec.createdAt ?? null,
          rec.updatedAt ?? null,
          rec.publishedAt ?? null,
          rec.comparisonRev,
          rec.excerpt ?? null,
          rec.bodyMarkdown,
          rec.bodySource,
          rec.categoriesJson,
          rec.tagsJson,
          rec.taxonomyVerified,
          rec.featuredImage ?? null,
          rec.seoJson ?? '{}',
          rec.locale ?? null,
          rec.bylinesJson ?? '[]',
          rec.capturedAt,
        );
      }

      let pruned = 0;
      if (options.walkComplete) {
        const existingRows = this.db
          .prepare('SELECT id FROM snapshot_articles WHERE collection = ?')
          .all(options.collection) as Array<{ id: string }>;
        const delStmt = this.db.prepare('DELETE FROM snapshot_articles WHERE id = ?');
        for (const row of existingRows) {
          if (!keepIds.has(String(row.id))) {
            delStmt.run(String(row.id));
            pruned++;
          }
        }
      }

      return { upserted: options.records.length, pruned };
    });
  }

  private mapSnapshotMediaRow(r: Record<string, unknown>): SnapshotMediaRecord {
    return {
      mediaId: String(r.media_id),
      storageKey:
        r.storage_key !== null && r.storage_key !== undefined ? String(r.storage_key) : null,
      filename: r.filename !== null && r.filename !== undefined ? String(r.filename) : null,
      mimeType: r.mime_type !== null && r.mime_type !== undefined ? String(r.mime_type) : null,
      size: r.size !== null && r.size !== undefined ? Number(r.size) : null,
      alt: r.alt !== null && r.alt !== undefined ? String(r.alt) : null,
      caption: r.caption !== null && r.caption !== undefined ? String(r.caption) : null,
      createdAt: r.created_at !== null && r.created_at !== undefined ? String(r.created_at) : null,
      cachedAt: r.cached_at !== null && r.cached_at !== undefined ? Number(r.cached_at) : null,
      cachePath: r.cache_path !== null && r.cache_path !== undefined ? String(r.cache_path) : null,
      contentHash:
        r.content_hash !== null && r.content_hash !== undefined ? String(r.content_hash) : null,
      capturedAt: Number(r.captured_at),
    };
  }

  public listSnapshotMedia(): SnapshotMediaRecord[] {
    const rows = this.db.prepare('SELECT * FROM snapshot_media').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => this.mapSnapshotMediaRow(r));
  }

  public getSnapshotMediaByStorageKey(storageKey: string): SnapshotMediaRecord | null {
    const row = this.db
      .prepare('SELECT * FROM snapshot_media WHERE storage_key = ? LIMIT 1')
      .get(storageKey) as Record<string, unknown> | undefined;
    return row ? this.mapSnapshotMediaRow(row) : null;
  }

  public getSnapshotMediaById(mediaId: string): SnapshotMediaRecord | null {
    const row = this.db
      .prepare('SELECT * FROM snapshot_media WHERE media_id = ? LIMIT 1')
      .get(mediaId.toUpperCase()) as Record<string, unknown> | undefined;
    return row ? this.mapSnapshotMediaRow(row) : null;
  }

  public listCachedSnapshotMedia(): SnapshotMediaRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM snapshot_media WHERE cached_at IS NOT NULL')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapSnapshotMediaRow(r));
  }

  public markMediaCached(
    mediaId: string,
    info: { cachedAt: number; cachePath: string; contentHash: string },
  ): void {
    this.db
      .prepare(
        `UPDATE snapshot_media SET cached_at = ?, cache_path = ?, content_hash = ? WHERE media_id = ?`,
      )
      .run(info.cachedAt, info.cachePath, info.contentHash, mediaId.toUpperCase());
  }

  public clearMediaCacheFields(mediaId: string): void {
    this.db
      .prepare(
        `UPDATE snapshot_media SET cached_at = NULL, cache_path = NULL, content_hash = NULL WHERE media_id = ?`,
      )
      .run(mediaId.toUpperCase());
  }

  public countSnapshotMeta(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM snapshot_meta').get() as {
      cnt: number;
    };
    return Number(row?.cnt ?? 0);
  }

  public upsertSnapshotMediaBatch(options: {
    records: SnapshotMediaRecord[];
    walkComplete: boolean;
  }): { upserted: number; pruned: number } {
    return this.runTransaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO snapshot_media (
          media_id, storage_key, filename, mime_type, size, alt, caption, created_at,
          cached_at, cache_path, content_hash, captured_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(media_id) DO UPDATE SET
          storage_key = excluded.storage_key,
          filename = excluded.filename,
          mime_type = excluded.mime_type,
          size = excluded.size,
          alt = excluded.alt,
          caption = excluded.caption,
          created_at = excluded.created_at,
          cached_at = COALESCE(excluded.cached_at, snapshot_media.cached_at),
          cache_path = COALESCE(excluded.cache_path, snapshot_media.cache_path),
          content_hash = COALESCE(excluded.content_hash, snapshot_media.content_hash),
          captured_at = excluded.captured_at
      `);

      const keepIds = new Set<string>();
      for (const rec of options.records) {
        keepIds.add(rec.mediaId);
        stmt.run(
          rec.mediaId,
          rec.storageKey ?? null,
          rec.filename ?? null,
          rec.mimeType ?? null,
          rec.size ?? null,
          rec.alt ?? null,
          rec.caption ?? null,
          rec.createdAt ?? null,
          rec.cachedAt ?? null,
          rec.cachePath ?? null,
          rec.contentHash ?? null,
          rec.capturedAt,
        );
      }

      let pruned = 0;
      if (options.walkComplete) {
        const existingRows = this.db.prepare('SELECT media_id FROM snapshot_media').all() as Array<{
          media_id: string;
        }>;
        const delStmt = this.db.prepare('DELETE FROM snapshot_media WHERE media_id = ?');
        for (const row of existingRows) {
          if (!keepIds.has(String(row.media_id))) {
            delStmt.run(String(row.media_id));
            pruned++;
          }
        }
      }

      return { upserted: options.records.length, pruned };
    });
  }

  public clearSnapshot(collection?: string): { articlesCleared: number; mediaCleared: number } {
    return this.runTransaction(() => {
      const artCountRow = (
        collection
          ? this.db
              .prepare('SELECT COUNT(*) as cnt FROM snapshot_articles WHERE collection = ?')
              .get(collection)
          : this.db.prepare('SELECT COUNT(*) as cnt FROM snapshot_articles').get()
      ) as { cnt: number };
      const medCountRow = this.db.prepare('SELECT COUNT(*) as cnt FROM snapshot_media').get() as {
        cnt: number;
      };

      if (collection) {
        this.db.prepare('DELETE FROM snapshot_articles WHERE collection = ?').run(collection);
        this.db.prepare('DELETE FROM snapshot_meta WHERE collection = ?').run(collection);
      } else {
        this.db.exec('DELETE FROM snapshot_articles;');
        this.db.exec('DELETE FROM snapshot_meta;');
      }

      const remainingMeta = this.db.prepare('SELECT COUNT(*) as cnt FROM snapshot_meta').get() as {
        cnt: number;
      };
      const shouldClearMedia = !collection || Number(remainingMeta?.cnt ?? 0) === 0;
      if (shouldClearMedia) {
        this.db.exec('DELETE FROM snapshot_media;');
      }

      return {
        articlesCleared: Number(artCountRow?.cnt ?? 0),
        mediaCleared: shouldClearMedia ? Number(medCountRow?.cnt ?? 0) : 0,
      };
    });
  }

  private mapSnapshotArticleRow(row: Record<string, unknown>): SnapshotArticleRecord {
    return {
      id: String(row.id),
      collection: String(row.collection),
      slug: String(row.slug),
      title: String(row.title),
      status: String(row.status),
      createdAt:
        row.created_at !== null && row.created_at !== undefined ? String(row.created_at) : null,
      updatedAt:
        row.updated_at !== null && row.updated_at !== undefined ? String(row.updated_at) : null,
      publishedAt:
        row.published_at !== null && row.published_at !== undefined
          ? String(row.published_at)
          : null,
      comparisonRev: String(row.comparison_rev),
      excerpt: row.excerpt !== null && row.excerpt !== undefined ? String(row.excerpt) : null,
      bodyMarkdown: String(row.body_markdown ?? ''),
      bodySource: String(row.body_source ?? 'list-live') as SnapshotBodySource,
      categoriesJson: String(row.categories_json ?? '[]'),
      tagsJson: String(row.tags_json ?? '[]'),
      taxonomyVerified: Number(row.taxonomy_verified ?? 1),
      featuredImage:
        row.featured_image !== null && row.featured_image !== undefined
          ? String(row.featured_image)
          : null,
      seoJson: String(row.seo_json ?? '{}'),
      locale: row.locale !== null && row.locale !== undefined ? String(row.locale) : null,
      bylinesJson: String(row.bylines_json ?? '[]'),
      capturedAt: Number(row.captured_at),
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
