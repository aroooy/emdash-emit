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

import type { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { getPackageVersion } from '../utils/version.js';

export const CURRENT_CACHE_SCHEMA_VERSION = 6;

function pruneBackups(dbPath: string): void {
  if (dbPath === ':memory:') return;
  try {
    const dbDir = path.dirname(dbPath);
    const dbBase = path.basename(dbPath);
    if (!fs.existsSync(dbDir)) return;

    const backupFiles = fs
      .readdirSync(dbDir)
      .filter((f) => f.startsWith(`${dbBase}.bak-`))
      .map((f) => path.join(dbDir, f));

    // 1. Unconditionally purge 0-byte backup files
    const validBackups: string[] = [];
    for (const bak of backupFiles) {
      try {
        const stat = fs.statSync(bak);
        if (stat.size === 0) {
          fs.unlinkSync(bak);
        } else {
          validBackups.push(bak);
        }
      } catch {
        // Ignore stat/unlink errors
      }
    }

    // 2. Retain up to 3 newest valid backups
    validBackups.sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });

    if (validBackups.length > 3) {
      for (const oldBak of validBackups.slice(3)) {
        try {
          fs.unlinkSync(oldBak);
        } catch {
          // Ignore unlink errors
        }
      }
    }
  } catch {
    // Ignore backup prune errors
  }
}

/**
 * Initializes SQLite schema tables and executes versioned migrations up to CURRENT_CACHE_SCHEMA_VERSION.
 */
export function runCacheMigrations(db: DatabaseSync, dbPath = ':memory:'): void {
  // Enable WAL mode for better concurrency and write performance
  db.exec('PRAGMA journal_mode = WAL;');

  // 1. entries table: remote state cache
  db.exec(`
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
  db.exec(`
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      id TEXT PRIMARY KEY,
      local_file_path TEXT NOT NULL,
      local_hash TEXT NOT NULL,
      remote_rev TEXT NOT NULL,
      status TEXT NOT NULL,
      slug TEXT NOT NULL,
      last_synced_at INTEGER NOT NULL,
      conflict_pending INTEGER NOT NULL DEFAULT 0,
      body_conflict_pending INTEGER NOT NULL DEFAULT 0,
      taxonomy_conflict_pending INTEGER NOT NULL DEFAULT 0,
      delete_pending INTEGER NOT NULL DEFAULT 0,
      conflict_copy_hash TEXT,
      conflict_copy_path TEXT,
      conflict_at INTEGER,
      remote_taxonomy_hash TEXT,
      taxonomy_apply_pending INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sync_state_file_path ON sync_state (local_file_path);
  `);

  // 4. bylines table: local cache for author/byline resolution
  db.exec(`
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

  // 5. media_state table: local draft media upload tracking & idempotency (Schema v5)
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_state (
      storage_key TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      local_content_hash TEXT,
      remote_record_ref TEXT,
      url TEXT NOT NULL,
      workspace_path TEXT,
      markdown_ref TEXT,
      status TEXT NOT NULL,
      uploaded_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_media_state_media_id ON media_state (media_id);
    CREATE INDEX IF NOT EXISTS idx_media_state_status ON media_state (status);
  `);

  // 6. snapshot_meta table: records when the remote metadata snapshot was captured (Schema v6)
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_meta (
      collection TEXT PRIMARY KEY,
      captured_at INTEGER NOT NULL,
      article_count INTEGER NOT NULL DEFAULT 0,
      media_count INTEGER NOT NULL DEFAULT 0,
      taxonomy_fetched_count INTEGER NOT NULL DEFAULT 0,
      taxonomy_reused_count INTEGER NOT NULL DEFAULT 0,
      article_single_get_count INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );
  `);

  // 7. snapshot_articles table: full-library article metadata & verified body catalog (Schema v6)
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_articles (
      id TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      published_at TEXT,
      comparison_rev TEXT NOT NULL,
      excerpt TEXT,
      body_markdown TEXT NOT NULL DEFAULT '',
      body_source TEXT NOT NULL DEFAULT 'list-live',
      categories_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      taxonomy_verified INTEGER NOT NULL DEFAULT 1,
      captured_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshot_articles_collection ON snapshot_articles (collection);
    CREATE INDEX IF NOT EXISTS idx_snapshot_articles_status ON snapshot_articles (status);
    CREATE INDEX IF NOT EXISTS idx_snapshot_articles_slug ON snapshot_articles (slug);
  `);

  // 8. snapshot_media table: full-library media metadata catalog without binary downloads (Schema v6)
  // Primary key is media_id (D1 26-char record ULID) so migrated records lacking a storageKey are
  // stored and pruned accurately. Dimensions (width/height) are intentionally omitted as unnecessary
  // for offline search.
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_media (
      media_id TEXT PRIMARY KEY,
      storage_key TEXT,
      filename TEXT,
      mime_type TEXT,
      size INTEGER,
      alt TEXT,
      caption TEXT,
      created_at TEXT,
      captured_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshot_media_storage_key ON snapshot_media (storage_key);
    CREATE INDEX IF NOT EXISTS idx_snapshot_media_created_at ON snapshot_media (created_at);
  `);

  const versionRow = db.prepare('PRAGMA user_version;').get() as
    Record<string, unknown> | undefined;
  const currentVersion = Number(versionRow?.user_version || 0);

  // Guard against opening a database created by a newer version of emdash-emit
  if (currentVersion > CURRENT_CACHE_SCHEMA_VERSION) {
    throw new Error(
      `[CACHE_SCHEMA_MISMATCH] Cache database at ${dbPath} was created with schema version ${currentVersion}, but current emit supports up to ${CURRENT_CACHE_SCHEMA_VERSION}. Please upgrade emdash-emit.`,
    );
  }

  if (currentVersion < CURRENT_CACHE_SCHEMA_VERSION) {
    // 1. Backup database before running migration via SQLite native VACUUM INTO
    if (dbPath !== ':memory:' && fs.existsSync(dbPath)) {
      try {
        const version = getPackageVersion();
        const versionStr = version !== 'unknown' ? version : CURRENT_CACHE_SCHEMA_VERSION;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const bakPath = `${dbPath}.bak-${versionStr}-${timestamp}`;
        db.prepare('VACUUM INTO ?').run(bakPath);
      } catch {
        // Ignore in-memory or constrained test environments
      }
    }

    // Unconditionally sweep 0-byte or excess backups
    pruneBackups(dbPath);

    // Migration 1 & 2: schema columns from v1 and v2 if missing
    const columns = db.prepare("PRAGMA table_info('sync_state');").all() as Array<
      Record<string, unknown>
    >;
    const columnNames = new Set(columns.map((c) => String(c.name)));

    if (!columnNames.has('conflict_pending')) {
      db.exec('ALTER TABLE sync_state ADD COLUMN conflict_pending INTEGER NOT NULL DEFAULT 0;');
    }
    if (!columnNames.has('delete_pending')) {
      db.exec('ALTER TABLE sync_state ADD COLUMN delete_pending INTEGER NOT NULL DEFAULT 0;');
    }
    if (!columnNames.has('conflict_copy_hash')) {
      db.exec('ALTER TABLE sync_state ADD COLUMN conflict_copy_hash TEXT;');
    }
    if (!columnNames.has('conflict_copy_path')) {
      db.exec('ALTER TABLE sync_state ADD COLUMN conflict_copy_path TEXT;');
    }
    if (!columnNames.has('conflict_at')) {
      db.exec('ALTER TABLE sync_state ADD COLUMN conflict_at INTEGER;');
    }
    if (!columnNames.has('remote_taxonomy_hash')) {
      db.exec('ALTER TABLE sync_state ADD COLUMN remote_taxonomy_hash TEXT;');
    }
    if (!columnNames.has('taxonomy_apply_pending')) {
      db.exec(
        'ALTER TABLE sync_state ADD COLUMN taxonomy_apply_pending INTEGER NOT NULL DEFAULT 0;',
      );
    }

    // Migration 3 (v3): separate body and taxonomy conflict pending flags
    if (!columnNames.has('body_conflict_pending')) {
      db.exec(
        'ALTER TABLE sync_state ADD COLUMN body_conflict_pending INTEGER NOT NULL DEFAULT 0;',
      );
    }
    if (!columnNames.has('taxonomy_conflict_pending')) {
      db.exec(
        'ALTER TABLE sync_state ADD COLUMN taxonomy_conflict_pending INTEGER NOT NULL DEFAULT 0;',
      );
    }

    // Existing rows allocation rule when upgrading to v3
    if (currentVersion < 3) {
      db.exec(`
        UPDATE sync_state
        SET body_conflict_pending = CASE
          WHEN conflict_pending = 1 AND conflict_copy_path LIKE '%.conflict.md' THEN 1
          WHEN conflict_pending = 1 AND remote_taxonomy_hash IS NOT NULL AND (conflict_copy_path IS NULL OR conflict_copy_path NOT LIKE '%.conflict.md') THEN 0
          WHEN conflict_pending = 1 THEN 1
          ELSE 0 END,
        taxonomy_conflict_pending = CASE
          WHEN conflict_pending = 1 AND conflict_copy_path LIKE '%.conflict.md' THEN 0
          WHEN conflict_pending = 1 AND remote_taxonomy_hash IS NOT NULL THEN 1
          WHEN conflict_pending = 1 THEN 1
          ELSE 0 END
        WHERE conflict_pending = 1;
      `);
    }

    db.exec('CREATE INDEX IF NOT EXISTS idx_sync_state_conflict ON sync_state (conflict_pending);');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_sync_state_body_conflict ON sync_state (body_conflict_pending);',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_sync_state_tax_conflict ON sync_state (taxonomy_conflict_pending);',
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_sync_state_delete ON sync_state (delete_pending);');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_sync_state_tax_apply ON sync_state (taxonomy_apply_pending);',
    );

    // Migration 4 (v4): media mirrors are named after the storageKey
    const mediaColumns = db.prepare("PRAGMA table_info('media_state');").all() as Array<
      Record<string, unknown>
    >;
    const mediaColumnNames = new Set(mediaColumns.map((c) => String(c.name)));
    if (!mediaColumnNames.has('markdown_ref')) {
      db.exec('ALTER TABLE media_state ADD COLUMN markdown_ref TEXT;');
    }

    // Migration 5 (v5): recreate media_state with storage_key as PRIMARY KEY,
    // separating local_content_hash (SHA-256) and remote_record_ref (media-record:<id>).
    if (currentVersion < 5) {
      const mediaCols = db.prepare("PRAGMA table_info('media_state');").all() as Array<
        Record<string, unknown>
      >;
      const mediaColNames = new Set(mediaCols.map((c) => String(c.name)));
      const storageKeyCol = mediaCols.find((c) => String(c.name) === 'storage_key');
      const isStorageKeyPk = storageKeyCol && Number(storageKeyCol.pk) > 0;

      if (!isStorageKeyPk) {
        db.exec('BEGIN TRANSACTION;');
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS media_state_v5 (
              storage_key TEXT PRIMARY KEY,
              media_id TEXT NOT NULL,
              local_content_hash TEXT,
              remote_record_ref TEXT,
              url TEXT NOT NULL,
              workspace_path TEXT,
              markdown_ref TEXT,
              status TEXT NOT NULL,
              uploaded_at INTEGER
            );
          `);

          if (mediaColNames.has('local_hash')) {
            const hasMarkdownRef = mediaColNames.has('markdown_ref');
            db.exec(`
              INSERT INTO media_state_v5 (
                storage_key,
                media_id,
                local_content_hash,
                remote_record_ref,
                url,
                workspace_path,
                markdown_ref,
                status,
                uploaded_at
              )
              SELECT
                COALESCE(
                  NULLIF(storage_key, ''),
                  CASE WHEN url LIKE '%/file/%' THEN substr(url, instr(url, '/file/') + 6) ELSE 'legacy_' || media_id END
                ) AS computed_key,
                MAX(media_id),
                MAX(CASE WHEN local_hash NOT LIKE 'media-record:%' THEN local_hash ELSE NULL END),
                MAX(CASE WHEN local_hash LIKE 'media-record:%' THEN local_hash ELSE NULL END),
                MAX(url),
                MAX(workspace_path),
                ${hasMarkdownRef ? 'MAX(markdown_ref)' : 'NULL'},
                MAX(status),
                MAX(uploaded_at)
              FROM media_state
              WHERE (storage_key IS NOT NULL AND storage_key != '') OR url LIKE '%/file/%'
              GROUP BY computed_key;
            `);
            db.exec('DROP TABLE media_state;');
          }
          db.exec('ALTER TABLE media_state_v5 RENAME TO media_state;');
          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_media_state_media_id ON media_state (media_id);
            CREATE INDEX IF NOT EXISTS idx_media_state_status ON media_state (status);
            CREATE INDEX IF NOT EXISTS idx_media_state_content_hash ON media_state (local_content_hash);
          `);
          db.exec('COMMIT;');
        } catch (err) {
          db.exec('ROLLBACK;');
          throw err;
        }
      }
    }

    db.exec(`PRAGMA user_version = ${CURRENT_CACHE_SCHEMA_VERSION};`);
  }

  // Create indexes that depend on migrated columns
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sync_state_conflict ON sync_state (conflict_pending);
    CREATE INDEX IF NOT EXISTS idx_media_state_content_hash ON media_state (local_content_hash);
  `);
}
