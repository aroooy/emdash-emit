import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { toRootRelativeMediaUrl } from '../../client/media.js';
import { MEDIA_FILE_ROUTE_PREFIX } from '../../utils/media-refs.js';
import type { EmDashMediaItem, LocalMediaMirrorCandidate } from './types.js';

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
