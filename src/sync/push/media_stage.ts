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
import { extractMediaUlid, type localToApiPayload } from '../../client/mapper.js';
import {
  toRootRelativeMediaUrl,
  resolveImageMimeType,
  uploadMediaFile,
  fetchRemoteMediaDetail,
  type UploadMediaResult,
} from '../../client/media.js';
import { classifyCodeFenceLines } from '../../client/portable-text.js';
import { promoteDraftMediaFile } from '../media.js';
import { ApiError } from '../../client/error.js';
import type { CacheDatabase } from '../../db/cache.js';
import type { DraftImageReference } from '../preflight.js';
import type { PushOptions } from './types.js';

/**
 * Featured-image preservation / resolution helper.
 *
 * EmDash stores `featured_image: { id: "<ULID>" }`.
 * When pushing an article whose frontmatter sets `featuredImage: <ULID>`, Emit cross-checks that the
 * referenced media exists locally (or was mirrored), and preserves the exact remote object structure
 * from the cache when unchanged.
 */
export function preserveOrResolveFeaturedImage(
  payload: ReturnType<typeof localToApiPayload>,
  featuredImage: string | null | undefined,
  cache: CacheDatabase | undefined,
  id: string,
  workspaceRoot?: string,
): string[] {
  const warnings: string[] = [];
  if (featuredImage === undefined) return warnings;
  if (featuredImage === null) {
    payload.data.featured_image = null;
    return warnings;
  }

  // Canonicalize once: uppercase Crockford base32. extractMediaUlid() also folds a media
  // URL-shaped value back to its ULID so cached-remote comparison still succeeds.
  const targetUlid = (extractMediaUlid(featuredImage) ?? featuredImage.trim()).toUpperCase();

  // 1. Resend the exact remote object when it already points at this media ULID.
  if (cache) {
    try {
      const cachedEntry = cache.getEntry(id);
      if (cachedEntry) {
        const raw = JSON.parse(cachedEntry.rawJson);
        const item = (raw.item || raw) as Record<string, unknown>;
        const itemData = (item.data || {}) as Record<string, unknown>;
        const remoteFi = itemData.featured_image;
        if (remoteFi && extractMediaUlid(remoteFi) === targetUlid) {
          payload.data.featured_image = remoteFi;
          return warnings;
        }
      }
    } catch (err: unknown) {
      // Non-fatal: cache inspection failure falls through to canonical minimal payload.
      warnings.push(
        `[push] Unable to inspect cache for featured_image restoration: ${(err as Error).message}`,
      );
    }
  }

  // 2. Cross-check the reference against the workspace media mirror (verification only).
  //    A missing entry here is NOT a payload problem - { id: <ULID> } is a valid request that
  //    EmDash resolves. It only means Emit cannot confirm the media exists, which is exactly
  //    where a hallucinated or mistyped ULID would surface. A workspace that does not mirror
  //    media (no media/, or an empty one) is not warned about.
  if (workspaceRoot) {
    const mediaDir = path.join(workspaceRoot, 'media');
    const mirrored = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : [];
    if (mirrored.length > 0) {
      let companionFound = false;
      let mismatchedCompanion: { name: string; metaId: string } | null = null;

      for (const f of mirrored) {
        if (!f.endsWith('.yaml') || f.startsWith('legacy_')) continue;
        try {
          const meta = yaml.load(fs.readFileSync(path.join(mediaDir, f), 'utf8')) as Record<
            string,
            unknown
          > | null;
          const metaId = typeof meta?.id === 'string' ? meta.id.trim().toUpperCase() : undefined;
          if (metaId === targetUlid) {
            companionFound = true;
            break;
          }
          if (
            (f.includes(`_${targetUlid}-`) || f.startsWith(`${targetUlid}-`)) &&
            metaId &&
            metaId !== targetUlid
          ) {
            mismatchedCompanion = { name: f, metaId };
          }
        } catch (err: unknown) {
          // Non-fatal: metadata inspection is advisory only.
          warnings.push(
            `[push] Failed to read local media metadata '${f}': ${(err as Error).message}`,
          );
        }
      }

      if (!companionFound) {
        if (mismatchedCompanion) {
          warnings.push(
            `Local media metadata '${mismatchedCompanion.name}' describes a different media ID (${mismatchedCompanion.metaId}); it was ignored for featuredImage ${targetUlid}.`,
          );
        }
        warnings.push(
          `featuredImage ${targetUlid} was not found in the mirrored media under media/, so Emit could not confirm this media ID exists. The ID is sent as-is and EmDash resolves it, but if the ID is wrong the hero image will be missing. Upload the image first (EmDash Admin or media_upload) and use the ULID it returns, or run "emit pull-media" to mirror remote media locally.`,
        );
      }
    }
  }

  // 3. Canonical minimal payload (identical to what localToApiPayload produces).
  payload.data.featured_image = { id: targetUlid };
  return warnings;
}

/**
 * Rewrites standalone local draft image lines in Markdown body to their confirmed
 * canonical root-relative URLs (`/_emdash/api/media/file/<storageKey>`), skipping
 * fenced code blocks and opaque block fences.
 */
export function rewriteDraftImagesInBody(
  body: string,
  draftImages: DraftImageReference[],
  uploadedByAbsPath: Map<string, UploadMediaResult>,
): string {
  if (draftImages.length === 0) return body;

  const rawPathToResult = new Map<string, UploadMediaResult>();
  for (const ref of draftImages) {
    const res = uploadedByAbsPath.get(ref.resolvedAbsPath);
    if (res) {
      rawPathToResult.set(ref.rawPath, res);
      rawPathToResult.set(ref.rawPath.trim(), res);
    }
  }

  const lines = body.split('\n');
  // Same CommonMark-aware fence walker that G5 / G11 use, so a line can never be
  // rewritten here while being skipped there (or vice versa).
  const fenceStates = classifyCodeFenceLines(body);
  const standaloneRegex = /^!\[([^\]]*)\]\(([^)]+)\)$/;

  return lines
    .map((line, index) => {
      const state = fenceStates[index]!;
      if (state.isFenceDelimiter || state.insideCodeFence) {
        return line;
      }

      const hasCr = line.endsWith('\r');
      const cleanLine = hasCr ? line.slice(0, -1) : line;
      const trimmed = cleanLine.trim();

      // Opaque EmDash block fences are managed by G9 and must stay untouched
      if (/^<!--ec:block .+ -->$/.test(trimmed)) {
        return line;
      }

      const match = trimmed.match(standaloneRegex);
      if (!match) return line;

      const alt = match[1];
      const rawPath = match[2];
      const uploaded = rawPathToResult.get(rawPath) ?? rawPathToResult.get(rawPath.trim());
      if (!uploaded) return line;

      const replaced = `![${alt}](${uploaded.url})`;
      return hasCr ? `${replaced}\r` : replaced;
    })
    .join('\n');
}

/**
 * Promotes uploaded draft images from `media/drafts/<filename>` into
 * `media/<markdownRef>.<ext>` along with companion `.yaml` metadata, where markdownRef is derived from the
 * and commits `status = 'ready'` in `media_state`.
 *
 * Protected by try/catch per asset (C-2) so that any local filesystem failure
 * after a successful remote article PUT/POST is downgraded to a warning rather than
 * aborting `saveBaseSnapshot` / `saveSyncState`.
 */
export function finalizePromotedDraftImages(
  draftImages: DraftImageReference[],
  uploadedByAbsPath: Map<string, UploadMediaResult>,
  options: PushOptions,
  warnings: string[],
): void {
  if (draftImages.length === 0) return;

  const processedAbsPaths = new Set<string>();
  const promotedRelPaths: string[] = [];
  const reusedRelPaths: string[] = [];
  const unverifiedAssets: string[] = [];

  for (const ref of draftImages) {
    if (processedAbsPaths.has(ref.resolvedAbsPath)) continue;
    processedAbsPaths.add(ref.resolvedAbsPath);

    const uploaded = uploadedByAbsPath.get(ref.resolvedAbsPath);

    if (ref.alreadyPromoted) {
      reusedRelPaths.push(ref.alreadyPromoted.promotedRelPath);
      if (uploaded?.remoteVerification === 'unknown') {
        unverifiedAssets.push(
          `${ref.alreadyPromoted.promotedRelPath} (${ref.alreadyPromoted.mediaId})${
            uploaded.remoteVerificationNote ? `: ${uploaded.remoteVerificationNote}` : ''
          }`,
        );
      }
      continue;
    }

    if (!uploaded) continue;

    if (uploaded.remoteVerification === 'unknown') {
      unverifiedAssets.push(
        `${uploaded.filename} (${uploaded.mediaId})${
          uploaded.remoteVerificationNote ? `: ${uploaded.remoteVerificationNote}` : ''
        }`,
      );
    }

    try {
      const promoted = promoteDraftMediaFile({
        workspaceRoot: options.workspaceRoot,
        origin: options.origin,
        draftAbsPath: ref.resolvedAbsPath,
        item: {
          id: uploaded.mediaId,
          filename: uploaded.filename,
          mimeType: uploaded.mimeType,
          size: uploaded.size,
          width: uploaded.width ?? null,
          height: uploaded.height ?? null,
          alt: ref.alt || '',
          caption: '',
          storageKey: uploaded.storageKey,
          contentHash: uploaded.contentHash,
          status: 'ready',
          url: uploaded.url,
          createdAt: uploaded.createdAt || new Date().toISOString(),
        },
        removeDraft: true,
      });

      options.cache.saveMediaState({
        localHash: uploaded.localHash,
        mediaId: uploaded.mediaId,
        storageKey: uploaded.storageKey,
        url: uploaded.url,
        workspacePath: promoted.filePath,
        markdownRef: promoted.markdownRef,
        status: 'ready',
      });
      promotedRelPaths.push(promoted.filePath);
    } catch (err: unknown) {
      // Keep status='uploaded' in media_state so subsequent runs know the remote upload succeeded
      warnings.push(
        `[LOCAL_IMAGE_AUTO_UPLOAD] Uploaded '${ref.filename}' (${uploaded.mediaId}) to remote, but failed to promote local file to media/: ${(err as Error).message}`,
      );
    }
  }

  if (promotedRelPaths.length > 0) {
    warnings.push(
      `[LOCAL_IMAGE_AUTO_UPLOAD] Auto-uploaded ${promotedRelPaths.length} draft image(s) and promoted to: ${promotedRelPaths.join(', ')}`,
    );
  }
  if (reusedRelPaths.length > 0) {
    warnings.push(
      `[LOCAL_IMAGE_AUTO_UPLOAD] Reused ${reusedRelPaths.length} already-promoted media asset(s): ${reusedRelPaths.join(', ')}`,
    );
  }
  if (unverifiedAssets.length > 0) {
    warnings.push(
      `[MEDIA_EXISTENCE_UNVERIFIED] The remote server did not confirm these reused media records (GET /_emdash/api/media/{id} unsupported or failed): ${unverifiedAssets.join(', ')}. The cached /_emdash/api/media/file/<storageKey> URL was reused as-is; run "emit pull-media" to re-verify or re-upload if the images 404.`,
    );
  }
}

/**
 * Executes P2–P4 (upload/resolve draft images and rewrite Markdown body in-memory).
 * Already-promoted assets are verified against the remote before their canonical URL is
 * baked into the body, so a media record deleted on the EmDash side can never produce an
 * article that renders HTTP 404 images in production.
 */
export async function uploadAndRewriteDraftImages(
  body: string,
  draftImages: DraftImageReference[],
  options: PushOptions,
  fetchFn: typeof fetch,
): Promise<{ body: string; uploadedByAbsPath: Map<string, UploadMediaResult> }> {
  const uploadedByAbsPath = new Map<string, UploadMediaResult>();
  if (draftImages.length === 0) {
    return { body, uploadedByAbsPath };
  }

  for (const draftRef of draftImages) {
    if (uploadedByAbsPath.has(draftRef.resolvedAbsPath)) {
      continue;
    }

    if (draftRef.alreadyPromoted) {
      const promoted = draftRef.alreadyPromoted;
      const remoteCheck = await fetchRemoteMediaDetail(promoted.mediaId, {
        origin: options.origin,
        token: options.token,
        fetchFn,
      });

      if (remoteCheck.exists === false) {
        // Purge the stale local record so the next run does not keep reusing a dead URL
        const staleState = options.cache.getMediaStateByMediaId(promoted.mediaId);
        if (staleState) {
          options.cache.deleteMediaState(staleState.storageKey);
        }
        throw new ApiError({
          message: `Image '${draftRef.filename}' was already promoted to '${promoted.promotedRelPath}' (media id ${promoted.mediaId}), but that media record no longer exists on remote.`,
          code: 'PROMOTED_MEDIA_NOT_FOUND_REMOTE',
          status: 404,
          endpoint: `/_emdash/api/media/${promoted.mediaId}`,
          suggestion:
            'Restore the media on the EmDash side (then run "emit pull-media"), or place the image back under media/drafts/ and push again so Emit uploads a fresh record.',
        });
      }

      const detail = remoteCheck.exists === true ? remoteCheck.item : undefined;
      const promotedStorageKey = detail?.storageKey || promoted.storageKey;
      uploadedByAbsPath.set(draftRef.resolvedAbsPath, {
        mediaId: promoted.mediaId,
        storageKey: promotedStorageKey,
        url: toRootRelativeMediaUrl(
          detail?.url || promoted.url,
          promotedStorageKey,
          options.origin,
        ),
        localHash: '',
        contentHash: '',
        size: 0,
        mimeType: resolveImageMimeType(draftRef.filename) || 'image/png',
        filename: draftRef.filename,
        deduplicated: true,
        remoteVerification: remoteCheck.exists === true ? 'verified' : 'unknown',
        remoteVerificationNote: remoteCheck.exists === 'unknown' ? remoteCheck.reason : undefined,
      });
      continue;
    }

    const uploadRes = await uploadMediaFile({
      filePath: draftRef.resolvedAbsPath,
      filename: draftRef.filename,
      alt: draftRef.alt || undefined,
      origin: options.origin,
      token: options.token,
      refreshToken: options.refreshToken,
      cache: options.cache,
      fetchFn: options.fetchFn,
    });
    uploadedByAbsPath.set(draftRef.resolvedAbsPath, uploadRes);
  }

  const rewrittenBody = rewriteDraftImagesInBody(body, draftImages, uploadedByAbsPath);
  return { body: rewrittenBody, uploadedByAbsPath };
}
