# Changelog

All notable changes to the `emdash-emit` (`emit`) project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **Orphaned media records are not reported by `emit doctor`**: If a draft media upload succeeded but the subsequent article push failed, Emit keeps the record in `media_state` with `status = 'failed'` for compensation on the next run. A record that never gets retried remains visible only in the local cache and may linger as a `pending` entry in the remote media library; `emit doctor` currently checks referenced-media *disk existence* but does not yet report these failed/pending `media_state` entries (planned for a future release). Run `emit pull-media` to re-verify library state in the meantime.
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
