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
 *   local      `![alt](../../media/<storageKey>)`             — a reference spelled from the article's own
 *                                                        directory, resolving to the mirrored file under
 *                                                        `media/` at the workspace root
 *
 * The local spelling exists so an editor preview (VS Code, Obsidian) renders the image from the mirror. It is
 * only ever a disk form: `base_snapshots.bodyMarkdown` and every payload sent to EmDash keep the canonical
 * URL, because the baseline must stay byte-identical to what a remote pull writes.
 *
 * The depth is derived from the article's own path (`mediaRefPrefixForArticle`), so an article under
 * `<collection>/draft|published/` carries `../../` while one at the workspace root carries `../`. That makes
 * the link resolvable from the file that contains it, which a depth-free reference is not. The older depth-free
 * form (`media/<storageKey>`) is still accepted wherever a local reference is read — workspaces built with it
 * are re-spelled on the next pull rather than reported as edits.
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
 * carry the deterministic `<stem>--<mediaId>` collision suffix, which still names a real asset. An article may
 * spell that mirror relative to its own directory (`../../media/<key>`), so leading `../` / `./` segments are
 * part of the accepted shape — but nothing deeper than `media/` is: a staging draft (`media/drafts/x.png`) or
 * an unrelated folder (`../../uploads/x.jpg`) is not a canonicalized local reference.
 */
const LOCAL_MEDIA_REF_REGEX = /^(?:\.\.\/|\.\/)*media\/([^/?#\s]+)$/;

/** `storageKeyFromMirrorRef` needs no candidate list when the reference spells its storageKey outright. */
const EMPTY_STORAGE_KEY_CANDIDATES: ReadonlySet<string> = new Set();

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
 * Reports whether a Markdown image URL is a reference into `media/` — either workspace-relative (`media/<key>`)
 * or spelled from the article's own directory (`../../media/<key>`). Deliberately strict so an arbitrary
 * hand-written path (`./hero.png`, `../uploads/x.jpg`) or a staging draft (`media/drafts/x.png`) is never
 * mistaken for a canonicalized local reference.
 */
export function isLocalMediaRef(url: string): boolean {
  const name = refBasename(url);
  return name !== null && STORAGE_KEY_EXTENSION.test(name);
}

/**
 * Rewrites canonical body image URLs into local mirror references.
 *
 * Only a standalone Markdown image line whose URL is the canonical media route AND whose storageKey names an
 * existing file under `media/` is rewritten. Anything else — an external `https://` src, a data URL, a
 * reference whose asset is not mirrored, an inline image inside a paragraph, an opaque EmDash block fence —
 * is left exactly as it arrived, so the transform never invents a broken local link and never rewrites a line
 * Emit's push guards would refuse to restore.
 *
 * A line that already carries a local mirror reference is normalized rather than skipped: its storageKey is
 * recovered through `storageKeyFromMirrorRef` and rewritten into this function's own spelling, so re-localizing
 * a document is idempotent and a file written at another depth (a legacy workspace ref, or an article moved
 * between `draft/` and `published/`) converges on the requested form instead of being reported as an edit.
 *
 * When `articleRelPath` is supplied the reference is spelled relative to that article's own directory
 * (`../../media/<storageKey>` for `posts/draft/…`), which is what lets a Markdown preview resolve the mirror
 * offline. Without it the reference stays workspace-relative (`media/<storageKey>`), the spelling older
 * workspaces carry on disk.
 */
export function canonicalToLocalMediaRefs(
  body: string,
  options: {
    mediaDir: string;
    fs: { existsSync(p: string): boolean };
    articleRelPath?: string;
  },
): string {
  const prefix = options.articleRelPath
    ? `${mediaRefPrefixForArticle(options.articleRelPath)}${MEDIA_DIR_PREFIX}`
    : MEDIA_DIR_PREFIX;
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

      // A canonical route names its storageKey outright; an already-local reference names it through the mirror
      // spelling, which `storageKeyFromMirrorRef` recovers without a candidate list because the key is written
      // verbatim in the line. Either way the transform rewrites into `prefix`, never leaving a stale depth.
      const storageKey =
        storageKeyFromCanonicalUrl(match[3]) ??
        storageKeyFromMirrorRef(match[3], EMPTY_STORAGE_KEY_CANDIDATES);
      if (!storageKey) return line;
      if (!options.fs.existsSync(`${options.mediaDir}/${storageKey}`)) return line;

      const rewritten = `${match[1]}${prefix}${storageKey}${match[4]}`;
      return hasCr ? `${rewritten}\r` : rewritten;
    })
    .join('\n');
}

/**
 * Resolves a local mirror reference back to its storageKey.
 *
 * A reference that spells a storageKey outright (`media/<storageKey>` or the article-relative
 * `../../media/<storageKey>`) is returned verbatim: the key names its own mirror, so no lookup is needed. Any
 * other name — a `<stem>--<mediaId>` collision suffix or a truncated stem — is recovered by asking
 * `candidateStorageKeys`, the storageKeys Emit has confirmed through `media_state` and companion YAML, which
 * one sanitizes to that stem. A reference no confirmed mirror owns yields null, so a hand-written path still
 * reaches the push guards instead of being silently rewritten.
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

/** True when every standalone image line already carries `prefix` plus a mirrored storageKey. */
function isLocalizedIn(
  body: string,
  prefix: string,
  fs: { existsSync(p: string): boolean },
): boolean {
  let sawLocalRef = false;
  const standaloneRegex = /^!?\[([^\]]*)\]\(([^)]+)\)$/;
  for (const rawLine of body.split('\n')) {
    const trimmed = (rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine).trim();
    if (!trimmed || /^<!--ec:block\s/.test(trimmed)) continue;
    const match = trimmed.match(standaloneRegex);
    if (!match) continue;
    const ref = match[2].trim();
    if (isCanonicalMediaUrl(ref)) continue; // An unmirrored reference carries no local spelling either way.
    const name = refBasename(ref);
    if (name === null || !STORAGE_KEY_EXTENSION.test(name)) return false;
    if (!ref.startsWith(prefix)) return false;
    sawLocalRef = true;
  }
  return sawLocalRef;
}

/**
 * Chooses which local spelling a Markdown document should carry on disk.
 *
 * The canonical `/_emdash/api/media/file/<storageKey>` URL is what every baseline, cache hash and remote payload
 * records; only the file an editor reads may be spelled locally. This helper decides that spelling from what
 * the workspace already holds: a fresh write prefers the article-relative form (`../../media/<storageKey>`) so
 * a Markdown preview resolves the mirror offline, while a document already written in the depth-free legacy form
 * (`preferLegacyRef`, read back from disk) is reproduced in that same form. Reproducing the disk's own spelling
 * is what keeps `sync_state.local_hash` and an unchanged article's diff honest — re-spelling a file the user
 * never edited would report a media rewrite nobody made.
 *
 * A storageKey with no mirrored binary under `media/` stays canonical in every mode, so the transform can never
 * invent a broken local link.
 */
export function localizeArticleMediaRefs(
  body: string,
  options: {
    workspaceRoot: string;
    articleRelPath: string;
    fs: { existsSync(p: string): boolean };
    /** Reproduce the depth-free `media/<storageKey>` spelling instead of preferring the article-relative one. */
    preferLegacyRef?: boolean;
  },
): string {
  // The transform inspects `media/<storageKey>` existence itself, so the media directory must stay absolute.
  const mediaDir = `${options.workspaceRoot.replace(/\/$/, '')}/media`;
  const depthPrefix = `${mediaRefPrefixForArticle(options.articleRelPath)}${MEDIA_DIR_PREFIX}`;

  // Already written in the requested spelling: leave it byte-identical so its hash stays stable.
  const targetPrefix = options.preferLegacyRef ? MEDIA_DIR_PREFIX : depthPrefix;
  if (isLocalizedIn(body, targetPrefix, options.fs)) return body;

  // Otherwise localize from canonical form into the requested spelling. A disk file that already carries the
  // other local spelling is normalized here too — a draft→published move changes the article's depth, and
  // re-spelling in the new location keeps the written file honest about where its mirror lives.
  return canonicalToLocalMediaRefs(body, {
    mediaDir,
    fs: options.fs,
    articleRelPath: options.preferLegacyRef ? undefined : options.articleRelPath,
  });
}
