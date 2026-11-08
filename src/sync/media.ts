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
import yaml from 'js-yaml';
import { unwrapEnvelope } from '../client/api.js';
import { ApiError } from '../client/error.js';
import { createAuthedFetch } from '../client/http.js';
import { extractMediaUlid } from '../client/mapper.js';
import { toRootRelativeMediaUrl } from '../client/media.js';
import {
  formatDatePrefix,
  sanitizeTitleForFilename,
  parseMarkdown,
  lenientRepairMarkdownFrontmatter,
} from '../utils/frontmatter.js';
import { scanArticleMediaReferences } from './delete.js';

export interface EmDashMediaItem {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  width?: number | null;
  height?: number | null;
  alt?: string | null;
  caption?: string | null;
  url?: string;
  storageKey?: string;
  contentHash?: string | null;
  status?: 'pending' | 'ready' | 'failed';
  createdAt?: string;
}

export function buildMediaMetaDoc(
  item: EmDashMediaItem,
  origin: string,
  existingMeta?: Record<string, unknown> | null,
): Record<string, unknown> {
  const storageKey =
    (typeof item.storageKey === 'string' && item.storageKey ? item.storageKey : undefined) ??
    (typeof existingMeta?.storageKey === 'string' && existingMeta.storageKey
      ? existingMeta.storageKey
      : '');
  const canonicalUrl =
    item.url ||
    (storageKey
      ? `/_emdash/api/media/file/${storageKey}`
      : typeof existingMeta?.url === 'string'
        ? existingMeta.url
        : '');
  const rootRelativeUrl = canonicalUrl
    ? toRootRelativeMediaUrl(canonicalUrl, storageKey, origin)
    : '';
  const resolvedAlt =
    item.alt !== undefined && item.alt !== null && item.alt !== ''
      ? item.alt
      : typeof existingMeta?.alt === 'string'
        ? existingMeta.alt
        : '';
  const resolvedCaption =
    item.caption !== undefined && item.caption !== null && item.caption !== ''
      ? item.caption
      : typeof existingMeta?.caption === 'string'
        ? existingMeta.caption
        : '';
  const resolvedContentHash =
    typeof item.contentHash === 'string' && item.contentHash
      ? item.contentHash
      : typeof existingMeta?.contentHash === 'string' && existingMeta.contentHash
        ? existingMeta.contentHash
        : null;

  return {
    id: item.id,
    filename: item.filename,
    mimeType: item.mimeType,
    size: item.size,
    width: item.width ?? (typeof existingMeta?.width === 'number' ? existingMeta.width : null),
    height: item.height ?? (typeof existingMeta?.height === 'number' ? existingMeta.height : null),
    alt: resolvedAlt,
    caption: resolvedCaption,
    storageKey,
    contentHash: resolvedContentHash,
    status:
      item.status ?? (typeof existingMeta?.status === 'string' ? existingMeta.status : 'ready'),
    url: rootRelativeUrl,
    createdAt:
      item.createdAt || (typeof existingMeta?.createdAt === 'string' ? existingMeta.createdAt : ''),
  };
}

export interface PromoteDraftMediaOptions {
  workspaceRoot: string;
  origin: string;
  draftAbsPath: string;
  item: EmDashMediaItem;
  removeDraft?: boolean;
}

/**
 * Moves a file from src to dest, falling back to copy + unlink when src and dest
 * reside on different filesystems (`EXDEV`).
 */
function moveFileSafe(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

/**
 * Removes any stale duplicate files in `media/` that share the same 26-char `mediaId`
 * but have a different baseName (e.g. a fabricated date prefix from an earlier local promotion).
 */
function cleanupDuplicateMediaFilesForId(
  mediaDir: string,
  mediaId: string,
  canonicalBaseName: string,
): void {
  if (!fs.existsSync(mediaDir)) return;
  const entries = fs.readdirSync(mediaDir);
  for (const entry of entries) {
    const match = entry.replace(/^\d{8}_/, '').match(/^([0-9A-Z]{26})-/);
    if (!match || match[1] !== mediaId) continue;
    const entryBase = entry.replace(/\.[^.]+$/, '');
    if (entryBase !== canonicalBaseName) {
      try {
        fs.unlinkSync(path.join(mediaDir, entry));
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Promotes a local draft image from media/drafts/<name> into the canonical
 * media/<yyyyMMdd>_<mediaId>-<sanitizedName>.<ext> location alongside its .yaml metadata.
 * Returns the workspace-relative path of the promoted binary file.
 */
export function promoteDraftMediaFile(options: PromoteDraftMediaOptions): string {
  const { workspaceRoot, origin, draftAbsPath, item, removeDraft = true } = options;
  const mediaDir = path.join(workspaceRoot, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const ext =
    path.extname(item.filename) ||
    path.extname(draftAbsPath) ||
    (item.mimeType.includes('png') ? '.png' : '.jpg');
  const baseWithoutExt = path.basename(item.filename, path.extname(item.filename));
  const sanitizedBase = sanitizeTitleForFilename(baseWithoutExt);
  const datePrefix = formatDatePrefix(item.createdAt || new Date().toISOString());
  const baseName = `${datePrefix}${item.id}-${sanitizedBase}`;

  const yamlPath = path.join(mediaDir, `${baseName}.yaml`);
  let existingMeta: Record<string, unknown> | null = null;
  if (fs.existsSync(yamlPath)) {
    try {
      existingMeta = yaml.load(fs.readFileSync(yamlPath, 'utf8')) as Record<string, unknown> | null;
    } catch {
      existingMeta = null;
    }
  }
  const metaDoc = buildMediaMetaDoc(item, origin, existingMeta);
  fs.writeFileSync(
    yamlPath,
    yaml.dump(metaDoc, { indent: 2, quotingType: '"', forceQuotes: false, lineWidth: -1 }),
    'utf8',
  );

  const targetFilePath = path.join(mediaDir, `${baseName}${ext}`);
  if (fs.existsSync(draftAbsPath)) {
    if (removeDraft) {
      moveFileSafe(draftAbsPath, targetFilePath);
    } else {
      fs.copyFileSync(draftAbsPath, targetFilePath);
    }
  }

  cleanupDuplicateMediaFilesForId(mediaDir, item.id, baseName);

  return path.posix.join('media', `${baseName}${ext}`);
}

/**
 * Collects all media ULIDs referenced by an article content (frontmatter featuredImage + body images).
 */
export function collectArticleReferencedMediaIds(content: string): string[] {
  const ids = new Set<string>();

  let frontmatter: Record<string, unknown> | null = null;
  let body = content;

  // Try extracting YAML block directly if present
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (fmMatch) {
    try {
      frontmatter = (yaml.load(fmMatch[1]) as Record<string, unknown>) || null;
      body = content.slice(fmMatch[0].length);
    } catch {
      // Keep going
    }
  }

  if (!frontmatter) {
    try {
      const parsed = parseMarkdown(content);
      frontmatter = parsed.frontmatter as unknown as Record<string, unknown>;
      body = parsed.body;
    } catch {
      try {
        const healed = lenientRepairMarkdownFrontmatter(content);
        if (healed) {
          const parsed = parseMarkdown(healed);
          frontmatter = parsed.frontmatter as unknown as Record<string, unknown>;
          body = parsed.body;
        }
      } catch {
        // Fallback: search raw content
      }
    }
  }

  // 1. Frontmatter featuredImage
  if (frontmatter && frontmatter.featuredImage) {
    const ulid = extractMediaUlid(frontmatter.featuredImage);
    if (ulid) {
      ids.add(ulid);
    }
  } else {
    // Regex fallback for featuredImage in raw text if YAML parsing failed
    const rawFiMatch = content.match(/featuredImage:\s*["']?([0-9A-HJ-NP-Z]{26})["']?/i);
    if (rawFiMatch) {
      ids.add(rawFiMatch[1].toUpperCase());
    }
  }

  // 2. Body Markdown & HTML image references
  const refs = scanArticleMediaReferences(body);
  for (const ref of refs) {
    const ulid = extractMediaUlid(ref);
    if (ulid) {
      ids.add(ulid);
    } else {
      const match = ref.match(/(?:^|\/)(?:\d{8}_)?([0-9A-HJ-NP-Z]{26})-/i);
      if (match) {
        ids.add(match[1].toUpperCase());
      }
    }
  }

  // 3. URLs matching /_emdash/api/media/file/<ULID> or /media/<ULID>
  const mediaUrlRegex = /(?:\/media\/file\/|\/media\/)([0-9A-HJ-NP-Z]{26})/gi;
  let m: RegExpExecArray | null;
  while ((m = mediaUrlRegex.exec(body)) !== null) {
    ids.add(m[1].toUpperCase());
  }

  return Array.from(ids).sort();
}

/**
 * Persists YAML companion metadata and downloads the binary file for a single media item.
 */
async function syncSingleMediaItem(options: {
  item: EmDashMediaItem;
  mediaDir: string;
  origin: string;
  token: string;
  downloadFiles: boolean;
  fetchFn: typeof fetch;
}): Promise<{ downloaded: boolean; skipped: boolean; baseName: string }> {
  const { item, mediaDir, origin, token, downloadFiles, fetchFn } = options;
  const ext = path.extname(item.filename);
  const baseWithoutExt = path.basename(item.filename, ext);
  const sanitizedBase = sanitizeTitleForFilename(baseWithoutExt);
  const datePrefix = formatDatePrefix(item.createdAt);
  const baseName = `${datePrefix}${item.id}-${sanitizedBase}`;
  const oldBaseName = `${item.id}-${sanitizedBase}`;

  // Clean up old un-prefixed YAML if migrating, and load any existing metadata for this media ID
  const oldYamlPath = path.join(mediaDir, `${oldBaseName}.yaml`);
  const yamlPath = path.join(mediaDir, `${baseName}.yaml`);
  let existingMeta: Record<string, unknown> | null = null;
  if (fs.existsSync(yamlPath)) {
    try {
      existingMeta = yaml.load(fs.readFileSync(yamlPath, 'utf8')) as Record<string, unknown> | null;
    } catch {
      existingMeta = null;
    }
  } else {
    // Check if an older or differently-dated YAML for the same item.id exists
    const existingFiles = fs.readdirSync(mediaDir);
    const matchingYaml = existingFiles.find(
      (f) => f.endsWith('.yaml') && (f.includes(`_${item.id}-`) || f.startsWith(`${item.id}-`)),
    );
    if (matchingYaml) {
      try {
        existingMeta = yaml.load(
          fs.readFileSync(path.join(mediaDir, matchingYaml), 'utf8'),
        ) as Record<string, unknown> | null;
      } catch {
        existingMeta = null;
      }
    }
  }
  if (oldYamlPath !== yamlPath && fs.existsSync(oldYamlPath)) {
    try {
      fs.unlinkSync(oldYamlPath);
    } catch {}
  }

  // 1. Write YAML metadata
  const metaDoc = buildMediaMetaDoc(item, origin, existingMeta);
  fs.writeFileSync(
    yamlPath,
    yaml.dump(metaDoc, { indent: 2, quotingType: '"', forceQuotes: false, lineWidth: -1 }),
    'utf8',
  );

  let downloaded = false;
  let skipped = false;

  // 2. Download binary file if enabled and url is present
  const canonicalDownloadPath =
    item.url || (item.storageKey ? `/_emdash/api/media/file/${item.storageKey}` : '');
  if (downloadFiles && canonicalDownloadPath) {
    const fileExt = ext || (item.mimeType.includes('png') ? '.png' : '.jpg');
    const oldFilePath = path.join(mediaDir, `${oldBaseName}${fileExt}`);
    const targetFilePath = path.join(mediaDir, `${baseName}${fileExt}`);

    // Migrate/rename old or differently-dated file for the same media ID if already present
    if (!fs.existsSync(targetFilePath)) {
      const candidates = [
        oldFilePath,
        ...fs
          .readdirSync(mediaDir)
          .filter(
            (f) =>
              !f.endsWith('.yaml') && (f.includes(`_${item.id}-`) || f.startsWith(`${item.id}-`)),
          )
          .map((f) => path.join(mediaDir, f)),
      ];
      for (const candidate of candidates) {
        if (candidate !== targetFilePath && fs.existsSync(candidate)) {
          try {
            const stat = fs.statSync(candidate);
            if (stat.size === item.size) {
              moveFileSafe(candidate, targetFilePath);
              break;
            }
          } catch {}
        }
      }
    }

    // Avoid re-downloading if already present and matches size
    let shouldDownload = true;
    if (fs.existsSync(targetFilePath)) {
      const stat = fs.statSync(targetFilePath);
      if (stat.size === item.size) {
        shouldDownload = false;
        skipped = true;
      }
    }

    if (shouldDownload) {
      try {
        const downloadUrl = new URL(canonicalDownloadPath, origin).toString();
        const fileRes = await fetchFn(downloadUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        if (fileRes.ok) {
          const buffer = Buffer.from(await fileRes.arrayBuffer());
          fs.writeFileSync(targetFilePath, buffer);
          downloaded = true;
        }
      } catch {
        // Ignore individual download failures
      }
    }
  }

  // Clean up any duplicate files with the same media ID but a different datePrefix/baseName
  cleanupDuplicateMediaFilesForId(mediaDir, item.id, baseName);

  return { downloaded, skipped, baseName };
}

export interface PullMediaOptions {
  workspaceRoot: string;
  origin: string;
  token: string;
  refreshToken?: string;
  article?: string;
  collection?: string;
  limit?: number;
  all?: boolean;
  downloadFiles?: boolean;
  prune?: boolean;
  fetchFn?: typeof fetch;
}

export interface PullMediaResult {
  total: number;
  downloaded: number;
  skipped: number;
  deleted?: number;
  failed?: number;
  articleId?: string;
  mediaIds?: string[];
}

/**
 * Pulls media referenced by a specific article (by ULID or file path).
 */
export async function pullArticleMedia(options: {
  workspaceRoot: string;
  origin: string;
  token: string;
  refreshToken?: string;
  article: string;
  collection?: string;
  downloadFiles?: boolean;
  fetchFn?: typeof fetch;
}): Promise<PullMediaResult> {
  const fetchFn = createAuthedFetch(options);
  const collection = options.collection || 'posts';
  const downloadFiles = options.downloadFiles !== false;
  const mediaDir = path.join(options.workspaceRoot, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  let articleId = options.article;
  let articleContent: string | null = null;

  // 1. Try resolving as direct file path
  const directPath = path.isAbsolute(options.article)
    ? options.article
    : path.resolve(options.workspaceRoot, options.article);

  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    articleContent = fs.readFileSync(directPath, 'utf8');
    try {
      const parsed = parseMarkdown(articleContent);
      articleId = parsed.frontmatter.id || articleId;
    } catch {
      // Keep articleId as fallback
    }
  } else {
    // 2. Try finding file in draft/published
    for (const status of ['draft', 'published']) {
      const statusDir = path.join(options.workspaceRoot, collection, status);
      if (!fs.existsSync(statusDir)) continue;
      const found = fs
        .readdirSync(statusDir)
        .find((f) => f.endsWith('.md') && f.includes(options.article));
      if (found) {
        articleContent = fs.readFileSync(path.join(statusDir, found), 'utf8');
        try {
          const parsed = parseMarkdown(articleContent);
          articleId = parsed.frontmatter.id || articleId;
        } catch {
          // fallback
        }
        break;
      }
    }
  }

  // 3. If still absent locally, fetch remote article content from EmDash API
  if (!articleContent) {
    const url = new URL(`/_emdash/api/content/${collection}/${options.article}`, options.origin);
    const res = await fetchFn(url.toString(), {
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new ApiError({
        message: `Failed to fetch remote article for media resolution: ${res.statusText}`,
        code: 'ARTICLE_NOT_FOUND',
        status: res.status,
        endpoint: url.toString(),
        suggestion: `Verify that article '${options.article}' exists in collection '${collection}' on remote.`,
      });
    }

    const json = await res.json();
    const data = unwrapEnvelope<Record<string, unknown>>(json);
    const item = (data.item || data) as Record<string, unknown>;
    articleId = (item.id as string) || options.article;

    // Build synthesized content string from remote representation
    const remoteFi = item.featured_image || item.featuredImage;
    const fiId = extractMediaUlid(remoteFi);
    const fiPart = fiId ? `featuredImage: ${fiId}\n` : '';
    const bodyPart =
      typeof item.content === 'string'
        ? item.content
        : JSON.stringify(item.content || item.body || '');
    articleContent = `---\n${fiPart}---\n${bodyPart}`;
  }

  const mediaIds = collectArticleReferencedMediaIds(articleContent);
  if (mediaIds.length === 0) {
    return {
      total: 0,
      downloaded: 0,
      skipped: 0,
      failed: 0,
      articleId,
      mediaIds: [],
    };
  }

  let downloadedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const mId of mediaIds) {
    try {
      const mediaUrl = new URL(`/_emdash/api/media/${mId}`, options.origin);
      const res = await fetchFn(mediaUrl.toString(), {
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        failedCount++;
        continue;
      }

      const json = await res.json();
      const envelope = unwrapEnvelope<Record<string, unknown>>(json);
      const item = (envelope.item || envelope) as EmDashMediaItem;

      const result = await syncSingleMediaItem({
        item,
        mediaDir,
        origin: options.origin,
        token: options.token,
        downloadFiles,
        fetchFn,
      });

      if (result.downloaded) downloadedCount++;
      else if (result.skipped) skippedCount++;
    } catch {
      failedCount++;
    }
  }

  return {
    total: mediaIds.length,
    downloaded: downloadedCount,
    skipped: skippedCount,
    failed: failedCount,
    articleId,
    mediaIds,
  };
}

/**
 * Pulls media metadata and files from EmDash API into media/ directory with cursor pagination.
 * media/<id>-<filename>.yaml
 * media/<id>-<filename>.<ext>
 */
export async function pullMedia(options: PullMediaOptions): Promise<PullMediaResult> {
  if (options.article) {
    return pullArticleMedia({
      workspaceRoot: options.workspaceRoot,
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      article: options.article,
      collection: options.collection,
      downloadFiles: options.downloadFiles,
      fetchFn: options.fetchFn,
    });
  }

  const fetchFn = createAuthedFetch(options);
  const targetTotal = options.all ? Infinity : (options.limit ?? 300);
  const downloadFiles = options.downloadFiles !== false;
  const batchSize = 100;

  const mediaDir = path.join(options.workspaceRoot, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const activeMediaBaseNames = new Set<string>();
  const activeMediaIds = new Set<string>();

  let totalProcessed = 0;
  let downloadedCount = 0;
  let skippedCount = 0;
  let cursor: string | undefined = undefined;

  while (totalProcessed < targetTotal) {
    const remaining = targetTotal - totalProcessed;
    const currentBatch = Math.min(remaining, batchSize);

    const url = new URL(`/_emdash/api/media`, options.origin);
    url.searchParams.set('limit', String(currentBatch));
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const res = await fetchFn(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new ApiError({
        message: `Failed to list media: ${res.statusText}`,
        code: 'MEDIA_LIST_FAILED',
        status: res.status,
        endpoint: url.toString(),
        suggestion: 'Verify network connection and token permissions.',
      });
    }

    const json = await res.json();
    const data = unwrapEnvelope<Record<string, unknown>>(json);
    const rawItems = (
      Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : []
    ) as EmDashMediaItem[];

    if (rawItems.length === 0) {
      break;
    }

    for (const item of rawItems) {
      const ext = path.extname(item.filename);
      const baseWithoutExt = path.basename(item.filename, ext);
      const sanitizedBase = sanitizeTitleForFilename(baseWithoutExt);
      const datePrefix = formatDatePrefix(item.createdAt);
      const baseName = `${datePrefix}${item.id}-${sanitizedBase}`;
      const oldBaseName = `${item.id}-${sanitizedBase}`;
      activeMediaBaseNames.add(baseName);
      activeMediaBaseNames.add(oldBaseName);
      activeMediaIds.add(item.id);

      const result = await syncSingleMediaItem({
        item,
        mediaDir,
        origin: options.origin,
        token: options.token,
        downloadFiles,
        fetchFn,
      });

      if (result.downloaded) downloadedCount++;
      else if (result.skipped) skippedCount++;

      totalProcessed++;
      if (totalProcessed >= targetTotal) {
        break;
      }
    }

    if (!data.nextCursor || typeof data.nextCursor !== 'string') {
      break;
    }
    cursor = data.nextCursor;
  }

  // Pruning logic for media: if --prune or --all is enabled, delete local media not present on remote
  let deletedCount = 0;
  if ((options.prune || options.all) && fs.existsSync(mediaDir)) {
    const files = fs.readdirSync(mediaDir);
    for (const file of files) {
      // Check if file is related to any active media ID
      const match = file.replace(/^\d{8}_/, '').match(/^([0-9A-Z]{26})/);
      if (match) {
        const id = match[1];
        if (!activeMediaIds.has(id)) {
          try {
            fs.unlinkSync(path.join(mediaDir, file));
            deletedCount++;
          } catch {
            // Ignore unlink errors
          }
        }
      }
    }
  }

  return {
    total: totalProcessed,
    downloaded: downloadedCount,
    skipped: skippedCount,
    deleted: deletedCount,
  };
}
