# Changelog

All notable changes to the `emdash-emit` (`emit`) project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.16] - 2026-11-12

### Added

- **Media Search Index (`emit media-search` / `sync_media_search`)**:
  - Search pre-uploaded remote EmDash media assets across filename, alt text, caption, storageKey, and local mirror stems without downloading bulk binary files (conserving bandwidth, disk space, and LLM context).
  - Client-side pagination walk: Does not rely on the remote server's `q` parameter (which only filters filenames), enabling multi-lingual search over `alt` and `caption` metadata.
  - Epistemic completeness reporting: Reports `scannedCount` and `walkComplete: boolean`. When stopped early at `--max-scan`, emits `[WALK_INCOMPLETE]` and refuses to assert that an asset is absent, preventing AI hallucinations and rogue duplicate INSERTs.
  - Local mirror decoration: Resolves `mirrored: boolean`, `localPath`, and companion metadata against schema v5 `media_state` and companion YAMLs (`media/*.yaml`) without schema migrations.
  - Keyword hints (`--suggest-keywords`): Suggests top 10 local tag slugs (sorted by frequency count) to help discover assets in migrated corpora with opaque ULID filenames.

- **Targeted StorageKey Mirroring (`--storage-key`)**:
  - `emit pull-media --storage-key <key>` and MCP `sync_pull_media({ storageKey })`: Allows AI agents and users to mirror an individual asset discovered via search without pulling the full library or an entire article.
  - Directly reuses walked remote records via `syncSingleMediaItem()` without issuing duplicate `GET /_emdash/api/media/{id}` requests.
  - Enforces mutual exclusivity with `--article` and `--all` at the CLI level.

### Changed

- **Guard G5 / G11 Suggestion Guidance**:
  - `LOCAL_IMAGE_DETECTED` and `MISSING_LOCAL_IMAGE_FILE` suggestions now recommend looking up mirrored assets via `emit media-search` / `sync_media_search` and replacing local paths with canonical `/_emdash/api/media/file/<storageKey>` URLs, emphasizing that metadata matching resolves only confirmed local mirrors.

## [0.1.15] - 2026-11-12

### Added

- **Article-Relative Local Media References (`localMediaRefs`, default-ON)**:
  - Workspace setting `.emit/config.json → localMediaRefs` (default `true`). Mirrored body images are written to disk as article-relative `../../media/<storageKey>` references so Markdown preview and local tooling resolve them offline from the article's own directory, instead of the canonical `/_emdash/api/media/file/<storageKey>` URL.
  - Round-trip symmetry is preserved: the **baseline snapshot and hash stay canonical**, so the 3-way merge, `sync_state.local_hash`, and the remote payload all keep the canonical URL, while only the file on disk carries the local spelling. Push localizes _after_ preflight canonicalization, so an article that spells images locally still pushes the exact canonical body.
  - CLI flags `emit pull --local-media-refs` / `emit push --local-media-refs` enable the setting and persist it; `--no-local-media-refs` clears a remembered preference. MCP `sync_pull` / `sync_push` accept a `localMediaRefs` argument that overrides the stored setting, matching CLI precedence (explicit argument > remembered config).
  - `emit diff` renders the baseline in whichever spelling the disk already carries, so an untouched local-ref article never reports a phantom media rewrite and only a real edit shows up.

- **Canonical Sliding Window Size (`postsSyncLimit: 30`)**:
  - The default sliding window limit is canonicalized to `30` (fetching up to 30 `published` + up to 30 `draft` articles in parallel, for a maximum working set of 60 files on the staging desk), bounding local filesystem footprint and aligning with Cloudflare Workers / D1 execution limits. Single-article fetch (`emit pull <id>`) remains fully available for out-of-window posts.

- **Fast-Path Frontmatter Self-Healing (H1 / P1)**:
  - `tryFastPathOrHeal` in `src/sync/pull.ts` now validates `parseMarkdown` even when the disk hash matches the cached baseline. Legacy files whose unquoted percent-encoded taxonomy slugs never parse were previously skipped forever, so `emit status` reported them invalid while `emit pull` did nothing.
  - Such files are repaired locally by `lenientRepairMarkdownFrontmatter` and re-tracked against their own repaired hash; the `base_snapshot` is left untouched, values are never altered, and no per-article or taxonomy fetch is issued — batch pulls of large legacy corpora stay fast (verified: only list/bylines/openapi requests for healed articles).
  - Only when local lenient repair fails does the pull fall through to the full remote re-serialization path (which preserves unpushed bodies and quarantines divergence as before).
- **Lenient Repair Indentation Correctness**: `lenientRepairMarkdownFrontmatter` re-indents sequence items relative to their own parent taxonomy key (`sequenceParentIndent`) instead of hardcoding 4 spaces, so legacy 2-space sequences under a 2-space `categories:` key — the actual production corruption shape — are repaired correctly. Repaired candidates are additionally gated on gray-matter producing a plain object before schema validation.
- **Status & Doctor Diagnostic Alignment (H2 / P2)**:
  - `getWorkspaceStatus` adds `healable` per invalid item and `summary.healableInvalid`, classifying exactly the set `emit doctor` can recover. `emit status` now shows `🟠 healable` vs `🔴 invalid` and reports `N invalid (M healable)`.
  - `emit doctor` reports leniently repairable frontmatter as a `warning` with an explicit `emit pull` instruction instead of silently passing, so `status`, `doctor`, and `pull` never disagree.
- **Accurate Repair Hints (H3 / P3)**: CLI `emit status` and MCP `sync_status` distinguish healable from unrecoverable invalid files (`healableInvalid` / `unrecoverableInvalid` in the MCP payload) and describe the actual repair mechanism (local syntax-only re-quoting, no article fetch for cached unchanged revisions).

- **Cache Schema v5 Migration (`media_state_v5`)**:
  - Upgraded SQLite cache schema to version 5. Replaced `local_hash` PRIMARY KEY in `media_state` with `storage_key` PRIMARY KEY to model the immutable public address space accurately.
  - Separated `local_content_hash` (local SHA-256 binary digest) and `remote_record_ref` (`media-record:<id>`), resolving the historical collision asymmetry. Added index `idx_media_state_content_hash`.
  - Added dedicated methods `getMediaStateByContentHash` and `deleteMediaStateByContentHash` for upload recovery. Preserved the upload confirmation invariant where old temporary storageKey entries are cleanly deleted before committing confirmed double-ULID keys.

### Added

- **Two Media ID Spaces Specification (`docs/media-id-spaces.md`)**: a standalone reference documenting EmDash's two unrelated media ULIDs — the D1 `media` record `id` (used by `GET /_emdash/api/media/{id}` and every write endpoint) and the R2 object `storageKey` (served by `/_emdash/api/media/file/{storageKey}`) — with an identifier/endpoint matrix, a live production example proving they never match for the same asset, why a 401/404 from either route proves only a failed lookup, how migrated corpora enter a workspace (newest-first `mediaSyncLimit` window plus empty migrated featured images), and the `verifiedStorageKeys` → `orphanStorageKeys` resolution order.
- **Discovery Points for Humans and Agents**: the specification is reachable from every surface that touches media — README (§ Directory Structure & Data Specifications, Key Features, frontmatter schema note, `emit pull-media`, and a new FAQ entry for images that do not render in a local preview), AGENTS.md (§1 Reference Documents plus the workspace tree and Guard section), MCP `instructions` (the two-ULID rule and a media-window hint on `[MEDIA]`), `emit guide`, and the `emit doctor` "Media References" warning, which now states that a missing local mirror is not a broken reference. Tests assert the pointer survives in MCP instructions, `emit guide` output, and the doctor message.

### Changed

- **Media Mirror Coverage — Local `url:` Recovery and a Complete Library Walk**: the audit that proved all 4,008 records exist also showed why Emit could not see them: only 6 of the 33 migrated companions carried a `storageKey:` field, and `pullMedia` stopped at `mediaSyncLimit` (300), so 3,708 assets were unreachable and 27 healthy companions produced false warnings.
  - New exported `storageKeyFromMediaMeta(doc)` reads a companion's storageKey from `storageKey:` when present and otherwise recovers it from the canonical `url:` (`/_emdash/api/media/file/<storageKey>`, absolute or root-relative). A `url` that is not a file route names no key, and an explicit field always wins. `collectLocalMediaMirrorCandidates` and the `emit doctor` media index both use it, so a migrated companion verifies its own body reference instead of warning forever. `legacy_*` residue stays excluded.
  - `pullMedia` reports coverage: `PullMediaResult.remoteTotalCount` carries the server's `totalCount`, and CLI/MCP append `remote library holds N record(s), of which this run walked M`. Under `--all` the walk is exhaustive, so it doubles as a storageKey census — `referencedUnmirroredStorageKeys` lists body keys that neither a local companion nor any remote record names, surfaced as `[UNREFERENCED_REMOTE_MEDIA]` and worded as a lookup result rather than a missing record. Local mirrors seed the active-key set, so `--prune` never deletes an asset this run's window simply did not reach.
  - New exported `collectRemoteStorageKeys()` walks the library cursor-by-cursor (100 per page) into a `RemoteStorageKeyIndex`, and `findUnmirroredStorageKeys()` reports against it. A walk that stopped early is marked `complete: false` and yields nothing, because a partial walk proves nothing about the rest of the library.
  - **Live-server correction (verified against aroooy.net)**: the deployed EmDash list endpoint returns only `{ items, nextCursor }` — no `totalCount` at all — so `RemoteStorageKeyIndex` adds `scannedCount`, and a _complete_ walk becomes the library figure that coverage lines report (`remoteTotalCount` falls back to it; an incomplete walk reports nothing rather than a partial page count). A complete `emit pull-media --all` run states its own library size instead of printing the previous `remote library holds 0 record(s)`, and `emit doctor --check-media-library` reads "The remote library walk reached N media record(s)" when the server supplies no total.
- **Article-targeted media reporting no longer calls a storageKey a failure**: on aroooy.net `emit pull-media --article <id>` printed `4 failed` for an article whose four images were all mirrored correctly, because the ULIDs collected from body URLs are R2 storageKeys and the canonical id lookup cannot match them by design.
  - `pullArticleMedia` now counts those in a new `PullMediaResult.unresolvedIds`, and `failed` counts only references that failed the id lookup **and** every storageKey check (i.e. genuine `orphanStorageKeys`).
  - New exported `formatArticleMediaSummary` renders CLI output as `(0 downloaded, 0 skipped/up-to-date, 4 verified/mirrored). (4 body ULID(s) are R2 storageKeys, not media record ids, so no id lookup was expected to match)`; MCP `sync_pull_media` gained the same `verified/mirrored` count and explanation. The reassuring note is suppressed whenever something genuinely is unresolved.
  - README (`emit pull-media`), `docs/media-id-spaces.md`, and `PullMediaResult` docstrings now state that a migrated body's ULIDs are expected to resolve to nothing.
  - `emit doctor --check-media-library` (MCP `sync_doctor checkMediaLibrary: true`) states the remote record count against the number of assets this workspace mirrors, so a missing-file warning reads as coverage. Plain `emit doctor` stays offline.
  - Guidance now routes through Emit first: `[UNRESOLVED_MEDIA_ASSET]`, the doctor suggestion, README, MCP instructions, `emit guide`, and `docs/media-id-spaces.md` all route to `emit doctor --check-media-library` (metadata-only walk) first and reserve `emit pull-media --all` for deliberate full offline backups, with server-side verification only for what a complete walk could not match. Maintenance-only guardrails are enforced across CLI help, MCP schema descriptions, and `emit guide` outputs.
- **Media Resolution Stays Epistemic (production investigation follow-up)**: a live D1 audit of the migrated corpus proved that all 4,008 media records exist and every WordPress `storage_key` is registered, so the earlier "the D1 record is missing" framing was wrong — the 401/404 symptoms come from addressing `GET /_emdash/api/media/{id}` (D1 primary key) with an R2 `storageKey`, and from calling the authenticated admin API without a bearer token. Emit must therefore never conclude that a record is absent, and its advice must never invite a duplicate registration:
  - CLI warning renamed to `⚠️ [UNRESOLVED_MEDIA_ASSET]`, and both its wording and `emit doctor --check-media-urls`'s suggestion now state that a 404 proves only a failed lookup and instruct verification by storageKey (`wrangler d1 SELECT` on the media table, or the admin UI) before registering anything. The old "Register the missing media records" instruction is gone.
  - New exported `collectLocalMediaMirrorCandidates(mediaDir)` indexes every `media/*.yaml` companion by both its record id and its recorded `storageKey`, skipping `legacy_*` residue so fabricated metadata can never serve as verification evidence.
  - `PullMediaResult` adds `verifiedStorageKeys`: a body key is confirmed when Emit resolved a record under that ULID (even if the record reports a different storageKey) or when a local mirror companion names it, so such a key is never escalated as missing. Only keys with no evidence at all stay in `orphanStorageKeys`.

### Removed

- **Legacy Synthesized Media Fallback (`media/legacy_*` companions)**:
  - Deleted `syncSynthesizedMediaItem` and every direct file-route fallback branch in `pullArticleMedia`: Emit no longer downloads a `/_emdash/api/media/file/<storageKey>` asset that no media record resolves to, never invents a media record for it, and writes nothing into `media/`. Registering records belongs to EmDash (admin UI) or Wrangler — Emit mirrors records and does not repair server data. This also eliminates the self-destruct bug where a synthesized pair was unlinked during cleanup because its `legacy_` base name never matched the referenced id.
  - `pullArticleMedia` now collects every body storageKey via the new exported `collectArticleStorageKeys` (markdown images, HTML `img` tags, opaque fences, and legacy container lines) and reports the keys no media record could mirror as `orphanStorageKeys`, which CLI `emit pull-media --article` prints as a warning and MCP `sync_pull_media` returns both as an unresolved-keys list and the same warning. See **Changed** above for how that warning is worded now.
  - `emit doctor` no longer recognizes `legacy_*` stems in its known-storageKey set, so leftover residue is reported as a missing reference instead of silently satisfying it; with `--check-media-urls` a key the origin still serves is downgraded to an informational "served by the file route but matched by no local mirror or record lookup" note, and the check's suggestion always points at storageKey verification through the EmDash admin UI or wrangler rather than at `pull-media`.
  - `emit pull-media --prune` explicitly skips `legacy_*` files (they match no media id) so existing residue is never deleted implicitly; it must be removed by hand after the remote record is registered. Media metadata lookup also refuses to read a `legacy_*.yaml` as a real record's metadata.

---

## [0.1.14] - 2026-11-10

### Added

- **Taxonomy Strategy Enforcement (R1 / P1)**:
  - Made `mergeTaxonomies` in `src/sync/merge.ts` the single authoritative decision point for 3-way merge resolution, strictly honoring `--resolve-taxonomy local|remote` (CLI and MCP).
  - Extended strategy adoption to Case 2 (remote deleted vs local modified) and Case 4 (both modified), recording `strategyAdoptions` in merge warnings and returning discarded terms.
  - Clarified destructive single-side adoption semantics (ours/theirs): explicit `--resolve-taxonomy` bypasses `DESTRUCTIVE_TAXONOMY_WIPE` guard without requiring `--allow-wipe-taxonomies`.
  - Extended `TAXONOMY_UNION_REJECTED` guidance when server constraints (e.g. single category limit) reject strategy-adopted taxonomy assignments.
- **Body & Taxonomy Conflict Pending Separation (R2 / P2)**:
  - Upgraded SQLite cache schema to version 3 (`CURRENT_CACHE_SCHEMA_VERSION = 3`), adding dedicated `body_conflict_pending` and `taxonomy_conflict_pending` columns to `sync_state`.
  - Maintained `conflict_pending = MAX(body_conflict_pending, taxonomy_conflict_pending)` for full backward compatibility.
  - Re-ordered push guards: evaluated preflight Guard G6 (`UNRESOLVED_CONFLICT_MARKERS`) before G15 (`TAXONOMY_CONFLICT_PENDING`) to eliminate misleading taxonomy flags and circular suggestions when body conflict markers remain.
- **Remote-Deleted Article Deadlock Resolution (R3 / P3)**:
  - Unified HTTP 404/410 detection across initial PUT, conflict remote GET, and auto-merge retry PUT into actionable `[REMOTE_ARTICLE_DELETED]` with 3 clear escape routes.
  - Added `emit pull <id> --force` unpushed edits preservation: safely moves divergent local files to `<collection>/conflicts/*.local-dropped.md`, unlinks canonical article, deletes DB tracking record, and returns `deleted: true, quarantined: true`.
  - Added `--discard-local-edits` to CLI `emit delete` and MCP `sync_delete` to allow purging local and DB state on remote 404 while preserving unpushed modifications in `.deleted.md`.
- **Conflict Metadata Consistency & Lifecycle (R4 / P4)**:
  - Updated `saveSyncState` UPSERT to clear `conflict_copy_path`, `conflict_copy_hash`, and `conflict_at` to `NULL` only when all conflict pendings are 0, preserving recovery links if only one conflict type is resolved.
  - Added `clearConflictsByKind(id, kind: 'body' | 'taxonomy' | 'all')`.
  - Updated `emit conflicts resolve --accept-canonical` to call `clearConflictsByKind(id, 'body')`, unblocking subsequent bare pushes.
  - Updated `accept-local` to explicitly pass zeroed conflict fields to `saveSyncState`.
- **Doctor Diagnostic Coverage (R5 / P5)**:
  - Added checks for `taxonomy_apply_pending = 1` (with actionable remote term/permission verification suggestion) and `delete_pending = 1` (with local cleanup / `--revive` suggestions).
  - Separated body vs taxonomy conflict pending warnings in `emit doctor` and auto-cleared resolved flags on a per-kind basis when no divergence or conflict copies exist.
- **SQLite Native `VACUUM INTO` Backups (R6 / P6)**:
  - Replaced manual filesystem copy with SQLite native `prepare('VACUUM INTO ?').run(bakPath)`, producing clean atomic backups from WAL databases.
  - Derived backup filenames dynamically from `package.json` version (`.bak-<version>-<timestamp>`).
  - Implemented unconditional sweep of 0-byte backup files during `pruneBackups`.

---

## [0.1.13] - 2026-11-09

### Added

- **Pre-PUT Taxonomy Divergence Audit (R1 / EMIT-001)**:
  - Audits remote taxonomy assignments (`GET /_emdash/api/content/:collection/:id/terms/{category,tag}`) prior to PUT when article defines taxonomies.
  - Detects out-of-band remote taxonomy modifications independent of entry `_rev` and routes directly into 3-way merge / guards.
  - Added schema v2 migration (`CURRENT_CACHE_SCHEMA_VERSION = 2`), adding `remote_taxonomy_hash` and `taxonomy_apply_pending` with `.bak-0.1.12-<timestamp>` WAL-checkpointed backup (3-generation retention).
  - Added `--no-taxonomy-audit` and `--allow-unapplied-taxonomies` flags to CLI `emit push` and MCP `sync_push`.
- **Partial Failure Handling for Taxonomy Sync (R2 / EMIT-002)**:
  - Added Guard G17 (`TAXONOMY_APPLY_PENDING`): if body PUT succeeds but term POST fails, records `taxonomy_apply_pending = 1` and blocks bare re-push until resolved.
  - Reverts baseline taxonomy terms and hash to prior values on partial failure without rolling back body changes.
  - Automatically syncs taxonomies in single-article pull (`emit pull <id>` / MCP `sync_pull`) unless `postsOnly: true` is explicitly specified.
- **Hierarchical Taxonomy Term Flattening (R5 / EMIT-008)**:
  - Recursively traverses and flattens nested `children` terms in `pullTaxonomies` (`fetchTerms`), preserving `parentId` in `categories/<id>-<label>.yaml` and `tags/<id>-<label>.yaml` with visited-set cycle guard and depth limit (32).
  - Unifies local taxonomy candidate indexing and slug-to-term ID resolution across hierarchical taxonomy trees.
- **Quarantine, Doctor & MCP Enhancements (R3, R6, R8)**:
  - Conflict copy deduplication: reuses canonical `.conflict.md` if unedited without incrementing numeric suffix.
  - Added `.local-dropped` type recognition and `🛡️ [FORCE DROPPED]` reporting in `emit conflicts list`.
  - Added `warnings` in MCP `sync_status` when unreviewed quarantine copies exist in `<collection>/conflicts/`.
  - Added `prune` action with `olderThan`, `dryRun`, `allowOrphanRescues` to MCP `sync_conflicts`.
  - Added `--strict-media` option to CLI `emit doctor` and MCP `sync_doctor`.
  - Added `profile` and `workspaceRoot` to MCP heartbeat recording state.

### Fixed

- **Cache Schema Mismatch Presentation (R4 / EMIT-006)**:
  - Wrapped `CacheDatabase` initialization in CLI context resolver so `[CACHE_SCHEMA_MISMATCH]` exits with exit code 1 and a clean message instead of printing raw Node stack traces.
- **Deterministic Filename Resolution (R7 / EMIT-005)**:
  - Symmetrically resolved date prefixes and titles between batch fast-path and full pull.
- **3-State Taxonomy Evaluation**:
  - Treated missing or malformed term lists as `unknown` (`null`) instead of `none` (`[]`), avoiding false divergence detection on unsupported or mock endpoints.

### Notes & Migration

- **Schema v2 Self-Healing for Existing Workspaces**:
  - Articles synchronized prior to v0.1.12 will have `remote_taxonomy_hash` set to `NULL` in the SQLite cache upon upgrading to schema v2. The remote taxonomy hash is automatically calculated and saved on the article's first subsequent `emit push` or `emit pull`, after which out-of-band taxonomy divergence auditing is fully active.

---

## [0.1.12] - 2026-11-09

### Added

- **Phase 0: SQLite Schema Migration & WAL Safety**:
  - Implemented schema versioning via `PRAGMA user_version` (`CURRENT_CACHE_SCHEMA_VERSION = 1`).
  - Added safe migration with `PRAGMA wal_checkpoint(TRUNCATE)` before backup and 3-generation backup retention (`.bak-0.1.11-<timestamp>`).
  - Added new columns: `conflict_pending`, `delete_pending`, `conflict_copy_hash`, `conflict_copy_path`, and `conflict_at`.
  - Added future schema mismatch guard (`[CACHE_SCHEMA_MISMATCH]`) to prevent database corruption when running older binaries.
- **Phase 3 & 4: Strict Set-Algebraic Taxonomy 3-Way Merge & Push Guards**:
  - Replaced ambiguous dispute logic with strict set-algebraic 3-way taxonomy merge: mutual deletions and clean single-side edits are non-conflicting.
  - Automatic clean union of remote taxonomy additions with explicit logging: `🏷️ Merged remote taxonomy change(s)`.
  - Added `DESTRUCTIVE_TAXONOMY_WIPE` guard requiring `--allow-wipe-taxonomies` (or MCP `allowWipeTaxonomies: true`) when wiping existing remote terms with an empty array.
  - Added `TAXONOMY_UNION_REJECTED` error handling when server rejects a merged union (e.g. single category constraint), guiding user to `--resolve-taxonomy=local|remote`.
  - Added `TAXONOMY_CONFLICT_PENDING` push block: re-pushing an unresolved taxonomy conflict requires `--resolve-taxonomy` or `--force`.
  - Added `DELETE_PENDING_ARTICLE` push block: pushing delete-pending articles requires `--revive` (or `--force`).
- **Phase 6: Conflict Pruning & MCP Heartbeat**:
  - Added `emit conflicts prune` (`--older-than <duration>`, `--dry-run`, `--allow-orphan-rescues`) with unpushed edit safety guards.
  - Added MCP Heartbeat state recording (`~/.config/emit/mcp_state.json` mode 0600) and stale process detection in `emit doctor` / `sync_doctor` (`ESRCH` cleanup, `EPERM` tolerance, and `mtime` outdating check).
  - Maintained complete backward compatibility in `emit status` by omitting the `Flags:` line when all flags are 0.

### Fixed

- **Phase 1: Revision Normalization & Heal Symmetry**:
  - Fixed false-positive unpushed edits quarantine caused by Base64 token vs numeric revision formats (`normalizeRev()`).
  - Kept raw opaque tokens strictly unchanged for server `_rev` PUT transmission and storage.
- **Phase 2: Remote Delete Verification**:
  - Added exponential backoff GET verification with `Cache-Control: no-cache` and `_cb=<timestamp>` to prevent false-success deletion races.
  - Treated HTTP 404 and HTTP 410 (Gone) as confirmed deletion.
  - Protected unpushed local edits on remote delete as `orphan: true` instead of discarding local files.
- **Phase 5: Doctor Informational Media Classification**:
  - Classified code-fence, inline-code, and placeholder media references as `informationalRefs` (Info level).
  - Only unresolved normal body image references trigger warnings, allowing clean workspaces with sample code to report Overall PASS (exit 0).

---

## [0.1.11] - 2026-11-09

### Fixed

- **Doctor Media References False-Positive (D1)**:
  - Resolved `/_emdash/api/media/file/<storageKey>` references against indexed `media/*.yaml` companion documents and local media files.
  - Fixes false-positive warnings where valid remote canonical image references were falsely reported as missing from disk.
- **Push 3-Way Merge Taxonomy Preservation (D2)**:
  - Ensured remote taxonomy terms are fetched via `/_emdash/api/content/{collection}/{id}/terms/{category,tag}` during 409 conflict resolution, rather than assuming empty taxonomies from content GET endpoint.
  - Added `taxonomyConflicts` detection in `mergeTaxonomies`: when local and remote both modify taxonomies differently, push aborts to prevent silent data loss.
- **CLI Clean Error Output for Frontmatter Failures (D4)**:
  - In `emit push`, trapped `FrontmatterParseError` and plain errors to display single-line actionable error messages with suggestions instead of raw Node runtime stack traces (conforming to AGENTS.md §5).
- **Single Article Pull Non-Destructive Heal Symmetry (D5)**:
  - Extended the non-destructive frontmatter healing (`tryFastPathOrHeal`) to single-article pull (`emit pull <ULID>`), eliminating behavioral divergence between batch pull and single ID pull.
- **Guide & Package Distribution (D6)**:
  - Added `emit delete`, `emit conflicts`, `emit doctor`, and `emit pull-media` to `emit guide`'s Handy Commands.
  - Included `CHANGELOG.md` in `package.json`'s `files` distribution array.

---

## [0.1.10] - 2026-11-08

### Summary of Major Architectural Upgrades (Phases 1a, 1b, 2, 3, 4)

Version 0.1.10 represents a comprehensive modernization of Emit into an AI-first, zero-data-loss content authoring environment. It eliminates phantom diffs, hardens deletion and conflict safety, enhances workspace diagnostics, and introduces targeted media syncing.

### Added

- **Phase 1a & 1b: Non-Destructive Frontmatter & Inline Taxonomy Comments**
  - **Non-destructive frontmatter healing**: Unquoted colons, invalid YAML indentations, and encoding quirks are healed non-destructively while strictly preserving local body edits.
  - **Inline Taxonomy Comments (`# <Name>`)**: Frontmatter arrays for categories and tags now support trailing inline comments (e.g. `- tech # 技術`, `- 01M6... # Cloudflare`) so human and AI authors see names alongside IDs.
  - **Bidirectional taxonomy resolution**: Resolves names to IDs and IDs to names cleanly, eliminating phantom diffs on repeated pulls and pushes.
  - **Author Byline normalization**: Strict validation and default auto-selection of active authors for `emit new` / `sync_new`.

- **Phase 2: Slug Collision Guards, Safe Deletion, and Summary-First Status**
  - **Duplicate Slug Guard (`DuplicateSlugError` / `DUPLICATE_SLUG_GUARD`)**: Prevents creating new articles whose slugs clash with existing local files (draft or published), indexed cache entries, or remote CMS posts.
  - **Safe Deletion (`emit delete` / `sync_delete`)**:
    - Remote `DELETE` API call with Cloudflare Workers/D1 confirmation.
    - Automatic safety backup: writes a rescue copy to `posts/conflicts/<filename>.deleted.md` before unlinking.
    - Protection against unpushed local modifications (`UnpushedModificationsError` / `UNPUSHED_MODIFICATIONS_PROTECTION`).
    - Guard against unintended deletion of live published articles (`PublishedArticleDeletionForbiddenError`).
    - Media file protection: referenced images in `media/` are preserved even when the article is deleted.
    - Dry-run mode (`--dry-run` / `dryRun: true`) works without requiring authentication tokens.
  - **Summary-First Status (`emit status` / `sync_status`)**: Capped at 30 actionable items and 5 recent articles to prevent context window overflow for AI coding assistants. Added query filters for `search` and `status`.

- **Phase 3: Conflict Management Suite, Workspace Doctor, and Uniform `_meta`**
  - **Conflict Management Tooling (`emit conflicts` / `sync_conflicts`)**:
    - `list`: Categorizes quarantined files as `⚠️ SYNC CONFLICT` (`.conflict.md`) or `🗑️ DELETED RESCUE` (`.deleted.md`) with companion metadata and sizes.
    - `diff`: Displays unified diff between quarantined copy and canonical article.
    - `resolve`: Supports `--accept-local` (restore quarantined content to canonical) and `--accept-canonical` (safely discard quarantine copy).
    - **Guard G13 (`CANONICAL_HAS_UNPUSHED_EDITS` / `CanonicalHasUnpushedEditsError`)**: Overwriting a canonical article via `accept-local` is strictly blocked if the canonical file contains unpushed local modifications, requiring an explicit `--force` (`force: true`) flag.
    - **Guard G14 (`QUARANTINED_PATH_REQUIRED` / `QuarantinedPathRequiredError`)**: Restricts resolve operations strictly within `<collection>/conflicts/`, preventing arbitrary file unlinks or overwrites.
    - Warnings on restoring rescue files missing valid Crockford ULIDs.
  - **Workspace Doctor (`emit doctor` / `sync_doctor`)**: Comprehensive diagnostic suite checking version compatibility, origin consistency, frontmatter integrity, conflicts/quarantine, baseline sync status, and referenced media disk existence.
  - **Version Tracking**: Added `createdWithVersion` and `lastSyncedVersion` to `.emit/config.json`, updated automatically on sync operations.
  - **Uniform MCP `_meta`**: Every MCP tool response (both success and error) carries uniform metadata containing `profile`, `workspace`, `origin`, and `resolvedBy` rationale.

- **Phase 4: Targeted Media Sync Optimization & Git Best Practices**
  - **Targeted Media Pull (`emit pull-media --article <ULID>` / `sync_pull_media(article: <ULID>)`)**: Downloads only the media assets referenced by a specific article (frontmatter `featuredImage` and body Markdown/HTML images) without syncing the full multi-hundred media library.
  - **Git Media Management Guidance**: Clear recommendations in `README.md` and `.gitignore` on excluding binary images while tracking companion YAML metadata (`media/*.yaml`).
  - **Complete Documentation Harmonization**: Full alignment across `README.md`, `EMIT_MCP_INSTRUCTIONS`, and CLI command help.

### Changed

- **README Authoring Desk & Division of Labor clarification**: Non-Goals are now stated as deliberate design decisions rather than missing capabilities — `postsSyncLimit` can be raised to effectively sync the full article set, the sliding window bounds what stays on disk (not what is reachable via `emit pull <id>`), and a new "Division of Labor with the Official EmDash MCP" section documents that bulk media library management and site-wide operations are intentionally delegated to the official EmDash MCP / Admin Dashboard. A matching FAQ entry ("comprehensive piece referencing my entire back-catalog") was added, and the `--all` note now honestly reflects that `emit pull-media --all` exists while articles deliberately omit it.
- Standardized CLI failure outputs across `emit new`, `emit delete`, and `emit conflicts` to print clean single-line actionable errors with suggestions and exit code 1, rather than dumping raw runtime stack traces.
- Hermetic test isolation: tests stub `fetch` and isolate temporary `HOME` configurations to prevent ambient leakage from developer profiles.

### Known Limitations

- **Orphaned media records are not reported by `emit doctor`**: If a draft media upload succeeded but the subsequent article push failed, Emit keeps the record in `media_state` with `status = 'failed'` for compensation on the next run. A record that never gets retried remains visible only in the local cache and may linger as a `pending` entry in the remote media library; `emit doctor` currently checks referenced-media _disk existence_ but does not yet report these failed/pending `media_state` entries (planned for a future release). Run `emit pull-media` to re-verify library state in the meantime.
- **Article-targeted media pull (`--article`) scans remote Portable Text content with a ULID regex fallback** when no local Markdown body is available, which may collect ULIDs appearing outside body image references; precise AST-based extraction is planned for a future release.

---

## [0.1.9] - 2026-11-04

### Added

- **Sliding Window Staging Desk Model**: Bounded synchronizations defaulting to latest 100 articles (`postsSyncLimit`) per status (`all`, `draft`, `published`).
- **Offline Draft Media Upload Pipeline**: Standalone image references in `media/drafts/*` are automatically uploaded to EmDash R2 storage and rewritten to storageKey-based URLs during `emit push`.
- **Preflight Guards G1–G12**: Enforces strict invariants before writing to remote CMS (ID mismatch check, unintended publish guard, merge conflict marker detection, title autotrim, opaque block verification, etc.).
- **Distributed Mutex Lock**: Distributed 7-minute lease protocol via `POST /_emdash/api/content/{collection}/{id}/lock` to prevent multi-agent write collisions.

### Changed

- Refactored `emit pull` to automatically sync taxonomies (`categories/` and `tags/`) by default alongside articles.

---

## [0.1.8] - 2026-10-31

### Added

- Initial release of `emdash-emit`.
- Local-first synchronization engine for Cloudflare Workers + D1 powered EmDash CMS.
- Multi-site profile management (`emit profile add`, `list`, `use`, `remove`).
- Native SQLite cache database using Node.js built-in `node:sqlite`.
- Initial Model Context Protocol (MCP) server support over stdio.
