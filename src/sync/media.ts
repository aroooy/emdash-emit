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

/** A body image reference whose media record could not be resolved. */
export interface OrphanMediaDescriptor {
  /** The storageKey taken from the article body URL `/_emdash/api/media/file/<storageKey>`. */
  storageKey: string;
  /** ULID segment(s) found inside the storageKey, uppercased, in document order. */
  ulids: string[];
  ext: string;
}

/** Builds a descriptor from a ULID-segment storageKey, defaulting to `.jpg` when no extension is present. */
function descriptorFromStorageKey(storageKey: string): OrphanMediaDescriptor {
  const extMatch = storageKey.match(/\.[a-z]+$/i);
  return {
    storageKey,
    ext: extMatch ? extMatch[0].toLowerCase() : '.jpg',
    ulids: Array.from(storageKey.matchAll(/[0-9A-HJ-NP-Z]{26}/gi), (m) => m[0].toUpperCase()),
  };
}

/**
 * A locally mirrored asset that can be used to re-verify a body storageKey without inventing remote
 * data: the media/ companion YAML already records both the record id and the confirmed storageKey.
 */
export interface LocalMediaMirrorCandidate {
  /** Media record id read from the companion YAML (`id:`) or the canonical filename stem. */
  mediaId: string;
  /** The storageKey recorded by the companion YAML, when present. */
  storageKey?: string;
  /** Companion YAML file name relative to `media/`. */
  metaFile: string;
}

/**
 * Recovers the storageKey a companion YAML actually refers to. Older mirrors — most visibly the ones
 * written before Emit persisted the field — carry no `storageKey:` key at all, yet their `url:` is the
 * canonical `/_emdash/api/media/file/<storageKey>` route, which is confirmed metadata written from the
 * server response and not an inference from a body reference. Absolute and root-relative forms are both
 * accepted because either can appear depending on how the record was mirrored. `legacy_*` residue is
 * never read here: it backs no real record, so it must not serve as verification evidence.
 */
export function storageKeyFromMediaMeta(doc: Record<string, unknown>): string | undefined {
  if (typeof doc.storageKey === 'string' && doc.storageKey.trim()) {
    return doc.storageKey.trim();
  }
  if (typeof doc.url !== 'string' || !doc.url.trim()) return undefined;
  const match = doc.url.match(/(?:^|\/)media\/file\/([^?#]+)/);
  return match ? match[1] : undefined;
}

/**
 * Indexes every locally mirrored media asset (`media/<yyyyMMdd>_<mediaId>-<name>.yaml`) so a body
 * storageKey that the canonical id lookup failed to resolve can be re-checked against confirmed local
 * metadata instead of being declared missing. Leftover `legacy_*` residue is skipped because it backs
 * no real record. The result maps each ULID found in a mirror (record id or storageKey) to its entry,
 * which is what lets Emit tell "the record exists under a different id" apart from "no record exists".
 */
export function collectLocalMediaMirrorCandidates(
  mediaDir: string,
): Map<string, LocalMediaMirrorCandidate> {
  const byUlid = new Map<string, LocalMediaMirrorCandidate>();
  if (!fs.existsSync(mediaDir)) return byUlid;
  for (const file of fs.readdirSync(mediaDir)) {
    if (!file.endsWith('.yaml') || file.startsWith('legacy_')) continue;
    let doc: Record<string, unknown> | null = null;
    try {
      doc = yaml.load(fs.readFileSync(path.join(mediaDir, file), 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }
    if (!doc) continue;
    const storageKey = storageKeyFromMediaMeta(doc);
    const stem = file.replace(/\.yaml$/, '');
    const idMatch = stem.replace(/^\d{8}_/, '').match(/^([0-9A-HJ-NP-Z]{26})/i);
    const docId =
      typeof doc.id === 'string' && /^[0-9A-HJ-NP-Z]{26}$/i.test(doc.id.trim())
        ? doc.id.trim().toUpperCase()
        : undefined;
    const mediaId = docId || (idMatch ? idMatch[1].toUpperCase() : '');
    if (!mediaId) continue;
    const candidate: LocalMediaMirrorCandidate = { mediaId, storageKey, metaFile: file };
    if (!byUlid.has(mediaId)) byUlid.set(mediaId, candidate);
    for (const ulid of storageKey?.matchAll(/[0-9A-HJ-NP-Z]{26}/gi) ?? []) {
      const key = ulid[0].toUpperCase();
      if (!byUlid.has(key)) byUlid.set(key, candidate);
    }
  }
  return byUlid;
}

/** Collapses descriptors that name the same storageKey, keeping one entry per key. */
function dedupeDescriptorsByStorageKey(
  descriptors: OrphanMediaDescriptor[],
): OrphanMediaDescriptor[] {
  const byKey = new Map<string, OrphanMediaDescriptor>();
  for (const descriptor of descriptors) {
    if (!byKey.has(descriptor.storageKey)) byKey.set(descriptor.storageKey, descriptor);
  }
  return Array.from(byKey.values()).sort((a, b) => a.storageKey.localeCompare(b.storageKey));
}

/**
 * Extracts every media file storageKey referenced by an article (markdown images, HTML img tags,
 * opaque custom-block fences, and legacy container lines such as `[dimage url="..." control=true]`).
 * A storageKey must be ULID-segment based with a known image extension, so template placeholders
 * (`<storageKey>`) and prose never produce descriptors. The media record id is deliberately NOT
 * inferred from it: for migrated WordPress assets the file route serves `<storageKey>` while the
 * record id returns 404, so only the storageKey can be reported to the user.
 */
export function collectArticleStorageKeys(content: string): OrphanMediaDescriptor[] {
  const keys = new Set<string>();
  const keyPattern =
    /(?:^|\/)media\/file\/([0-9A-HJ-NP-Z]{26}(?:\.[0-9A-HJ-NP-Z]{26})*\.(?:jpg|jpeg|png|gif|webp|avif|svg))/gi;

  const harvest = (text: string): void => {
    let match: RegExpExecArray | null;
    keyPattern.lastIndex = 0;
    while ((match = keyPattern.exec(text)) !== null) {
      keys.add(match[1]);
    }
  };

  // scanArticleMediaReferences covers markdown images and HTML img tags anywhere in the body,
  // including inside opaque fences and legacy container lines where doctor stays quiet by design.
  harvest(scanArticleMediaReferences(content).join('\n'));
  harvest(content);

  const descriptors: OrphanMediaDescriptor[] = [];
  for (const storageKey of keys) {
    descriptors.push(descriptorFromStorageKey(storageKey));
  }
  return dedupeDescriptorsByStorageKey(descriptors);
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
    // Check if an older or differently-dated YAML for the same item.id exists. A leftover
    // `legacy_<storageKey>.yaml` from the removed file-route fallback also embeds this ULID, so it
    // must never be read as a real record's metadata.
    const existingFiles = fs.readdirSync(mediaDir);
    const matchingYaml = existingFiles.find(
      (f) =>
        f.endsWith('.yaml') &&
        !f.startsWith('legacy_') &&
        (f.includes(`_${item.id}-`) || f.startsWith(`${item.id}-`)),
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
  /**
   * Body storageKeys confirmed by evidence Emit actually holds: the canonical lookup resolved a record
   * under that ULID (its own storageKey may differ), or a local mirror companion already names it. Such
   * a key is healthy and must never be escalated as missing.
   */
  verifiedStorageKeys?: string[];
  /** Body storageKeys that neither a resolved record nor confirmed local metadata could match. */
  orphanStorageKeys?: string[];
  /**
   * Total media records reported by the server (`totalCount` of the list operation) for a library-wide
   * pull. Lets a user tell "this run covered N of M" apart from "the library has N items".
   */
  remoteTotalCount?: number | null;
  /**
   * StorageKeys referenced by workspace articles that no local mirror names and that a complete remote
   * library walk also did not report. Populated only for `--all` pulls, where the walk is exhaustive.
   */
  referencedUnmirroredStorageKeys?: string[];
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

    // Build a content string from the remote representation so references can be collected even when
    // no local file exists yet.
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
  // Body storageKeys are the only handle available when a migrated body bakes the R2 `storageKey`
  // instead of the D1 record id. They must never be fed to `GET /_emdash/api/media/{id}` as if they
  // were ids: that lookup keys on the primary key, so it returns 404 for a record that does exist.
  const storageKeyDescriptors = collectArticleStorageKeys(articleContent);
  const descriptorsByKey = new Map<string, OrphanMediaDescriptor>();
  for (const descriptor of storageKeyDescriptors) {
    descriptorsByKey.set(descriptor.storageKey, descriptor);
  }
  const allKeys = Array.from(descriptorsByKey.keys()).sort();

  if (mediaIds.length === 0 && allKeys.length === 0) {
    return {
      total: 0,
      downloaded: 0,
      skipped: 0,
      failed: 0,
      articleId,
      mediaIds: [],
      orphanStorageKeys: [],
    };
  }

  let downloadedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const recoveredStorageKeys = new Set<string>();
  // Ids whose canonical lookup succeeded. A body key sharing one of these ULIDs is a confirmed match:
  // the record exists, it simply carries a storageKey that differs from the one baked into the body.
  const resolvedRecordIds = new Set<string>();

  // 1. Canonical path: resolve each referenced media record id and mirror it normally.
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
      resolvedRecordIds.add(mId.toUpperCase());
      if (item.storageKey) recoveredStorageKeys.add(item.storageKey);
    } catch {
      failedCount++;
    }
  }

  // 2. Unresolved storageKeys: a body key that no canonical id lookup mirrored is NOT proof of a
  //    missing record. The record can exist under a different primary key, so Emit re-checks the key
  //    against confirmed evidence only — a record it just resolved under the same ULID, or the local
  //    mirror metadata (companion YAML `id` + `storageKey`) — and reports what still fails as
  //    unresolved. Emit never fetches such an asset and never registers a record for it.
  const mirrorCandidates = collectLocalMediaMirrorCandidates(mediaDir);
  const verifiedStorageKeys: string[] = [];
  const orphanStorageKeys: string[] = [];
  for (const key of allKeys) {
    if (recoveredStorageKeys.has(key)) continue;
    const ulids = (key.match(/[0-9A-HJ-NP-Z]{26}/gi) ?? []).map((u) => u.toUpperCase());
    // Only two things count as evidence: a record Emit successfully fetched under this exact ULID, or
    // confirmed local mirror metadata naming it. A body reference alone is never self-confirming — that
    // is precisely the case where the asset must be reported instead of assumed healthy.
    const confirmed = ulids.some(
      (ulid) => resolvedRecordIds.has(ulid) || mirrorCandidates.has(ulid),
    );
    if (confirmed) {
      verifiedStorageKeys.push(key);
      continue;
    }
    orphanStorageKeys.push(key);
  }

  return {
    total: mediaIds.length + verifiedStorageKeys.length + orphanStorageKeys.length,
    downloaded: downloadedCount,
    skipped: skippedCount,
    failed: failedCount,
    articleId,
    mediaIds,
    verifiedStorageKeys,
    orphanStorageKeys,
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
  // Every mirrored companion is a confirmed storageKey source, including the ones written before Emit
  // persisted the field, whose `url:` still names the key. Seeding from disk means `--prune` never
  // deletes an asset that this run's media window simply did not reach.
  const activeStorageKeys = new Set<string>();
  for (const candidate of collectLocalMediaMirrorCandidates(mediaDir).values()) {
    if (candidate.storageKey) activeStorageKeys.add(candidate.storageKey);
  }

  // Metadata for the coverage report and the storageKey census. `pullMedia` already walks the library
  // cursor-by-cursor, so it owns the index instead of paying for a second one.
  const remoteIndex: RemoteStorageKeyIndex = {
    storageKeys: activeStorageKeys,
    mediaIdsByStorageKey: new Map<string, string>(),
    totalCount: null,
    complete: false,
    scannedCount: 0,
  };

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
    if (typeof data.totalCount === 'number') remoteIndex.totalCount = data.totalCount;
    const rawItems = (
      Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : []
    ) as EmDashMediaItem[];

    if (rawItems.length === 0) {
      // An empty page ends the listing regardless of any cursor the server echoes back.
      remoteIndex.complete = true;
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
      if (item.storageKey) {
        activeStorageKeys.add(item.storageKey);
        remoteIndex.mediaIdsByStorageKey.set(item.storageKey, item.id);
      }

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
      remoteIndex.scannedCount++;
      if (totalProcessed >= targetTotal) {
        break;
      }
    }

    if (!data.nextCursor || typeof data.nextCursor !== 'string') {
      remoteIndex.complete = true;
      break;
    }
    cursor = data.nextCursor;
  }

  // Pruning logic for media: if --prune or --all is enabled, delete local media not present on remote
  let deletedCount = 0;
  if ((options.prune || options.all) && fs.existsSync(mediaDir)) {
    const files = fs.readdirSync(mediaDir);
    for (const file of files) {
      // Leftover `legacy_*` mirrors from the removed file-route fallback are never matched by the
      // mediaId pattern below, so they survive pruning and must be deleted by hand.
      if (file.startsWith('legacy_')) continue;
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

  // A library-wide walk is exhaustive, so it doubles as the storageKey census: every article reference
  // that neither a local companion nor any remote record names is reported. The list endpoint exposes no
  // storageKey filter, which is why the census requires the full walk `--all` already performs.
  let referencedUnmirroredStorageKeys: string[] | undefined = undefined;
  if (options.all) {
    const referenced = new Set<string>();
    for (const status of ['draft', 'published']) {
      const statusDir = path.join(options.workspaceRoot, options.collection || 'posts', status);
      if (!fs.existsSync(statusDir)) continue;
      for (const file of fs.readdirSync(statusDir)) {
        if (!file.endsWith('.md')) continue;
        try {
          const content = fs.readFileSync(path.join(statusDir, file), 'utf8');
          for (const descriptor of collectArticleStorageKeys(content)) {
            referenced.add(descriptor.storageKey);
          }
        } catch {
          // An unreadable article contributes nothing to the census.
        }
      }
    }
    if (referenced.size > 0) {
      referencedUnmirroredStorageKeys = findUnmirroredStorageKeys(
        referenced,
        activeStorageKeys,
        remoteIndex,
      );
    }
  }

  return {
    total: totalProcessed,
    downloaded: downloadedCount,
    skipped: skippedCount,
    deleted: deletedCount,
    remoteTotalCount: remoteIndex.complete
      ? (remoteIndex.totalCount ?? remoteIndex.scannedCount)
      : remoteIndex.totalCount,
    referencedUnmirroredStorageKeys,
  };
}

/**
 * Reads the media library once and returns its full storageKey index.
 *
 * `GET /_emdash/api/media` accepts only `cursor`, `limit`, `page`, `mimeType`, `folderId`, `q`, and
 * `includeUsage`, so a specific body reference cannot be looked up by key: the list operation is the
 * only handle that reaches migrated assets, whose storageKey differs from the record id that
 * `GET /_emdash/api/media/{id}` keys on. Every item in the response carries its own `storageKey` and
 * the listing is cursor-bounded by `totalCount`, so one walk indexes the whole library. The response's
 * `totalCount` is reported alongside the index so callers can tell "the key is absent from a complete
 * library" apart from "the walk stopped early".
 */
export interface RemoteStorageKeyIndex {
  /** Every storageKey present in the remote media library, as reported by the list endpoint. */
  storageKeys: Set<string>;
  /** ULIDs of the records those keys belong to, for reporting a match as a record id. */
  mediaIdsByStorageKey: Map<string, string>;
  /** `totalCount` reported by the server, or null when the response did not include it. */
  totalCount: number | null;
  /** True only when the walk finished without hitting `maxItems`. */
  complete: boolean;
  /**
   * Records actually read from the list endpoint. Live EmDash reports no `totalCount` at all, so this
   * walked count is the only figure a coverage report can state; it equals `storageKeys.size` unless a
   * record repeated a key or lacked one.
   */
  scannedCount: number;
}

export async function collectRemoteStorageKeys(options: {
  workspaceRoot: string;
  origin: string;
  token: string;
  refreshToken?: string;
  /** Stop after this many records. Defaults to unlimited, which is the whole library. */
  maxItems?: number;
  fetchFn?: typeof fetch;
}): Promise<RemoteStorageKeyIndex> {
  const fetchFn = createAuthedFetch(options);
  const batchSize = 100;
  const maxItems = options.maxItems ?? Infinity;

  const storageKeys = new Set<string>();
  const mediaIdsByStorageKey = new Map<string, string>();
  let totalCount: number | null = null;
  let scanned = 0;
  let complete = false;
  let cursor: string | undefined = undefined;

  for (;;) {
    const remaining = maxItems - scanned;
    if (remaining <= 0) break;
    const currentBatch = Math.min(remaining, batchSize);

    const url = new URL('/_emdash/api/media', options.origin);
    url.searchParams.set('limit', String(currentBatch));
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetchFn(url.toString(), {
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

    const data = unwrapEnvelope<Record<string, unknown>>(await res.json());
    if (typeof data.totalCount === 'number') totalCount = data.totalCount;
    const rawItems = (
      Array.isArray(data.items) ? data.items : Array.isArray(data.data) ? data.data : []
    ) as EmDashMediaItem[];

    for (const item of rawItems) {
      scanned++;
      if (typeof item.storageKey === 'string' && item.storageKey) {
        storageKeys.add(item.storageKey);
        if (item.id) mediaIdsByStorageKey.set(item.storageKey, item.id);
      }
    }

    if (rawItems.length === 0 || typeof data.nextCursor !== 'string' || !data.nextCursor) {
      complete = true;
      break;
    }
    cursor = data.nextCursor;
  }

  return { storageKeys, mediaIdsByStorageKey, totalCount, complete, scannedCount: scanned };
}

/**
 * Reports body storageKeys that no local mirror names and that a full remote library walk does not
 * contain. A key is only listed when the walk was complete: an early stop proves nothing about the
 * rest of the library, so an incomplete walk yields nothing. Even a confirmed absence is reported as a
 * lookup result rather than as a missing record — Emit mirrors records and never repairs server data.
 */
export function findUnmirroredStorageKeys(
  referenced: Iterable<string>,
  localMirrorKeys: Iterable<string>,
  remoteIndex: RemoteStorageKeyIndex,
): string[] {
  if (!remoteIndex.complete) return [];
  const mirrored = new Set(localMirrorKeys);
  const unresolved = new Set<string>();
  for (const key of referenced) {
    if (mirrored.has(key) || remoteIndex.storageKeys.has(key)) continue;
    unresolved.add(key);
  }
  return Array.from(unresolved).sort();
}
