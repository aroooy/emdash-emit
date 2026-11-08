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

---

## 2. Workspace Structure (Git-style)

```text
/your-blog-workspace/               <-- Target workspace root directory
├── .emit/                          <-- [Hidden Configuration & Cache Directory]
│   ├── cache.db                    <-- SQLite local cache (node:sqlite)
│   └── config.json                 <-- Instance connection and collection settings
├── categories/                     <-- Category definitions (<id>-<label>.yaml)
├── tags/                           <-- Tag definitions (<id>-<label>.yaml)
├── media/                          <-- Media files & companion YAML (<yyyyMMdd>_<id>-<name>.<ext>)
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

These rules are enforced at the code level via Preflight Guards (G1–G12):

### 1. Prohibition of Throwaway Temporary Files
- **Never create disposable files** such as `temp.md`, `draft.md`, or `scratch.md` in the workspace.
- Always write directly to the canonical file generated by `sync_new` or pulled into the workspace.

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
- **Two distinct ID spaces (Critical):** EmDash separates **media record IDs** (`id`) from **storage keys** (`storageKey`). Never interchange them:
  - **Frontmatter `featuredImage`** uses the **26-character media record `id`** (e.g. `01M67P0MBMJQQXH2K95HHCYRYB`) or `null`. Preflight Guard **G10** rejects local file paths (`./hero.png`), made-up IDs, and malformed values before pushing.
  - **Markdown body images `![alt](...)`** use the **`storageKey`-based public route** `/_emdash/api/media/file/<storageKey>` (where `<storageKey>` is `<ulid>.<ext>` or `<ulid1>.<ulid2>.<ext>`). Passing a media record `id` into `/_emdash/api/media/file/<id>.<ext>` returns **HTTP 404**.
- **Offline draft image auto-upload (G5 / G11):**
  - Place new local images in `media/drafts/<filename>` and reference them on a **standalone line** in the Markdown body: `![alt text](../../media/drafts/<filename>)` (or `media/drafts/<filename>`).
  - Preflight Guard **G11 (`LOCAL_IMAGE_AUTO_UPLOAD`)** validates that the file exists under `media/drafts/`, has a supported image extension (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.avif`, `.svg`), and is within the 50 MiB limit. During `emit push` / `sync_push`, Emit automatically uploads the image via the 4-stage media flow (`upload-url` → `PUT` → `confirm`), rewrites the Markdown line to the canonical root-relative `/_emdash/api/media/file/<storageKey>` URL, pushes the article, and promotes the file from `media/drafts/<filename>` to `media/<yyyyMMdd>_<mediaId>-<filename>` with its companion `.yaml`. The `<yyyyMMdd>` prefix uses the media record's remote `createdAt` when Emit can read it (it is fetched for deduplicated uploads); a provisional local-date name is canonicalized by the next `emit pull-media`.
  - **Already-promoted asset reuse (never re-upload):** If a referenced draft image was already promoted by an earlier push, Emit resolves it through `media_state` and `media/*.yaml` and accepts the line, rewriting it to the existing canonical URL. The identical `![alt](../../media/drafts/<filename>)` line is therefore valid in a second article, and a direct `media/<yyyyMMdd>_<mediaId>-<name>.<ext>` reference is valid too. **Never move a promoted file back into `media/drafts/`.** Before baking a reused URL into the body, Emit verifies the record with `GET /_emdash/api/media/{id}`: a record deleted on remote aborts the push with `PROMOTED_MEDIA_NOT_FOUND_REMOTE` and purges the stale cache entry, while a server that does not implement the endpoint still pushes and reports `[MEDIA_EXISTENCE_UNVERIFIED]` as a warning.
  - **Standalone line requirement:** Because EmDash's Portable Text AST treats images as top-level blocks (`/^!\[([^\]]*)\]\(([^)]+)\)$/`), inline local images inside a text paragraph (e.g. `Text ![alt](../../media/drafts/a.png) more text`) are rejected with `INLINE_LOCAL_IMAGE_NOT_SUPPORTED`. Images inside `<!--ec:block ... -->` opaque fences are ignored by G5/G11 so Guard **G9** is preserved. Any other local image path (e.g. `./hero.png`, an absolute filesystem path, or a `media/` path that cannot be resolved to a promoted media record) is rejected by Guard **G5 (`LOCAL_IMAGE_DETECTED`)**; a `media/drafts/` reference whose file is missing and has no promoted match is rejected with `MISSING_LOCAL_IMAGE_FILE`.
  - **Only backtick fences are exempted:** G5/G11 skip image lines that sit inside ```` ``` ```` fenced code blocks (any fence length, matched by a closing fence of equal or greater length, so a body that documents Markdown examples is never inspected as real markup). Tilde fences (`~~~`) are **not** exempted, because the Portable Text mapper only treats backtick fences as code blocks — exempting `~~~` would let a local path bypass validation and still be converted into a real remote image block. Document code examples with backticks.
- **Confirmed `featuredImage` contract (live EmDash):** pushing `featured_image: { "id": "<ULID>" }` alone is accepted (HTTP 200); the server stores the media id and normalizes `"provider": "local"` itself. Never fabricate `provider`, `src`, `storageKey`, dimensions, or MIME type in a push payload.
- When the cached remote entry already points at the same ULID, Emit resends that remote object verbatim so its original provider shape (`external` with `src`, or `local` with `meta.storageKey`) is preserved instead of being re-resolved from a bare id.
- Emit canonicalizes `featuredImage` to uppercase on read, so lowercase input is safe; the local file is rewritten with the canonical form on the next pull or push.
- `featuredImage: null` clears the hero image. Omitting the field leaves the remote value untouched.
- Do not hand-write remote media URLs into `featuredImage`. A URL that contains a media ULID is accepted with a warning and resolved to the bare ULID, but the canonical frontmatter form is the bare 26-character ULID.

### 7. Rescue Copies under `posts/conflicts/` (Read-Only)

- When a pull finds local content that diverges from the last synced baseline, Emit moves the divergent file to `<collection>/conflicts/<name>.conflict.md` before writing the canonical article, so unpushed writing is never discarded.
- **Never treat a rescue copy as an article**: `getWorkspaceStatus` / `emit status` scan only `draft/` and `published/`, count `conflicts/` separately (`summary.conflicts`), and `pushAll` never selects it.
- **Never push a rescue copy**: Guard **G12** (`QUARANTINED_COPY_NOT_PUSHABLE`) refuses it before any network request. Read the copy, merge the valuable lines into the canonical article, then delete the copy. To intentionally replace the remote version, copy the rescue file over the canonical path and push that canonical path instead.
- **Never create files in `conflicts/` yourself** and never move a rescue copy back into `draft/` or `published/` with `mv`; merge its content into the canonical file instead.

---

## 5. Development & Code Quality Standards

- All new features and bug fixes must include unit tests under `tests/` using Vitest.
- Run `npm run check` (`format:check`, `typecheck`, and `test`) before committing.
- Ensure 100% clean exit (zero errors, all tests green).
- `tsconfig.json` builds `src/` only (tests excluded). `tsconfig.test.json` type-checks `src/` **and** `tests/` and is wired into `npm run typecheck`, so test files are fully typed and editors resolve `node:*` imports correctly. Do not add `@types/node`; it is already configured via `"types": ["node"]`.
- **MCP tool error contract**: every MCP tool handler must convert failures into `formatToolError(error)` (`src/mcp/tool-errors.ts`) instead of letting the callback throw. The MCP SDK catches a thrown error and returns only `error.message`, which silently drops the `[CODE]`, HTTP status, endpoint, `💡 Suggestion`, and `PushValidationError.errors` payload that CLI users see. This applies to **context resolution too**: `resolveContext()` can throw `AmbiguousProfileError` or workspace errors, so call it inside the guarded `try` (`tests/mcp_tool_errors.test.ts` asserts this for all context tools). Profile tools must read/write the same `profilesPath` that `createMcpServer` forwards, so an embedded server never lists profiles it cannot resolve.
- **Baseline serialization invariant**: `base_snapshots` stores the frontmatter as **JSON-encoded** `Frontmatter` (column `frontmatter_yaml`, despite the name) plus the Markdown body. `emit diff` / `sync_diff` rebuilds the baseline with `serializeMarkdown(JSON.parse(frontmatterYaml), bodyMarkdown)`, and that result must remain byte-identical to what `pull` / `push` write to disk, otherwise untouched articles report phantom diffs and the 3-way merge baseline drifts. Any change to `formatFrontmatterYaml` / `serializeMarkdown` output must be made together with that reconstruction. `saved_at` is stored in epoch **seconds** (multiply by `1000` when rendering JS dates).
- **YAML scalar quoting rule (`formatYamlScalar`)**: `formatFrontmatterYaml` formats `id`, `slug`, `collection`, `locale`, `taxonomies` terms, and `bylines` through `formatYamlScalar(value)`. Standard ASCII/CJK identifiers (`^[\p{L}\p{N}_][\p{L}\p{N}._/-]*$` that are not pure numbers, ISO dates, or YAML reserved literals) stay unquoted to preserve baseline hash compatibility, while `%`-prefixed strings (such as percent-encoded Japanese taxonomy slugs like `"%e6%9c%aa%e5%88%86%e9%a1%9e"`), strings containing `%` or YAML punctuation, pure numbers/all-digit ULIDs, ISO dates, and reserved words (`true`, `null`, `yes`, etc.) are quoted via `JSON.stringify`. Never emit raw unquoted scalars in `formatFrontmatterYaml`, as leading `%` is a YAML 1.2 directive indicator and will corrupt every article that uses percent-encoded taxonomy slugs. Cached `invalid` files are automatically self-healed by batch `emit pull` / `sync_pull`; uncached `invalid` files outside the sliding window (`cached: false` in `getWorkspaceStatus`) are repaired by targeting their ULID explicitly via `emit pull <ULID>` or `sync_pull(id: "<ULID>")`.
- **Origin resolution invariant**: the effective `origin` is decided only by `resolveOriginPriority()` (`src/cli/context.ts`), which the MCP server also uses, so CLI and MCP can never disagree. Ranking is explicit `--profile` > `EMDASH_ORIGIN` > auto-resolved profile > resolved auth origin > `.emit/config.json` > `DEFAULT_ORIGIN`, and every higher-precedence source that overrides a lower one must emit a warning naming the real source. `loadConfig()` therefore keeps `EMDASH_ORIGIN` in the separate `envOrigin` field and never writes it into `.emit/config.json`; never collapse the two again or a warning will mislabel a file value as an env value. Profile workspace matching goes through `resolveDirectoryForComparison()` (`fs.realpathSync`) so symlinked workspaces still match. Tests must stay hermetic: `tests/setup/env-isolation.ts` (wired as a vitest `setupFiles` entry) deletes `EMDASH_ORIGIN`, `EMDASH_WORKSPACE`, `EMDASH_TOKEN`, and `EMDASH_API_TOKEN` before every file, so a developer's ambient env cannot change how profiles resolve inside the suite.
