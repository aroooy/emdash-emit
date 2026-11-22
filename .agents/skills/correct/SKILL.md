---
name: correct
description: >-
  Encode bug fixes, review findings, and repeated agent mistakes into emdash-emit's
  structure so they cannot recur. Ranks fixes from Architecture (Level 1) -> Types
  (Level 2) -> Structural Gates in tests/layering.test.ts or tests/guards.test.ts
  (Level 3) -> Behavior Tests (Level 4) -> Docs & AGENTS.md Rule-to-Enforcer Table
  (Level 5), with a mandatory Fail-First proof.
---

# Correct (Structural Mistake Encoder for Emit)

When the user corrects an agent mistake, or when an `/interrogate` review uncovers a real defect or drift between documentation and code, **change the repository so the next agent cannot make the same mistake**.

Assume every contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Design `emdash-emit` so a change that looks right from one file is right for the whole repository.

---

## 1. Fix Each Mistake Class at the Highest Level That Works

Always evaluate from **Level 1 down to Level 5**. Never settle for Level 5 (Docs) when Level 1, 2, or 3 is possible.

### Level 1: Eliminate It with Architecture
- Give each piece of state one owner and each task one supported entry point:
  - Full sync commit → `commitArticleSnapshot()` (`src/sync/workspace/commit.ts`)
  - Hash-only retrack → `retrackLocalHashOnly()` (`src/db/baseline.ts`)
  - Lenient frontmatter parse → `parseMarkdownLenient()` (`src/utils/frontmatter.ts`)
  - Origin resolution → `resolveOriginPriority()` (`src/cli/context.js`)
- Hide internals so the wrong import fails, and delete dead code or legacy helpers an agent might copy.

### Level 2: Enforce It with Types (`type-system-discipline`)
- Make illegal states unrepresentable at compile time:
  - Use Branded Types (`MediaRecordId` vs `StorageKey` in `src/utils/media-id.ts`) so distinct identifier spaces cannot be passed to each other.
  - Use discriminated unions (e.g., `SnapshotBodySource = 'list-live' | 'single-get' | 'list-stale'`) and explicit non-nullable return contracts.

### Level 3: Add a Structural Gate (`tests/layering.test.ts` or `tests/guards.test.ts`)
- If bad code still compiles, add or tighten a static check in:
  - `tests/layering.test.ts` (Axes 0–9, Sibling Snapshot, Public Barrel Check), OR
  - `tests/guards.test.ts` (Guard Registry Rules 1–5).
- **Mandatory Error Message Rule**: The assertion failure message **must name the exact replacement function and file path** (e.g., *"Use `commitArticleSnapshot()` (`src/sync/workspace/commit.ts`) for full sync commits or `retrackLocalHashOnly()` (`src/db/baseline.ts`) to advance `local_hash` alone"*).

### Level 4: Test Observable Behavior (`tests/*.test.ts`)
- Write a hermetic Vitest test that asserts what users or MCP callers observe (CLI output, exit code, MCP payload/`isError`, SQLite row state, on-disk Markdown bytes), not internal mock implementation details.

### Level 5: Update Docs & the `AGENTS.md` Rule ⇔ Enforcer Table Last
- Update `docs/*.md` and `AGENTS.md` §3 (**Rule ⇔ Enforcer Table**) so every documented rule names the exact type, Axis, or test file that enforces it.

---

## 2. Fail-First Proof Protocol

1. **Before fixing the production code** (when fixing an existing violation):
   - Add the Level 3 Axis gate or Level 4 behavior test first.
   - Run `npx vitest run <test-file>` and **confirm it fails on the current broken state**.
   - (If adding a proactive regression gate for a rule that is currently obeyed across `src/`, explicitly classify it as a **Regression-Prevention Gate** and verify that a synthetic violation triggers the expected error message.)
2. **Apply the fix** and re-run `npm run check` (`format:check`, `typecheck`, `check:cycles`, `test`) to prove 100% Green.
3. **Clean up** any temporary probe files before committing.

---

## 3. Required Output Format

- **Mistake Class**: What went wrong (or could go wrong) and the `file:line` evidence.
- **Enforcement Level Chosen**: Level 1 / 2 / 3 / 4 / 5, and why a higher level did or did not apply.
- **Fail-First & Green Proof**: The test command output before and after the fix.
- **Rule ⇔ Enforcer Table Update**: The row added or updated in `AGENTS.md` §3.
