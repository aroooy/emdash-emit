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
import type { CacheDatabase } from '../db/cache.js';
import {
  formatDatePrefix,
  sanitizeTitleForFilename,
  storageKeyToMarkdownRef,
  collisionSuffixedMarkdownRef,
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

/** Result of promoting a local draft image into the canonical `media/` layout. */
export interface PromotedMediaFile {
  /** Workspace-relative path of the promoted binary, e.g. `media/<markdownRef>.png`. */
  filePath: string;
  /**
   * Workspace-relative path of the shared stem for the binary and its companion YAML, e.g.
   * `media/<markdownRef>`. Recorded as `media_state.markdown_ref` so a body storageKey resolves to this
   * mirror without parsing a filename.
   */
  markdownRef: string;
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
 * Removes any stale duplicate files in `media/` that belong to the same 26-char `mediaId` but sit under a
 * different stem — a leftover date-prefixed name from an earlier local promotion, for instance. Ownership is
 * read from each file's companion YAML rather than from the filename, because a storageKey-named mirror
 * carries no record id at all and must never be matched (or deleted) by a coincidental ULID prefix.
 */
function cleanupDuplicateMediaFilesForId(
  mediaDir: string,
  mediaId: string,
  canonicalBaseName: string,
): void {
  if (!fs.existsSync(mediaDir)) return;
  const wanted = mediaId.toUpperCase();
  for (const entry of fs.readdirSync(mediaDir)) {
    if (entry.startsWith('legacy_')) continue;
    const entryBase = entry.replace(/\.yaml$/, '').replace(/\.[^.]+$/, '');
    if (entryBase === canonicalBaseName) continue;
    // Only a companion-backed mirror can be attributed, and only when the companion itself is being
    // retired together with its binary.
    if (!entry.endsWith('.yaml')) continue;
    if (mediaRecordIdForStem(mediaDir, entryBase) !== wanted) continue;
    for (const orphan of [
      `${entryBase}.yaml`,
      ...MEDIA_BINARY_EXTENSIONS.map((e) => `${entryBase}${e}`),
    ]) {
      const orphanPath = path.join(mediaDir, orphan);
      if (orphan === `${canonicalBaseName}.yaml`) continue;
      try {
        if (fs.existsSync(orphanPath)) fs.unlinkSync(orphanPath);
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
 * Indexes every locally mirrored media asset (`media/<markdownRef>.yaml`, plus legacy companion names) so a body
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
  // A workspace that spells a mirrored image as `media/<storageKey>` names the key outright rather than
  // through the file route, so the census must read that spelling too — otherwise an unmirrored local
  // reference silently disappears from `referencedUnmirroredStorageKeys`.
  const localRefPattern =
    /(?:^|\/)media\/([0-9A-HJ-NP-Z]{26}(?:\.[0-9A-HJ-NP-Z]{26})*\.(?:jpg|jpeg|png|gif|webp|avif|svg))/gi;

  const harvest = (text: string, pattern: RegExp): void => {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      keys.add(match[1]);
    }
  };

  // scanArticleMediaReferences covers markdown images and HTML img tags anywhere in the body,
  // including inside opaque fences and legacy container lines where doctor stays quiet by design.
  const scannedRefs = scanArticleMediaReferences(content).join('\n');
  harvest(scannedRefs, keyPattern);
  harvest(content, keyPattern);
  harvest(scannedRefs, localRefPattern);
  harvest(content, localRefPattern);

  const descriptors: OrphanMediaDescriptor[] = [];
  for (const storageKey of keys) {
    descriptors.push(descriptorFromStorageKey(storageKey));
  }
  return dedupeDescriptorsByStorageKey(descriptors);
}

/**
 * Reads the media record id a mirror belongs to from its companion YAML, accepting both the storageKey-named
 * stem and the legacy `<yyyyMMdd>_<id>-<name>` form. Returns `null` when no companion exists or it names no
 * valid ULID, which is how Emit refuses to prune a file it cannot attribute to a record. A companion whose
 * id is explicitly null (or any non-ULID value) proves the mirror backs no real record, so the stem's own
 * leading characters are never trusted as an id — that fallback would let fabricated fixture ids reach
 * record-keyed logic.
 */
export function mediaRecordIdForStem(mediaDir: string, stem: string): string | null {
  const candidates = [`${stem}.yaml`, `${stem.replace(/^\d{8}_/, '')}.yaml`];
  for (const name of candidates) {
    const candidatePath = path.join(mediaDir, name);
    if (!fs.existsSync(candidatePath)) continue;
    let doc: Record<string, unknown> | null = null;
    try {
      doc = yaml.load(fs.readFileSync(candidatePath, 'utf8')) as Record<string, unknown> | null;
    } catch {
      // An unreadable companion proves nothing.
      continue;
    }
    if (!doc) continue;
    const rawId = typeof doc.id === 'string' ? doc.id.trim() : '';
    if (/^[0-9A-Za-z_-]{26}$/.test(rawId)) {
      return rawId.toUpperCase();
    }
    return null;
  }
  return null;
}

/**
 * Promotes a local draft image from media/drafts/<name> into the canonical
 * media/<markdownRef>.<ext> location alongside its matching media/<markdownRef>.yaml companion, where
 * markdownRef is derived from the storageKey the article body will reference. Returns both the workspace-relative
 * path of the promoted binary and the shared `media/<markdownRef>` stem, so the caller can record the mirror in
 * `media_state.markdown_ref`.
 */
export function promoteDraftMediaFile(options: PromoteDraftMediaOptions): PromotedMediaFile {
  const { workspaceRoot, origin, draftAbsPath, item, removeDraft = true } = options;
  const mediaDir = path.join(workspaceRoot, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const ext =
    path.extname(item.filename) ||
    path.extname(draftAbsPath) ||
    (item.mimeType.includes('png') ? '.png' : '.jpg');
  const names = mediaMirrorNames(
    { ...item, filename: item.filename || path.basename(draftAbsPath) },
    mediaDir,
  );
  const baseName = names.markdownRef;

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

  // Retire any earlier id-named mirror of the same record so one asset never occupies two names.
  for (const legacy of names.legacyBaseNames) {
    for (const suffix of [ext, '.yaml']) {
      const legacyPath = path.join(mediaDir, `${legacy}${suffix}`);
      if (legacyPath !== yamlPath && legacyPath !== targetFilePath && fs.existsSync(legacyPath)) {
        try {
          fs.unlinkSync(legacyPath);
        } catch {}
      }
    }
  }
  cleanupDuplicateMediaFilesForId(mediaDir, item.id, baseName);

  return {
    filePath: path.posix.join('media', `${baseName}${ext}`),
    markdownRef: path.posix.join('media', baseName),
  };
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
 * A media mirror's on-disk identity under the storageKey naming rule.
 *
 * `markdownRef` is the stem both the binary and its companion YAML share, derived from the storageKey the
 * article body references. `legacyBaseNames` enumerates every older stem this asset may still occupy — the
 * un-prefixed `<id>-<name>` form and any `<yyyyMMdd>_<id>-<name>` form written by earlier Emit versions or
 * by a local promotion with a provisional date — so one pull can rename an existing workspace into the new
 * layout without re-downloading a byte.
 */
export interface MediaMirrorNames {
  markdownRef: string;
  ext: string;
  legacyBaseNames: string[];
}

/** Extensions a media mirror binary may carry, used when probing a stem for an existing owner. */
const MEDIA_BINARY_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.svg'];

/**
 * Resolves the storageKey-derived stem against the names already taken in `media/`. Two distinct keys can
 * sanitize to the same basename — `a/sample.png` and `b/sample.png` both yield `sample` — and a second asset
 * must never overwrite the first. A name already owned by this same record is reused as-is, so re-pulling is
 * idempotent; any other collision gets the deterministic `<stem>--<mediaId>` suffix.
 */
function resolveMarkdownRefCollision(
  mediaDir: string,
  baseRef: string,
  item: EmDashMediaItem,
): string {
  const suffixed = collisionSuffixedMarkdownRef(baseRef, item.id);
  const takenByOther = (stem: string): boolean => {
    for (const suffix of ['.yaml', ...MEDIA_BINARY_EXTENSIONS]) {
      const candidatePath = path.join(mediaDir, `${stem}${suffix}`);
      if (!fs.existsSync(candidatePath)) continue;
      const ownerId = mediaRecordIdForStem(mediaDir, stem);
      if (ownerId && ownerId !== item.id.toUpperCase()) return true;
    }
    return false;
  };

  if (!takenByOther(baseRef)) return baseRef;
  if (!takenByOther(suffixed)) return suffixed;
  // Both taken and both owned by this record: the suffixed form is already this asset's, so keep it.
  return suffixed;
}

/**
 * Computes the canonical mirror name for one remote media item. Falls back to the record-id based stem only
 * when the storageKey carries no usable basename, so a malformed migrated key cannot produce an unnameable
 * file. Pass `mediaDir` to resolve a stem collision against the mirrors already on disk.
 */
export function mediaMirrorNames(item: EmDashMediaItem, mediaDir?: string): MediaMirrorNames {
  const ext = path.extname(item.filename) || '';
  const sanitizedBase = sanitizeTitleForFilename(path.basename(item.filename, ext));
  const legacyBaseNames = [
    `${item.id}-${sanitizedBase}`,
    `${formatDatePrefix(item.createdAt)}${item.id}-${sanitizedBase}`,
  ];

  const fromKey = item.storageKey ? storageKeyToMarkdownRef(item.storageKey) : null;
  if (fromKey) {
    const markdownRef = mediaDir ? resolveMarkdownRefCollision(mediaDir, fromKey, item) : fromKey;
    return { markdownRef, ext, legacyBaseNames };
  }
  return {
    markdownRef: `${formatDatePrefix(item.createdAt)}${item.id}-${sanitizedBase}`,
    ext,
    legacyBaseNames,
  };
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
  cache?: CacheDatabase;
}): Promise<{ downloaded: boolean; skipped: boolean; baseName: string }> {
  const { item, mediaDir, origin, token, downloadFiles, fetchFn, cache } = options;
  const names = mediaMirrorNames(item, mediaDir);
  const baseName = names.markdownRef;
  const yamlPath = path.join(mediaDir, `${baseName}.yaml`);

  // Read any existing companion for this record id first, whatever stem it currently occupies. The
  // storageKey-named companion is the expected location; the legacy stems are where an older workspace still
  // holds the same asset. `legacy_<storageKey>.yaml` is skipped unconditionally: it carries a matching ULID
  // but fabricates its metadata from a file route, so it must never seed a real record.
  let existingMeta: Record<string, unknown> | null = null;
  let existingMetaPath: string | null = null;
  const mediaFiles = fs.readdirSync(mediaDir);
  const companionCandidates = [yamlPath];
  for (const legacy of names.legacyBaseNames) {
    companionCandidates.push(path.join(mediaDir, `${legacy}.yaml`));
  }
  for (const candidate of companionCandidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      existingMeta = yaml.load(fs.readFileSync(candidate, 'utf8')) as Record<
        string,
        unknown
      > | null;
      existingMetaPath = candidate;
      break;
    } catch {
      existingMeta = null;
    }
  }
  if (!existingMeta) {
    const matchingYaml = mediaFiles.find(
      (f) =>
        f.endsWith('.yaml') &&
        !f.startsWith('legacy_') &&
        f !== path.basename(yamlPath) &&
        (f.includes(`_${item.id}-`) || f.startsWith(`${item.id}-`)),
    );
    if (matchingYaml) {
      try {
        existingMeta = yaml.load(
          fs.readFileSync(path.join(mediaDir, matchingYaml), 'utf8'),
        ) as Record<string, unknown> | null;
        existingMetaPath = path.join(mediaDir, matchingYaml);
      } catch {
        existingMeta = null;
      }
    }
  }

  // 1. Write YAML metadata under the storageKey-derived stem
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
  const fileExt = names.ext || (item.mimeType.includes('png') ? '.png' : '.jpg');
  const targetFilePath = path.join(mediaDir, `${baseName}${fileExt}`);

  // Rename an existing mirror into the new name before considering a download, so migrating a workspace
  // costs no bandwidth. Size must match: a same-stem file of a different size is not this asset.
  if (!fs.existsSync(targetFilePath)) {
    const candidates = names.legacyBaseNames
      .map((legacy) => path.join(mediaDir, `${legacy}${fileExt}`))
      .concat(
        mediaFiles
          .filter(
            (f) =>
              !f.endsWith('.yaml') &&
              !f.startsWith('legacy_') &&
              (f.includes(`_${item.id}-`) || f.startsWith(`${item.id}-`)),
          )
          .map((f) => path.join(mediaDir, f)),
      );
    for (const candidate of candidates) {
      if (candidate === targetFilePath || !fs.existsSync(candidate)) continue;
      try {
        const stat = fs.statSync(candidate);
        if (stat.size === item.size) {
          moveFileSafe(candidate, targetFilePath);
          break;
        }
      } catch {}
    }
  }

  if (downloadFiles && canonicalDownloadPath) {
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

  // Register the mirrored asset in media_state. Before storageKey naming, only the push/upload path wrote
  // this table, so a pulled workspace had no index at all and every lookup fell back to scanning YAML. With
  // the mirror name no longer carrying the record id, that index is what makes a body reference resolvable
  // without re-reading thousands of companions. `local_hash` keys on the media id because a pull knows the
  // record, not the local file's bytes — the upload path uses the content hash and simply overwrites.
  if (cache && item.storageKey) {
    const mirrorUrl =
      typeof metaDoc.url === 'string' && metaDoc.url
        ? metaDoc.url
        : `/_emdash/api/media/file/${item.storageKey}`;
    cache.saveMediaState({
      localHash: `media-record:${item.id}`,
      mediaId: item.id,
      storageKey: item.storageKey,
      url: mirrorUrl,
      workspacePath: path.posix.join('media', `${baseName}${fileExt}`),
      markdownRef: path.posix.join('media', baseName),
      status: 'ready',
    });
  }

  // Drop the companion this asset occupied under a legacy stem. Done after the binary rename so an
  // interrupted run never leaves a record whose metadata and bytes disagree about the name.
  if (existingMetaPath && existingMetaPath !== yamlPath && fs.existsSync(existingMetaPath)) {
    try {
      fs.unlinkSync(existingMetaPath);
    } catch {}
  }
  for (const legacy of names.legacyBaseNames) {
    const legacyYaml = path.join(mediaDir, `${legacy}.yaml`);
    if (legacyYaml !== yamlPath && fs.existsSync(legacyYaml)) {
      try {
        fs.unlinkSync(legacyYaml);
      } catch {}
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
  /**
   * Workspace cache. When provided, every mirrored asset is registered in `media_state` with its storageKey
   * and mirror path, which is what lets a body reference resolve by index instead of by filename — mirrors
   * are named after the storageKey and no longer carry the record id.
   */
  cache?: CacheDatabase;
}

export interface PullMediaResult {
  total: number;
  downloaded: number;
  skipped: number;
  deleted?: number;
  /**
   * Media ids that Emit could not mirror in this run. An article-targeted pull collects every ULID a
   * body mentions, but a migrated corpus bakes the R2 `storageKey` into the body URL, and those ULIDs
   * are media ids only by coincidence — so most of them resolve to nothing. That is a known shape of a
   * migrated corpus, not an unresolved reference: for an article-targeted pull this field counts only
   * references that failed every id lookup AND every storageKey check, and `unresolvedIds` below holds
   * the ids that merely resolved to no record.
   */
  failed?: number;
  /**
   * Article-targeted pulls only: how many collected media ULIDs returned no record. Expected for a
   * migrated corpus, where the body URL carries an R2 storageKey rather than a media id, so these are
   * reported separately from `failed` and never presented as unresolved references.
   */
  unresolvedIds?: number;
  articleId?: string;
  mediaIds?: string[];
  /**
   * Body storageKeys confirmed by evidence Emit actually holds: the canonical lookup resolved a record
   * under that ULID (its own storageKey may differ), or a local mirror companion already names it. Such
   * a key is healthy and must never be escalated as missing.
   */
  verifiedStorageKeys?: string[];
  /**
   * Body storageKeys that neither a resolved record nor confirmed local metadata could match.
   * Populated only for an article-targeted pull, where body references are inspected one by one.
   */
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
  cache?: CacheDatabase;
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
  // A body ULID that no canonical lookup resolves is the normal shape of a migrated corpus: the URL
  // carries an R2 storageKey, not a media id. Only a reference that also survives every storageKey
  // check is a problem, so a failed id lookup alone is never reported as `failed`.
  let unresolvedIdCount = 0;
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
        unresolvedIdCount++;
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
        cache: options.cache,
      });

      if (result.downloaded) downloadedCount++;
      else if (result.skipped) skippedCount++;
      resolvedRecordIds.add(mId.toUpperCase());
      if (item.storageKey) recoveredStorageKeys.add(item.storageKey);
    } catch {
      unresolvedIdCount++;
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
    failed: orphanStorageKeys.length,
    unresolvedIds: unresolvedIdCount,
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
      cache: options.cache,
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
    recordsByStorageKey: new Map<string, EmDashMediaItem>(),
    recordsById: new Map<string, EmDashMediaItem>(),
    totalCount: null,
    complete: false,
    scannedCount: 0,
  };

  const activeMediaBaseNames = new Set<string>();
  // Only records the remote walk actually reports may authorise a mirror to stay. Seeding this from local
  // companions instead would make every existing file self-exempt and prune nothing at all.
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
      const names = mediaMirrorNames(item);
      activeMediaBaseNames.add(names.markdownRef);
      for (const legacy of names.legacyBaseNames) {
        activeMediaBaseNames.add(legacy);
      }
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
        cache: options.cache,
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
      // A mirror is identified with its companion YAML: the stem names the storageKey, and the record id
      // lives inside the companion. Only a file Emit can attribute to a record may be pruned — an
      // unattributable migrated name is kept, because deleting an asset over a guess is unrecoverable.
      const stem = file.replace(/\.[^.]+$/, '');
      if (activeMediaBaseNames.has(stem) || activeMediaBaseNames.has(stem.replace(/^\d{8}_/, ''))) {
        continue;
      }
      const companionId = mediaRecordIdForStem(mediaDir, stem);
      if (companionId && !activeMediaIds.has(companionId)) {
        try {
          fs.unlinkSync(path.join(mediaDir, file));
          deletedCount++;
        } catch {
          // Ignore unlink errors
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
  /**
   * The full `EmDashMediaItem` each storageKey resolves to, exactly as the list endpoint reported it.
   * These carry `filename`, `mimeType`, and `size` — everything `mediaMirrorNames()` needs to derive a
   * mirror stem, collision suffix, and extension — so an article-driven mirror can reuse a walked record
   * instead of fetching `GET /_emdash/api/media/{id}` again per asset. A walk that only builds the key set
   * (doctor's coverage check) still populates this; nothing reads it unless a mirror stage asks for it.
   */
  recordsByStorageKey: Map<string, EmDashMediaItem>;
  /** The same records keyed by their record id, so an article body that references a media id resolves too. */
  recordsById: Map<string, EmDashMediaItem>;
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
  const recordsByStorageKey = new Map<string, EmDashMediaItem>();
  const recordsById = new Map<string, EmDashMediaItem>();
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
      if (item.id) recordsById.set(item.id.toUpperCase(), item);
      if (typeof item.storageKey === 'string' && item.storageKey) {
        storageKeys.add(item.storageKey);
        // First record wins a repeated key, so reporting a match stays deterministic.
        if (item.id && !mediaIdsByStorageKey.has(item.storageKey)) {
          mediaIdsByStorageKey.set(item.storageKey, item.id);
        }
        if (!recordsByStorageKey.has(item.storageKey)) {
          recordsByStorageKey.set(item.storageKey, item);
        }
      }
    }

    if (rawItems.length === 0 || typeof data.nextCursor !== 'string' || !data.nextCursor) {
      complete = true;
      break;
    }
    cursor = data.nextCursor;
  }

  return {
    storageKeys,
    mediaIdsByStorageKey,
    recordsByStorageKey,
    recordsById,
    totalCount,
    complete,
    scannedCount: scanned,
  };
}

/** The set of storageKeys a mirror stage actually resolved to a walked record and mirrored. */
export interface MirroredAssetResult {
  /** StorageKeys matched to a walked record and written to `media/` (binary + companion). */
  mirroredStorageKeys: Set<string>;
  /** How many of those were freshly downloaded versus already up-to-date on disk. */
  downloaded: number;
  skipped: number;
  /**
   * Referenced storageKeys no walked record mirrors, but confirmed evidence proves healthy: the walk stored
   * that exact key, or a walked record / local mirror companion names the ULID baked into the key. Such a key
   * is healthy and must never be escalated as missing.
   */
  verifiedStorageKeys: string[];
  /**
   * Referenced storageKeys that no walked record owns and no confirmed local mirror metadata names. A key
   * whose ULID matches a record the walk resolved under that id is downgraded to `verifiedStorageKeys`,
   * never escalated here — Emit mirrors records and never repairs server data.
   */
  orphanStorageKeys: string[];
}

/**
 * Mirrors only the assets a batch of pulled articles actually references, reusing the records the lightweight
 * index walk already fetched instead of paying for a per-asset `GET /_emdash/api/media/{id}`.
 *
 * This is the mirror half of the default-ON local-first pull: the walk phase builds `RemoteStorageKeyIndex`
 * (JSON only, no binaries), and this phase downloads the binary + companion YAML for exactly the storageKeys
 * found in article bodies. A key the walk did not report is NOT proof of a missing record — the record can
 * exist under a different primary key while the body carries an R2 storageKey — so it is re-checked against
 * confirmed evidence only (a walked record resolved under that exact ULID, or local mirror metadata) and what
 * still fails is reported as `orphanStorageKeys`. Emit never fetches such an asset and never registers one.
 */
export async function mirrorReferencedAssetsFromIndex(
  referencedStorageKeys: Iterable<string>,
  index: RemoteStorageKeyIndex,
  options: {
    workspaceRoot: string;
    origin: string;
    token: string;
    refreshToken?: string;
    downloadFiles?: boolean;
    fetchFn?: typeof fetch;
    cache?: CacheDatabase;
  },
): Promise<MirroredAssetResult> {
  const fetchFn = createAuthedFetch(options);
  const downloadFiles = options.downloadFiles !== false;
  const mediaDir = path.join(options.workspaceRoot, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const mirroredStorageKeys = new Set<string>();
  let downloadedCount = 0;
  let skippedCount = 0;

  // Walk every referenced key once. A key resolves to a walked record either directly (the walk reported
  // that exact storageKey) or through a ULID the walk resolved under that record id — the migrated-corpus
  // case where the body URL bakes an R2 storageKey that differs from the record's own primary key.
  const referenced = [...referencedStorageKeys];
  const mirrorCandidates = collectLocalMediaMirrorCandidates(mediaDir);
  const verifiedStorageKeys: string[] = [];
  const orphanStorageKeys: string[] = [];

  for (const key of referenced) {
    let item: EmDashMediaItem | undefined = index.recordsByStorageKey.get(key);
    if (!item) {
      // The body key may itself be a record id the walk stored under `recordsById`, or share a ULID with a
      // walked record. Reuse that record rather than re-fetching it.
      const ulids = (key.match(/[0-9A-HJ-NP-Z]{26}/gi) ?? []).map((u) => u.toUpperCase());
      for (const ulid of ulids) {
        const byId = index.recordsById.get(ulid);
        if (byId) {
          item = byId;
          break;
        }
      }
    }

    if (item) {
      const result = await syncSingleMediaItem({
        item,
        mediaDir,
        origin: options.origin,
        token: options.token,
        downloadFiles,
        fetchFn,
        cache: options.cache,
      });
      if (result.downloaded) downloadedCount++;
      else if (result.skipped) skippedCount++;
      if (item.storageKey) mirroredStorageKeys.add(item.storageKey);
      mirroredStorageKeys.add(key);
      continue;
    }

    // No walked record owns this key. Only two things count as evidence it is healthy: a local mirror
    // companion already names the ULID, or the walk stored a matching storageKey. A bare body reference is
    // never self-confirming — that is precisely the case to report rather than assume healthy.
    const ulids = (key.match(/[0-9A-HJ-NP-Z]{26}/gi) ?? []).map((u) => u.toUpperCase());
    const confirmed =
      index.storageKeys.has(key) ||
      ulids.some((ulid) => index.recordsById.has(ulid) || mirrorCandidates.has(ulid));
    if (confirmed) {
      verifiedStorageKeys.push(key);
    } else {
      orphanStorageKeys.push(key);
    }
  }

  return {
    mirroredStorageKeys,
    downloaded: downloadedCount,
    skipped: skippedCount,
    verifiedStorageKeys,
    orphanStorageKeys,
  };
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
