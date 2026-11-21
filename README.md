# Emit (`emdash-emit`)

[![CI](https://github.com/aroooy/emdash-emit/actions/workflows/ci.yml/badge.svg)](https://github.com/aroooy/emdash-emit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/emdash-emit.svg)](https://www.npmjs.com/package/emdash-emit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)

**Emit** is an AI-first local authoring workspace and bidirectional synchronization tool for [EmDash](https://github.com/aroooy/emdash) (Cloudflare Workers + D1 + R2). It provides a full-featured CLI and a Model Context Protocol (MCP) server designed for autonomous coding agents (Google Antigravity, Claude Code, Cursor) and human writers.

---

## 📑 Table of Contents

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

## 💡 Overview & Architecture Philosophy

EmDash is a modern serverless headless CMS built on Cloudflare Workers, D1, and R2. **Emit** turns any local directory into a Git-like local authoring workbench, allowing you and AI coding agents to draft, inspect, diff, and publish Markdown articles with strict safety guardrails.

```text
┌───────────────────────┐                    ┌─────────────────────────┐
│   Local Workspace     │   emit push / pull │   Remote EmDash Server  │
│  posts/draft/*.md     │ ◄────────────────► │   Cloudflare Workers    │
│  posts/published/*.md │   (AST + Frontmatter)│   Cloudflare D1 SQL     │
│  media/* + cache.db   │                    │   Cloudflare R2 Media   │
└───────────────────────┘                    └─────────────────────────┘
```

### The "Staging Desk" Philosophy & Non-Goals

- **What Emit IS (Core Goal)**:
  - An **active authoring and editing workbench (Staging Desk)** where human authors and AI agents collaborate safely.
  - A Local-First workflow with **automatic offline draft image upload** (`media/drafts/`), **article-relative image preview** (`../../media/<storageKey>`), **distributed mutex locks**, **Hybrid 3-Way Merge**, and **19 preflight safety guards (G1–G19)**.
- **What Emit is NOT (Deliberate Non-Goals)**:
  - **Not a full-site database dumper**: Emit maintains a bounded sliding window of recent articles on disk (default: **latest 30 published + 30 drafts**, configurable via `postsSyncLimit` in `.emit/config.json`), pruning older clean files to keep local searches and AI context windows fast.
  - **Every historical article remains 100% reachable on demand**: Use `emit article-search` to find any past post by keyword, tag, category, or date range, then pull it on demand via `emit pull <ULID>`. If an out-of-window article has unpushed local edits, Emit's **Unpushed Edits Safeguard** aborts pruning immediately (`SyncPruneConflictError`) to guarantee zero data loss.

### Division of Labor with the Official EmDash MCP

Emit and the [Official EmDash MCP server](https://github.com/aroooy/emdash) are designed to work side by side against the same site:

| Operation | Right Tool |
| --- | --- |
| Drafting, reviewing, diffing, and publishing articles with safety guards (G1–G19), locks & 3-way merge | **Emit** (`emit pull` / `emit push`, MCP `sync_*` tools) |
| Finding and targeting past articles or media assets (with local mirror status & offline body search) | **Emit** (`emit article-search` / `emit media-search`) |
| On-demand retrieval of any single historical article by ULID | **Emit** (`emit pull <id>`) |
| Bulk media library management (mass upload, mass delete) or arbitrary site-wide collection queries | **Official EmDash MCP** / EmDash Admin Dashboard |

---

## 🌟 Key Features

- **AI-First Authoring Loop**: Purpose-built CLI and stdio MCP server with structured `_meta` context and actionable remediation messages.
- **Sliding Window + Unpushed Edits Safeguard**: Keeps workspaces lean (30 published + 30 drafts by default) while refusing to prune any file with unpushed local changes.
- **Multi-Site Directory Auto-Detection**: Register profiles in `~/.config/emit/profiles.yaml` with `--workspace`; `cd` into any blog directory and Emit automatically targets the right site without manual switching.
- **Two-Layer Human-Friendly Representation**:
  - **Taxonomies**: Server-side percent-encoded slugs (`"%e6%9c%aa%e5%88%86%e9%a1%9e"`) are displayed on disk as readable decoded Unicode (`未分類`).
  - **Local Media References (`localMediaRefs: true`)**: Mirrored body images use article-relative `../../media/<storageKey>` paths for offline preview in VS Code / Obsidian while pushing canonical `/_emdash/api/media/file/<storageKey>` URLs to EmDash.
- **Dual-Track Image & Custom Block Fidelity**: Standard images render as Markdown `![alt](...)` (Track A), while styled images (`alignment`, `displayWidth`) and custom blocks are preserved losslessly inside `<!--ec:block ... -->` comment fences (Track B / Tier 3).
- **Offline Draft Image Auto-Upload**: Drop new images into `media/drafts/`, reference them in Markdown, and `emit push` uploads, rewrites URLs, and promotes them to `media/<markdownRef>.<ext>` automatically.
- **Two-Track Revision & Draft Revision Support**: Tracks live published articles that hold uncommitted remote draft revisions (`published* [has unpublished draft]` / `status: published # draft revision`).
- **Distributed Lock & Hybrid 3-Way Merge**: Acquires a 7-minute remote lease (`POST /lock`) and merges concurrent frontmatter and body edits via `node-diff3`, rescuing divergent local files to `posts/conflicts/`.
- **Zero Native Dependencies**: Uses Node.js 22+ built-in `node:sqlite` (`DatabaseSync`)—no `node-gyp` or C++ compiler required.

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
│   └── drafts/                     # Staging folder for offline draft images (auto-uploaded & moved on push)
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

### The 4-Step Authoring Cycle

```text
[1. PULL / SEARCH]  Sync active window or find past post  ──►  emit pull / emit article-search
    │
[2. NEW / STATUS]   Scaffold draft or inspect status      ──►  emit new <slug> / emit status
    │
[3. DIRECT EDIT]    Write Markdown & stage draft images   ──►  posts/draft/*.md + media/drafts/*
    │
[4. DIFF & PUSH]    Review diff & push with G1–G19 guards ──►  emit diff / emit push <filePath>
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

> For the complete table of **Safety Guardrails (G1–G19)** and AST conversion rules, see **[docs/safety-guards-and-diagnostics.md](docs/safety-guards-and-diagnostics.md)** and **[docs/markdown-and-ast.md](docs/markdown-and-ast.md)**.

---

## 🛠 CLI Commands Overview

Emit provides **16 top-level CLI commands** (plus **10 subcommands** under `profile` and `conflicts`). For all flags, parameters, and output examples, see **[docs/cli-and-mcp-reference.md](docs/cli-and-mcp-reference.md)**.

| Command | Summary | Common Example |
| --- | --- | --- |
| `emit init` | Initialize workspace (`.emit/config.json`, `cache.db`, `.emit/.gitignore`) or re-link a moved folder | `emit init` / `emit init --profile work` |
| `emit profile` | Manage site profiles (`list`, `add`, `current`, `set-token`, `remove`, `use`) | `emit profile add blog --origin <url> --workspace .` |
| `emit new <slug>` | Scaffold a new draft offline with ULID, one-shot frontmatter & G18 duplicate-slug guard | `emit new my-post -t "Title" -C tech -T ai` |
| `emit pull [target]` | Pull sliding window (articles + taxonomies + referenced media) or a single article by ULID/path | `emit pull` / `emit pull 01M6ABCDEF...` |
| `emit push [file]` | Validate (G1–G19), upload `media/drafts/*`, acquire lock, 3-way merge, and push to EmDash | `emit push posts/draft/20261104_01M6...md` |
| `emit status` | Inspect workspace sync status (`synced`, `published*`, `modified`, `untracked`, `invalid`) | `emit status` / `emit status --search "AI"` |
| `emit diff [file]` | Show unified diff between local working file and reconstructed baseline snapshot | `emit diff posts/draft/20261104_01M6...md` |
| `emit delete <target>` | Delete article locally & remotely after creating a `.deleted.md` backup in `posts/conflicts/` | `emit delete <file> --allow-delete-published` |
| `emit conflicts` | Inspect and resolve rescue copies in `posts/conflicts/` (`list`, `diff`, `resolve`, `prune`) | `emit conflicts list` / `emit conflicts resolve <path> --accept-local` |
| `emit doctor` | Run offline workspace health checks + opt-in probes (`--check-auth`, `--check-media-library`, `--check-media-urls`) | `emit doctor` / `emit doctor --check-auth` |
| `emit article-search [q]` | Search remote articles (or local Markdown bodies via `--offline`) by keyword, tag, category, or date | `emit article-search "Cloudflare" --tag ai --since 2026-01-01` |
| `emit media-search [q]` | Search remote media library (or local mirrors via `--offline`) by keyword and date range | `emit media-search "header" --mirrored-only` |
| `emit pull-taxonomies` | Standalone download of remote categories and tags into `categories/*.yaml` and `tags/*.yaml` | `emit pull-taxonomies` |
| `emit pull-media` | Mirror media assets by `--article <id>`, `--storage-key <key>`, or bounded library window | `emit pull-media --article 01M6ABCDEF...` |
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

### Available MCP Tools (14 Tools)

Every tool attaches structured `_meta` (`profile`, `workspace`, `origin`, `resolvedBy`) and returns actionable error codes and remediation hints. See **[docs/cli-and-mcp-reference.md](docs/cli-and-mcp-reference.md)** for full parameter schemas.

| Tool | Purpose |
| --- | --- |
| `sync_status` | Inspect local workspace tracking status, summary counts, and `actionRequired` files |
| `sync_diff` | View unified diff between local working file and baseline snapshot |
| `sync_new` | Scaffold new draft article offline with canonical ULID, one-shot metadata, and taxonomy hints |
| `sync_pull` | Pull batch sliding window (articles + taxonomies + referenced media) or a targeted single article by `id`/`filePath` |
| `sync_push` | Push local article changes with preflight guards (G1–G19), distributed lock, 3-way merge, and `media/drafts/*` auto-upload |
| `sync_delete` | Safely delete an article locally and remotely with `.deleted.md` rescue backup |
| `sync_conflicts` | `list`, `diff`, `resolve`, or `prune` quarantined rescue copies in `posts/conflicts/` |
| `sync_doctor` | Run workspace diagnostics (offline by default; opt-in `checkAuth`, `checkMediaLibrary`, `checkMediaUrls`) |
| `sync_article_search` | Search remote EmDash articles or local Markdown bodies (`offline: true`) by keyword, taxonomy, status, slug, or date range |
| `sync_media_search` | Search remote media library or local mirrors (`offline: true`) by keyword and date range |
| `sync_pull_taxonomies` | Standalone sync of remote category and tag YAML definitions |
| `sync_pull_media` | Mirror media assets by `article`, `storageKey`, or bounded library window |
| `profile_list` | List all configured EmDash connection profiles and resolution rationale |
| `profile_switch` | Switch active session/default profile for multi-site environments |

---

## 📚 Authoritative Documentation & Architecture Specs (`docs/`)

Detailed specifications, subsystem designs, and troubleshooting guides are organized by domain boundary under **[docs/](docs/README.md)**:

1. **[Architecture, Layering & Infrastructure (`docs/architecture-and-layers.md`)](docs/architecture-and-layers.md)** — 4-tier layering rules (Axes 0–5), Workspace Contracts, Profile/Auth/Origin resolution precedence, SQLite `cache.db` schema (v5), and CLI/MCP presentation symmetry.
2. **[Sync Engine, Revisions & 3-Way Merge (`docs/sync-engine-and-revisions.md`)](docs/sync-engine-and-revisions.md)** — Modular Pull (6 stages) & Push (10 modules), Two-Track Revision model (`revForTransport` vs `revForComparison`), `published*` draft revisions, distributed locks, Hybrid 3-Way Merge, and `posts/conflicts/` quarantine lifecycle.
3. **[Markdown, Frontmatter & Portable Text AST (`docs/markdown-and-ast.md`)](docs/markdown-and-ast.md)** — `FrontmatterSchema`, `parseMarkdownLenient` self-healing, YAML scalar quoting, baseline reconstruction, Portable Text conversion, and Dual-Track Image Model (Tier 1 vs Tier 3 `<!--ec:block ... -->`).
4. **[Local-First Media Pipeline (`docs/media-pipeline.md`)](docs/media-pipeline.md)** — `media/drafts/` auto-upload & promotion, `localMediaRefs` relative path localization, `storageKeyToMarkdownRef` mirror naming, and remote-authoritative media pruning.
5. **[Two Media ID Spaces: `id` vs `storageKey` (`docs/media-id-spaces.md`)](docs/media-id-spaces.md)** — Authoritative specification of D1 record `id` vs R2 `storageKey`, endpoint lookup matrices, and migrated-corpus behavior.
6. **[Taxonomies (Two-Layer Representation) & Bylines (`docs/taxonomies-and-bylines.md`)](docs/taxonomies-and-bylines.md)** — Layer A percent-encoded slugs vs Layer B decoded CJK display, collision resolution, 0-GET deleted taxonomy auto-healing, pre-PUT remote taxonomy audit, and author bylines.
7. **[Safety Guardrails (G1–G19), Diagnostics, Search & Troubleshooting FAQ (`docs/safety-guards-and-diagnostics.md`)](docs/safety-guards-and-diagnostics.md)** — Complete G1–G19 guard table, `emit doctor` checks, epistemic search rules (`[WALK_INCOMPLETE]`), and Troubleshooting FAQ.
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
