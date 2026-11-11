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
import { extractUlidFromFilename, storageKeyToMarkdownRef } from '../utils/naming.js';
import { extractMediaUlid } from '../client/mapper.js';
import {
  MAX_MEDIA_UPLOAD_BYTES,
  resolveImageMimeType,
  toRootRelativeMediaUrl,
} from '../client/media.js';
import {
  stripCodeBlocks,
  verifyOpaqueBlocksUntampered,
  detectUnsupportedMarkdownSyntax,
} from '../client/portable-text.js';
import {
  sanitizeTitleForFilename,
  type Frontmatter,
  type ParsedMarkdown,
} from '../utils/frontmatter.js';
import { MEDIA_FILE_ROUTE_PREFIX, storageKeyFromMirrorRef } from '../utils/media-body-refs.js';
import { storageKeyFromMediaMeta } from './media.js';
import {
  findClosestTaxonomySuggestions,
  getLocalTaxonomiesSummary,
  type LocalTaxonomiesSummary,
} from './taxonomies.js';
import type { CacheDatabase } from '../db/cache.js';

export interface PreflightOptions {
  allowPublish?: boolean;
  knownTaxonomies?: Record<string, string[]>;
  baseMarkdown?: string;
  previousStatus?: 'draft' | 'published';
  workspaceRoot?: string;
  cache?: CacheDatabase;
}

export interface PromotedMediaMatch {
  mediaId: string;
  storageKey: string;
  url: string;
  promotedRelPath: string;
}

export interface DraftImageReference {
  /** Exact standalone Markdown line matched in body */
  line: string;
  /** Alt text inside `![alt](...)` */
  alt: string;
  /** Raw path string written in Markdown `![alt](rawPath)` */
  rawPath: string;
  /** Basename of the draft image file under `media/drafts/` */
  filename: string;
  /** Resolved absolute path on disk (when `workspaceRoot` is known) */
  resolvedAbsPath: string;
  /**
   * Present when `media/drafts/<filename>` was already promoted to `media/<markdownRef>`
   * by an earlier article push (P1 shared draft image reuse across articles).
   */
  alreadyPromoted?: PromotedMediaMatch;
}

export interface PreflightResult {
  valid: boolean;
  cleanedBody: string;
  frontmatter: Frontmatter;
  errors: PreflightError[];
  warnings: string[];
  /** G11: Validated standalone local draft images queued for automatic upload on push */
  draftImages: DraftImageReference[];
}

export interface PreflightError {
  code: string;
  message: string;
  suggestion?: string;
}

const CONFLICT_MARKER_REGEX = /^<{7}\s|^={7}$|^>{7}\s/m;
const OPAQUE_FENCE_LINE_REGEX = /^<!--ec:block .+ -->$/;
const STANDALONE_IMAGE_LINE_REGEX = /^!\[([^\]]*)\]\(([^)]+)\)$/;
const REMOTE_OR_DATA_URL_REGEX = /^(?:https?:\/\/|data:|\/_emdash\/api\/media\/file\/)/i;
const ANY_LOCAL_IMAGE_REGEX =
  /!\[([^\]]*)\]\((?!https?:\/\/|data:|\/_emdash\/api\/media\/file\/)([^)]+)\)/g;
// Canonical ULID shape (Crockford base32: 26 chars, excludes I and O). Casing is
// case-insensitive here because parseMarkdown() normalizes local frontmatter to uppercase.
const CANONICAL_ULID_REGEX = /^[0-9A-HJ-NP-Z]{26}$/i;

interface ResolvedDraftPathInfo {
  isInsideDraftsDir: boolean;
  isInsideMediaDir: boolean;
  candidateAbs: string;
  filename: string;
}

function resolveDraftImagePath(
  articleFilePath: string,
  rawImagePath: string,
  workspaceRoot?: string,
): ResolvedDraftPathInfo {
  const root = workspaceRoot ? path.resolve(workspaceRoot) : '/__emit_virtual_workspace__';
  const articleAbs = path.isAbsolute(articleFilePath)
    ? articleFilePath
    : path.resolve(root, articleFilePath);
  const articleDir = path.dirname(articleAbs);
  const trimmed = rawImagePath.trim();

  if (path.isAbsolute(trimmed)) {
    return {
      isInsideDraftsDir: false,
      isInsideMediaDir: false,
      candidateAbs: trimmed,
      filename: path.basename(trimmed),
    };
  }

  const normalized = trimmed.replace(/\\/g, '/');
  // A depth-free `media/...` reference is workspace-relative by contract. Anything carrying leading `../` /
  // `./` is spelled from the article's own directory — which is how an article references its own mirror so a
  // preview resolves it — and resolves against that article's directory instead.
  const isWorkspaceRelative = !/^(?:\.\.\/|\.\.\\|\.\/|\.\\)/.test(normalized);
  const candidateAbs = isWorkspaceRelative
    ? path.resolve(root, normalized)
    : path.resolve(articleDir, normalized);

  const draftsDirAbs = path.resolve(root, 'media', 'drafts');
  const mediaDirAbs = path.resolve(root, 'media');
  const isInsideDraftsDir =
    path.dirname(candidateAbs) === draftsDirAbs && path.basename(candidateAbs).length > 0;
  const isInsideMediaDir =
    candidateAbs.startsWith(mediaDirAbs + path.sep) && path.basename(candidateAbs).length > 0;

  return {
    isInsideDraftsDir,
    isInsideMediaDir,
    candidateAbs,
    filename: path.basename(candidateAbs),
  };
}

/**
 * Searches `media_state` and `media/*.yaml` to see whether a draft image filename — or a direct reference to
 * an already-promoted mirror under `media/` — has been promoted by a previous push (P1 shared draft image
 * reuse across multiple articles).
 *
 * Mirrors are named after the storageKey, so a name can no longer be derived from the referenced filename:
 * the match is made against what Emit has actually recorded. A reference may therefore hit a mirror by its
 * exact on-disk basename (`media/<markdownRef>.<ext>`), by the original upload filename stored in the
 * companion's `filename:` field, or, for a workspace still holding legacy `<yyyyMMdd>_<id>-<name>` names, by
 * the sanitized name suffix or the media record id embedded in that stem.
 */
function findAlreadyPromotedMedia(
  filename: string,
  workspaceRoot: string,
  cache?: CacheDatabase,
): PromotedMediaMatch | null {
  const ext = path.extname(filename);
  const baseWithoutExt = path.basename(filename, ext);
  const sanitizedTarget = `${sanitizeTitleForFilename(baseWithoutExt)}${ext}`.toLowerCase();
  const lowerFilename = filename.toLowerCase();
  const directUlidMatch = filename.replace(/^\d{8}_/, '').match(/^([0-9A-HJ-NP-Z]{26})-/i);
  const directUlid = directUlidMatch ? directUlidMatch[1].toUpperCase() : null;

  /** Strips the legacy `<yyyyMMdd>_<ulid>-` prefix; a storageKey-named stem is returned untouched. */
  const nameSuffixOf = (name: string): string =>
    name.replace(/^(?:\d{8}_)?[0-9A-HJ-NP-Z]{26}-/i, '').toLowerCase();

  // 1. Check media_state records first
  if (cache) {
    const states = cache.listMediaStates();
    for (const st of states) {
      if (st.status !== 'ready' && st.status !== 'uploaded') continue;
      if (!st.mediaId || !st.storageKey || !st.url) continue;

      if (directUlid && st.mediaId.toUpperCase() === directUlid) {
        return {
          mediaId: st.mediaId,
          storageKey: st.storageKey,
          url: st.url,
          promotedRelPath: st.workspacePath || `media/${filename}`,
        };
      }

      if (st.workspacePath) {
        const promotedBase = path.basename(st.workspacePath);
        const suffix = nameSuffixOf(promotedBase);
        if (
          promotedBase.toLowerCase() === lowerFilename ||
          suffix === sanitizedTarget ||
          suffix === lowerFilename
        ) {
          return {
            mediaId: st.mediaId,
            storageKey: st.storageKey,
            url: st.url,
            promotedRelPath: st.workspacePath,
          };
        }
      }
    }
  }

  // 2. Scan companion YAML files in media/
  const mediaDir = path.join(workspaceRoot, 'media');
  if (!fs.existsSync(mediaDir)) return null;

  const files = fs.readdirSync(mediaDir);
  for (const file of files) {
    if (!file.endsWith('.yaml')) continue;
    if (file.startsWith('legacy_')) continue;
    if (directUlid && !file.toUpperCase().includes(directUlid)) continue;

    try {
      const meta = yaml.load(fs.readFileSync(path.join(mediaDir, file), 'utf8')) as Record<
        string,
        unknown
      > | null;
      if (!meta || typeof meta.id !== 'string') continue;
      const metaFilename = typeof meta.filename === 'string' ? meta.filename : '';
      const stem = file.replace(/\.yaml$/, '');
      const fileSuffix = nameSuffixOf(stem);
      const matchesFilename =
        (directUlid !== null && meta.id.toUpperCase() === directUlid) ||
        stem.toLowerCase() === lowerFilename ||
        metaFilename === filename ||
        metaFilename.toLowerCase() === lowerFilename ||
        `${fileSuffix}${ext.toLowerCase()}` === sanitizedTarget;

      if (!matchesFilename) continue;

      const storageKey = typeof meta.storageKey === 'string' ? meta.storageKey : '';
      const rawUrl = typeof meta.url === 'string' ? meta.url : '';
      const canonicalUrl = rawUrl
        ? toRootRelativeMediaUrl(rawUrl, storageKey, 'https://example.com')
        : storageKey
          ? `/_emdash/api/media/file/${storageKey}`
          : '';
      if (!canonicalUrl) continue;

      const binaryName = `${file.replace(/\.yaml$/, '')}${ext || path.extname(metaFilename) || '.jpg'}`;
      return {
        mediaId: meta.id,
        storageKey: storageKey || path.basename(canonicalUrl),
        url: canonicalUrl,
        promotedRelPath: path.posix.join('media', binaryName),
      };
    } catch {
      // Ignore unreadable YAML
    }
  }

  return null;
}

/**
 * Collects every storageKey Emit has confirmed for this workspace — the `media_state` index plus each
 * `media/*.yaml` companion — so a body reference can be resolved against recorded metadata instead of by
 * guessing a filename. `legacy_*` residue is skipped because it backs no real record.
 */
function confirmedStorageKeys(options?: PreflightOptions): Set<string> {
  const keys = new Set<string>();
  if (options?.cache) {
    for (const state of options.cache.listMediaStates()) {
      if (state.storageKey) keys.add(state.storageKey);
    }
  }
  if (!options?.workspaceRoot) return keys;

  const mediaDir = path.join(options.workspaceRoot, 'media');
  if (!fs.existsSync(mediaDir)) return keys;
  for (const file of fs.readdirSync(mediaDir)) {
    if (!file.endsWith('.yaml') || file.startsWith('legacy_')) continue;
    try {
      const meta = yaml.load(fs.readFileSync(path.join(mediaDir, file), 'utf8')) as Record<
        string,
        unknown
      > | null;
      if (!meta) continue;
      const key = storageKeyFromMediaMeta(meta);
      if (key) keys.add(key);
    } catch {
      // Ignore unreadable YAML
    }
  }
  return keys;
}

/**
 * Resolves a body reference that names a storageKey outright (`media/<storageKey>`) to the promoted asset
 * Emit already mirrors. The key is confirmed against recorded metadata — `media_state` or a companion YAML —
 * so an unmirrored key stays unresolved and still reaches the push guards. A media record id is attached when
 * a source records one, which lets push verify the remote record before baking the URL into the body.
 */
function findPromotedMediaByStorageKey(
  storageKey: string,
  options?: PreflightOptions,
): PromotedMediaMatch | null {
  if (!options?.workspaceRoot) return null;

  const state = options.cache?.getMediaStateByStorageKey(storageKey);
  if (state && state.mediaId && state.url) {
    return {
      mediaId: state.mediaId,
      storageKey: state.storageKey || storageKey,
      url: state.url,
      promotedRelPath: state.markdownRef || state.workspacePath || `media/${storageKey}`,
    };
  }

  const stem = storageKeyToMarkdownRef(storageKey);
  if (!stem) return null;
  const companionPath = path.join(options.workspaceRoot, 'media', `${stem}.yaml`);
  if (!fs.existsSync(companionPath)) return null;

  try {
    const meta = yaml.load(fs.readFileSync(companionPath, 'utf8')) as Record<
      string,
      unknown
    > | null;
    if (!meta || typeof meta.id !== 'string') return null;
    const companionKey = storageKeyFromMediaMeta(meta) || storageKey;
    return {
      mediaId: meta.id.toUpperCase(),
      storageKey: companionKey,
      url: `${MEDIA_FILE_ROUTE_PREFIX}${companionKey}`,
      promotedRelPath: `media/${stem}`,
    };
  } catch {
    return null;
  }
}

/**
 * Runs Preflight Guards G2 through G11 against the article to prevent AI misbehavior.
 * (G1 is enforced at the MCP / CLI invocation layer).
 */
export function runPreflightChecks(
  filePath: string,
  parsed: ParsedMarkdown,
  options?: PreflightOptions,
): PreflightResult {
  const errors: PreflightError[] = [];
  const warnings: string[] = [];
  const draftImages: DraftImageReference[] = [];
  let cleanedBody = parsed.body;
  const { frontmatter } = parsed;

  // G2: ID (ULID) immutability check
  const filename = path.basename(filePath);
  const filenameId = extractUlidFromFilename(filename);
  if (filenameId) {
    if (filenameId !== frontmatter.id) {
      errors.push({
        code: 'ID_MISMATCH_ERROR',
        message: `ID in frontmatter ('${frontmatter.id}') does not match ULID in filename ('${filenameId}').`,
        suggestion:
          'Do not rename files manually with "mv". Update the slug or title in frontmatter, and Emit will rename the file automatically on push.',
      });
    }
  }

  // G3: Unintended publish check
  const prevStatus = options?.previousStatus ?? 'draft';
  if (prevStatus === 'draft' && frontmatter.status === 'published' && !options?.allowPublish) {
    errors.push({
      code: 'UNINTENDED_PUBLISH_GUARD',
      message:
        'Article status was changed from draft to published, but allowPublish: true was not provided.',
      suggestion:
        'To publish the article live, re-run with allowPublish: true. Otherwise, keep status as draft.',
    });
  }

  // G4: Taxonomy hallucination check
  if (options?.knownTaxonomies && frontmatter.taxonomies) {
    let summary: LocalTaxonomiesSummary | null = null;
    if (options.workspaceRoot) {
      try {
        summary = getLocalTaxonomiesSummary(options.workspaceRoot);
      } catch {
        summary = null;
      }
    }

    for (const [taxName, terms] of Object.entries(frontmatter.taxonomies)) {
      const allowed = options.knownTaxonomies[taxName];
      if (allowed && Array.isArray(terms)) {
        for (const term of terms) {
          if (!allowed.includes(term)) {
            // Term IDs are canonical 26-char ULIDs: uppercase Crockford base32 (excludes I, L, O, U).
            // Restricting to that alphabet prevents 26-character slugs from being mislabeled as IDs.
            const isTermId = /^[0-9A-HJ-NP-Z]{26}$/.test(term);
            const staleNote = isTermId
              ? ' (term ID was not found in local definitions and may be stale or deleted)'
              : '';

            const taxItems = summary
              ? taxName === 'categories'
                ? summary.categories
                : taxName === 'tags'
                  ? summary.tags
                  : []
              : [];

            let suggestion: string;
            if (taxItems.length > 0) {
              const suggestions = findClosestTaxonomySuggestions(term, taxItems, 3);
              const formattedList = suggestions.map((s) => `  - ${s}`).join('\n');
              suggestion = `Did you mean:\n${formattedList}\n\nRun sync_pull_taxonomies to refresh, or create it via official MCP first.`;
            } else {
              const allowedPreview = allowed.slice(0, 20).join(', ');
              const moreSuffix = allowed.length > 20 ? ' ...' : '';
              suggestion = `Use one of the allowed ${taxName}: [${allowedPreview}${moreSuffix}], run sync_pull_taxonomies to refresh, or create it via official MCP first.`;
            }

            errors.push({
              code: 'INVALID_TAXONOMY_ERROR',
              message: `Unknown ${taxName} term: '${term}'${staleNote}.`,
              suggestion,
            });
          }
        }
      }
    }
  }

  // G5 & G11: Local image path inspection & offline draft media auto-upload resolution
  // Code blocks and opaque fences (<!--ec:block ... -->) are excluded from scanning.
  const bodyWithoutCode = stripCodeBlocks(cleanedBody);
  const bodyLines = bodyWithoutCode.split('\n');
  for (const rawLine of bodyLines) {
    const trimmedLine = rawLine.replace(/\r$/, '').trim();
    if (!trimmedLine) continue;

    // Opaque fences are managed by G9 and must never be touched by image replacement
    if (OPAQUE_FENCE_LINE_REGEX.test(trimmedLine)) {
      continue;
    }

    const standaloneMatch = trimmedLine.match(STANDALONE_IMAGE_LINE_REGEX);
    if (standaloneMatch) {
      const alt = standaloneMatch[1];
      const rawPath = standaloneMatch[2].trim();

      if (REMOTE_OR_DATA_URL_REGEX.test(rawPath)) {
        continue;
      }

      const resolved = resolveDraftImagePath(filePath, rawPath, options?.workspaceRoot);
      if (!resolved.isInsideDraftsDir) {
        // Also allow reusing an already-promoted file directly under media/<markdownRef>
        if (resolved.isInsideMediaDir && options?.workspaceRoot) {
          const promotedMatch = findAlreadyPromotedMedia(
            resolved.filename,
            options.workspaceRoot,
            options.cache,
          );
          if (promotedMatch) {
            draftImages.push({
              line: trimmedLine,
              alt,
              rawPath: standaloneMatch[2],
              filename: resolved.filename,
              resolvedAbsPath: resolved.candidateAbs,
              alreadyPromoted: promotedMatch,
            });
            continue;
          }

          // A workspace that spells a mirrored image as `../../media/<storageKey>` references the storageKey
          // outright rather than a companion stem, so name matching above cannot resolve it. Recover the key
          // from recorded metadata and queue it as a reuse: push rewrites the line to the canonical route
          // without ever re-uploading, and an unmirrored key still falls through to LOCAL_IMAGE_DETECTED.
          const directKey = storageKeyFromMirrorRef(rawPath, confirmedStorageKeys(options));
          if (directKey) {
            const promotedByStorageKey = findPromotedMediaByStorageKey(directKey, options);
            if (promotedByStorageKey) {
              draftImages.push({
                line: trimmedLine,
                alt,
                rawPath: standaloneMatch[2],
                filename: resolved.filename,
                resolvedAbsPath: resolved.candidateAbs,
                alreadyPromoted: promotedByStorageKey,
              });
              continue;
            }
          }
        }

        errors.push({
          code: 'LOCAL_IMAGE_DETECTED',
          message: `Local image path detected in markdown body: '${trimmedLine}'. Only images placed directly under "media/drafts/" can be automatically uploaded.`,
          suggestion:
            'Place the image in "media/drafts/<filename>" and reference it on a standalone line (e.g. ![alt](../../media/drafts/<filename>)), or upload first using EmDash MCP "media_upload" and replace with /_emdash/api/media/file/<storageKey>.',
        });
        continue;
      }

      // G11: Standalone image referencing media/drafts/<filename>
      if (options?.workspaceRoot) {
        if (!fs.existsSync(resolved.candidateAbs)) {
          // P1: Check whether an earlier article push already promoted this draft image into media/
          const promotedMatch = findAlreadyPromotedMedia(
            resolved.filename,
            options.workspaceRoot,
            options.cache,
          );
          if (promotedMatch) {
            draftImages.push({
              line: trimmedLine,
              alt,
              rawPath: standaloneMatch[2],
              filename: resolved.filename,
              resolvedAbsPath: resolved.candidateAbs,
              alreadyPromoted: promotedMatch,
            });
            continue;
          }

          errors.push({
            code: 'MISSING_LOCAL_IMAGE_FILE',
            message: `Draft image file not found on disk: '${rawPath}' (resolved to '${resolved.candidateAbs}', and no promoted asset matching '${resolved.filename}' was found in media/).`,
            suggestion: `Place "${resolved.filename}" inside "media/drafts/", or if it was already promoted, look for a "media/<storageKey-derived-name>-${resolved.filename}" mirror in "media/".`,
          });
          continue;
        }

        const stat = fs.statSync(resolved.candidateAbs);
        if (!stat.isFile()) {
          errors.push({
            code: 'MISSING_LOCAL_IMAGE_FILE',
            message: `Draft image path is not a regular file: '${rawPath}'.`,
            suggestion: `Ensure "${resolved.filename}" is a valid image file inside "media/drafts/".`,
          });
          continue;
        }

        if (!resolveImageMimeType(resolved.filename)) {
          errors.push({
            code: 'INVALID_LOCAL_IMAGE_TYPE',
            message: `Unsupported image file extension for draft image: '${resolved.filename}'.`,
            suggestion:
              'Use a supported image format (.jpg, .jpeg, .png, .webp, .gif, .avif, .svg).',
          });
          continue;
        }

        if (stat.size > MAX_MEDIA_UPLOAD_BYTES) {
          errors.push({
            code: 'LOCAL_IMAGE_SIZE_EXCEEDED',
            message: `Draft image '${resolved.filename}' (${stat.size} bytes) exceeds the maximum allowed upload size of ${MAX_MEDIA_UPLOAD_BYTES} bytes (50 MiB).`,
            suggestion: 'Compress or resize the image below 50 MiB before pushing.',
          });
          continue;
        }
      }

      draftImages.push({
        line: trimmedLine,
        alt,
        rawPath: standaloneMatch[2],
        filename: resolved.filename,
        resolvedAbsPath: resolved.candidateAbs,
      });
      continue;
    }

    // Non-standalone line: check if any inline local image is embedded within paragraph text
    const inlineMatches = [...rawLine.matchAll(ANY_LOCAL_IMAGE_REGEX)];
    for (const match of inlineMatches) {
      const fullImgSyntax = match[0];
      const rawPath = match[2].trim();
      const resolved = resolveDraftImagePath(filePath, rawPath, options?.workspaceRoot);

      if (resolved.isInsideDraftsDir || resolved.isInsideMediaDir) {
        errors.push({
          code: 'INLINE_LOCAL_IMAGE_NOT_SUPPORTED',
          message: `Inline local image detected inside paragraph: '${fullImgSyntax}'. EmDash Portable Text only supports block-level standalone images for automatic sync.`,
          suggestion:
            'Move the image onto its own standalone line at the beginning of the line (e.g. ![alt](../../media/drafts/<filename>)).',
        });
      } else {
        errors.push({
          code: 'LOCAL_IMAGE_DETECTED',
          message: `Local image path detected in markdown body: '${fullImgSyntax}'.`,
          suggestion:
            'Upload the image first using emdash official MCP "media_upload", and replace the local path with the returned remote URL (e.g. /_emdash/api/media/file/<id>.<ext>), or place it in "media/drafts/" on a standalone line.',
        });
      }
    }
  }

  // G10: featuredImage must reference a canonical 26-character media ULID (or null).
  // A root-relative or absolute media URL that unambiguously contains a media ULID is
  // accepted with a warning, because Emit resolves it to the canonical ULID on push.
  if (frontmatter.featuredImage !== undefined && frontmatter.featuredImage !== null) {
    const rawFeaturedImage = frontmatter.featuredImage.trim();
    if (!CANONICAL_ULID_REGEX.test(rawFeaturedImage)) {
      const resolved = extractMediaUlid(rawFeaturedImage);
      if (resolved) {
        warnings.push(
          `featuredImage '${rawFeaturedImage}' was resolved to the canonical media ULID '${resolved}'. Prefer writing the bare 26-character ULID in frontmatter.`,
        );
      } else {
        errors.push({
          code: 'INVALID_FEATURED_IMAGE',
          message: `Invalid featuredImage in frontmatter: '${frontmatter.featuredImage}'. It must be a valid 26-character Crockford media ULID or null.`,
          suggestion:
            'Upload the image first using EmDash Admin or MCP "media_upload", then specify the returned 26-character ULID (e.g. 01M67P0MBMJQQXH2K95HHCYRYB). To remove the featured image, set featuredImage: null. Local file paths are never allowed.',
        });
      }
    }
  }

  // G6: Unresolved conflict markers check
  if (CONFLICT_MARKER_REGEX.test(cleanedBody)) {
    errors.push({
      code: 'UNRESOLVED_CONFLICT_MARKERS',
      message:
        'Unresolved 3-Way Merge conflict markers (<<<<<<<, =======, >>>>>>>) found in markdown body.',
      suggestion:
        'Resolve all conflicting regions in the body and remove the conflict markers before pushing.',
    });
  }

  // G7: Title duplication check (auto-trim)
  // If the body starts with an H1/H2 that duplicates frontmatter.title, trim it safely.
  const trimmedBody = cleanedBody.trimStart();
  const titleHeadingRegex = /^(?:#|##)\s+(.+)$/m;
  const headingMatch = trimmedBody.match(titleHeadingRegex);
  if (headingMatch && trimmedBody.startsWith(headingMatch[0])) {
    const headingText = headingMatch[1].trim().toLowerCase();
    const titleText = frontmatter.title.trim().toLowerCase();
    if (headingText === titleText) {
      warnings.push(
        `Duplicate top-level heading matching title ('${headingMatch[0]}') was automatically trimmed from body.`,
      );
      // Remove the top heading line and following empty line
      cleanedBody = trimmedBody.slice(headingMatch[0].length).replace(/^\r?\n/, '');
    }
  }

  // G9: Opaque fence tampered check
  if (options?.baseMarkdown) {
    const isUntampered = verifyOpaqueBlocksUntampered(options.baseMarkdown, cleanedBody);
    if (!isUntampered) {
      errors.push({
        code: 'MODIFIED_OPAQUE_BLOCK',
        message:
          'One or more <!--ec:block ... --> opaque custom block fences were modified or deleted.',
        suggestion:
          'Restore the exact <!--ec:block ... --> comment fence from the base version. Custom blocks cannot be edited directly in Markdown.',
      });
    }
  }

  // Unsupported Markdown syntax warning (tables, raw block HTML tags)
  const syntaxWarnings = detectUnsupportedMarkdownSyntax(cleanedBody);
  warnings.push(...syntaxWarnings);

  return {
    valid: errors.length === 0,
    cleanedBody,
    frontmatter,
    errors,
    warnings,
    draftImages,
  };
}
