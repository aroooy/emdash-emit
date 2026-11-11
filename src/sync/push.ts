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
import { loadLocalTaxonomyMaps, loadLocalTaxonomyCandidates } from './taxonomies.js';
import { localizeArticleMediaRefs } from '../utils/media-body-refs.js';
import { runPreflightChecks, type DraftImageReference, type PreflightError } from './preflight.js';
import {
  calculateHash,
  carriesDepthFreeMediaRef,
  CONFLICTS_SUBDIR,
  isQuarantinedRelativePath,
  quarantineLocalCopy,
} from './pull.js';
import { hybrid3WayMerge } from './merge.js';
import { syncRemoteBylines } from './bylines.js';
import { updateConfigSyncedVersion } from '../utils/config.js';
import { fetchAssignedTaxonomies, computeTaxonomyHash } from './terms.js';
import {
  fetchRemoteMediaDetail,
  resolveImageMimeType,
  toRootRelativeMediaUrl,
  uploadMediaFile,
  type UploadMediaResult,
} from '../client/media.js';
import { promoteDraftMediaFile } from './media.js';

export type TaxonomyResolutionStrategy = 'union' | 'local' | 'remote';

export interface PushOptions extends MapperOptions {
  workspaceRoot: string;
  cache: CacheDatabase;
  origin: string;
  token: string;
  refreshToken?: string;
  fetchFn?: typeof fetch;
  candidates?: TaxonomyCandidates;
  knownTaxonomies?: Record<string, string[]>;
  resolveTaxonomy?: TaxonomyResolutionStrategy;
  allowWipeTaxonomies?: boolean;
  allowUnappliedTaxonomies?: boolean;
  revive?: boolean;
  force?: boolean;
  noTaxonomyAudit?: boolean;
  /**
   * Accept body images spelled as local mirror references — article-relative `../../media/<storageKey>` or the
   * older depth-free `media/<storageKey>` — and rewrite them to the canonical
   * `/_emdash/api/media/file/<storageKey>` URL before anything reaches EmDash. The cache baseline stores the
   * canonical form too, so a local-ref workspace never reports a phantom diff.
   */
  localMediaRefs?: boolean;
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
  taxonomyConflict?: boolean;
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
 * `media/<markdownRef>.<ext>` along with companion `.yaml` metadata, where markdownRef is derived from the
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

function throwRemoteArticleDeleted(
  collection: string,
  id: string,
  targetFilePath: string,
  endpoint: string,
): never {
  throw new ApiError({
    endpoint,
    code: 'REMOTE_ARTICLE_DELETED',
    status: 404,
    message: `Article ${id} (${targetFilePath}) was deleted on the remote server.`,
    suggestion: [
      '1. Keep your edits and re-create as a new article: remove the `id:` field from frontmatter, then "emit push <file>".',
      `2. Discard local edits and untrack: "emit pull ${id} --force"   (local copy is preserved under posts/conflicts/)`,
      `3. Delete with rescue backup: "emit delete ${targetFilePath} --discard-local-edits"`,
    ].join('\n  '),
  });
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

  // 1. Guard against blind re-push when article is marked delete_pending (G15)
  if (syncState?.deletePending === 1 && !options.revive && !options.force) {
    throw new ApiError({
      endpoint: `/_emdash/api/content/${collection}/${id}`,
      code: 'DELETE_PENDING_ARTICLE',
      status: 409,
      message: `Article ${id} (${targetFilePath}) is marked as delete-pending (previous remote deletion was unconfirmed).`,
      suggestion: `To intentionally revive and push this article to remote, pass --revive (or --force): "emit push ${targetFilePath} --revive"`,
    });
  }

  // 2. Preflight Guards (including G6: UNRESOLVED_CONFLICT_MARKERS)
  // Evaluated before taxonomy conflict pending so markers in markdown body are caught first
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

  // 3. Guard against blind re-push when taxonomy conflict is still pending (G16)
  const isTaxConflictPending =
    syncState?.taxonomyConflictPending !== undefined
      ? syncState.taxonomyConflictPending === 1
      : syncState?.conflictPending === 1 && (syncState?.bodyConflictPending ?? 0) === 0;

  if (isTaxConflictPending && !options.resolveTaxonomy && !options.force) {
    throw new ApiError({
      endpoint: `/_emdash/api/content/${collection}/${id}`,
      code: 'TAXONOMY_CONFLICT_PENDING',
      status: 409,
      message: `Article ${id} (${targetFilePath}) has an unresolved taxonomy conflict from a previous sync.`,
      suggestion: `Pass --resolve-taxonomy=union|local|remote (or --force) to explicitly resolve and confirm: "emit push ${targetFilePath} --resolve-taxonomy=union"`,
    });
  }

  // 4. Guard against blind re-push when previous taxonomy update failed (G17)
  if (
    syncState?.taxonomyApplyPending === 1 &&
    !options.allowUnappliedTaxonomies &&
    !options.force
  ) {
    throw new ApiError({
      endpoint: `/_emdash/api/content/${collection}/${id}`,
      code: 'TAXONOMY_APPLY_PENDING',
      status: 409,
      message: `Article ${id} (${targetFilePath}) has an unconfirmed taxonomy assignment from a previous failed update.`,
      suggestion: `Run "emit pull-taxonomies" to synchronize taxonomy definitions, then re-push (or pass --allow-unapplied-taxonomies / --force).`,
    });
  }

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
  const syncArticleTaxonomies = async (
    articleId: string,
  ): Promise<Array<{ taxonomy: string; status: number; error: string; endpoint: string }>> => {
    const failures: Array<{ taxonomy: string; status: number; error: string; endpoint: string }> =
      [];
    if (!parsed.frontmatter.taxonomies) return failures;
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

      if (resolvedTermIds.length === 0) {
        // Check if remote previously had assignments in baseline
        const baseFm = baseSnapshot?.frontmatterYaml
          ? (JSON.parse(baseSnapshot.frontmatterYaml) as Frontmatter)
          : null;
        const prevTerms =
          taxonomyName === 'category' ? baseFm?.taxonomies?.categories : baseFm?.taxonomies?.tags;
        if (prevTerms && prevTerms.length > 0) {
          if (!options.allowWipeTaxonomies && !options.force && !options.resolveTaxonomy) {
            throw new ApiError({
              endpoint: `/_emdash/api/content/${collection}/${articleId}/terms/${taxonomyName}`,
              code: 'DESTRUCTIVE_TAXONOMY_WIPE',
              status: 400,
              message: `Local article specified empty array for ${taxonomyName}, which would remove ${prevTerms.length} existing remote assignment(s).`,
              suggestion: `Pass --allow-wipe-taxonomies (or --force) to confirm wiping all ${taxonomyName} assignments.`,
            });
          }
          warnings.push(
            `🏷️ Cleared all ${prevTerms.length} ${taxonomyName} assignment(s) from remote (local specified empty array).`,
          );
        }
      }

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
        failures.push({
          taxonomy: taxonomyName,
          status: termRes.status,
          error: errBody || termRes.statusText,
          endpoint: termsUrl,
        });
        warnings.push(`Failed to update ${taxonomyName} terms: ${termRes.statusText} ${errBody}`);
      }
    };

    if (parsed.frontmatter.taxonomies.categories) {
      await updateTaxonomy('category', parsed.frontmatter.taxonomies.categories);
    }
    if (parsed.frontmatter.taxonomies.tags) {
      await updateTaxonomy('tag', parsed.frontmatter.taxonomies.tags);
    }
    return failures;
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
    const taxFailures = await syncArticleTaxonomies(actualId);
    const hasTaxFailures = taxFailures.length > 0;

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

    const serializedCanonical = serializeMarkdown(parsed.frontmatter, parsed.body, candidates);
    // `parsed.body` carries the canonical URL because preflight rewrote every local reference. The file that
    // lands on disk must carry the workspace's own spelling again, or a push would silently re-canonicalize
    // the article and the next status pass would report an edit nobody made. The baseline keeps the canonical
    // body untouched so `diff` and the 3-way merge stay byte-identical to what a remote pull would write.
    // An already-tracked file keeps the spelling its bytes already carry; only a fresh article (or one whose
    // path just changed, which changes the depth) is written in the article-relative form.
    const serializedContent = options.localMediaRefs
      ? localizeArticleMediaRefs(serializedCanonical, {
          workspaceRoot: options.workspaceRoot,
          articleRelPath: newRelPath,
          fs,
          preferLegacyRef: carriesDepthFreeMediaRef(rawContent),
        })
      : serializedCanonical;
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

    const finalTaxHash = hasTaxFailures
      ? null
      : computeTaxonomyHash(
          parsed.frontmatter.taxonomies?.categories,
          parsed.frontmatter.taxonomies?.tags,
        );

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
      conflictPending: 0,
      bodyConflictPending: 0,
      taxonomyConflictPending: 0,
      conflictCopyHash: null,
      conflictCopyPath: null,
      conflictAt: null,
      remoteTaxonomyHash: finalTaxHash,
      taxonomyApplyPending: hasTaxFailures ? 1 : 0,
    });

    if (hasTaxFailures) {
      throw new ApiError({
        endpoint: taxFailures[0].endpoint,
        code: 'TAXONOMY_UPDATE_FAILED',
        status: taxFailures[0].status || 400,
        message: `Failed to update ${taxFailures.map((f) => f.taxonomy).join(', ')} terms on remote: ${taxFailures.map((f) => f.error).join('; ')}`,
        suggestion:
          'Run "emit pull-taxonomies" to update local definitions, verify taxonomy permissions, and retry push.',
      });
    }

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

    // R1: Pre-PUT Taxonomy Audit to detect out-of-band remote taxonomy changes
    let remoteTaxAudit: { categories: string[] | null; tags: string[] | null } | null = null;
    let taxonomyDivergenceDetected = false;

    const baseFm = baseSnapshot?.frontmatterYaml
      ? (JSON.parse(baseSnapshot.frontmatterYaml) as Frontmatter)
      : null;
    const hasLocalTaxonomies = Boolean(
      parsed.frontmatter.taxonomies &&
      (parsed.frontmatter.taxonomies.categories !== undefined ||
        parsed.frontmatter.taxonomies.tags !== undefined),
    );
    const hasBaseTaxonomies = Boolean(
      baseFm?.taxonomies && (baseFm.taxonomies.categories || baseFm.taxonomies.tags),
    );

    if ((hasLocalTaxonomies || hasBaseTaxonomies) && !options.noTaxonomyAudit) {
      remoteTaxAudit = await fetchAssignedTaxonomies({
        origin: options.origin,
        token: options.token,
        collection,
        id,
        fetchFn,
      });

      if (remoteTaxAudit.categories === null && remoteTaxAudit.tags === null) {
        warnings.push('⚠️ Remote taxonomy state unknown (could not audit remote terms).');
      } else {
        if (remoteTaxAudit.categories === null) {
          warnings.push('⚠️ Remote category taxonomy state unknown (could not audit categories).');
        }
        if (remoteTaxAudit.tags === null) {
          warnings.push('⚠️ Remote tag taxonomy state unknown (could not audit tags).');
        }
        const baselineTaxHash =
          syncState?.remoteTaxonomyHash ||
          (baseFm?.taxonomies
            ? computeTaxonomyHash(baseFm.taxonomies.categories, baseFm.taxonomies.tags)
            : null);

        const currentRemoteCats =
          remoteTaxAudit.categories !== null
            ? remoteTaxAudit.categories
            : baseFm?.taxonomies?.categories || [];
        const currentRemoteTags =
          remoteTaxAudit.tags !== null ? remoteTaxAudit.tags : baseFm?.taxonomies?.tags || [];

        const currentRemoteTaxHash = computeTaxonomyHash(currentRemoteCats, currentRemoteTags);

        if (baselineTaxHash && currentRemoteTaxHash !== baselineTaxHash) {
          taxonomyDivergenceDetected = true;
        }
      }
    }

    let res = taxonomyDivergenceDetected
      ? ({
          status: 409,
          ok: false,
          json: async () => ({ error: { code: 'TAXONOMY_DIVERGENCE' } }),
          text: async () => '',
        } as unknown as Response)
      : await fetchFn(putUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${options.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

    if (!taxonomyDivergenceDetected && (res.status === 404 || res.status === 410)) {
      throwRemoteArticleDeleted(collection, id, targetFilePath, putUrl);
    }

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

      // True revision mismatch conflict or taxonomy divergence: fetch remote latest and run Hybrid 3-Way Merge
      const getUrl = new URL(`/_emdash/api/content/${collection}/${id}`, options.origin).toString();
      const getRes = await fetchFn(getUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: 'application/json',
        },
      });

      if (!getRes.ok) {
        if (getRes.status === 404 || getRes.status === 410) {
          throwRemoteArticleDeleted(collection, id, targetFilePath, getUrl);
        }
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

      // Fetch remote taxonomy assignments (reuse remoteTaxAudit if available)
      const remoteTax =
        remoteTaxAudit ||
        (await fetchAssignedTaxonomies({
          origin: options.origin,
          token: options.token,
          collection,
          id,
          fetchFn,
        }));

      if (!remoteParsed.frontmatter.taxonomies) {
        remoteParsed.frontmatter.taxonomies = {};
      }
      if (remoteTax.categories !== null) {
        remoteParsed.frontmatter.taxonomies.categories = remoteTax.categories;
      } else if (baseSnapshot) {
        const baseFm = JSON.parse(baseSnapshot.frontmatterYaml) as Frontmatter;
        if (baseFm.taxonomies?.categories) {
          remoteParsed.frontmatter.taxonomies.categories = baseFm.taxonomies.categories;
        }
      }
      if (remoteTax.tags !== null) {
        remoteParsed.frontmatter.taxonomies.tags = remoteTax.tags;
      } else if (baseSnapshot) {
        const baseFm = JSON.parse(baseSnapshot.frontmatterYaml) as Frontmatter;
        if (baseFm.taxonomies?.tags) {
          remoteParsed.frontmatter.taxonomies.tags = baseFm.taxonomies.tags;
        }
      }

      // Perform Hybrid 3-Way Merge
      const baseInfo = baseSnapshot
        ? {
            frontmatter: JSON.parse(baseSnapshot.frontmatterYaml) as Frontmatter,
            body: baseSnapshot.bodyMarkdown,
          }
        : null;

      const mergeResult = hybrid3WayMerge(
        parsed,
        baseInfo,
        {
          frontmatter: remoteParsed.frontmatter,
          body: remoteParsed.body,
        },
        {
          strategy: options.resolveTaxonomy,
        },
      );

      warnings.push(...mergeResult.warnings);

      // Check destructive taxonomy wipe guard during 3-way merge (exempt if strategy is explicitly specified)
      if (
        !options.resolveTaxonomy &&
        mergeResult.wipeWarnings &&
        mergeResult.wipeWarnings.length > 0
      ) {
        if (!options.allowWipeTaxonomies && !options.force) {
          const details = mergeResult.wipeWarnings
            .map((w) => `${w.name}: clearing ${w.remoteTerms.length} assignment(s)`)
            .join(', ');
          throw new ApiError({
            endpoint: `/_emdash/api/content/${collection}/${id}`,
            code: 'DESTRUCTIVE_TAXONOMY_WIPE',
            status: 400,
            message: `Local article specified empty array for taxonomies (${details}), which would wipe existing remote assignments.`,
            suggestion: `Pass --allow-wipe-taxonomies (or --force) to confirm clearing: "emit push ${targetFilePath} --allow-wipe-taxonomies"`,
          });
        }
      }

      // Log clean auto-merged taxonomy changes
      if (mergeResult.autoMergedTaxonomies && mergeResult.autoMergedTaxonomies.length > 0) {
        for (const item of mergeResult.autoMergedTaxonomies) {
          const parts: string[] = [];
          if (item.remoteAdded.length > 0) parts.push(`+${item.remoteAdded.join(', ')}`);
          if (item.remoteRemoved.length > 0) parts.push(`-${item.remoteRemoved.join(', ')}`);
          warnings.push(`🏷️ Merged remote taxonomy change(s) for ${item.name}: ${parts.join(' ')}`);
        }
      }

      // Log strategy adoptions
      if (mergeResult.strategyAdoptions && mergeResult.strategyAdoptions.length > 0) {
        for (const item of mergeResult.strategyAdoptions) {
          const parts: string[] = [];
          if (item.discardedAdded.length > 0) parts.push(`+${item.discardedAdded.join(', ')}`);
          if (item.discardedRemoved.length > 0) parts.push(`-${item.discardedRemoved.join(', ')}`);
          const discardedStr = parts.length > 0 ? `: discarded ${parts.join(' ')}` : '';
          warnings.push(`🏷️ Resolved '${item.name}' with strategy '${item.side}'${discardedStr}.`);
        }
      }

      // Fallback post-merge resolution only if strategy was NOT specified and taxonomy conflicts occurred
      if (
        !options.resolveTaxonomy &&
        mergeResult.taxonomyConflicts &&
        mergeResult.taxonomyConflicts.length > 0
      ) {
        if (options.force) {
          const strategy = 'union';
          const unionTaxonomies: Record<string, string[]> = {};
          const allTaxNames = new Set([
            ...Object.keys(parsed.frontmatter.taxonomies || {}),
            ...Object.keys(remoteParsed.frontmatter.taxonomies || {}),
          ]);
          for (const tName of allTaxNames) {
            const lTerms = parsed.frontmatter.taxonomies?.[tName] || [];
            const rTerms = remoteParsed.frontmatter.taxonomies?.[tName] || [];
            unionTaxonomies[tName] = Array.from(new Set([...lTerms, ...rTerms]));
          }
          mergeResult.frontmatter.taxonomies = unionTaxonomies;
          warnings.push(`Resolved taxonomy conflicts using strategy '${strategy}'.`);
        } else {
          mergeResult.hasConflict = true;
          warnings.push(
            `Conflict on taxonomies (${mergeResult.taxonomyConflicts.join(', ')}): local and remote changes could not be cleanly merged. Push aborted to prevent data loss.`,
          );
        }
      }

      if (mergeResult.hasConflict) {
        const isTaxonomyConflict = Boolean(
          mergeResult.taxonomyConflicts && mergeResult.taxonomyConflicts.length > 0,
        );
        const hasBodyConflict = Boolean(
          mergeResult.body.includes('<<<<<<< LOCAL') || mergeResult.body.includes('<<<<<<< local'),
        );
        const isTaxonomyOnlyConflict = isTaxonomyConflict && !hasBodyConflict;

        const conflictedMarkdown = serializeMarkdown(
          mergeResult.frontmatter,
          mergeResult.body,
          options.candidates,
        );
        let quarantineRel: string | null = null;
        // Only write conflict markers into the article body if body actually has conflicts
        if (!isTaxonomyOnlyConflict) {
          const currentDisk = fs.readFileSync(fullPath, 'utf8');
          quarantineRel = quarantineLocalCopy(
            options.workspaceRoot,
            collection,
            targetFilePath,
            currentDisk,
            { isForce: false },
          );
          fs.writeFileSync(fullPath, conflictedMarkdown, 'utf8');
        }

        const conflictedHash = calculateHash(conflictedMarkdown);

        // Update sync state:
        // Do NOT overwrite localHash with marker hash, so `status` remains clean when markers are cleaned up!
        options.cache.saveSyncState({
          id,
          localFilePath: targetFilePath,
          localHash: syncState?.localHash || '',
          remoteRev: remoteParsed.rev,
          status: parsed.frontmatter.status,
          slug: parsed.frontmatter.slug,
          lastSyncedAt: Math.floor(Date.now() / 1000),
          conflictPending: 1,
          bodyConflictPending: hasBodyConflict ? 1 : 0,
          taxonomyConflictPending: isTaxonomyConflict ? 1 : 0,
          conflictCopyHash: conflictedHash,
          conflictCopyPath: quarantineRel,
          conflictAt: Math.floor(Date.now() / 1000),
          remoteTaxonomyHash: computeTaxonomyHash(
            remoteParsed.frontmatter.taxonomies?.categories,
            remoteParsed.frontmatter.taxonomies?.tags,
          ),
          taxonomyApplyPending: 0,
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
          taxonomyConflict: isTaxonomyOnlyConflict,
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
        if (res.status === 404 || res.status === 410) {
          throwRemoteArticleDeleted(collection, id, targetFilePath, putUrl);
        }

        const errText = await res.text().catch(() => '');
        // Check if server rejected the merged taxonomy union or strategy (e.g. single category limit)
        if (
          (res.status === 400 || res.status === 422) &&
          ((mergeResult.autoMergedTaxonomies && mergeResult.autoMergedTaxonomies.length > 0) ||
            (mergeResult.strategyAdoptions && mergeResult.strategyAdoptions.length > 0))
        ) {
          const wasStrategy =
            mergeResult.strategyAdoptions && mergeResult.strategyAdoptions.length > 0;
          throw new ApiError({
            message: `Remote server rejected the merged taxonomy union (HTTP ${res.status}): ${errText || res.statusText}`,
            code: 'TAXONOMY_UNION_REJECTED',
            status: res.status,
            endpoint: putUrl,
            suggestion: wasStrategy
              ? 'The remote server rejected the taxonomy adopted by your strategy (e.g. single-category constraint). Switch strategy with "--resolve-taxonomy=remote" or edit the frontmatter manually before pushing.'
              : 'The remote server enforces constraints that reject combining local and remote taxonomy terms (e.g. single-category constraint). Resolve by explicitly choosing a side: "emit push <file> --resolve-taxonomy=local" (or remote), or edit the frontmatter manually.',
          });
        }

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
      if (res.status === 404 || res.status === 410) {
        throwRemoteArticleDeleted(collection, id, targetFilePath, putUrl);
      }
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
    const taxFailures = await syncArticleTaxonomies(id);
    const hasTaxFailures = taxFailures.length > 0;

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

    const serializedCanonical = serializeMarkdown(parsed.frontmatter, parsed.body, candidates);
    // Same disk spelling rule as the clean-push path: keep the workspace's own local references on disk while
    // the canonical form goes to remote and into the baseline. A file that already carries the depth-free form
    // keeps it; a path change (draft→published) re-spells at the new depth.
    const serializedContent = options.localMediaRefs
      ? localizeArticleMediaRefs(serializedCanonical, {
          workspaceRoot: options.workspaceRoot,
          articleRelPath: newRelPath,
          fs,
          preferLegacyRef: carriesDepthFreeMediaRef(rawContent),
        })
      : serializedCanonical;
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
    const savedFrontmatter: Frontmatter = { ...parsed.frontmatter };
    if (hasTaxFailures && baseFm?.taxonomies) {
      savedFrontmatter.taxonomies = { ...baseFm.taxonomies };
    }

    const finalTaxHash = hasTaxFailures
      ? syncState?.remoteTaxonomyHash ||
        (baseFm?.taxonomies
          ? computeTaxonomyHash(baseFm.taxonomies.categories, baseFm.taxonomies.tags)
          : null)
      : computeTaxonomyHash(
          parsed.frontmatter.taxonomies?.categories,
          parsed.frontmatter.taxonomies?.tags,
        );

    options.cache.saveBaseSnapshot({
      id,
      rev: finalRev,
      bodyMarkdown: parsed.body,
      frontmatterYaml: JSON.stringify(savedFrontmatter),
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
      conflictPending: hasTaxFailures ? (syncState?.conflictPending ?? 0) : 0,
      bodyConflictPending: hasTaxFailures ? (syncState?.bodyConflictPending ?? 0) : 0,
      taxonomyConflictPending: hasTaxFailures ? (syncState?.taxonomyConflictPending ?? 0) : 0,
      conflictCopyHash: hasTaxFailures ? syncState?.conflictCopyHash : null,
      conflictCopyPath: hasTaxFailures ? syncState?.conflictCopyPath : null,
      conflictAt: hasTaxFailures ? syncState?.conflictAt : null,
      remoteTaxonomyHash: finalTaxHash,
      taxonomyApplyPending: hasTaxFailures ? 1 : 0,
    });

    if (hasTaxFailures) {
      throw new ApiError({
        endpoint: taxFailures[0].endpoint,
        code: 'TAXONOMY_UPDATE_FAILED',
        status: taxFailures[0].status || 400,
        message: `Failed to update ${taxFailures.map((f) => f.taxonomy).join(', ')} terms on remote: ${taxFailures.map((f) => f.error).join('; ')}`,
        suggestion:
          'Run "emit pull-taxonomies" to update local definitions, verify taxonomy permissions, and retry push.',
      });
    }

    updateConfigSyncedVersion(options.workspaceRoot);

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
