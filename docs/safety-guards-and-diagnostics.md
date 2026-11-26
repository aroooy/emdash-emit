# Safety Guardrails (G1–G22), Diagnostics, Search & Troubleshooting

This document is the authoritative specification for Emit's 20 safety guardrails (`src/sync/guards.ts`, `src/sync/preflight.ts`, `src/sync/media/delete_media.ts`), static guard registry verification rules (`tests/guards.test.ts`), `emit doctor` diagnostic vectors (`src/sync/doctor.ts`), epistemic search invariants (`src/sync/article_search/`, `src/sync/media/`), and troubleshooting FAQ.

---

## 1. Safety Guardrails Registry (G1–G22)

All safety guardrails are centrally registered in `GUARD_REGISTRY` (`src/sync/guards.ts`) with remediation guidance:

| Guard   | Error / Warning Code(s)                                                                                                                                                              | Enforcement Stage & Description                                                                                                                                                                                                                                                                                                               | Severity               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **G1**  | `SINGLE_TARGET_GUARD`                                                                                                                                                                | Enforces an explicit target (`filePath`, `id`, or `--all`) for push/pull; prohibits blind bulk pushes in MCP (`sync_push` requires `filePath`).                                                                                                                                                                                               | Error                  |
| **G2**  | `ID_MISMATCH_ERROR`                                                                                                                                                                  | Verifies that frontmatter `id` matches the 26-char ULID in the filename; prevents manual `mv` renames from corrupting cache associations.                                                                                                                                                                                                     | Error                  |
| **G3**  | `UNINTENDED_PUBLISH_GUARD`                                                                                                                                                           | Blocks promoting an article to `status: published` (or publishing an uncommitted draft revision on a `published*` article) unless `--allow-publish` (`allowPublish: true`) is passed.                                                                                                                                                         | Error                  |
| **G4**  | `INVALID_TAXONOMY_ERROR`                                                                                                                                                             | Validates `taxonomies.categories` and `taxonomies.tags` against local `categories/*.yaml` and `tags/*.yaml` definitions (transparently resolving valid term ULIDs).                                                                                                                                                                           | Error                  |
| **G5**  | `LOCAL_IMAGE_DETECTED` / `INLINE_LOCAL_IMAGE_NOT_SUPPORTED`                                                                                                                          | Rejects local image paths outside `media/drafts/` (unless resolved to an already-promoted `media/` asset) and rejects inline paragraph local images (must be on a standalone line).                                                                                                                                                           | Error                  |
| **G6**  | `UNRESOLVED_CONFLICT_MARKERS`                                                                                                                                                        | Scans for Git 3-way merge conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) and blocks push. **Evaluated strictly before G16.**                                                                                                                                                                                                              | Error                  |
| **G7**  | `TITLE_DUPLICATION_AUTOTRIM`                                                                                                                                                         | Detects a redundant top-level `# Title` heading at the start of the Markdown body matching frontmatter `title` and trims it automatically.                                                                                                                                                                                                    | Warning                |
| **G8**  | `UNSUPPORTED_SYNTAX_WARNING`                                                                                                                                                         | Warns on unsupported block HTML, tilde code fences (`~~~`), Setext underlined headings (`===` / `---`), or unterminated backtick code fences (`detectCodeFenceIssues`).                                                                                                                                                                       | Warning                |
| **G9**  | `MODIFIED_OPAQUE_BLOCK`                                                                                                                                                              | Classifies `<!--ec:block ... -->` edits against `base_snapshots`: permits safe `image` layout/caption edits, pure removals, and reorderings with warnings; blocks structural tampering or invalid added `image` URLs unless `--allow-modified-opaque-blocks` (`allowModifiedOpaqueBlocks: true`) is passed.                                   | Error                  |
| **G10** | `INVALID_FEATURED_IMAGE`                                                                                                                                                             | Verifies that `featuredImage` is a 26-char canonical media record ULID, a valid local draft/promoted path under `media/`, or `null`.                                                                                                                                                                                                          | Error                  |
| **G11** | `LOCAL_IMAGE_AUTO_UPLOAD` (`MISSING_LOCAL_IMAGE_FILE` / `INVALID_LOCAL_IMAGE_TYPE` / `LOCAL_IMAGE_SIZE_EXCEEDED` / `PROMOTED_MEDIA_NOT_FOUND_REMOTE` / `MEDIA_EXISTENCE_UNVERIFIED`) | Validates standalone `media/drafts/<file>` images (existence, extension, ≤ 50 MiB), queues auto-upload and `media/<markdownRef>.<ext>` promotion, and verifies reused assets via `GET /_emdash/api/media/{id}`.                                                                                                                               | Info / Warning / Error |
| **G12** | `QUARANTINED_COPY_NOT_PUSHABLE`                                                                                                                                                      | Refuses to push any rescue copy residing under `<collection>/conflicts/` before any network request.                                                                                                                                                                                                                                          | Error                  |
| **G13** | `CANONICAL_HAS_UNPUSHED_EDITS`                                                                                                                                                       | Protects canonical articles from being overwritten during `emit conflicts resolve --accept-local` when the canonical file has unpushed local modifications (requires `--force`).                                                                                                                                                              | Error                  |
| **G14** | `QUARANTINED_PATH_REQUIRED`                                                                                                                                                          | Restricts `emit conflicts diff` and `emit conflicts resolve` targets strictly to paths inside `<collection>/conflicts/`.                                                                                                                                                                                                                      | Error                  |
| **G15** | `DELETE_PENDING_ARTICLE`                                                                                                                                                             | Blocks pushing an article marked `delete_pending = 1` (unconfirmed remote deletion); requires `--revive` or `--force`.                                                                                                                                                                                                                        | Error                  |
| **G16** | `TAXONOMY_CONFLICT_PENDING`                                                                                                                                                          | Blocks re-pushing an article with `taxonomy_conflict_pending = 1` from a prior 3-way merge; requires `--resolve-taxonomy <union\|local\|remote>` or `--force`.                                                                                                                                                                                | Error                  |
| **G17** | `TAXONOMY_APPLY_PENDING`                                                                                                                                                             | Blocks bare re-push when a prior push succeeded on body PUT but failed on taxonomy POST (`taxonomy_apply_pending = 1`); requires `--allow-unapplied-taxonomies` or `--force`.                                                                                                                                                                 | Error                  |
| **G18** | `DUPLICATE_SLUG_CONFLICT`                                                                                                                                                            | Offline pre-check during `emit new` / `sync_new` that blocks creating a scaffold whose slug already exists in local `draft/`, `published/`, or SQLite cache index.                                                                                                                                                                            | Error                  |
| **G19** | `DESTRUCTIVE_TAXONOMY_WIPE`                                                                                                                                                          | Blocks pushing empty taxonomy arrays (`categories: []` / `tags: []`) that would wipe existing remote assignments; requires `--allow-wipe-taxonomies`, `--resolve-taxonomy`, or `--force` (auto-bypassed when pre-PUT remote audit confirms `remoteCount === 0`).                                                                              | Error                  |
| **G20** | `MEDIA_IN_USE_PROTECTION`                                                                                                                                                            | Blocks `emit delete-media` / `sync_delete_media` before any network request when a target media asset is referenced by any local workspace article (`draft/`, `published/`, or `conflicts/`, excluding `.deleted.md` backups). Has no bypass flag; remove the reference from the article first. Always reports `[LOCAL_REFERENCE_SCAN_ONLY]`. | Error                  |
| **G21** | `DRAFT_ONLY_DISCARD_FORBIDDEN`                                                                                                                                                       | Blocks `emit discard-draft` / `sync_discard_draft` on `draft`-only articles that have no published live version. Use `emit delete` instead.                                                                                                                                                                                                   | Error                  |
| **G22** | `REMOTE_CHANGED_BEFORE_PUBLISH`                                                                                                                                                      | Blocks `emit publish` / `sync_publish` when the remote draft revision changed since the last sync (`!isSameRev(syncState.remoteRev, remoteComparisonRev)`), preventing local/remote body divergence. Run `emit pull` first.                                                                                                                   | Error                  |

### Guard Registry Static Verification Invariants (`tests/guards.test.ts` Rules 1–5)

1. **Rule 1 (Inclusion Check)**: Every guard code declared in `GUARD_REGISTRY` must appear in `src/`.
2. **Rule 2 (Rogue Code Exclusion)**: Every error code emitted anywhere in `src/` must be classified in `GUARD_REGISTRY`, `OPERATIONAL_ERROR_CODES`, or `PROTECTION_ERROR_CODES`.
3. **Rule 3 (Mutual Exclusivity & Sequential IDs)**: Guard error codes must not overlap across sets, and Guard IDs (`1..20`) must be strictly sequential without gaps.
4. **Rule 4 (Code-less Guard Validation)**: Validates runtime behavior for informational/auto-trim guards (`G1`, `G7`, `G8`, `G11` label).
5. **Rule 5 (Test Coverage Enforcement)**: Every one of the 21 unique guard error codes across 17 active guards must appear as an explicit string literal in `tests/` (excluding dynamic registry tests `tests/guards.test.ts` and `tests/presentation_symmetry.test.ts`).

---

## 2. Workspace Doctor Diagnostics (`src/sync/doctor.ts`)

`emit doctor` (MCP `sync_doctor`) validates 6 core health vectors plus 2 conditional checks:

1. **Check 1 — Version Compatibility**: Compares running Emit version against `createdWithVersion` / `lastSyncedVersion` in `.emit/config.json`.
2. **Check 2 — Origin Consistency**: Verifies alignment between `.emit/config.json`, resolved profile origin, and `EMDASH_ORIGIN`.
   - **Check 2b — Workspace Link Consistency** _(conditional)_: Reported only when a profile's registered `workspace` path has drifted from the current directory (`detectWorkspaceLinkDrift`). Guides re-linking with `emit init --profile <name>`.
   - **Check 2c — Auth Validity** _(opt-in via `--check-auth` / `checkAuth: true`)_: Sends exactly one authenticated `GET /_emdash/api/content/<collection>?limit=1` via `createAuthedFetch`. `2xx` → `ok`; `401`/`403` → `error` (remediation: `emit profile set-token <name>`); `404`/`5xx` or unreachable → `warning` (never asserts token invalidity on non-401/403 status).
3. **Check 3 — Frontmatter Integrity**: Parses all workspace articles. Files failing strict parse but recoverable via `parseMarkdownLenient()` are reported as `warning` (`healable: true` via `emit pull`); unrecoverable files are reported as `error`.
4. **Check 4 — Conflicts & Quarantine**: Reports `.conflict.md` and `.deleted.md` rescue copies in `<collection>/conflicts/`.
5. **Check 5 — Sync Status**: Verifies baseline snapshot presence and local hash tracking.
6. **Check 6 — Referenced Media Existence**: Scans article bodies (`scanClassifiedMediaReferences` in `src/utils/media-refs.ts`) and frontmatter `featuredImage`, matching references against local `media/` mirrors by storageKey stem (`storageKeyToMarkdownRef`). Unreferenced items (`media_isolated`, `status: 'ok'`) prioritize binary-backed assets in examples and label companion-only entries (`hasBinary: false`) as `media metadata entries (YAML companion only, no mirrored binary file)` without suggesting deletion.
   - _Offline Cache Availability (`media_cache_available`, `[MEDIA_CACHE_AVAILABLE]`)_: When missing references are already cached and size-verified in `media/_cache/`, emits an informational `ok` check (0-HTTP) guiding `emit pull --from-snapshot`.
   - _Opt-in `--check-media-urls` (`checkMediaUrls: true`)_: Probes `HEAD /_emdash/api/media/file/<storageKey>` for locally unresolved references, downgrading assets still served by R2 to informational notes.
   - _Opt-in `--check-media-library` (`checkMediaLibrary: true`)_: Walks the remote media library via metadata only (no binary downloads) and compares remote record count against local mirror count.

- **Offline-by-Default Invariant**: Without `--check-auth`, `--check-media-urls`, or `--check-media-library`, `emit doctor` performs **zero network requests**, and `runEnvironmentChecks()` remains a pure synchronous function. Unspecified opt-in flags emit no check entry at all.

---

## 3. Snapshot-First Search Invariants (`article-search` & `media-search`)

Emit provides exhaustive 0-HTTP search across both articles (`src/sync/article_search/`) and media (`src/sync/media/local_search.ts`), plus an explicit `--live` FTS mode for articles (`src/sync/article_search/remote.ts`):

1. **No Bounded Scan**:
   - Default `article-search` and `media-search` inspect 100% of local workspace files (`iterWorkspaceArticles` / `media_state` + `media/*.yaml`, excluding `media/_cache/` via `isReservedMediaSubdir()`) and cached `.emit/cache.db` snapshot rows (`snapshot_articles` / `snapshot_media`, surfacing `cached: true` when binary is cached in `media/_cache/`), with disk/mirror precedence and `list-stale` body exclusion (`[body unverified]`).
   - Display count is capped via `clampSearchLimit` (`limit` default `20`, max `50`), setting `truncated: true` and `truncatedHint` when more matches exist.
2. **Explicit `--live` / `live: true` FTS (`article-search` only)**:
   - Queries `/_emdash/api/search` directly for keyword-only searches and enriches hits from `snapshot_articles` (`enrichedFromSnapshot`, `enrichmentStale`).
   - Rejects `--tag`, `--category`, `--status`, `--since`, `--until`, or empty queries with `LIVE_SEARCH_UNSUPPORTED_FILTER` (no silent scan fallback). Trigram queries `< 3` chars returning 0 hits report `absenceGuaranteed: false` and suggest default snapshot-local search.
3. **AI-First `snapshotStatus` Framing (`buildSnapshotSearchFraming`)**:
   - Reports `snapshotStatus: 'fresh' | 'stale' | 'missing'` (`stale` when `ageDays >= 7`), `absenceGuaranteed`, `userNotice`, and `recommendedAction` consistently across CLI and MCP. When `hits.length === 0` and `snapshotStatus !== 'fresh'`, `absenceGuaranteed` is `false`.
4. **Diagnostic Census Boundary**:
   - `collectRemoteStorageKeys()` and `findUnmirroredStorageKeys()` (`src/sync/media/remote_index.ts`) are diagnostic census helpers used by `emit doctor --check-media-library` (not search).

---

## 4. Troubleshooting & FAQ

### Q1: Pruning skipped for out-of-window article(s) with unpushed modifications

- **Cause**: An article that fell outside the active sliding window (default: latest 30 posts per status) has unpushed local edits. Emit excludes that ULID from pruning and keeps the local file and `cache.db` entry untouched while completing the rest of the sync, surfacing a warning (`pruneSkipped`). _(Historically, versions prior to v0.1.61 aborted the pull by throwing `SyncPruneConflictError`.)_
- **Solution**: Push the changes first (`emit push <file>`), revert/delete the local edits, raise `postsSyncLimit` in `.emit/config.json`, or run `emit pull --no-prune` to suppress window pruning.

### Q2: How do I edit or reference an older article from years ago outside the 30-post window?

- **Solution**: Use `emit article-search <query>` (or filter by `--tag`, `--category`, `--since`, `--until`) to find the article's 26-character ULID, then pull it on demand:
  ```bash
  emit pull <26-char-ULID>
  ```
  If you permanently want a larger local working set on disk, raise `"postsSyncLimit": 300` in `.emit/config.json`.

### Q3: `PushValidationError`: Cannot publish article live without `--allow-publish` (Guard G3)

- **Cause**: Frontmatter has `status: published` (or the article is `published*` with an uncommitted remote draft revision and you want to publish it live).
- **Solution**: Run `emit push <file> --allow-publish` (MCP: `allowPublish: true`).

### Q4: `[INVALID_TAXONOMY_ERROR]`: Unknown category or tag during push (Guard G4)

- **Cause**: A category or tag in `taxonomies:` does not match any definition in `categories/*.yaml` or `tags/*.yaml` (or categories/tags were mistakenly placed at the top level of frontmatter instead of nested under `taxonomies:`).
- **Solution**: Ensure terms are nested under `taxonomies:`, and run `emit pull` or `emit pull-taxonomies` to refresh local taxonomy definitions.

### Q5: Images in an older article do not render in local Markdown preview / `[UNRESOLVED_MEDIA_ASSET]`

- **Cause**: Either the asset lies outside the default `mediaSyncLimit` (100) window and hasn't been mirrored yet, or the article was migrated and its body URL uses an R2 `storageKey` whose D1 record `id` is a different ULID (see [docs/media-id-spaces.md](./media-id-spaces.md)).
- **Solution**:
  1. Run `emit doctor --check-media-library` (metadata-only walk) to compare remote library size against local mirrors.
  2. Run `emit pull-media --article <article-id>` to mirror the article's referenced images on demand.
  3. Because a 404 on `GET /_emdash/api/media/{id}` only means the key in the URL is a `storageKey` rather than a primary key `id`, **never assume the D1 record is missing and never run a blind SQL INSERT**.

### Q6: `Auth Validity`: Configured credentials were rejected by `<origin>` (HTTP 401/403)

- **Cause**: `emit doctor --check-auth` received HTTP 401 or 403 because the Personal Access Token expired, was revoked, or lacks content permissions.
- **Solution**: Check the active profile with `emit profile current` and rotate the token safely without touching shell history:
  ```bash
  emit profile set-token <profile-name>
  # or pipe from keychain:
  security find-generic-password -s emdash-pat -w | emit profile set-token <profile-name> --stdin
  ```

### Q7: `[NETWORK_ERROR]`: Network request failed (`fetch failed`)

- **Cause**: The resolved `origin` URL is unreachable (DNS failure, offline state, or misconfigured origin in `profiles.yaml` / `.emit/config.json`).
- **Solution**: Check `emit profile current` and `emit profile list` to verify the resolved origin URL and resolution rationale (`Resolved by: ...`).
