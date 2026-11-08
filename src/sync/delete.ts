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
import path from 'node:path';
import type { CacheDatabase } from '../db/cache.js';
import { parseMarkdown } from '../utils/frontmatter.js';
import { calculateHash, CONFLICTS_SUBDIR } from './pull.js';
import { resolveArticleTarget } from './diff.js';
import { ApiError } from '../client/error.js';

export class UnpushedModificationsError extends Error {
  public readonly code = 'UNPUSHED_CHANGES_PROTECTION';
  public readonly filePath: string;
  public readonly id: string;
  public readonly suggestion: string;

  constructor(details: { filePath: string; id: string }) {
    const msg = [
      `❌ ABORT: File contains unpushed local modifications: ${details.filePath}`,
      `   Local changes would be lost permanently.`,
      `   💡 Suggestion: Run "emit push" (or sync_push) to save changes, or discard them first.`,
    ].join('\n');
    super(msg);
    this.name = 'UnpushedModificationsError';
    this.filePath = details.filePath;
    this.id = details.id;
    this.suggestion = 'Run "emit push" (or sync_push) to save changes, or discard them first.';
  }
}

export class PublishedArticleDeletionForbiddenError extends Error {
  public readonly code = 'PUBLISHED_ARTICLE_PROTECTION';
  public readonly filePath: string;
  public readonly id: string;
  public readonly suggestion: string;

  constructor(details: { filePath: string; id: string }) {
    const msg = [
      `❌ ABORT: Article is published: ${details.filePath}`,
      `   Deleting a live published article is an irreversible public action.`,
      `   💡 Suggestion: Pass --allow-delete-published (or allowDeletePublished: true in MCP) to confirm.`,
    ].join('\n');
    super(msg);
    this.name = 'PublishedArticleDeletionForbiddenError';
    this.filePath = details.filePath;
    this.id = details.id;
    this.suggestion =
      'Pass --allow-delete-published (or allowDeletePublished: true in MCP) to confirm.';
  }
}

/**
 * Scans article Markdown body to detect referenced media files in media/.
 */
export function scanArticleMediaReferences(bodyMarkdown: string): string[] {
  const references = new Set<string>();

  // 1. Markdown image syntax: ![alt](url)
  const mdRegex = /!\[.*?\]\(([^)\s]+)(?:\s+["'].*?["'])?\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdRegex.exec(bodyMarkdown)) !== null) {
    const url = match[1].trim();
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('data:')) {
      references.add(url);
    }
  }

  // 2. HTML <img> tags: <img src="...">
  const htmlRegex = /<img[^>]+src=["']([^"']+)["']/gi;
  while ((match = htmlRegex.exec(bodyMarkdown)) !== null) {
    const url = match[1].trim();
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('data:')) {
      references.add(url);
    }
  }

  return Array.from(references).sort();
}

export interface DeleteArticleOptions {
  workspaceRoot: string;
  cache: CacheDatabase;
  filePath?: string;
  id?: string;
  collection?: string;
  allowDeletePublished?: boolean;
  dryRun?: boolean;
  origin?: string;
  token?: string;
  refreshToken?: string;
  fetchFn?: typeof fetch;
}

export interface DeleteArticleResult {
  success: boolean;
  dryRun: boolean;
  id: string;
  slug: string;
  title: string;
  status: string;
  filePath: string;
  bodyLineCount: number;
  referencedMedia: string[];
  rescueFilePath?: string;
  remoteDeleted: boolean;
  message: string;
}

/**
 * Safely deletes an article with strict unpushed modification protection,
 * published article protection, automatic rescue backup, and remote API deletion.
 */
export async function deleteArticle(options: DeleteArticleOptions): Promise<DeleteArticleResult> {
  const collection = options.collection || 'posts';
  const { id: targetId, filePath: targetFile } = resolveArticleTarget({
    workspaceRoot: options.workspaceRoot,
    cache: options.cache,
    filePath: options.filePath,
    id: options.id,
  });

  if (!targetFile) {
    throw new Error(
      `❌ Could not resolve article file path for deletion (id: "${options.id || ''}", filePath: "${options.filePath || ''}").`,
    );
  }

  const fullLocalPath = path.join(options.workspaceRoot, targetFile);
  if (!fs.existsSync(fullLocalPath)) {
    throw new Error(`❌ Local file not found: ${targetFile}`);
  }

  const rawContent = fs.readFileSync(fullLocalPath, 'utf8');
  const parsed = parseMarkdown(rawContent);
  const articleId = parsed.frontmatter.id || targetId || 'unknown';
  const articleStatus = parsed.frontmatter.status || 'draft';
  const articleSlug = parsed.frontmatter.slug || '';
  const articleTitle = parsed.frontmatter.title || articleSlug;
  const bodyLineCount = parsed.body.split('\n').length;
  const referencedMedia = scanArticleMediaReferences(parsed.body);

  // Safety Guard 1: Unpushed Modifications Protection
  const syncState = options.cache.getSyncState(articleId);
  const currentHash = calculateHash(rawContent);
  if (syncState && syncState.localHash !== currentHash) {
    throw new UnpushedModificationsError({ filePath: targetFile, id: articleId });
  }

  // Safety Guard 2: Published Article Deletion Protection
  if (articleStatus === 'published' && !options.allowDeletePublished) {
    throw new PublishedArticleDeletionForbiddenError({ filePath: targetFile, id: articleId });
  }

  // Dry-run mode: return preview without modifying anything
  if (options.dryRun) {
    const mediaNote =
      referencedMedia.length > 0
        ? ` Note: ${referencedMedia.length} referenced media file(s) would be preserved in media/.`
        : '';
    return {
      success: true,
      dryRun: true,
      id: articleId,
      slug: articleSlug,
      title: articleTitle,
      status: articleStatus,
      filePath: targetFile,
      bodyLineCount,
      referencedMedia,
      remoteDeleted: false,
      message: `[DRY-RUN] Article ${articleId} (${targetFile}) would be deleted.${mediaNote}`,
    };
  }

  // Remote API deletion (DELETE /_emdash/api/content/{collection}/{id})
  // Attempt remote deletion first before touching local files or rescue directories
  let remoteDeleted = false;
  if (options.origin && options.token && articleId && articleId !== 'unknown') {
    const fetchFn = options.fetchFn || globalThis.fetch;
    const url = new URL(`/_emdash/api/content/${collection}/${articleId}`, options.origin);

    let res: Response;
    try {
      res = await fetchFn(url.toString(), {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: 'application/json',
        },
      });
    } catch (fetchErr) {
      throw new ApiError({
        endpoint: url.pathname,
        code: 'REMOTE_DELETE_FAILED',
        status: 0,
        message: `Network error during remote DELETE: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
        suggestion: 'Verify network connectivity, origin URL, and remote server status.',
      });
    }

    if (res.ok || res.status === 204) {
      remoteDeleted = true;
    } else if (res.status === 404) {
      // Already absent on remote server
      remoteDeleted = false;
    } else {
      // Remote deletion failed: abort before deleting local file or writing rescue to prevent desync
      const errText = await res.text().catch(() => '');
      throw new ApiError({
        endpoint: url.pathname,
        code: 'REMOTE_DELETE_FAILED',
        status: res.status,
        message: errText || `Remote DELETE failed with status ${res.status}`,
        suggestion: 'Verify network connectivity, token permissions, and article status.',
      });
    }
  }

  // Rescue Backup: save copy to <collection>/conflicts/<name>.deleted.md only after remote is confirmed
  const conflictsDir = path.join(options.workspaceRoot, collection, CONFLICTS_SUBDIR);
  fs.mkdirSync(conflictsDir, { recursive: true });
  const filenameBase = path.basename(targetFile, '.md');
  const rescueRelPath = path.join(collection, CONFLICTS_SUBDIR, `${filenameBase}.deleted.md`);
  const rescueFullPath = path.join(options.workspaceRoot, rescueRelPath);
  fs.writeFileSync(rescueFullPath, rawContent, 'utf8');

  // Delete local file from disk
  fs.unlinkSync(fullLocalPath);

  // Remove cache DB records (entries, base_snapshots, sync_state)
  options.cache.deleteEntry(articleId);

  const mediaMsg =
    referencedMedia.length > 0
      ? `\nℹ️ Note: ${referencedMedia.length} referenced media file(s) remain safely preserved in media/.`
      : '';

  return {
    success: true,
    dryRun: false,
    id: articleId,
    slug: articleSlug,
    title: articleTitle,
    status: articleStatus,
    filePath: targetFile,
    bodyLineCount,
    referencedMedia,
    rescueFilePath: rescueRelPath,
    remoteDeleted,
    message:
      `✅ Successfully deleted article ${articleId} (${targetFile}).` +
      `\n🩹 Rescue backup saved to: ${rescueRelPath}` +
      (remoteDeleted ? '\n🌐 Remote article deleted from server.' : '') +
      mediaMsg,
  };
}
