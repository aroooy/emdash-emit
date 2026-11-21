# Changelog

All notable changes to the `emdash-emit` (`emit`) project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.45] - 2026-11-21

### Fixed

- **Media Search Date Boundary Error Code (`src/utils/search-date.ts`, `src/sync/media/remote_index.ts`, `src/sync/media/local_search.ts`, v0.1.45 P1)**:
  - Invalid `--since` / `--until` boundaries in media search previously threw `MEDIA_SEARCH_QUERY_REQUIRED` with a misleading "A non-empty search query is required" suggestion. Centralized date-boundary parsing and `ApiError` construction into `resolveSearchDateBoundaries()` (Layer 0), ensuring all article and media search commands throw `DATE_BOUNDARY_INVALID` consistently.
- **Lenient Frontmatter Repair in Offline Article Search (`src/utils/frontmatter.ts`, `src/sync/article_search/local.ts`, v0.1.45 P4)**:
  - `searchLocalArticles` previously bypassed `lenientRepairMarkdownFrontmatter()` by calling `gray-matter` directly, causing articles with syntax-repairable frontmatter (e.g. unquoted percent-encoded slugs) to be skipped offline while `status` / `doctor` reported them as `healable: true`. Introduced `parseMarkdownLenient()` in Layer 0 and unified all 6 read-only inspection paths (`article_search/local.ts`, `status.ts`, `doctor.ts`, `conflicts.ts` x2, `media/body_scan.ts`), removing `gray-matter` imports outside `utils/frontmatter.ts`.

### Changed

- **Media Search Layering & Presentation Consolidation (`src/sync/media/local_search.ts`, `src/presentation/media_report.ts`, v0.1.45 P2–P3)**:
  - Extracted `searchLocalMirrorMedia()` from `src/sync/media/types.ts` into `src/sync/media/local_search.ts`, restoring `types.ts` to pure type/constant definitions.
  - Moved CLI media-search formatting into `src/presentation/media_report.ts` and unified `[WALK_INCOMPLETE]` wording across CLI and MCP via `formatMediaSearchWalkIncompleteNotice()`, backed by characterization snapshots and presentation symmetry tests.
- **Media Scanner Convergence & Search Fast-Path Extraction (`src/utils/media-refs.ts`, `src/sync/media/body_scan.ts`, `src/sync/article_search/remote.ts`, v0.1.45 P5–P6)**:
  - Removed redundant regex harvests on `scannedRefs` in `collectArticleStorageKeys()`.
  - Consolidated `classifyMediaUrl` and `isInlineCodeSpan` into `scanClassifiedMediaReferences()` in Layer 0 (`src/utils/media-refs.ts`), reducing `scanArticleMediaDetailed()` in `doctor.ts` to a thin wrapper.
  - Extracted `readTaxonomiesFromBaseline()` from `executeScanSearch()` with explicit `BaselineTaxonomyRead` reason codes for discrete precondition unit testing.
- **Shared Search Limit Constants & Workspace Article Iterator (`src/utils/search-options.ts`, `src/sync/workspace/articles.ts`, v0.1.45 P7–P8)**:
  - Centralized `SEARCH_DEFAULT_LIMIT`, `SEARCH_MAX_LIMIT`, and `clampSearchLimit()` in `src/utils/search-options.ts` while preserving existing `maxScan` defaults and public re-exports.
  - Added `iterWorkspaceArticles()` in `src/sync/workspace/articles.ts` (documented in `AGENTS.md` Workspace Contracts) to replace 6 duplicated directory traversal loops across `status`, `doctor`, `conflicts`, `pull_library`, `article_search/local`, and `media/prune_protect`.

## [0.1.44] - 2026-11-21

### Added

- **Media Search Hit-Limit Early Exit (`searchRemoteMedia`, `src/sync/media/remote_index.ts`, v0.1.44 P1)**:
  - Remote media search stops scanning remote pages immediately once `--limit` is satisfied (`hitLimitReached`), saving superfluous HTTP pagination requests.
  - Epistemic completeness is strictly preserved: a hit-limited scan retains `walkComplete: false` and sets `truncated: true`, continuing to output `[WALK_INCOMPLETE]` without asserting negative existence.
  - Symmetrical hit-limit diagnostic notice (`formatMediaSearchHitLimitNotice`) informs CLI users and MCP agents how to broaden the result window (`raise --limit` / `raise limit`).
- **Baseline Fast-Path for Taxonomy Filtering in Article Search (`executeScanSearch`, `src/sync/article_search/remote.ts`, v0.1.44 P2)**:
  - Eliminates N+1 remote GET requests during scan-based article search (`--category` / `--tag`) by reading taxonomy terms directly from local baseline snapshots (`base_snapshots.frontmatter_yaml`) for clean, tracked articles.
  - Strictly guarded by five preconditions: valid cache record, rev-check match via composite comparison key (`extractComparisonRev` extracting version from Base64 transport tokens if omitted in list items), all four pending flags clear (`deletePending`, `bodyConflictPending`, `taxonomyApplyPending`, `taxonomyConflictPending`), and disk content clean (`isLocalFileUnmodified`).
  - Search maintains pure read-only semantics: passing `healOnSpellingMatch: false` ensures spelling variations (e.g. localized media refs) evaluate the fast-path without mutating `sync_state.local_hash` as a side effect.
  - Graceful fallback: unpushed local edits, remote revisions, missing snapshots, or legacy snapshots without recorded taxonomies seamlessly fall back to individual GET requests.
  - Cache hit statistics (`taxonomyCacheHitCount`) are exposed in CLI headers and MCP tool results.
- **Offline Search Guidance for Agents & Users (`formatArticleSearchOfflineHint`, `src/presentation/article_report.ts`, v0.1.44 P3)**:
  - Emits proactive hints when remote article search yields 0 hits or encounters walk truncation, directing agents to instant local Markdown body search (`--offline` / `offline: true`).
  - Shared formatter guarantees unified wording across CLI and MCP, while MCP payloads include structured metadata (`hint.offlineSearch === true`).

## [0.1.43] - 2026-11-21

### Added

- **Multidimensional Past Article Search & Targeting (`emit article-search` / MCP `sync_article_search`, v0.1.43 P1–P4)**:
  - Discover articles outside the default 30-post sync window by keyword, date range (`--since` / `--until` accepting `today`, `yesterday`, or `YYYY-MM-DD`), status, slug, category, or tag, then target the canonical ULID with `emit pull <id>`. The query is optional — run it bare to browse recent articles by recency.
  - Two routes behind one decision rule: the official `GET /_emdash/api/search` FTS endpoint (Primary) when only a query and/or status is supplied, and a bounded client-side list walk (Scan) whenever taxonomy or date filters are involved, because search returns neither taxonomy nor dates. Date filtering needs **zero extra GETs** — the list API already carries `createdAt` / `updatedAt` / `publishedAt` per item.
  - Early-exit on the scan route: the list API is `createdAt` descending, so a `--since` boundary stops the walk and still reports `walkComplete: true`. A short query (under three Unicode characters) that FTS cannot match falls back to the scan route so absence is never misread.
  - Local tracking state (`synced` / `modified` / untracked) is shown per hit, with `--> To edit or pull locally: emit pull <id>` guidance for remote-only hits. Epistemic rule: absence is only proven when `walkComplete: true`; an unfinished walk prints `[WALK_INCOMPLETE]` and may never assert the article does not exist.
  - Full offline search (`--offline` / `offline: true`) scans workspace Markdown bodies with zero network requests, covering local files only — absence in an offline result never proves remote absence.

### Fixed

- **Taxonomy Filters Never Matched Non-ASCII Terms in Article Search (`src/utils/taxonomy-term-match.ts`, `src/sync/article_search/local.ts`, `src/sync/article_search/remote.ts`)**:
  - A workspace stores taxonomy terms as decoded slugs (`カメラレビュー`) while remote assigned terms come back as canonical percent-encoded slugs (`%e3%82%ab...`). Comparing one raw string against the other silently yielded zero matches for every non-ASCII `--tag` / `--category` filter, in both the local and remote search paths.
  - New pure Layer 0 helper `taxonomyTermFilterAliases()` expands a user-supplied filter into every spelling it may legitimately match (raw, decoded, canonical slug, and human-readable name) through the local definitions, and `taxonomyTermMatchesFilter()` compares through those spellings while preserving substring behavior for partial filters. Without local definitions, both raw and decoded forms of the filter are still tried, so ASCII terms and already-decoded frontmatter keep working.
  - Local search also read taxonomy terms from the top-level `fm.categories` / `fm.tags` keys, which the canonical schema never emits — terms live under the frontmatter's `taxonomies:` map. Filters silently matched nothing; both paths now read `fm.taxonomies.categories` / `fm.taxonomies.tags`.
  - Both search paths now share one taxonomy-definition reader: `readTaxonomyAliases()` in `src/sync/article_search/local.ts` delegates to `readTaxonomyDir()` (Layer 1), the repository's single source of truth, replacing duplicated ad-hoc YAML parsing.

## [0.1.42] - 2026-11-21

### Added

- **Date-Range & Recency Media Search (`src/cli/commands/media.ts`, `src/mcp/tools/sync-media-search.ts`, `src/utils/search-date.ts`, v0.1.42 P1)**:
  - `emit media-search` now takes an **optional** query: run it bare to browse the newest assets in the remote library, or narrow the window with `--since <date>` / `--until <date>` accepting `today`, `yesterday`, or `YYYY-MM-DD` (local time). MCP `sync_media_search` gains matching `since` / `until` arguments.
  - The list API is newest-first, so a bounded `--since` boundary stops the walk early and still reports `walkComplete: true` — a date-bounded browse never pays for scanning the whole library, and the completeness claim stays honest.
  - Since/until boundaries are parsed **independently**, so a same-day range (`--since 2026-11-21 --until 2026-11-21`) keeps that day's assets instead of silently resolving to an empty window. An unparseable boundary fails fast with `MEDIA_SEARCH_QUERY_REQUIRED` rather than returning zero hits.
- **Offline Media Search (`--offline` / `offline: true`, v0.1.42 P2)**:
  - Searches only this workspace's media mirrors (`media/` binaries plus their companion YAML and the `media_state` index) with **zero network requests**, so an agent can answer "do we already have this asset?" without touching the origin.
  - Epistemic framing is enforced in output: the header states the result covers local files only, an empty offline result prints an explicit notice, and nothing in the offline path may assert that an asset is absent remotely.

### Changed

- **Media Library Pruning Is Now Default-ON (v0.1.42 P4)**:
  - `emit pull-media` (and MCP `sync_pull_media`) now prune local mirrors whose companion `.yaml` names a media record that no longer exists on remote, **without requiring `--prune`**. Pass `--no-prune` (or `noPrune: true`) to suppress the pass.
  - Pruning stays gated on epistemic completeness: it runs only when the library walk was complete (`remoteIndex.complete`). A walk cut off at `mediaSyncLimit` skips pruning entirely and reports `[PRUNE_SKIPPED]` with the reason, so a partial view can never delete an asset that merely sits outside the window.
  - Reference protection (`src/sync/media/prune_protect.ts`) additionally shields any mirror still named by an article body, a frontmatter `featuredImage`, or a rescue copy under `<collection>/conflicts/`, even when its record is gone from remote.

### Fixed

- **Same-Day Date Boundary Collapse (`src/sync/media/remote_index.ts`)**: `since` and `until` were resolved through a shared branch, so an equal pair produced a null boundary and the browse returned nothing. Each side is now parsed on its own, and the same-day window resolves inclusively.
- **Empty-Query Search Rejected (`src/cli/commands/media.ts`)**: the guard that demanded a query blocked the recency browse; it now only fires when no search criterion at all (query, date range, or offline mode) was supplied.
- **Companion `createdAt` Parsed as a `Date` Object (`src/sync/media/companions.ts`)**: `js-yaml` returns a native `Date` for unquoted ISO scalars, which failed the string type guard and dropped companion dates from search and prune-protection matching. `parseCompanionDate()` now normalizes both `Date` objects and strings.

## [0.1.41] - 2026-11-20

### Added

- **Unterminated Code Fence Diagnostics (`src/client/portable-text.ts`, `src/sync/preflight.ts`, v0.1.41 P2)**:
  - Added pure Layer 0 diagnostic helper `detectCodeFenceIssues()` that detects backtick code fences left open until the end of the article body (`kind: 'unterminated'`).
  - Integrated into Preflight Guards warnings: alerts authors when trailing headings, paragraphs, or images would disappear on EmDash due to an unclosed fence, without blocking the push (`valid: true`).
  - Reporting line numbers track post-preflight body content (after Guard G7 title trim) for exact alignment with the author's editor.
  - Excludes closing fence variations (info strings on close, shorter runs) from false-positive warnings, as CommonMark legitimately treats them as code content, preserving technical articles that document Markdown syntax.
- **Unreferenced Staging Draft Media & Isolated Media Filename Visibility (`src/sync/doctor.ts`, v0.1.41 P3)**:
  - Extended Check 6 (`media_isolated`) in `emit doctor` to inspect `media/drafts/` and report unreferenced draft image files under `details.draftsStaging: { count, files }`.
  - Displays actual unreferenced file names in `check.message` for both `media/` mirrors and `media/drafts/` staging files (up to 3 files plus `and N more`), providing immediate human visibility in the CLI without breaking JSON details in MCP `sync_doctor`.
  - Keeps check status as `ok` to ensure clean workspaces never degrade to `warnings`. Automatic deletion remains strictly prohibited.
- **Epistemic Clarification for Remote Media Coverage (`src/presentation/article_report.ts`, v0.1.41 P3)**:
  - Added distinction note to `[UNREFERENCED_REMOTE_MEDIA]` output clarifying that unreferenced remote keys (referenced by articles but absent from complete remote walk) are distinct from local unreferenced mirrors reported by `media_isolated`.

### Fixed

- **Published Article Draft Staging Notice Gap (`src/sync/push/commit.ts`, v0.1.41 P1)**:
  - Fixed a gap where pushing updates to a live-only published article (`@live:...`) without `--allow-publish` failed to emit the draft staging warning because the check previously evaluated pre-push sync state (`hadRemoteDraft`).
  - Evaluates post-push comparison revision (`Track 2`) via `hasUncommittedDraftRevision()` as the single source of truth: reliably emits `'Changes were staged as a draft on EmDash (live version unchanged). Use --allow-publish to publish live.'` across all successful push paths (clean push, create, and 409 clean 3-way merge PUT retry).
  - Emits `'Existing uncommitted remote draft was overwritten by this push (previous draft revision replaced).'` when an existing uncommitted remote draft was overwritten.
  - Ensures 409 conflict-marker abort paths (`handled: true`) emit no false staging warnings since local modifications were not transmitted.

## [0.1.40] - 2026-11-20

### Added

- **Thematic Break (`---` / `***` / `___`) Bidirectional Conversion (`src/client/portable-text.ts`, v0.1.40 P3)**:
  - Standalone thematic break lines — surrounded by blank lines, or at a block boundary / document start / end — now convert to EmDash's canonical `{ _type: 'break' }` block (confirmed against production EmDash) instead of being stored as a three-character paragraph (`<p>---</p>`).
  - Reverse conversion emits the canonical `---` spelling for plain break blocks, and also serializes legacy `_type: 'divider'` / `_type: 'hr'` blocks to `---` for compatibility.
  - Symmetrical Tier-3 fallback (`isPlainBreakBlock`, Layer 0): a break block carrying extended properties (e.g. `style`, `color`) is preserved verbatim as an opaque comment fence (`<!--ec:block ... -->`) and round-trips exactly, so custom divider metadata can never be silently dropped.
  - Parsing order is fixed deliberately: the thematic-break check runs after code fences and image blocks, before table detection and before paragraph parsing. That ordering prevents `---` from being consumed as a table delimiter row and eliminates the pre-existing bug where `___` was misread as an emphasis mark.
- **Inline Formatting Variants & CommonMark Flanking Compliance (`src/client/portable-text.ts`, v0.1.40 P1)**:
  - `*italic*` and `__bold__` are now recognized as `em` / `strong`, absorbing the notation variance EmDash's server already accepts.
  - Follows CommonMark §6.4/§6.5 flanking delimiter rules asymmetrically, as the spec requires: `_` / `__` cannot open or close emphasis inside a word (fixing the long-standing bug where `foo_bar_baz` italicized `bar`), while `*` / `**` may.
  - Reverse conversion is symmetrical with that asymmetry: an `em` span adjacent to alphanumeric characters renders as `*…*` rather than `_…_`, so intraword emphasis such as `foo*bar*baz` survives a full pull cycle and cannot produce phantom diff3 conflicts during 3-way merge.
- **Autolink Support (`src/client/portable-text.ts`, v0.1.40 P2)**: `<https://example.com>` and `<mailto:user@example.com>` now parse into a `link` markDef plus span instead of degrading to plain text. Reverse conversion normalizes any link whose display text equals its `href` to the single autolink form, guaranteeing identical AST on re-parse.
- **Task List Safety Mapping (`src/client/portable-text.ts:isTaskListItem`, v0.1.40 P4)**: `- [ ] ` / `- [x] ` checkbox syntax is preserved intact through round trips without corrupting list structure. The exported Layer 0 contract helper `isTaskListItem()` is reserved for a future EmDash task-list schema and is intentionally not wired into the current parse pipeline.
- **Setext Heading Diagnostics (Guard G8, v0.1.40 P5)**: `Title\n---` and `Some text\n---\nmore` now raise a warning recommending an ATX heading (`# Heading`), instead of silently storing the underline as a paragraph.

### Fixed

- **Intraword Emphasis Loss (`src/client/portable-text.ts:renderSpans`, v0.1.40 P1)**: parsing `foo*bar*baz` produced an `em` span, but reverse conversion rendered `_`, which the flanking rule then refused to re-parse — dropping the mark and re-spelling an unedited line. This violated the loss-free AST principle and could surface as a divergence on an untouched line in `push/merge_stage.ts`. Reverse conversion now selects the delimiter from the surrounding characters.
- **False-Positive Setext Warning (Guard G8, v0.1.40 P5)**: a blockquote immediately followed by `---` was correctly resolved into a thematic break, yet G8 still warned that the document used an unsupported Setext heading — telling users to rewrite content that already converts correctly. The exclusion set gained `>` and `=` so it tracks the parser's own prose-line rule as closely as a single-character class can.

### Known Limitations

- **Residual G8 Setext false positives (accepted)**: Guard G8 inspects only the first character of a line, while the parser classifies block types, so the two predicates are not identical. `* item\n---\nx`, `+ item\n---\nx` and `1. item\n---\nx` still warn even though the AST is produced correctly; the warning is cosmetic and never blocks a push. Widening the negated character class is deliberately prohibited: excluding `*` or digits would also swallow legitimate Setext headings such as `*emphasized text*\n---` and `2026 was great\n---`. Achieving full agreement would require duplicating a CommonMark block parser, contrary to this release's principle of a lightweight preflight with no external parser. Pinned by `T5-6`, which fails if the class is widened.
- **Source fidelity normalization**: reverse conversion normalizes notation without changing meaning — `*italic*` becomes `_italic_` (except in intraword positions), and `***` / `___` become `---`. This appears on disk only through the full-pull path (`apiResponseToLocal`); push writes the raw Markdown from disk. `hasSpellingTransform` and `retrackLocalHashOnly()` keep re-tracking the hash, so `emit status` still reports `synced` — the author's original notation choice is not preserved, but sync integrity is.
- **Nested emphasis remains out of scope**: `parseInline()` performs a flat regex scan without building an AST tree, so constructs like `*a **b** c*` degrade linearly rather than nesting correctly (documented and pinned by `T1-5`).

## [0.1.39] - 2026-11-19

### Added

- **Bidirectional GFM Table Support for EmDash 1.5 (`src/client/portable-text.ts`, v0.1.39 P5)**:
  - Added native GFM pipe table parser in `markdownToPortableText`, converting Markdown tables into EmDash 1.5 Portable Text table AST (`_type: 'table'`, `hasHeaderRow: true`, `rows: [{ _type: 'tableRow', cells: [{ _type: 'tableCell', isHeader: boolean, textAlign: string, content: PortableTextSpan[], markDefs: MarkDef[] }] }]`).
  - Supports column alignment (`:---`, `:---:`, `---:`) mapped to `textAlign`.
  - Supports inline rich text formatting (bold, italic, inline code, links, strikethrough) within table cells.
  - Symmetrical reverse conversion in `portableTextToMarkdown` with lossless round-trip fidelity.
  - Symmetrical Tier-3 fallback (`isPlainTableBlock`): complex table features not expressible in GFM (such as `colspan`/`rowspan` > 1, custom column widths, multi-paragraph cell contents, or tables without header rows) safely fall back to opaque HTML comment fences (`<!--ec:block ... -->`), protected by Guard G9 (`MODIFIED_OPAQUE_BLOCK`).
  - Removed outdated "Markdown tables are not supported" warning from `detectUnsupportedMarkdownSyntax` (Guard G8).
- **Unreferenced Local Media Diagnostics (`src/sync/doctor.ts`, v0.1.39 P3)**:
  - Added read-only diagnostic check `media_isolated` (Check 6b) in `runWorkspaceDoctor` that reports local companion-backed media files in `media/` not referenced by any article body or frontmatter `featuredImage`.
  - Adheres strictly to epistemic integrity: reported with `status: 'ok'` so healthy workspaces do not flip to warnings, companion-less files are separated as `unattributable`, and no destructive deletion actions are suggested.
- **Git-like Default for Conflicts (`src/cli/commands/conflicts.ts`, v0.1.39 P2)**:
  - Executing bare `emit conflicts` without subcommands now defaults to `list`, matching Git ergonomics (`git status` style). Clean workspaces report `✅ No conflicts or rescue backups found`.

### Changed

- **G3 Publish Guard Suggestion Symmetry (`src/sync/preflight.ts`, v0.1.39 P1)**:
  - Standardized G3 preflight suggestion text to `'To publish the article live, re-run with --allow-publish (or allowPublish: true in MCP). Otherwise, keep status as draft.'`, symmetrical across CLI and MCP.
- **Clarified Offline Draft Media Promotion (`README.md`, MCP `sync_push`, v0.1.39 P4)**:
  - Clarified documentation across README, MCP tool descriptions, and server prompts that uploaded offline draft images (`media/drafts/<file>`) are moved (not copied) into `media/<markdownRef>.<ext>` upon successful push.

## [0.1.38] - 2026-11-19

### Added

- **Profile Resolution Rationale (`src/utils/profile-resolution.ts`, CLI, MCP)**:
  - New Layer 0 helper publishing one shared source for how a profile was chosen (`current directory match`, `origin match`, `explicit --profile`, `only configured profile`, `active default`), consumed by `emit profile current`, the `emit profile list` labels, and MCP `profile_list` (`resolvedBy` / `matchesCwd`).
  - `emit profile list` now separates `(matches current directory)` from `(active default — used only outside registered workspaces)`, removing the long-standing misreading of the old bare `(active)` marker. No resolution order changed: a registered workspace containing the current directory still wins over the `active` fallback, so no manual `profile use` is needed inside a linked workspace.
- **Workspace Link Drift Detection (`src/utils/profile.ts:detectWorkspaceLinkDrift`)**:
  - Detects the case where a profile's registered `workspace` path no longer matches the directory being operated on after a folder move or rename, and reports both paths. Shared by the CLI warning in `resolveContext()` (stderr) and doctor check `workspace_link_consistency` (Check 2b), so the two can never disagree. Comparison goes through `resolveDirectoryForComparison()`, so symlinks (`/var` vs `/private/var`) and trailing slashes do not produce false drift, and a registered path that does not exist yet is not reported as drift.
  - The check is pushed only when a link exists and is stale; an unregistered profile adds no line, keeping a healthy report quiet.
- **Non-Destructive Link Repair (`emit init --profile <name>`)**: re-points a drifted profile's workspace at the current directory and prints `🔗 Re-linked profile ...`. `initWorkspace()` now merges into an existing `.emit/config.json` instead of overwriting it, preserving `defaultCollection`, `defaultLocale`, sync limits, `concurrency`, `localMediaRefs`, unrelated keys written by other code paths, and `createdWithVersion`. The three `resolveInitPlan()` auto-link guards are unchanged.
- **Generated `.emit/.gitignore` (`src/utils/config.ts:ensureEmitGitignore`)**: `emit init` now ships ignore rules for its own machine-local SQLite cache (`cache.db`, `cache.db-wal`, `cache.db-shm`, `cache.db.bak-*`, `mcp_state.json`), so a new workspace never commits the database binary. An existing file is never rewritten or appended to, and nothing outside `.emit/` is ever written — repository-level ignore policy (notably whether `media/` is tracked) stays the user's, per README §6. `initWorkspace()` returns `{ gitignoreCreated }` so the CLI reports what actually happened.
- **Credential Rotation Without Retyping the Profile (`emit profile set-token <name>`)**: replaces only the token, carrying `origin`, `workspace`, `defaultCollection` and `defaultLocale` forward. Input resolves `--token` → `--stdin` → interactive prompt with terminal echo disabled on a TTY; `--stdin` supports keychain piping (`security find-generic-password ... | emit profile set-token <name> --stdin`) and CI without the value ever reaching argv or shell history. The command announces `Replaces the existing token ...` before writing and never prints either value; an unknown name is rejected with one actionable line, and an empty pipe fails instead of silently blanking the credential.
- **Opt-In Auth Validity Probe (`emit doctor --check-auth`, MCP `sync_doctor checkAuth: true`)**: new async `runRemoteAuthCheck()` (Check 2c) sends exactly one authenticated `GET /_emdash/api/content/<collection>?limit=1` and reads only the HTTP status — `2xx` → `ok` naming the auth source, `401`/`403` → `error` with an `emit profile set-token <name>` remediation, any other status or an unreachable origin → `warning`. The article endpoint (the resource Emit actually pushes to) is used deliberately so a posts-only token is never reported as broken. Plain `emit doctor` performs no auth request at all, and the probe introduces no new error code, leaving the guard registry untouched.

### Changed

- **Doctor Check Sequence**: the report's documented order gained `workspace_link_consistency` (2b, inside the synchronous environment group) and `auth_validity` (2c, awaited immediately after it). `runEnvironmentChecks()` remains a pure synchronous function with no HTTP inside; the `await` positions in `runWorkspaceDoctor()` are what fix the sequence, and its docblock now states that logical id order and execution order differ on purpose.
- **Characterization Snapshot Flips (deliberate)**: `tests/v0138_characterization.test.ts` pinned the pre-v0.1.38 behavior first (P0), then recorded exactly three intended changes — `.emit/` now holds `.gitignore`, the profile subcommand set gained `set-token`, and the doctor option set gained `--check-auth`.

### Fixed

- **Flaky Profile Tests on macOS**: drift tests compare through `fs.realpathSync`, mock `os.homedir()` (not only `process.env.HOME`) so an ambient `~/.config/emit/profiles.yaml` cannot decide an outcome, and read `profiles.yaml` before deleting the throwaway `HOME` in cleanup.

## [0.1.37] - 2026-11-18

### Added

- **Sync Limit & Concurrency Precedence Resolver (`src/utils/sync-limit-precedence.ts`)**:
  - Centralized `resolvePostsSyncLimit` / `resolveMediaSyncLimit` / `resolveConcurrency` in a pure Layer 0 helper with exact pre-refactor `||` precedence semantics, replacing 12 scattered fallback chains across CLI `pull`, MCP `sync_pull`, and the Layer 2 orchestrator.
  - Removed the magic number `8` for concurrency in favor of `DEFAULT_CONFIG`.
  - Added `tests/sync_limit_precedence.test.ts` including a static symmetry rail that forbids inline fallback chains from regressing in consumers.

### Changed

- **Guard Registry Source Metadata (`src/sync/guards.ts`)**: Refreshed the stale `source:` line metadata for G12 / G15 / G16 / G17, which pointed at the pre-modularization `src/sync/push.ts`, to their actual emission sites in `src/sync/push/guards.ts` (lines 46, 72, 98, 123).

### Refactored

- **Characterization Snapshot Rails (`tests/cli_pull_snapshot.test.ts`, `tests/doctor_snapshot.test.ts`)**: Added byte-invariance snapshot tests for the CLI batch-pull output and `emit doctor` report as invariance gates to be consumed by the giant-function splits below.
- **`uploadMediaFile` Phase Helpers (`src/client/media.ts`)**: Extracted the four transport phases into focused private helpers — `resolveReusableUpload` (reuse/dedup recovery), `finalizeServerDedupHit` (server dedup short-circuit), `putBinaryStream` (upload-url + binary PUT streaming), and `confirmUpload` (confirm POST plus `media_state`/companion writes) — leaving `uploadMediaFile` as a linear orchestrator over the 4-stage flow. No payload, endpoint, guard, or state-write changes.
- **`runWorkspaceDoctor` Check Groups (`src/sync/doctor.ts`)**: Split the 619-line monolith into three private helpers — `runEnvironmentChecks`, `runContentIntegrityChecks`, and `runMediaIntegrityChecks` — behind a shared read-only `DoctorCheckContext`. DB write authority (`clearConflictsByKind`) remains in the orchestrator via an `afterAutoClear` callback, preserving the exact check sequence and write ordering (snapshot-identical output).
- **CLI Batch Pull Stages (`src/cli/commands/pull.ts`)**: Extracted the batch branch into named stages — `runBatchPull`, `printBatchPullProgress`, `printBatchTaxonomyHint`, `printBatchPullSummary`, and `runBatchIncludeMediaStage` — using a local structural `BatchPullSummary` type so the Layer 2 consumer allowlist stays untouched.
- **Barrel Re-export Convergence (`src/sync/pull.ts`, `src/sync/push.ts`, `src/sync/media.ts`)**: The three thin barrels are now reserved exclusively as the public npm façade re-exported by `src/index.ts`. All 41 repository-internal import sites (Layer 2 `orchestrator`/`doctor`/media stages, Layer 3 CLI/MCP, and 19 test files) were rewired to the implementation entities (`sync/pull/index.js`, `sync/push/index.js`, `sync/media/index.js`). The layering sibling snapshot and the G11 label source check follow the new paths; `ALLOWED_LAYER_2_SYMBOLS` remains unchanged.

## [0.1.36] - 2026-11-16

### Added

- **Preserved Opaque Blocks Diagnostic & Guidance Pipeline (`src/client/portable-text.ts`, `src/presentation/pull_report.ts`)**:
  - Implemented `countPreservedOpaqueBlocks` in Layer 0 (`src/client/portable-text.ts`) with strict code block exclusion via `stripCodeBlocks` to accurately count Tier 3 comment fences (`<!--ec:block ... -->`) without false positives from documentation code samples.
  - Added `preservedBlocks?: number` to `PullResult` (Layer 2) across full pull, differential fast-path skip, healing, and `localEditsPreserved` branches.
  - Implemented pure string formatter `formatPreservedBlocksHint` in Layer 3 (`src/presentation/pull_report.ts`), returning standardized helpful diagnostic hints (`💡 Preserved N styled/custom block(s) (<!--ec:block ... -->) retaining alignment/layout.`) for CLI pull and MCP `sync_pull`.
  - Added unit test suite `tests/pull_report.test.ts` and symmetry tests in `tests/presentation_symmetry.test.ts`.

### Documentation

- **The Dual-Track Image Model & Authoring Rules (`README.md`, `AGENTS.md`)**:
  - Documented the Dual-Track Image Model (Track A: Plain Image Local-First preview vs Track B: Preserved Block Round-trip Fidelity), clarifying the intentional design trade-off between local editor preview and server-side layout attribute protection.
  - Established golden authoring rules for images: always author new images using standard Markdown (`![alt](../../media/drafts/...)`), and manipulate preserved blocks by moving or deleting entire comment lines without manually crafting JSON.
  - Enhanced tool descriptions for MCP `sync_pull`, `sync_push`, and `sync_diff` with explicit preserved block safety guidelines for autonomous AI agents.

## [0.1.35] - 2026-11-16

### Fixed

- **Styled Image Blocks Tier 3 Opaque Fence Protection (`src/client/portable-text.ts`)**:
  - Implemented `isPlainImageBlock` with a strict fail-safe whitelist (`KNOWN_PLAIN_IMAGE_KEYS = {_type, _key, alt, asset}`) and 2-tier inspection (checking top-level block properties and inner `asset` properties).
  - Preserved standard Markdown `![alt](url)` (Tier 1) for plain image blocks and blocks with empty/null attributes (`caption: null`, `title: ''`).
  - Automatically falls back image blocks carrying layout, styling, or custom metadata (e.g. `alignment`, `displayWidth`, `displayHeight`, `caption`, `title`, or extended `asset` properties) to Tier 3 opaque comment fences (`<!--ec:block ... -->`).
  - Guarantees 100% round-trip fidelity between Markdown and Portable Text AST, preventing destructive reset/initialization of server-side image styles on subsequent push.
  - Guard G9 (`MODIFIED_OPAQUE_BLOCK`) automatically protects styled image fences against accidental modification or deletion on disk.
  - Unified test date calculations in `tests/local_media_refs.test.ts` and `tests/push_media_pipeline.test.ts` with `formatDatePrefix` to eliminate timezone mismatch errors across early morning JST runs.

## [0.1.34] - 2026-11-15

### Added

- **Consolidated Pull Presentation Formatters (`src/presentation/pull_report.ts`)**:
  - Created `src/presentation/pull_report.ts` consolidating pull-related reporting into Layer 3: `formatTaxonomySyncFailure`, `formatTaxonomySyncSuccess`, `formatArticleMediaSummary`, `formatPullStatusBreakdown`, and `formatPullWindowLabel`.
  - Added unit and symmetry tests in `tests/presentation_symmetry.test.ts` verifying identical formatting output between direct presentation calls and CLI re-exports, as well as static import alignment across CLI and MCP.

### Changed

- **Unified Taxonomy Sync Failure Notifications**:
  - Replaced divergent taxonomy sync failure warnings across CLI (`src/cli/commands/pull.ts`) and MCP (`src/mcp/tools/sync-pull.ts`) with standardized `formatTaxonomySyncFailure`, eliminating 7 divergent warning patterns and providing consistent diagnostic messages for human users and AI agents.
  - Aligned partial failure semantics in `printTaxonomySyncSummary`: suppressed misleading partial success counts when either categories or tags fail, matching MCP behavior.
  - Maintained 2-block backward-compatible re-exports in `src/cli/commands/pull.ts` (Block 1 from `presentation/article_report.js`, Block 2 from `presentation/pull_report.js`), ensuring zero breakage for existing tests and consumers.
- **Style and Licensing Parity**:
  - Added MIT license headers (SPORT-SERVICE RS★R) across 12 newly introduced modules (`src/sync/media/`, `src/sync/guards.ts`, `src/utils/media-refs.ts`), achieving 100% license coverage across all 105 TypeScript modules.
  - Standardized barrel file comments in `src/sync/media.ts` to align with `pull.ts` and `push.ts`.
  - Reordered presentation imports to the top of `src/cli/commands/pull.ts`.

## [0.1.33] - 2026-11-15

### Added

- **Static Architecture & Quality Gates (Axis 5, Rule 5)**:
  - Enforced Axis 5 non-CLI logging isolation in `tests/layering.test.ts`: strictly prohibits `console.log` and `console.debug` outside `src/cli/` to protect MCP stdio streams.
  - Enforced Rule 5 guard coverage in `tests/guards.test.ts`: verified test assertion coverage across all 20 unique guard error codes across 16 active guards, adding explicit tests for G11, G12, and G17.
  - Integrated `npm run check:cycles` using `madge --circular` into the test and verification pipeline.
- **Governance & Specification Archive**:
  - Created `docs/README.md` as the index and central directory for specifications and refactoring plans.
  - Updated `AGENTS.md` with Axis 5, Rules 1-5, Ask First Policy, and Commit Readiness Checklist.

### Fixed

- **Circular Import Eradication**:
  - Extracted `calculateHash` into `src/sync/workspace/hash.ts`, breaking the `commit.ts` <-> `index.ts` circular dependency.
  - Relocated canonical `MEDIA_FILE_ROUTE_PREFIX` to `src/utils/media-refs.ts`, breaking the `media-body-refs.ts` <-> `media-refs.ts` circular dependency.

## [0.1.32] - 2026-11-15

### Added

- **Batch Pull Taxonomy Orchestration Facade (`src/sync/orchestrator.ts`)**:
  - Encapsulated remote taxonomy synchronization into `orchestrator.ts:pullBatch` (symmetric with `pullSingleArticle`), eliminating consumer-level duplicate calls and try/catch omissions.
  - Provided `onTaxonomySync` callback for CLI progress output while returning full `OrchestratorTaxonomiesResult` with 4 counts.
- **Media Reference Precedence Isolation (`src/utils/media-ref-precedence.ts`)**:
  - Extracted `resolveLocalMediaRefsOption` to Layer 0 pure function (`src/utils/media-ref-precedence.ts`) while keeping persistence CLI-only.

### Fixed

- **Draft Initial Pull Staleness Fix (`src/sync/pull/fast_path.ts`, `src/sync/pull/index.ts`)**:
  - Discarded stale list `rawItem` for untracked drafts when `Boolean(draftRevisionId)` is true, triggering selective single-GET to fetch the canonical draft body.

## [0.1.31] - 2026-11-15

### Added

- **0-GET Pruned Taxonomy Auto-Healing (`src/sync/pull/fast_path.ts`, `src/sync/taxonomies.ts`)**:
  - Automatically reconciles frontmatter taxonomy assignments when categories or tags were deleted on remote EmDash without triggering destructive `--force` pulls or wasting network GET calls.
  - When taxonomy sync is performed at the start of pull, untouched articles (`currentDiskHash === existingSync.localHash`) detect deleted terms and prune them in-place within the fast path (`tryFastPathOrHeal`).
  - Preserves explicit empty arrays (e.g. `tags: []`) when all terms in a taxonomy are deleted, enabling clean remote relation cleanup on subsequent push instead of abandoning orphan `post_terms` relations.
  - Rewrites Layer A baseline snapshot (`bumpBaselineHashOnly: false` with canonicalized slugs and verbatim ULID preservation), eliminating phantom diffs in `emit diff` (`inspectArticleDiff`).
  - Implements the epistemic rule: when taxonomies sync was skipped (`--posts-only`) or failed, auto-pruning is strictly suppressed (`canPruneTaxonomies: false`). Unpushed local edits are 100% protected against auto-pruning.
- **Layer 0 Predicate & Detail Types (`src/utils/taxonomy-key.ts`)**:
  - Added `isKnownTaxonomyTerm`, `TaxonomyLookupMaps`, and `PrunedTaxonomiesDetail` to Layer 0.
  - Accurately checks terms against exact ULID (`idToSlug`), canonical slug, decoded slug, and unique name aliases (`slugToId`), while safely preserving loser ULIDs in slug collisions.
- **Layer 3 Dedicated Notice Formatter (`src/presentation/article_report.ts`)**:
  - Added `formatPrunedTaxonomiesNotice(pruned)` in `src/presentation/article_report.ts`, surfacing clear notifications in CLI (`emit pull`) and MCP (`sync_pull`) identifying exactly which terms were pruned.

### Changed

- **Guard G19 Remote Audit Parity (`src/sync/push/taxonomy_plan.ts`, `src/sync/push/index.ts`)**:
  - Connected `auditRemoteTaxonomies` result (`remoteTaxAudit`) to `syncArticleTaxonomies`.
  - When remote audit confirms remote assignments are already 0 (`remoteCount === 0`, e.g. following remote term deletions), Guard G19 (`DESTRUCTIVE_TAXONOMY_WIPE`) is cleanly bypassed, dispatching `POST /terms/{taxonomy} { termIds: [] }` to clean up remote orphan relations safely without requiring manual `--allow-wipe-taxonomies`.

## [0.1.30] - 2026-11-15

### Added

- **Single-Article Pull Orchestration Facade (`src/sync/orchestrator.ts`)**:
  - Added `pullSingleArticle`, `PullSingleArticleOptions`, and `PullSingleArticleResult` to `src/sync/orchestrator.ts` as the Layer 2 designated coordinator counterpart to `pullBatch`.
  - Consolidates the single-article pipeline (optional taxonomy synchronization, article pull with on-demand media mirroring, and optional full media library sync) into a single reusable entry point shared by CLI (`src/cli/commands/pull.ts`) and MCP (`src/mcp/tools/sync-pull.ts`).
  - Enforces clean architectural layering: returns structured flags (`categoriesFailed`, `tagsFailed`, `error`) without UI strings, leaving presentation formatting to Layer 3. Registered in `ALLOWED_LAYER_2_SYMBOLS['orchestrator']` in `tests/layering.test.ts` with zero intra-layer sibling coupling exceptions.
- **Deterministic Taxonomy Term Deduplication (`src/sync/taxonomies.ts`)**:
  - Extracted and exported `dedupeTermsBySlug` supporting `'slug-grouped'` (categories) and `'frequency'` (tags) modes. Replaced local closure in `getLocalTaxonomiesSummary` and enabled direct unit testing of winner selection and tie-breaking invariants.
- **Robust CLI Explicit Boolean Option Resolution (`src/cli/context.ts`)**:
  - Introduced `resolveExplicitBooleanOption` in `src/cli/context.ts` using Commander's `getOptionValueSource('media') === 'cli'` paired with `getOptionValue('media')`.
  - Accurately differentiates `--media` (`true`), `--no-media` (`false`), and unprovided (`undefined`) without raw `process.argv` scanning, while safely handling Commander's `--no-*` source attribution behavior and argument ordering.

### Changed

- **Media Library Walk Pagination Unification (`src/sync/media/`)**:
  - Exported `fetchMediaListPage` from `src/sync/media/remote_index.ts` and replaced the inline HTTP pagination walk in `src/sync/media/pull_library.ts:pullMedia()`, unifying media list endpoint queries, `MEDIA_LIST_FAILED` error wrapping, and cursor progression across `collectRemoteStorageKeys`, `searchRemoteMedia`, and `pullMedia`.
  - Removed unused imports (`unwrapEnvelope`, `ApiError`, `mediaListEndpoint`) in `src/sync/media/pull_library.ts`, ensuring strict compliance with `noUnusedLocals: true`.

## [0.1.29] - 2026-11-15

### Added

- **Single-Article On-Demand Media Mirroring (`src/sync/pull/media_stage.ts`, `src/sync/pull/index.ts`)**:
  - Automatically discovers and mirrors article-referenced media assets (Markdown body images and frontmatter `featuredImage`) into `media/` during single-article pulls (`emit pull <id>`, `sync_pull`).
  - Immediately resolves **Markdown body image references** to local relative paths (`../../media/<storageKey>.<ext>`) in 1 step without requiring manual `emit pull-media --article <id>` or a subsequent `--force` pull. Scope limit: the disk rewriting applies only to body `![...](/_emdash/api/media/file/<storageKey>)` references. A frontmatter `featuredImage` is mirrored into `media/` as a companion-backed asset, but its frontmatter value always stays the canonical 26-character D1 record ULID — Emit never rewrites it to a local path (see `docs/media-id-spaces.md`).
  - Implements `MediaMirrorSession` with 0-HTTP short-circuit when all referenced assets exist locally (verifying file size and upserting `localContentHash` via `computeFileSha256` and `mediaRecordIdForStem` without guessing stem prefixes).
  - Unifies `featuredImage` resolution: uses D1 `MediaRecordId` single-GET lookup via `/api/media/{id}` in single-article pull **only when the article carries no body images** (Case B — one body image is enough to route the article through the shared library walk, Case A), and the shared `recordsById` map from `RemoteStorageKeyIndex` in batch pull or articles with body images (0 extra GETs). When the walk already completed (`complete === true`) and the id is absent from it, the redundant individual GET is skipped instead of paying for a request that must 404.
  - In-flight deduplication across parallel article pulls prevents duplicate downloads and accurately aggregates session counts. Batch media statistics are session-wide: `downloaded`/`skipped` count each shared storageKey once, not once per referencing article.
- **CLI `emit pull [target]` Target Resolution & Symmetry (`src/cli/commands/pull.ts`, `src/sync/diff.ts`)**:
  - Allows `emit pull [target]` where `target` can be an article ULID or a workspace relative/absolute file path (e.g. `emit pull posts/draft/20261115_<ulid>-title.md`).
  - Added frontmatter `id` disk fallback to `resolveArticleTarget` in `src/sync/diff.ts`.
  - Added clean error reporting for invalid/unresolvable target paths (`ARTICLE_TARGET_UNRESOLVED`) registered in `OPERATIONAL_ERROR_CODES`.
  - Added single-article media sync summary, orphan image warnings, and taxonomy sync warnings.
  - Supported `--media` on single-article pull to trigger library pull, and explicit `--no-media` to skip media mirroring.
- **MCP `sync_pull` Target Symmetry & `noMedia` Support (`src/mcp/tools/sync-pull.ts`)**:
  - Added `noMedia: true` option to `sync_pull` schema to mirror CLI `--no-media`.
  - Added single-article media sync summary reporting and taxonomy failure notes.
- **Fast-Path Relative Media Reference Self-Healing (`src/sync/pull/fast_path.ts`)**:
  - Extended `tryFastPathOrHeal` to detect and heal unmirrored referenced assets even when the article revision is unchanged.
  - Guaranteed `updateConfigSyncedVersion` execution on all fast-path exits.
- **On-Demand Byline Catalog Refresh on Unknown Author ID (`src/sync/pull/index.ts`, `src/sync/bylines.ts`)**:
  - Single-article pull inspects `rawItem` for unknown byline IDs not yet recorded in SQLite cache. If detected, triggers `syncRemoteBylines` to refresh local authors before generating frontmatter.

### Changed

- **1-Pass Batch Media Processing (`src/sync/orchestrator.ts`)**:
  - Replaced the 2-pass disk rewrite loop in `pullBatch` with shared `MediaMirrorSession`, eliminating redundant file reads/writes and saving media state directly during the primary article pull.
  - Injected `loadLocalTaxonomyCandidates` once at batch start, avoiding redundant filesystem traversals across parallel article pulls.
- **Unified `pullArticleMedia` / `pullMedia` on `mirrorReferencedAssetsFromIndex` (`src/sync/media/`)**:
  - Replaced bespoke loops in `pull_article.ts` and `pull_library.ts` with shared `mirrorReferencedAssetsFromIndex`.
- **Safe `filename` Fallbacks (`src/sync/media/naming_mirror.ts`)**:
  - Added safe fallback to `item.storageKey` or `image.jpg` when remote `item.filename` is missing or undefined. The mirror extension now comes from `filename` first and falls back to the storageKey's own extension, so a filename-less record never derives an extension from an inner `.ulid` segment of a multi-ULID key.

### Fixed

- **Byline Staleness Check Accepted Slugs As Well As Ids (`src/sync/pull/index.ts`)**:
  - `getBylineIdToSlug()` fed the byline references found in `rawItem` into `cachedMaps.idToSlug` only. Because a remote item can carry a byline **slug** (or both), a slug always missed the id-keyed map and every pull re-ran `syncRemoteBylines` even when the author was already cached. The check now treats a reference as known when it appears in either `idToSlug` or `slugToId`, so a cached workspace performs zero byline requests per article. Regression test: `tests/sync.test.ts` ("does not trigger on-demand bylines sync when rawItem contains already-cached byline slug or ID").
- **Bounded Library Walks For Referenced-Media Resolution (`src/sync/pull/media_stage.ts`, `src/sync/media/pull_article.ts`, `src/sync/media/pull_library.ts`)**:
  - The shared `MediaMirrorSession` walk, the article-targeted media pull, and the targeted `--storage-key` pull each walked the **entire** remote media library. On a fleet-scale instance that made one article's pull pay for thousands of list requests. All three are now bounded by `mediaSyncLimit` (default 300; unlimited only for an explicit full-library pass), matching how `emit pull-media --all` and `--check-media-library` already behave. A key outside the window is reported as unresolved, never asserted absent, and `complete === false` keeps per-record lookups available.
- **Targeted `pull-media --storage-key` Never Reports Silence As Success (`src/cli/commands/pull.ts`, `src/mcp/tools/sync-pull.ts`)**:
  - When nothing was downloaded but the key was confirmed by local mirror metadata, the command printed a success line for a pull that mirrored nothing (or exited silently). It now reports `ℹ️ Targeted storageKey(s) not downloaded` naming the reason — "confirmed by local mirror metadata already in media/" versus "not found within the bounded library walk" — and keeps the existing exit-1 path only for genuine orphans. MCP mirrors the same wording instead of claiming `✅ Successfully pulled`.

## [0.1.28] - 2026-11-15

### Fixed

- **Order-Independent Unmodified Detection Across All Layer 2 Paths (`src/sync/orchestrator.ts`, `src/sync/conflicts.ts`, `src/sync/pull/{quarantine,fast_path}.ts`)**:
  - Replaced all 5 remaining raw `calculateHash(content) !== syncState.localHash` comparisons in Layer 2 with `isLocalFileUnmodified()` so articles whose disk bytes differ from `sync_state.local_hash` only by media reference spelling (`../../media/<storageKey>` vs `/_emdash/api/media/file/<storageKey>`) or taxonomy comment decoration are never misclassified as having unpushed local edits:
    1. `pullBatch` prune guard (`src/sync/orchestrator.ts`) — prevents false `SyncPruneConflictError` on window-out articles.
    2. `resolveConflict(..., 'accept-local')` & `pruneConflicts` (`src/sync/conflicts.ts`) — prevents false `CanonicalHasUnpushedEditsError`.
    3. `quarantineDivergentLocalCopies` (`src/sync/pull/quarantine.ts`) — prevents false quarantine of unmodified duplicate ULID files.
    4. `handleRemoteDeletedArticle` (`src/sync/pull/quarantine.ts`) — prevents false `deletePending: true` on 404/410 remote deletion.
    5. `tryFastPathOrHeal` (`src/sync/pull/fast_path.ts`) — prevents false `localEditsPreserved: true` when remote revision advances and heals `sync_state.local_hash` once via `retrackLocalHashOnly` on skip, while preserving the raw hash check at the `carriesDepthFreeMediaRef` legacy self-heal branch (`AGENTS.md` §7).
- **`computeContextDiff` `contextLines` Support (`src/sync/diff.ts`)**:
  - Wired `options?.contextLines` (defaulting to `0` to preserve zero-context token efficiency and existing diff output) into `computeContextDiff()`, emitting surrounding context lines (` ${line}`) and adjusted hunk headers (`@@ -start1,len1 +start2,len2 @@`) when `contextLines > 0` is explicitly requested.

### Changed

- **Complete 4-Tier Layering Gate & `mcp-heartbeat` Relocation (`src/utils/mcp-heartbeat.ts`, `tests/layering.test.ts`)**:
  - Moved MCP heartbeat process inspection (`checkMcpProcess`, `touchMcpHeartbeat`, `removeMcpHeartbeat`) to Layer 0 (`src/utils/mcp-heartbeat.ts`, reusing `getPackageVersion` from `src/utils/version.ts`), keeping `src/mcp/heartbeat.ts` as a backward-compatible barrel re-export and eliminating the Layer 2 → Layer 3 import in `src/sync/doctor.ts`.
  - Normalized `src/sync/orchestrator.ts` and 14 test files to import `calculateHash` / workspace contracts from `src/sync/workspace/index.ts`, and `src/sync/doctor.ts` to import `storageKeyFromMediaMeta` from `src/utils/media-companion.ts`.
  - Extended `tests/layering.test.ts` with **Axis 0** (Layer 0 never imports Layer 1/2/3) and **Axis 4** (Layers 0/1/2 never import Layer 3 `cli/`, `mcp/`, `presentation/`).
- **Modular Pull Architecture & Cache Migration Separation (`src/sync/pull/`, `src/db/migrations.ts`)**:
  - Split `src/sync/pull.ts` (1,163 lines) into 5 focused modules under `src/sync/pull/` (`types.ts`, `list.ts`, `quarantine.ts`, `fast_path.ts`, `index.ts`) using `FastPathContext` to eliminate closure capture, while keeping `src/sync/pull.ts` as a barrel re-export.
  - Extracted SQLite schema initialization and versioned migrations (`runCacheMigrations`, `CURRENT_CACHE_SCHEMA_VERSION`) from `src/db/cache.ts` into `src/db/migrations.ts`.
- **CLI `pull` / `push` Failure Presentation & Deduplication (`src/cli/report-failure.ts`, `src/cli/context.ts`, `src/cli/commands/{pull,push}.ts`)**:
  - Extended `reportActionFailure` to format `PushValidationError`, `SyncPruneConflictError`, and `FrontmatterParseError`, and unified all catch blocks in `pull.ts` and `push.ts`.
  - Extracted `resolveAndPersistLocalMediaRefs()` in `src/cli/context.ts`, `printTaxonomySyncSummary()` in `src/cli/commands/pull.ts`, and `printPushArticleDetails()` in `src/cli/commands/push.ts`.
- **Zero Unused Locals Gate (`tsconfig.json`)**:
  - Removed all unused imports, variables, and internal function parameters across `src/` and `tests/`, and enabled `"noUnusedLocals": true` in `tsconfig.json`.

## [0.1.27] - 2026-11-15

### Fixed

- **Order-Independent Baseline Reconstruction & Diagnostic Alignment (`src/sync/baseline-reconstruction.ts`, `src/sync/diff.ts`, `src/sync/doctor.ts`, `src/sync/delete.ts`)**:
  - Fixed a self-contradiction bug in `inspectArticleDiff` (`src/sync/diff.ts`) where calling `emit diff` / `sync_diff` _before_ `emit status` on an untouched article with localized media references returned `status: 'modified'` (`Status: 🟡 Modified`) despite `diff.hasChanges === false` (`No changes detected.`).
  - Unified `isLocalFileUnmodified()` across `status.ts`, `diff.ts`, `doctor.ts`, and `delete.ts` so spelling-only differences between `sync_state.local_hash` and disk bytes are recognized and healed regardless of which command runs first.
- **Unified CLI Failure Presentation Without Double Prefixing (`src/cli/report-failure.ts`)**:
  - Consolidated 5 duplicate `reportActionFailure` implementations (`delete`, `new`, `conflicts`, `doctor`, `media`) into `src/cli/report-failure.ts`.
  - Fixed missing `❌ Error:` prefix on generic errors in `emit delete` and `emit new` while preventing double `❌ Error: ❌ ...` prefixes on pre-formatted errors (`DuplicateSlugError`, `UnpushedModificationsError`, `PublishedArticleDeletionForbiddenError`).

### Changed

- **Sync-State-Only Hash Retracking (`retrackLocalHashOnly` in `src/db/baseline.ts`)**:
  - Centralized hash-only re-tracking (updating `sync_state.local_hash` when disk spelling changes without touching `base_snapshots`) into Layer 0 (`src/db/baseline.ts`), replacing 3 independent `saveSyncState` call sites in `status.ts`, `orchestrator.ts`, and `pull.ts`.
- **Taxonomy Consolidation (`src/sync/taxonomies.ts`, `src/utils/taxonomy-key.ts`)**:
  - Consolidated category and tag save/prune loops in `pullTaxonomies()` into `writeAndPruneTaxonomyDir()`.
  - Unified deterministic collision winner ordering (`count desc → ULID desc`) into `compareTaxonomyTermDeterministically()`, guaranteeing 100% winner parity between Layer A (`loadLocalTaxonomyMaps`) and Layer B (`getLocalTaxonomiesSummary`).
  - Extracted taxonomy key normalization helpers (`normalizeTaxonomyKey`, `isPercentEncodedTerm`, `canonicalSlugOf`, `aliasesOf`) into Layer 0 (`src/utils/taxonomy-key.ts`).
- **MCP Tool Context & Preflight Local Image Probe (`src/mcp/tool-errors.ts`, `src/sync/preflight/image_probe.ts`)**:
  - Added `withResolvedContext()` and `formatToolTextWithMeta()` in `src/mcp/tool-errors.ts` to standardize context error handling and `_meta` suffix formatting across MCP tools.
  - Extracted local draft image probing (`probeLocalImageFile`) into `src/sync/preflight/image_probe.ts` while preserving guard-specific remediation messages for G5, G10, and G11.

## [0.1.26] - 2026-11-15

### Added

- **Two-Layer Representation for Taxonomy YAML Definitions (`src/sync/taxonomies.ts`)**:
  - Extended Two-Layer Representation from article frontmatter (`taxonomies:`) to category and tag YAML definition files (`categories/*.yaml`, `tags/*.yaml`).
  - Disk format (Layer B) presents human-readable decoded slugs (`slug: ローカルガイド`) while preserving the raw server slug in `canonicalSlug: "%e3%83%ad..."` (omitted for standard ASCII terms where `canonicalSlug === slug`).
  - Added safe YAML scalar serialization (`serializeTaxonomyYaml`) using `formatYamlScalar`:
    - Guarantees single-line output, completely eliminating multi-line folded blocks (`slug: >-`) previously triggered by long percent-encoded strings in js-yaml.
    - Reliably quotes YAML reserved words (`on`, `true`), numeric strings (`2026-review`), and symbols (`買い物(レビュー)`), preventing unintended type coercion during round-trip parsing.
  - Added backward-compatible loading in `readTaxonomyDir()`: seamlessly loads legacy v0.1.25 files (`slug: '%e3...'` without `canonicalSlug`) and transparently decodes them in memory until refreshed on next pull.
  - Implemented 2-Phase Collision Resolution in `loadLocalTaxonomyMaps()`:
    - **Phase 1 (Canonical Registration)**: Registers all canonical slugs first (`idToSlug[item.id]` strictly returns canonical slug for Layer A transport, baseline snapshots, and hash calculations; ties broken deterministically by count desc, then ULID desc).
    - **Phase 2 (Alias Registration)**: Registers decoded slugs and display names only when they do not collide with any canonical slug and uniquely map to a single term ID. Preserves loser terms' unique name aliases while avoiding alias poisoning.
    - Dropped collision losers from Layer B presentations (`getLocalTaxonomiesSummary()`, `formatTaxonomiesHint()`) via `dedupeBySlug`, presenting clean winner candidates in AI prompts and CLI outputs.

## [0.1.25] - 2026-11-14

### Added

- **Frontmatter Draft Revision Visualization (`status: published # draft revision`)**:
  - Implemented explicit, human-readable draft revision annotation on the `status:` frontmatter line when a published article tracks an uncommitted remote draft revision.
  - File inspectors, text editors (VS Code, Obsidian, Cursor), and AI agents can immediately recognize that the file reflects an uncommitted draft revision without needing to query CLI `emit status`.
  - Maintained 100% YAML 1.1/1.2 parser transparency: inline comments are ignored by `gray-matter` and `FrontmatterSchema` (Zod), preserving `status: 'published'` without altering AST or schema contracts.
  - Automatically maintained across lifecycles: added on pull when `draftRevisionId` is present, maintained when staging drafts via push, and automatically removed when published live (when the remote publish response reports no remaining draft revision) or discarded.
- **Single Source of Truth Helper (`src/utils/draft-revision.ts`)**:
  - Centralized `hasUncommittedDraftRevision(syncState)` in Layer 0. All disk representation, baseline reconstruction, diagnostics, and warnings derive strictly from `sync_state.remote_rev.includes('@draft:')` when status is published, eliminating guesswork from CLI arguments or partial local state.
- **Unified 3-Axis Disk Spelling Engine (`src/utils/disk-spelling.ts`)**:
  - Centralized `resolveDiskSpelling()` and `renderForDisk()` in Layer 0, unifying all 3 disk representation dimensions (taxonomy percent-encoding, article-relative media references, and draft revision annotation) into a single resolver shared by pull, commit, diff, and status.

### Changed

- **Phase 0 Refactoring: Centralized Article Snapshot Commit (`src/sync/workspace/commit.ts`)**:
  - Eliminated dangerous code duplication across 6 distinct snapshot and disk writing locations (`pull.ts` fast-path heals ×3, full pull, `push/commit.ts`, and `push/merge_stage.ts`).
  - Centralized all snapshot writes into `commitArticleSnapshot()`, structurally guaranteeing the 4 synchronization invariants:
    1. `localHash === calculateHash(diskContent)` (strict disk byte tracking)
    2. `baseline.hash === calculateHash(canonicalContent)` (canonical baseline tracking)
    3. `frontmatter` in base snapshots stores remote-derived Layer A values only (no synthetic noise)
    4. `revForTransport` (Track 1) and `revForComparison` (Track 2) remain strictly separated.
  - Eliminated phantom diffs and baseline desynchronization across all standard pull, heal, and status inspection paths.

---

## [0.1.24] - 2026-11-14

### Added

- **Draft Revision Synchronization for Published Articles (`src/sync/pull.ts`)**:
  - Supported EmDash's architecture where published articles (`status: 'published'`) can hold uncommitted/staged draft revisions (`draftRevisionId`).
  - Generalized single GET fallthrough condition from `itemStatus !== 'published'` to `needsFullDraftFetch = isDraft || hasDraftRevision`:
    - **Published articles with draft revisions (`draftRevisionId` present)**: Discards the stale list `rawItem` (which only contains published `liveData`) and executes a single GET (`GET /posts/{id}`) to fetch the full 10-block draft body into `posts/published/<file>.md`.
    - **Clean published articles (`draftRevisionId === null`)**: Completely maintains the zero-overhead fast-path with **zero extra HTTP requests (0-GET)**.
- **Unpublished Draft Status Visualization (`src/sync/status.ts`, `src/cli/commands/status.ts`, MCP `sync_status`)**:
  - Added `hasUnpublishedDraft?: boolean` to `ArticleStatusItem`.
  - Automatically flags published articles whose remote revision tracks an uncommitted draft (`@draft:` in `sync_state.remote_rev`).
  - CLI `emit status` clearly highlights them with a purple icon and badge: `🟣 [synced  ] published*  posts/published/...  [has unpublished draft]`.
  - MCP `sync_status` transparently exposes `hasUnpublishedDraft: true` in JSON payloads.
- **Push Semantics Documentation & Safety Rails for Published Drafts**:
  - Documented push semantics: EmDash stages PUT updates as drafts when `status` is omitted (Emit's default). To publish changes live to web, `--allow-publish` must be explicitly passed.
  - Added contextual safety warnings during push (`src/sync/push/commit.ts`): when pushing published articles that carry remote draft revisions (`hadRemoteDraft`), Emit warns if changes were staged as drafts (without `--allow-publish`) or published live to web (with `--allow-publish`). Clean published articles remain warning-free.
  - Verified and tested that unpushed local edits during draft advancement are safely preserved in `posts/conflicts/*.conflict.md` with `body_conflict_pending = 1` and Guard G12 rescue copy protection.

## [0.1.23] - 2026-11-14

### Added

- **Selective Single-Article GET Fallthrough for Updated Drafts (`src/sync/pull.ts`)**:
  - Resolved architectural discrepancy where EmDash's list API (`GET /posts?status=draft`) returns stale creation-time `posts.data` while the latest content resides in the `revisions` table, which previously caused `emit pull` to overwrite local draft files with outdated content and mark them up-to-date.
  - Implemented selective fallthrough in `pullArticle`:
    - **Draft articles with advanced remote revisions**: Automatically discards the incomplete list `rawItem` and fetches the full canonical article via single GET (`articleContentEndpoint`), accurately reflecting added blocks, images, and edits.
    - **Published articles**: Fully preserves the zero-overhead fast-path—uses the list `rawItem` directly without extra single GET requests, maintaining byte-identical consistency and zero additional network calls.
    - **Fail-safe fallback**: Any article with missing or undefined status defaults safely to `'draft'`, ensuring single GET retrieval rather than writing incomplete content.
  - Hardened unpushed edit protection: Divergent local copies continue to be safely quarantined under `posts/conflicts/*.conflict.md` with `body_conflict_pending = 1` and Guard G12 push protection across both draft and published states.

## [0.1.22] - 2026-11-14

### Added

- **Two-Track Revision Architecture & Draft Revision Advancement Detection**:
  - Solved EmDash server architecture nuance where draft saves update `draftRevisionId` (ULID) while keeping `posts.version` and `posts.updatedAt` unchanged, which previously caused `emit pull` fast-path to falsely report `already up-to-date`.
  - Implemented **Two-Track Revision Invariant**:
    - **Track 1 (`revForTransport`)**: Preserves verbatim server revision tokens (Base64 string like `3:2026-11-14T...`) in `base_snapshots.rev` and `entries.rev`. Prioritized in `push/index.ts:136` for REST PUT `{ _rev }` requests, strictly preventing synthetic key contamination and HTTP 409 conflict loops.
    - **Track 2 (`revForComparison`)**: Stores composite revision identifiers (`${version}@draft:${draftRevisionId}` or `${version}@live:${liveRevisionId}`) in `sync_state.remote_rev` across all 4 save paths (`pull.ts` full pull, `pull.ts` fast-path heal branches, `push/commit.ts`, and `push/merge_stage.ts`).
  - Added `extractComparisonRev` (`src/client/api.ts`): Field-first composite key generator prioritizing explicit revision ULIDs (`draftRevisionId` -> `liveRevisionId`) with clean version fallback.
  - Added `isSameRev` (`src/client/api.ts`): Strict multi-stage revision comparator supporting exact matches, composite key comparisons, legacy-to-composite cache migration, and Base64 round-trip verification.
  - Added `formatRevForDisplay` (`src/client/api.ts`): Clean presentation formatter for CLI/MCP outputs, displaying only the clean version number (e.g. `rev: 3`) while hiding internal `@draft:...` tracking details in `status.ts` and `diff.ts`.
  - Added `CacheDatabase.runTransaction<T>` (`src/db/cache.ts`): Safe transaction helper wrapping `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` for multi-step SQLite operations.
  - Added Unicode NFC normalization to `tryDecodeTaxonomyTerm` (`src/utils/frontmatter.ts`), guaranteeing consistent string comparisons regardless of OS file system encoding (NFD vs NFC).
  - Extended `transitionContentStatus` (`src/sync/push/transport.ts`) to return `StatusTransitionResult { rev, rawJson }`, ensuring post-publish/unpublish commit updates Track 2 with remote status and revision ULIDs accurately.
  - Full production workspace verification: achieved 100% idempotency (`0 updated, 60 skipped/up-to-date`) on successive `pull` runs and verified clean create, update, and delete push lifecycles.

## [0.1.21] - 2026-11-14

### Added

- **Frontmatter Taxonomy Japanese Decoded Display & Two-Layer Representation**:
  - Implemented human-readable Japanese decoded display (`    - 未分類`, `    - カメラ`) in Markdown frontmatter `taxonomies:` by default instead of percent-encoded slugs (`    - "%e6%9c%aa%e5%88%86%e9%a1%9e"`).
  - Established strict Two-Layer Representation Invariant:
    - **Layer A (Internal Data Layer)**: Remote API payloads, `computeTaxonomyHash`, and SQLite baseline snapshots (`base_snapshots.frontmatter_yaml`) strictly preserve canonical percent-encoded slugs, preventing hash divergence, 409 conflicts, and Guard G16 triggers.
    - **Layer B (Presentation & Serialization Layer)**: Disk Markdown files (`serializeMarkdown`, `formatFrontmatterYaml`) and hint formatters (`formatTaxonomiesHint`) render decoded terms using safe unquoted CJK scalars or auto-quoted YAML strings via `formatYamlScalar`.
  - Added Phantom Diff Prevention: `isBaselineSpellingMatch` (`src/sync/status.ts`) and `inspectArticleDiff` (`src/sync/diff.ts`) detect percent-encoded disk content via `carriesPercentEncodedTaxonomy` and selectively serialize baseline markdown with matching encoding (`preferEncodedTaxonomy`), ensuring untouched files never report spurious `modified` status.
  - Implemented Self-Healing on Pull (`src/sync/pull.ts`):
    - **Branch 1 (Valid frontmatter)**: Upgrades percent-encoded taxonomy terms to decoded format in-place on disk and bumps baseline snapshot hash atomically without remote refetching.
    - **Branch 2 (Broken/unquoted legacy syntax)**: Leniently repairs invalid frontmatter via `lenientRepairMarkdownFrontmatter` -> `parseMarkdown` -> `serializeMarkdown` to clean decoded YAML and synchronizes baseline snapshot atomically.
    - **Branch 3 (Unpushed local modifications)**: Preserves local edits intact without touching disk.
    - Achieves complete idempotency: subsequent pull runs are zero-overhead no-ops (`0 updated, N skipped/up-to-date`).
  - Added NFC Unicode normalization for taxonomy alias resolution in `loadLocalTaxonomyMaps` and `createArticleScaffold`, accepting raw Japanese terms (`-C 未分類 -T カメラレビュー`) seamlessly without spurious warnings.
  - Dual-indexed candidates in `loadLocalTaxonomyCandidates` and refined human-readable name comments in frontmatter YAML (`# 日本語名`), automatically omitting redundant comments when term equals display name.

## [0.1.20] - 2026-11-14

### Added

- **One-shot Article Scaffolding via Extended Arguments (`sync_new` & `emit new`)**:
  - Extended `createArticleScaffold` (`src/sync/new.ts`), CLI `emit new` (`src/cli/commands/new.ts`), and MCP `sync_new` (`src/mcp/tools/sync-new.ts`) with `-C, --categories`, `-T, --tags`, `-d, --description`, and `-f, --featured-image` arguments.
  - Implemented centralized input normalization (`normalizeStringList`) supporting both array and comma-separated string inputs with whitespace trimming across MCP and CLI layers.
  - Added uppercase Crockford Base32 normalization for 26-character ULID `featuredImage` values prior to disk write, keeping disk frontmatter immediately canonical.
  - Added epistemic validation for taxonomy arguments: checks local `categories/` and `tags/` definitions when present and surfaces non-blocking warnings via `CreateArticleResult.warnings` without halting draft scaffolding.
  - Enhanced CLI and MCP outputs with structured `Assigned: ...` confirmation line, separating assigned values, taxonomy warnings, and available hint summaries.
  - Eliminates the error-prone post-creation Frontmatter manual editing step for AI agents and human authors.

## [0.1.19] - 2026-11-14

### Added

- **Local-First Featured Image Auto-Upload & ID Resolution (Guard G10 Extension)**:
  - Allowed direct local image paths (`../../media/drafts/<filename>` or already-promoted `../../media/<filename>`) in frontmatter `featuredImage`.
  - During `emit push` / `sync_push`, local draft featured images are automatically uploaded via EmDash Media API (`upload-url` → `PUT` → `confirm`) and resolved to their canonical 26-character D1 `mediaId` (ULID) in the remote push payload.
  - On push completion, frontmatter `featuredImage` on disk and in baseline snapshots is committed as the canonical media record ULID, maintaining byte-identical baseline synchronization.
  - Implemented shared upload pool deduplication: referencing the identical image in both article body and `featuredImage` executes binary upload and file promotion exactly once without duplicating remote assets or triggering filesystem collisions.
  - Added two-stage lookup for already-promoted mirrors (supporting both stem-based and direct `storageKey` filename references) and suppressed spurious companion verification warnings for newly uploaded assets.
  - Guarded against 409 conflict: 3-way merge strictly honors scalar conflict rules (Remote takes precedence with warning log), keeping baseline snapshots and disk state fully aligned (note: auto-uploaded draft images remain promoted in local media mirror and tracked in `media_state` for future doctor/media cleanups).

## [0.1.18] - 2026-11-13

### Added

- **4-Tier Architectural Layering & Invariant Gates (`tests/layering.test.ts`)**:
  - Formally established 4-tier layer isolation: Layer 0 (Primitives & Infra), Layer 1 (Sync Upstream), Layer 2 (Sync Downstream), and Layer 3 (Consumers & Presentation).
  - Mechanically verified via Vitest:
    - Axis 1: Layer 1 files never import Layer 2 modules.
    - Axis 2: Layer 3 imports only allowed Layer 2 public symbols from an explicit allowlist snapshot.
    - Axis 3: MCP tools (`src/mcp/`) never import from CLI command modules (`src/cli/commands/`).
    - Layer 2 Sibling Coupling Gate: Layer 2 downstream modules never import from sibling modules except via a minimal, explicit coordinator snapshot (`orchestrator`, `doctor`, `push/media_stage`).
- **Unified Presentation Layer (`src/presentation/article_report.ts`)**:
  - Unified report formatters (`formatOrphanMediaWarning`, `formatMediaCoverageLine`, `formatArticleDiffReport`), ensuring CLI and MCP produce symmetric vocabulary and identical warning outputs.
  - Added actionable `remediationFor(code)` in `src/sync/guards.ts` covering G1–G19 without adding new error codes.
- **Branded Media ID Spaces & Strict Type Safety (`src/utils/media-id.ts`)**:
  - Formally separated D1 record IDs (`MediaRecordId`) and R2 object keys (`StorageKey`) at the TypeScript type level.
  - Added strict runtime validators `toMediaRecordId()` and `toStorageKey()`, validating extensions, paths, and Crockford Base32 syntax across supply boundaries.
  - Centralized all REST endpoint URL builders in `src/client/endpoints.ts` with byte-identical regression tests in `tests/api.test.ts`.

### Refactored

- **Modular Push Pipeline Deconstruction (`src/sync/push/`)**:
  - Decomposed `pushArticle` from a monolithic module into 9 focused pipeline stages: `types.ts`, `guards.ts`, `preflight_stage.ts`, `taxonomy_plan.ts`, `media_stage.ts`, `tax_audit.ts`, `transport.ts`, `merge_stage.ts`, `commit.ts`, coordinated by `index.ts`.
  - Unified post-push commit processing via `pendingFlagsFor` (`PendingFlagsResult`), strictly guaranteeing symmetry and NULL rules across create, update, and conflict paths.
  - Eliminated synthetic responses in taxonomy divergence audit.
  - Established T2-1 regression lock guaranteeing preflight conflict markers check (G6) evaluates strictly before taxonomy conflict pending check (G16).
- **Workspace Contracts & Media Refactoring**:
  - Centralized filesystem mutations and hash contracts into `src/sync/workspace/index.ts`.
  - Moved companion metadata parsing to `src/utils/media-companion.ts` (Layer 0), eliminating `./media.js` import from `preflight.ts`.
  - Moved body scanning (`scanArticleMediaReferences`, `carriesDepthFreeMediaRef`, `shouldPreferLegacyRef`) to `src/utils/media-body-refs.ts` (Layer 0), eliminating sibling coupling between `delete.ts` and `media/body_scan.ts`.
  - Consolidated Crockford Base32 ULID regexes and validation into `src/utils/ulid.ts` (30 call sites aggregated, `extractFilenameUlid` separated).

## [0.1.17] - 2026-11-12

### Fixed

- **Draft image localization on push (`localMediaRefs: true`)**:
  - A draft image auto-uploaded from `media/drafts/` during `emit push` / `sync_push` now lands on disk as an article-relative mirror reference (`../../media/<storageKey>`) instead of a canonical remote URL. Promotion of the uploaded file into `media/` (P6) was running _after_ the body localization pass, and `localizeArticleMediaRefs` only rewrites a reference whose storageKey already has a real mirror under `media/`, so a freshly uploaded image stayed spelled as `/_emdash/api/media/file/<storageKey>` on disk until the next pull.
  - The fix relocates promotion to just after the remote POST/PUT (and its conflict handling) and before localization, on both the create and update paths. Promotion still never runs when the remote article write fails or a 3-way merge aborts the push, so the compensation window stays intact: the draft image remains staged under `media/drafts/`, the article file keeps its original draft-path reference, and `media_state` keeps `status: 'uploaded'` for the next run.

### Removed

- **Zero-Communication Article Scaffolding (`emit new` / `sync_new`)**:
  - Removed `checkRemoteDuplicateSlug` network calls during `emit new` and MCP `sync_new`. Article scaffolding is now 100% local-first and zero-communication (0ms instant response even when offline or in airplane mode).
  - Remote slug collision detection is deferred to `emit push` / `sync_push`. Guard G18 (`DUPLICATE_SLUG_CONFLICT`) now operates strictly against local files and indexed `cache.db` entries.

### Changed

- **Remote Slug Conflict Guidance on Push**:
  - When creating a new article via `emit push`, if remote EmDash returns `422 Unprocessable Entity` with `SLUG_CONFLICT` (or `details.slug`), `PUSH_CREATE_FAILED` now provides a targeted suggestion guiding the user or AI agent to change the `slug` in frontmatter and re-run push (leveraging Emit's automatic file renaming and cache tracking).
  - Detection stays strictly code-first: an explicit code that names another failure (`VALIDATION_ERROR`, `ENTRY_LOCKED`, `FORBIDDEN`, ...) keeps the generic suggestion, and a body-less `409` on create is reported as contention rather than a taken slug. Message-text matching is consulted only when the server sends no structured code at all, which covers EmDash builds that predate `SLUG_CONFLICT`.
  - Note: EmDash enforces slug uniqueness on `(slug, locale)` including trashed entries, so a slug freed by moving an entry to Trash stays reserved; the guidance names that case explicitly.

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
