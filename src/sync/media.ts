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
import { formatDatePrefix, sanitizeTitleForFilename } from '../utils/frontmatter.js';

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

export function buildMediaMetaDoc(item: EmDashMediaItem, origin: string): Record<string, unknown> {
  const canonicalUrl =
    item.url || (item.storageKey ? `/_emdash/api/media/file/${item.storageKey}` : '');
  return {
    id: item.id,
    filename: item.filename,
    mimeType: item.mimeType,
    size: item.size,
    width: item.width ?? null,
    height: item.height ?? null,
    alt: item.alt ?? '',
    caption: item.caption ?? '',
    storageKey: item.storageKey ?? '',
    contentHash: item.contentHash ?? null,
    status: item.status ?? 'ready',
    url: canonicalUrl ? new URL(canonicalUrl, origin).toString() : '',
    createdAt: item.createdAt || '',
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
  const metaDoc = buildMediaMetaDoc(item, origin);
  fs.writeFileSync(
    yamlPath,
    yaml.dump(metaDoc, { indent: 2, quotingType: '"', forceQuotes: false, lineWidth: -1 }),
    'utf8',
  );

  const targetFilePath = path.join(mediaDir, `${baseName}${ext}`);
  if (fs.existsSync(draftAbsPath)) {
    if (removeDraft) {
      fs.renameSync(draftAbsPath, targetFilePath);
    } else {
      fs.copyFileSync(draftAbsPath, targetFilePath);
    }
  }

  return path.posix.join('media', `${baseName}${ext}`);
}

import { ApiError } from '../client/error.js';
import { createAuthedFetch } from '../client/http.js';
import { unwrapEnvelope } from '../client/api.js';

export interface PullMediaOptions {
  workspaceRoot: string;
  origin: string;
  token: string;
  refreshToken?: string;
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
}

/**
 * Pulls media metadata and files from EmDash API into media/ directory with cursor pagination.
 * media/<id>-<filename>.yaml
 * media/<id>-<filename>.<ext>
 */
export async function pullMedia(options: PullMediaOptions): Promise<PullMediaResult> {
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

      // Clean up old un-prefixed YAML if migrating
      const oldYamlPath = path.join(mediaDir, `${oldBaseName}.yaml`);
      const yamlPath = path.join(mediaDir, `${baseName}.yaml`);
      if (oldYamlPath !== yamlPath && fs.existsSync(oldYamlPath)) {
        try {
          fs.unlinkSync(oldYamlPath);
        } catch {}
      }

      // 1. Write YAML metadata
      const metaDoc = buildMediaMetaDoc(item, options.origin);
      fs.writeFileSync(
        yamlPath,
        yaml.dump(metaDoc, { indent: 2, quotingType: '"', forceQuotes: false, lineWidth: -1 }),
        'utf8',
      );

      // 2. Download binary file if enabled and url is present
      if (downloadFiles && item.url) {
        const fileExt = ext || (item.mimeType.includes('png') ? '.png' : '.jpg');
        const oldFilePath = path.join(mediaDir, `${oldBaseName}${fileExt}`);
        const targetFilePath = path.join(mediaDir, `${baseName}${fileExt}`);

        // Migrate/rename old file to new name if already downloaded
        if (oldFilePath !== targetFilePath && fs.existsSync(oldFilePath)) {
          try {
            const stat = fs.statSync(oldFilePath);
            if (stat.size === item.size) {
              fs.renameSync(oldFilePath, targetFilePath);
            }
          } catch {}
        }

        // Avoid re-downloading if already present and matches size
        let shouldDownload = true;
        if (fs.existsSync(targetFilePath)) {
          const stat = fs.statSync(targetFilePath);
          if (stat.size === item.size) {
            shouldDownload = false;
            skippedCount++;
          }
        }

        if (shouldDownload) {
          try {
            const downloadUrl = new URL(item.url, options.origin).toString();
            const fileRes = await fetchFn(downloadUrl, {
              headers: {
                Authorization: `Bearer ${options.token}`,
              },
            });
            if (fileRes.ok) {
              const buffer = Buffer.from(await fileRes.arrayBuffer());
              fs.writeFileSync(targetFilePath, buffer);
              downloadedCount++;
            }
          } catch {
            // Ignore individual download failures
          }
        }
      }

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
