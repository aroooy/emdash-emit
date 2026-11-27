# Taxonomies (Two-Layer Representation) & Bylines Specifications

This document specifies Emit's taxonomy synchronization (`src/sync/taxonomies.ts`, `src/sync/terms.ts`, `src/utils/taxonomy-key.ts`, `src/utils/taxonomy-term-match.ts`), the Two-Layer Representation (Layer A canonical percent-encoded slugs vs Layer B human-readable decoded CJK display), deterministic collision resolution, 0-GET deleted taxonomy auto-healing, pre-PUT remote taxonomy auditing, and author bylines management (`src/sync/bylines.ts`).

---

## 1. Two-Layer Taxonomy Representation (Layer A vs Layer B)

EmDash stores non-ASCII category and tag slugs on the server as lowercase percent-encoded strings (e.g. `"%e6%9c%aa%e5%88%86%e9%a1%9e"` for `未分類`). Writing raw percent-encoded strings into Markdown frontmatter or YAML files makes articles unreadable for human authors and AI agents.

Emit solves this with a strict **Two-Layer Representation**:

| Layer                                       | Representation                                 | Example                                   | Where It Lives                                                                                                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Layer A: Canonical Transport & Baseline** | Lowercase percent-encoded slug (or ASCII slug) | `"%e6%9c%aa%e5%88%86%e9%a1%9e"`, `"tech"` | `base_snapshots.frontmatter_yaml` (JSON), `computeTaxonomyHash()`, remote API payloads                                                                                                                                                   |
| **Layer B: Human & Disk Display**           | Decoded Unicode string (`decodeURIComponent`)  | `未分類`, `カメラレビュー`, `tech`        | Article YAML frontmatter on disk (`posts/<locale>/draft/*.md`, `posts/<locale>/published/*.md`), taxonomy definition YAML (`categories/<locale>/*.yaml`, `tags/<locale>/*.yaml`, including `locale` & `translationGroup`), CLI/MCP hints |

### 1.1 Taxonomy Definition Files (`categories/<locale>/*.yaml`, `tags/<locale>/*.yaml`)

Each synced category or tag is written to `<taxonomy>/<locale>/<id>-<sanitizedLabel>.yaml`:

```yaml
id: 01M6CAT2ABCDEF123456789012
taxonomy: categories
name: ローカルガイド
slug: ローカルガイド # Layer B: human-readable decoded slug
canonicalSlug: '%e3%83%ad%e3%83%bc%e3%82%ab%e3%83%ab%e3%82%ac%e3%82%a4%e3%83%89' # Layer A: preserved raw remote slug (omitted when identical to slug, e.g. ASCII "tech")
count: 14
```

- `readTaxonomyDir()` seamlessly loads both Two-Layer definitions (`slug` + `canonicalSlug`) and legacy single-slug definitions.
- Partial Failure Resilience: During `emit pull` or `emit pull-taxonomies`, if one taxonomy endpoint fails (e.g. categories fail while tags succeed), Emit preserves the existing local YAML definitions for the failed taxonomy and outputs a standardized warning via `formatTaxonomySyncFailure()` (`src/presentation/pull_report.ts`).

### 1.2 Flexible Frontmatter Input & Resolution (`src/utils/taxonomy-term-match.ts`)

When an author or AI agent edits `taxonomies.categories` or `taxonomies.tags` in an article's frontmatter, Emit accepts any of the following forms and resolves them to the canonical term record:

1. **Decoded display slug** (e.g. `未分類`, `カメラレビュー`)
2. **Canonical percent-encoded slug** (e.g. `"%e6%9c%aa%e5%88%86%e9%a1%9e"`)
3. **Unique term `name`** (display label)
4. **Canonical 26-character term ULID** (e.g. `01M6CAT2ABCDEF123456789012`)

On the next pull or push commit, Emit normalizes the frontmatter on disk to the clean Layer B decoded slug (`    - 未分類`).

### 1.3 Deterministic Slug Collision Resolution

If multiple remote terms share the exact same canonical slug:

- **Winner Selection**: `loadLocalTaxonomyMaps()` selects a deterministic winner ordered by **`count DESC` → `id (ULID) DESC`** to claim the slug in `slugToId`.
- **Targeting a Loser Term**: Writing the shared slug in frontmatter resolves to the winner term. To assign a loser term specifically, write its unique display `name` (if unique) or its **26-character term ULID** in frontmatter.
- **Hint Deduplication**: Summary and hint outputs (`Available Categories` / `Available Tags`) deduplicate shared slugs via `dedupeBySlug` so only winner terms are suggested.

---

## 2. 0-GET Pruned Taxonomy Auto-Healing on Pull

When a category or tag is deleted in EmDash, EmDash does **not** increment `posts.version` or `posts.updatedAt` on articles that referenced that term.

To prevent stale deleted terms from lingering in local files and causing Preflight Guard **G4 (`INVALID_TAXONOMY_ERROR`)** failures on subsequent edits:

1. During batch `emit pull` / `sync_pull` (where taxonomies are refreshed upfront), `tryFastPathOrHeal()` (`src/sync/pull/fast_path.ts`) inspects untouched local articles (`currentDiskHash === existingSync.localHash`) with **0 extra GET requests (0-GET)**.
2. Any frontmatter term that no longer exists in the freshly synced `categories/` or `tags/` definitions is automatically pruned in place.
3. **Full Baseline Rewrite (`bumpBaselineHashOnly: false`)**: Both the disk file and `base_snapshots.frontmatter_yaml` are updated atomically so `emit diff` and `emit status` never report phantom diffs.
4. **Empty Array Preservation (`tags: []`)**: If all terms in a taxonomy are pruned, the empty array key (`tags: []`) is preserved in frontmatter so any leftover remote orphan relation is cleanly cleared on the next push.
5. **Unpushed Edit & Epistemic Protection**:
   - Articles with unpushed local modifications (`currentDiskHash !== existingSync.localHash`) are **never** auto-pruned.
   - If taxonomy sync was skipped (`--posts-only`) or failed (`canPruneTaxonomies === false`), auto-pruning is completely suppressed.

---

## 3. Remote Taxonomy Audit, Wipe Guard (G19) & Partial Apply (G17)

### 3.1 Pre-PUT Remote Taxonomy Audit (`src/sync/push/tax_audit.ts`)

Because out-of-band taxonomy edits on EmDash do not bump the article's `_rev`, a standard article `PUT` would not return HTTP 409 when only remote categories or tags changed.

- Before pushing taxonomy updates (unless `--no-taxonomy-audit` is passed), `auditRemoteTaxonomies()` compares the remote article's live taxonomy assignments against the local `base_snapshots`.
- If remote taxonomies diverged from baseline while local taxonomies also changed, Emit triggers the 3-way taxonomy merge stage (`src/sync/push/merge_stage.ts`) instead of silently overwriting remote terms.

### 3.2 Destructive Taxonomy Wipe Guard (Guard G19 / `DESTRUCTIVE_TAXONOMY_WIPE`)

- Pushing an empty taxonomy array (`categories: []` or `tags: []`) when the article previously held terms is blocked by Guard **G19** unless confirmed via `--allow-wipe-taxonomies` (MCP `allowWipeTaxonomies: true`) or an explicit `--resolve-taxonomy local|remote` conflict resolution strategy.
- **Remote Audit Parity Bypass**: If `auditRemoteTaxonomies` confirms that remote assignments are already empty (`remoteCount === 0`, e.g. after a term was deleted on the server), Guard G19 in `src/sync/push/taxonomy_plan.ts` is bypassed automatically and `POST { termIds: [] }` is dispatched to clean up remote orphan relations without requiring `--allow-wipe-taxonomies`. (Note: the 409 merge path in `push/merge_stage.ts` evaluates G19 against observed live remote terms independently and remains strict).

### 3.3 Taxonomy Partial Failure Guard (Guard G17 / `TAXONOMY_APPLY_PENDING`)

Updating an article on EmDash requires two separate HTTP calls: `PUT /content/{collection}/{id}` (body & scalar frontmatter) followed by `POST /content/{collection}/{id}/terms` (taxonomy assignments).

- If the article body `PUT` succeeds but the subsequent taxonomy `POST` fails, Emit records `taxonomy_apply_pending = 1` in `sync_state` and reverts the baseline taxonomy snapshot and hash to their prior values.
- Subsequent bare pushes of that article are blocked by Guard **G17 (`TAXONOMY_APPLY_PENDING`)** so the unapplied taxonomy change is never silently forgotten.
- **Resolution**: Run `emit pull-taxonomies` (or `emit pull <id>`), verify permissions, and re-run `emit push <file>` (or pass `--allow-unapplied-taxonomies` / `--force` to override).

---

## 4. Author Bylines Synchronization (`src/sync/bylines.ts`)

- **Automatic Cache Sync**: During `emit pull` / `sync_pull`, Emit queries EmDash's `/_emdash/api/mcp` (`byline_list`) endpoint and caches author records (`id`, `slug`, `display_name`, `is_guest`) in the `bylines` table of `.emit/cache.db`.
- **Slug ⇔ ULID Resolution**: Frontmatter `bylines:` stores human-readable author slugs (`- aroooy`), which Emit resolves to canonical author ULIDs when building remote payloads.
- **Deterministic Default Author on `emit new` / `sync_new`**: When scaffolding a new draft without `--byline` (`byline`), Emit automatically populates `bylines:` with the first cached non-guest author (`is_guest = 0`) ordered deterministically by `slug ASC`.
