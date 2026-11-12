import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { toRootRelativeMediaUrl } from '../../client/media.js';
import type { CacheDatabase } from '../../db/cache.js';
import { MEDIA_FILE_ROUTE_PREFIX } from '../../utils/media-refs.js';
import { storageKeyToMarkdownRef } from '../../utils/naming.js';
import type {
  EmDashMediaItem,
  LocalMediaMirrorCandidate,
  LocalMirrorEntry,
  LocalMirrorIndex,
} from './types.js';

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
      ? `${MEDIA_FILE_ROUTE_PREFIX}${storageKey}`
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

/**
 * Builds a local mirror index mapping storageKey -> LocalMirrorEntry.
 *
 * Driven by cache `media_state` (status 'ready' or 'uploaded') when available.
 * Resolves companion YAML metadata (filename, alt, caption) strictly from companion YAML,
 * never by filename guessing. If companion YAML is absent, metadata is null.
 *
 * For cache-less workspaces, scans `media/*.yaml` and recovers storageKey via storageKeyFromMediaMeta.
 * Leftover `legacy_*` residue is strictly ignored.
 */
export function collectLocalMirrorIndex(
  workspaceRoot: string,
  cache?: CacheDatabase,
): LocalMirrorIndex {
  const index: LocalMirrorIndex = new Map();
  const mediaDir = path.join(workspaceRoot, 'media');

  if (cache) {
    const states = cache.listMediaStates();
    for (const record of states) {
      if (record.status !== 'ready' && record.status !== 'uploaded') continue;
      if (!record.storageKey) continue;

      let stem: string;
      if (record.markdownRef) {
        stem = path.basename(record.markdownRef);
      } else {
        stem = storageKeyToMarkdownRef(record.storageKey) || record.storageKey;
      }

      let filename: string | null = null;
      let alt: string | null = null;
      let caption: string | null = null;

      const yamlPath = path.join(mediaDir, `${stem}.yaml`);
      let loadedDoc: Record<string, unknown> | null = null;

      if (fs.existsSync(yamlPath)) {
        try {
          loadedDoc = yaml.load(fs.readFileSync(yamlPath, 'utf8')) as Record<
            string,
            unknown
          > | null;
        } catch {
          loadedDoc = null;
        }
      } else if (record.workspacePath) {
        const altYamlPath = path.join(
          workspaceRoot,
          record.workspacePath.replace(/\.[^.]+$/, '.yaml'),
        );
        if (fs.existsSync(altYamlPath)) {
          try {
            loadedDoc = yaml.load(fs.readFileSync(altYamlPath, 'utf8')) as Record<
              string,
              unknown
            > | null;
          } catch {
            loadedDoc = null;
          }
        }
      }

      if (loadedDoc) {
        filename =
          typeof loadedDoc.filename === 'string' && loadedDoc.filename ? loadedDoc.filename : null;
        alt = typeof loadedDoc.alt === 'string' && loadedDoc.alt ? loadedDoc.alt : null;
        caption =
          typeof loadedDoc.caption === 'string' && loadedDoc.caption ? loadedDoc.caption : null;
      } else if (fs.existsSync(mediaDir)) {
        // Fallback: search for any companion that confirms this storageKey or mediaId
        for (const f of fs.readdirSync(mediaDir)) {
          if (!f.endsWith('.yaml') || f.startsWith('legacy_')) continue;
          try {
            const candidate = yaml.load(fs.readFileSync(path.join(mediaDir, f), 'utf8')) as Record<
              string,
              unknown
            > | null;
            if (
              candidate &&
              (storageKeyFromMediaMeta(candidate) === record.storageKey ||
                (candidate.id && String(candidate.id).toUpperCase() === record.mediaId))
            ) {
              filename =
                typeof candidate.filename === 'string' && candidate.filename
                  ? candidate.filename
                  : null;
              alt = typeof candidate.alt === 'string' && candidate.alt ? candidate.alt : null;
              caption =
                typeof candidate.caption === 'string' && candidate.caption
                  ? candidate.caption
                  : null;
              break;
            }
          } catch {}
        }
      }

      let localPath: string | null = null;
      if (record.workspacePath && fs.existsSync(path.join(workspaceRoot, record.workspacePath))) {
        localPath = record.workspacePath;
      } else if (fs.existsSync(mediaDir)) {
        const files = fs.readdirSync(mediaDir);
        for (const f of files) {
          if (f.replace(/\.[^.]+$/, '') === stem && !f.endsWith('.yaml')) {
            localPath = path.posix.join('media', f);
            break;
          }
        }
      }

      index.set(record.storageKey, {
        mediaId: record.mediaId,
        storageKey: record.storageKey,
        localPath,
        filename,
        alt,
        caption,
      });
    }
    return index;
  }

  // Cache-less fallback
  if (fs.existsSync(mediaDir)) {
    const files = fs.readdirSync(mediaDir);
    for (const file of files) {
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
      if (!storageKey) continue;

      const stem = file.replace(/\.yaml$/, '');
      const docId =
        typeof doc.id === 'string' && /^[0-9A-HJ-NP-Z]{26}$/i.test(doc.id.trim())
          ? doc.id.trim().toUpperCase()
          : '';

      let binaryPath: string | null = null;
      for (const f of files) {
        if (f !== file && f.replace(/\.[^.]+$/, '') === stem && !f.endsWith('.yaml')) {
          binaryPath = path.posix.join('media', f);
          break;
        }
      }

      index.set(storageKey, {
        mediaId: docId,
        storageKey,
        localPath: binaryPath,
        filename: typeof doc.filename === 'string' && doc.filename ? doc.filename : null,
        alt: typeof doc.alt === 'string' && doc.alt ? doc.alt : null,
        caption: typeof doc.caption === 'string' && doc.caption ? doc.caption : null,
      });
    }
  }

  return index;
}
