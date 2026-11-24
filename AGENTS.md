# AGENTS.md - Emit Development & AI Agent Operation Guide

This document defines the **official architectural invariants, development governance, and content authoring workflow (The Golden Path)** for AI agents (Antigravity, Claude Code, Cursor) and human developers working in this repository.

---

## 1. Project Overview & Authoritative Specifications

- **Project Name**: `emdash-emit` (CLI / MCP Command: `emit`)
- **Target CMS**: **EmDash (Cloudflare Workers + D1 + R2)**
- **Purpose**: AI-first local authoring workspace ("Staging Desk") and bidirectional sync tool with loss-free Portable Text AST conversion, two-layer human/canonical representation, and Git-like Hybrid 3-Way Merge.
- **Tech Stack**: TypeScript 7.x (Node.js >= 22.0.0), Vitest, Prettier (`printWidth: 100`, `singleQuote: true`, `trailingComma: all`), built-in `node:sqlite` (`DatabaseSync` / zero native dependencies), `ulidx`, `node-diff3`.

### Authoritative Domain Specifications (`docs/`)

Before modifying any subsystem or debugging domain behavior, consult the corresponding specification in `docs/`:

| Domain / Subsystem | Authoritative Specification | When to Read |
| --- | --- | --- |
| **4-Tier Architecture, Layering, Auth/Origin & SQLite Schema** | **[docs/architecture-and-layers.md](docs/architecture-and-layers.md)** | Touching module imports, Workspace Contracts (`src/sync/workspace/`), profile/auth/origin resolution, `cache.db` tables, or CLI/MCP presentation & error handlers. |
| **Pull/Push Pipelines, Two-Track Revisions & 3-Way Merge** | **[docs/sync-engine-and-revisions.md](docs/sync-engine-and-revisions.md)** | Modifying `orchestrator.ts`, `src/sync/pull/*`, `src/sync/push/*`, `_rev` / `draftRevisionId` tracking, distributed locks, 3-way merge, or `posts/conflicts/` quarantine. |
| **Markdown, Frontmatter, YAML Quoting & Portable Text AST** | **[docs/markdown-and-ast.md](docs/markdown-and-ast.md)** | Modifying `FrontmatterSchema`, `parseMarkdownLenient`, `formatYamlScalar`, baseline reconstruction, Portable Text conversion, or `<!--ec:block ... -->` Tier 3 fences. |
| **Two Media Identifier Spaces (`id` vs `storageKey`)** | **[docs/media-id-spaces.md](docs/media-id-spaces.md)** | **Mandatory reading before debugging any missing or 404 image.** Defines D1 record `id` vs R2 `storageKey`, endpoint matrices, and migrated-corpus behavior. |
| **Local-First Media Pipeline, Mirror Naming & Pruning** | **[docs/media-pipeline.md](docs/media-pipeline.md)** | Modifying `src/sync/media/*`, `media/drafts/` auto-upload & promotion, `localMediaRefs` relative path rewriting, `storageKeyToMarkdownRef` naming, or media pruning. |
| **Taxonomies (Two-Layer Representation) & Bylines** | **[docs/taxonomies-and-bylines.md](docs/taxonomies-and-bylines.md)** | Modifying category/tag sync, percent-encoded (Layer A) vs decoded CJK (Layer B) slugs, collision resolution, 0-GET deleted term auto-healing, or remote taxonomy audit. |
| **Safety Guardrails (G1–G20), Doctor, Search & FAQ** | **[docs/safety-guards-and-diagnostics.md](docs/safety-guards-and-diagnostics.md)** | Modifying `GUARD_REGISTRY` (`src/sync/guards.ts`), `emit doctor` checks, or `article-search` / `media-search` (`snapshotStatus` / `--live` FTS). |
| **CLI Commands & MCP Tools Complete Reference** | **[docs/cli-and-mcp-reference.md](docs/cli-and-mcp-reference.md)** | Inspecting or updating CLI flags (19 top-level commands + 10 subcommands) or MCP tool schemas (17 tools). |

---

## 2. Architectural Layering & Dependency Invariants

The codebase strictly enforces a 4-tier unidirectional architecture verified by `tests/layering.test.ts`:

| Layer | Responsibility & Modules | Allowed Outbound Imports | Allowed Inbound Consumers | Prohibited Imports |
| --- | --- | --- | --- | --- |
| **Layer 0: Primitives & Infra** | `src/utils/`, `src/db/`, `src/client/` — Core types, SQLite cache (`cache.db`, migrations, `retrackLocalHashOnly`), HTTP/auth/lock clients, endpoint builders, branded media IDs (`MediaRecordId`, `StorageKey`), `resolveLocalMediaRefsOption`, `parseMarkdownLenient`, `formatYamlScalar`, search option/date resolvers, ULID helpers. | Layer 0 internals only | Layers 1, 2, 3 | Never imports Layer 1, 2, or 3. |
| **Layer 1: Sync Upstream** | `src/sync/{baseline-reconstruction, status, diff, merge, preflight, guards, taxonomies, terms, bylines}` — Pure computation, baseline spelling reconstruction, status/diff calculation, taxonomy matching, and preflight safety verification (`src/sync/preflight/image_probe.ts`). | Layer 0 only | Layers 2, 3 | **NEVER imports Layer 2 or Layer 3.** |
| **Layer 2: Sync Downstream** | `src/sync/{orchestrator, push, pull, new, delete, conflicts, doctor, media, article_search, snapshot, workspace}` — Orchestration, remote sync execution, 3-way merge conflict handling, search execution, full-library metadata snapshots, and local file mutations. | Layers 0 and 1 | Layer 3 (restricted to `ALLOWED_LAYER_2_SYMBOLS`) | Never imports Layer 3. |
| **Layer 3: Consumers & Presentation** | `src/cli/`, `src/mcp/`, `src/presentation/` — CLI commands, centralized CLI failure presenter (`src/cli/report-failure.ts`), MCP tools (`src/mcp/tool-errors.ts`), and shared report formatters (`src/presentation/{article_report, media_report, pull_report}.ts`). | Layers 0, 1, and `ALLOWED_LAYER_2_SYMBOLS` | Top-level entry points (`src/bin/emit.ts`, `src/index.ts`) only | Never imported by Layer 0, 1, or 2. |

### Static Enforcement Axes & Allowlist Governance

- **Axis 0 (Layer 0 Outbound Isolation)**: Layer 0 never imports Layer 1, 2, or 3 (`node:fs` is permitted in Layer 0 only for config/profile loading and `utils/media-body-refs.ts`).
- **Axis 1 (Layer 1 → Layer 2 Prohibition)**: Layer 1 modules must remain side-effect-free and never import Layer 2 modules.
- **Axis 2 (Layer 3 → Layer 2 Controlled Access)**: Layer 3 consumers may only import Layer 2 symbols listed in `ALLOWED_LAYER_2_SYMBOLS` (`tests/layering.test.ts`).
- **Axis 3 (Layer 3 Intra-Layer Isolation)**: `src/mcp/` must never import from `src/cli/commands/`. Shared formatting belongs in `src/presentation/`.
- **Axis 4 (Lower Layers → Layer 3 Prohibition)**: Layers 0, 1, and 2 must never import from Layer 3.
- **Axis 5 (Non-CLI Logging Isolation)**: Non-CLI modules (`src/sync/`, `src/utils/`, `src/db/`, `src/client/`, `src/mcp/`, `src/presentation/`) must **never** call `console.log()` or `console.debug()` (which corrupts MCP JSON-RPC stdio transport). Only `src/cli/` may invoke `console.log()`.
- **Axis 6 (`saveSyncState` Call-Site Isolation)**: `.saveSyncState(` may only be invoked inside `db/baseline.ts` (`retrackLocalHashOnly`), `sync/workspace/commit.ts` (`commitArticleSnapshot`), and `sync/conflicts.ts`.
- **Axis 7 (Lenient Frontmatter Parse Isolation)**: `gray-matter` may only be imported in `src/utils/frontmatter.ts`, and all inspector/deletion/diff modules (`status`, `doctor`, `conflicts`, `delete`, `diff`, `article_search/local`, `media/body_scan`) must import and use `parseMarkdownLenient()`.
- **Axis 8 (CLI Failure Presenter Isolation)**: Every `src/cli/commands/*.ts` module must route action failures through `reportActionFailure()` (`src/cli/report-failure.ts`) or `reportProfileFailure()`.
- **Axis 9 (MCP Tool Error & `_meta` Wrapper Isolation)**: Every `src/mcp/tools/*.ts` module must import and use `withResolvedContext()` or `formatToolError()` from `src/mcp/tool-errors.ts`.
- **Layer 2 Sibling Snapshot & Public Barrel Rule**:
  - Layer 2 modules must not import sibling Layer 2 modules beyond the explicit snapshot in `tests/layering.test.ts` (`orchestrator` → `pull/index.js`, `push/index.js`, `media/index.js`; `doctor` → `conflicts`, `media/index.js`; `push/media_stage` → `sync/media/index.js`; `pull/media_stage` → `sync/media/index.js`; `snapshot/index.ts` → `media/index.js`, `pull/index.js`).
  - The thin barrels `src/sync/{pull,push,media}.ts` are reserved exclusively for the public npm façade (`src/index.ts`). **No internal module across `src/` or `tests/` may import those barrels**; always import `src/sync/{pull,push,media}/index.js`.
  - Workspace filesystem contracts (`calculateHash`, `iterWorkspaceArticles`, `findLocalFilesByUlid`, `CONFLICTS_SUBDIR`, `isQuarantinedRelativePath`, `resolveCanonicalArticlePath`, `quarantineLocalCopy`) live in `src/sync/workspace/`.
  - **Strict Allowlist Governance (Ask First)**: Never widen `ALLOWED_LAYER_2_SYMBOLS` or add a new Layer 2 sibling edge in `tests/layering.test.ts` without explicit project owner approval.

---

## 3. Core System Invariants (Top 7 Principles)

1. **Two-Track Revision Invariant (`docs/sync-engine-and-revisions.md`)**:
   - **Track 1 (`revForTransport`)**: Raw server tokens stored in `base_snapshots.rev` and `entries.rev`, sent verbatim in PUT `{ _rev }` payloads. Never overwrite with composite keys.
   - **Track 2 (`revForComparison`)**: Composite keys (`${version}@draft:${draftRevisionId}` or `${version}@live:${liveRevisionId}`) stored in `sync_state.remote_rev` across all 4 save paths and compared via `isSameRev()`.
   - **Draft Selective Single GET**: Articles with `draftRevisionId` (or tracked drafts when `remoteChanged`) trigger a single `GET /posts/{id}` because the list API returns stale creation-time `data` or published `liveData`. Clean published articles reuse list payloads with **0-GET**.
   - **Published Articles with Draft Revisions (`published*`)**: Derived solely from `hasUncommittedDraftRevision()` (`status === 'published' && remote_rev.includes('@draft:')`). Kept in `posts/published/` with frontmatter `status: published # draft revision`. Standard `push` stages a draft; `--allow-publish` publishes live.
2. **Two-Layer Representation Invariant (`docs/taxonomies-and-bylines.md`, `docs/media-pipeline.md`)**:
   - **Layer A (Internal Baseline & Remote Payloads)**: `base_snapshots` (where `frontmatter_yaml` is JSON-encoded `Frontmatter`) and remote API requests always store canonical percent-encoded taxonomy slugs (`"%e6%9c%aa%e5%88%86%e9%a1%9e"`) and canonical root-relative media URLs (`/_emdash/api/media/file/<storageKey>`).
   - **Layer B (On-Disk Markdown & YAML)**: Disk files render decoded human-readable CJK slugs (`    - 未分類`) and, when `localMediaRefs: true` (default), article-relative body image paths (`../../media/<storageKey>`). Only `sync_state.local_hash` tracks the Layer B disk bytes.
   - `resolveLocalMediaRefsOption()` lives in Layer 0 as a pure function; only the CLI (`resolveAndPersistLocalMediaRefs`) persists flag overrides to `.emit/config.json`—MCP tools must never mutate `.emit/config.json`.
3. **Two Media ID Spaces & Mirror Naming Invariant (`docs/media-id-spaces.md`, `docs/media-pipeline.md`)**:
   - EmDash assets have two unrelated 26-char ULIDs: D1 record `id` (used by `featuredImage` and `GET /_emdash/api/media/{id}`) and R2 `storageKey` (used by `/_emdash/api/media/file/{storageKey}` and `media_state` PK). Never interchange them.
   - Local mirrors are named strictly from `storageKeyToMarkdownRef(storageKey)` (`media/<markdownRef>.<ext>` + `.yaml`), with `<stem>--<mediaId>` only on confirmed stem collision. Ownership (`mediaRecordIdForStem`) is read exclusively from companion YAML `id:`, never parsed from filenames.
   - Media pruning seeds active IDs solely from remote records when `walkComplete === true`, protecting any mirror still referenced in `draft/`, `published/`, or `conflicts/`. Standalone media deletion (`emit delete-media` / `sync_delete_media`) enforces Guard **G20 (`MEDIA_IN_USE_PROTECTION`)** against local workspace articles (`[LOCAL_REFERENCE_SCAN_ONLY]`, no bypass flag) and moves deleted local mirrors into `media/_trash/<stem>.deleted.*` only after remote `DELETE` succeeds.
   - **Media Ordering Is Server-Authoritative (Declared Non-Scope)**: Emit never parses image metadata (EXIF), never sorts uploads to influence `createdAt`, and never attempts to rewrite or re-sort remote media records. List order derives from EmDash's ULID-keyed record IDs (`ORDER BY id DESC` = newest-first).
   - **Epistemic Media Rule**: A 404 from `GET /_emdash/api/media/{id}` proves only that an ID-space lookup failed. Emit must **never** assert that a D1 record is missing and must **never** recommend a SQL `INSERT`.
4. **Dual-Track Image & AST Fidelity Invariant (`docs/markdown-and-ast.md`)**:
   - **Track A (Tier 1 Plain Images)**: Standard images without layout attributes serialize as `![alt](../../media/<storageKey>.<ext>)` for offline editor preview.
   - **Track B (Tier 3 Preserved Blocks)**: Images with layout/styling (`alignment`, `displayWidth`, `caption`, etc.) and custom EmDash blocks serialize as single-line opaque comment fences (`<!--ec:block {...} -->`) protected by Guard **G9 (`MODIFIED_OPAQUE_BLOCK`)**.
   - Only backtick code fences (` ``` `) are recognized as code blocks and exempted from image guards G5/G11; tilde fences (`~~~`) and Setext headings emit Guard **G8** warnings.
5. **Diagnostic & Lenient Parse Alignment Invariant (`docs/markdown-and-ast.md`)**:
   - All read-only inspectors (`status`, `doctor`, `conflicts`, `delete`, `article_search/local`, `media/body_scan`) must parse files through `parseMarkdownLenient()` (`src/utils/frontmatter.ts`) and check modification status via `reconstructBaseline()` / `isLocalFileUnmodified()` (`src/sync/baseline-reconstruction.ts`).
   - Never call `saveSyncState()` directly to advance `local_hash` alone; always use `retrackLocalHashOnly()` (`src/db/baseline.ts`).
6. **Snapshot-First Search (`snapshotStatus` Framing) & Offline Doctor Invariant (`docs/safety-guards-and-diagnostics.md`)**:
   - Default `article-search` and `media-search` run 0-HTTP exhaustive searches across local workspace files and `.emit/cache.db` snapshots, framing coverage via `buildSnapshotSearchFraming()` (`snapshotStatus: 'fresh' | 'stale' | 'missing'`, `absenceGuaranteed`, `truncatedHint`). `article-search --live` / `live: true` queries `/_emdash/api/search` (FTS, keyword-only) and rejects unsupported filters (`LIVE_SEARCH_UNSUPPORTED_FILTER`) instead of falling back to bounded scans.
   - **Search vs. Diagnostic Census Boundary**: `collectRemoteStorageKeys()` and `findUnmirroredStorageKeys()` (`src/sync/media/remote_index.ts`) are diagnostic census helpers for `emit doctor --check-media-library` (not search), and `doctor` remains **100% offline by default** unless `--check-auth`, `--check-media-urls`, or `--check-media-library` is explicitly passed.
7. **CLI / MCP Presentation & Origin Symmetry Invariant (`docs/architecture-and-layers.md`)**:
   - Target `origin` is resolved exclusively by `resolveOriginPriority()` (`--profile` > `EMDASH_ORIGIN` > auto-resolved profile > auth origin > `.emit/config.json` > `DEFAULT_ORIGIN`), surfacing every override as a warning naming the true source.
   - CLI actions route all errors through `reportActionFailure()` (`❌ <message>` + `process.exit(1)`, zero raw stack traces).
   - MCP tool handlers wrap all execution (including `resolveContext()`) in `try/catch`, returning `formatToolError(error)` and attaching `_meta` (`profile`, `workspace`, `origin`, `resolvedBy`).

### Invariant ⇔ Enforcer Mapping Table (`pstack` `/correct` Discipline)

Every core invariant is paired with the structural mechanism (Architecture, Type, Static Gate, or Behavioral Suite) that enforces it. When a mistake recurs, promote its enforcement up the hierarchy (Architecture → Types → Static Axis/Guard → Behavior Test → Docs) using `.agents/skills/correct/SKILL.md`:

| Invariant / Principle | Enforcement Level | Enforced By (Source of Truth) |
| --- | --- | --- |
| **4-Tier Layering & Sibling Isolation** | Architecture / Static Test | `tests/layering.test.ts` (Axes 0–4, Sibling Snapshot, Public Barrel Check) & `npm run check:cycles` |
| **Non-CLI Stdio Logging Prohibition** | Static Test | `tests/layering.test.ts` (Axis 5: prohibits `console.log`/`console.debug` outside `src/cli/`) |
| **1. Two-Track Revision (`revForTransport` vs `revForComparison` & `snapshot:` Sentinel)** | Runtime & Unit Test | `src/client/api.ts` (`extractRev`, `extractComparisonRev`, `isSameRev`), `src/sync/push/guards.ts` (`checkSnapshotBaselineGuard` / `PULL_REQUIRED_BEFORE_PUSH`), `src/sync/pull/fast_path.ts` (`promoteSnapshotBaselineIfNeeded`), `tests/api_rev.test.ts`, `tests/push_transport_rev.test.ts`, `tests/commit_symmetry.test.ts`, `tests/snapshot_pull.test.ts` |
| **2. Two-Layer Representation (Canonical Layer A vs Disk Layer B)** | Architecture & Unit Test | `src/sync/baseline-reconstruction.ts`, `src/utils/disk-spelling.ts`, `tests/taxonomies_two_layer.test.ts`, `tests/local_media_refs.test.ts` |
| **3. Two Media ID Spaces (`MediaRecordId` vs `StorageKey`), G20 & Server-Authoritative Ordering** | Type System & Guard Registry | `src/utils/media-id.ts` (`MediaRecordId`, `StorageKey`), `src/sync/media/delete_media.ts` (G20 `MEDIA_IN_USE_PROTECTION`), `tests/media_id.test.ts`, `tests/delete_media.test.ts`, `tests/media_upload.test.ts` (declared non-scope: zero EXIF / sort payload fields) |
| **4. Dual-Track Image & AST Fidelity (Tier 1 vs Tier 3 `ec:block`)** | Guard Registry & Static Test | `src/sync/guards.ts` (G5, G8, G9, G11), `tests/guards.test.ts` (Rules 1–5), `tests/portable-text.test.ts` |
| **5. Diagnostic Lenient Parse & `retrackLocalHashOnly`** | Static Test & Unit Test | • `parseMarkdownLenient` & `gray-matter` isolation: `tests/layering.test.ts` (Axis 7)<br>• `saveSyncState` / `retrackLocalHashOnly` isolation: `tests/layering.test.ts` (Axis 6) & `tests/baseline_reconstruction.test.ts`<br>• `reconstructBaseline` / `isLocalFileUnmodified` parity: `tests/baseline_reconstruction.test.ts` & `tests/diagnostic_draft_alignment.test.ts` |
| **6. Snapshot-First Search (`snapshotStatus`) & Offline Doctor** | Runtime & Unit Test | `tests/article_search.test.ts`, `tests/media_search.test.ts`, `tests/cli_media_search.test.ts`, `tests/doctor.test.ts` |
| **7. CLI / MCP Presentation & Error Handling Symmetry** | Static Test & Unit Test | • File-level presenter/wrapper gates: `tests/layering.test.ts` (Axes 8 & 9)<br>• Behavioral & symmetry verification: `tests/presentation_symmetry.test.ts`, `tests/mcp_tool_errors.test.ts`, `tests/cli.test.ts` |

---

## 4. The Golden Path for AI Content Authoring (Workflows A/B & 2-Stage Push)

When drafting, reviewing, or updating blog articles, AI agents must follow the **Golden Path Workflows**:

```text
  [0. SYNC WORKSPACE]  sync_pull / sync_status  (Syncs 30+30 window, categories/tags & media)
           │
           ├─────────────────────────────────────────────┐
           ▼ (Workflow A: Create New Post)               ▼ (Workflow B: Revise Existing / Past Post)
  [1A. ONE-SHOT SCAFFOLD]                       [1B. DISCOVER & TARGET]
   sync_new(slug, title, categories,             • In window: locate via sync_status
     tags, description, featuredImage)           • Outside 30-post window:
   (Generates complete frontmatter in 1 step;      sync_article_search(query, tag, since, ...)
    no manual YAML header editing required)        ──► sync_pull(id: "<26-char-ULID>")
           │                                             │
           └─────────────────────┬───────────────────────┘
                                 ▼
  [2. DIRECT MARKDOWN EDIT & MEDIA STAGING]
   • Edit posts/[draft|published]/<yyyyMMdd>_<ulid>-<title>.md
   • New local images: place in media/drafts/<file> & reference as ![alt](../../media/drafts/<file>)
   • Existing remote images: discover via sync_media_search(query, since)
   • Preserved blocks: keep structural keys intact on <!--ec:block {...} --> lines; safe image layout/caption edits, block removal, and reordering are permitted (Guard G9)
                                 │
                                 ▼
  [3. DIFF & 2-STAGE PUSH (Draft Staging ──► Live Publish)]
   • Review diff:     sync_diff(filePath)
   • Stage as Draft:  sync_push(filePath)
                      (Auto-uploads media/drafts/* -> promotes to media/, acquires 7-min lock,
                       3-way merges if needed. On a live published post, bare sync_push safely
                       stages an unpublished draft revision [published*] without altering live)
   • Publish Live:    Only when explicitly requested, set status: published and run:
                      sync_push(filePath, allowPublish: true)
```

### Critical Authoring Rules for AI Agents

1. **Pull Before Editing**: Run `sync_pull` (or `sync_status`) first. Batch `sync_pull` syncs the latest 30 published + 30 draft articles, refreshes `categories/` and `tags/`, and mirrors referenced media on demand.
   - **Targeting Older Articles Outside the 30-Post Window**: Use `sync_article_search` (by keyword, `tag`, `category`, `since`/`until`, `status`, or `live: true` for keyword-only FTS) to discover the article's 26-character ULID, then run `sync_pull(id: "<ulid>")`. Never guess ULIDs.
2. **One-Shot Scaffolding (`sync_new`) & No Throwaway Files (Guard G18)**:
   - Never create disposable files (`temp.md`, `draft.md`, `scratch.md`). Always use `sync_new` with `title`, `categories`, `tags`, `description`, and `featuredImage` to generate a complete, schema-valid file in one step.
3. **Never Move or Rename Files with `mv` (Guard G2)**:
   - To change `title`, `slug`, or `status`, edit the YAML frontmatter and run `sync_push`. Emit relocates and renames the file automatically while keeping `cache.db` consistent.
4. **Frontmatter & Body Rules (Guards G3, G4, G5, G7, G9, G10, G11)**:
   - **Always nest `categories` and `tags` under `taxonomies:`** (top-level `categories:` / `tags:` are stripped by Zod). Use existing slugs or term ULIDs from `categories/*.yaml` and `tags/*.yaml`.
   - **Do not repeat `# Title` at the top of the body** (Guard G7).
   - **Do not tamper with structural keys (`_key`, `asset`, etc.) on `<!--ec:block ... -->` lines** (safe `image` layout/caption edits, block removal, and reordering are permitted with warnings; structural tampering requires `--allow-modified-opaque-blocks`, Guard G9).
   - **Offline Draft Images**: Place new local images in `media/drafts/<filename>` and reference them on a standalone line (`![alt](../../media/drafts/<filename>)` or in `featuredImage`). `sync_push` uploads them, rewrites the URL, and moves the file to `media/<markdownRef>.<ext>`.
   - **Staging Protection (Guard G3)**: Keep `status: draft` unless explicitly asked to publish (`allowPublish: true`).
5. **Quarantine & Conflict Resolution (`posts/conflicts/`, Guards G6, G12–G17, G19)**:
   - Never push a rescue copy under `posts/conflicts/` (blocked by Guard G12). Use `sync_conflicts` (`list`, `diff`, `resolve`, `prune`) to inspect or resolve quarantined copies.
   - See **[docs/safety-guards-and-diagnostics.md](docs/safety-guards-and-diagnostics.md)** for the full G1–G20 specification and remediation flags.

---

## 5. Development Governance, Quality Gates & Ask First Policy

### Ask First Policy (4 Mandatory Categories)

Before executing modifications in any of the following 4 categories, an AI agent or contributor **must pause and obtain explicit confirmation from the project owner**:

1. **New npm packages**: Adding any package to `dependencies` or `devDependencies` in `package.json`.
2. **Persistence schema modifications**: Adding or altering SQLite tables, columns, indexes, or migrations in `cache.db` (`src/db/`) or configuration keys in `.emit/config.json`.
3. **Public Facade / Orchestrator API & Layering Allowlist changes**: Altering the signature or return shape of `pullBatch`, `pullSingleArticle`, `pushArticle`, or `pushAll`, or adding symbols/edges to `ALLOWED_LAYER_2_SYMBOLS` or the Layer 2 sibling snapshot in `tests/layering.test.ts`.
4. **Specification deletions / core revisions**: Deleting or fundamentally altering authoritative specifications in `docs/` or core principles in `AGENTS.md`.

### Commit Readiness Checklist

Before finalizing any commit, verify all 7 items:

- [ ] **Localized Diff**: `git status` / `git diff` contains only files directly required for the task.
- [ ] **Doc & Code Consistency**: Implementation matches `AGENTS.md` and the authoritative specifications in `docs/`.
- [ ] **Non-CLI Clean Logging**: Zero `console.log` or `console.debug` calls in non-CLI modules (Axis 5 PASS).
- [ ] **Zero Circular Dependencies**: `npm run check:cycles` reports 0 circular dependencies.
- [ ] **Layering & Guard Invariants**: `tests/layering.test.ts` (Axes 0–5) and `tests/guards.test.ts` (Rules 1–5) PASS without unapproved allowlist additions.
- [ ] **Comprehensive Test Coverage**: All new features and bug fixes include unit tests under `tests/` (Vitest, hermetic via `tests/setup/env-isolation.ts`).
- [ ] **Static Quality Gate**: `npm run check` (`format:check`, `typecheck`, `check:cycles`, `test`) exits 100% green.
