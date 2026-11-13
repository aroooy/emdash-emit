import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { CacheDatabase } from '../../db/cache.js';
import { toMediaRecordId, asMediaRecordId } from '../../utils/media-id.js';
import { MEDIA_FILE_ROUTE_PREFIX } from '../../utils/media-refs.js';
import { buildMediaMetaDoc } from './companions.js';
import {
  cleanupDuplicateMediaFilesForId,
  mediaMirrorNames,
  mediaRecordIdForStem,
  moveFileSafe,
} from './naming_mirror.js';
import type { EmDashMediaItem, PromoteDraftMediaOptions, PromotedMediaFile } from './types.js';

/**
 * Persists YAML companion metadata and downloads the binary file for a single media item.
 */
export async function syncSingleMediaItem(options: {
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
    const wanted = item.id.toUpperCase();
    for (const f of mediaFiles) {
      if (!f.endsWith('.yaml') || f.startsWith('legacy_') || f === path.basename(yamlPath))
        continue;
      const stem = f.replace(/\.yaml$/, '');
      if (mediaRecordIdForStem(mediaDir, stem) === wanted) {
        try {
          existingMeta = yaml.load(fs.readFileSync(path.join(mediaDir, f), 'utf8')) as Record<
            string,
            unknown
          > | null;
          existingMetaPath = path.join(mediaDir, f);
          break;
        } catch {
          existingMeta = null;
        }
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
    item.url || (item.storageKey ? `${MEDIA_FILE_ROUTE_PREFIX}${item.storageKey}` : '');
  const fileExt = names.ext || (item.mimeType.includes('png') ? '.png' : '.jpg');
  const targetFilePath = path.join(mediaDir, `${baseName}${fileExt}`);

  // Rename an existing mirror into the new name before considering a download, so migrating a workspace
  // costs no bandwidth. Size must match: a same-stem file of a different size is not this asset.
  // Candidates are strictly companion-backed mirrors (or official legacyBaseNames with confirmed companion):
  // Never guess an unbacked binary by filename or file size alone (AGENTS.md §7).
  if (!fs.existsSync(targetFilePath)) {
    const candidateStems: string[] = [];
    for (const legacy of names.legacyBaseNames) {
      if (fs.existsSync(path.join(mediaDir, `${legacy}.yaml`))) {
        candidateStems.push(legacy);
      }
    }
    if (existingMetaPath) {
      const existingStem = path.basename(existingMetaPath, '.yaml');
      if (!candidateStems.includes(existingStem) && existingStem !== baseName) {
        candidateStems.push(existingStem);
      }
    }

    for (const stem of candidateStems) {
      const candidate = path.join(mediaDir, `${stem}${fileExt}`);
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
  // without re-reading thousands of companions.
  if (cache && item.storageKey) {
    const mirrorUrl =
      typeof metaDoc.url === 'string' && metaDoc.url
        ? metaDoc.url
        : `${MEDIA_FILE_ROUTE_PREFIX}${item.storageKey}`;
    cache.saveMediaState({
      localHash: `media-record:${item.id}`,
      mediaId: toMediaRecordId(item.id) ?? asMediaRecordId(item.id),
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
