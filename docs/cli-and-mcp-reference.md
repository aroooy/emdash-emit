# CLI Command & MCP Tool Complete Reference

This document provides the complete reference for all **22 top-level CLI commands** (plus **10 subcommands**) and all **19 Model Context Protocol (MCP) tools** in Emit (`emdash-emit`).

---

## Part 1: CLI Command Reference

### 1. `emit init`

Initializes the current directory as an Emit local workspace (`.emit/config.json`, `.emit/cache.db`, and `.emit/.gitignore`).

```bash
emit init [--origin <url>] [-p, --profile <name>] [--no-link]
```

- `--origin <url>`: Optional EmDash origin URL. If omitted, inherits from the resolved profile or `EMDASH_ORIGIN`.
- `-p, --profile <name>`: Initialize against a named profile. If that profile's registered `workspace` points to a folder that was moved or renamed, `emit init --profile <name>` repairs the link to the current directory (`🔗 Re-linked profile ...`).
- `--no-link`: Do not register this directory in `~/.config/emit/profiles.yaml`.
- **Non-Destructive Re-Init**: Re-running `emit init` on an existing workspace preserves `defaultCollection`, `defaultLocale`, `postsSyncLimit`, `mediaSyncLimit`, `concurrency`, `localMediaRefs`, and `createdWithVersion`.

---

### 2. `emit profile` (6 Subcommands: `list`, `add`, `use`, `set-token`, `remove`, `current`)

Manages connection profiles across multiple EmDash instances in `~/.config/emit/profiles.yaml` (mode `0600`).

```bash
# 1. List all configured profiles and workspace links
emit profile list

# 2. Add or update a profile in place (preserves existing token/workspace when omitted)
emit profile add <name> --origin <url> [--token <pat>] [--workspace <path>]

# 3. Show currently resolved profile for this directory and resolution rationale ("Resolved by: ...")
emit profile current

# 4. Rotate only the token of an existing profile (prompts with terminal echo off)
emit profile set-token <name> [--stdin] [--token <pat>]

# 5. Remove a profile
emit profile remove <name>

# 6. Set fallback active default profile (used only when running outside any registered workspace)
emit profile use <name>
```

- **Token Rotation (`emit profile set-token <name>`)**: Resolves credentials in the order `--token` → `--stdin` → interactive TTY prompt (echo disabled). Pass `--token ''` to clear a token intentionally. Never prints old or new token values.

---

### 3. `emit new`

Scaffolds a new draft article in `<collection>/draft/<yyyyMMdd>_<ulid>-<title>.md` completely offline with Guard **G18 (`DUPLICATE_SLUG_CONFLICT`)** validation.

```bash
emit new <slug> [options]
```

- `<slug>`: URL slug for the article (required).
- `-t, --title <title>`: Human-readable article title (defaults to `<slug>`).
- `-c, --collection <name>`: Collection name (defaults to `posts` or config `defaultCollection`).
- `-l, --locale <locale>`: Locale code (defaults to `ja` or config `defaultLocale`).
- `-b, --byline <slug>`: Author byline slug (defaults to first cached non-guest author ordered by `slug ASC`).
- `-C, --categories <categories...>`: Category slugs or ULIDs (comma-separated or space-separated).
- `-T, --tags <tags...>`: Tag slugs or ULIDs (comma-separated or space-separated).
- `-d, --description <desc>`: Article excerpt / SEO meta description (`seo.description`).
- `-f, --featured-image <pathOrId>`: Featured image (`../../media/drafts/cover.jpg` or 26-char media record ULID).
- `-p, --profile <name>`: Explicitly select a connection profile.

---

### 4. `emit pull`

Synchronizes remote articles, taxonomies (categories/tags), bylines, and referenced media into the local workspace.

```bash
emit pull [target] [options]
```

- `[target]`: Optional article 26-character ULID or local file path. When specified, executes a targeted single-article pull (even if the article sits outside the 30-post sliding window).
- `-s, --status <draft|published|all>`: Filter by publication status in batch mode (default: `all`, which pulls up to `postsSyncLimit` `published` + `postsSyncLimit` `draft` articles in parallel).
- `-c, --collection <collection>`: Collection name (default: `posts`).
- `--no-prune`: Skip pruning local tracked articles that fell outside the sliding window.
- `--force`: Quarantine divergent local edits into `<collection>/conflicts/*.conflict.md` and overwrite with the canonical remote version.
- `--concurrency <n>`: Parallel HTTP fetch concurrency limit (default: `8`).
- `--posts-only`: Skip remote taxonomy synchronization in batch mode.
- `--no-media`: Skip automatic on-demand mirroring of referenced media assets.
- `--media`: Also run a bounded media library pass (`mediaSyncLimit`, default `100`).
- `--metadata-only`: With `--media` or on-demand media mirroring, write companion `.yaml` metadata only without downloading binary image files.
- `--local-media-refs` / `--no-local-media-refs`: Enable (default-ON) or disable rewriting mirrored body image URLs on disk to article-relative `../../media/<storageKey>` paths, persisting the choice to `.emit/config.json`.
- `--from-snapshot`: Restore article(s) offline from the local `.emit/cache.db` snapshot catalog with zero network calls (works without an auth token). Stores a `snapshot:<comparisonRev>` sentinel in `base_snapshots.rev` so offline `status`/`diff` work while `push` is blocked (`PULL_REQUIRED_BEFORE_PUSH`) until the next online `pull`. Unlike online `emit pull`, batch snapshot restore intentionally performs **no disk pruning** so local files outside the snapshot window remain untouched.
- `--no-media-restore`: When used with `--from-snapshot`, skip materializing cached media binaries from `media/_cache/` into `media/`.
- `--stale-threshold-days <days>`: Snapshot staleness warning threshold in days when using `--from-snapshot` (default: `30`).
- `-p, --profile <name>`: Explicitly select a connection profile.

---

### 5. `emit push`

Validates and pushes local Markdown article changes to the remote EmDash instance under a 7-minute distributed mutex lock, auto-uploading staged images in `media/drafts/`.

```bash
emit push [file] [options]
```

- `[file]`: Relative or absolute path to the Markdown file. When omitted without `--all`, Emit checks workspace status: 0 push-ready files exits cleanly, 1 push-ready file prompts for TTY confirmation (or proceeds with `-y, --yes`; override flags like `--force` / `--allow-publish` are rejected without an explicit file path), and >= 2 files lists candidates and exits.
- `--all`: Push all `modified` and `untracked` articles in the workspace (skips `invalid` files and `conflicts/` copies).
- `-y, --yes`: Skip the interactive TTY confirmation prompt when auto-targeting a single push-ready article.
- `--allow-publish`: Required by Guard **G3** when promoting an article to `status: published` (or publishing a remote draft revision live on a `published*` article).
- `--allow-modified-opaque-blocks`: Bypass Guard **G9** (`MODIFIED_OPAQUE_BLOCK`) when `<!--ec:block ... -->` opaque block JSON or structural keys were modified (rejected in argument-less auto-target mode).
- `--no-taxonomy-audit`: Skip pre-PUT remote taxonomy divergence audit.
- `--allow-unapplied-taxonomies`: Bypass Guard **G17 (`TAXONOMY_APPLY_PENDING`)**.
- `--allow-wipe-taxonomies`: Bypass Guard **G19 (`DESTRUCTIVE_TAXONOMY_WIPE`)** to confirm intentional removal of all categories or tags.
- `--resolve-taxonomy <union|local|remote>`: Resolve a pending taxonomy 3-way merge conflict (Guard **G16**).
- `--revive`: Resurrect and push an article marked `delete_pending` (Guard **G15**).
- `-f, --force`: Bypass overridable safety guardrails.
- `--local-media-refs` / `--no-local-media-refs`: Override and persist the on-disk media reference spelling preference.
- `-p, --profile <name>`: Explicitly select a connection profile.

---

### 6. `emit status`

Displays the local workspace synchronization status compared against the SQLite baseline cache, sorted newest-first by date prefix and ULID.

```bash
emit status [-c, --collection <collection>] [--status <draft|published|all>] [-s, --search <term>] [-p, --profile <name>]
```

- **Status Badges**:
  - `🟢 [synced  ]`: Matches last synced baseline.
  - `🟣 [synced  ] published* ... [has unpublished draft]`: Published article holding an uncommitted remote draft revision (`status: published # draft revision` in frontmatter).
  - `🟡 [modified]`: Contains unpushed local edits.
  - `⚪ [untracked]`: Local scaffold not yet pushed to remote.
  - `🔴 [invalid ]`: YAML frontmatter failed strict parsing (`[healable]` via `emit pull` or `[uncached]` via `emit pull <ULID>`).

---

### 7. `emit diff`

Displays a unified line-by-line diff between the local working Markdown file and the reconstructed baseline snapshot.

```bash
emit diff [filePath] [-i, --id <ulid>] [-c, --collection <collection>] [-p, --profile <name>]
```

- `[filePath]`: Relative or absolute path to the local Markdown file. When both `[filePath]` and `--id` are omitted, diffs all `modified` articles in the collection (untracked files have no base snapshot to diff against and are noted in summary, whereas `emit push` includes both `modified` and `untracked` candidates).
- `-i, --id <ulid>`: Target article by 26-character ULID instead of file path.
- `-c, --collection <collection>`: Collection to inspect when omitting `[filePath]` and `--id` (default: `posts`).

---

### 8. `emit delete`

Deletes a local Markdown article and its remote counterpart on EmDash, creating a safety rescue backup at `<collection>/conflicts/<name>.deleted.md`.

```bash
emit delete <filePathOrId> [--allow-delete-published] [--discard-local-edits] [--dry-run] [-y, --yes] [-p, --profile <name>]
```

- `<filePathOrId>`: File path or 26-character ULID.
- `--allow-delete-published`: Required safety confirmation when deleting a live published article.
- `--discard-local-edits`: Allow deleting an article that has unpushed local modifications (edits are still backed up to `.deleted.md`).
- `--dry-run`: Preview the deletion without modifying disk or remote.
- `-y, --yes`: Skip interactive confirmation prompt.

---

### 9. `emit conflicts` (4 Subcommands: `list`, `diff`, `resolve`, `prune`)

Inspects, diffs, resolves, and prunes quarantined sync conflict copies (`.conflict.md`) and deletion rescue backups (`.deleted.md`) in `<collection>/conflicts/`. Running `emit conflicts` with no subcommand defaults to `list`.

```bash
# 1. List all quarantined copies and deletion backups
emit conflicts list [-c, --collection <collection>]

# 2. View unified diff between a quarantined copy and its canonical article
emit conflicts diff <filePath> [-c, --collection <collection>]

# 3. Resolve a conflict by accepting the quarantined local copy or the canonical file
emit conflicts resolve <filePath> --accept-local [-f, --force] [-c, --collection <collection>]
emit conflicts resolve <filePath> --accept-canonical [-c, --collection <collection>]

# 4. Prune old rescue copies
emit conflicts prune [--older-than <duration>] [--allow-orphan-rescues] [--dry-run] [-c, --collection <collection>]
```

---

### 10. `emit doctor`

Runs offline-by-default diagnostic checks across the workspace and `.emit/cache.db`, with opt-in remote probes.

```bash
emit doctor [-c, --collection <collection>] [--strict-media] [--check-media-urls] [--check-media-library] [--check-auth] [-p, --profile <name>]
```

- `--strict-media`: Treat missing local media mirrors as errors instead of warnings.
- `--check-media-urls`: _(Opt-in network)_ Probe `HEAD /_emdash/api/media/file/<storageKey>` for locally unresolved media references.
- `--check-media-library`: _(Opt-in network)_ Walk the remote media library via metadata only to report total remote assets vs local mirror coverage.
- `--check-auth`: _(Opt-in network)_ Probe `GET /_emdash/api/content/<collection>?limit=1` to verify token validity (`2xx` ok, `401`/`403` error, `404`/`5xx`/unreachable warning).

---

### 11. `emit pull-taxonomies`

Standalone command to download remote categories and tags into `categories/*.yaml` and `tags/*.yaml`.

```bash
emit pull-taxonomies [-p, --profile <name>]
```

---

### 12. `emit pull-media`

Downloads media assets and companion `.yaml` metadata into `media/<markdownRef>.<ext>`.

```bash
emit pull-media [-a, --article <id-or-path>] [--storage-key <key...>] [--all] [--no-prune] [--metadata-only] [-p, --profile <name>]
```

- `-a, --article <id-or-path>`: Pull only media assets referenced by a specific article (`featuredImage` and body images).
- `--storage-key <key...>`: Mirror one or more specific R2 `storageKey`s (reports 3 explicit outcomes: mirrored, orphan `[UNRESOLVED_MEDIA_ASSET]` exiting 1, or healthy/already-verified needing no download).
- `--all`: Walk the entire remote media library without limit (**Maintenance / Full Backup Only**; default window is `mediaSyncLimit: 100`).
- `--no-prune`: Disable automatic pruning of unreferenced local mirrors whose remote records were deleted (pruning only runs when `walkComplete === true`).
- `--metadata-only`: Download companion `.yaml` files only.

---

### 12b. `emit push-media`

Uploads standalone local image file(s) to the remote EmDash media library and/or updates `alt` and `caption` metadata on existing media records (symmetric counterpart to `emit pull-media`).

```bash
emit push-media <targets...> [--alt <text>] [--caption <text>] [-p, --profile <name>]
```

- `<targets...>`: One or more targets:
  - **Mode A (`media/<stem>.yaml`)**: Updates remote `PUT /_emdash/api/media/{mediaId}` from `--alt` / `--caption` flags (and writes them back to the `.yaml` preserving all other fields) or, when flags are omitted, pushes the `alt` and `caption` values edited directly in `media/<stem>.yaml`.
  - **Mode B (local image file)**: If the image is an already-mirrored `media/<stem>.<ext>` with a valid companion `media/<stem>.yaml` `id:`, deterministically routes to Mode A metadata update. Otherwise validates via `probeLocalImageFile()`, uploads via the 4-phase upload contract (or dedup), and mirrors into `media/<markdownRef>.<ext>` + `.yaml` (moving files from `media/drafts/*` and copying external paths so originals are preserved).
  - **Mode C (`<mediaId>` or `<storageKey>`)**: Resolves `storageKey` to its 26-character D1 `mediaId` (never passing `storageKey` directly to `PUT /_emdash/api/media/{mediaId}`) and updates remote metadata.
- `--alt <text>` / `--caption <text>`: Explicit metadata values to set (pass `""` to clear an existing value).
- **Note on Media Ordering**: `createdAt` is server-assigned when the D1 record ULID is issued (= upload order). Emit never parses EXIF metadata and exposes no upload sorting flags.

---

### 12c. `emit delete-media`

Safely deletes one or more media records from the remote EmDash server and local `media/` mirror, enforcing Guard **G20 (`MEDIA_IN_USE_PROTECTION`)** and moving deleted local files into `media/_trash/<stem>.deleted.*`.

```bash
emit delete-media <targets...> [--dry-run] [--no-backup] [-c, --collection <collection>] [-p, --profile <name>]
```

- `<targets...>`: One or more local mirror files (`media/<stem>.<ext>` or `media/<stem>.yaml`), R2 `storageKey`s, or 26-character D1 `mediaId`s. (`storageKey` is resolved to its D1 `mediaId` before `DELETE /_emdash/api/media/{mediaId}`).
- `--dry-run`: Offline preview of target resolution and Guard G20 local reference checks (`0` network calls; works without an auth token in CLI).
- `--no-backup`: Unlink local mirror files directly after remote `DELETE` instead of moving them to `media/_trash/<stem>.deleted.*`.
- `-c, --collection <collection>`: Collection to scan for local references (defaults to `"posts"`). Every report includes `[LOCAL_REFERENCE_SCAN_ONLY] references from articles outside this workspace are NOT checked`.

---

### 13. `emit article-search`

Searches articles exhaustively across the local workspace and `.emit/cache.db` snapshot (0-HTTP, no auth token required) by keyword, taxonomy, status, slug, or date range — or passes `--live` for keyword-only remote FTS. Omit `[query]` to browse recent articles.

```bash
emit article-search [query] [-t, --tag <slug>] [-c, --category <slug>] [--status <draft|published>] [--slug <slug>] [--since <date>] [--until <date>] [--date-field <publishedAt|updatedAt|createdAt>] [--live] [-l, --limit <n>] [--include-conflicts] [-p, --profile <name>]
```

- `--since` / `--until`: Accepts `today`, `yesterday`, or `YYYY-MM-DD`. Malformed values fail with `DATE_BOUNDARY_INVALID`.
- `--live`: Query EmDash `/_emdash/api/search` (FTS) directly. Requires a non-empty keyword query and rejects `--tag`, `--category`, `--status`, `--since`, and `--until` (`LIVE_SEARCH_UNSUPPORTED_FILTER`). Enriches hits with `snapshot_articles` status/dates when available (`[enriched: snapshot (unverified)]` when rev cannot be verified).
- `-l, --limit <n>`: Max hits to return (default: `20`, max: `50`). When more matches exist, `truncatedHint` advises raising `--limit`.
- Freshness & coverage framing (`buildSnapshotSearchFraming`): Reports `snapshotStatus` (`fresh` < 7d, `stale` >= 7d, or `missing`), `absenceGuaranteed`, and actionable next steps (`emit snapshot capture` or `--live`).

---

### 14. `emit media-search`

Searches media exhaustively across local workspace mirrors (`media_state` + `media/*.yaml`) and `.emit/cache.db` `snapshot_media` (0-HTTP, no auth token required) by filename, alt text, caption, and `storageKey`. Omit `[query]` to browse newest media assets.

```bash
emit media-search [query] [-l, --limit <n>] [--mirrored-only] [--since <date>] [--until <date>] [--suggest-keywords] [-p, --profile <name>]
```

- `-l, --limit <n>`: Max hits (default: `20`, max: `50`).
- `--mirrored-only`: Filter to assets already mirrored in `media/` (excludes snapshot-only records).
- `--suggest-keywords`: Append top local tag slugs as keyword suggestions.

---

### 15. `emit snapshot`

Captures, inspects, or clears a full-library metadata snapshot (articles, media, taxonomies) in `.emit/cache.db` (Schema v8) for exhaustive 0-HTTP search, `--from-snapshot` offline article restore, opt-in `media/_cache/` binary caching, and 0-GET remote taxonomy filtering.

```bash
emit snapshot [-c, --collection <collection>] [--status] [--clear] [--prune-cache] [--include-media | --no-include-media] [--media-cache-limit <n>] [--media-cache-max-bytes <bytes>] [--concurrency <number>] [-p, --profile <name>]
```

---

### 16. `emit guide`

Prints the Golden Path workflow cheat sheet, two-ID-space reminder, and AI collaboration safety rules to stdout (zero network or workspace context required).

```bash
emit guide
```

---

### 17. `emit mcp`

Starts the Emit Model Context Protocol (MCP) server over stdio.

```bash
emit mcp [-w, --workspace <path>]
```

---

## Part 2: Model Context Protocol (MCP) Tool Reference

All 17 MCP tools attach structured `_meta` (`profile`, `workspace`, `origin`, `resolvedBy`) to every response and format errors via `formatToolError()` with error codes and remediation suggestions.

| #   | MCP Tool Name          | CLI Equivalent         | Key Parameters (Zod Schema)                                                                                                                                                                                                                            | Description                                                                                                                                                                                                  |
| --- | ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `sync_status`          | `emit status`          | `collection?`, `status?` (`"draft"\|"published"\|"all"`), `search?`, `limit?`, `profile?`                                                                                                                                                              | Inspect local workspace tracking status, summary counts, and `actionRequired` items.                                                                                                                         |
| 2   | `sync_diff`            | `emit diff`            | `filePath?`, `id?`, `profile?`                                                                                                                                                                                                                         | Inspect unified diff between local working file and reconstructed baseline snapshot.                                                                                                                         |
| 3   | `sync_new`             | `emit new`             | `slug` _(required)_, `title?`, `collection?`, `locale?`, `byline?`, `categories?`, `tags?`, `description?`, `featuredImage?`, `profile?`                                                                                                               | Scaffold a new draft article offline with canonical ULID, one-shot frontmatter, G18 duplicate-slug check, and taxonomy hints.                                                                                |
| 4   | `sync_pull`            | `emit pull`            | `collection?`, `id?`, `filePath?`, `status?`, `force?`, `noPrune?`, `prune?`, `postsOnly?`, `noMedia?`, `includeMedia?`, `metadataOnly?`, `localMediaRefs?`, `fromSnapshot?`, `restoreMedia?`, `staleThresholdDays?`, `profile?`                       | Pull batch sliding window (articles + taxonomies + on-demand referenced media), pull a single article by `id`/`filePath`, or restore offline from snapshot (`fromSnapshot: true`).                           |
| 5   | `sync_push`            | `emit push`            | `filePath` _(required)_, `allowPublish?`, `allowModifiedOpaqueBlocks?`, `noTaxonomyAudit?`, `allowUnappliedTaxonomies?`, `allowWipeTaxonomies?`, `resolveTaxonomy?` (`"union"\|"local"\|"remote"`), `revive?`, `force?`, `localMediaRefs?`, `profile?` | Push a single article with preflight guards (G1–G19), distributed lock, 3-way merge, and `media/drafts/*` auto-upload.                                                                                       |
| 6   | `sync_delete`          | `emit delete`          | `filePath?`, `id?`, `allowDeletePublished?`, `discardLocalEdits?`, `dryRun?`, `profile?`                                                                                                                                                               | Delete an article locally and remotely after creating a `.deleted.md` rescue backup in `conflicts/`.                                                                                                         |
| 7   | `sync_conflicts`       | `emit conflicts`       | `action?` (`"list"\|"diff"\|"resolve"\|"prune"`, defaults to `"list"`), `filePath?`, `strategy?` (`"accept-local"\|"accept-canonical"`), `force?`, `olderThan?`, `allowOrphanRescues?`, `dryRun?`, `collection?`, `profile?`                           | List, diff, resolve, or prune quarantined `.conflict.md` and `.deleted.md` rescue copies.                                                                                                                    |
| 8   | `sync_doctor`          | `emit doctor`          | `collection?`, `strictMedia?`, `checkMediaUrls?`, `checkMediaLibrary?`, `checkAuth?`, `profile?`                                                                                                                                                       | Run workspace diagnostics (offline by default; opt-in remote probes via `checkAuth`, `checkMediaUrls`, `checkMediaLibrary`).                                                                                 |
| 9   | `sync_pull_taxonomies` | `emit pull-taxonomies` | `profile?`                                                                                                                                                                                                                                             | Standalone sync of remote categories and tags into `categories/*.yaml` and `tags/*.yaml`.                                                                                                                    |
| 10  | `sync_pull_media`      | `emit pull-media`      | `article?`, `storageKey?`, `limit?`, `all?`, `noPrune?`, `downloadFiles?`, `profile?`                                                                                                                                                                  | Mirror media assets by article (`article`), specific key (`storageKey`), or bounded library window (`mediaSyncLimit`).                                                                                       |
| 11  | `sync_push_media`      | `emit push-media`      | `targets` _(required, `string[]`)_, `alt?`, `caption?`, `profile?`                                                                                                                                                                                     | Upload standalone local image file(s) (`media/drafts/*` move or external copy) and/or sync `alt`/`caption` metadata from flags or local `media/<stem>.yaml`.                                                 |
| 12  | `sync_delete_media`    | `emit delete-media`    | `targets` _(required, `string[]`)_, `dryRun?`, `noBackup?`, `collection?`, `profile?`                                                                                                                                                                  | Delete unreferenced media asset(s) from remote and local `media/` with Guard G20 (`MEDIA_IN_USE_PROTECTION`) and rescue backup to `media/_trash/` (MCP requires an authenticated profile even for `dryRun`). |
| 13  | `sync_media_search`    | `emit media-search`    | `query?`, `since?`, `until?`, `limit?`, `mirroredOnly?`, `suggestKeywords?`, `profile?`                                                                                                                                                                | Exhaustive 0-HTTP search across local mirrors and `snapshot_media` with `snapshotStatus` (`fresh`/`stale`/`missing`) framing.                                                                                |
| 14  | `sync_article_search`  | `emit article-search`  | `query?`, `tag?`, `category?`, `status?`, `slug?`, `since?`, `until?`, `dateField?`, `live?`, `limit?`, `includeConflicts?`, `profile?`                                                                                                                | Exhaustive 0-HTTP search across local Markdown and `snapshot_articles` (with `snapshotStatus` framing), or keyword-only remote FTS with `live: true`.                                                        |
| 15  | `sync_snapshot`        | `emit snapshot`        | `action?` (`"capture"\|"status"\|"clear"\|"prune-cache"`, defaults to `"capture"`), `collection?`, `concurrency?`, `includeMedia?`, `mediaCacheLimit?`, `mediaCacheMaxBytes?`, `profile?`                                                              | Capture, inspect, clear, or prune the full-library metadata snapshot and opt-in `media/_cache/` binaries in `cache.db`.                                                                                      |
| 16  | `profile_list`         | `emit profile list`    | _(none)_                                                                                                                                                                                                                                               | List all configured profiles, origins, workspaces, and active resolution rationale.                                                                                                                          |
| 17  | `profile_switch`       | `emit profile use`     | `name` _(required)_, `persist?`                                                                                                                                                                                                                        | Switch the active session/default profile for multi-site operation.                                                                                                                                          |
| 18  | `sync_publish`         | `emit publish`         | `target` _(required)_, `localMediaRefs?`, `profile?`                                                                                                                                                                                                   | Promote a staged remote draft (`published*`) or `draft` article to live `published` status without re-uploading content (enforces local unmodified check & Guard G22).                                       |
| 19  | `sync_discard_draft`   | `emit discard-draft`   | `target` _(required)_, `force?`, `localMediaRefs?`, `profile?`                                                                                                                                                                                         | Discard a staged remote draft on a `published` article and re-pull the live version (enforces Guard G21; `force: true` quarantines unpushed local edits to `posts/conflicts/`).                              |
| 18 | `sync_publish` | `emit publish` | `target` *(required)*, `localMediaRefs?`, `profile?` | Promote a staged remote draft (`published*`) or `draft` article to live `published` status without re-uploading content (enforces local unmodified check & Guard G22). |
| 19 | `sync_discard_draft` | `emit discard-draft` | `target` *(required)*, `force?`, `localMediaRefs?`, `profile?` | Discard a staged remote draft on a `published` article and re-pull the live version (enforces Guard G21; `force: true` quarantines unpushed local edits to `posts/conflicts/`). |
