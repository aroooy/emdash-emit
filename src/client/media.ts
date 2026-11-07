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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { unwrapEnvelope } from './api.js';
import { ApiError } from './error.js';
import { createAuthedFetch } from './http.js';
import type { CacheDatabase } from '../db/cache.js';

/**
 * Maximum media upload size allowed by EmDash OpenAPI 3.1.0 schema (MediaUploadUrlBody.size.maximum).
 * 50 MiB = 52,428,800 bytes.
 */
export const MAX_MEDIA_UPLOAD_BYTES = 52_428_800;

const SUPPORTED_IMAGE_MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

export function resolveImageMimeType(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  return SUPPORTED_IMAGE_MIME_TYPES[ext] ?? null;
}

export interface MediaHashes {
  /** Emit-internal SHA-256 hex key used exclusively for local media_state table */
  localHash: string;
  /** EmDash server deduplication hash formatted as "sha1:<40-char-hex>" */
  serverContentHash: string;
}

export function computeMediaHashes(buffer: Buffer): MediaHashes {
  const localHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const sha1Hex = crypto.createHash('sha1').update(buffer).digest('hex');
  return {
    localHash,
    serverContentHash: `sha1:${sha1Hex}`,
  };
}

/**
 * Normalizes a media file URL into the canonical root-relative form:
 * `/_emdash/api/media/file/<storageKey>`
 *
 * Note: `storageKey` may be either `<ULID>.<ext>` (legacy migrated media) or
 * `<ULID_1>.<ULID_2>.<ext>` (native EmDash uploads after confirmation). Treat it as an opaque key.
 */
export function toRootRelativeMediaUrl(
  rawUrl: string | undefined | null,
  storageKey: string,
  origin: string,
): string {
  if (rawUrl && typeof rawUrl === 'string' && rawUrl.trim().length > 0) {
    const trimmed = rawUrl.trim();
    if (trimmed.startsWith('/')) {
      return trimmed;
    }
    try {
      const parsed = new URL(trimmed, origin);
      return parsed.pathname;
    } catch {
      // Fall through to storageKey construction
    }
  }
  return `/_emdash/api/media/file/${storageKey}`;
}

export interface MediaUploadUrlResponse {
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  mediaId: string;
  storageKey: string;
  expiresAt: string;
}

export interface MediaExistingResponse {
  existing: true;
  mediaId: string;
  storageKey: string;
  url: string;
}

export interface UploadMediaOptions {
  filePath?: string;
  buffer?: Buffer;
  filename: string;
  contentType?: string;
  origin: string;
  token: string;
  refreshToken?: string;
  alt?: string;
  caption?: string;
  cache?: CacheDatabase;
  fetchFn?: typeof fetch;
}

export interface UploadMediaResult {
  /** Media record ULID (used for frontmatter `featuredImage` and promoted filename prefix) */
  mediaId: string;
  /** Confirmed storage key (used for `/_emdash/api/media/file/<storageKey>`) */
  storageKey: string;
  /** Canonical root-relative URL `/_emdash/api/media/file/<storageKey>` */
  url: string;
  /** SHA-256 hex of the binary file */
  localHash: string;
  /** `sha1:<hex>` content hash */
  contentHash: string;
  size: number;
  mimeType: string;
  filename: string;
  width?: number | null;
  height?: number | null;
  createdAt?: string;
  deduplicated: boolean;
}

export interface CompensationResult {
  compensated: boolean;
  alreadyReadyItem?: Record<string, unknown>;
}

/**
 * Compensating transaction for failed uploads after `POST /_emdash/api/media/upload-url`
 * has created a pending record on the server.
 *
 * 1. Reads `GET /_emdash/api/media/{mediaId}` to inspect `status`.
 * 2. If `status` is `pending` or `failed`, calls `DELETE /_emdash/api/media/{mediaId}`.
 * 3. If `status` is `ready`, preserves the record and returns `alreadyReadyItem`.
 */
export async function compensateOrphanMedia(
  mediaId: string,
  options: { origin: string; token: string; fetchFn: typeof fetch },
): Promise<CompensationResult> {
  const { origin, token, fetchFn } = options;
  const itemUrl = new URL(`/_emdash/api/media/${mediaId}`, origin).toString();
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };

  try {
    const getRes = await fetchFn(itemUrl, { method: 'GET', headers: authHeaders });
    if (getRes.status === 404) {
      return { compensated: true };
    }
    if (getRes.ok) {
      const json = await getRes.json();
      const data = unwrapEnvelope<Record<string, unknown>>(json);
      const item = ((data.item && typeof data.item === 'object' ? data.item : data) ??
        {}) as Record<string, unknown>;
      if (item.status === 'ready') {
        return { compensated: false, alreadyReadyItem: item };
      }
    }
  } catch {
    // Proceed to attempt DELETE even if GET failed due to transient network error
  }

  try {
    const delRes = await fetchFn(itemUrl, { method: 'DELETE', headers: authHeaders });
    if (delRes.ok || delRes.status === 404) {
      return { compensated: true };
    }
    return { compensated: false };
  } catch {
    return { compensated: false };
  }
}

/**
 * Requests an upload target from `POST /_emdash/api/media/upload-url`.
 */
async function requestUploadTarget(
  params: {
    filename: string;
    contentType: string;
    size: number;
    contentHash: string;
  },
  options: { origin: string; token: string; fetchFn: typeof fetch },
): Promise<MediaUploadUrlResponse | MediaExistingResponse> {
  const endpoint = new URL('/_emdash/api/media/upload-url', options.origin).toString();
  const res = await options.fetchFn(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      filename: params.filename,
      contentType: params.contentType,
      size: params.size,
      deduplicate: true,
      contentHash: params.contentHash,
    }),
  });

  if (!res.ok) {
    throw new ApiError({
      message: `Failed to obtain media upload URL for "${params.filename}": ${res.statusText}`,
      code: 'MEDIA_UPLOAD_URL_FAILED',
      status: res.status,
      endpoint,
      suggestion: 'Verify authentication token permissions and network connectivity.',
    });
  }

  const json = await res.json();
  const data = unwrapEnvelope<Record<string, unknown>>(json);

  if (data.existing === true) {
    return {
      existing: true,
      mediaId: String(data.mediaId),
      storageKey: String(data.storageKey),
      url: String(data.url || `/_emdash/api/media/file/${String(data.storageKey)}`),
    };
  }

  return {
    uploadUrl: String(data.uploadUrl),
    method: 'PUT',
    headers:
      data.headers && typeof data.headers === 'object'
        ? (data.headers as Record<string, string>)
        : {},
    mediaId: String(data.mediaId),
    storageKey: String(data.storageKey),
    expiresAt: String(data.expiresAt || ''),
  };
}

/**
 * Executes the confirmed 4-phase EmDash media upload contract with server-side
 * deduplication, local `media_state` idempotency, and orphan-pending compensation.
 */
export async function uploadMediaFile(options: UploadMediaOptions): Promise<UploadMediaResult> {
  const fetchFn = createAuthedFetch(options);
  const rawFetchFn = options.fetchFn || fetch;
  const buffer =
    options.buffer ?? (options.filePath ? fs.readFileSync(options.filePath) : undefined);

  if (!buffer) {
    throw new Error('Either buffer or filePath must be provided to uploadMediaFile.');
  }

  const mimeType = options.contentType || resolveImageMimeType(options.filename);
  if (!mimeType) {
    throw new ApiError({
      message: `Unsupported image MIME type for "${options.filename}".`,
      code: 'INVALID_LOCAL_IMAGE_TYPE',
      endpoint: '/_emdash/api/media/upload-url',
      suggestion: 'Use a supported image format (.jpg, .jpeg, .png, .webp, .gif, .avif, .svg).',
    });
  }

  if (buffer.length > MAX_MEDIA_UPLOAD_BYTES) {
    throw new ApiError({
      message: `Image "${options.filename}" (${buffer.length} bytes) exceeds maximum upload size of ${MAX_MEDIA_UPLOAD_BYTES} bytes (50 MiB).`,
      code: 'LOCAL_IMAGE_SIZE_EXCEEDED',
      endpoint: '/_emdash/api/media/upload-url',
      suggestion: 'Compress or resize the image below 50 MiB before pushing.',
    });
  }

  const { localHash, serverContentHash } = computeMediaHashes(buffer);

  // Check local media_state for recovery from the "upload succeeded -> article PUT failed" window
  if (options.cache) {
    const existingLocal = options.cache.getMediaState(localHash);
    if (
      existingLocal &&
      (existingLocal.status === 'ready' || existingLocal.status === 'uploaded') &&
      existingLocal.mediaId &&
      existingLocal.storageKey &&
      existingLocal.url
    ) {
      return {
        mediaId: existingLocal.mediaId,
        storageKey: existingLocal.storageKey,
        url: existingLocal.url,
        localHash,
        contentHash: serverContentHash,
        size: buffer.length,
        mimeType,
        filename: options.filename,
        deduplicated: true,
      };
    }
  }

  // [Phase A] Request upload target (or existing deduplicated record)
  const initialTarget = await requestUploadTarget(
    {
      filename: options.filename,
      contentType: mimeType,
      size: buffer.length,
      contentHash: serverContentHash,
    },
    { origin: options.origin, token: options.token, fetchFn },
  );

  // Handle server-side deduplication hit
  if ('existing' in initialTarget) {
    const canonicalUrl = toRootRelativeMediaUrl(
      initialTarget.url,
      initialTarget.storageKey,
      options.origin,
    );
    options.cache?.saveMediaState({
      localHash,
      mediaId: initialTarget.mediaId,
      storageKey: initialTarget.storageKey,
      url: canonicalUrl,
      status: 'uploaded',
    });
    return {
      mediaId: initialTarget.mediaId,
      storageKey: initialTarget.storageKey,
      url: canonicalUrl,
      localHash,
      contentHash: serverContentHash,
      size: buffer.length,
      mimeType,
      filename: options.filename,
      deduplicated: true,
    };
  }

  let target: MediaUploadUrlResponse = initialTarget;

  // Check if expiresAt is already expired; if so, clean up old pending mediaId and re-request once
  if (target.expiresAt) {
    const expMs = Date.parse(target.expiresAt);
    if (!Number.isNaN(expMs) && expMs <= Date.now()) {
      await compensateOrphanMedia(target.mediaId, {
        origin: options.origin,
        token: options.token,
        fetchFn,
      });
      const retriedTarget = await requestUploadTarget(
        {
          filename: options.filename,
          contentType: mimeType,
          size: buffer.length,
          contentHash: serverContentHash,
        },
        { origin: options.origin, token: options.token, fetchFn },
      );
      if ('existing' in retriedTarget) {
        const canonicalUrl = toRootRelativeMediaUrl(
          retriedTarget.url,
          retriedTarget.storageKey,
          options.origin,
        );
        options.cache?.saveMediaState({
          localHash,
          mediaId: retriedTarget.mediaId,
          storageKey: retriedTarget.storageKey,
          url: canonicalUrl,
          status: 'uploaded',
        });
        return {
          mediaId: retriedTarget.mediaId,
          storageKey: retriedTarget.storageKey,
          url: canonicalUrl,
          localHash,
          contentHash: serverContentHash,
          size: buffer.length,
          mimeType,
          filename: options.filename,
          deduplicated: true,
        };
      }
      target = retriedTarget;
    }
  }

  const pendingMediaId = target.mediaId;
  const initialStorageKey = target.storageKey;

  // Record pending state immediately so we never lose track of the created server record
  options.cache?.saveMediaState({
    localHash,
    mediaId: pendingMediaId,
    storageKey: initialStorageKey,
    url: toRootRelativeMediaUrl(undefined, initialStorageKey, options.origin),
    status: 'pending',
  });

  try {
    // [Phase B] Stream binary via PUT (either same-origin streaming or signed external URL)
    const putUrlObj = new URL(target.uploadUrl, options.origin);
    const originUrlObj = new URL(options.origin);
    const isSameOrigin = putUrlObj.origin === originUrlObj.origin;

    const putHeaders: Record<string, string> = {
      ...target.headers,
    };
    if (!putHeaders['Content-Type'] && !putHeaders['content-type']) {
      putHeaders['Content-Type'] = mimeType;
    }
    if (isSameOrigin) {
      putHeaders['Authorization'] = `Bearer ${options.token}`;
    }

    const putFn = isSameOrigin ? fetchFn : rawFetchFn;
    const putRes = await putFn(putUrlObj.toString(), {
      method: target.method || 'PUT',
      headers: putHeaders,
      body: new Uint8Array(buffer),
    });

    if (!putRes.ok) {
      throw new ApiError({
        message: `Failed to upload binary for "${options.filename}": ${putRes.statusText}`,
        code: 'MEDIA_BINARY_UPLOAD_FAILED',
        status: putRes.status,
        endpoint: putUrlObj.toString(),
        suggestion: 'Check network stability and retry pushing.',
      });
    }

    // [Phase C] Confirm upload (`POST /_emdash/api/media/{mediaId}/confirm`)
    const confirmEndpoint = new URL(
      `/_emdash/api/media/${pendingMediaId}/confirm`,
      options.origin,
    ).toString();
    const confirmRes = await fetchFn(confirmEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        size: buffer.length,
      }),
    });

    if (!confirmRes.ok) {
      throw new ApiError({
        message: `Failed to confirm media "${options.filename}" (${pendingMediaId}): ${confirmRes.statusText}`,
        code: 'MEDIA_CONFIRM_FAILED',
        status: confirmRes.status,
        endpoint: confirmEndpoint,
        suggestion: 'The uploaded file could not be confirmed by EmDash.',
      });
    }

    const confirmJson = await confirmRes.json();
    const confirmData = unwrapEnvelope<Record<string, unknown>>(confirmJson);
    const item = ((confirmData.item && typeof confirmData.item === 'object'
      ? confirmData.item
      : confirmData) ?? {}) as Record<string, unknown>;

    if (item.status && item.status !== 'ready') {
      throw new ApiError({
        message: `Media "${options.filename}" (${pendingMediaId}) confirmed with unexpected status "${String(item.status)}".`,
        code: 'MEDIA_NOT_READY',
        endpoint: confirmEndpoint,
        suggestion: 'Retry pushing the article.',
      });
    }

    // IMPORTANT: Use the confirmed storageKey and url (EmDash rewrites storageKey to a double-ULID on confirm)
    const confirmedMediaId = typeof item.id === 'string' && item.id ? item.id : pendingMediaId;
    const confirmedStorageKey =
      typeof item.storageKey === 'string' && item.storageKey ? item.storageKey : initialStorageKey;
    const confirmedUrl = toRootRelativeMediaUrl(
      typeof item.url === 'string' ? item.url : undefined,
      confirmedStorageKey,
      options.origin,
    );

    options.cache?.saveMediaState({
      localHash,
      mediaId: confirmedMediaId,
      storageKey: confirmedStorageKey,
      url: confirmedUrl,
      status: 'uploaded',
    });

    return {
      mediaId: confirmedMediaId,
      storageKey: confirmedStorageKey,
      url: confirmedUrl,
      localHash,
      contentHash:
        typeof item.contentHash === 'string' && item.contentHash
          ? item.contentHash
          : serverContentHash,
      size: typeof item.size === 'number' ? item.size : buffer.length,
      mimeType: typeof item.mimeType === 'string' ? item.mimeType : mimeType,
      filename: typeof item.filename === 'string' ? item.filename : options.filename,
      width: typeof item.width === 'number' ? item.width : null,
      height: typeof item.height === 'number' ? item.height : null,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined,
      deduplicated: false,
    };
  } catch (err) {
    // [Compensation] Clean up orphan pending/failed record on server
    const comp = await compensateOrphanMedia(pendingMediaId, {
      origin: options.origin,
      token: options.token,
      fetchFn,
    });

    if (comp.alreadyReadyItem) {
      const readyItem = comp.alreadyReadyItem;
      const confirmedMediaId =
        typeof readyItem.id === 'string' && readyItem.id ? readyItem.id : pendingMediaId;
      const confirmedStorageKey =
        typeof readyItem.storageKey === 'string' && readyItem.storageKey
          ? readyItem.storageKey
          : initialStorageKey;
      const confirmedUrl = toRootRelativeMediaUrl(
        typeof readyItem.url === 'string' ? readyItem.url : undefined,
        confirmedStorageKey,
        options.origin,
      );
      options.cache?.saveMediaState({
        localHash,
        mediaId: confirmedMediaId,
        storageKey: confirmedStorageKey,
        url: confirmedUrl,
        status: 'uploaded',
      });
      return {
        mediaId: confirmedMediaId,
        storageKey: confirmedStorageKey,
        url: confirmedUrl,
        localHash,
        contentHash: serverContentHash,
        size: buffer.length,
        mimeType,
        filename: options.filename,
        deduplicated: false,
      };
    }

    if (comp.compensated) {
      options.cache?.deleteMediaState(localHash);
    } else {
      options.cache?.saveMediaState({
        localHash,
        mediaId: pendingMediaId,
        storageKey: initialStorageKey,
        url: toRootRelativeMediaUrl(undefined, initialStorageKey, options.origin),
        status: 'failed',
      });
      if (err instanceof ApiError) {
        throw new ApiError({
          message: `${err.message} (Orphan pending media record ${pendingMediaId} could not be automatically deleted).`,
          code: err.code,
          status: err.status,
          endpoint: err.endpoint,
          suggestion: `Manually delete pending media ID "${pendingMediaId}" via EmDash Admin (/admin/media) or DELETE /_emdash/api/media/${pendingMediaId}.`,
        });
      }
    }

    throw err;
  }
}
