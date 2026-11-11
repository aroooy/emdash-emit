# AGENTS.md - Emit Development & AI Agent Operation Guide

This document defines the **official workflow rules (The Golden Path) and coding standards** for AI agents (Antigravity, Claude Code, Cursor, etc.) and human developers working in this repository.

---

## 1. Project Overview & Architecture

- **Project Name**: `emdash-emit` (CLI / MCP Command: `emit`)
- **Target CMS**: **EmDash (Cloudflare Workers + D1)**
- **Purpose**: Bidirectional sync between local Markdown workspace and remote EmDash, loss-free AST conversion, and Git-like Hybrid 3-Way Merge.
- **Tech Stack**:
  - Language: TypeScript 7.x (Node.js >= 22.0.0)
  - Testing: Vitest
  - Code Style: Prettier (`printWidth: 100`, `singleQuote: true`, `trailingComma: all`)
  - Cache Storage: Node.js built-in `node:sqlite` (`DatabaseSync` / zero native compilation)
  - ULID Generation: `ulidx` (26-character canonical ULID)
  - 3-Way Merge: `node-diff3`

### Reference Documents

- **`docs/media-id-spaces.md`** — the authoritative specification of EmDash's two media identifier spaces (D1 record `id` vs R2 `storageKey`), which endpoint accepts which, and how migrated corpora behave. Read it before debugging any missing or unresolved image.

---

## 2. Workspace Structure (Git-style)

```text
/your-blog-workspace/               <-- Target workspace root directory
├── .emit/                          <-- [Hidden Configuration & Cache Directory]
│   ├── cache.db                    <-- SQLite local cache (node:sqlite)
│   └── config.json                 <-- Instance connection and collection settings
├── categories/                     <-- Category definitions (<id>-<label>.yaml)
├── tags/                           <-- Tag definitions (<id>-<label>.yaml)
├── media/                          <-- Media files & companion YAML (`media/<markdownRef>.<ext>` + `media/<markdownRef>.yaml`, where <markdownRef> is the sanitized storageKey basename — never the media record id; see docs/media-id-spaces.md)
│   └── drafts/                     <-- Staging folder for offline draft images (auto-uploaded on push)
└── posts/                          <-- [Local Markdown Files for Humans & AI]
    ├── draft/                      <-- Draft articles (<yyyyMMdd>_<ulid>-<title>.md, title || slug)
    ├── published/                  <-- Published articles (<yyyyMMdd>_<ulid>-<title>.md, title || slug)
    └── conflicts/                  <-- Read-only rescue copies written by pull when local content diverged (never articles, never pushed)
```

- **Boundary Rule**: All operations take place relative to the workspace root containing `.emit/`. Commands run from subdirectories (e.g. `posts/draft/`) automatically discover the parent workspace root.

---

## 3. The Golden Path for AI Agents (4-Step Cycle)

When drafting, reviewing, or updating articles, AI agents must strictly follow the **4-step cycle**:

```text
[1. PULL / STATUS]  Synchronize local state    -->  sync_pull / sync_status / sync_diff
    │
[2. NEW / CHECK]    Resolve target article     -->  New: sync_new <slug> / Existing: find file
    │
[3. DIRECT EDIT]    Edit canonical file        -->  posts/[status]/<yyyyMMdd>_<ulid>-<title>.md
    │
[4. PUSH]           Explicit push to remote    -->  sync_push (filePath required)
```

1. **PULL / STATUS (`sync_pull` / `sync_status`)**: Always pull or check status before editing to ensure the local cache reflects the latest remote revision. `sync_status` returns tracked articles sorted newest-first (descending by date prefix and ULID; date reflects publication/creation date, not last modified). To locate active edits, filter by `syncStatus: 'modified'`. Batch mode `sync_pull` automatically syncs taxonomies (categories/tags) alongside articles. Use `postsOnly:true` to skip taxonomies. Use `includeMedia:true` to also pull media assets.
2. **NEW (`sync_new`)**: When creating new posts, always use `sync_new` (or `emit new`) to scaffold canonical ULID metadata and files. Valid categories and tags (sorted by usage count) are returned automatically in the response hint.
3. **DIRECT EDIT**: Edit the generated `<collection>/draft/<yyyyMMdd>_<ulid>-<title>.md` directly (frontmatter and body).
4. **PUSH (`sync_push`)**: When editing is complete, push the specific `filePath` to remote EmDash.

### Canonical Frontmatter Schema (`src/utils/frontmatter.ts`)

Every article file must adhere strictly to `FrontmatterSchema`:

```yaml
---
id: 01M6ABCDEF1234567890123456     # 26-char canonical ULID (DO NOT EDIT)
slug: article-slug
title: "Article Title"
collection: posts                  # Default: "posts"
status: draft                      # "draft" or "published"
publishedAt: null                  # ISO 8601 timestamp string or null
locale: ja                         # Default: "ja"
featuredImage: "01M67P0MBMJQQXH2K95HHCYRYB" # Optional: 26-char media record ULID or null
taxonomies:                        # Nested map of taxonomy key -> array of term slugs (or term ULIDs)
  categories:
    - tech
  tags:
    - typescript
seo:                               # Optional SEO metadata block
  title: null
  description: null
  canonical: null                  # Must be an absolute URL (https://...) or null
  noIndex: false
  image: null
bylines:                           # Author byline slugs (defaults to first non-guest author by slug ASC)
  - aroooy
---
```

- **Never place `categories` or `tags` at the top level**: `parseMarkdown()` strips unknown top-level keys via Zod and `serializeMarkdown()` rewrites the frontmatter on every pull/push. Top-level `categories:` / `tags:` are silently discarded without triggering Guard G4. Always nest them under `taxonomies:`.
- **`seo.canonical` requires an absolute URL**: Validated with `z.string().url().nullable().optional()`; relative paths fail parsing.
- **No duplicate `# Title` in body**: Do not repeat the article title as a top-level `# Heading` at the start of the Markdown body (Guard G7).

---

## 4. Strict Safety Guardrails for AI Agents

These rules are enforced at the code level via Preflight Guards (G1–G17):

### 1. Prohibition of Throwaway Temporary Files
- **Never create disposable files** such as `temp.md`, `draft.md`, or `scratch.md` in the workspace.
- Always write directly to the canonical file generated by `sync_new` or pulled into the workspace.
- **Duplicate Slug Guard (`DuplicateSlugError` / `DUPLICATE_SLUG_GUARD`)**: `sync_new` verifies that the given slug does not collide with existing local files (draft or published), indexed cache entries, or remote CMS articles.

### 2. Never Move or Rename Files Manually
- **Do not use `mv` or shell file operations** to rename files or move them between `draft/` and `published/`.
- To update the title, `slug`, or `status`, simply modify the YAML frontmatter and run `sync_push`. Emit will automatically move and rename files while maintaining cache database integrity.

### 3. Single-Target Push Enforcement
- `sync_push` requires a specific `filePath` (relative to the workspace root). `sync_diff` and single-article `sync_pull` accept either `filePath` or `id`. Bulk uncontrolled pushes without inspection are prohibited.

### 4. Staging Protection (Do Not Publish Prematurely)
- Unless explicitly requested by the user, keep the post status as `draft`.
- Promoting to `status: published` requires explicit `allowPublish: true` confirmation.

### 5. Taxonomy Validation
- Do not invent nonexistent taxonomy terms. Preflight Guard G4 validates taxonomy terms on `sync_push` against the local `categories/` and `tags/` definitions. Validation only runs when those local definitions exist, so always run `emit pull` (or `sync_pull`) first to populate them.
- Valid category and tag slugs are automatically provided as hints in the output of `sync_new`, `sync_pull` (batch mode, even with `postsOnly: true`), and `sync_pull_taxonomies`. Tags are sorted by usage count (most used first). Hint lists are capped per command, so the complete authoritative list is always the `categories/` and `tags/` YAML files themselves.
- Canonical term ULIDs in frontmatter are transparently accepted and verified against local definitions; unknown or obsolete ULIDs not found locally are rejected as stale.

### 6. Media References, Two ID Spaces & Offline Draft Images
- **Two distinct ID spaces (Critical):** EmDash separates **media record IDs** (`id`) from **storage keys** (`storageKey`). Never interchange them. The full specification — identifier matrix, endpoints, migrated-corpus behavior, and resolution order — is documented in `docs/media-id-spaces.md`; read it before debugging any media reference:
  - **Frontmatter `featuredImage`** uses the **26-character media record `id`** (e.g. `01M67P0MBMJQQXH2K95HHCYRYB`) or `null`. Preflight Guard **G10** rejects local file paths (`./hero.png`), made-up IDs, and malformed values before pushing.
  - **Markdown body images `![alt](...)`** use the **`storageKey`-based public route** `/_emdash/api/media/file/<storageKey>` (where `<storageKey>` is `<ulid>.<ext>` or `<ulid1>.<ulid2>.<ext>`). Passing a media record `id` into `/_emdash/api/media/file/<id>.<ext>` returns **HTTP 404**.
- **Offline draft image auto-upload (G5 / G11):**
  - Place new local images in `media/drafts/<filename>` and reference them on a **standalone line** in the Markdown body: `![alt text](../../media/drafts/<filename>)` (or `media/drafts/<filename>`).
  - Preflight Guard **G11 (`LOCAL_IMAGE_AUTO_UPLOAD`)** validates that the file exists under `media/drafts/`, has a supported image extension (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.avif`, `.svg`), and is within the 50 MiB limit. During `emit push` / `sync_push`, Emit automatically uploads the image via the 4-stage media flow (`upload-url` → `PUT` → `confirm`), rewrites the Markdown line to the canonical root-relative `/_emdash/api/media/file/<storageKey>` URL, pushes the article, and promotes the file from `media/drafts/<filename>` to `media/<markdownRef>.<ext>` with its companion `media/<markdownRef>.yaml`. **`markdownRef` is derived from the storageKey** (`storageKeyToMarkdownRef`: basename of the key, invalid characters stripped, own extension removed, UTF-8-safe truncation), never from the media record id and never from `createdAt`, so the promoted file is named exactly as the body URL that references it and no date prefix or re-naming pass is needed. Two keys that sanitize to the same stem collide-resolve deterministically to `<stem>--<mediaId>` (`collisionSuffixedMarkdownRef`), so a second asset can never overwrite the first mirror.
  - **Already-promoted asset reuse (never re-upload):** If a referenced draft image was already promoted by an earlier push, Emit resolves it through `media_state` and `media/*.yaml` and accepts the line, rewriting it to the existing canonical URL. The identical `![alt](../../media/drafts/<filename>)` line is therefore valid in a second article, and a direct `media/<markdownRef>.<ext>` reference is valid too — matched against recorded metadata (the mirror basename, the companion's `filename:`, or a legacy stem's name suffix / embedded record id), never by filename guessing. **Never move a promoted file back into `media/drafts/`.** Before baking a reused URL into the body, Emit verifies the record with `GET /_emdash/api/media/{id}`: a record deleted on remote aborts the push with `PROMOTED_MEDIA_NOT_FOUND_REMOTE` and purges the stale cache entry, while a server that does not implement the endpoint still pushes and reports `[MEDIA_EXISTENCE_UNVERIFIED]` as a warning.
  - **Standalone line requirement:** Because EmDash's Portable Text AST treats images as top-level blocks (`/^!\[([^\]]*)\]\(([^)]+)\)$/`), inline local images inside a text paragraph (e.g. `Text ![alt](../../media/drafts/a.png) more text`) are rejected with `INLINE_LOCAL_IMAGE_NOT_SUPPORTED`. Images inside `<!--ec:block ... -->` opaque fences are ignored by G5/G11 so Guard **G9** is preserved. Any other local image path (e.g. `./hero.png`, an absolute filesystem path, or a `media/` path that cannot be resolved to a promoted media record) is rejected by Guard **G5 (`LOCAL_IMAGE_DETECTED`)**; a `media/drafts/` reference whose file is missing and has no promoted match is rejected with `MISSING_LOCAL_IMAGE_FILE`.
  - **Only backtick fences are exempted:** G5/G11 skip image lines that sit inside ```` ``` ```` fenced code blocks (any fence length, matched by a closing fence of equal or greater length, so a body that documents Markdown examples is never inspected as real markup). Tilde fences (`~~~`) are **not** exempted, because the Portable Text mapper only treats backtick fences as code blocks — exempting `~~~` would let a local path bypass validation and still be converted into a real remote image block. Document code examples with backticks.
- **Confirmed `featuredImage` contract (live EmDash):** pushing `featured_image: { "id": "<ULID>" }` alone is accepted (HTTP 200); the server stores the media id and normalizes `"provider": "local"` itself. Never fabricate `provider`, `src`, `storageKey`, dimensions, or MIME type in a push payload.
- **Unresolved body storageKeys (`[UNRESOLVED_MEDIA_ASSET]` warning):** a migrated body can bake the R2 `storageKey` into `/_emdash/api/media/file/<storageKey>` while the media record's D1 primary key is a different ULID. Emit resolves references through **confirmed metadata sources only** — the canonical `GET /_emdash/api/media/{id}` lookup, `media_state`, and `media/*.yaml` companions (a companion storageKey is read from `storageKey:` when present, otherwise recovered from its canonical `url:` by `storageKeyFromMediaMeta`) — and never infers a record id from a body URL segment. When nothing resolves, `emit pull-media --article <id>` reports the key in `orphanStorageKeys` (MCP `sync_pull_media` prints the same list) and warns `⚠️ [UNRESOLVED_MEDIA_ASSET] <n> storageKey(s) ...`. Point at Emit's own library walk first: `GET /_emdash/api/media` is the only endpoint that reports each record's own `storageKey` and exposes no key filter (`q` matches filenames only), so `emit pull-media --all` — or `emit doctor --check-media-library` for the counts alone — indexes every storageKey the server holds without any server-side query. Only a key that survives a complete walk may be verified on the server, and only before registering anything: a blind INSERT can create a duplicate. Emit mirrors records and never repairs server data.` The warning must stay epistemic: a 404 from `GET /_emdash/api/media/{id}` proves only that *that* lookup failed, because the endpoint keys on the primary key while the body carries a storageKey, so **Emit must never assert that the D1 record is absent and must never recommend inserting one**. Keys whose ULID matches a record Emit resolved under that id or confirmed local mirror metadata are downgraded to `verifiedStorageKeys` instead. Remediation of genuinely missing records belongs to EmDash/Wrangler; once the record resolves, a normal `emit pull-media` mirrors the asset under its canonical `media/<markdownRef>.<ext>` name. Workspaces built by earlier Emit versions may still hold `media/legacy_<storageKey>.<ext>` + `.yaml` residue from the removed synthesized fallback: nothing reads it, it is excluded from every known-key set (`doctor.ts` and `collectLocalMediaMirrorCandidates`), `--prune` deliberately never touches it (it matches no media id), and it must be deleted by hand. `emit doctor --check-media-urls` probes `HEAD /_emdash/api/media/file/<key>` for references no local source can resolve and downgrades ones the origin still serves to an informational note instead of a missing-file warning — a served key proves only that the R2 object exists, never that a record is missing. Without the flag doctor stays offline and keeps reporting them as missing. `emit doctor --check-media-library` walks the whole library and reports its record count against the local mirror count, and a library-wide pull also reports `referencedUnmirroredStorageKeys`; every suggestion points at those Emit-side walks first and at server-side storageKey verification only for what a complete walk could not match — never at an INSERT.
- When the cached remote entry already points at the same ULID, Emit resends that remote object verbatim so its original provider shape (`external` with `src`, or `local` with `meta.storageKey`) is preserved instead of being re-resolved from a bare id.
- Emit canonicalizes `featuredImage` to uppercase on read, so lowercase input is safe; the local file is rewritten with the canonical form on the next pull or push.
- `featuredImage: null` clears the hero image. Omitting the field leaves the remote value untouched.
- Do not hand-write remote media URLs into `featuredImage`. A URL that contains a media ULID is accepted with a warning and resolved to the bare ULID, but the canonical frontmatter form is the bare 26-character ULID.

### 7. Media Mirror Naming & Index-Based Pruning Invariant

- **Mirror names come from the storageKey, never from the record id**: `mediaMirrorNames()` (`src/sync/media.ts`) derives both the binary and its `.yaml` companion from `storageKeyToMarkdownRef()` (`src/utils/naming.ts`) — basename of the key, invalid characters stripped, own extension removed so binary and companion share one stem, multi-ULID keys keep their internal dots, path-shaped keys collapse to their basename, truncation lands on UTF-8 character boundaries. A record id may appear in a filename **only** as a collision suffix (`<stem>--<mediaId>`, `collisionSuffixedMarkdownRef`) after `resolveMarkdownRefCollision()` has confirmed via companion YAML `id:` that another record already owns the bare stem; re-pulling the same record is idempotent and never spawns a second suffix.
- **Legacy names stay readable, never authoritative**: a workspace that has not been re-pulled yet still holds `media/<yyyyMMdd>_<mediaId>-<name>.<ext>`. Emit accepts those stems when resolving an existing mirror (matching the sanitized name suffix or the embedded record id) so a migration re-pull renames in place instead of re-downloading, but no new name is ever generated from that shape. A record with no usable storageKey falls back to the old id-based stem.
- **Ownership is read from companion YAML, never parsed from a filename**: `mediaRecordIdForStem()` accepts only a valid 26-char ULID under `id:` in `media/<stem>.yaml` and returns `null` otherwise — including when the stem itself begins with 26 ULID-ish characters. A storageKey-derived stem can coincidentally resemble an id, so filename-prefix attribution is unsafe everywhere: pruning, duplicate cleanup (`cleanupDuplicateMediaFilesForId`), and reuse matching must go through metadata or the `media_state` index.
- **Pruning authority is remote records only**: `pullMediaLibrary` seeds its active-id set from the records it just listed, **never** from a local scan of existing mirrors. Seeding locally makes every existing mirror self-exempt and silently disables pruning entirely — that bug shipped in this migration and must not return (the helper that enabled it, `collectLocalMediaIds()`, has been deleted; do not reintroduce it). A file with no companion is never pruned because Emit cannot attribute it to a record; `legacy_*` residue is excluded from every known-key set and from `--prune`, and is deleted only by hand.
- **Cache schema v4 carries the mirror path**: `media_state.markdown_ref` (plus `idx_media_state_storage_key`) records the workspace-relative path of the storageKey-named mirror alongside `workspace_path`, because the record id addresses the remote row while the markdown ref addresses the article body. Lookups and doctor resolution read these columns instead of parsing filenames.
- **`doctor` resolves body URLs by stem**: `runWorkspaceDoctor` builds `knownMediaStems` from mirror stems (whole stem, date-prefix-stripped stem, legacy name-suffix tail) and matches a body storageKey through `storageKeyToMarkdownRef(key)` first, so an already-migrated asset is never reported as an unresolved reference.
- **`localMediaRefs` changes the disk spelling only, never the remote payload**: when `.emit/config.json → localMediaRefs` is `true` (set with `emit pull --local-media-refs`, cleared with `--no-local-media-refs`; MCP `sync_pull` / `sync_push` accept a `localMediaRefs` argument that overrides it), mirrored body images are written to the Markdown file as workspace-relative `media/<storageKey>` references so preview resolves offline. The **baseline (`base_snapshots`), `sync_state.local_hash`, and every remote push payload keep the canonical `/_emdash/api/media/file/<storageKey>` URL** — push localizes *after* preflight canonicalization, so `diff.ts` and the 3-way merge stay byte-identical to a remote pull. Never hand-write `media/<storageKey>` into a body expecting it to be pushed verbatim: Preflight Guards still run against the canonicalized form, and only a key already confirmed mirrored (`media_state` or a `media/*.yaml` companion) is localized back on disk. `inspectArticleDiff` renders the baseline in whichever spelling the disk already carries, so an untouched local-ref article must never report a phantom media rewrite — keep that alignment with what `status` reports.

### 8. Rescue Copies under `posts/conflicts/` (Read-Only)

- When a pull finds local content that diverges from the last synced baseline, Emit moves the divergent file to `<collection>/conflicts/<name>.conflict.md` before writing the canonical article, so unpushed writing is never discarded.
- **Never treat a rescue copy as an article**: `getWorkspaceStatus` / `emit status` scan only `draft/` and `published/`, count `conflicts/` separately (`summary.conflicts`), and `pushAll` never selects it.
- **Never push a rescue copy**: Guard **G12** (`QUARANTINED_COPY_NOT_PUSHABLE`) refuses it before any network request. Read the copy, merge the valuable lines into the canonical article, then delete the copy. To intentionally replace the remote version, copy the rescue file over the canonical path and push that canonical path instead.
- **Never create files in `conflicts/` yourself** and never move a rescue copy back into `draft/` or `published/` with `mv`; merge its content into the canonical file instead.

### 9. Conflict Resolution & Quarantine Boundary Guards (G13 / G14)

- **Unpushed Edits Protection on Conflict Resolution (Guard G13 / `CANONICAL_HAS_UNPUSHED_EDITS`)**:
  - Resolving a conflict via `accept-local` overwrites the canonical article with the quarantined copy.
  - If the canonical article contains unpushed local edits that diverge from the cache baseline, `emit conflicts resolve --accept-local` (or `sync_conflicts` with `strategy: "accept-local"`) strictly aborts to prevent silent data loss.
  - To discard canonical edits and force overwrite, explicitly pass `-f, --force` (or MCP `force: true`).
- **Quarantined Path Restriction (Guard G14 / `QUARANTINED_PATH_REQUIRED`)**:
  - `emit conflicts resolve` and `diff` strictly validate that target files are located within `<collection>/conflicts/`. Arbitrary workspace paths are rejected before any unlink or write operation.
- **Pending Conflict Separation & Alignment (Schema v3)**:
  - Cache schema v3 separates `body_conflict_pending` and `taxonomy_conflict_pending` in `sync_state`, with `conflict_pending = MAX(body_conflict_pending, taxonomy_conflict_pending)`.
  - Push guards strictly evaluate preflight Guard **G6 (`UNRESOLVED_CONFLICT_MARKERS`)** before Guard **G15 (`TAXONOMY_CONFLICT_PENDING`)**, ensuring that files with unresolved conflict markers are halted with body-marker instructions rather than taxonomy guidance.
  - Resolving a conflict via `accept-canonical` dispatches `cache.clearConflictsByKind(id, 'body')`, unblocking subsequent bare pushes.
  - Conflict copy columns (`conflict_copy_path`, `conflict_copy_hash`, `conflict_at`) are cleared to `NULL` only when both `body_conflict_pending` and `taxonomy_conflict_pending` are 0.

### 10. Taxonomy Conflict Management, Wipe Guard & Revive (G15 / G16)

- **Taxonomy Conflict Pending Guard (`TAXONOMY_CONFLICT_PENDING`)**:
  - If a 3-way merge encounters diverged taxonomy assignments and cannot cleanly union them, `taxonomy_conflict_pending = 1` is recorded in `sync_state`. Re-pushing without specifying resolution is strictly blocked.
  - Pass `--resolve-taxonomy=union|local|remote` (or MCP `resolveTaxonomy: "union"`) or `-f, --force` to confirm resolution.
  - **Single-Side Adoption (ours/theirs) Semantics**: Passing explicit `--resolve-taxonomy local|remote` strictly adopts the chosen side. If the adopted side specifies an empty taxonomy (wipe), Guard G18 (`DESTRUCTIVE_TAXONOMY_WIPE`) is bypassed because the explicit user strategy intent is unambiguous.
- **Destructive Taxonomy Wipe Guard (`DESTRUCTIVE_TAXONOMY_WIPE`)**:
  - Pushing an empty taxonomy array (`categories: []` or `tags: []`) that would wipe existing remote terms requires explicit confirmation via `--allow-wipe-taxonomies` (or MCP `allowWipeTaxonomies: true`), unless an explicit `--resolve-taxonomy` strategy was passed.
- **Delete-Pending Article Revival Guard (`DELETE_PENDING_ARTICLE`)**:
  - If an article was previously deleted but unconfirmed on remote (`delete_pending: 1`), pushing is blocked to prevent accidental zombie re-publication. Pass `--revive` (or `--force`) to intentionally resurrect and push the article.

### 11. Quarantined Copy Pruning & Remote-Deleted Article Escape (R3)

- **Quarantined Copy Pruning (`emit conflicts prune`)**:
  - Quarantined copies in `<collection>/conflicts/` can be pruned via `emit conflicts prune` (with `--older-than <duration>` such as `7d` or `24h`, `--dry-run`).
  - If a canonical article contains unpushed local edits, its rescue copy is skipped.
  - Deletion backups (`.deleted.md`) that have no canonical article require `--allow-orphan-rescues` to be pruned.
- **Remote-Deleted Article Deadlock Escape (`[REMOTE_ARTICLE_DELETED]`)**:
  - When remote article returns 404/410 during push (PUT, conflict GET, or retry PUT), Emit halts with `[REMOTE_ARTICLE_DELETED]` (404) and offers 3 clean escape options:
    1. Recreate as new article: remove `id:` from frontmatter and `emit push <file>`.
    2. Discard local edits and untrack: `emit pull <id> --force` moves local edits to `<collection>/conflicts/*.local-dropped.md`, unlinks canonical article, and clears cache.
    3. Delete with rescue backup: `emit delete <file> --discard-local-edits` deletes remote/cache and saves unpushed edits to `<collection>/conflicts/*.deleted.md`.

### 12. Taxonomy Partial Failure Guard (Guard G17 / `TAXONOMY_APPLY_PENDING`)

- **Taxonomy Apply Pending Guard (`TAXONOMY_APPLY_PENDING`)**:
  - If article body PUT succeeds but subsequent taxonomy term update POST fails, `sync_state.taxonomy_apply_pending = 1` is recorded in the SQLite cache, and baseline taxonomies and hash are reverted to prior values to prevent silent drift.
  - Subsequent bare re-pushes are strictly blocked by Guard G17 until resolved, preventing phantom clean overwrites. Pass `--allow-unapplied-taxonomies` (or MCP `allowUnappliedTaxonomies: true`) or `-f, --force` to override.
  - To resolve cleanly: run `emit pull-taxonomies` (or MCP `sync_pull_taxonomies`), verify term permissions, and retry push. Single-article pull (`emit pull <id>`) also automatically refreshes taxonomy definitions to avoid `NOT_FOUND` errors.

---

## 5. Development & Code Quality Standards

- All new features and bug fixes must include unit tests under `tests/` using Vitest.
- Run `npm run check` (`format:check`, `typecheck`, and `test`) before committing.
- Ensure 100% clean exit (zero errors, all tests green).
- `tsconfig.json` builds `src/` only (tests excluded). `tsconfig.test.json` type-checks `src/` **and** `tests/` and is wired into `npm run typecheck`, so test files are fully typed and editors resolve `node:*` imports correctly. Do not add `@types/node`; it is already configured via `"types": ["node"]`.
- **MCP tool error contract**: every MCP tool handler must convert failures into `formatToolError(error)` (`src/mcp/tool-errors.ts`) instead of letting the callback throw. The MCP SDK catches a thrown error and returns only `error.message`, which silently drops the `[CODE]`, HTTP status, endpoint, `💡 Suggestion`, and `PushValidationError.errors` payload that CLI users see. This applies to **context resolution too**: `resolveContext()` can throw `AmbiguousProfileError` or workspace errors, so call it inside the guarded `try` (`tests/mcp_tool_errors.test.ts` asserts this for all context tools). Profile tools must read/write the same `profilesPath` that `createMcpServer` forwards, so an embedded server never lists profiles it cannot resolve.
- **Baseline serialization invariant**: `base_snapshots` stores the frontmatter as **JSON-encoded** `Frontmatter` (column `frontmatter_yaml`, despite the name) plus the Markdown body. `emit diff` / `sync_diff` rebuilds the baseline with `serializeMarkdown(JSON.parse(frontmatterYaml), bodyMarkdown)`, and that result must remain byte-identical to what `pull` / `push` write to disk, otherwise untouched articles report phantom diffs and the 3-way merge baseline drifts. Any change to `formatFrontmatterYaml` / `serializeMarkdown` output must be made together with that reconstruction. `saved_at` is stored in epoch **seconds** (multiply by `1000` when rendering JS dates).
- **YAML scalar quoting rule (`formatYamlScalar`)**: `formatFrontmatterYaml` formats `id`, `slug`, `collection`, `locale`, `taxonomies` terms, and `bylines` through `formatYamlScalar(value)`. Standard ASCII/CJK identifiers (`^[\p{L}\p{N}_][\p{L}\p{N}._/-]*$` that are not pure numbers, ISO dates, or YAML reserved literals) stay unquoted to preserve baseline hash compatibility, while `%`-prefixed strings (such as percent-encoded Japanese taxonomy slugs like `"%e6%9c%aa%e5%88%86%e9%a1%9e"`), strings containing `%` or YAML punctuation, pure numbers/all-digit ULIDs, ISO dates, and reserved words (`true`, `null`, `yes`, etc.) are quoted via `JSON.stringify`. Never emit raw unquoted scalars in `formatFrontmatterYaml`, as leading `%` is a YAML 1.2 directive indicator and will corrupt every article that uses percent-encoded taxonomy slugs. **Hash-matched invalid files are healed on the fast path**: `tryFastPathOrHeal` validates `parseMarkdown` even when `diskHash === cachedHash`, and a failure routes to `lenientRepairMarkdownFrontmatter` (re-quoting plus relative re-indenting of sequence items under their own parent taxonomy key) instead of a full remote re-pull, so legacy corpora self-heal without per-article fetches. The repaired file is re-tracked against its **own repaired hash** and the `base_snapshot` stays untouched — healing is syntax-only, values are never altered, and the article keeps reporting `synced`. Cached `invalid` files are automatically self-healed by batch `emit pull` / `sync_pull`; uncached `invalid` files outside the sliding window (`cached: false` in `getWorkspaceStatus`) are repaired by targeting their ULID explicitly via `emit pull <ULID>` or `sync_pull(id: "<ULID>")`.
- **Diagnostic alignment invariant (`status` vs `doctor`)**: `getWorkspaceStatus` classifies every strict-parse failure as `invalid` and marks it `healable: true` when `lenientRepairMarkdownFrontmatter` would succeed, exposing `summary.healableInvalid`; `emit doctor` reports the same set as a `warning` ("repair automatically") and reserves `error` for unrecoverable files. The two diagnostics must never disagree, and MCP `sync_status` mirrors both counts (`healableInvalid` / `unrecoverableInvalid`) in its `repairHint`.
- **Origin resolution invariant**: the effective `origin` is decided only by `resolveOriginPriority()` (`src/cli/context.ts`), which the MCP server also uses, so CLI and MCP can never disagree. Ranking is explicit `--profile` > `EMDASH_ORIGIN` > auto-resolved profile > resolved auth origin > `.emit/config.json` > `DEFAULT_ORIGIN`, and every higher-precedence source that overrides a lower one must emit a warning naming the real source. `loadConfig()` therefore keeps `EMDASH_ORIGIN` in the separate `envOrigin` field and never writes it into `.emit/config.json`; never collapse the two again or a warning will mislabel a file value as an env value. Profile workspace matching goes through `resolveDirectoryForComparison()` (`fs.realpathSync`) so symlinked workspaces still match. Tests must stay hermetic: `tests/setup/env-isolation.ts` (wired as a vitest `setupFiles` entry) deletes `EMDASH_ORIGIN`, `EMDASH_WORKSPACE`, `EMDASH_TOKEN`, and `EMDASH_API_TOKEN` before every file, so a developer's ambient env cannot change how profiles resolve inside the suite.
- **CLI failure presentation**: command actions must convert local failures into one `❌ <message>` line plus `process.exit(1)` (`emit pull*` formats `ApiError.toActionableString()`, `emit profile *` uses `reportProfileFailure()` in `src/cli/commands/profile.ts`). Never let an action throw: commander prints a raw `file://` stack trace, which is useless for humans and wastes agent context. `tests/cli.test.ts` asserts this for `profile use/remove/current` by stubbing `HOME`, `console.error`, and `process.exit` and running `program.parseAsync`.
