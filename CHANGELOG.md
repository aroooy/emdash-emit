# Changelog

All notable changes to the `emdash-emit` (`emit`) project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
