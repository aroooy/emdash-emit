---
name: interrogate
description: >-
  Execution-proven adversarial review for emdash-emit code diffs, branches, and
  implementation plans (docs/plans/v0.1.0XX-*.md). Use when asked to "interrogate",
  "adversarial review", "challenge this", "find blind spots", or review a plan or diff.
  Only findings proven by an actual command, test run, or real file:line verification
  survive; all speculative findings are dropped.
---

# Interrogate (Execution-Proven Adversarial Review for Emit)

Adversaries try to break a change or an implementation plan in `emdash-emit`. **A finding survives only when a real execution or exact code/schema proof demonstrates the failure.** Report the verified findings; do not apply fixes unless asked.

---

## 1. Frame the Scope & Intent

1. **Determine Scope**:
   - If the user names a file, plan (`docs/plans/v0.1.0XX-*.md`), or commit range, use that.
   - Otherwise, inspect `git status -s` and `git diff` against `HEAD` (or the merge base with `main`).
2. **Restate Intent**:
   - Summarize in 2–3 sentences what the change or plan intends to guarantee and which of Emit's 7 Core System Invariants (`AGENTS.md` §3) it touches.

---

## 2. The Run-Proven Survival Rule (`prove-it-works`)

> **"Break this change. Prove each finding with a run against the real code."**

- **For Code Diffs / PRs**:
  - Every surviving finding **must** include:
    1. The exact command executed (`npx vitest run ...`, `npx tsx ...`, `node -e ...`, `npm run check:cycles`, etc.)
    2. The actual stdout/stderr output produced
    3. Why that output violates the intent or an `AGENTS.md` invariant.
- **For Implementation Plans (`docs/plans/*.md`)**:
  - Every surviving finding **must** include an executed verification command (`grep -n`, `npx tsc --noEmit`, or a probe script) proving that:
    - A referenced function, type, column, or file does not exist or has an incompatible signature, OR
    - A proposed change violates an existing `tests/layering.test.ts` (Axes 0–9) or `tests/guards.test.ts` (Rules 1–5) gate, OR
    - A proposed algorithm contradicts an authoritative specification in `docs/`.
- **What Must Be Dropped**:
  - Leave out anything you did not run or verify against real code.
  - Drop style preferences, naming opinions, hypothetical future risks ("if someone later adds..."), or claims where an upstream/downstream check already prevents the state.
  - List dropped items only in a brief `Dropped findings: <N> (unproven / speculative)` section at the end with one line per dropped item explaining why it was dropped.

---

## 3. Emit-Specific Attack Vectors (Always Check)

When probing a diff or plan in `emdash-emit`, actively test against these 7 domain invariants:

1. **4-Tier Layering & Static Axes (`tests/layering.test.ts` Axes 0–9)**:
   - Does Layer 0 import Layer 1/2/3? Does Layer 1 import Layer 2/3? Does Layer 3 import a Layer 2 symbol not in `ALLOWED_LAYER_2_SYMBOLS`?
   - Does any non-CLI file call `console.log` / `console.debug` (Axis 5)?
   - Does any file call `.saveSyncState(` outside `db/baseline.ts`, `sync/workspace/commit.ts`, `sync/conflicts.ts` (Axis 6)?
   - Do inspector modules use `parseMarkdownLenient` (Axis 7)? Do CLI commands use `reportActionFailure` (Axis 8)? Do MCP tools use `withResolvedContext` / `formatToolError` (Axis 9)?
2. **Two-Track Revision Invariant (`docs/sync-engine-and-revisions.md`)**:
   - Is Track 1 (`revForTransport` in `base_snapshots.rev` / `entries.rev`) ever overwritten with a Track 2 composite key (`${version}@draft:${draftRevisionId}`)?
   - Does draft / `published*` handling respect the **Draft Selective Single GET** invariant (`body_source`: `list-live` vs `single-get` vs `list-stale`)?
3. **Two-Layer Representation Invariant (`docs/taxonomies-and-bylines.md`, `docs/media-pipeline.md`)**:
   - Does `base_snapshots.frontmatter_yaml` (Layer A) keep canonical percent-encoded taxonomy slugs (`"%e6%9c%aa%e5%88%86%e9%a1%9e"`) and `/_emdash/api/media/file/<storageKey>` URLs while disk files (Layer B) render decoded slugs and relative paths?
   - Does an MCP tool ever mutate `.emit/config.json`?
4. **Two Media ID Spaces (`docs/media-id-spaces.md`)**:
   - Are D1 record `id` (`MediaRecordId`, used in `featuredImage` and `GET /_emdash/api/media/{id}`) and R2 `storageKey` (`StorageKey`, used in `/_emdash/api/media/file/{storageKey}` and `media_state` PK) ever interchanged?
   - Is `snapshot_media` treated as site-wide (collection-independent) while `snapshot_articles` / `snapshot_meta` are collection-scoped?
5. **Epistemic Search & Offline Doctor (`docs/safety-guards-and-diagnostics.md`)**:
   - Whenever `walkComplete === false`, does the output preserve `[WALK_INCOMPLETE]` without asserting absence?
   - Does `emit doctor` remain 100% offline unless `--check-auth`, `--check-media-urls`, or `--check-media-library` is explicitly passed?

---

## 4. Required Output Format

- **Intent**: 2–3 sentence restatement of what the change/plan must achieve.
- **Verified Findings (Blocker / Minor)**:
  - For each finding: **Title**, **Severity**, **Command Executed**, **Actual Output**, **Why It Breaks Intent/Invariants**, and **Exact Fix (`file:line`)**.
  - Write *"No verified findings."* when no attack succeeds.
- **Dropped Findings**: Count of dropped hypotheses and a 1-line reason each was dropped.
