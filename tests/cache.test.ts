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
import {
  CacheDatabase,
  type BaseSnapshot,
  type CachedEntry,
  type SyncState,
} from '../src/db/cache.js';

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
      localFilePath: 'posts/draft/01M67MP2W0VKCK2DFWM166CR24-my-post.md',
      localHash: 'hash_local_123',
      remoteRev: 'rev_remote_456',
      status: 'draft',
      slug: 'my-post',
      lastSyncedAt: 1730550200,
    };

    cache.saveSyncState(state);

    const byId = cache.getSyncState(state.id);
    expect(byId).toEqual(state);

    const byPath = cache.getSyncStateByPath(state.localFilePath);
    expect(byPath).toEqual(state);

    // Path lookup for non-existing path returns null
    expect(cache.getSyncStateByPath('posts/draft/non-existing.md')).toBeNull();

    // Delete
    cache.deleteSyncState(state.id);
    expect(cache.getSyncState(state.id)).toBeNull();
  });

  it('tracks media_state records for local draft upload idempotency and orphan recovery', () => {
    const localHash = 'a'.repeat(64);
    cache.saveMediaState({
      localHash,
      mediaId: '01M6TF1XXBS2KC9EVYG6RBT0J0',
      storageKey: '01M6TF1XXBSC06QQG9M648B4K3.png',
      url: '/_emdash/api/media/file/01M6TF1XXBSC06QQG9M648B4K3.png',
      status: 'pending',
      uploadedAt: 1730550300,
    });

    const pending = cache.getMediaState(localHash);
    expect(pending?.status).toBe('pending');
    expect(pending?.mediaId).toBe('01M6TF1XXBS2KC9EVYG6RBT0J0');

    // Upsert on confirm (storageKey rewritten to double-ULID, status -> ready)
    cache.saveMediaState({
      localHash,
      mediaId: '01M6TF1XXBS2KC9EVYG6RBT0J0',
      storageKey: '01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png',
      url: '/_emdash/api/media/file/01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png',
      workspacePath: 'media/20261107_01M6TF1XXBS2KC9EVYG6RBT0J0-spike.png',
      status: 'ready',
      uploadedAt: 1730550310,
    });

    const ready = cache.getMediaStateByMediaId('01M6TF1XXBS2KC9EVYG6RBT0J0');
    expect(ready?.status).toBe('ready');
    expect(ready?.storageKey).toBe('01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png');
    expect(ready?.workspacePath).toBe('media/20261107_01M6TF1XXBS2KC9EVYG6RBT0J0-spike.png');

    expect(cache.listMediaStates('ready')).toHaveLength(1);
    expect(cache.listMediaStates('pending')).toHaveLength(0);

    cache.deleteMediaState(localHash);
    expect(cache.getMediaState(localHash)).toBeNull();
  });
});
