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
}

export interface BylineRecord {
  id: string;
  slug: string;
  displayName: string;
  isGuest?: boolean;
  rawJson?: string;
  updatedAt?: number;
}

export class CacheDatabase {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const parentDir = path.dirname(dbPath);
    if (!fs.existsSync(parentDir)) {
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
        last_synced_at INTEGER NOT NULL
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

  // --- sync_state operations ---

  public saveSyncState(state: SyncState): void {
    const stmt = this.db.prepare(`
      INSERT INTO sync_state (id, local_file_path, local_hash, remote_rev, status, slug, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        local_file_path = excluded.local_file_path,
        local_hash = excluded.local_hash,
        remote_rev = excluded.remote_rev,
        status = excluded.status,
        slug = excluded.slug,
        last_synced_at = excluded.last_synced_at
    `);
    stmt.run(
      state.id,
      state.localFilePath,
      state.localHash,
      state.remoteRev,
      state.status,
      state.slug,
      state.lastSyncedAt,
    );
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
    }));
  }

  public deleteEntry(id: string): void {
    this.db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM base_snapshots WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM sync_state WHERE id = ?').run(id);
  }

  // --- bylines operations ---

  public saveBylines(bylines: BylineRecord[]): void {
    if (bylines.length === 0) return;
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

  public close(): void {
    this.db.close();
  }
}
