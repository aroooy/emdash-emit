# Emit (`emdash-emit`)

[![CI](https://github.com/aroooy/emdash-emit/actions/workflows/ci.yml/badge.svg)](https://github.com/aroooy/emdash-emit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/emdash-emit.svg)](https://www.npmjs.com/package/emdash-emit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)

**Emit** is an AI-first local authoring workspace and bidirectional synchronization tool for [EmDash](https://github.com/aroooy/emdash) (Cloudflare Workers + D1 + R2). It provides a full-featured CLI and a Model Context Protocol (MCP) server designed for autonomous coding agents (Google Antigravity, Claude Code, Cursor) and human writers.

---

## 📑 Table of Contents

- [Why Emit?](#-why-emit)
- [1-Minute Daily Workflow](#-1-minute-daily-workflow)
- [Overview & Architecture Philosophy](#-overview--architecture-philosophy)
- [Key Features](#-key-features)
- [Installation](#-installation)
- [Initial Setup & Profiles](#-initial-setup--profiles)
  - [6. Recommended `.gitignore`](#6-recommended-gitignore)
- [Workspace Structure & Data Model](#-workspace-structure--data-model)
- [Markdown, Frontmatter & The 4-Step Golden Path](#-markdown-frontmatter--the-4-step-golden-path)
- [CLI Commands Overview](#-cli-commands-overview)
- [Model Context Protocol (MCP) Support](#-model-context-protocol-mcp-support)
- [Authoritative Documentation & Architecture Specs (`docs/`)](#-authoritative-documentation--architecture-specs-docs)
- [Development, Testing & License](#-development-testing--license)

---

## 💡 Why Emit?

- **🛡️ Zero-Cost AI Iteration (Defend Cloudflare D1 Limits)**:
  When AI agents (like Google Antigravity, Cursor, or Claude Code) interact directly with a remote CMS, their rapid, iterative read/search/edit loops can quickly exhaust API quotas (such as Cloudflare D1 daily read/write limits). Emit trades a **one-time upfront sync cost** (an initial `emit pull` or full-library `emit snapshot` performs a batch read to populate `.emit/cache.db` via `node:sqlite`) for **zero network requests during iteration and minimal delta on sync**—agents can search (`snapshot`-first), diff, validate guards, and iterate thousands of times locally, syncing only the final reviewed delta via a distributed lock and 3-way merge.
- **✈️ True Offline Authoring & Media Staging**:
  Web editors struggle on flights or unstable Wi-Fi, especially with image uploads. With Emit, place new images in `media/drafts/`, write Markdown in VS Code or Obsidian with relative image preview (`../../media/...`), and push when back online—Emit handles the upload → confirm → promote R2 pipeline and URL rewrite automatically. You can even cache existing remote media binaries (`emit snapshot --include-media`) for full offline restoration via `emit pull --from-snapshot`.
- **🔒 20 Code-Level Guardrails for AI Agents (G1–G20)**:
  Autonomous agents can accidentally publish unfinished drafts or hallucinate taxonomy slugs if given raw CMS APIs. Emit enforces 20 physical preflight guardrails before any write—blocking unapproved live publishing without `--allow-publish` / `allowPublish: true` (**G3**), invalid taxonomy terms (**G4**), manual `mv` corruption (**G2**), and deleting in-use media (**G20**).

---

## 🚀 1-Minute Daily Workflow

Your day-to-day writing workflow takes just 4 steps:

1. **Initialize once**: `emit profile add <name> --origin https://your-site.example --token <token>` and `emit init`
2. **Pull latest state**: `emit pull` (syncs recent posts, taxonomies, and referenced media)
3. **Write & iterate offline**: Edit Markdown in VS Code / Obsidian or run local CLI / MCP checks (`0-HTTP` search, diff, and guard validation)
4. **Push safely**: `emit push` (uploads `media/drafts/*`, acquires a distributed lock, and 3-way merges)

> **Using Cursor, Claude Desktop/Code, or Antigravity via MCP?** Copy-paste the 6-line stdio config in [MCP Client Configuration](#mcp-client-configuration-claude_desktop_configjson--cursormcpjson--mcp_configjson).

---

## 💡 Overview & Architecture Philosophy

EmDash is a modern serverless headless CMS built on Cloudflare Workers, D1, and R2. **Emit** turns any local directory into a Git-like local authoring workbench, allowing you and AI coding agents to draft, inspect, diff, and publish Markdown articles with strict safety guardrails.

```text
  ┌─────────────────── Local Workspace (0 Network / 0 D1) ───────────────────┐
  │                                                                          │
  │   AI Agents (Google Antigravity / Cursor / Claude Code)                  │
  │        ▲                                                                 │
  │        │ MCP (17 tools) / CLI                                            │
  │        ▼                                                                 │
  │   Emit Engine + Local SQLite (.emit/cache.db Staging Desk)               │
  │        ▲                                                                 │
  │        │ Markdown + media/ (VS Code / Obsidian)                          │
  └────────┼─────────────────────────────────────────────────────────────────┘
           │
           │  emit pull / snapshot  (Batch Read)
           │  emit push             (Lock + 3-Way Merge Delta)
           ▼
  ┌────────────────────── Cloudflare (Online Remote) ────────────────────────┐
  │   EmDash CMS  (Cloudflare Workers  +  D1 SQL  +  R2 Media)               │
  └──────────────────────────────────────────────────────────────────────────┘
```

### The "Staging Desk" Philosophy & Non-Goals

- **What Emit IS (Core Goal)**:
  - An **active authoring and editing workbench (Staging Desk)** where human authors and AI agents collaborate safely.
  - A Local-First workflow with **automatic offline draft image upload** (`media/drafts/`), **article-relative image preview** (`../../media/<storageKey>`), **distributed mutex locks**, **Hybrid 3-Way Merge**, and **20 preflight safety guards (G1–G20)**.
- **What Emit is NOT (Deliberate Non-Goals)**:
  - **Not a full-site database dumper**: Emit maintains a bounded sliding window of recent articles on disk (default: **latest 30 published + 30 drafts**, configurable via `postsSyncLimit` in `.emit/config.json`), pruning older clean files to keep local searches and AI context windows fast.
  - **Every historical article remains 100% reachable on demand**: Use `emit article-search` to find any past post by keyword, tag, category, or date range, then pull it on demand via `emit pull <ULID>`. If an out-of-window article has unpushed local edits, Emit's **Unpushed Edits Safeguard** aborts pruning immediately (`SyncPruneConflictError`) to guarantee zero data loss.

### Division of Labor with the Official EmDash MCP

Emit and the [Official EmDash MCP server](https://github.com/aroooy/emdash) are designed to work side by side against the same site:

| Operation | Right Tool |
| --- | --- |
| Drafting, reviewing, diffing, and publishing articles with safety guards (G1–G20), locks & 3-way merge | **Emit** (`emit pull` / `emit push`, MCP `sync_*` tools) |
| Finding and targeting past articles or media assets (with local mirror status & offline body search) | **Emit** (`emit article-search` / `emit media-search`) |
| On-demand retrieval of any single historical article by ULID | **Emit** (`emit pull <id>`) |
| Bulk media library management (mass upload, mass delete) or arbitrary site-wide collection queries | **Official EmDash MCP** / EmDash Admin Dashboard |

---

## 🌟 Key Features

### 1. Lossless Portable Text ⇔ Markdown Bidirectional Sync (3-Tier AST Engine)

Most headless CMS tools only support one-way Markdown import or strip custom styling attributes on round-trip. Emit implements a **3-Tier Portable Text AST engine** that converts standard prose cleanly while protecting rich CMS layout attributes from destructive resets:

```text
  Remote EmDash Portable Text AST (JSON Blocks)
  ├── Tier 1 & 2: Headings, Lists, Marks, GFM Tables, Thematic Breaks (---)
  │     + Plain Images ──► Track A: ![alt](../../media/<storageKey>)  [🖼️ Offline Editor Preview]
  └── Tier 3: Styled Images (alignment, displayWidth, caption) & Custom Blocks (core:gallery)
        ──► Track B: <!--ec:block {"_type":"image","alignment":"left",...} --> [🔒 Protected by Guard G9]
```

- **GFM Tables & Thematic Breaks**: Pipe tables (`| col |`) and horizontal rules (`---`) round-trip losslessly to EmDash Portable Text `table` and `thematicBreak` blocks.
- **Dual-Track Image & Custom Block Fidelity**: Plain images serialize as standard Markdown (`Track A`) for immediate preview in VS Code / Obsidian, while styled images (`alignment`, `displayWidth`, `caption`) and custom EmDash blocks automatically fall back to single-line opaque comment fences (`Track B`, `<!--ec:block {...} -->`) guarded by **G9 (`MODIFIED_OPAQUE_BLOCK`)** so server-side layout is never lost on push.

### 2. True Local-First Offline Authoring & Two-Layer Representation

Emit separates **Layer A (canonical server & baseline data)** from **Layer B (human- & editor-friendly disk files)**:

- **Offline Image Preview with Zero Phantom Diffs (`localMediaRefs: true`)**: On disk, mirrored body images are written as article-relative paths (`../../media/<storageKey>`, resolving to local mirror `media/<markdownRef>.<ext>`), so Markdown preview works 100% offline. In `.emit/cache.db` (`base_snapshots`) and remote payloads, Emit preserves the canonical `/_emdash/api/media/file/<storageKey>` URL—meaning `emit diff` and `emit status` never report false diffs.
- **Automated Offline Draft Image Pipeline (`media/drafts/`)**: Drop new images into `media/drafts/<filename>`, reference them on a standalone line (`![alt](../../media/drafts/<filename>)` or in `featuredImage`), and run `emit push`. Emit automatically executes EmDash's 4-stage upload (`upload-url` → `PUT` → `confirm`), rewrites the link, and moves the file to `media/<markdownRef>.<ext>` (+ `.yaml` companion), reusing already-promoted assets across articles without re-uploading.
- **Human-Readable Decoded CJK Taxonomies**: Server-side percent-encoded slugs (`"%e6%9c%aa%e5%88%86%e9%a1%9e"`) are rendered on disk as readable decoded Unicode (`未分類`) while retaining canonical encoding in baseline snapshots and API requests.

### 3. CMS-Grade Concurrency, Two-Track Revisions & Structure-Aware 3-Way Merge

- **Uncommitted Draft Revisions on Published Articles (`published*`)**: When a live published article is edited and saved as an unpublished draft in the EmDash Web Admin, Emit detects it via **Two-Track Revisions** (separating raw transport `_rev` from composite comparison keys `${version}@draft:${draftRevisionId}`). The file stays in `posts/published/` with `status: published # draft revision` (`published* [has unpublished draft]` in `emit status`): a normal `emit push` updates the remote draft, while `--allow-publish` publishes it live.
- **Structure-Aware Hybrid 3-Way Merge & Distributed Locks**: Acquires a 7-minute mutual exclusion lease (`POST /lock`) before writing. If concurrent edits occur, Emit performs a 3-way merge across three distinct structural dimensions—**(1) YAML Frontmatter key-by-key**, **(2) Taxonomy categories/tags as mathematical sets** (with pre-PUT remote taxonomy auditing), and **(3) Markdown body line-by-line via `node-diff3`**—while rescuing divergent local files to `posts/conflicts/`.

### 4. Hardened for Autonomous AI Agents (20 Guardrails & Epistemic Search)

- **20 Code-Level Preflight & Sync Guardrails (G1–G20)**: Physically blocks AI agent accidents before any network request—preventing unapproved live publishing (**G3**), hallucinated category/tag names (**G4**), manual `mv` filename corruption (**G2**), pushing quarantined conflict copies (**G12**), accidental taxonomy wipes (**G19**), or deleting in-use media (**G20**).
- **Snapshot-First Exhaustive Search (`snapshotStatus` Framing) & 0-GET Self-Healing**: `emit article-search` and `emit media-search` search 100% of the local workspace + `.emit/cache.db` snapshot with zero network calls (with explicit `fresh` / `stale` / `missing` coverage framing and optional `--live` keyword-only FTS for articles). On pull, untouched local articles self-heal deleted remote taxonomy terms and legacy spellings on the **0-GET fast path**.
- **Zero-Friction Multi-Site Profiles & Zero Native Dependencies**: Auto-detects the target EmDash site from your current working directory (`~/.config/emit/profiles.yaml`) and runs on Node.js 22+ built-in `node:sqlite` (`DatabaseSync`) with zero C++ `node-gyp` dependencies.

---

## 📦 Installation

Requires **Node.js v22.0.0** or higher.

```bash
# Global installation via npm (Recommended)
npm install -g emdash-emit
emit --version

# Or run directly via npx
npx emdash-emit status
```

---

## 🚀 Initial Setup & Profiles

### 1. Register a Profile & Initialize Your Workspace

```bash
# 1. Register your EmDash instance and Personal Access Token (stored in ~/.config/emit/profiles.yaml with 0600 permissions)
emit profile add my-blog \
  --origin https://your-blog.example.com \
  --token <your-personal-access-token> \
  --workspace /path/to/local/blog-repo

# 2. Initialize the workspace (.emit/config.json, .emit/cache.db, and .emit/.gitignore)
cd /path/to/local/blog-repo
emit init

# 3. (Optional) Verify credentials against the remote server
emit doctor --check-auth
```

### 2. Multi-Site Management & Token Rotation

When you manage multiple blogs (e.g., `personal` and `work`), link each profile to its `--workspace` directory. Emit automatically selects the matching profile based on your current working directory (`emit profile current` shows the exact `Resolved by: ...` rationale).

To rotate a token safely without exposing secrets in shell history or touching other profile settings:

```bash
# Interactive prompt with terminal echo disabled
emit profile set-token my-blog

# Or pipe directly from macOS Keychain / secret manager
security find-generic-password -s emdash-pat -w | emit profile set-token my-blog --stdin
```

> For details on the 4-tier authentication chain, automatic OAuth 401 token refresh, origin resolution precedence, and `.emit/config.json` options (`postsSyncLimit`, `mediaSyncLimit`, `localMediaRefs`, `concurrency`), see **[docs/architecture-and-layers.md](docs/architecture-and-layers.md)**.

### 6. Recommended `.gitignore`

`emit init` automatically generates `.emit/.gitignore` to exclude the machine-local SQLite database (`cache.db*`, `mcp_state.json`). For your root repository `.gitignore`, use the following configuration:

```gitignore
# Emit Local Cache Database (Strictly exclude binary SQLite DBs)
.emit/cache.db*
.emit/*.db*
*.db
*.db-wal
*.db-shm

# OS & Editor temporary files
.DS_Store
Thumbs.db
Temp/
tmp/

# Optional: Media binaries (Uncomment if you prefer not to commit large images to Git)
# media/*.jpg
# media/*.png
# media/*.webp
# media/*.avif
# media/*.mp4
```

- **`.emit/cache.db*`** must be excluded from Git (machine-local SQLite state).
- **`.emit/config.json`** and **`media/*.yaml`** can be safely committed to Git (tokens live outside the repo in `~/.config/emit/profiles.yaml`).

---

## 📂 Workspace Structure & Data Model

```text
your-blog/
├── .emit/                          # Workspace config (config.json) & SQLite baseline cache (cache.db)
├── categories/                     # Category YAML definitions (<id>-<label>.yaml; decoded slug + canonicalSlug)
├── tags/                           # Tag YAML definitions (<id>-<label>.yaml; decoded slug + canonicalSlug)
├── media/                          # Mirrored media (<markdownRef>.<ext> + .yaml; named after storageKey)
│   ├── drafts/                     # Staging folder for offline draft images (auto-uploaded & moved on push)
│   └── _cache/                     # Opt-in offline media cache (via snapshot --include-media; gitignored)
└── posts/                          # Local Markdown Articles (<yyyyMMdd>_<ulid>-<title>.md)
    ├── draft/                      # Draft articles
    ├── published/                  # Live published articles (includes published* with "# draft revision")
    └── conflicts/                  # Read-only rescue copies (.conflict.md, .deleted.md) — never pushed
```

> [!IMPORTANT]
> **Two Media Identifier Spaces (`id` vs `storageKey`)**:
> Every EmDash media asset has two unrelated 26-character ULIDs:
> - **Media Record `id`** (D1 primary key): Used in frontmatter `featuredImage: "01M67P0MBMJQQXH2K95HHCYRYB"` and `GET /_emdash/api/media/{id}`.
> - **Media `storageKey`** (R2 object key): Used in Markdown body URLs (`/_emdash/api/media/file/<storageKey>`) and local mirror filenames (`media/<markdownRef>.<ext>`).
>
> Never interchange them. See **[docs/media-id-spaces.md](docs/media-id-spaces.md)** and **[docs/media-pipeline.md](docs/media-pipeline.md)** for full details.

---

## 📝 Markdown, Frontmatter & The 4-Step Golden Path

### The Authoring Workflows (New Posts vs. Revising Past Posts & 2-Stage Push)

Emit supports two primary entry flows—**Workflow A (One-Shot New Draft)** and **Workflow B (Discovering & Revising Existing/Historical Posts)**—both converging into offline Markdown authoring and a **2-Stage Push** (Draft Staging → Live Publish):

```text
  [0. SYNC WORKSPACE]  emit pull  (Syncs latest 30+30 posts, categories/tags & referenced media)
           │
           ├─────────────────────────────────────────────┐
           ▼ (Workflow A: Create New Post)               ▼ (Workflow B: Revise Existing / Past Post)
  [1A. ONE-SHOT SCAFFOLD]                       [1B. DISCOVER & TARGET]
   emit new <slug> -t "Title" \                  • Recent (in window): inspect "emit status"
     -C tech -T ai -d "SEO desc" \               • Older (outside 30-post window):
     -f "../../media/drafts/cover.jpg"               emit article-search "keyword" --tag ai
   (Generates schema-valid YAML in 1 step;           ──► emit pull <26-char-ULID>
    no manual frontmatter YAML editing!)         (Pulls post + mirrors its images on demand)
           │                                             │
           └─────────────────────┬───────────────────────┘
                                 ▼
  [2. OFFLINE AUTHORING & MEDIA STAGING]
   • Edit Markdown body in VS Code / Obsidian / Cursor (images preview offline via ../../media/)
   • New local images: drop in media/drafts/<file> & reference as ![alt](../../media/drafts/<file>)
   • Existing remote images: find via "emit media-search [--since today | --offline]"
   • Preserved blocks: keep <!--ec:block {...} --> lines intact (layout/styling protected by G9)
                                 │
                                 ▼
  [3. DIFF & 2-STAGE PUSH (Draft Staging ──► Live Publish)]
   • Inspect changes:  emit diff <file>
   • Stage as Draft:   emit push <file>
                       (Auto-uploads media/drafts/* -> moves to media/, acquires 7-min lock,
                        3-way merges if needed, and saves draft on EmDash.
                        *Even on a live published post, bare "emit push" safely stages an
                         unpublished draft revision [published*] without altering live!*)
   • Publish Live:     Set "status: published" in frontmatter, then run:
                       emit push <file> --allow-publish
```

### Canonical Frontmatter Example

```yaml
---
id: 01M6ABCDEF1234567890123456 # 26-char canonical ULID (auto-generated; DO NOT EDIT)
slug: building-ai-powered-cms-tools
title: 'Building AI-Powered CMS Tools'
collection: posts
status: draft # "draft" or "published"
publishedAt: null
locale: ja
featuredImage: '01M67P0MBMJQQXH2K95HHCYRYB' # 26-char media record ULID, "../../media/drafts/cover.jpg", or null
taxonomies: # Always nest categories and tags under taxonomies:
  categories:
    - 未分類
  tags:
    - typescript
    - ai
seo:
  title: null
  description: 'A complete guide to AI-driven CMS workflows'
  canonical: null # Full https://... URL or null
  noIndex: false
  image: null
bylines:
  - aroooy
---
Write your Markdown body here (do not repeat `# Building AI-Powered CMS Tools` at the top)...

![Offline Draft Image](../../media/drafts/diagram.png)
```

### Key Content & Safety Rules

1. **Always nest `categories` and `tags` under `taxonomies:`** (top-level keys are stripped by schema validation).
2. **Never rename or move files with `mv`** (Guard **G2**): Update `title`, `slug`, or `status` in frontmatter and run `emit push`; Emit relocates the file automatically.
3. **Offline Draft Images (`media/drafts/`)**: Place new images in `media/drafts/<file>` and reference them on a standalone line (`![alt](../../media/drafts/<file>)`). On `emit push`, Emit uploads the image, rewrites the link, and moves the file to `media/<markdownRef>.<ext>`.
4. **Dual-Track Images & Preserved Blocks (`<!--ec:block ... -->`)**: Plain images render as standard Markdown (`Track A`), while styled images (`alignment`, `displayWidth`) and custom blocks are wrapped in `<!--ec:block ... -->` comment fences (`Track B`) protected by Guard **G9**. Do not tamper with opaque comment fences.
5. **Publishing Live (Guard G3)**: Promoting to `status: published` (or publishing a draft revision on a `published*` article) requires `--allow-publish`.

> For the complete table of **Safety Guardrails (G1–G20)** and AST conversion rules, see **[docs/safety-guards-and-diagnostics.md](docs/safety-guards-and-diagnostics.md)** and **[docs/markdown-and-ast.md](docs/markdown-and-ast.md)**.

---

## 🛠 CLI Commands Overview

Emit provides **17 top-level CLI commands** (plus **10 subcommands** under `profile` and `conflicts`). For all flags, parameters, and output examples, see **[docs/cli-and-mcp-reference.md](docs/cli-and-mcp-reference.md)**.

| Command | Summary | Common Example |
| --- | --- | --- |
| `emit init` | Initialize workspace (`.emit/config.json`, `cache.db`, `.emit/.gitignore`) or re-link a moved folder | `emit init` / `emit init --profile work` |
| `emit profile` | Manage site profiles (`list`, `add`, `current`, `set-token`, `remove`, `use`) | `emit profile add blog --origin <url> --workspace .` |
| `emit new <slug>` | Scaffold a new draft offline with ULID, one-shot frontmatter & G18 duplicate-slug guard | `emit new my-post -t "Title" -C tech -T ai` |
| `emit pull [target]` | Pull sliding window (articles + taxonomies + referenced media) or a single article by ULID/path | `emit pull` / `emit pull 01M6ABCDEF...` |
| `emit push [file]` | Validate (G1–G20), upload `media/drafts/*`, acquire lock, 3-way merge, and push to EmDash (auto-targets a single modified article with TTY confirmation or `-y`) | `emit push` / `emit push posts/draft/20261104_01M6...md` |
| `emit status` | Inspect workspace sync status (`synced`, `published*`, `modified`, `untracked`, `invalid`) | `emit status` / `emit status --search "AI"` |
| `emit diff [file]` | Show unified diff between local working file(s) and reconstructed baseline snapshot (omit `[file]` to diff all modified articles) | `emit diff` / `emit diff posts/draft/20261104_01M6...md` |
| `emit delete <target>` | Delete article locally & remotely after creating a `.deleted.md` backup in `posts/conflicts/` | `emit delete <file> --allow-delete-published` |
| `emit conflicts` | Inspect and resolve rescue copies in `posts/conflicts/` (`list`, `diff`, `resolve`, `prune`) | `emit conflicts list` / `emit conflicts resolve <path> --accept-local` |
| `emit doctor` | Run offline workspace health checks + opt-in probes (`--check-auth`, `--check-media-library`, `--check-media-urls`) | `emit doctor` / `emit doctor --check-auth` |
| `emit article-search [q]` | Exhaustive 0-HTTP search across local Markdown and `snapshot_articles` (or keyword-only remote FTS via `--live`) | `emit article-search "Cloudflare" --tag ai --since 2026-01-01` / `emit article-search "Cloudflare" --live` |
| `emit media-search [q]` | Exhaustive 0-HTTP search across local mirrors and `snapshot_media` by keyword and date range | `emit media-search "header" --mirrored-only` |
| `emit pull-taxonomies` | Standalone download of remote categories and tags into `categories/*.yaml` and `tags/*.yaml` | `emit pull-taxonomies` |
| `emit pull-media` | Mirror media assets by `--article <id>`, `--storage-key <key>`, or bounded library window | `emit pull-media --article 01M6ABCDEF...` |
| `emit snapshot` | Capture full-library metadata snapshot (`articles`, `media`, `taxonomies`) into `cache.db` and optionally cache media binaries | `emit snapshot --include-media` / `emit snapshot --status` |
| `emit guide` | Print the concise Golden Path cheat sheet and AI safety rules to the console | `emit guide` |
| `emit mcp` | Launch Emit as a Model Context Protocol (MCP) stdio server for AI coding agents | `emit mcp` |

---

## 🤖 Model Context Protocol (MCP) Support

Emit includes a first-class stdio MCP server so AI coding agents (**Google Antigravity**, **Claude Code / Claude Desktop**, **Cursor**) can autonomously manage and author EmDash content.

### MCP Client Configuration (`claude_desktop_config.json` / `.cursor/mcp.json` / `mcp_config.json`)

```json
{
  "mcpServers": {
    "emit": {
      "command": "emit",
      "args": ["mcp"]
    }
  }
}
```

*(If Emit is not installed globally, use `"command": "npx", "args": ["-y", "emdash-emit", "mcp"]`.)*

### Available MCP Tools (17 Tools)

Every tool attaches structured `_meta` (`profile`, `workspace`, `origin`, `resolvedBy`) and returns actionable error codes and remediation hints. See **[docs/cli-and-mcp-reference.md](docs/cli-and-mcp-reference.md)** for full parameter schemas.

| Tool | Purpose |
| --- | --- |
| `sync_status` | Inspect local workspace tracking status, summary counts, and `actionRequired` files |
| `sync_diff` | View unified diff between local working file and baseline snapshot |
| `sync_new` | Scaffold new draft article offline with canonical ULID, one-shot metadata, and taxonomy hints |
| `sync_pull` | Pull batch sliding window (articles + taxonomies + referenced media), single article by `id`/`filePath`, or offline `fromSnapshot: true` |
| `sync_push` | Push local article changes with preflight guards (G1–G20), distributed lock, 3-way merge, and `media/drafts/*` auto-upload |
| `sync_delete` | Safely delete an article locally and remotely with `.deleted.md` rescue backup |
| `sync_conflicts` | `list`, `diff`, `resolve`, or `prune` quarantined rescue copies in `posts/conflicts/` |
| `sync_doctor` | Run workspace diagnostics (offline by default; opt-in `checkAuth`, `checkMediaLibrary`, `checkMediaUrls`) |
| `sync_article_search` | Exhaustive 0-HTTP search across local Markdown and `snapshot_articles` (`snapshotStatus` framing), or keyword-only remote FTS with `live: true` |
| `sync_media_search` | Exhaustive 0-HTTP search across local mirrors and `snapshot_media` (`snapshotStatus` framing) by keyword and date range |
| `sync_pull_taxonomies` | Standalone sync of remote category and tag YAML definitions |
| `sync_pull_media` | Mirror media assets by `article`, `storageKey`, or bounded library window |
| `sync_push_media` | Upload standalone local image files (`media/drafts/*` or external) and/or sync `alt`/`caption` metadata |
| `sync_delete_media` | Delete unreferenced media assets with Guard G20 (`MEDIA_IN_USE_PROTECTION`) and `media/_trash/` backup |
| `sync_snapshot` | `capture`, `status`, `clear`, or `prune-cache` for full-library metadata snapshots and opt-in `media/_cache/` binaries in `cache.db` |
| `profile_list` | List all configured EmDash connection profiles and resolution rationale |
| `profile_switch` | Switch active session/default profile for multi-site environments |

---

## 📚 Authoritative Documentation & Architecture Specs (`docs/`)

Detailed specifications, subsystem designs, and troubleshooting guides are organized by domain boundary under **[docs/](docs/README.md)**:

1. **[Architecture, Layering & Infrastructure (`docs/architecture-and-layers.md`)](docs/architecture-and-layers.md)** — 4-tier layering rules (Axes 0–5), Workspace Contracts, Profile/Auth/Origin resolution precedence, SQLite `cache.db` schema (v8), and CLI/MCP presentation symmetry.
2. **[Sync Engine, Revisions & 3-Way Merge (`docs/sync-engine-and-revisions.md`)](docs/sync-engine-and-revisions.md)** — Modular Pull (6 stages) & Push (10 modules), Two-Track Revision model (`revForTransport` vs `revForComparison`), `published*` draft revisions, distributed locks, Hybrid 3-Way Merge, and `posts/conflicts/` quarantine lifecycle.
3. **[Markdown, Frontmatter & Portable Text AST (`docs/markdown-and-ast.md`)](docs/markdown-and-ast.md)** — `FrontmatterSchema`, `parseMarkdownLenient` self-healing, YAML scalar quoting, baseline reconstruction, Portable Text conversion, and Dual-Track Image Model (Tier 1 vs Tier 3 `<!--ec:block ... -->`).
4. **[Local-First Media Pipeline (`docs/media-pipeline.md`)](docs/media-pipeline.md)** — `media/drafts/` auto-upload & promotion, `localMediaRefs` relative path localization, `storageKeyToMarkdownRef` mirror naming, and remote-authoritative media pruning.
5. **[Two Media ID Spaces: `id` vs `storageKey` (`docs/media-id-spaces.md`)](docs/media-id-spaces.md)** — Authoritative specification of D1 record `id` vs R2 `storageKey`, endpoint lookup matrices, and migrated-corpus behavior.
6. **[Taxonomies (Two-Layer Representation) & Bylines (`docs/taxonomies-and-bylines.md`)](docs/taxonomies-and-bylines.md)** — Layer A percent-encoded slugs vs Layer B decoded CJK display, collision resolution, 0-GET deleted taxonomy auto-healing, pre-PUT remote taxonomy audit, and author bylines.
7. **[Safety Guardrails (G1–G20), Diagnostics, Search & Troubleshooting FAQ (`docs/safety-guards-and-diagnostics.md`)](docs/safety-guards-and-diagnostics.md)** — Complete G1–G20 guard table, `emit doctor` checks, snapshot-first search rules (`snapshotStatus`), and Troubleshooting FAQ.
8. **[CLI Command & MCP Tool Complete Reference (`docs/cli-and-mcp-reference.md`)](docs/cli-and-mcp-reference.md)** — Full option reference and output examples for all 16 CLI commands (+10 subcommands) and 14 MCP tools.
9. **[npm Publish Guide (`docs/npm-publish-guide.md`)](docs/npm-publish-guide.md)** & **[Historical Implementation Plans (`docs/plans/`)](docs/README.md)** — Release workflow and archived design plans (`v0.1.012` – `v0.1.046`).

---

## 🧪 Development, Testing & License

```bash
# Run unit test suite (Vitest)
npm test

# Run TypeScript strict typecheck (src + tests)
npm run typecheck

# Check circular dependencies (Madge)
npm run check:cycles

# Run complete CI verification gate (format:check + typecheck + check:cycles + test)
npm run check
```

This project is open-source software licensed under the [MIT License](LICENSE).  
Copyright (c) 2026 SPORT-SERVICE RS★R. All rights reserved.
