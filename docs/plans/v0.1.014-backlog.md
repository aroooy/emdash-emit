# v0.1.14 Backlog & Continuous Improvement Items

This document tracks refinement and continuous improvement items carried over from the v0.1.13 review cycle for consideration in `emdash-emit v0.1.14`.

---

## 1. Fast-Path vs Full-Pull Title Resolution Symmetry & Dedicated Tests (EMIT-005 Followup)

- **Background**:
  - In v0.1.13, `resolveCanonicalArticlePath` (`src/sync/pull.ts`) unified the date prefix resolution order (`publishedAt` -> `existingPrefix` -> `createdAt` -> `updatedAt`) across both fast-path and full-pull.
  - However, in fast-path (`tryFastPathOrHeal`), title resolution utilizes remote data (`rawData.title || rawData.slug`), whereas full-pull (`pullArticle`) uses local frontmatter data (`frontmatter.title || frontmatter.slug`).
- **Goal for v0.1.14**:
  - Add dedicated unit tests for `resolveCanonicalArticlePath` asserting consistent behavior across all edge cases (missing dates, different title formats, APFS filesystem collision scenarios).
  - Harmonize the title precedence between fast-path and full-pull to guarantee deterministic canonical filenames in 100% of scenarios, even if local frontmatter title diverges from remote entry title before sync.

---

## 2. Taxonomy-Only Conflict Quarantine Copy Hash Alignment

- **Background**:
  - When an out-of-band taxonomy modification occurs, a synthesized 409 error routes into `hybrid3WayMerge`.
  - While local unpushed edits and divergent taxonomy assignments are safely quarantined and preserved under `<collection>/conflicts/`, the recorded `sync_state.conflict_copy_hash` may in some edge cases reflect the pre-merge content hash rather than the newly quarantined conflict file hash.
  - This has zero risk of data loss (the quarantined copy is intact and never overwritten unless content matches), but could cause an extra rescue copy iteration if repetitive conflict pulls occur.
- **Goal for v0.1.14**:
  - Refine the quarantine copy hash assignment during taxonomy-only synthetic 409 conflict flows to ensure exact byte-for-byte alignment between disk copy and database record.
