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
  - [Preflight Safety Guardrails (G1–G9)](#preflight-safety-guardrails-g1g9)
- [🛠 CLI Command Reference](#-cli-command-reference)
  - [`emit init`](#emit-init)
  - [`emit profile`](#emit-profile)
  - [`emit new`](#emit-new)
  - [`emit pull`](#emit-pull)
  - [`emit push`](#emit-push)
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
  * A tool focused on drafting, reviewing, polishing, diffing, and publishing current and recent articles with strict safety guards.
* **What Emit is NOT (Non-Goals)**:
  * **Not a full-site database archiver / backup dumper**: Emit is not designed to clone an entire 15-year history of 20,000 blog posts onto your laptop.
  * **Not an offline bulk mass-migration converter**: Emit does not perform batch transformation across thousands of historical posts at once.

If your site contains thousands of articles, they remain safe, searchable, and intact in your Cloudflare D1 database. Emit only pulls the active working set into your local workspace, keeping your directory clean and searches instant. Need to edit a specific older article outside the active window? Simply pull it on demand using `emit pull <article-id>`.

> [!NOTE]
> **Can the sync limit be adjusted?**
> Yes. While `--all` is intentionally omitted from the CLI to protect the sliding window discipline, you can customize the window size by setting `postsSyncLimit: 300` (or any desired number) in `.emit/config.json`. Emit's internal pagination engine will automatically batch-fetch up to that configured limit.

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

* Emit acquires a distributed 7-minute lease via `POST /api/v1/content/lock` before writing to remote articles, with automatic heartbeats and `try/finally` release guarantees.
* If concurrent edits occur, Emit utilizes a **Hybrid 3-Way Merge** engine (`node-diff3`), merging YAML frontmatter fields and Markdown body text independently.

---

## 🌟 Key Features

* **AI-First Authoring Workflow**: Built specifically for autonomous agents and humans to draft, inspect, and sync local Markdown files safely.
* **Sliding Window Synchronization**: Automatically manages an active sliding window of recent posts (default: latest 100), pruning older cached entries from disk.
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

### 2. Initialize a Workspace

Navigate to your local repository directory and initialize it:

```bash
cd /path/to/local/blog-repo
emit init
```

This creates the `.emit/` directory with a default `config.json` and initializes the local baseline cache SQLite database (`.emit/cache.db`).

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
1. **Directory-Driven Auto Detection (Recommended)**: When you `cd ~/blogs/personal` and run `emit pull`, `emit push`, or launch an AI agent, Emit detects your current folder and automatically uses the `personal` profile. When you `cd ~/blogs/work`, it seamlessly connects to `work`.
2. **Explicit Profile Flag**: You can explicitly specify `--profile <name>` (or pass `profile: "<name>"` in MCP) from any directory to override automatic detection.
3. **Ambiguity Safeguard**: If you run a command outside of any registered workspace and omit `--profile`, Emit aborts with an `AmbiguousProfileError` instead of guessing or silently pushing to the wrong site.

### 4. Recommended `.gitignore`

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
> * `media/*.yaml` metadata files can be committed to Git to track asset metadata alongside your Markdown articles.
> 
> 

---

## 📂 Directory Structure & Data Specifications

When synchronized, your local workspace will be organized as follows:

```text
your-blog/
├── .emit/                          # [Hidden System Directory - Do not edit manually]
│   ├── config.json                 # Workspace configuration (origin, postsSyncLimit, etc.)
│   └── cache.db                    # SQLite baseline tracking & hash database
├── categories/                     # Category definition files
│   ├── tech.yaml
│   └── lifestyle.yaml
├── tags/                           # Tag definition files
│   ├── typescript.yaml
│   └── ai.yaml
├── media/                          # Media files and metadata
│   ├── 01M6ABCDEF.jpg
│   └── 01M6ABCDEF.jpg.yaml
└── posts/                          # Local Markdown Articles
    ├── draft/                      # Draft articles (<yyyyMMdd>_<ulid>-<slug>.md)
    │   └── 20261104_01M6...-my-new-post.md
    └── published/                  # Live published articles (<yyyyMMdd>_<ulid>-<slug>.md)
        └── 20261015_01M5...-getting-started.md

```

---

## 📝 Markdown & YAML Frontmatter Specification

Each article is stored as a Markdown file with a standard YAML frontmatter header.

### Frontmatter Schema

```yaml
---
id: 01M6ABCDEF1234567890123456     # EmDash canonical ULID (auto-generated; DO NOT EDIT)
title: "Building AI-Powered CMS Tools"
slug: "building-ai-powered-cms-tools"
status: draft                       # Status: "draft" or "published"
publishedAt: null                   # ISO 8601 timestamp (null for drafts)
updatedAt: "2026-11-04T12:00:00.000Z"
excerpt: "A deep dive into building autonomous content workflows with EmDash and Emit."
featuredImage: "01M6MEDIA123456"    # Media ULID or null
categories:                         # Slugs matching definitions in categories/*.yaml
  - tech
tags:                               # Slugs matching definitions in tags/*.yaml
  - typescript
  - ai
customFields:                       # Optional custom field definitions
  canonicalUrl: ""
---

Markdown body begins here...

```

### Critical Content Rules

1. **Do Not Duplicate the Title in the Body**:
   - The article title is managed by the `title:` field in the frontmatter.
   - **Do not** add `# Article Title` as the first heading in the Markdown body. Doing so causes duplicate title displays on the site frontend. (Emit's preflight guard G7 will detect and automatically trim redundant top headings).
2. **Taxonomy Slugs**:
   - Items under `categories:` and `tags:` must match existing slug names from `categories/` and `tags/`.
   - Never invent arbitrary IDs or invalid names; taxonomies are synced automatically with `emit pull`, or use `emit pull-taxonomies` standalone to see available options.
3. **Status Transitions**:
   - To publish a draft, update `status: published` in the frontmatter and execute `emit push <filePath> --allow-publish`.
   - Emit automatically updates the remote state and moves the file from `posts/draft/` to `posts/published/`.
   - **Never move or rename files manually using `mv`**.

### EmDash Custom Block Preservation

EmDash supports rich visual blocks (e.g., galleries, callouts, audio players). When converted from EmDash's internal AST to Markdown, Emit wraps non-standard blocks in opaque comment fences:

```html
<!--ec:block type="core:gallery" id="01M6XYZ..." data="{\"columns\":3,\"images\":[...]}" -->
<!--/ec:block-->

```

* **Rule**: Do not modify or delete these comment fences unless you intentionally want to remove the block. Emit preserves them losslessly on round-trips.

### Media Management & Upload Workflow

EmDash stores media files (images, documents) in Cloudflare R2 via multipart upload endpoints.

**How to add and use images in your articles:**

1. **Upload New Images**: Upload images via the **EmDash Admin Web Dashboard** (`/admin/media`) or via the official EmDash MCP tool (`media_upload`). This generates a canonical ULID and uploads the asset to Cloudflare R2.
2. **Sync Media Locally**: Run `emit pull-media` in your workspace. This downloads the images and companion `.yaml` metadata files into `media/`.
3. **Embed in Articles**:
   - For featured hero images: set `featuredImage: "01M6..."` in frontmatter.
   - For inline images in body: use standard Markdown syntax with remote URLs: `![Alt text](https://your-blog.example.com/api/v1/media/01M6.../file.jpg)`.

> [!WARNING]
> **No Local Image Paths in Markdown**: Preflight Guard **G5** strictly forbids pushing articles containing local filesystem paths like `![pic](./my-image.png)`. Images must be uploaded to Cloudflare R2 before publishing to prevent broken images in production.

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

### Preflight Safety Guardrails (G1–G9)

To ensure autonomous AI agents and automated scripts cannot corrupt workspace state or accidentally publish unintended content, Emit enforces 9 strict preflight guardrails before executing any write operation:

| Guard | Code Name | Description | Severity |
| --- | --- | --- | --- |
| **G1** | `SINGLE_TARGET_GUARD` | Enforces explicit target (`filePath`, `id`, or `--all`) for push/pull; forbids blind bulk push without inspection | Error |
| **G2** | `ID_MISMATCH_ERROR` | Verifies that frontmatter `id` exactly matches the filename ULID; forbids manual `mv` renames | Error |
| **G3** | `UNINTENDED_PUBLISH_GUARD` | Rejects promoting `draft` to `published` unless `--allow-publish` (`allowPublish: true`) is explicitly given | Error |
| **G4** | `INVALID_TAXONOMY_ERROR` | Validates category and tag slugs against local YAML definitions to stop AI taxonomy hallucination | Error |
| **G5** | `LOCAL_IMAGE_DETECTED` | Detects unresolved local image paths (`![alt](./path.png)`); requires remote R2 URLs | Error |
| **G6** | `UNRESOLVED_CONFLICT_MARKERS` | Scans for Git 3-way merge conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) and blocks push | Error |
| **G7** | `TITLE_DUPLICATION_AUTOTRIM` | Detects redundant `# Title` headings at the top of the body and automatically trims them safely | Warning |
| **G8** | `UNSUPPORTED_SYNTAX_WARNING` | Warns if unsupported block HTML or incompatible constructs are detected in Markdown | Warning |
| **G9** | `MODIFIED_OPAQUE_BLOCK` | Verifies that `<!--ec:block ... -->` opaque fences have not been tampered with or corrupted | Error |

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
emit new <slug> [-t, --title <title>] [-c, --collection <collection>] [-l, --locale <locale>]

```

* `<slug>`: URL slug for the article (e.g., `modern-web-architecture`).
* `-t, --title <title>`: Human-readable article title.
* `-c, --collection <name>`: Collection name (defaults to `posts`).
* `-l, --locale <locale>`: Locale code (defaults to `ja` or config).

**Example:**

```bash
emit new ai-workflow-guide --title "AI Workflow Guide"

```

**Output:**

```text
✅ Created new article scaffold (ID: 01M6ABCDEF1234567890123456)
   Path: posts/draft/20261104_01M6ABCDEF1234567890123456-ai-workflow-guide.md

Next: Write your content in Markdown, then run:
   emit push posts/draft/20261104_01M6ABCDEF1234567890123456-ai-workflow-guide.md

```

---

### `emit pull`

Synchronizes remote articles **and taxonomies** (categories/tags) into the local workspace.

```bash
emit pull [id] [options]

```

* `[id]`: Optional article ID or ULID. If specified, pulls only that specific article (even if outside the window). Taxonomies are not pulled in single-article mode.
* `-s, --status <draft|published|all>`: Filter by publication status (default: `all`).
* `-c, --collection <collection>`: Collection name (default: `posts`).
* `--no-prune`: Do not prune local articles that have fallen outside the sliding window (escape hatch; not intended for routine use).
* `--force`: Force overwrite local files and bypass differential hash checking.
* `--concurrency <n>`: Parallel processing task limit (default: `8`).
* `--posts-only`: Skip automatic taxonomy (categories/tags) sync. Pull articles only.
* `--media`: Also pull media assets and companion metadata into `media/`.
* `--metadata-only`: With `--media`: download only metadata YAML, skip binary file downloads.

> [!NOTE]
> **Taxonomies are pulled by default in batch mode.** Categories and tags are lightweight (2 API calls) and required for valid push operations (Preflight Guard G4 validates taxonomy slugs). This eliminates a common source of push failures. Use `--posts-only` if you need articles only.

> [!NOTE]
> **Why `--no-prune` is rarely needed:**  
> Automatic pruning is mathematically loss-free: Emit's unpushed edits safeguard strictly aborts the pull if an older article contains local modifications. You only need `--no-prune` in exceptional circumstances, such as temporarily suppressing Git working-tree changes during a quick pull.

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
Fetching articles from remote (posts, status: all, window: 100, concurrency: 8)...
  [1/100] ✅ Pulled hello-world -> posts/published/20261101_01M5...-Hello-World.md
  [2/100] ✅ Pulled draft-post -> posts/draft/20261104_01M6...-Draft-Post.md

🎉 Articles: 100 total (12 updated, 88 skipped/up-to-date)

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
* `-p, --profile <name>`: Explicitly target a specific connection profile.

**Example:**

```bash
# Push draft updates
emit push posts/draft/20261104_01M6...-my-article.md

# Publish live to remote
emit push posts/draft/20261104_01M6...-my-article.md --allow-publish

```

---

### `emit status`

Displays the local workspace synchronization status compared against the baseline cache.

```bash
emit status [-c, --collection <collection>] [-p, --profile <name>]

```

**Example Output:**

```text
--- Workspace Status (posts | origin: https://your-blog.example.com) ---
  🟡 [modified] draft     posts/draft/20261104_01M6BBB...-ai-workflow-guide.md (AI Workflow Guide)
  ⚪ [untracked] draft     posts/draft/20261104_01M6AAA...-notes.md (Draft Notes)
  🟢 [synced  ] published posts/published/20261015_01M5ZZZ...-getting-started.md (Getting Started)

Summary: 3 total (1 synced, 1 modified, 1 untracked)

```

> [!NOTE]
> Articles are sorted newest-first by date prefix and ULID. The date prefix reflects the article's publication or creation date, not the last-modified time. To locate currently active edits, look for files marked `[modified]`.

```

---

### `emit diff`

Shows line-by-line differences between the working Markdown file and the baseline snapshot.

```bash
emit diff [filePath]

```

---

### `emit pull-taxonomies`

Downloads categories and tags from EmDash and generates local YAML definitions under `categories/` and `tags/`. This is also performed automatically by `emit pull` in batch mode.

```bash
emit pull-taxonomies

```

**Output:**

```text
Pulling categories and tags from remote...
✅ Successfully synced taxonomies: 12 categories, 34 tags.

```

---

### `emit pull-media`

Downloads media assets and their companion metadata YAML files into `media/`.

```bash
emit pull-media [-l, --limit <n>] [--all] [--prune] [--metadata-only]

```

* `-l, --limit <n>`: Maximum number of media items to fetch (default: `300`).
* `--all`: Fetch all media items without limit.
* `--prune`: Remove local media files that no longer exist on remote.
* `--metadata-only`: Download metadata YAML files only, skipping large binary downloads.

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
| `sync_status` | Inspect local sync state (articles returned newest-first) | `collection` |
| `sync_pull` | Pull remote articles **and taxonomies** into local workspace | `id`, `force`, `status`, `noPrune`, `postsOnly`, `includeMedia`, `metadataOnly` |
| `sync_new` | Scaffold new article with canonical ULID and frontmatter | `slug`, `title`, `locale`, `collection` |
| `sync_push` | Push local article changes to remote with preflight checks | `filePath`, `id`, `allowPublish` |
| `sync_diff` | Inspect diff between working file and baseline snapshot | `filePath` |
| `sync_pull_taxonomies` | Pull remote category and tag definitions (standalone; also included in `sync_pull`) | (none) |
| `sync_pull_media` | Pull remote media files and metadata into `media/` | `limit`, `all`, `prune`, `metadataOnly` |
| `profile_list` | List all configured connection profiles | (none) |
| `profile_switch` | Switch active profile for multi-site environments | `name` |

### Autonomous Agent Workflows

With Emit connected via MCP, you can give high-level natural language instructions to your AI:

* *"Check the workspace status, pull the latest posts, and show me what was changed recently."*
* *"Draft a new blog post titled 'Next-Gen Serverless Architectures' with slug `serverless-next`, add the `tech` category, and write a comprehensive outline."*
* *"Review the draft in `posts/draft/...`, proofread the content, and push it to remote as a draft."*

---

## 🔒 Distributed Concurrency & 3-Way Merge

### Distributed Mutex Lock Protocol

To eliminate race conditions when multiple users or agents edit the same post:

1. Emit issues a `POST /api/v1/content/lock` request to EmDash before pushing.
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

### Q: `PushValidationError`: Cannot publish article live without `--allow-publish`

**Cause**: Frontmatter has `status: published`, but `emit push` was executed without `--allow-publish`.

**Solution**: Run `emit push <filePath> --allow-publish`. This safety guardrail prevents accidental live publication.

### Q: Taxonomies not recognized during push

**Cause**: Categories or tags in frontmatter do not exist in the remote database.

**Solution**: Run `emit pull` (taxonomies are synced automatically), or use `emit pull-taxonomies` standalone to refresh your local category and tag list. Ensure frontmatter values match existing slugs.

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

