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
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { ApiError } from '../../client/error.js';
import {
  resolveImageMimeType,
  toRootRelativeMediaUrl,
  updateRemoteMediaMetadata,
  uploadMediaFile,
} from '../../client/media.js';
import type { CacheDatabase } from '../../db/cache.js';
import {
  asMediaRecordId,
  toMediaRecordId,
  toStorageKey,
  type MediaRecordId,
  type StorageKey,
} from '../../utils/media-id.js';
import { probeLocalImageFile } from '../preflight/image_probe.js';
import { collectLocalMediaMirrorCandidates, collectLocalMirrorIndex } from './companions.js';
import { promoteDraftMediaFile } from './mirror_item.js';
import { mediaRecordIdForStem } from './naming_mirror.js';
import { collectRemoteStorageKeys } from './remote_index.js';
import type {
  MEDIA_BINARY_EXTENSIONS,
  PushMediaItemResult,
  PushMediaOptions,
  PushMediaResult,
} from './types.js';
import { MEDIA_BINARY_EXTENSIONS as BINARY_EXTS } from './types.js';

function expandHomePath(raw: string): string {
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

function isExplicitLocalPathTarget(raw: string): boolean {
  const trimmed = raw.trim();
  return (
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('~/') ||
    trimmed.startsWith('media/') ||
    trimmed.includes('\\') ||
    trimmed.endsWith('.yaml') ||
    trimmed.endsWith('.yml')
  );
}

function isInsideMediaDrafts(absPath: string, workspaceRoot: string): boolean {
  const draftsDir = path.resolve(workspaceRoot, 'media', 'drafts');
  const normalized = path.resolve(absPath);
  return normalized.startsWith(draftsDir + path.sep);
}

function isDirectChildOfMediaDir(absPath: string, workspaceRoot: string): boolean {
  const mediaDir = path.resolve(workspaceRoot, 'media');
  return path.dirname(path.resolve(absPath)) === mediaDir;
}

function findCompanionBinaryRelPath(
  workspaceRoot: string,
  mediaDir: string,
  stem: string,
): string | undefined {
  for (const ext of BINARY_EXTS as readonly (typeof MEDIA_BINARY_EXTENSIONS)[number][]) {
    const candidate = path.join(mediaDir, `${stem}${ext}`);
    if (fs.existsSync(candidate)) {
      return path.posix.join('media', path.relative(mediaDir, candidate).split(path.sep).join('/'));
    }
  }
  return undefined;
}

function readCompanionYamlDoc(yamlAbsPath: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = yaml.load(fs.readFileSync(yamlAbsPath, 'utf8'));
  } catch (err) {
    throw new ApiError({
      message: `Failed to parse companion YAML "${yamlAbsPath}": ${(err as Error).message}`,
      code: 'INVALID_MEDIA_COMPANION',
      suggestion: 'Fix the YAML syntax in the media companion file or run "emit pull-media".',
    });
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ApiError({
      message: `Companion YAML "${yamlAbsPath}" does not contain a valid YAML mapping.`,
      code: 'INVALID_MEDIA_COMPANION',
      suggestion: 'Run "emit pull-media" to restore valid media companion metadata.',
    });
  }
  return doc as Record<string, unknown>;
}

function writeUpdatedCompanionYaml(
  yamlAbsPath: string,
  doc: Record<string, unknown>,
  updates: { alt?: string; caption?: string },
): void {
  const nextDoc: Record<string, unknown> = { ...doc };
  if (updates.alt !== undefined) {
    nextDoc.alt = updates.alt;
  }
  if (updates.caption !== undefined) {
    nextDoc.caption = updates.caption;
  }
  fs.writeFileSync(
    yamlAbsPath,
    yaml.dump(nextDoc, { indent: 2, quotingType: '"', forceQuotes: false, lineWidth: -1 }),
    'utf8',
  );
}

async function executeMetadataUpdateFromYaml(params: {
  target: string;
  yamlAbsPath: string;
  workspaceRoot: string;
  options: PushMediaOptions;
}): Promise<PushMediaItemResult> {
  const { target, yamlAbsPath, workspaceRoot, options } = params;
  const mediaDir = path.resolve(workspaceRoot, 'media');
  const resolvedYaml = path.resolve(yamlAbsPath);
  const baseName = path.basename(resolvedYaml);

  if (path.dirname(resolvedYaml) !== mediaDir || baseName.startsWith('legacy_')) {
    throw new ApiError({
      message: `Cannot push media metadata from "${target}": only canonical companion files under media/<stem>.yaml are supported.`,
      code: 'INVALID_MEDIA_COMPANION',
      suggestion: 'Pass a valid companion file under media/<stem>.yaml (excluding legacy_*.yaml).',
    });
  }

  const doc = readCompanionYamlDoc(resolvedYaml);
  const mediaId = toMediaRecordId(doc.id);
  if (!mediaId) {
    throw new ApiError({
      message: `Companion YAML "${target}" is missing a valid 26-character D1 media record ID ("id:").`,
      code: 'INVALID_MEDIA_COMPANION',
      suggestion: 'Run "emit pull-media" to refresh local companion YAML metadata from remote.',
    });
  }

  const effectiveAlt =
    options.alt !== undefined
      ? options.alt.trim()
      : typeof doc.alt === 'string'
        ? doc.alt.trim()
        : undefined;
  const effectiveCaption =
    options.caption !== undefined
      ? options.caption.trim()
      : typeof doc.caption === 'string'
        ? doc.caption.trim()
        : undefined;

  await updateRemoteMediaMetadata(
    mediaId,
    { alt: effectiveAlt, caption: effectiveCaption },
    {
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      fetchFn: options.fetchFn,
    },
  );

  // If explicit flags were supplied, persist them back into the local companion YAML while preserving all other fields
  if (options.alt !== undefined || options.caption !== undefined) {
    writeUpdatedCompanionYaml(resolvedYaml, doc, {
      alt: effectiveAlt,
      caption: effectiveCaption,
    });
  }

  const stem = baseName.replace(/\.ya?ml$/i, '');
  const storageKey =
    typeof doc.storageKey === 'string' && doc.storageKey ? doc.storageKey : undefined;
  const url =
    typeof doc.url === 'string' && doc.url
      ? doc.url
      : storageKey
        ? toRootRelativeMediaUrl(undefined, storageKey, options.origin)
        : undefined;

  return {
    target,
    action: 'metadata-updated',
    mediaId,
    storageKey,
    url,
    filePath: findCompanionBinaryRelPath(workspaceRoot, mediaDir, stem),
    yamlPath: path.posix.join('media', baseName),
    alt: effectiveAlt ?? '',
    caption: effectiveCaption ?? '',
  };
}

function findLocalYamlByMediaId(
  mediaDir: string,
  mediaId: MediaRecordId,
  cache?: CacheDatabase,
): string | null {
  const candidates = collectLocalMediaMirrorCandidates(mediaDir);
  const candidate = candidates.get(mediaId);
  if (candidate) {
    const abs = path.join(mediaDir, candidate.metaFile);
    if (fs.existsSync(abs)) return abs;
  }
  const state = cache?.getMediaStateByMediaId(mediaId);
  if (state?.markdownRef) {
    const abs = path.join(path.dirname(mediaDir), `${state.markdownRef}.yaml`);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function findLocalYamlByStorageKey(
  workspaceRoot: string,
  mediaDir: string,
  storageKey: StorageKey,
  cache?: CacheDatabase,
): { mediaId: MediaRecordId; yamlAbsPath: string | null } | null {
  const state = cache?.getMediaStateByStorageKey(storageKey);
  if (state?.mediaId) {
    const mediaId = toMediaRecordId(state.mediaId) ?? asMediaRecordId(state.mediaId);
    let yamlAbsPath: string | null = null;
    if (state.markdownRef) {
      const candidate = path.join(workspaceRoot, `${state.markdownRef}.yaml`);
      if (fs.existsSync(candidate)) yamlAbsPath = candidate;
    }
    if (!yamlAbsPath) {
      yamlAbsPath = findLocalYamlByMediaId(mediaDir, mediaId, cache);
    }
    return { mediaId, yamlAbsPath };
  }

  const mirrorIndex = collectLocalMirrorIndex(workspaceRoot, cache);
  const entry = mirrorIndex.get(storageKey);
  if (entry?.mediaId) {
    const mediaId = toMediaRecordId(entry.mediaId) ?? asMediaRecordId(entry.mediaId);
    const yamlAbsPath = findLocalYamlByMediaId(mediaDir, mediaId, cache);
    return { mediaId, yamlAbsPath };
  }

  return null;
}

async function executeNewBinaryUpload(params: {
  target: string;
  absPath: string;
  workspaceRoot: string;
  options: PushMediaOptions;
}): Promise<PushMediaItemResult> {
  const { target, absPath, workspaceRoot, options } = params;
  const filename = path.basename(absPath);
  const probe = probeLocalImageFile(absPath, filename);
  if (!probe.ok) {
    if (probe.failure.code === 'MISSING_LOCAL_IMAGE_FILE') {
      throw new ApiError({
        message: `Local image file not found or not a regular file: "${target}".`,
        code: 'MISSING_LOCAL_IMAGE_FILE',
        suggestion: 'Verify the image file path exists before running emit push-media.',
      });
    }
    if (probe.failure.code === 'INVALID_LOCAL_IMAGE_TYPE') {
      throw new ApiError({
        message: `Unsupported image MIME type for "${filename}".`,
        code: 'INVALID_LOCAL_IMAGE_TYPE',
        suggestion: 'Use a supported image format (.jpg, .jpeg, .png, .webp, .gif, .avif, .svg).',
      });
    }
    throw new ApiError({
      message: `Image "${filename}" (${probe.failure.sizeBytes} bytes) exceeds maximum upload size of ${probe.failure.maxBytes} bytes (50 MiB).`,
      code: 'LOCAL_IMAGE_SIZE_EXCEEDED',
      suggestion: 'Compress or resize the image below 50 MiB before pushing.',
    });
  }

  const uploaded = await uploadMediaFile({
    filePath: absPath,
    filename,
    alt: options.alt,
    caption: options.caption,
    origin: options.origin,
    token: options.token,
    refreshToken: options.refreshToken,
    cache: options.cache,
    fetchFn: options.fetchFn,
  });

  // If the user explicitly passed --alt "" or --caption "" on a dedup hit, apply strict metadata update too
  if (
    uploaded.deduplicated &&
    ((options.alt !== undefined && options.alt.trim() === '') ||
      (options.caption !== undefined && options.caption.trim() === ''))
  ) {
    await updateRemoteMediaMetadata(
      uploaded.mediaId,
      { alt: options.alt, caption: options.caption },
      {
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        fetchFn: options.fetchFn,
      },
    );
  }

  const removeDraft = isInsideMediaDrafts(absPath, workspaceRoot);
  const promoted = promoteDraftMediaFile({
    workspaceRoot,
    origin: options.origin,
    draftAbsPath: absPath,
    item: {
      id: uploaded.mediaId,
      filename: uploaded.filename,
      mimeType: uploaded.mimeType,
      size: uploaded.size,
      width: uploaded.width ?? null,
      height: uploaded.height ?? null,
      alt: options.alt !== undefined ? options.alt.trim() : undefined,
      caption: options.caption !== undefined ? options.caption.trim() : undefined,
      storageKey: uploaded.storageKey,
      contentHash: uploaded.contentHash,
      status: 'ready',
      url: uploaded.url,
      createdAt: uploaded.createdAt || new Date().toISOString(),
    },
    removeDraft,
  });

  // If explicit empty string was provided for alt/caption, ensure companion YAML reflects "" instead of fallback
  const yamlAbsPath = path.join(workspaceRoot, `${promoted.markdownRef}.yaml`);
  if (
    fs.existsSync(yamlAbsPath) &&
    ((options.alt !== undefined && options.alt.trim() === '') ||
      (options.caption !== undefined && options.caption.trim() === ''))
  ) {
    const doc = readCompanionYamlDoc(yamlAbsPath);
    writeUpdatedCompanionYaml(yamlAbsPath, doc, {
      alt: options.alt !== undefined ? options.alt.trim() : undefined,
      caption: options.caption !== undefined ? options.caption.trim() : undefined,
    });
  }

  options.cache?.saveMediaState({
    localHash: uploaded.localHash,
    localContentHash: uploaded.localHash,
    mediaId: uploaded.mediaId,
    storageKey: uploaded.storageKey,
    url: uploaded.url,
    workspacePath: promoted.filePath,
    markdownRef: promoted.markdownRef,
    status: 'ready',
  });

  const finalYamlDoc = fs.existsSync(yamlAbsPath) ? readCompanionYamlDoc(yamlAbsPath) : null;

  return {
    target,
    action: uploaded.deduplicated ? 'deduplicated' : 'uploaded',
    mediaId: uploaded.mediaId,
    storageKey: uploaded.storageKey,
    url: uploaded.url,
    filePath: promoted.filePath,
    yamlPath: `${promoted.markdownRef}.yaml`,
    alt:
      typeof finalYamlDoc?.alt === 'string'
        ? finalYamlDoc.alt
        : options.alt !== undefined
          ? options.alt.trim()
          : '',
    caption:
      typeof finalYamlDoc?.caption === 'string'
        ? finalYamlDoc.caption
        : options.caption !== undefined
          ? options.caption.trim()
          : '',
  };
}

async function executeIdOrStorageKeyUpdate(params: {
  target: string;
  workspaceRoot: string;
  options: PushMediaOptions;
}): Promise<PushMediaItemResult> {
  const { target, workspaceRoot, options } = params;
  const mediaDir = path.resolve(workspaceRoot, 'media');
  const trimmed = target.trim();

  // 1. Check if target is a canonical 26-char D1 mediaId
  const directMediaId = toMediaRecordId(trimmed);
  if (directMediaId) {
    const yamlAbsPath = findLocalYamlByMediaId(mediaDir, directMediaId, options.cache);
    if (yamlAbsPath) {
      return await executeMetadataUpdateFromYaml({
        target,
        yamlAbsPath,
        workspaceRoot,
        options,
      });
    }
    if (options.alt === undefined && options.caption === undefined) {
      throw new ApiError({
        message: `Media ID "${directMediaId}" is not mirrored locally under media/, and no --alt or --caption flags were provided.`,
        code: 'MEDIA_METADATA_UPDATE_REQUIRED',
        suggestion:
          'Provide --alt and/or --caption explicitly, or run "emit pull-media" first to mirror its companion YAML.',
      });
    }
    const updated = await updateRemoteMediaMetadata(
      directMediaId,
      { alt: options.alt, caption: options.caption },
      {
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        fetchFn: options.fetchFn,
      },
    );
    return {
      target,
      action: 'metadata-updated',
      mediaId: directMediaId,
      alt: updated.alt,
      caption: updated.caption,
    };
  }

  // 2. Check if target is an R2 storageKey (never pass storageKey directly to PUT /_emdash/api/media/{mediaId})
  const storageKey = toStorageKey(trimmed);
  if (storageKey) {
    const localResolved = findLocalYamlByStorageKey(
      workspaceRoot,
      mediaDir,
      storageKey,
      options.cache,
    );
    if (localResolved?.yamlAbsPath) {
      return await executeMetadataUpdateFromYaml({
        target,
        yamlAbsPath: localResolved.yamlAbsPath,
        workspaceRoot,
        options,
      });
    }

    let resolvedMediaId: MediaRecordId | null = localResolved?.mediaId ?? null;
    if (!resolvedMediaId) {
      const remoteIndex = await collectRemoteStorageKeys({
        workspaceRoot,
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        fetchFn: options.fetchFn,
      });
      const remoteId = remoteIndex.mediaIdsByStorageKey.get(storageKey);
      if (remoteId) {
        resolvedMediaId = toMediaRecordId(remoteId) ?? asMediaRecordId(remoteId);
      }
    }

    if (!resolvedMediaId) {
      throw new ApiError({
        message: `Could not resolve R2 storageKey "${storageKey}" to a D1 media record ID (or local image file "${target}" was not found).`,
        code: 'MISSING_LOCAL_IMAGE_FILE',
        suggestion:
          'If this is a local file, check the file path. If it is a remote storageKey, run "emit pull-media --storage-key ' +
          storageKey +
          '" first.',
      });
    }

    if (options.alt === undefined && options.caption === undefined) {
      throw new ApiError({
        message: `StorageKey "${storageKey}" (mediaId: ${resolvedMediaId}) has no local companion YAML under media/, and no --alt or --caption flags were provided.`,
        code: 'MEDIA_METADATA_UPDATE_REQUIRED',
        suggestion:
          'Provide --alt and/or --caption explicitly, or run "emit pull-media --storage-key ' +
          storageKey +
          '" first.',
      });
    }

    const updated = await updateRemoteMediaMetadata(
      resolvedMediaId,
      { alt: options.alt, caption: options.caption },
      {
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        fetchFn: options.fetchFn,
      },
    );
    return {
      target,
      action: 'metadata-updated',
      mediaId: resolvedMediaId,
      storageKey,
      url: toRootRelativeMediaUrl(undefined, storageKey, options.origin),
      alt: updated.alt,
      caption: updated.caption,
    };
  }

  throw new ApiError({
    message: `Target "${target}" is neither an existing local file, a valid 26-character mediaId, nor a valid storageKey.`,
    code: 'MISSING_LOCAL_IMAGE_FILE',
    suggestion:
      'Pass an existing local image path (e.g. "media/drafts/photo.jpg"), a companion YAML ("media/<stem>.yaml"), a storageKey, or a 26-character mediaId.',
  });
}

/**
 * Unified standalone media upload and metadata sync (`emit push-media` / `sync_push_media`).
 *
 * - Mode A (`media/<stem>.yaml`): Updates remote `alt`/`caption` via `PUT /_emdash/api/media/{mediaId}`
 *   from explicit `--alt`/`--caption` flags or from the edited local companion YAML.
 * - Mode B (existing local image file):
 *   - B-1: If the file sits directly in `media/<stem>.<ext>` and has a companion `media/<stem>.yaml`
 *     with a valid 26-char `id:`, deterministically routes to Mode A metadata update.
 *   - B-2: Otherwise probes, uploads (4-phase contract + dedup), and mirrors/promotes into `media/`
 *     (`media/drafts/*` is moved; external/other paths are copied so user originals are preserved).
 * - Mode C (`<mediaId>` or `<storageKey>`): Resolves `storageKey` -> D1 `mediaId` (respecting the
 *   Two Media ID Spaces invariant) and updates remote metadata + local companion YAML if present.
 */
export async function pushMedia(options: PushMediaOptions): Promise<PushMediaResult> {
  if (!options.targets || options.targets.length === 0) {
    throw new Error(
      'At least one target file path, companion YAML, storageKey, or mediaId is required.',
    );
  }

  const items: PushMediaItemResult[] = [];
  const mediaDir = path.resolve(options.workspaceRoot, 'media');

  for (const rawTarget of options.targets) {
    try {
      const expanded = expandHomePath(rawTarget.trim());
      const absPath = path.isAbsolute(expanded)
        ? path.normalize(expanded)
        : path.resolve(options.workspaceRoot, expanded);
      const existsOnDisk = fs.existsSync(absPath);

      if (existsOnDisk) {
        const lower = absPath.toLowerCase();
        // Mode A: Companion YAML
        if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
          items.push(
            await executeMetadataUpdateFromYaml({
              target: rawTarget,
              yamlAbsPath: absPath,
              workspaceRoot: options.workspaceRoot,
              options,
            }),
          );
          continue;
        }

        // Mode B-1: Deterministic routing for already-mirrored image in media/<stem>.<ext> with valid companion YAML id
        if (
          isDirectChildOfMediaDir(absPath, options.workspaceRoot) &&
          resolveImageMimeType(absPath) !== null
        ) {
          const stem = path.basename(absPath, path.extname(absPath));
          const existingRecordId = mediaRecordIdForStem(mediaDir, stem);
          const companionYaml = path.join(mediaDir, `${stem}.yaml`);
          if (existingRecordId && fs.existsSync(companionYaml)) {
            items.push(
              await executeMetadataUpdateFromYaml({
                target: rawTarget,
                yamlAbsPath: companionYaml,
                workspaceRoot: options.workspaceRoot,
                options,
              }),
            );
            continue;
          }
        }

        // Mode B-2: New local image upload
        items.push(
          await executeNewBinaryUpload({
            target: rawTarget,
            absPath,
            workspaceRoot: options.workspaceRoot,
            options,
          }),
        );
        continue;
      }

      // Target does not exist on disk: guard explicit file paths from falling through into storageKey lookup
      if (isExplicitLocalPathTarget(rawTarget)) {
        const lower = rawTarget.trim().toLowerCase();
        if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
          throw new ApiError({
            message: `Companion YAML file not found: "${rawTarget}".`,
            code: 'MEDIA_COMPANION_NOT_FOUND',
            suggestion:
              'Verify the path under media/<stem>.yaml or run "emit pull-media" to mirror remote media metadata.',
          });
        }
        throw new ApiError({
          message: `Local image file not found: "${rawTarget}".`,
          code: 'MISSING_LOCAL_IMAGE_FILE',
          suggestion: 'Verify the image file path exists before running emit push-media.',
        });
      }

      // Mode C: <mediaId> or <storageKey> metadata update
      items.push(
        await executeIdOrStorageKeyUpdate({
          target: rawTarget,
          workspaceRoot: options.workspaceRoot,
          options,
        }),
      );
    } catch (err) {
      if (items.length > 0 && err instanceof Error) {
        const completedSummary = items
          .map((it) => `${it.target} (${it.action}: ${it.mediaId})`)
          .join(', ');
        err.message = `${err.message} (Completed ${items.length}/${options.targets.length} target(s) before failure: ${completedSummary})`;
      }
      throw err;
    }
  }

  return { items };
}
