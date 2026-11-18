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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheDatabase } from '../src/db/cache.js';
import { initWorkspace, loadConfig } from '../src/utils/config.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';
import { calculateHash } from '../src/sync/workspace/index.js';
import { runWorkspaceDoctor, type DoctorReport } from '../src/sync/doctor.js';

/**
 * Characterization snapshot suite for `runWorkspaceDoctor` (v0.1.37 Phase 1 Part B).
 *
 * These tests lock in the EXACT observable output of the monolithic doctor today so the planned
 * section-by-section extraction can be proven behavior-preserving. Any change to a check's id,
 * name, status, message wording, details payload, or ordering must fail here and be justified
 * deliberately — not silently absorbed by a snapshot update.
 */

/** Normalizes volatile fields (absolute paths, package version) so snapshots stay stable. */
function normalizeReport(report: DoctorReport): unknown {
  const json = JSON.stringify(
    report,
    (key, value) => (key === 'workspace' ? '<WORKSPACE_ROOT>' : value),
    2,
  );
  // The running package version legitimately changes across releases; pin it in the snapshot.
  return JSON.parse(json.replace(/\d+\.\d+\.\d+/g, '<VERSION>'));
}

describe('Doctor Characterization Snapshots (v0.1.37 Phase 1 Part B)', () => {
  let tempDir: string;
  let cache: CacheDatabase;
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-doctor-snap-'));
    // Isolate the MCP heartbeat file so an ambient ~/.config/emit/mcp_state.json on a developer's
    // machine cannot add or remove the `mcp_process` check from a snapshot.
    process.env.HOME = tempDir;
    initWorkspace(tempDir, {
      origin: 'https://aroooy.net',
      createdWithVersion: '0.1.9',
      lastSyncedVersion: '0.1.10',
    });
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (origHome !== undefined) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    vi.restoreAllMocks();
  });

  function writeArticle(
    id: string,
    opts?: { status?: 'draft' | 'published'; title?: string; body?: string },
  ): string {
    const frontmatter: Frontmatter = {
      id,
      slug: `snap-${id.toLowerCase()}`,
      title: opts?.title || `Snap Article ${id.slice(-4)}`,
      collection: 'posts',
      status: opts?.status || 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const content = serializeMarkdown(frontmatter, opts?.body ?? 'Snapshot body content.\n');
    const relPath = path.join(
      'posts',
      opts?.status || 'draft',
      `20261108_${id}-${frontmatter.slug}.md`,
    );
    const fullPath = path.join(tempDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    return relPath;
  }

  function trackArticle(id: string, relPath: string): void {
    const content = fs.readFileSync(path.join(tempDir, relPath), 'utf8');
    const hash = calculateHash(content);
    cache.saveSyncState({
      id,
      localFilePath: relPath,
      localHash: hash,
      remoteRev: 'rev-1',
      status: 'draft',
      slug: `snap-${id.toLowerCase()}`,
      lastSyncedAt: 1700000000,
    });
    cache.saveBaseSnapshot({
      id,
      rev: 'rev-1',
      frontmatterYaml: JSON.stringify({
        id,
        slug: `snap-${id.toLowerCase()}`,
        title: `Snap Article ${id.slice(-4)}`,
        collection: 'posts',
        status: 'draft',
        locale: 'ja',
        taxonomies: {},
        bylines: [],
      }),
      bodyMarkdown: 'Snapshot body content.\n',
      hash,
      savedAt: 1700000000,
    });
  }

  it('healthy single-article workspace matches the full check-by-check snapshot', async () => {
    const id = '01M67SNAPSH0T0000000000001';
    const relPath = writeArticle(id);
    trackArticle(id, relPath);

    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config: loadConfig(tempDir),
      profileName: 'default',
      profileOrigin: 'https://aroooy.net',
    });

    expect(normalizeReport(report)).toMatchSnapshot();
  });

  it('mixed-defect workspace matches the full check-by-check snapshot', async () => {
    // Unrecoverable frontmatter.
    fs.mkdirSync(path.join(tempDir, 'posts', 'draft'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'posts', 'draft', 'broken.md'),
      ['---', 'id: not-a-ulid', 'slug:', '  bad: [', '---', 'body'].join('\n'),
      'utf8',
    );
    // Healable (percent-encoded taxonomy) frontmatter.
    fs.writeFileSync(
      path.join(tempDir, 'posts', 'draft', 'healable.md'),
      [
        '---',
        'id: 01M67SNAPSH0T0000000000002',
        'slug: healable-post',
        'title: Healable Post',
        'status: draft',
        'taxonomies:',
        '  categories:',
        '    - %e6%9c%aa%e5%88%86%e9%a1%9e',
        '---',
        'healable body',
      ].join('\n'),
      'utf8',
    );
    // Quarantine copies. `listConflicts` sorts by mtime (newest first), and same-millisecond writes
    // have nondeterministic mtimes on APFS, so stagger them to keep the snapshot order stable.
    const conflictsDir = path.join(tempDir, 'posts', 'conflicts');
    fs.mkdirSync(conflictsDir, { recursive: true });
    fs.writeFileSync(path.join(conflictsDir, 'x.conflict.md'), 'conflict copy', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 10));
    fs.writeFileSync(path.join(conflictsDir, 'y.deleted.md'), 'deleted copy', 'utf8');

    // Pending flags on an article whose file no longer exists.
    cache.saveSyncState({
      id: '01M67SNAPSH0T0000000000003',
      localFilePath: 'posts/draft/gone.md',
      localHash: 'stale-hash',
      remoteRev: 'rev-9',
      status: 'draft',
      slug: 'ghost-post',
      lastSyncedAt: 1700000000,
      taxonomyApplyPending: 1,
      deletePending: 1,
    });

    // Untracked valid article -> sync_status warning.
    writeArticle('01M67SNAPSH0T0000000000004');

    // Media: an article body referencing a storageKey nothing can resolve, plus a legacy_* mirror.
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'legacy_orphan.png'), 'residue', 'utf8');
    fs.writeFileSync(
      path.join(tempDir, 'posts', 'draft', 'media-refs.md'),
      [
        '---',
        'id: 01M67SNAPSH0T0000000000005',
        'slug: media-ref-post',
        'title: Media Ref Post',
        'status: draft',
        '---',
        '![missing](/_emdash/api/media/file/01M67MISSING000000000000AA.png)',
        '```',
        '![fenced](/_emdash/api/media/file/01M67FENCED00000000000000A.png)',
        '```',
      ].join('\n'),
      'utf8',
    );

    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config: loadConfig(tempDir),
      profileOrigin: 'https://other.example.com',
    });

    expect(normalizeReport(report)).toMatchSnapshot();
  });

  it('media library census and file-route probe match the snapshot', async () => {
    fs.mkdirSync(path.join(tempDir, 'posts', 'draft'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'posts', 'draft', 'media-census.md'),
      [
        '---',
        'id: 01M67SNAPSH0T0000000000006',
        'slug: census-post',
        'title: Census Post',
        'status: draft',
        '---',
        '![served](/_emdash/api/media/file/served-key.png)',
        '![gone](/_emdash/api/media/file/absent-key.png)',
      ].join('\n'),
      'utf8',
    );
    const mediaDir = path.join(tempDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'served-key.png'), 'binary', 'utf8');

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (init?.method === 'HEAD') {
        return url.includes('served-key')
          ? new Response(null, { status: 200 })
          : new Response(null, { status: 404 });
      }
      if (url.includes('/_emdash/api/media?')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: '01M67SNAPSH0T000000000000A',
                storageKey: 'served-key.png',
                filename: 'served-key.png',
              },
            ],
            totalCount: 2,
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const report = await runWorkspaceDoctor({
      workspaceRoot: tempDir,
      cache,
      config: loadConfig(tempDir),
      checkMediaUrls: true,
      checkMediaLibrary: true,
      token: 'test-token',
      fetchFn: mockFetch,
    });

    expect(normalizeReport(report)).toMatchSnapshot();
  });
});
