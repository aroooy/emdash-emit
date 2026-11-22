---
name: blast-radius
description: >-
  Analyze what a change in emdash-emit could break beyond the diff—especially across
  Layer 0 (src/db, src/client, src/utils), Layer 1 (src/sync upstream), SQLite cache.db
  migrations, Two-Layer Representation, and CLI/MCP symmetry—and prove the one fact
  its safety depends on by running real code.
---

# Blast Radius (Impact & Safety Proof for Emit)

Find what a change in `emdash-emit` could break somewhere else before it ships, beyond what `grep` shows, and **prove the core fact its safety depends on by running real code**.

Listing callers with `grep` is not the job. The job is finding the implicit couplings `grep` misses and proving safety at **Level 4 ("You ran it")**.

---

## 1. The 5-Level Certainty Ladder

For each safety claim your change depends on, push it to **Step 4 or 5** and state where it stopped:

1. **You said so** — Worthless on its own.
2. **You pointed at `file:line`** — Necessary, not sufficient.
3. **You traced the execution path** — Showed step-by-step why the bad state cannot reach.
4. **You ran it (Required Default)** — A Vitest test or probe script that calls the real Emit code and fails loud if the assumption is false.
5. **You reproduced it end-to-end via CLI / MCP server** — Ran `emit <cmd>` or an MCP tool handler against a real temporary workspace and SQLite `cache.db`.

---

## 2. Where `grep` Stops in `emdash-emit` (Mandatory Checkpoints)

Whenever you touch Layer 0, Layer 1, or SQLite persistence, check these 5 non-obvious blast zones:

1. **SQLite `cache.db` Schema & Hash Invariants (`src/db/migrations.ts`, `src/db/cache.ts`)**:
   - Does a schema migration (v1 → v6+) alter any column read by `reconstructBaseline()` or invalidate existing `sync_state.local_hash` values? (Verify with `npx vitest run tests/migration_hash_invariants.test.ts tests/cache.test.ts`.)
   - Are `snapshot_articles` / `snapshot_meta` (collection-scoped) and `snapshot_media` (site-wide, preserved until the last `snapshot_meta` row is cleared) kept consistent?
2. **Two-Layer Representation Round-Trip (`Layer A` ⇔ `Layer B`)**:
   - **Layer A** (`base_snapshots.frontmatter_yaml` JSON & remote payloads): canonical percent-encoded taxonomy slugs (`"%e6%9c%aa%e5%88%86%e9%a1%9e"`) and `/_emdash/api/media/file/<storageKey>`.
   - **Layer B** (on-disk Markdown): decoded CJK slugs (`- 未分類`) and relative image paths (`../../media/<storageKey>`).
   - If you touch `formatYamlScalar`, `parseMarkdownLenient`, `reconstructBaseline`, or `disk-spelling.ts`, does an unmodified local file still report `synced` without false diffs? (Verify with `npx vitest run tests/taxonomies_two_layer.test.ts tests/local_media_refs.test.ts tests/baseline_reconstruction.test.ts`.)
3. **Two-Track Revisions & Draft Selective Single GET**:
   - Does `base_snapshots.rev` stay raw Track 1 (`revForTransport`) while `sync_state.remote_rev` uses composite Track 2 (`${version}@draft:${draftRevisionId}` / `${version}@live:${liveRevisionId}`)?
   - Are `published*` articles (`hasUncommittedDraftRevision`) kept in `posts/published/` with `status: published # draft revision`? (Verify with `npx vitest run tests/api_rev.test.ts tests/push_transport_rev.test.ts tests/status_unpublished_draft.test.ts`.)
4. **Read-Only Inspector Cache Purity**:
   - Read-only search (`article-search`, `media-search`) must pass `healOnSpellingMatch: false` to `isLocalFileUnmodified()` and never mutate `.emit/config.json` or `sync_state.local_hash` from MCP.
5. **CLI ⇔ MCP Presentation & Error Symmetry (`src/presentation/`, `src/mcp/tool-errors.ts`)**:
   - Does a change to a shared formatter or error class preserve `_meta` attachment, `isError: true`, and CLI/MCP wording parity? (Verify with `npx vitest run tests/presentation_symmetry.test.ts tests/mcp_tool_errors.test.ts`.)

---

## 3. Required Output Format

- **What Changed**: Including non-obvious behavioral or data-shape changes.
- **The One Fact It's Safe Because Of**: State the core invariant that clears the risk, the Certainty Ladder step reached (must be Step 4 or 5), and the exact command + output proving it.
- **Confirmed Risks**: Each with `file:line`, likelihood, impact, and verification command.
- **Cleared Zones**: Implicit boundaries checked and proven unaffected.
