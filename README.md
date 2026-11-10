# Emit (`emdash-emit`)

[![CI](https://github.com/aroooy/emdash-emit/actions/workflows/ci.yml/badge.svg)](https://github.com/aroooy/emdash-emit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/emdash-emit.svg)](https://www.npmjs.com/package/emdash-emit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)

**Emit** is an AI-first local workspace and bidirectional synchronization tool for [EmDash](https://github.com/aroooy/emdash) (Cloudflare Workers + D1). It provides a full-featured CLI and a Model Context Protocol (MCP) server designed for autonomous coding agents (Antigravity, Claude Code, Cursor) and human writers.

---

## 📑 Table of Contents

- [Overview & Architecture Philosophy](#-overview--architecture-philosophy)
  - [The Authoring Desk Philosophy & Non-Goals](#1-the-authoring-desk-philosophy--non-goals)
  - [The Sliding Window "Staging Desk" Model](#2-the-sliding-window-staging-desk-model)
  - [Unpushed Edits Safeguard](#3-unpushed-edits-safeguard)
  - [Pure TypeScript & Zero Native Builds](#4-pure-typescript--zero-native-builds)
  - [Distributed Mutex Lock & 3-Way Merge](#5-distributed-mutex-lock--3-way-merge)
  - [Division of Labor with the Official EmDash MCP](#6-division-of-labor-with-the-official-emdash-mcp)
- [🌟 Key Features](#-key-features)
- [📦 Installation](#-installation)
- [🚀 Initial Setup & Profiles](#-initial-setup--profiles)
  - [Register a Profile](#1-register-a-profile)
  - [Initialize a Workspace](#2-initialize-a-workspace)
  - [Multi-Site Management](#3-multi-site-management)
  - [Recommended `.gitignore`](#4-recommended-gitignore)
- [📂 Directory Structure & Data Specifications](#-directory-structure--data-specifications)
- [📝 Markdown & YAML Frontmatter Specification](#-markdown--yaml-frontmatter-specification)
  - [Frontmatter Schema](#frontmatter-schema)
  - [Critical Content Rules](#critical-content-rules)
  - [EmDash Custom Block Preservation](#emdash-custom-block-preservation)
  - [Media Management & Upload Workflow](#media-management--upload-workflow)
- [🤖 The Golden Path for AI & Humans (4-Step Cycle)](#-the-golden-path-for-ai--humans-4-step-cycle)
  - [The 4-Step Authoring Cycle](#the-4-step-authoring-cycle)
  - [Preflight Safety Guardrails (G1–G12)](#preflight-safety-guardrails-g1g12)
- [🛠 CLI Command Reference](#-cli-command-reference)
  - [`emit init`](#emit-init)
  - [`emit profile`](#emit-profile)
  - [`emit new`](#emit-new)
  - [`emit pull`](#emit-pull)
  - [`emit push`](#emit-push)
  - [`emit delete`](#emit-delete)
  - [`emit conflicts`](#emit-conflicts)
  - [`emit doctor`](#emit-doctor)
  - [`emit status`](#emit-status)
  - [`emit diff`](#emit-diff)
  - [`emit pull-taxonomies`](#emit-pull-taxonomies)
  - [`emit pull-media`](#emit-pull-media)
  - [`emit guide`](#emit-guide)
  - [`emit mcp`](#emit-mcp)
- [🤖 Model Context Protocol (MCP) Support](#-model-context-protocol-mcp-support)
  - [Setup Guide](#setup-guide)
  - [Available MCP Tools](#available-mcp-tools)
  - [Autonomous Agent Workflows](#autonomous-agent-workflows)
- [🔒 Distributed Concurrency & 3-Way Merge](#-distributed-concurrency--3-way-merge)
- [🔧 Troubleshooting & FAQ](#-troubleshooting--faq)
- [🧪 Testing & Quality Assurance](#-testing--quality-assurance)
- [📄 License & Copyright](#-license--copyright)

---

## 💡 Overview & Architecture Philosophy

EmDash is a modern serverless headless CMS built on Cloudflare Workers and D1. While Cloudflare D1 provides blazing-fast edge performance, authoring long-form blog posts and articles directly in a web dashboard can be cumbersome.

**Emit** bridges this gap. It turns any local directory into a Git-like local authoring workspace, allowing you and AI coding agents to edit Markdown files using your favorite editors (VS Code, Neovim, Cursor, Antigravity) and seamlessly sync them with EmDash.

```text
┌───────────────────────┐                    ┌─────────────────────────┐
│   Local Workspace     │   emit push / pull │   Remote EmDash Server  │
│  posts/draft/*.md     │ ◄────────────────► │   Cloudflare Workers    │
│  posts/published/*.md │   (AST + Frontmatter)│   Cloudflare D1 SQL     │
│  .emit/cache.db       │                    │   Cloudflare R2 Media   │
└───────────────────────┘                    └─────────────────────────┘

```

### 1. The Authoring Desk Philosophy & Non-Goals

To prevent user expectations from misaligning with the tool's purpose, it is important to clarify **what Emit is and what it is not**:

* **What Emit IS (Core Goal)**:
  * An **active authoring and editing workbench (Staging Desk)** where human authors and AI coding agents collaborate seamlessly.
  * A tool focused on drafting, reviewing, polishing, diffing, and publishing current and recent articles with strict safety guards—including **automatic offline draft image upload** (`media/drafts/`) for images referenced in the article being pushed.
* **What Emit is NOT (Non-Goals)**:
  * **Not a full-site database archiver / backup dumper**: Emit is not designed to clone an entire 15-year history of 20,000 blog posts or an entire multi-gigabyte media library onto your laptop.
  * **Not an offline bulk mass-migration converter**: Emit does not perform batch transformation across thousands of historical posts or bulk media migrations at once.

If your site contains thousands of articles, they remain safe, searchable, and intact in your Cloudflare D1 database. Emit only pulls the active working set into your local workspace, keeping your directory clean and searches instant. Need to edit a specific older article outside the active window? Simply pull it on demand using `emit pull <article-id>`.

These Non-Goals are **deliberate design decisions, not missing capabilities**: raising `postsSyncLimit` (see below) can in fact fetch tens of thousands of articles, so Emit *could* clone a whole site — it chooses not to expose that as its default workflow. The sliding window is a boundary on what stays *on disk*, never on what you can *reach*: every historical article remains editable through an on-demand `emit pull <id>`, and writing a long-form piece that cites or revises many past posts works exactly the same way — fetch each referenced article by ULID, edit it, push it. For operations that genuinely belong to the whole library (bulk media management, site-wide content queries), pair Emit with the [official EmDash MCP](#6-division-of-labor-with-the-official-emdash-mcp) instead of asking Emit to reinvent them.

> [!NOTE]
> **Can the sync limit be adjusted — and why is there no `--all` for articles?**
> Yes. Set `postsSyncLimit: 300` (or any larger number, e.g. your full article count) in `.emit/config.json`, and Emit's internal pagination engine automatically batch-fetches up to that configured limit. What Emit deliberately omits is a `--all` *flag* for articles: pulling the entire history into the workspace is an explicit configuration choice, not a routine default, so the "staging desk" discipline is preserved in day-to-day UX while remaining fully escapable when you truly want a larger working set. Media is intentionally different — `emit pull-media --all` does exist, because media files are inert assets that never carry unsynced writing risk.

### 2. The Sliding Window "Staging Desk" Model

Traditional synchronization tools attempt to download the entire history of a site. If your blog has thousands of articles, local directories become cluttered, Ripgrep/VSCode search slows down, and AI context windows get overwhelmed with irrelevant historical data.

Emit adopts a **bounded sliding window**:

* It maintains an active sliding window of recent posts (default: **latest 100 posts**).
* When older posts fall outside the sliding window during `emit pull`, Emit cleanly **prunes them from disk**, keeping your local repository lean, fast, and organized.
* Any pruned article can be pulled back into the workspace at any time with `emit pull <id>`.

### 3. Unpushed Edits Safeguard

What happens if an article with unpushed local modifications is pushed out of the sliding window?
Emit guarantees **zero data loss**:

* If an article has local modifications not yet pushed to the remote server, Emit's pruning engine **aborts the pull immediately** with a `SyncPruneConflictError`.
* It lists the exact unpushed file and informs the user to either push the changes (`emit push <file>`) or discard them before proceeding.

### 4. Pure TypeScript & Zero Native Builds

Emit has **zero C++ native dependencies** (`node-gyp`).
By leveraging Node.js 22's built-in `node:sqlite` module (`DatabaseSync`), Emit installs in seconds on macOS, Linux, and Windows without requiring system build tools or Python.

### 5. Distributed Mutex Lock & 3-Way Merge

To prevent concurrent race conditions when multiple authors or AI agents collaborate:

* Emit acquires a distributed 7-minute lease via `POST /_emdash/api/content/{collection}/{id}/lock` before writing to remote articles, with automatic heartbeats and `try/finally` release guarantees.
* If concurrent edits occur, Emit utilizes a **Hybrid 3-Way Merge** engine (`node-diff3`), merging YAML frontmatter fields and Markdown body text independently.

### 6. Division of Labor with the Official EmDash MCP

Emit is intentionally not a complete EmDash client. The [official EmDash MCP server](https://github.com/aroooy/emdash) (and the Admin Dashboard) remains the canonical surface for whole-library operations, and the two tools are designed to be used **side by side against the same site**:

| Operation | Right Tool |
| --- | --- |
| Drafting, reviewing, diffing, publishing articles with safety guards | **Emit** (`emit pull` / `emit push`, MCP `sync_*` tools) |
| On-demand retrieval of any single historical article by ULID | **Emit** (`emit pull <id>`) |
| Bulk media library management (mass upload, mass delete, full-library listing) | **Official EmDash MCP** (e.g. `media_upload`) / Admin Dashboard |
| Site-wide content queries, arbitrary collection operations outside the authoring loop | **Official EmDash MCP** raw content tools |

This division is a design stance, not a limitation to work around: Emit focuses its guardrails (G1–G14, locks, 3-way merge, quarantine) on the *authoring loop* where data loss actually happens, and leaves fleet-scale operations to the server-native tooling that already handles them safely.

---

## 🌟 Key Features

* **AI-First Authoring Workflow**: Built specifically for autonomous agents and humans to draft, inspect, and sync local Markdown files safely.
* **Sliding Window Synchronization**: Automatically manages an active sliding window of recent posts (default: latest 100), pruning older cached entries from disk. The window bounds what stays on disk, not what you can reach — any historical article remains available via `emit pull <id>`, and the window size is configurable (`postsSyncLimit`) when a larger working set is genuinely needed.
* **Unpushed Edits Safeguard**: Detects unpushed local changes outside the sync window and aborts sync safely before any files can be deleted.
* **Git-Style Workspace Encapsulation**: Houses local SQLite cache (`node:sqlite`) and workspace configuration neatly inside a `.emit/` hidden folder.
* **Multi-Site Profile Management**: Manage multiple EmDash sites and credentials in `~/.config/emit/profiles.yaml` with automatic workspace directory detection.
* **Hybrid 3-Way Merge Engine**: Resolves concurrent changes between remote and local versions like Git, independently merging YAML frontmatter and Markdown body.
* **Distributed Mutual Exclusion Lock**: Acquires 7-minute leases via `POST /lock` with `try/finally` release semantics to eliminate race conditions during publishing.
* **Opaque Block Preservation**: Preserves EmDash custom blocks (e.g., `core:gallery`) losslessly across AST roundtrips via `<!--ec:block ... -->` fences.
* **Taxonomy & Media Synchronization**: Sync category/tag YAML schemas and download media assets with metadata.
* **Zero Native Dependencies**: Completely eliminates native C++ builds (`node-gyp`) by leveraging Node.js 22+ built-in `node:sqlite`.

---

## 📦 Installation

Emit requires **Node.js v22.0.0** or higher.

### Method A: Global Installation via npm (Recommended)

```bash
npm install -g emdash-emit

# Verify installation
emit --version

```

### Method B: Temporary Execution via npx

Run commands without installing globally:

```bash
npx emdash-emit status
npx emdash-emit pull

```

### Method C: Local Development Link

```bash
git clone https://github.com/aroooy/emdash-emit.git
cd emdash-emit
npm install
npm run build
npm install -g .

```

---

## 🚀 Initial Setup & Profiles

### 1. Register a Profile

Add your EmDash instance credentials to the global profile registry:

```bash
emit profile add my-blog \
  --origin https://your-blog.example.com \
  --token <your-personal-access-token> \
  --workspace /path/to/local/blog-repo
```

* `--origin`: The base URL of your EmDash Cloudflare Workers instance.
* `--token`: Your Personal Access Token (PAT) generated from the EmDash dashboard.
* `--workspace`: The local directory where articles and assets will be synchronized.

> [!NOTE]
> Profiles are securely stored with `0600` permissions at `~/.config/emit/profiles.yaml` (on macOS / Linux) or `%USERPROFILE%\.config\emit\profiles.yaml` (on Windows).

> [!NOTE]
> **`emit profile add` updates in place.** Re-running it with only `--origin` (for example after rotating a domain) keeps the stored `--token` and the `--workspace` link that `emit init` created, and reports `Kept the existing token and workspace link`. Pass `--token`/`--workspace` explicitly to replace them; an empty `--token ''` clears the credential on purpose.

### 2. Initialize a Workspace

Navigate to your local repository directory and initialize it:

```bash
cd /path/to/local/blog-repo
emit init
```

This creates the `.emit/` directory with `config.json` (inheriting `origin` from your resolved profile when `--origin` is omitted, and automatically linking `workspace` back into `~/.config/emit/profiles.yaml` unless `--no-link` is passed) and initializes the local baseline cache SQLite database (`.emit/cache.db`).

### 3. Multi-Site Management (Directory-Driven & Zero Friction)

Emit is designed from the ground up for authors who manage multiple blogs or environments (e.g. personal blog, company blog, staging site).

Because each profile records its own `--workspace` directory, **you never have to manually switch global "active" sites**. Emit resolves the target site automatically based on where you are:

```bash
# Register personal blog
emit profile add personal --origin https://personal.example.com --token <pat-1> --workspace ~/blogs/personal

# Register company blog
emit profile add work --origin https://blog.company.example.com --token <pat-2> --workspace ~/blogs/work

# List all registered profiles
emit profile list
```

**How Automatic Profile Resolution Works:**
1. **Directory-Driven Auto Detection (Recommended)**: When you `cd ~/blogs/personal` and run `emit pull`, `emit push`, or launch an AI agent, Emit detects your current folder and automatically uses the `personal` profile. When you `cd ~/blogs/work`, it seamlessly connects to `work`. Directory comparison is symlink-safe (`fs.realpathSync`), so a workspace reached through a symlinked path (or a macOS `/tmp`-style alias) still resolves to the right profile.
2. **Explicit Profile Flag**: You can explicitly specify `--profile <name>` (or pass `profile: "<name>"` in MCP) from any directory to override automatic detection.
3. **Ambiguity Safeguard**: If you run a command outside of any registered workspace and omit `--profile`, Emit aborts with an `AmbiguousProfileError` instead of guessing or silently pushing to the wrong site.

### 4. Authentication Resolution Order & Token Auto-Refresh

Emit resolves authentication credentials using a strict 4-tier priority chain (`src/client/auth.ts`):

1. **Environment Variables (`EMDASH_TOKEN` or `EMDASH_API_TOKEN`)**: Highest priority; ideal for CI/CD pipelines and one-off overrides. `EMDASH_ORIGIN` (and `EMDASH_WORKSPACE`) are read here as well and documented under [Origin Resolution Precedence](#origin-resolution-precedence).
2. **Site Profile Registry (`~/.config/emit/profiles.yaml`)**: Matched via `--profile <name>` (or MCP `profile`), current workspace directory auto-detection, or a single registered profile.
3. **EmDash CLI Credentials (`~/.config/emdash/auth.json`)**: Fallback when no token is configured in the profile.
4. **Emit Custom Credentials (`~/.config/emit/credentials.json`)**: Final fallback.

**Automatic OAuth Token Refresh on HTTP 401 (`src/client/http.ts`)**:
When credentials include a `refresh_token` (such as OAuth sessions in `~/.config/emdash/auth.json` or `~/.config/emit/credentials.json`) and a request returns `401 Unauthorized`, Emit automatically exchanges the `refresh_token` at `POST /_emdash/api/auth/token` (`grant_type: "refresh_token"`), persists the refreshed token back to `auth.json` when applicable, and transparently retries the request once.

#### Origin Resolution Precedence

The target instance (`origin`) is resolved by one shared function (`resolveOriginPriority()` in `src/cli/context.ts`, reused by the MCP server) so CLI and MCP always agree:

1. **Explicitly selected profile** — `--profile <name>` (or MCP `profile: "<name>"`)
2. **`EMDASH_ORIGIN`** — overrides an *implicitly* resolved profile so CI/staging overrides actually take effect
3. **Auto-resolved profile** — current-directory match, unique origin match, or the single registered profile
4. **Resolved auth origin** — carried by `~/.config/emdash/auth.json` / `~/.config/emit/credentials.json`
5. **Workspace `.emit/config.json`** → then the `https://example.com` sentinel default

> [!NOTE]
> Every silent override is surfaced as a `⚠️ Warning` naming the **real source** of each value (`.emit/config.json` values are never mislabeled as `EMDASH_ORIGIN` or the reverse). When you select `--profile` explicitly, `EMDASH_ORIGIN` is ignored **and reported**. Comparisons ignore trailing slashes. `emit init` follows the same ranking (`--origin` > `EMDASH_ORIGIN` > auto-resolved profile) and refuses to link the workspace to a profile whose origin does not match the initialized origin.

### 5. Workspace Configuration (`.emit/config.json`)

Running `emit init` generates `.emit/config.json` with the following keys (`src/utils/config.ts`):

```json
{
  "origin": "https://your-blog.example.com",
  "defaultCollection": "posts",
  "defaultLocale": "ja",
  "postsSyncLimit": 100,
  "mediaSyncLimit": 300,
  "concurrency": 8
}
```

| Key | Default | Description |
| --- | --- | --- |
| `origin` | `"https://example.com"` | Base URL of the target EmDash instance, exactly as written to disk. It is never rewritten in-memory by `EMDASH_ORIGIN`; see [Origin Resolution Precedence](#origin-resolution-precedence) for how the effective origin is chosen |
| `defaultCollection` | `"posts"` | Default content collection when `--collection` is omitted |
| `defaultLocale` | `"ja"` | Default locale used when scaffolding new drafts via `emit new` / `sync_new` |
| `postsSyncLimit` | `100` | Sliding window size for batch article pulls (when `status: all`, fetches up to `postsSyncLimit` `published` + up to `postsSyncLimit` `draft` articles in parallel; also supports legacy `syncLimit` fallback) |
| `mediaSyncLimit` | `300` | Default maximum items fetched by `emit pull-media` / `sync_pull_media` |
| `concurrency` | `8` | Parallel HTTP fetch concurrency during batch pulls |

### 6. Recommended `.gitignore`

When tracking your local blog repository with Git, use the following recommended `.gitignore` configuration:

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

> [!TIP]
> * `.emit/cache.db*` **must be excluded** from Git because it is a machine-local SQLite tracking database.
> * `.emit/config.json` **can be safely committed** to Git because it contains workspace configuration (origin URL, default collections), while sensitive authentication tokens remain securely isolated in `~/.config/emit/profiles.yaml`.
> * `media/*.yaml` metadata files can be committed to Git to track asset metadata (`storageKey`, `contentHash`, `status`, dimensions) alongside your Markdown articles.
> * **Local-First Git Tracking for `media/`**: If you use your Git repository as a self-contained Local-First source of truth (including offline drafts in `media/drafts/`), keep `media/` tracked in Git (or via Git LFS). If you treat Cloudflare R2 as the sole binary store and want a lightweight Git repo, uncomment the `media/*.jpg` ignore rules above while keeping `media/*.yaml` tracked.

---

## 📂 Directory Structure & Data Specifications

When synchronized, your local workspace will be organized as follows:

```text
your-blog/
├── .emit/                          # [Hidden System Directory - Do not edit manually]
│   ├── config.json                 # Workspace configuration (origin, postsSyncLimit, etc.)
│   └── cache.db                    # SQLite baseline tracking & hash database
├── categories/                     # Category definition files (<id>-<label>.yaml)
│   ├── 01M6CAT1-Tech.yaml
│   └── 01M6CAT2-カメラ.yaml
├── tags/                           # Tag definition files (<id>-<label>.yaml)
│   ├── 01M6TAG1-Typescript.yaml
│   └── 01M6TAG2-Ai.yaml
├── media/                          # Media files and companion metadata (<yyyyMMdd>_<id>-<name>.<ext>)
│   ├── drafts/                     # Staging folder for offline draft images (auto-uploaded on push)
│   │   └── sunset.png
│   ├── 20261101_01M6ABCDEF-header.jpg
│   └── 20261101_01M6ABCDEF-header.yaml
└── posts/                          # Local Markdown Articles (<yyyyMMdd>_<ulid>-<title>.md)
    ├── draft/                      # Draft articles (named after title; falls back to slug if empty)
    │   └── 20261104_01M6...-My-New-Post.md
    ├── published/                  # Live published articles
    │   └── 20261015_01M5...-Getting-Started.md
    └── conflicts/                  # Read-only rescue copies of divergent local content (written by pull; never pushed or pruned)
        └── 20261101_01M5...-Getting-Started.conflict.md

```

### Local SQLite Cache (`.emit/cache.db`)

Emit maintains a local SQLite database via Node.js built-in `node:sqlite` (`src/db/cache.ts`) with 5 tables:

| Table | Purpose |
| --- | --- |
| `entries` | Caches the latest remote JSON envelope and revision (`rev`) for each synced article |
| `base_snapshots` | Stores the baseline Markdown body and baseline frontmatter at the last synced revision to power Hybrid 3-Way Merge (`frontmatter_yaml` holds a **JSON-encoded** `Frontmatter` object, not YAML text) |
| `sync_state` | Tracks each article's workspace-relative file path and SHA-256 content hash to detect local modifications (`synced` vs `modified` vs `untracked`, plus `invalid` when YAML frontmatter fails parsing; `invalid` files are excluded from `emit push --all`, cached `invalid` files are automatically self-healed on batch `emit pull` / `sync_pull`, and uncached `invalid` files outside the sliding window can be repaired via `emit pull <ULID>` or `sync_pull(id: "<ULID>")`) |
| `bylines` | Caches remote author records (`id`, `slug`, `display_name`, `is_guest`) synced automatically via `/_emdash/api/mcp` (`byline_list`) on pull, enabling slug ⇔ ULID resolution and default author selection |
| `media_state` | Tracks offline draft image uploads (`local_hash`, `media_id`, `storage_key`, `url`, `workspace_path`, `status`: `pending` \| `uploaded` \| `ready` \| `failed`) for idempotency, retry recovery, and cross-article asset reuse |

---

## 📝 Markdown & YAML Frontmatter Specification

Each article is stored as a Markdown file with a validated YAML frontmatter header (`FrontmatterSchema` in `src/utils/frontmatter.ts`).

### Frontmatter Schema

```yaml
---
id: 01M6ABCDEF1234567890123456     # 26-char canonical ULID (auto-generated; DO NOT EDIT)
slug: building-ai-powered-cms-tools
title: "Building AI-Powered CMS Tools"
collection: posts                  # Target collection (defaults to "posts")
status: draft                      # "draft" or "published" (defaults to "draft")
publishedAt: null                  # ISO 8601 timestamp string (e.g. "2026-11-04T12:00:00.000Z") or null
locale: ja                         # Locale code (defaults to "ja")
featuredImage: "01M67P0MBMJQQXH2K95HHCYRYB" # Optional: 26-char media ULID (uppercase-normalized) or null
taxonomies:                        # Map of taxonomy key -> array of term slugs (or canonical term ULIDs)
  categories:
    - tech
  tags:
    - typescript
    - ai
seo:                               # Optional SEO metadata block
  title: null                      # Custom SEO title string or null
  description: null                # Meta description string or null
  canonical: null                  # Absolute URL (e.g. "https://example.com/posts/...") or null
  noIndex: false                   # Boolean (optional)
  image: null                      # SEO image string or null
bylines:                           # Author byline slugs (resolved via cached bylines table)
  - aroooy
---

Markdown body begins here...

```

> [!IMPORTANT]
> **Schema Validation & Serialization Rules (`src/utils/frontmatter.ts`)**:
> * **Always nest categories and tags under `taxonomies:`**: `parseMarkdown()` validates frontmatter with Zod (`FrontmatterSchema`), which strips unknown top-level keys, and `serializeMarkdown()` regenerates the YAML header on every pull and push. Writing `categories:` or `tags:` at the top level will silently discard them without triggering Preflight Guard G4. `taxonomies` accepts `categories`, `tags`, and any additional custom taxonomy keys defined in EmDash (`z.record(z.array(z.string()))`).
> * **`seo.canonical` must be an absolute URL**: Validated via `z.string().url().nullable().optional()`. Relative paths such as `"/posts/my-slug"` will fail frontmatter parsing; always specify a full `https://...` URL or `null`.
> * **Author `bylines` auto-selection**: When scaffolding with `emit new` / `sync_new` without `--byline` / `byline`, Emit populates `bylines` with the first cached non-guest author ordered by `slug ASC` from `.emit/cache.db`. On single-author sites this is always your author slug; on multi-author sites, pass `-b, --byline <slug>` (or `byline` in MCP) or edit `bylines:` in frontmatter explicitly.
> * **`id` and `featuredImage` normalization**: `id` must be an exact 26-character ULID. `featuredImage` values matching a 26-character Crockford base32 ULID are normalized to uppercase automatically.

### Critical Content Rules

1. **Do Not Duplicate the Title in the Body**:
   - The article title is managed by the `title:` field in the frontmatter.
   - **Do not** add `# Article Title` as the first heading in the Markdown body. Doing so causes duplicate title displays on the site frontend. (Emit's preflight guard G7 will detect and automatically trim redundant top headings).
2. **Taxonomy Slugs & Normalization**:
   - Items under `taxonomies.categories` and `taxonomies.tags` should use existing slug names from `categories/*.yaml` and `tags/*.yaml` (e.g. `- tech`, `- nodejs`). Note that while taxonomy definition filenames include the ULID (`categories/<id>-<slug>.yaml`), the frontmatter entries use the **slug**.
   - If a valid term ULID is specified in the frontmatter, Emit automatically resolves it transparently to its corresponding slug for Preflight Guard G4 validation and maintains accurate term assignment on remote sync.
   - Do not duplicate the same term using both its slug and ULID within the same taxonomy (e.g. `[- tech, 01M6CAT1]`). Emit de-duplicates identical term assignments, but a slug and a ULID that resolve to **different** terms will both be assigned to the article.
   - Never invent arbitrary IDs or invalid names; valid options are automatically displayed as hints during `emit pull`, `emit pull-taxonomies`, `emit new`, `sync_pull`, `sync_pull_taxonomies`, and `sync_new`. Hint lists are capped per command (with an `...and N more` marker), so the authoritative full list is always the `categories/` and `tags/` YAML files. Preflight Guard G4 strictly validates taxonomy terms before pushing.
3. **Status Transitions**:
   - To publish a draft, update `status: published` in the frontmatter and execute `emit push <filePath> --allow-publish`.
   - Emit automatically updates the remote state and moves the file from `posts/draft/` to `posts/published/`.
   - **Never move or rename files manually using `mv`**.
4. **Featured Image References**:
   - `featuredImage` must be a 26-character canonical media ULID (e.g. `01M67P0MBMJQQXH2K95HHCYRYB`) or `null`. Emit normalizes the value to uppercase, so lowercase input is accepted and canonicalized on pull, merge, and push.
   - To remove the hero image, set `featuredImage: null`. Omitting the field leaves the remote value untouched.
   - When the referenced ULID matches the cached remote entry, Emit resends the original remote `featured_image` object verbatim (provider, `src`, `meta.storageKey`, dimensions, MIME type) so nothing is lost. When it does not match, Emit sends the bare `{ id: <ULID> }` and lets EmDash resolve the media record. **This contract is confirmed against a live EmDash instance:** `featured_image: { "id": "<ULID>" }` is accepted (HTTP 200) and the server stores the id and normalizes `"provider": "local"` itself.
   - Emit never fabricates media metadata from local `media/*.yaml` files: companion files are used only to cross-check a reference. In a workspace that mirrors media (`media/` exists and is non-empty), a missing or mismatched companion file is reported as a push warning — it means Emit could not confirm the media ID exists, not that the payload is invalid. Workspaces that do not mirror media produce no such warning.
   - Preflight Guard **G10** rejects local file paths and malformed values before pushing.

### EmDash Custom Block Preservation

EmDash supports rich visual blocks (e.g., galleries, callouts, audio players). When converted from EmDash's internal AST to Markdown, Emit wraps non-standard blocks in opaque comment fences:

```html
<!--ec:block type="core:gallery" id="01M6XYZ..." data="{\"columns\":3,\"images\":[...]}" -->
<!--/ec:block-->

```

* **Rule**: Do not modify or delete these comment fences unless you intentionally want to remove the block. Emit preserves them losslessly on round-trips.

### Media Management & Upload Workflow

EmDash stores media files (images, documents) in Cloudflare R2 and uses **two distinct identifier spaces**:

| Usage | Identifier Used | Format / Example |
| --- | --- | --- |
| Frontmatter `featuredImage` | **Media Record `id`** | 26-character ULID (`01M67P0MBMJQQXH2K95HHCYRYB`) or `null` |
| Body `![alt](...)` URL | **Media `storageKey`** | `/_emdash/api/media/file/<storageKey>` (e.g. `/_emdash/api/media/file/01M67P07X2VPW0MYRRRGMA6T5A.jpg` or double-ULID `01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png`) |

> [!IMPORTANT]
> Never put a media record `id` into `/_emdash/api/media/file/<id>.<ext>`—the public file route resolves by **`storageKey`**, so using a record `id` returns HTTP 404.

#### Workflow A: Offline Draft Image Auto-Upload (`media/drafts/` — Recommended for Body Images)

You can author articles completely offline using local images and let `emit push` handle uploading, URL rewriting, and local file promotion automatically:

1. **Stage Image in `media/drafts/`**: Place your image in `<workspace>/media/drafts/<filename>` (supported extensions: `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.avif`, `.svg`; max 50 MiB).
2. **Reference on a Standalone Line**: In your Markdown body, reference the staged image on its own standalone line:
   ```markdown
   ![Sunset over clouds](../../media/drafts/sunset.png)
   ```
3. **Push the Article (`emit push` / `sync_push`)**: Emit automatically:
   - Uploads the image via EmDash's 4-stage flow (`POST /_emdash/api/media/upload-url` with `sha1:<hex>` deduplication → `PUT` upload → `POST /_emdash/api/media/{id}/confirm`), cleaning up any orphan `pending` record if an upload fails midway.
   - Rewrites the Markdown line in place to the canonical root-relative `/_emdash/api/media/file/<storageKey>` URL.
   - Pushes the article to EmDash.
   - Promotes the local file from `media/drafts/<filename>` to `media/<yyyyMMdd>_<mediaId>-<filename>` alongside a companion `.yaml` metadata file (`storageKey`, `contentHash`, `status`). The `<yyyyMMdd>` prefix reflects the media record's remote `createdAt` when available; if Emit only had a provisional local date, the next `emit pull-media` canonicalizes the filename.
4. **Reuse Across Articles (no re-upload):** The same `media/drafts/<filename>` line can be used in several articles. After the first push promotes the asset, every later push resolves that reference through `media_state` / `media/*.yaml` and rewrites it to the already-confirmed `/_emdash/api/media/file/<storageKey>` URL instead of uploading again (reported as `[LOCAL_IMAGE_AUTO_UPLOAD] Reused N already-promoted media asset(s)`). A direct reference to the promoted path works as well. Emit verifies each reused record with `GET /_emdash/api/media/{id}`: if the record was deleted on the EmDash side the push aborts with `PROMOTED_MEDIA_NOT_FOUND_REMOTE` (run `emit pull-media` or re-stage the image in `media/drafts/`), and servers without that endpoint push successfully but warn with `[MEDIA_EXISTENCE_UNVERIFIED]`.

#### Workflow B: Pre-Uploaded Media & Featured Hero Images

1. **Upload via Admin / EmDash MCP**: Upload images via the **EmDash Admin Web Dashboard** (`/admin/media`) or via the official EmDash MCP tool (`media_upload`) — bulk media library management is intentionally the official tooling's domain (see [Division of Labor](#6-division-of-labor-with-the-official-emdash-mcp)).
2. **Sync Media Locally (optional)**: Run `emit pull-media` in your workspace to download images and companion `.yaml` metadata files into `media/`. Note that `emit pull-media --prune` safely ignores `media/drafts/`.
3. **Embed in Articles**:
   - For featured hero images: set `featuredImage: "01M67P0MBMJQQXH2K95HHCYRYB"` (26-character canonical media record `id`) or `null` in frontmatter.
   - For body images: use `![Alt text](/_emdash/api/media/file/<storageKey>)`.

> [!WARNING]
> **Local Image Guardrails (G5 & G11)**:
> - Arbitrary local paths (e.g. `![pic](./my-image.png)`, absolute filesystem paths, or a `media/` path that does not resolve to a promoted media record) are blocked by Preflight Guard **G5 (`LOCAL_IMAGE_DETECTED`)**. Paths under `media/drafts/` and already-promoted `media/<yyyyMMdd>_<id>-<name>.<ext>` paths are the only accepted local forms.
> - Local images placed inline inside a paragraph (e.g. `Text ![pic](../../media/drafts/a.png) more text`) are blocked with `INLINE_LOCAL_IMAGE_NOT_SUPPORTED` because EmDash Portable Text requires images to be standalone top-level blocks.
> - A `media/drafts/` reference whose file no longer exists and which has no promoted match is blocked with `MISSING_LOCAL_IMAGE_FILE` (the promoted location is reported in the error).
> - Only **backtick** fences (```` ``` ````) are exempt from image scanning. Tilde fences (`~~~`) are not recognized as code by the Portable Text mapper, so they are scanned like normal prose (and emit a `G8` warning because they degrade to plain paragraphs). Write code examples with backticks.

---

## 🤖 The Golden Path for AI & Humans (4-Step Cycle)

Whether you are a human developer or an autonomous AI agent (Antigravity, Claude Code, Cursor), always follow the **4-Step Cycle**:

```text
[1. CHECK]  Inspect local workspace state   ──►  emit status
    │
[2. PULL]   Sync remote updates safely       ──►  emit pull  (articles + taxonomies)
    │
[3. EDIT]   Write & refine Markdown directly ──►  posts/draft/*.md
    │
[4. PUSH]   Push changes to remote           ──►  emit push <filePath>

```

### The 4-Step Authoring Cycle

1. **CHECK (`emit status`)**: Check your workspace status to see synced, modified, and untracked files.
2. **PULL (`emit pull`)**: Synchronize the latest articles and taxonomies from the server into your local workspace. Taxonomies (categories/tags) are synced automatically in batch mode.
3. **EDIT (Direct Editing)**:
* For new posts: run `emit new <slug> --title "My Title"` to scaffold a canonical draft.
* Edit the Markdown body and YAML frontmatter in `posts/draft/` or `posts/published/`.

4. **PUSH (`emit push`)**:
* To push a draft: `emit push posts/draft/<filename>.md`
* To publish live: update `status: published` and run `emit push posts/draft/<filename>.md --allow-publish`.

### Preflight Safety Guardrails (G1–G14)

To ensure autonomous AI agents and automated scripts cannot corrupt workspace state or accidentally publish unintended content, Emit enforces 14 strict preflight guardrails before executing any write operation:

| Guard | Code Name | Description | Severity |
| --- | --- | --- | --- |
| **G1** | `SINGLE_TARGET_GUARD` | Enforces explicit target (`filePath`, `id`, or `--all`) for push/pull; forbids blind bulk push without inspection | Error |
| **G2** | `ID_MISMATCH_ERROR` | Verifies that frontmatter `id` exactly matches the filename ULID; forbids manual `mv` renames | Error |
| **G3** | `UNINTENDED_PUBLISH_GUARD` | Rejects promoting `draft` to `published` unless `--allow-publish` (`allowPublish: true`) is explicitly given | Error |
| **G4** | `INVALID_TAXONOMY_ERROR` | Validates taxonomy terms against local definitions (transparently resolves valid term ULIDs) to stop AI taxonomy hallucination | Error |
| **G5** | `LOCAL_IMAGE_DETECTED` / `INLINE_LOCAL_IMAGE_NOT_SUPPORTED` / `MISSING_LOCAL_IMAGE_FILE` | Rejects local image paths other than `media/drafts/<file>` (or an already-promoted `media/<yyyyMMdd>_<id>-<name>.<ext>` asset) and rejects inline paragraph local images (must be a standalone line) | Error |
| **G6** | `UNRESOLVED_CONFLICT_MARKERS` | Scans for Git 3-way merge conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) and blocks push | Error |
| **G7** | `TITLE_DUPLICATION_AUTOTRIM` | Detects redundant `# Title` headings at the top of the body and automatically trims them safely | Warning |
| **G8** | `UNSUPPORTED_SYNTAX_WARNING` | Warns if unsupported block HTML or incompatible constructs are detected in Markdown | Warning |
| **G9** | `MODIFIED_OPAQUE_BLOCK` | Verifies that `<!--ec:block ... -->` opaque fences have not been tampered with or corrupted | Error |
| **G10** | `INVALID_FEATURED_IMAGE` | Verifies that `featuredImage` is a 26-character canonical media ULID (normalized to uppercase) or `null`. A remote media URL that contains a ULID is resolved with a warning; local file paths and malformed values are rejected | Error |
| **G11** | `LOCAL_IMAGE_AUTO_UPLOAD` (`MISSING_LOCAL_IMAGE_FILE` / `INVALID_LOCAL_IMAGE_TYPE` / `LOCAL_IMAGE_SIZE_EXCEEDED` / `PROMOTED_MEDIA_NOT_FOUND_REMOTE` / `[MEDIA_EXISTENCE_UNVERIFIED]`) | Detects standalone `media/drafts/<file>` image lines (or reuses an already-promoted `media/` asset across articles), validates file existence, extension, and size (≤ 50 MiB), queues them for automatic upload, URL rewrite, and `media/` promotion during `push`, and verifies every reused asset against `GET /_emdash/api/media/{id}` before its URL is baked into the body | Info / Warning / Error |
| **G12** | `QUARANTINED_COPY_NOT_PUSHABLE` | Refuses to push a rescue copy under `posts/conflicts/` (written by a pull that found divergent local content) before any network request, because it would overwrite the canonical article of the same ULID with stale content and recreate duplicate local files | Error |
| **G13** | `CANONICAL_HAS_UNPUSHED_EDITS` | Protects canonical articles from being silently overwritten during conflict resolution (`accept-local`) when unpushed local modifications exist; requires explicit `--force` (`force: true`) | Error |
| **G14** | `QUARANTINED_PATH_REQUIRED` | Restricts conflict resolution targets strictly within `<collection>/conflicts/`, preventing accidental overwrites or unlinks outside the quarantine directory | Error |
| **Guard** | `DUPLICATE_SLUG_GUARD` | Scans local drafts, published posts, cache index, and remote collection during `emit new` / `sync_new` to strictly block creating scaffold articles with already-existing slugs | Error |

---

## 🛠 CLI Command Reference

### `emit init`

Initializes the current directory as an Emit local workspace.

```bash
emit init [--origin <url>]

```

* `--origin <url>`: Optional EmDash origin URL. If omitted, uses the active profile.

**Example Output:**

```text
✅ Initialized Emit workspace at: /Volumes/ext/github/my-blog
   Config: /Volumes/ext/github/my-blog/.emit/config.json
   Database: /Volumes/ext/github/my-blog/.emit/cache.db

```

---

### `emit profile`

Manage connection profiles across multiple EmDash instances.

```bash
# List all configured profiles and their workspace directories
emit profile list

# Add or update a profile
emit profile add <name> --origin <url> [--token <pat>] [--workspace <path>]

# Show currently resolved profile for this directory
emit profile current

# Remove a profile
emit profile remove <name>

# (Optional) Set a fallback default profile for when operating outside any workspace
emit profile use <name>
```

---

### `emit new`

Scaffolds a new draft article with a canonical 26-character ULID timestamp.

```bash
emit new <slug> [-t, --title <title>] [-c, --collection <collection>] [-l, --locale <locale>] [-b, --byline <slug>] [-p, --profile <name>]

```

* `<slug>`: URL slug for the article (e.g., `modern-web-architecture`).
* `-t, --title <title>`: Human-readable article title.
* `-c, --collection <name>`: Collection name (defaults to `posts`).
* `-l, --locale <locale>`: Locale code (defaults to `ja` or config).
* `-b, --byline <slug>`: Author byline slug (defaults to the first cached non-guest author ordered by `slug ASC`).
* `-p, --profile <name>`: Explicitly target a specific connection profile.

**Example:**

```bash
emit new ai-workflow-guide --title "AI Workflow Guide"

```

**Output:**

```text
✅ Created new article scaffold (ID: 01M6ABCDEF1234567890123456)
   Path: posts/draft/20261104_01M6ABCDEF1234567890123456-AI-Workflow-Guide.md

Available Categories:
  - tech (技術)
  - column (コラム)

Available Tags:
  - ai, cloudflare, emit, typescript

Next: Write your content in Markdown, then run:
   emit push posts/draft/20261104_01M6ABCDEF1234567890123456-AI-Workflow-Guide.md

```

---

### `emit pull`

Synchronizes remote articles **and taxonomies** (categories/tags) into the local workspace.

```bash
emit pull [id] [options]

```

* `[id]`: Optional article ID or ULID. If specified, pulls only that specific article (even if outside the window). Taxonomies are not pulled in single-article mode.
* `-s, --status <draft|published|all>`: Filter by publication status (default: `all`). When set to `all`, the sliding window (`postsSyncLimit`, default `100`) is applied **per status** (fetching up to `postsSyncLimit` `published` + up to `postsSyncLimit` `draft` articles in parallel).
* `-c, --collection <collection>`: Collection name (default: `posts`).
* `--no-prune`: Do not prune local articles that have fallen outside the sliding window (escape hatch; not intended for routine use).
* `--force`: Force overwrite local files and bypass differential hash checking.
* `--concurrency <n>`: Parallel processing task limit (default: `8`).
* `--posts-only`: Skip automatic remote taxonomy sync. Pulls articles only (local taxonomy candidates hint is still displayed from cached definitions).
* `--media`: Also pull media assets and companion metadata into `media/` (bounded by `mediaSyncLimit`, default `300`). Use `emit pull-media` for `--limit`, `--all`, and `--prune` control.
* `--metadata-only`: With `--media`: download only metadata YAML, skip binary file downloads.

> [!NOTE]
> **Taxonomies are pulled by default in batch mode.** Categories and tags are lightweight (2 API calls) and required for valid push operations (Preflight Guard G4 validates taxonomy terms against these local definitions). This eliminates a common source of push failures. Use `--posts-only` if you need articles only.

> [!NOTE]
> **Why `--no-prune` is rarely needed:**  
> Automatic pruning is mathematically loss-free: Emit's unpushed edits safeguard inspects both the canonical file and any duplicate filenames sharing the same 26-character ULID, strictly aborting the pull (`SyncPruneConflictError`) if any of them contain local modifications. Clean duplicate files are removed alongside the canonical file. You only need `--no-prune` in exceptional circumstances, such as temporarily suppressing Git working-tree changes during a quick pull.

> [!NOTE]
> **Unpushed writing is never discarded.** When a pull finds local content that diverges from the last synced baseline, Emit first moves that file to `posts/conflicts/<name>.conflict.md` (a read-only rescue copy) and then writes the canonical article. Rescue copies are never pushed or pruned automatically, and pushing one directly is refused with `QUARANTINED_COPY_NOT_PUSHABLE` (Guard **G12**): read the copy, merge any valuable content into the canonical article, then delete it. If an invalid file also carries local edits, `--force` is the escape hatch (it quarantines the divergent copy, then writes the repaired file).

**Example:**

```bash
# Pull latest articles + taxonomies (default unified sync)
emit pull

# Pull articles only (skip taxonomies)
emit pull --posts-only

# Pull articles + taxonomies + media
emit pull --media

# Pull articles + taxonomies + media metadata only (no binary downloads)
emit pull --media --metadata-only

# Pull a specific legacy article by ID (no taxonomy overhead)
emit pull 01M5XYZ9876543210123456789

```

**Example Output:**

```text
Syncing categories and tags...
  ✅ Taxonomies: 12 categories, 34 tags

Available Categories:
  - tech (技術)
  - column (コラム)

Available Tags:
  - ai, cloudflare, emit, typescript

Fetching articles from remote (posts, status: all, window: 100/status, concurrency: 8)...
  [1/169] ✅ Pulled hello-world -> posts/published/20261101_01M5...-Hello-World.md
  [2/169] ✅ Pulled draft-post -> posts/draft/20261104_01M6...-Draft-Post.md

🎉 Articles: 169 total [100 published, 69 draft] (12 updated, 157 skipped/up-to-date)

```

---

### `emit push`

Pushes local markdown article changes to the remote EmDash instance.

```bash
emit push [file] [options]

```

* `[file]`: Relative or absolute path to the Markdown file.
* `--allow-publish`: Required when promoting an article to `status: published`.
* `--all`: Pushes all modified files in the workspace.
* `--no-taxonomy-audit`: Skips pre-PUT remote taxonomy divergence audit.
* `--allow-unapplied-taxonomies`: Pushes article body even if taxonomy term assignment fails (bypasses Guard G17).
* `--allow-wipe-taxonomies`: Confirms intentional deletion of all assigned categories or tags.
* `--resolve-taxonomy <strategy>`: Resolves taxonomy conflict explicitly (`union`, `local`, or `remote`).
* `--revive`: Pushes an article that was previously marked delete_pending.
* `-f, --force`: Bypasses non-critical safety guardrails.
* `-p, --profile <name>`: Explicitly target a specific connection profile.

**Example:**

```bash
# Push draft updates
emit push posts/draft/20261104_01M6...-my-article.md

# Publish live to remote
emit push posts/draft/20261104_01M6...-my-article.md --allow-publish

```

---

### `emit delete`

Safely deletes a local Markdown article and its remote counterpart on EmDash.

```bash
emit delete <filePathOrId> [--allow-delete-published] [--dry-run] [-y, --yes] [-p, --profile <name>]
```

* `<filePathOrId>`: Relative/absolute path to the Markdown file, or 26-character article ULID.
* `--allow-delete-published`: Required when deleting a published article (safety guardrail).
* `--dry-run`: Previews the deletion, inspecting referenced media and lines without modifying disk or remote.
* `-y, --yes`: Skips interactive confirmation prompt.
* `-p, --profile <name>`: Explicitly target a specific connection profile.

> [!NOTE]
> **Rescue Backups on Deletion**: When an article is deleted, Emit automatically creates a safety rescue backup at `posts/conflicts/<name>.deleted.md` before removing the file, preserving your work in case of accidental deletion.

---

### `emit conflicts`

Inspects, diffs, and resolves quarantined sync conflict copies (`.conflict.md`) and deletion rescue backups (`.deleted.md`) residing in `posts/conflicts/`.

```bash
# List all quarantined copies with status labels and canonical file paths
emit conflicts list [-c, --collection <collection>]

# View line-by-line diff between quarantined copy and canonical article
emit conflicts diff <filePath> [-c, --collection <collection>]

# Resolve conflict with a specific strategy
emit conflicts resolve <filePath> --accept-local [-f, --force] [-c, --collection <collection>]
emit conflicts resolve <filePath> --accept-canonical [-c, --collection <collection>]
```

* `list`: Scans `<collection>/conflicts/`, classifying items as `⚠️ SYNC CONFLICT` or `🗑️ DELETED RESCUE`, showing sizes and dates.
* `diff`: Displays a unified diff against the current canonical article.
* `resolve --accept-local`: Restores the quarantined content to the canonical location and purges the quarantine file. Guard **G13** blocks overwriting canonical articles that contain unpushed local modifications unless `-f, --force` is explicitly provided.
* `resolve --accept-canonical`: Safely discards the quarantined copy, retaining the canonical version.

---

### `emit doctor`

Runs an automated diagnostic health check across the local workspace and cache database.

```bash
emit doctor [-c, --collection <collection>] [-p, --profile <name>]
```

Validates 6 critical health vectors:
1. **Version Compatibility**: Checks tool version against `createdWithVersion` / `lastSyncedVersion` in config.
2. **Origin Consistency**: Verifies `.emit/config.json`, profile origin, and environment variables.
3. **Frontmatter Integrity**: Ensures all local Markdown files have valid parseable frontmatter.
4. **Conflicts & Quarantine**: Flags unresolved conflict copies and deletion backups in `conflicts/`.
5. **Sync Status**: Verifies local baseline hash tracking.
6. **Referenced Media Existence**: Validates that all local media referenced in article Markdown bodies exist on disk.

---

### `emit status`

Displays the local workspace synchronization status compared against the baseline cache.

```bash
emit status [-c, --collection <collection>] [-p, --profile <name>]

```

**Example Output:**

```text
--- Workspace Status (posts | origin: https://your-blog.example.com) ---
  🟡 [modified] draft     posts/draft/20261104_01M6BBB...-AI-Workflow-Guide.md (AI Workflow Guide)
  ⚪ [untracked] draft     posts/draft/20261104_01M6AAA...-Draft-Notes.md (Draft Notes)
  🟢 [synced  ] published posts/published/20261015_01M5ZZZ...-Getting-Started.md (Getting Started)
  🔴 [invalid ] published posts/published/20190405_01M6CCC...-Broken-Post.md (Broken-Post) [uncached] — bad indentation of a mapping entry at line 5

Summary: 4 total (1 synced, 1 modified, 1 untracked, 1 invalid)
```

> [!NOTE]
> Articles are sorted newest-first by date prefix and ULID. The date prefix reflects the article's publication or creation date, not the last-modified time. To locate currently active edits, look for files marked `[modified]`.

> [!NOTE]
> `[invalid]` marks a file whose YAML frontmatter could not be parsed (usually an older serializer wrote unquoted percent-encoded taxonomy slugs). Batch `emit pull` self-heals cached invalid files; files outside the sliding window are marked `[uncached]` and are repaired with `emit pull <ULID>` (MCP: `sync_pull` with `id: "<ULID>"`). When `<collection>/conflicts/` holds rescue copies, the count is reported separately (`conflicts`) and never counted as an article.

---

### `emit diff`

Shows line-by-line differences between the working Markdown file and the baseline snapshot.

```bash
emit diff [filePath] [-i, --id <id>] [-p, --profile <name>]

```

* `[filePath]`: Relative path to the local Markdown file (e.g., `posts/draft/20261104_01M6...-my-article.md`).
* `-i, --id <id>`: Inspect by 26-character article ULID instead of file path.
* `-p, --profile <name>`: Explicitly target a specific connection profile.

---

### `emit pull-taxonomies`

Downloads categories and tags from EmDash and generates local YAML definitions under `categories/` and `tags/`. This is also performed automatically by `emit pull` in batch mode. If one taxonomy endpoint fails, existing local definitions for that taxonomy are preserved with a warning; if both endpoints fail, the command exits with code `1`.

```bash
emit pull-taxonomies

```

**Output:**

```text
Pulling categories and tags from remote...
✅ Successfully synced taxonomies: 12 categories, 34 tags.

Available Categories:
  - tech (技術)
  - column (コラム)

Available Tags:
  - ai, cloudflare, emit, typescript

```

---

### `emit pull-media`

Downloads media assets and their companion metadata YAML files into `media/`. Supports pulling all media, a limited batch, or targeted media referenced by a specific article.

```bash
emit pull-media [-a, --article <id-or-path>] [-l, --limit <n>] [--all] [--prune] [--metadata-only]
```

* `-a, --article <id-or-path>`: Pulls only media assets referenced by the specified article (featured image and body images), saving bandwidth and disk space.
* `-l, --limit <n>`: Maximum number of media items to fetch (default: `300`).
* `--all`: Fetch all media items without limit.
* `--prune`: Remove local media files that no longer exist on remote. Leftover `media/legacy_*` residue written by older Emit versions is never pruned and must be deleted by hand.
* `--metadata-only`: Download metadata YAML files only, skipping large binary downloads.

> **Unresolved assets:** When an article body references a `/_emdash/api/media/file/<storageKey>` image that Emit cannot match to a media record or to confirmed local mirror metadata, Emit reports it as `⚠️ [UNRESOLVED_MEDIA_ASSET]` and mirrors nothing. That is a *lookup* failure, not proof that the record is missing: body URLs carry the R2 `storageKey`, while `GET /_emdash/api/media/{id}` searches the D1 primary key, so an existing record can 404 here. Verify by storageKey (admin UI, or `wrangler d1 SELECT` on the media table) before registering anything — a blind INSERT can duplicate a record that already exists. Registering records is an EmDash/Wrangler task; once Emit can resolve the record, a normal `emit pull-media` mirrors the asset normally.

---

### `emit guide`

Prints the concise Golden Path cheat sheet and AI safety rules directly to the console.

```bash
emit guide

```

---

### `emit mcp`

Launches Emit as a Model Context Protocol (MCP) stdio server for AI agents.

```bash
emit mcp [-w, --workspace <path>]

```

---

## 🤖 Model Context Protocol (MCP) Support

Emit features a first-class **Model Context Protocol (MCP)** server over stdio. This empowers AI assistants—such as **Google Antigravity**, **Claude Code**, and **Cursor**—to autonomously manage, draft, review, and synchronize EmDash content.

### Setup Guide

#### 1. Claude Desktop (`claude_desktop_config.json`)

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

#### 2. Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "emit": {
      "command": "npx",
      "args": ["-y", "emdash-emit", "mcp"]
    }
  }
}

```

#### 3. Google Antigravity (`~/.gemini/antigravity/mcp_config.json`)

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

> **Tip:** When profiles are registered using `emit profile add --workspace <dir>`, the MCP server automatically discovers credentials and paths without requiring secrets in your agent configuration.

### Available MCP Tools

| Tool | Purpose | Key Parameters |
| --- | --- | --- |
| `sync_status` | Inspect local sync state (summary-first structure with capped actionRequired, articles, and search filters) | `collection`, `status`, `search`, `profile` |
| `sync_pull` | Pull remote articles **and taxonomies** into local workspace (includes taxonomy hints; preserves divergent local copies under `posts/conflicts/`) | `collection`, `id`, `filePath`, `status`, `force`, `noPrune`, `prune`, `postsOnly`, `includeMedia`, `metadataOnly`, `profile` |
| `sync_new` | Scaffold new article with canonical ULID, frontmatter, default byline, duplicate slug guard, and taxonomy hints | `slug` (required), `title`, `collection`, `locale`, `byline`, `profile` |
| `sync_push` | Push local article changes to remote with preflight checks and `media/drafts/*` auto-upload; refuses `posts/conflicts/` rescue copies (G12) | `filePath` (required), `allowPublish`, `profile` |
| `sync_delete` | Safely delete article locally and remotely with rescue backup (`.deleted.md`) and unpushed edit protection | `filePath`, `id`, `allowDeletePublished`, `dryRun`, `profile` |
| `sync_conflicts` | List, diff, and resolve quarantined conflict copies and deletion backups in `posts/conflicts/` (G13 unpushed edit guard with `force`) | `action` ("list"\|"diff"\|"resolve"), `filePath`, `strategy` ("accept-local"\|"accept-canonical"), `force`, `profile` |
| `sync_doctor` | Run comprehensive workspace diagnostics (version, origin, frontmatter, conflicts, sync, referenced media) | `collection`, `profile` |
| `sync_diff` | Inspect diff between working file and baseline snapshot | `filePath`, `id`, `profile` |
| `sync_pull_taxonomies` | Pull remote category and tag definitions (standalone; returns taxonomy hints) | `profile` |
| `sync_pull_media` | Pull remote media files and metadata into `media/` (supports batch or targeted article media) | `article`, `limit`, `all`, `downloadFiles`, `profile` |
| `profile_list` | List all configured connection profiles | (none) |
| `profile_switch` | Switch active profile for multi-site environments | `name` (required), `persist` |

> [!NOTE]
> **Uniform `_meta` Context & Structured Diagnostics**: Every MCP tool response (success and error) includes structured `_meta` context containing `profile`, `workspace`, `origin`, and `resolvedBy` resolution rationale. Handlers return structured error payloads with actionable suggestions, HTTP status, and preflight codes rather than uncaught raw exceptions.

### Autonomous Agent Workflows

With Emit connected via MCP, you can give high-level natural language instructions to your AI:

* *"Check the workspace status, pull the latest posts, and show me what was changed recently."*
* *"Draft a new blog post titled 'Next-Gen Serverless Architectures' with slug `serverless-next`, add the `tech` category, and write a comprehensive outline."*
* *"Review the draft in `posts/draft/...`, proofread the content, and push it to remote as a draft."*

---

## 🔒 Distributed Concurrency & 3-Way Merge

### Distributed Mutex Lock Protocol

To eliminate race conditions when multiple users or agents edit the same post:

1. Emit issues a `POST /_emdash/api/content/{collection}/{id}/lock` request to EmDash before pushing.
2. EmDash grants a 7-minute mutual exclusion lease.
3. If another author currently holds the lock, Emit aborts with an informative message indicating who owns the lock and when the lease expires.
4. Emit guarantees lock release using strict `try/finally` execution.

### Hybrid 3-Way Merge

If a remote article was updated after you pulled it:

1. Emit loads the **Base Snapshot** (the state when you last pulled), the **Local Working File**, and the **Remote Server State**.
2. **YAML Frontmatter**: Fields are merged key-by-key. Non-conflicting changes are applied automatically.
3. **Markdown Body**: Merged line-by-line using `node-diff3`.
4. If a conflict occurs, standard Git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) are injected for human or agent resolution.

---

## 🔧 Troubleshooting & FAQ

### Q: `SyncPruneConflictError`: Pull aborted due to unpushed modifications

```text
❌ Cannot prune 1 local article(s) outside the sync window because they contain unpushed changes:
- posts/draft/20261001_01M4...-old-draft.md
Push your changes with 'emit push <file>' or discard them before pulling.

```

**Cause**: An article that has fallen outside the sliding window (e.g., beyond the latest 100 posts) contains local edits that have not been pushed to the remote server. To prevent accidental data loss, Emit aborts the pull.

**Solution**:

* If you want to keep the changes: Push them to remote using `emit push posts/draft/...`.
* If you want to discard local edits: Delete or revert the file, then re-run `emit pull`.
* If you want to temporarily skip pruning: Run `emit pull --no-prune`.

### Q: I want to write a comprehensive piece that references my entire back-catalog — is that supported?

**Yes.** The sliding window limits which articles *stay on disk*, not which articles you can *work with*. To reference, quote, or revise any historical post, fetch it individually: `emit pull <article-ULID>` (MCP: `sync_pull` with `id`). Each fetched article enters the normal authoring loop — edit, diff, push — with all guardrails applied. If you prefer a permanently larger local working set instead, raise `postsSyncLimit` in `.emit/config.json`; Emit's pagination engine will fetch up to that size automatically. What Emit deliberately does not offer is a default "clone the whole site" mode; for genuine whole-library operations (bulk media management, site-wide queries), use the official EmDash MCP alongside Emit — see [Division of Labor with the Official EmDash MCP](#6-division-of-labor-with-the-official-emdash-mcp).

### Q: `PushValidationError`: Cannot publish article live without `--allow-publish`

**Cause**: Frontmatter has `status: published`, but `emit push` was executed without `--allow-publish`.

**Solution**: Run `emit push <filePath> --allow-publish`. This safety guardrail prevents accidental live publication.

### Q: Taxonomies not recognized during push

**Cause**: Categories or tags in frontmatter do not exist in local definitions or remote database (or local cache is stale).

**Solution**: Run `emit pull` or `sync_pull` (taxonomies are synced automatically), or use `emit pull-taxonomies` standalone to refresh your local category and tag list. Preflight Guard G4 will guide you with valid options.

### Q: `[NETWORK_ERROR]`: Network request failed (`fetch failed`)

**Cause**: The configured origin URL is unreachable due to DNS resolution failure, offline network/VPN state, or an incorrect origin in `~/.config/emit/profiles.yaml` or `.emit/config.json`.

**Solution**: Verify the `origin` URL reported in `Endpoint:` and check `emit profile list` / `.emit/config.json`. If `.emit/config.json` and your active profile point to different origins, Emit prints an origin mismatch warning to help you reconcile them.

---

## 🧪 Testing & Quality Assurance

Emit adheres to high code quality and test-driven development standards:

```bash
# Run unit test suite (Vitest)
npm test

# Run TypeScript strict typecheck
npm run typecheck

# Verify Prettier code style
npm run format:check

# Auto-format codebase
npm run format

# Run complete CI verification suite
npm run check

```

---

## 📄 License & Copyright

This project is open-source software licensed under the [MIT License](LICENSE).

Copyright (c) 2026 SPORT-SERVICE RS★R. All rights reserved.

