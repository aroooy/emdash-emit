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
import type { CacheDatabase } from '../db/cache.js';
import { withEntryLock } from '../client/lock.js';
import {
  apiResponseToLocal,
  extractMediaUlid,
  localToApiPayload,
  type MapperOptions,
} from '../client/mapper.js';
import { ApiError } from '../client/error.js';
import { createAuthedFetch } from '../client/http.js';
import { unwrapItem, extractRev } from '../client/api.js';
import { classifyCodeFenceLines } from '../client/portable-text.js';
import {
  computeArticleRelativePath,
  extractDatePrefixFromPath,
  formatFrontmatterParseError,
  parseMarkdown,
  serializeMarkdown,
  type Frontmatter,
  type ParsedMarkdown,
  type TaxonomyCandidates,
} from '../utils/frontmatter.js';
import {
  getLocalTaxonomiesSummary,
  loadLocalTaxonomyMaps,
  loadLocalTaxonomyCandidates,
} from './taxonomies.js';
import { runPreflightChecks, type DraftImageReference, type PreflightError } from './preflight.js';
import { calculateHash, CONFLICTS_SUBDIR, isQuarantinedRelativePath } from './pull.js';
import { hybrid3WayMerge } from './merge.js';
import { syncRemoteBylines } from './bylines.js';
import {
  fetchRemoteMediaDetail,
  resolveImageMimeType,
  toRootRelativeMediaUrl,
  uploadMediaFile,
  type UploadMediaResult,
} from '../client/media.js';
import { promoteDraftMediaFile } from './media.js';

export interface PushOptions extends MapperOptions {
  workspaceRoot: string;
  cache: CacheDatabase;
  origin: string;
  token: string;
  refreshToken?: string;
  fetchFn?: typeof fetch;
  candidates?: TaxonomyCandidates;
  knownTaxonomies?: Record<string, string[]>;
}

export interface ResolvedTaxonomyItem {
  input: string;
  resolved: string;
  id: string;
}

export interface PushResult {
  success: boolean;
  id: string;
  rev: string;
  filePath: string;
  previousId?: string;
  previousFilePath?: string;
  conflict: boolean;
  warnings: string[];
  errors?: PreflightError[];
  resolvedTaxonomies?: {
    categories?: ResolvedTaxonomyItem[];
    tags?: ResolvedTaxonomyItem[];
    [taxonomy: string]: ResolvedTaxonomyItem[] | undefined;
  };
}

export class PushValidationError extends Error {
  public errors: PreflightError[];

  constructor(message: string, errors: PreflightError[]) {
    super(message);
    this.name = 'PushValidationError';
    this.errors = errors;
  }
}

/**
 * Helper to transition content status via EmDash /publish or /unpublish endpoints.
 */
async function transitionContentStatus(
  collection: string,
  id: string,
  targetStatus: 'draft' | 'published',
  currentRev: string,
  publishedAt: string | null | undefined,
  options: PushOptions,
  fetchFn: typeof fetch,
): Promise<string> {
  const isPublishing = targetStatus === 'published';
  const endpoint = new URL(
    `/_emdash/api/content/${collection}/${id}/${isPublishing ? 'publish' : 'unpublish'}`,
    options.origin,
  ).toString();

  const body: Record<string, unknown> = { _rev: currentRev };
  if (isPublishing && publishedAt) {
    body.publishedAt = publishedAt;
  }

  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new ApiError({
      message: `Failed to ${isPublishing ? 'publish' : 'unpublish'} content: ${res.statusText}${errText ? ` - ${errText}` : ''}`,
      code: isPublishing ? 'PUBLISH_FAILED' : 'UNPUBLISH_FAILED',
      status: res.status,
      endpoint,
      suggestion: isPublishing
        ? 'Verify publish permissions and revision state.'
        : 'Verify unpublish permissions and revision state.',
    });
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return extractRev(json, currentRev);
}

/**
 * Determines the featured_image value to send to EmDash, returning any warnings.
 *
 * Contract (confirmed against production EmDash): `featured_image: { id: <ULID> }` is
 * accepted on its own and resolved server-side - the server stores the media id and
 * normalizes `provider` itself for media held in the media library. Clients must never
 * fabricate provider, src, storageKey or dimensions.
 *
 * - undefined : leave the payload untouched (field omitted, remote value preserved).
 * - null      : send an explicit null to clear the hero image.
 * - otherwise : if the cached remote entry references the same media ULID, resend the remote
 *               object verbatim so its original shape (provider "external" with src, or
 *               provider "local" with meta.storageKey, blurhash and dimensions) survives the
 *               round-trip byte-for-byte rather than being re-resolved from a bare id.
 *               Otherwise send the canonical minimal { id: <ULID> }.
 *
 * Local media/*.yaml is never a payload source: it lacks meta.storageKey, and re-sending
 * possibly stale companion metadata would overwrite authoritative remote state. The companion
 * file is used only to cross-check that a referenced ULID is one this workspace knows about.
 */
function preserveOrResolveFeaturedImage(
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
      // Anchored on the id segment so a ULID appearing inside another media item's
      // filename can never be mistaken for its own metadata file.
      const companion = mirrored.find(
        (f) =>
          f.endsWith('.yaml') && (f.includes(`_${targetUlid}-`) || f.startsWith(`${targetUlid}-`)),
      );
      if (companion) {
        try {
          const meta = yaml.load(fs.readFileSync(path.join(mediaDir, companion), 'utf8')) as Record<
            string,
            unknown
          > | null;
          const metaId = typeof meta?.id === 'string' ? meta.id.trim().toUpperCase() : undefined;
          if (metaId && metaId !== targetUlid) {
            warnings.push(
              `Local media metadata '${companion}' describes a different media ID (${metaId}); it was ignored for featuredImage ${targetUlid}.`,
            );
          }
        } catch (err: unknown) {
          // Non-fatal: metadata inspection is advisory only.
          warnings.push(
            `[push] Failed to read local media metadata '${companion}': ${(err as Error).message}`,
          );
        }
      } else {
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
function rewriteDraftImagesInBody(
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
 * `media/<yyyyMMdd>_<mediaId>-<name>.<ext>` along with companion `.yaml` metadata,
 * and commits `status = 'ready'` in `media_state`.
 *
 * Protected by try/catch per asset (C-2) so that any local filesystem failure
 * after a successful remote article PUT/POST is downgraded to a warning rather than
 * aborting `saveBaseSnapshot` / `saveSyncState`.
 */
function finalizePromotedDraftImages(
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
      const promotedRelPath = promoteDraftMediaFile({
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
        workspacePath: promotedRelPath,
        status: 'ready',
      });
      promotedRelPaths.push(promotedRelPath);
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
async function uploadAndRewriteDraftImages(
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
          options.cache.deleteMediaState(staleState.localHash);
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

/**
 * Pushes a local markdown article to remote EmDash with full preflight guards,
 * two-tier lock lease protection, and automatic 3-way merge on conflict.
 */
export async function pushArticle(
  targetFilePath: string,
  options: PushOptions,
): Promise<PushResult> {
  const fetchFn = createAuthedFetch(options);
  const fullPath = path.isAbsolute(targetFilePath)
    ? targetFilePath
    : path.join(options.workspaceRoot, targetFilePath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Target file not found: ${targetFilePath}`);
  }

  const originalRelPath = path.relative(options.workspaceRoot, fullPath);

  // Rescue copies under "<collection>/conflicts/" are deliberately unpushable. They exist only to
  // retain divergent local content that a pull was about to overwrite; pushing one as-is would
  // replace the canonical article's remote title/slug/body with stale divergent content and
  // regenerate the duplicate-file-for-one-ULID state that quarantine exists to repair.
  if (isQuarantinedRelativePath(originalRelPath)) {
    throw new PushValidationError(`Refusing to push a preserved rescue copy: ${originalRelPath}`, [
      {
        code: 'QUARANTINED_COPY_NOT_PUSHABLE',
        message:
          `'${originalRelPath}' is a preserved rescue copy under "${CONFLICTS_SUBDIR}/". ` +
          'Rescue copies hold stale divergent content captured before a pull overwrote it; ' +
          'pushing one would overwrite the canonical article of the same ULID and recreate duplicate local files.',
        suggestion:
          'Merge the valuable lines into the canonical article file (posts/draft/... or posts/published/...), then delete this copy. ' +
          'To intentionally replace the remote version, copy the rescue file over the canonical path and push that canonical path instead.',
      },
    ]);
  }

  const rawContent = fs.readFileSync(fullPath, 'utf8');
  const parsed = parseMarkdown(rawContent, targetFilePath);
  const id = parsed.frontmatter.id;
  const collection = parsed.frontmatter.collection;

  // Retrieve sync state and base snapshot
  const syncState = options.cache.getSyncState(id);
  const baseSnapshot = options.cache.getBaseSnapshot(id);

  // Pre-load local taxonomy maps once for canonicalization, G4 guard, and remote sync
  const taxonomyMaps = loadLocalTaxonomyMaps(options.workspaceRoot);

  const resolvedTaxonomies: {
    categories?: ResolvedTaxonomyItem[];
    tags?: ResolvedTaxonomyItem[];
    [taxonomy: string]: ResolvedTaxonomyItem[] | undefined;
  } = {};

  const canonicalizeTerms = (taxName: 'category' | 'tag', terms: string[]): string[] => {
    const list: ResolvedTaxonomyItem[] = [];
    const canonicalized = terms.map((term) => {
      // 1. If term is a ULID in idToSlug
      if (taxonomyMaps.idToSlug[taxName]?.[term]) {
        const canonicalSlug = taxonomyMaps.idToSlug[taxName][term];
        list.push({ input: term, resolved: canonicalSlug, id: term });
        return canonicalSlug;
      }
      // 2. If term is in slugToId (can be canonical slug, decoded slug, or human name alias)
      const id = taxonomyMaps.slugToId[taxName]?.[term];
      if (id && taxonomyMaps.idToSlug[taxName]?.[id]) {
        const canonicalSlug = taxonomyMaps.idToSlug[taxName][id];
        if (term !== canonicalSlug) {
          list.push({ input: term, resolved: canonicalSlug, id });
        }
        return canonicalSlug;
      }
      return term;
    });
    if (list.length > 0) {
      resolvedTaxonomies[taxName === 'category' ? 'categories' : 'tags'] = list;
    }
    return canonicalized;
  };

  // Canonicalize frontmatter taxonomy terms in-place before preflight and payload creation
  if (parsed.frontmatter.taxonomies) {
    if (parsed.frontmatter.taxonomies.categories) {
      parsed.frontmatter.taxonomies.categories = canonicalizeTerms(
        'category',
        parsed.frontmatter.taxonomies.categories,
      );
    }
    if (parsed.frontmatter.taxonomies.tags) {
      parsed.frontmatter.taxonomies.tags = canonicalizeTerms(
        'tag',
        parsed.frontmatter.taxonomies.tags,
      );
    }
  }

  // Pre-build taxonomy candidates with slugToName for frontmatter serialization with inline '# <Name>' comments
  const candidates: TaxonomyCandidates =
    options.candidates || loadLocalTaxonomyCandidates(options.workspaceRoot);

  // If knownTaxonomies is not explicitly passed, populate from local categories/ and tags/ (if present)
  let knownTaxonomies = options.knownTaxonomies;
  if (!knownTaxonomies) {
    const knownCats = Object.keys(taxonomyMaps.slugToId.category);
    const knownTags = Object.keys(taxonomyMaps.slugToId.tag);
    if (knownCats.length > 0 || knownTags.length > 0) {
      knownTaxonomies = {
        ...(knownCats.length > 0 ? { categories: knownCats } : {}),
        ...(knownTags.length > 0 ? { tags: knownTags } : {}),
      };
    }
  }

  // 1. Run Preflight Guards G2 - G11
  const preflight = runPreflightChecks(targetFilePath, parsed, {
    allowPublish: options.allowPublish,
    knownTaxonomies,
    baseMarkdown: baseSnapshot?.bodyMarkdown,
    previousStatus: (syncState?.status as 'draft' | 'published') || 'draft',
    workspaceRoot: options.workspaceRoot,
    cache: options.cache,
  });

  if (!preflight.valid) {
    throw new PushValidationError(
      `Push blocked by Preflight Guards (${preflight.errors.length} error(s)).`,
      preflight.errors,
    );
  }

  // Update parsed with cleaned body (e.g. trimmed duplicate heading)
  parsed.body = preflight.cleanedBody;

  const currentRev = syncState?.remoteRev || baseSnapshot?.rev || '';
  const warnings = [...preflight.warnings];

  // Load local bylines map for converting frontmatter byline slugs to ULIDs
  let bylineSlugToId = options.bylineSlugToId;
  if (!bylineSlugToId) {
    const cachedMaps = options.cache.getBylineMaps();
    if (Object.keys(cachedMaps.slugToId).length > 0) {
      bylineSlugToId = cachedMaps.slugToId;
    } else {
      const freshMaps = await syncRemoteBylines({
        origin: options.origin,
        token: options.token,
        refreshToken: options.refreshToken,
        cache: options.cache,
        fetchFn: options.fetchFn,
      }).catch(() => ({ slugToId: {}, idToSlug: {} }));
      bylineSlugToId = freshMaps.slugToId;
    }
  }

  const effectiveOptions: PushOptions = {
    ...options,
    bylineSlugToId,
  };

  // 2. Determine whether this is a new article create (POST) or update (PUT)
  const isNewArticle = !syncState;

  // Helper to synchronize taxonomy assignments
  const syncArticleTaxonomies = async (articleId: string) => {
    if (!parsed.frontmatter.taxonomies) return;
    const taxMaps = taxonomyMaps;

    const updateTaxonomy = async (taxonomyName: 'category' | 'tag', termSlugsOrIds: string[]) => {
      const slugMap = taxMaps.slugToId[taxonomyName] || {};
      const idMap = taxMaps.idToSlug[taxonomyName] || {};
      const resolvedTermIds = Array.from(
        new Set(
          termSlugsOrIds
            .map((item) => {
              // 1. If item is already a known ULID, preserve it directly to avoid silent substitution
              if (idMap[item]) return item;
              // 2. If item was canonicalized from a specific ULID or alias, preserve the bound term ID
              const tracked =
                resolvedTaxonomies[taxonomyName === 'category' ? 'categories' : 'tags'];
              const match = tracked?.find((t) => t.resolved === item);
              if (match?.id) return match.id;
              // 3. Fallback to slugMap
              return slugMap[item] || item;
            })
            .filter((tid): tid is string => Boolean(tid)),
        ),
      );

      const termsUrl = new URL(
        `/_emdash/api/content/${collection}/${articleId}/terms/${taxonomyName}`,
        options.origin,
      ).toString();

      const termRes = await fetchFn(termsUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ termIds: resolvedTermIds }),
      });

      if (!termRes.ok) {
        const errBody = await termRes.text().catch(() => '');
        warnings.push(`Failed to update ${taxonomyName} terms: ${termRes.statusText} ${errBody}`);
      }
    };

    if (parsed.frontmatter.taxonomies.categories) {
      await updateTaxonomy('category', parsed.frontmatter.taxonomies.categories);
    }
    if (parsed.frontmatter.taxonomies.tags) {
      await updateTaxonomy('tag', parsed.frontmatter.taxonomies.tags);
    }
  };

  if (isNewArticle) {
    // [P2-P4] Upload/resolve standalone draft images and rewrite body
    const { body: rewrittenBody, uploadedByAbsPath } = await uploadAndRewriteDraftImages(
      parsed.body,
      preflight.draftImages,
      options,
      fetchFn,
    );
    parsed.body = rewrittenBody;

    let payload = localToApiPayload(parsed, '', effectiveOptions);
    warnings.push(
      ...preserveOrResolveFeaturedImage(
        payload,
        parsed.frontmatter.featuredImage,
        options.cache,
        id,
        options.workspaceRoot,
      ),
    );
    const postUrl = new URL(`/_emdash/api/content/${collection}`, options.origin).toString();

    const res = await fetchFn(postUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new ApiError({
        message: `Create push failed: ${res.statusText} - ${errBody}`,
        code: 'PUSH_CREATE_FAILED',
        status: res.status,
        endpoint: postUrl,
        suggestion:
          'Check if an article with this slug already exists or if token has create permissions.',
      });
    }

    const createdJson = await res.json();
    const createdItem = unwrapItem<Record<string, unknown>>(createdJson);
    const actualId = String(createdItem.id || id);
    const newRev = extractRev(createdJson, '1');

    // Update parsed frontmatter with the actual ID returned by EmDash
    parsed.frontmatter.id = actualId;

    // Sync taxonomies for newly created article
    await syncArticleTaxonomies(actualId);

    const currentPrefix = extractDatePrefixFromPath(fullPath);
    const dateInput =
      parsed.frontmatter.publishedAt || currentPrefix || (createdItem.createdAt as string) || null;

    const newRelPath = computeArticleRelativePath(
      parsed.frontmatter.collection,
      parsed.frontmatter.status,
      actualId,
      parsed.frontmatter.title || parsed.frontmatter.slug,
      dateInput,
    );
    const newFullPath = path.join(options.workspaceRoot, newRelPath);

    const serializedContent = serializeMarkdown(parsed.frontmatter, parsed.body, candidates);
    const newHash = calculateHash(serializedContent);

    // Transition status to published if requested and permitted
    let finalRev = newRev;
    if (parsed.frontmatter.status === 'published' && options.allowPublish) {
      finalRev = await transitionContentStatus(
        collection,
        actualId,
        'published',
        newRev,
        parsed.frontmatter.publishedAt,
        options,
        fetchFn,
      );
    }

    // Save newly serialized file (with actual server ID) and clean up provisional file
    fs.mkdirSync(path.dirname(newFullPath), { recursive: true });
    fs.writeFileSync(newFullPath, serializedContent, 'utf8');

    if (fullPath !== newFullPath && fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
      } catch (unlinkErr: unknown) {
        warnings.push(
          `Failed to remove provisional file at ${fullPath}: ${(unlinkErr as Error).message}.`,
        );
      }
    }

    // [P6] Promote uploaded draft images from media/drafts/ into media/ and commit media_state
    finalizePromotedDraftImages(preflight.draftImages, uploadedByAbsPath, options, warnings);

    // Update Base snapshot and Sync state
    options.cache.saveBaseSnapshot({
      id: actualId,
      rev: finalRev,
      bodyMarkdown: parsed.body,
      frontmatterYaml: JSON.stringify(parsed.frontmatter),
      hash: newHash,
      savedAt: Math.floor(Date.now() / 1000),
    });

    options.cache.saveSyncState({
      id: actualId,
      localFilePath: newRelPath,
      localHash: newHash,
      remoteRev: finalRev,
      status: parsed.frontmatter.status,
      slug: parsed.frontmatter.slug,
      lastSyncedAt: Math.floor(Date.now() / 1000),
    });

    return {
      success: true,
      id: actualId,
      rev: finalRev,
      filePath: newRelPath,
      ...(actualId !== id ? { previousId: id } : {}),
      ...(originalRelPath !== newRelPath ? { previousFilePath: originalRelPath } : {}),
      ...(Object.keys(resolvedTaxonomies).length > 0 ? { resolvedTaxonomies } : {}),
      conflict: false,
      warnings,
    };
  }

  // Existing article: execute within full 7-minute entry lock lease (B-3: acquire lock BEFORE uploading media)
  return await withEntryLock(collection, id, options, async () => {
    // [P2-P4] Upload/resolve standalone draft images and rewrite body after entry lock is acquired
    const { body: rewrittenBody, uploadedByAbsPath } = await uploadAndRewriteDraftImages(
      parsed.body,
      preflight.draftImages,
      options,
      fetchFn,
    );
    parsed.body = rewrittenBody;

    let payload = localToApiPayload(parsed, currentRev, effectiveOptions);
    warnings.push(
      ...preserveOrResolveFeaturedImage(
        payload,
        parsed.frontmatter.featuredImage,
        options.cache,
        id,
        options.workspaceRoot,
      ),
    );
    const putUrl = new URL(`/_emdash/api/content/${collection}/${id}`, options.origin).toString();

    let res = await fetchFn(putUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    // 3. Handle 409 Conflict
    if (res.status === 409) {
      const errJson = (await res.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string; holder?: unknown };
      };
      const errorCode = errJson.error?.code || 'CONFLICT';

      if (errorCode === 'ENTRY_LOCKED') {
        throw new ApiError({
          message: `Entry is currently locked by another user. (${errJson.error?.message || ''})`,
          code: 'ENTRY_LOCKED',
          status: 409,
          endpoint: putUrl,
          suggestion:
            'Wait for the other user to finish editing or release their lock before retrying.',
        });
      }

      // True revision mismatch conflict: fetch remote latest and run Hybrid 3-Way Merge
      const getUrl = new URL(`/_emdash/api/content/${collection}/${id}`, options.origin).toString();
      const getRes = await fetchFn(getUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: 'application/json',
        },
      });

      if (!getRes.ok) {
        throw new ApiError({
          message: `Failed to fetch latest remote version during conflict resolution: ${getRes.statusText}`,
          code: 'CONFLICT_REMOTE_FETCH_FAILED',
          status: getRes.status,
          endpoint: getUrl,
          suggestion: 'Check remote server availability to resolve conflict.',
        });
      }

      const remoteItem = (await getRes.json()) as Record<string, unknown>;
      const remoteParsed = apiResponseToLocal(remoteItem, options);

      // Perform Hybrid 3-Way Merge
      const baseInfo = baseSnapshot
        ? {
            frontmatter: JSON.parse(baseSnapshot.frontmatterYaml) as Frontmatter,
            body: baseSnapshot.bodyMarkdown,
          }
        : null;

      const mergeResult = hybrid3WayMerge(parsed, baseInfo, {
        frontmatter: remoteParsed.frontmatter,
        body: remoteParsed.body,
      });

      warnings.push(...mergeResult.warnings);

      if (mergeResult.hasConflict) {
        // Unresolvable conflict in body: write conflict markers to local file for AI/human resolution
        const conflictedMarkdown = serializeMarkdown(
          mergeResult.frontmatter,
          mergeResult.body,
          options.candidates,
        );
        fs.writeFileSync(fullPath, conflictedMarkdown, 'utf8');

        // Update sync state with latest remoteRev and update base snapshot to remote state
        // so that once conflict markers are resolved, the subsequent push sends the correct _rev
        options.cache.saveSyncState({
          id,
          localFilePath: targetFilePath,
          localHash: calculateHash(conflictedMarkdown),
          remoteRev: remoteParsed.rev,
          status: parsed.frontmatter.status,
          slug: parsed.frontmatter.slug,
          lastSyncedAt: Math.floor(Date.now() / 1000),
        });

        options.cache.saveBaseSnapshot({
          id,
          rev: remoteParsed.rev,
          bodyMarkdown: remoteParsed.body,
          frontmatterYaml: JSON.stringify(remoteParsed.frontmatter),
          hash: calculateHash(
            serializeMarkdown(remoteParsed.frontmatter, remoteParsed.body, candidates),
          ),
          savedAt: Math.floor(Date.now() / 1000),
        });

        return {
          success: false,
          id,
          rev: remoteParsed.rev,
          filePath: targetFilePath,
          conflict: true,
          warnings,
        };
      }

      // Auto-merged cleanly: retry PUT with remote's _rev
      parsed.frontmatter = mergeResult.frontmatter;
      parsed.body = mergeResult.body;
      payload = localToApiPayload(parsed, remoteParsed.rev, effectiveOptions);
      warnings.push(
        ...preserveOrResolveFeaturedImage(
          payload,
          parsed.frontmatter.featuredImage,
          options.cache,
          id,
          options.workspaceRoot,
        ),
      );

      res = await fetchFn(putUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new ApiError({
          message: `Retry push after auto-merge failed: ${res.statusText}${errText ? ` - ${errText}` : ''}`,
          code: 'PUSH_RETRY_FAILED',
          status: res.status,
          endpoint: putUrl,
          suggestion:
            'Another change might have been committed in the meantime. Try pulling again.',
        });
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new ApiError({
        message: `Push failed: ${res.statusText}${errText ? ` - ${errText}` : ''}`,
        code: 'PUSH_FAILED',
        status: res.status,
        endpoint: putUrl,
        suggestion: 'Verify network connectivity, token permissions, and article status.',
      });
    }

    const updatedJson = await res.json().catch(() => ({}));
    const newRev = extractRev(updatedJson, currentRev);

    // 4. Post-push updates & Path tracking
    // Sync taxonomies on updated article
    await syncArticleTaxonomies(id);

    const currentPrefix = extractDatePrefixFromPath(fullPath);
    const existingSync = options.cache.getSyncState(parsed.frontmatter.id);
    const dateInput =
      parsed.frontmatter.publishedAt ||
      currentPrefix ||
      (existingSync?.lastSyncedAt ? new Date(existingSync.lastSyncedAt * 1000) : null);

    const newRelPath = computeArticleRelativePath(
      parsed.frontmatter.collection,
      parsed.frontmatter.status,
      parsed.frontmatter.id,
      parsed.frontmatter.title || parsed.frontmatter.slug,
      dateInput,
    );
    const newFullPath = path.join(options.workspaceRoot, newRelPath);

    const serializedContent = serializeMarkdown(parsed.frontmatter, parsed.body, candidates);
    const newHash = calculateHash(serializedContent);

    // Transition status (publish or unpublish) via dedicated endpoints if needed
    let finalRev = newRev;
    const previousStatus = syncState?.status || 'draft';
    if (parsed.frontmatter.status === 'published' && options.allowPublish) {
      finalRev = await transitionContentStatus(
        collection,
        id,
        'published',
        newRev,
        parsed.frontmatter.publishedAt,
        options,
        fetchFn,
      );
    } else if (parsed.frontmatter.status === 'draft' && previousStatus === 'published') {
      finalRev = await transitionContentStatus(
        collection,
        id,
        'draft',
        newRev,
        null,
        options,
        fetchFn,
      );
    }

    // Only move/rename file on disk AFTER remote update & status transition have succeeded!
    if (fullPath !== newFullPath) {
      fs.mkdirSync(path.dirname(newFullPath), { recursive: true });
      fs.writeFileSync(newFullPath, serializedContent, 'utf8');
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
        } catch (unlinkErr: unknown) {
          warnings.push(
            `Failed to remove old file at ${fullPath} after path transition: ${(unlinkErr as Error).message}. Please remove it manually to prevent duplicates.`,
          );
        }
      }
    } else {
      fs.writeFileSync(fullPath, serializedContent, 'utf8');
    }

    // [P6] Promote uploaded draft images from media/drafts/ into media/ and commit media_state
    finalizePromotedDraftImages(preflight.draftImages, uploadedByAbsPath, options, warnings);

    // Update Base snapshot
    options.cache.saveBaseSnapshot({
      id,
      rev: finalRev,
      bodyMarkdown: parsed.body,
      frontmatterYaml: JSON.stringify(parsed.frontmatter),
      hash: newHash,
      savedAt: Math.floor(Date.now() / 1000),
    });

    // Update sync state
    options.cache.saveSyncState({
      id,
      localFilePath: newRelPath,
      localHash: newHash,
      remoteRev: finalRev,
      status: parsed.frontmatter.status,
      slug: parsed.frontmatter.slug,
      lastSyncedAt: Math.floor(Date.now() / 1000),
    });

    return {
      success: true,
      id,
      rev: finalRev,
      filePath: newRelPath,
      ...(originalRelPath !== newRelPath ? { previousFilePath: originalRelPath } : {}),
      ...(Object.keys(resolvedTaxonomies).length > 0 ? { resolvedTaxonomies } : {}),
      conflict: false,
      warnings,
    };
  });
}
