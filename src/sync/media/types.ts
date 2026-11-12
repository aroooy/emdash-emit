import type { CacheDatabase } from '../../db/cache.js';

export const MEDIA_BINARY_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.avif',
  '.svg',
] as const;

export const MEDIA_LIST_PAGE_SIZE = 100;

export interface EmDashMediaItem {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  width?: number | null;
  height?: number | null;
  alt?: string | null;
  caption?: string | null;
  url?: string;
  storageKey?: string;
  contentHash?: string | null;
  status?: 'pending' | 'ready' | 'failed';
  createdAt?: string;
}

/** Result of promoting a local draft image into the canonical `media/` layout. */
export interface PromotedMediaFile {
  /** Workspace-relative path of the promoted binary, e.g. `media/<markdownRef>.png`. */
  filePath: string;
  /**
   * Workspace-relative path of the shared stem for the binary and its companion YAML, e.g.
   * `media/<markdownRef>`. Recorded as `media_state.markdown_ref` so a body storageKey resolves to this
   * mirror without parsing a filename.
   */
  markdownRef: string;
}

export interface PromoteDraftMediaOptions {
  workspaceRoot: string;
  origin: string;
  draftAbsPath: string;
  item: EmDashMediaItem;
  removeDraft?: boolean;
}

/** A body image reference whose media record could not be resolved. */
export interface OrphanMediaDescriptor {
  /** The storageKey taken from the article body URL `/_emdash/api/media/file/<storageKey>`. */
  storageKey: string;
  /** ULID segment(s) found inside the storageKey, uppercased, in document order. */
  ulids: string[];
  ext: string;
}

/**
 * A locally mirrored asset that can be used to re-verify a body storageKey without inventing remote
 * data: the media/ companion YAML already records both the record id and the confirmed storageKey.
 */
export interface LocalMediaMirrorCandidate {
  /** Media record id read from the companion YAML (`id:`) or the canonical filename stem. */
  mediaId: string;
  /** The storageKey recorded by the companion YAML, when present. */
  storageKey?: string;
  /** Companion YAML file name relative to `media/`. */
  metaFile: string;
}

/**
 * A media mirror's on-disk identity under the storageKey naming rule.
 *
 * `markdownRef` is the stem both the binary and its companion YAML share, derived from the storageKey the
 * article body references. `legacyBaseNames` enumerates every older stem this asset may still occupy — the
 * un-prefixed `<id>-<name>` form and any `<yyyyMMdd>_<id>-<name>` form written by earlier Emit versions or
 * by a local promotion with a provisional date — so one pull can rename an existing workspace into the new
 * layout without re-downloading a byte.
 */
export interface MediaMirrorNames {
  markdownRef: string;
  ext: string;
  legacyBaseNames: string[];
}

export interface PullMediaOptions {
  workspaceRoot: string;
  origin: string;
  token: string;
  refreshToken?: string;
  article?: string;
  collection?: string;
  limit?: number;
  all?: boolean;
  /** Mirror exactly these storageKeys, resolved from the library walk. */
  storageKeys?: string[];
  downloadFiles?: boolean;
  prune?: boolean;
  fetchFn?: typeof fetch;
  /**
   * Workspace cache. When provided, every mirrored asset is registered in `media_state` with its storageKey
   * and mirror path, which is what lets a body reference resolve by index instead of by filename — mirrors
   * are named after the storageKey and no longer carry the record id.
   */
  cache?: CacheDatabase;
}

export interface PullMediaResult {
  total: number;
  downloaded: number;
  skipped: number;
  deleted?: number;
  /**
   * Media ids that Emit could not mirror in this run. An article-targeted pull collects every ULID a
   * body mentions, but a migrated corpus bakes the R2 `storageKey` into the body URL, and those ULIDs
   * are media ids only by coincidence — so most of them resolve to nothing. That is a known shape of a
   * migrated corpus, not an unresolved reference: for an article-targeted pull this field counts only
   * references that failed every id lookup AND every storageKey check, and `unresolvedIds` below holds
   * the ids that merely resolved to no record.
   */
  failed?: number;
  /**
   * Article-targeted pulls only: how many collected media ULIDs returned no record. Expected for a
   * migrated corpus, where the body URL carries an R2 storageKey rather than a media id, so these are
   * reported separately from `failed` and never presented as unresolved references.
   */
  unresolvedIds?: number;
  articleId?: string;
  mediaIds?: string[];
  /**
   * Body storageKeys confirmed by evidence Emit actually holds: the canonical lookup resolved a record
   * under that ULID (its own storageKey may differ), or a local mirror companion already names it. Such
   * a key is healthy and must never be escalated as missing.
   */
  verifiedStorageKeys?: string[];
  /**
   * Body storageKeys that neither a resolved record nor confirmed local metadata could match.
   * Populated only for an article-targeted pull, where body references are inspected one by one.
   */
  orphanStorageKeys?: string[];
  /**
   * Total media records reported by the server (`totalCount` of the list operation) for a library-wide
   * pull. Lets a user tell "this run covered N of M" apart from "the library has N items".
   */
  remoteTotalCount?: number | null;
  /**
   * StorageKeys referenced by workspace articles that no local mirror names and that a complete remote
   * library walk also did not report. Populated only for `--all` pulls, where the walk is exhaustive.
   */
  referencedUnmirroredStorageKeys?: string[];
}

/**
 * Reads the media library once and returns its full storageKey index.
 *
 * `GET /_emdash/api/media` accepts only `cursor`, `limit`, `page`, `mimeType`, `folderId`, `q`, and
 * `includeUsage`, so a specific body reference cannot be looked up by key: the list operation is the
 * only handle that reaches migrated assets, whose storageKey differs from the record id that
 * `GET /_emdash/api/media/{id}` keys on. Every item in the response carries its own `storageKey` and
 * the listing is cursor-bounded by `totalCount`, so one walk indexes the whole library. The response's
 * `totalCount` is reported alongside the index so callers can tell "the key is absent from a complete
 * library" apart from "the walk stopped early".
 */
export interface RemoteStorageKeyIndex {
  /** Every storageKey present in the remote media library, as reported by the list endpoint. */
  storageKeys: Set<string>;
  /** ULIDs of the records those keys belong to, for reporting a match as a record id. */
  mediaIdsByStorageKey: Map<string, string>;
  /**
   * The full `EmDashMediaItem` each storageKey resolves to, exactly as the list endpoint reported it.
   * These carry `filename`, `mimeType`, and `size` — everything `mediaMirrorNames()` needs to derive a
   * mirror stem, collision suffix, and extension — so an article-driven mirror can reuse a walked record
   * instead of fetching `GET /_emdash/api/media/{id}` again per asset. A walk that only builds the key set
   * (doctor's coverage check) still populates this; nothing reads it unless a mirror stage asks for it.
   */
  recordsByStorageKey: Map<string, EmDashMediaItem>;
  /** The same records keyed by their record id, so an article body that references a media id resolves too. */
  recordsById: Map<string, EmDashMediaItem>;
  /** `totalCount` reported by the server, or null when the response did not include it. */
  totalCount: number | null;
  /** True only when the walk finished without hitting `maxItems`. */
  complete: boolean;
  /**
   * Records actually read from the list endpoint. Live EmDash reports no `totalCount` at all, so this
   * walked count is the only figure a coverage report can state; it equals `storageKeys.size` unless a
   * record repeated a key or lacked one.
   */
  scannedCount: number;
}

/** The set of storageKeys a mirror stage actually resolved to a walked record and mirrored. */
export interface MirroredAssetResult {
  /** StorageKeys matched to a walked record and written to `media/` (binary + companion). */
  mirroredStorageKeys: Set<string>;
  /** How many of those were freshly downloaded versus already up-to-date on disk. */
  downloaded: number;
  skipped: number;
  /**
   * Referenced storageKeys no walked record mirrors, but confirmed evidence proves healthy: the walk stored
   * that exact key, or a walked record / local mirror companion names the ULID baked into the key. Such a key
   * is healthy and must never be escalated as missing.
   */
  verifiedStorageKeys: string[];
  /**
   * Referenced storageKeys that no walked record owns and no confirmed local mirror metadata names. A key
   * whose ULID matches a record the walk resolved under that id is downgraded to `verifiedStorageKeys`,
   * never escalated here — Emit mirrors records and never repairs server data.
   */
  orphanStorageKeys: string[];
}

/** One media-search hit, decorated with the local mirror state Emit actually holds. */
export interface MediaSearchHit {
  /** D1 media record id (uppercase ULID). NEVER usable in a body URL. */
  mediaId: string;
  /** R2 storage key — the only value valid in `/_emdash/api/media/file/<storageKey>`. */
  storageKey: string | null;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  alt: string | null;
  caption: string | null;
  createdAt?: string;
  /** True when Emit already mirrors this asset (media_state or companion YAML confirms it). */
  mirrored: boolean;
  /** Workspace-relative mirror path (`media/<markdownRef>.<ext>`), null when not mirrored. */
  localPath: string | null;
  /** Which field matched the query, so an agent can read why a row was returned. */
  matchedOn: Array<'filename' | 'alt' | 'caption' | 'storageKey' | 'mirrorStem'>;
}

export interface MediaSearchResult {
  hits: MediaSearchHit[];
  /** Records actually read from the list endpoint. */
  scannedCount: number;
  /** True only when the walk finished without hitting `maxScan`. Absence claims require this. */
  walkComplete: boolean;
  /** Server-reported totalCount when present (live EmDash reports none). */
  totalCount: number | null;
  /** True when hits were cut at `limit`. */
  truncated: boolean;
  /** Query as normalized for matching (lowercased), echoed so agents can audit. */
  normalizedQuery: string;
}

export interface LocalMirrorEntry {
  mediaId: string;
  storageKey: string;
  /** Workspace-relative binary path, read from media_state.markdown_ref / workspace_path. */
  localPath: string | null;
  /** Companion YAML metadata only — never guessed from a filename. */
  filename: string | null;
  alt: string | null;
  caption: string | null;
}

/** storageKey -> mirror entry. Built from confirmed metadata sources only. */
export type LocalMirrorIndex = Map<string, LocalMirrorEntry>;
