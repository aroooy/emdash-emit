import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  formatDatePrefix,
  sanitizeTitleForFilename,
  storageKeyToMarkdownRef,
  collisionSuffixedMarkdownRef,
} from '../../utils/frontmatter.js';
import { MEDIA_BINARY_EXTENSIONS, type EmDashMediaItem, type MediaMirrorNames } from './types.js';

/**
 * Moves a file from src to dest, falling back to copy + unlink when src and dest
 * reside on different filesystems (`EXDEV`).
 */
export function moveFileSafe(src: string, dest: string): void {
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
 * Removes any stale duplicate files in `media/` that belong to the same 26-char `mediaId` but sit under a
 * different stem — a leftover date-prefixed name from an earlier local promotion, for instance. Ownership is
 * read from each file's companion YAML rather than from the filename, because a storageKey-named mirror
 * carries no record id at all and must never be matched (or deleted) by a coincidental ULID prefix.
 */
export function cleanupDuplicateMediaFilesForId(
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

/**
 * Resolves the storageKey-derived stem against the names already taken in `media/`. Two distinct keys can
 * sanitize to the same basename — `a/sample.png` and `b/sample.png` both yield `sample` — and a second asset
 * must never overwrite the first. A name already owned by this same record is reused as-is, so re-pulling is
 * idempotent; any other collision gets the deterministic `<stem>--<mediaId>` suffix.
 */
export function resolveMarkdownRefCollision(
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
