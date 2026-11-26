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
import { ApiError } from '../../client/error.js';
import { createAuthedFetch } from '../../client/http.js';
import {
  deleteRemoteMedia,
  fetchRemoteMediaDetail,
  resolveImageMimeType,
} from '../../client/media.js';
import { storageKeyFromMediaMeta } from '../../utils/media-companion.js';
import {
  asMediaRecordId,
  toMediaRecordId,
  toStorageKey,
  type MediaRecordId,
} from '../../utils/media-id.js';
import { storageKeyToMarkdownRef } from '../../utils/naming.js';
import { mediaRecordIdForStem, moveFileSafe } from './naming_mirror.js';
import { collectPruneProtectionSets, type PruneProtectionSets } from './prune_protect.js';
import { collectRemoteStorageKeys } from './remote_index.js';
import {
  expandHomePath,
  findCompanionBinaryRelPath,
  findLocalYamlByMediaId,
  findLocalYamlByStorageKey,
  isDirectChildOfMediaDir,
  isExplicitLocalPathTarget,
  readCompanionYamlDoc,
} from './target_resolve.js';
import {
  LOCAL_REFERENCE_SCAN_ONLY_WARNING,
  type DeleteMediaItemResult,
  type DeleteMediaOptions,
  type DeleteMediaResult,
} from './types.js';

export class MediaInUseDeletionForbiddenError extends Error {
  public readonly code = 'MEDIA_IN_USE_PROTECTION';
  public readonly items: DeleteMediaItemResult[];
  public readonly referencedBy: string[];
  public readonly suggestion: string;

  constructor(details: { items: DeleteMediaItemResult[]; referencedBy: string[] }) {
    const refusedItems = details.items.filter((it) => it.action === 'refused');
    const completedItems = details.items.filter(
      (it) => it.action === 'deleted' || it.action === 'already-deleted',
    );
    const refusedSummary = refusedItems
      .map(
        (it) =>
          `${it.target}${it.mediaId ? ` (${it.mediaId})` : ''} -> referenced by ${(it.referencedBy ?? []).join(', ')}`,
      )
      .join('; ');
    const completedNote =
      completedItems.length > 0
        ? ` (Completed ${completedItems.length}/${details.items.length} target(s) before refusal: ${completedItems.map((it) => `${it.target} (${it.action}: ${it.mediaId ?? 'n/a'})`).join(', ')})`
        : '';
    const suggestion =
      'Remove the image reference(s) from the referencing article(s) and push the article changes before deleting this media asset.';
    super(
      `❌ [MEDIA_IN_USE_PROTECTION] Cannot delete media asset(s) currently referenced in local workspace articles: ${refusedSummary}.${completedNote}\n   ${LOCAL_REFERENCE_SCAN_ONLY_WARNING}`,
    );
    this.name = 'MediaInUseDeletionForbiddenError';
    this.items = details.items;
    this.referencedBy = details.referencedBy;
    this.suggestion = suggestion;
  }
}

interface ResolvedDeleteTarget {
  target: string;
  mediaId: MediaRecordId;
  storageKey?: string;
  stem?: string;
  yamlAbsPath?: string;
  binaryAbsPath?: string;
  filePath?: string;
  yamlPath?: string;
  size?: number | null;
}

function hydrateFromYaml(
  workspaceRoot: string,
  mediaDir: string,
  yamlAbsPath: string,
): {
  mediaId: MediaRecordId;
  storageKey?: string;
  stem: string;
  yamlAbsPath: string;
  binaryAbsPath?: string;
  filePath?: string;
  yamlPath: string;
  size?: number | null;
} {
  const resolvedYaml = path.resolve(yamlAbsPath);
  const baseName = path.basename(resolvedYaml);
  if (path.dirname(resolvedYaml) !== mediaDir || baseName.startsWith('legacy_')) {
    throw new ApiError({
      message: `Cannot delete media from "${yamlAbsPath}": only canonical companion files under media/<stem>.yaml are supported.`,
      code: 'INVALID_MEDIA_COMPANION',
      suggestion: 'Pass a valid companion file under media/<stem>.yaml (excluding legacy_*.yaml).',
    });
  }
  const doc = readCompanionYamlDoc(resolvedYaml);
  const mediaId = toMediaRecordId(doc.id);
  if (!mediaId) {
    throw new ApiError({
      message: `Companion YAML "${baseName}" is missing a valid 26-character D1 media record ID ("id:").`,
      code: 'MEDIA_COMPANION_NOT_FOUND',
      suggestion: 'Run "emit pull-media" to refresh local companion YAML metadata from remote.',
    });
  }
  const stem = baseName.replace(/\.ya?ml$/i, '');
  const storageKey =
    (typeof doc.storageKey === 'string' && doc.storageKey ? doc.storageKey : undefined) ??
    storageKeyFromMediaMeta(doc) ??
    undefined;
  const filePath = findCompanionBinaryRelPath(workspaceRoot, mediaDir, stem);
  const binaryAbsPath = filePath ? path.join(workspaceRoot, filePath) : undefined;
  let size: number | null = typeof doc.size === 'number' ? doc.size : null;
  if (size === null && binaryAbsPath && fs.existsSync(binaryAbsPath)) {
    try {
      size = fs.statSync(binaryAbsPath).size;
    } catch {
      size = null;
    }
  }

  return {
    mediaId,
    storageKey,
    stem,
    yamlAbsPath: resolvedYaml,
    binaryAbsPath,
    filePath,
    yamlPath: path.posix.join('media', baseName),
    size,
  };
}

async function resolveSingleDeleteTarget(
  rawTarget: string,
  options: DeleteMediaOptions,
): Promise<ResolvedDeleteTarget> {
  const { workspaceRoot } = options;
  const mediaDir = path.resolve(workspaceRoot, 'media');
  const expanded = expandHomePath(rawTarget.trim());
  const absPath = path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(workspaceRoot, expanded);
  const existsOnDisk = fs.existsSync(absPath);

  if (existsOnDisk) {
    const lower = absPath.toLowerCase();
    // T-A: Local companion YAML
    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
      return {
        target: rawTarget,
        ...hydrateFromYaml(workspaceRoot, mediaDir, absPath),
      };
    }

    // T-B: Local mirrored binary image in media/<stem>.<ext>
    if (isDirectChildOfMediaDir(absPath, workspaceRoot) && resolveImageMimeType(absPath) !== null) {
      const stem = path.basename(absPath, path.extname(absPath));
      const recordId = mediaRecordIdForStem(mediaDir, stem);
      const companionYaml = path.join(mediaDir, `${stem}.yaml`);
      if (!recordId || !fs.existsSync(companionYaml)) {
        throw new ApiError({
          message: `Cannot delete local image "${rawTarget}": companion YAML "${path.posix.join('media', `${stem}.yaml`)}" with a confirmed 26-character D1 record "id:" was not found.`,
          code: 'MEDIA_COMPANION_NOT_FOUND',
          suggestion:
            'Emit never deletes unattributed files in media/ without a companion YAML id. Run "emit pull-media" or remove untracked files manually.',
        });
      }
      return {
        target: rawTarget,
        ...hydrateFromYaml(workspaceRoot, mediaDir, companionYaml),
      };
    }

    throw new ApiError({
      message: `Cannot delete "${rawTarget}": target is not a mirrored media file under media/<stem>.<ext> or media/<stem>.yaml.`,
      code: 'MEDIA_COMPANION_NOT_FOUND',
      suggestion:
        'Pass a mirrored file under media/<stem>.<ext>, its companion media/<stem>.yaml, a storageKey, or a 26-character mediaId.',
    });
  }

  // Missing explicit local file path -> fail immediately without falling through to T-C
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
      suggestion: 'Verify the media file path exists before running emit delete-media.',
    });
  }

  // T-C: <mediaId> or <storageKey>
  const trimmed = rawTarget.trim();
  const directMediaId = toMediaRecordId(trimmed);
  if (directMediaId) {
    const yamlAbsPath = findLocalYamlByMediaId(mediaDir, directMediaId, options.cache);
    if (yamlAbsPath) {
      return {
        target: rawTarget,
        ...hydrateFromYaml(workspaceRoot, mediaDir, yamlAbsPath),
      };
    }
    const state = options.cache?.getMediaStateByMediaId(directMediaId);
    return {
      target: rawTarget,
      mediaId: directMediaId,
      storageKey: state?.storageKey,
      filePath: state?.workspacePath ?? undefined,
    };
  }

  const storageKey = toStorageKey(trimmed);
  if (storageKey) {
    const localResolved = findLocalYamlByStorageKey(
      workspaceRoot,
      mediaDir,
      storageKey,
      options.cache,
    );
    if (localResolved?.yamlAbsPath) {
      return {
        target: rawTarget,
        ...hydrateFromYaml(workspaceRoot, mediaDir, localResolved.yamlAbsPath),
      };
    }
    if (localResolved?.mediaId) {
      return {
        target: rawTarget,
        mediaId: localResolved.mediaId,
        storageKey,
      };
    }

    // In dry-run mode (or without token), never make network calls
    if (!options.dryRun && options.token) {
      const remoteIndex = await collectRemoteStorageKeys({
        workspaceRoot,
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        fetchFn: options.fetchFn,
      });
      const remoteId = remoteIndex.mediaIdsByStorageKey.get(storageKey);
      if (remoteId) {
        const resolvedId = toMediaRecordId(remoteId) ?? asMediaRecordId(remoteId);
        return {
          target: rawTarget,
          mediaId: resolvedId,
          storageKey,
        };
      }
    }

    throw new ApiError({
      message: `Could not resolve R2 storageKey "${storageKey}" to a D1 media record ID${options.dryRun ? ' in offline dry-run mode' : ''}.`,
      code: 'MEDIA_COMPANION_NOT_FOUND',
      suggestion:
        'Run "emit pull-media --storage-key ' +
        storageKey +
        '" first so its D1 record ID is mirrored locally, or pass the 26-character D1 mediaId directly.',
    });
  }

  throw new ApiError({
    message: `Target "${rawTarget}" is neither an existing local mirror file, a valid 26-character mediaId, nor a valid storageKey.`,
    code: 'MISSING_LOCAL_IMAGE_FILE',
    suggestion:
      'Pass a mirrored file under media/<stem>.<ext>, a companion YAML ("media/<stem>.yaml"), a storageKey, or a 26-character mediaId.',
  });
}

function collectReferencingArticlesForTarget(
  resolved: ResolvedDeleteTarget,
  protection: PruneProtectionSets,
): string[] {
  const refs = new Set<string>();
  const upperId = resolved.mediaId.toUpperCase();
  for (const rel of protection.referencingFilesByRecordId.get(upperId) ?? []) {
    refs.add(rel);
  }

  const candidateStems = new Set<string>();
  if (resolved.stem) candidateStems.add(resolved.stem);
  if (resolved.storageKey) {
    const mdRef = storageKeyToMarkdownRef(resolved.storageKey);
    if (mdRef) candidateStems.add(mdRef);
    const withoutExt = resolved.storageKey.replace(/\.[A-Za-z0-9]{1,11}$/, '');
    if (withoutExt) candidateStems.add(withoutExt);
  }

  for (const stem of candidateStems) {
    for (const rel of protection.referencingFilesByStem.get(stem) ?? []) {
      refs.add(rel);
    }
  }

  return Array.from(refs).sort();
}

function cleanupLocalMediaFiles(
  workspaceRoot: string,
  resolved: ResolvedDeleteTarget,
  options: DeleteMediaOptions,
): string[] {
  const backupPaths: string[] = [];
  const mediaDir = path.resolve(workspaceRoot, 'media');
  const trashDir = path.join(mediaDir, '_trash');
  const stem =
    resolved.stem ||
    (resolved.yamlAbsPath ? path.basename(resolved.yamlAbsPath, '.yaml') : undefined) ||
    (resolved.storageKey ? storageKeyToMarkdownRef(resolved.storageKey) : undefined);

  if (!options.noBackup && stem && (resolved.yamlAbsPath || resolved.binaryAbsPath)) {
    fs.mkdirSync(trashDir, { recursive: true });
    if (resolved.yamlAbsPath && fs.existsSync(resolved.yamlAbsPath)) {
      const destYaml = path.join(trashDir, `${stem}.deleted.yaml`);
      moveFileSafe(resolved.yamlAbsPath, destYaml);
      backupPaths.push(path.posix.join('media', '_trash', `${stem}.deleted.yaml`));
    }
    if (resolved.binaryAbsPath && fs.existsSync(resolved.binaryAbsPath)) {
      const ext = path.extname(resolved.binaryAbsPath);
      const destBin = path.join(trashDir, `${stem}.deleted${ext}`);
      moveFileSafe(resolved.binaryAbsPath, destBin);
      backupPaths.push(path.posix.join('media', '_trash', `${stem}.deleted${ext}`));
    }
  } else {
    if (resolved.yamlAbsPath && fs.existsSync(resolved.yamlAbsPath)) {
      try {
        fs.unlinkSync(resolved.yamlAbsPath);
      } catch {}
    }
    if (resolved.binaryAbsPath && fs.existsSync(resolved.binaryAbsPath)) {
      try {
        fs.unlinkSync(resolved.binaryAbsPath);
      } catch {}
    }
  }

  // Ensure any remaining mirror files are unlinked
  if (resolved.yamlAbsPath && fs.existsSync(resolved.yamlAbsPath)) {
    try {
      fs.unlinkSync(resolved.yamlAbsPath);
    } catch {}
  }
  if (resolved.binaryAbsPath && fs.existsSync(resolved.binaryAbsPath)) {
    try {
      fs.unlinkSync(resolved.binaryAbsPath);
    } catch {}
  }

  if (options.cache) {
    if (resolved.storageKey) {
      options.cache.deleteMediaState(resolved.storageKey);
    } else {
      const byId = options.cache.getMediaStateByMediaId(resolved.mediaId);
      if (byId?.storageKey) {
        options.cache.deleteMediaState(byId.storageKey);
      }
    }
  }

  return backupPaths;
}

/**
 * Safely deletes one or more media records from the remote EmDash server and local workspace mirror
 * (`emit delete-media` / `sync_delete_media`).
 *
 * Enforces Guard G20 (`MEDIA_IN_USE_PROTECTION`) before any network request, supports offline
 * `--dry-run`, verifies remote record status before `DELETE /_emdash/api/media/{mediaId}`, and
 * moves local mirrors into `media/_trash/<stem>.deleted.*` only after remote deletion is confirmed.
 */
export async function deleteMedia(options: DeleteMediaOptions): Promise<DeleteMediaResult> {
  if (!options.targets || options.targets.length === 0) {
    throw new Error(
      'At least one target mirror path, companion YAML, storageKey, or mediaId is required.',
    );
  }

  const collection = options.collection || 'posts';
  const protection = collectPruneProtectionSets(options.workspaceRoot, collection);
  const items: DeleteMediaItemResult[] = [];
  const dryRun = Boolean(options.dryRun);
  let hasUnverifiedRemoteUsedIn = dryRun;

  for (const rawTarget of options.targets) {
    const normTarget = rawTarget.replace(/\\/g, '/');
    if (normTarget.includes('media/_cache/') || normTarget.startsWith('_cache/')) {
      items.push({
        target: rawTarget,
        action: 'error',
        error: {
          code: 'MEDIA_COMPANION_NOT_FOUND',
          message: `"${rawTarget}" is inside Emit's derived offline cache (media/_cache/) and cannot be deleted directly. Specify the workspace mirror path (media/<stem>.yaml), D1 mediaId, or storageKey instead.`,
        },
      });
      continue;
    }

    // [0] Resolve target -> { mediaId, storageKey?, mirrorPaths? }
    let resolved: ResolvedDeleteTarget;
    try {
      resolved = await resolveSingleDeleteTarget(rawTarget, options);
    } catch (err) {
      if (err instanceof ApiError) {
        items.push({
          target: rawTarget,
          action: 'error',
          error: {
            code: err.code,
            message: err.message,
          },
        });
        continue;
      }
      throw err;
    }

    // [1] G20 local reference check (0 network calls)
    const referencedBy = collectReferencingArticlesForTarget(resolved, protection);
    if (referencedBy.length > 0) {
      items.push({
        target: rawTarget,
        action: 'refused',
        mediaId: resolved.mediaId,
        storageKey: resolved.storageKey,
        filePath: resolved.filePath,
        yamlPath: resolved.yamlPath,
        size: resolved.size,
        referencedBy,
        error: {
          code: 'MEDIA_IN_USE_PROTECTION',
          message: `Media asset ${resolved.mediaId} is referenced by ${referencedBy.join(', ')}`,
        },
      });
      continue;
    }

    // [2] Dry-run early return for this item (0 network calls)
    if (dryRun) {
      items.push({
        target: rawTarget,
        action: 'deleted',
        mediaId: resolved.mediaId,
        storageKey: resolved.storageKey,
        filePath: resolved.filePath,
        yamlPath: resolved.yamlPath,
        size: resolved.size,
        referencedBy: [],
      });
      continue;
    }

    if (!options.token) {
      items.push({
        target: rawTarget,
        action: 'error',
        mediaId: resolved.mediaId,
        storageKey: resolved.storageKey,
        error: {
          code: 'REMOTE_MEDIA_DELETE_FAILED',
          message: 'Authentication token is required to delete remote media (or pass --dry-run).',
        },
      });
      continue;
    }

    // [3] GET /_emdash/api/media/{mediaId} existence & status check
    const authedFetch = createAuthedFetch({
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      fetchFn: options.fetchFn,
    });
    const detailCheck = await fetchRemoteMediaDetail(resolved.mediaId, {
      origin: options.origin,
      token: options.token,
      fetchFn: authedFetch,
    });

    if (detailCheck.exists === false) {
      const backupPaths = cleanupLocalMediaFiles(options.workspaceRoot, resolved, options);
      items.push({
        target: rawTarget,
        action: 'already-deleted',
        mediaId: resolved.mediaId,
        storageKey: resolved.storageKey,
        filePath: resolved.filePath,
        yamlPath: resolved.yamlPath,
        backupPaths,
        size: resolved.size,
      });
      continue;
    }

    if (
      detailCheck.exists === true &&
      detailCheck.item.status &&
      detailCheck.item.status !== 'ready'
    ) {
      items.push({
        target: rawTarget,
        action: 'error',
        mediaId: resolved.mediaId,
        storageKey: resolved.storageKey ?? detailCheck.item.storageKey,
        filePath: resolved.filePath,
        yamlPath: resolved.yamlPath,
        error: {
          code: 'MEDIA_DELETE_PRECONDITION_FAILED',
          message: `Cannot delete media "${resolved.mediaId}" with remote status "${detailCheck.item.status}" (only "ready" media records can be deleted via delete-media).`,
        },
      });
      continue;
    }

    if (detailCheck.exists === true && !resolved.storageKey && detailCheck.item.storageKey) {
      resolved.storageKey = detailCheck.item.storageKey;
    }

    if (detailCheck.exists === true && detailCheck.item.usedIn !== undefined) {
      if (detailCheck.item.usedIn.length > 0) {
        const remoteRefs = detailCheck.item.usedIn.map((ref) => {
          if (ref.raw) return `remote:${ref.raw}`;
          const col = ref.collection || 'content';
          const titlePart = ref.title ? `"${ref.title}" ` : '';
          const idPart = ref.id || ref.slug || 'unknown';
          return `remote:${col}:${titlePart}(${idPart})`;
        });
        items.push({
          target: rawTarget,
          action: 'refused',
          mediaId: resolved.mediaId,
          storageKey: resolved.storageKey,
          filePath: resolved.filePath,
          yamlPath: resolved.yamlPath,
          referencedBy: remoteRefs,
          size: resolved.size,
        });
        continue;
      }
    } else {
      hasUnverifiedRemoteUsedIn = true;
    }

    // [4] DELETE /_emdash/api/media/{mediaId}
    try {
      const delRes = await deleteRemoteMedia(resolved.mediaId, {
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        fetchFn: options.fetchFn,
      });

      // [5] Local cleanup & backup move ONLY after remote DELETE succeeds
      const backupPaths = cleanupLocalMediaFiles(options.workspaceRoot, resolved, options);
      items.push({
        target: rawTarget,
        action: delRes.notFound ? 'already-deleted' : 'deleted',
        mediaId: resolved.mediaId,
        storageKey: resolved.storageKey,
        filePath: resolved.filePath,
        yamlPath: resolved.yamlPath,
        backupPaths,
        size: resolved.size,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        items.push({
          target: rawTarget,
          action: 'error',
          mediaId: resolved.mediaId,
          storageKey: resolved.storageKey,
          filePath: resolved.filePath,
          yamlPath: resolved.yamlPath,
          error: {
            code: err.code,
            message: err.message,
          },
        });
        continue;
      }
      throw err;
    }
  }

  const warnings = hasUnverifiedRemoteUsedIn ? [LOCAL_REFERENCE_SCAN_ONLY_WARNING] : [];

  // §2.6: In dry-run mode, never throw; return full preview report
  if (dryRun) {
    return { dryRun: true, items, warnings };
  }

  // In execution mode, if any target was refused by Guard G20, throw MediaInUseDeletionForbiddenError
  const refusedItems = items.filter((it) => it.action === 'refused');
  if (refusedItems.length > 0) {
    const allRefs = Array.from(new Set(refusedItems.flatMap((it) => it.referencedBy ?? []))).sort();
    throw new MediaInUseDeletionForbiddenError({ items, referencedBy: allRefs });
  }

  // If any target encountered an operational/resolution error, throw ApiError summarizing completed & failed items
  const errorItems = items.filter((it) => it.action === 'error' && it.error);
  if (errorItems.length > 0) {
    const lastErr = errorItems[errorItems.length - 1]!.error!;
    const completedItems = items.filter(
      (it) => it.action === 'deleted' || it.action === 'already-deleted',
    );
    const completedNote =
      completedItems.length > 0
        ? ` (Completed ${completedItems.length}/${items.length} target(s) before failure: ${completedItems.map((it) => `${it.target} (${it.action}: ${it.mediaId ?? 'n/a'})`).join(', ')})`
        : '';
    const apiErr = new ApiError({
      message: `${errorItems.map((it) => it.error!.message).join('; ')}${completedNote}`,
      code: lastErr.code,
      suggestion:
        'Check the media target path/ID, remote status, and network connectivity before retrying.',
    });
    (apiErr as ApiError & { items?: DeleteMediaItemResult[] }).items = items;
    throw apiErr;
  }

  return { dryRun: false, items, warnings };
}
