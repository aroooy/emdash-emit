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

/**
 * Local Markdown body image references vs the canonical remote form.
 *
 * A body image has two spellings of the same asset:
 *
 *   canonical  `![alt](/_emdash/api/media/file/<storageKey>)`  — what EmDash stores in Portable Text and
 *                                                        what the live site serves
 *   local      `![alt](media/<storageKey>)`                    — a workspace-relative reference that
 *                                                        resolves to the mirrored file under `media/`
 *
 * The local spelling exists so an editor preview (VS Code, GitHub) renders the image from the mirror. It is
 * only ever a disk form: `base_snapshots.bodyMarkdown` and every payload sent to EmDash keep the canonical
 * URL, because the baseline must stay byte-identical to what a remote pull writes.
 *
 * The reference deliberately carries no `../../` prefix. An article lives at `<collection>/<status>/<file>.md`,
 * so its distance to `media/` is fixed by the workspace layout rather than by the article; baking depth into
 * the body would break on every draft→published move and would make the baseline reconstruction in `diff.ts`
 * impossible. Emit injects the depth at push time from the article's own path.
 */

import { storageKeyToMarkdownRef } from './naming.js';

/** Canonical root-relative media route prefix EmDash writes into Portable Text image blocks. */
export const MEDIA_FILE_ROUTE_PREFIX = '/_emdash/api/media/file/';

/** Workspace-relative directory a mirrored asset lives in. */
export const MEDIA_DIR_PREFIX = 'media/';

const CANONICAL_MEDIA_URL_REGEX = /(?:^|\/)media\/file\/([^?#\s)]+)/;

/** Image extensions a storageKey may carry, matching the mirror naming rule. */
const STORAGE_KEY_EXTENSION = /\.(jpg|jpeg|png|gif|webp|avif|svg)$/i;

/**
 * A storageKey names its mirror outright: one path segment that is itself an image file. A reference may also
 * carry the deterministic `<stem>--<mediaId>` collision suffix, which still names a real asset. Anything
 * deeper (`media/drafts/x.png`) or shapeless (`./hero.png`) is not a canonicalized local reference.
 */
const LOCAL_MEDIA_REF_REGEX = /^media\/([^/?#\s]+)$/;

/** Extracts the storageKey from a canonical `/_emdash/api/media/file/<storageKey>` URL. */
export function storageKeyFromCanonicalUrl(url: string): string | null {
  const match = url.match(CANONICAL_MEDIA_URL_REGEX);
  if (!match) return null;
  const key = match[1].trim();
  return key.length > 0 ? key : null;
}

/** Reports whether a Markdown image URL already carries the canonical EmDash media file route. */
export function isCanonicalMediaUrl(url: string): boolean {
  return storageKeyFromCanonicalUrl(url) !== null;
}

/** The final path segment of a reference, or null when it carries no usable name. */
function refBasename(url: string): string | null {
  const match = url.trim().match(LOCAL_MEDIA_REF_REGEX);
  if (!match) return null;
  return match[1];
}

/**
 * Reports whether a Markdown image URL is a workspace-relative reference into `media/`. Deliberately strict so
 * an arbitrary hand-written path (`./hero.png`, `../uploads/x.jpg`) or a staging draft (`media/drafts/x.png`)
 * is never mistaken for a canonicalized local reference.
 */
export function isLocalMediaRef(url: string): boolean {
  const name = refBasename(url);
  return name !== null && STORAGE_KEY_EXTENSION.test(name);
}

/**
 * Rewrites canonical body image URLs into workspace-relative mirror references.
 *
 * Only a standalone Markdown image line whose URL is the canonical media route AND whose storageKey names an
 * existing file under `media/` is rewritten. Anything else — an external `https://` src, a data URL, a
 * reference whose asset is not mirrored, an inline image inside a paragraph, an opaque EmDash block fence —
 * is left exactly as it arrived, so the transform never invents a broken local link and never rewrites a line
 * Emit's push guards would refuse to restore.
 */
export function canonicalToLocalMediaRefs(
  body: string,
  options: { mediaDir: string; fs: { existsSync(p: string): boolean } },
): string {
  const lines = body.split('\n');
  const standaloneRegex = /^(!\[([^\]]*)\]\()([^)]+)(\))$/;

  return lines
    .map((line) => {
      const hasCr = line.endsWith('\r');
      const trimmed = (hasCr ? line.slice(0, -1) : line).trim();
      if (!trimmed) return line;
      // Opaque EmDash block fences carry remote JSON inside and are managed by Guard G9.
      if (/^<!--ec:block\s/.test(trimmed)) return line;

      const match = trimmed.match(standaloneRegex);
      if (!match) return line;

      const storageKey = storageKeyFromCanonicalUrl(match[3]);
      if (!storageKey) return line;
      if (!options.fs.existsSync(`${options.mediaDir}/${storageKey}`)) return line;

      const rewritten = `${match[1]}${MEDIA_DIR_PREFIX}${storageKey}${match[4]}`;
      return hasCr ? `${rewritten}\r` : rewritten;
    })
    .join('\n');
}

/**
 * Resolves a workspace-relative mirror reference back to its storageKey.
 *
 * A reference that spells a storageKey outright (`media/<storageKey>`) is returned verbatim: the key names its
 * own mirror, so no lookup is needed. Any other name — a `<stem>--<mediaId>` collision suffix or a truncated
 * stem — is recovered by asking `candidateStorageKeys`, the storageKeys Emit has confirmed through `media_state`
 * and companion YAML, which one sanitizes to that stem. A reference no confirmed mirror owns yields null, so a
 * hand-written path still reaches the push guards instead of being silently rewritten.
 */
export function storageKeyFromMirrorRef(
  rawPath: string,
  candidateStorageKeys: Iterable<string>,
): string | null {
  const name = refBasename(rawPath);
  if (!name) return null;

  // The reference may already be the storageKey itself. Confirming it against recorded metadata keeps an
  // unmirrored key unresolved, but a bare storageKey needs no stem translation.
  const confirmed = [...candidateStorageKeys];
  if (confirmed.length === 0 && STORAGE_KEY_EXTENSION.test(name)) return name;
  for (const key of confirmed) {
    if (key === name) return key;
  }

  const stem = name.replace(/\.[A-Za-z0-9]{1,11}$/, '');
  if (!stem) return null;
  // A collision-suffixed mirror is named `<stem>--<mediaId>` by `collisionSuffixedMarkdownRef`, so the suffix
  // must come off before the stem is matched against confirmed storageKeys.
  const bareStem = stem.replace(/--[0-9A-HJ-NP-Z]{26}$/i, '');
  for (const key of confirmed) {
    const ref = storageKeyToMarkdownRef(key);
    if (ref && (ref === stem || ref === bareStem)) return key;
  }
  return null;
}

/**
 * Builds the `../../` depth an article at `articleRelPath` needs to reach `media/` from its own directory,
 * matching the prefix the draft-image guards already accept.
 */
export function mediaRefPrefixForArticle(articleRelPath: string): string {
  const dir = articleRelPath.split('/').slice(0, -1).join('/');
  const depth = dir ? dir.split('/').length : 0;
  return '../'.repeat(Math.max(depth, 1));
}
