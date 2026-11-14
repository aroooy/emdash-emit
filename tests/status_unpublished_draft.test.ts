import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheDatabase } from '../src/db/cache.js';
import { getWorkspaceStatus } from '../src/sync/status.js';
import { serializeMarkdown, type Frontmatter } from '../src/utils/frontmatter.js';
import { calculateHash } from '../src/sync/pull.js';
import { createMcpServer } from '../src/mcp/server.js';

describe('Unpublished Draft Status Visualization (v0.1.24)', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-status-draft-test-'));
    cache = new CacheDatabase(path.join(tempDir, 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('sets hasUnpublishedDraft=true only for published articles with @draft: in remoteRev', () => {
    const pubWithDraftId = '01M77VFT15HSH2M1XW8MJPTCPQ';
    const pubCleanId = '01M77VFT15HSH2M1XW8MJPTCP1';
    const draftArticleId = '01M77VFT15HSH2M1XW8MJPTCP2';

    // 1. Published article with unpublished draft changes on remote
    const pubWithDraftPath = path.join(
      tempDir,
      'posts',
      'published',
      `20261113_${pubWithDraftId}-pub-draft.md`,
    );
    fs.mkdirSync(path.dirname(pubWithDraftPath), { recursive: true });
    const fm1: Frontmatter = {
      id: pubWithDraftId,
      slug: 'pub-draft',
      title: 'Published with Draft',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-13T10:00:00.000Z',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const content1 = serializeMarkdown(fm1, 'Published body with draft changes.', undefined, {
      hasDraftRevision: true,
    });
    expect(content1).toContain('status: published # draft revision');
    fs.writeFileSync(pubWithDraftPath, content1, 'utf8');
    cache.saveSyncState({
      id: pubWithDraftId,
      localFilePath: `posts/published/20261113_${pubWithDraftId}-pub-draft.md`,
      localHash: calculateHash(content1),
      remoteRev: '19@draft:01M7CD9YGWNPAEP1Z7NC8600ZD',
      status: 'published',
      slug: 'pub-draft',
      lastSyncedAt: 1000,
    });

    // 2. Clean published article (no unpublished draft)
    const pubCleanPath = path.join(
      tempDir,
      'posts',
      'published',
      `20261113_${pubCleanId}-pub-clean.md`,
    );
    const fm2: Frontmatter = {
      id: pubCleanId,
      slug: 'pub-clean',
      title: 'Published Clean',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-13T10:00:00.000Z',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const content2 = serializeMarkdown(fm2, 'Clean published body.');
    fs.writeFileSync(pubCleanPath, content2, 'utf8');
    cache.saveSyncState({
      id: pubCleanId,
      localFilePath: `posts/published/20261113_${pubCleanId}-pub-clean.md`,
      localHash: calculateHash(content2),
      remoteRev: '19@live:01M7CCGC748FQWMC3FDBP4WDY7',
      status: 'published',
      slug: 'pub-clean',
      lastSyncedAt: 1000,
    });

    // 3. Normal draft article
    const draftPath = path.join(
      tempDir,
      'posts',
      'draft',
      `20261114_${draftArticleId}-draft-article.md`,
    );
    fs.mkdirSync(path.dirname(draftPath), { recursive: true });
    const fm3: Frontmatter = {
      id: draftArticleId,
      slug: 'draft-article',
      title: 'Draft Article',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const content3 = serializeMarkdown(fm3, 'Draft body.');
    fs.writeFileSync(draftPath, content3, 'utf8');
    cache.saveSyncState({
      id: draftArticleId,
      localFilePath: `posts/draft/20261114_${draftArticleId}-draft-article.md`,
      localHash: calculateHash(content3),
      remoteRev: '3@draft:01M7DRAFT000000000000000000',
      status: 'draft',
      slug: 'draft-article',
      lastSyncedAt: 1000,
    });

    const statusRes = getWorkspaceStatus(tempDir, cache, 'posts');
    expect(statusRes.items).toHaveLength(3);

    const itemWithDraft = statusRes.items.find((i) => i.id === pubWithDraftId);
    expect(itemWithDraft).toBeDefined();
    expect(itemWithDraft?.status).toBe('published');
    expect(itemWithDraft?.hasUnpublishedDraft).toBe(true);

    const itemClean = statusRes.items.find((i) => i.id === pubCleanId);
    expect(itemClean).toBeDefined();
    expect(itemClean?.status).toBe('published');
    expect(itemClean?.hasUnpublishedDraft).toBeUndefined();

    const itemDraft = statusRes.items.find((i) => i.id === draftArticleId);
    expect(itemDraft).toBeDefined();
    expect(itemDraft?.status).toBe('draft');
    expect(itemDraft?.hasUnpublishedDraft).toBeUndefined();
  });

  it('transparents hasUnpublishedDraft in MCP sync_status tool response', async () => {
    const articleId = '01M77VFT15HSH2M1XW8MJPTCPQ';
    const emitDir = path.join(tempDir, '.emit');
    fs.mkdirSync(emitDir, { recursive: true });
    fs.writeFileSync(
      path.join(emitDir, 'config.json'),
      JSON.stringify({ origin: 'https://example.com', token: 'fake-token' }),
      'utf8',
    );

    const pubPath = path.join(tempDir, 'posts', 'published', `20261113_${articleId}-pub-draft.md`);
    fs.mkdirSync(path.dirname(pubPath), { recursive: true });
    const fm: Frontmatter = {
      id: articleId,
      slug: 'pub-draft',
      title: 'Published with Draft',
      collection: 'posts',
      status: 'published',
      publishedAt: '2026-11-13T10:00:00.000Z',
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };
    const content = serializeMarkdown(fm, 'Body content.');
    fs.writeFileSync(pubPath, content, 'utf8');

    // Save sync state with @draft: composite rev
    const diskCache = new CacheDatabase(path.join(emitDir, 'cache.db'));
    diskCache.saveSyncState({
      id: articleId,
      localFilePath: `posts/published/20261113_${articleId}-pub-draft.md`,
      localHash: calculateHash(content),
      remoteRev: '19@draft:01M7CD9YGWNPAEP1Z7NC8600ZD',
      status: 'published',
      slug: 'pub-draft',
      lastSyncedAt: 1000,
    });
    diskCache.close();

    const server = createMcpServer({ workspaceRoot: tempDir });
    const registered = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }
        >;
      }
    )._registeredTools;

    const res = await registered['sync_status'].handler({});
    const payload = JSON.parse(res.content[0].text);

    const item = payload.recentArticles.find((i: { id: string }) => i.id === articleId);
    expect(item).toBeDefined();
    expect(item.hasUnpublishedDraft).toBe(true);
    expect(item.status).toBe('published');
  });
});
