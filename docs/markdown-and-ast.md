# Markdown, YAML Frontmatter & Portable Text AST Specifications

This document specifies Emit's Markdown and YAML frontmatter format, two-stage lenient parsing and self-healing, YAML scalar quoting rules, baseline snapshot reconstruction, Portable Text AST round-trip conversion, and the Dual-Track Image Model (Tier 1 vs Tier 3 opaque block protection).

---

## 1. Canonical YAML Frontmatter Schema (`src/utils/frontmatter.ts`)

Every article in `<collection>/draft/` and `<collection>/published/` begins with a YAML frontmatter block validated by `FrontmatterSchema` (Zod):

```yaml
---
id: 01M6ABCDEF1234567890123456 # 26-char canonical Crockford base32 ULID (auto-generated; DO NOT EDIT)
slug: building-ai-powered-cms-tools
title: 'Building AI-Powered CMS Tools'
collection: posts # Target collection (defaults to "posts")
status: draft # "draft" | "published" (or "published # draft revision" on disk when uncommitted remote draft exists)
publishedAt: null # ISO 8601 timestamp string (e.g. "2026-11-04T12:00:00.000Z") or null
locale: ja # Locale code (defaults to "ja")
featuredImage: '01M67P0MBMJQQXH2K95HHCYRYB' # 26-char media record ULID (uppercase-normalized), local draft path ("../../media/drafts/cover.jpg"), or null — NEVER a bare R2 storageKey
taxonomies: # Nested map of taxonomy key -> array of term slugs (or canonical term ULIDs)
  categories:
    - 未分類 # Human-readable decoded CJK or ASCII slug
  tags:
    - typescript
    - カメラレビュー
seo: # Optional SEO metadata block
  title: null # Custom SEO title string or null
  description: null # Meta description string or null
  canonical: null # Must be an absolute URL ("https://...") or null (validated via z.string().url().nullable().optional())
  noIndex: false # Boolean (optional)
  image: null # SEO image string or null
bylines: # Author byline slugs (resolved via cached bylines table)
  - aroooy
---
```

### Schema & Serialization Rules

1. **Always nest categories and tags under `taxonomies:`**: `parseMarkdown()` validates frontmatter with Zod, which strips unknown top-level keys, and `serializeMarkdown()` regenerates the YAML header on every pull and push. Top-level `categories:` or `tags:` are silently discarded without triggering Preflight Guard G4. `taxonomies` accepts `categories`, `tags`, and any custom taxonomy keys defined in EmDash (`z.record(z.array(z.string()))`).
2. **`seo.canonical` requires an absolute URL**: Relative paths (e.g. `"/posts/my-slug"`) fail schema validation; specify a full `https://...` URL or `null`.
3. **`id` and `featuredImage` normalization**: `id` must be an exact 26-character ULID. `featuredImage` values matching a 26-character ULID are normalized to uppercase automatically on read, pull, merge, and push.
4. **Draft Revision Annotation (`status: published # draft revision`)**: Managed exclusively by `src/utils/disk-spelling.ts` based on `hasUncommittedDraftRevision()` (`sync_state.remote_rev.includes('@draft:')`). Never add, edit, or strip this comment manually.
5. **No Duplicate `# Title` in Body**: The article title lives in frontmatter `title:`. Do not repeat `# Article Title` as the first line of the Markdown body (Preflight Guard **G7** detects and automatically trims redundant top-level title headings).

---

## 2. YAML Scalar Quoting (`formatYamlScalar`) & Lenient Self-Healing

### 2.1 `formatYamlScalar(value)` Rules

`formatFrontmatterYaml` formats `id`, `slug`, `collection`, `locale`, `taxonomies` terms, and `bylines` through `formatYamlScalar()`:

- **Unquoted Unicode / ASCII Identifiers**: Decoded CJK strings (`未分類`, `カメラレビュー`) and standard ASCII slugs (`tech`, `typescript`) match `/^[\p{L}\p{N}_-]+$/u` (without being pure digits or YAML reserved words) and are emitted **unquoted** (`    - 未分類`).
- **Mandatory `JSON.stringify` Quoting**:
  - Strings starting with or containing `%` (such as percent-encoded slugs `"%e6%9c%aa%e5%88%86%e9%a1%9e"`). In YAML 1.2, a leading `%` is a directive indicator and causes a fatal parse error if left unquoted.
  - Strings containing YAML punctuation (`:`, `#`, `[`, `]`, `{`, `}`, `,`, `&`, `*`, `?`, `|`, `-`, `<`, `>`, `=`, `!`, `@`, `` ` ``, quotes, or whitespace).
  - Pure numbers, all-digit strings/ULIDs, ISO dates, and YAML boolean/null literals (`true`, `false`, `null`, `yes`, `no`, `on`, `off`, `~`).

### 2.2 Two-Stage Lenient Parsing (`parseMarkdownLenient`)

To guarantee diagnostic alignment across all read-only inspectors (`status`, `doctor`, `conflicts`, `delete`, `article_search/local`, and `media/body_scan`), Layer 0 provides a single entry point in `src/utils/frontmatter.ts`:

```ts
export function parseMarkdownLenient(content: string, filePath?: string): ParsedMarkdown | null;
```

1. **Stage 1**: Attempts strict `parseMarkdown(content)` (`gray-matter` + Zod `FrontmatterSchema`).
2. **Stage 2 (Fallback)**: On failure, runs `lenientRepairMarkdownFrontmatter(content)` (which re-quotes bare `%`-encoded scalars and repairs broken list indentation under taxonomy keys) and re-runs strict `parseMarkdown()`. Returns `null` only if the file is genuinely unrecoverable.

- **Fast-Path Self-Healing on Pull (`tryFastPathOrHeal` in `src/sync/pull/fast_path.ts`)**:
  - When a cached file fails strict parsing (classified as `invalid` with `healable: true` in `emit status` and `warning` in `emit doctor`), batch `emit pull` / `sync_pull` repairs the frontmatter on disk on the 0-GET fast path and updates `local_hash` atomically.
  - Uncached `invalid` files outside the 30-post sliding window (`[uncached]` in `emit status`) can be healed on demand via `emit pull <ULID>` or `sync_pull(id: "<ULID>")`.

---

## 3. Baseline Serialization & Diagnostic Alignment Invariant

Emit separates the **internal baseline representation (Layer A)** from the **on-disk human/editor representation (Layer B)**:

```text
┌───────────────────────────────────────────────────────────────────────────────────┐
│               LAYER A: Remote EmDash API & SQLite base_snapshots                  │
│ • Taxonomies: Canonical %-encoded slugs (e.g. ["%e6%9c%aa%e5%88%86%e9%a1%9e"])    │
│ • Body AST:   Portable Text JSON blocks (or canonical Markdown in base_snapshots) │
│ • Media URLs: Canonical root-relative URLs (/_emdash/api/media/file/<storageKey>) │
│ • Revisions:  Raw transport token in base_snapshots.rev (Track 1)                 │
│               + composite "${version}@draft:${draftRevId}" in sync_state (Track 2)│
└───────────────────┬───────────────────────────────────────────▲───────────────────┘
                    │ Pull (Decode + Localize)                  │ Push (Canonicalize
                    │ & reconstructBaseline()                   │       + AST Convert)
                    ▼                                           │
┌───────────────────────────────────────────────────────────────────────────────────┐
│               LAYER B: Local Disk Markdown (posts/draft|published/*.md)           │
│ • Taxonomies: Decoded human-readable Unicode (  - 未分類) via formatYamlScalar()  │
│ • Draft Flag: "status: published # draft revision" when @draft: revision exists   │
│ • Body AST (3-Tier Mapping):                                                      │
│   ├─ Tier 1/2: Headings, Lists, Marks, GFM Tables (| col |), Breaks (---)         │
│   ├─ Track A (Plain Image):  ![alt](../../media/<storageKey>) [Offline Preview]   │
│   └─ Track B (Tier 3 Block): <!--ec:block {"_type":"image","alignment":...} -->   │
│                              [Opaque JSON comment fence protected by Guard G9]    │
│ • Tracking:   Only sync_state.local_hash hashes Layer B disk bytes                │
└───────────────────────────────────────────────────────────────────────────────────┘
```

| Aspect | Layer A (Internal Baseline & Remote Payloads) | Layer B (On-Disk Markdown File) |
| --- | --- | --- |
| **Storage Location** | `base_snapshots.frontmatter_yaml` (**JSON-encoded** `Frontmatter`) & `base_snapshots.body_markdown` | `posts/draft/*.md`, `posts/published/*.md` |
| **Taxonomy Slugs** | Canonical percent-encoded slugs (`"%e6%9c%aa%e5%88%86%e9%a1%9e"`) | Decoded human-readable Unicode (`未分類`) |
| **Mirrored Body Media URLs** | Canonical root-relative URLs (`/_emdash/api/media/file/<storageKey>`) | Article-relative paths (`../../media/<storageKey>`) when `localMediaRefs: true` (default) |
| **Published Draft Status** | `status: "published"` (with `@draft:<ULID>` in `sync_state.remote_rev`) | `status: published # draft revision` |

### Baseline Reconstruction (`src/sync/baseline-reconstruction.ts`)

When `emit status`, `emit diff`, `emit doctor`, or `emit delete` compares a working file on disk against `base_snapshots`, it calls `reconstructBaseline()` and `isLocalFileUnmodified()`:

- `reconstructBaseline()` renders the stored baseline snapshot using the exact spelling flavor currently present on disk (e.g., matching decoded vs percent-encoded taxonomy terms via `carriesPercentEncodedTaxonomy(diskContent)`, matching `localMediaRefs` vs canonical URLs, and matching `# draft revision` via `hasUncommittedDraftRevision`).
- If a file differs from `sync_state.local_hash` solely due to a self-healed spelling normalization, `isLocalFileUnmodified()` recognizes it as unmodified and calls `retrackLocalHashOnly()` (`src/db/baseline.ts`) to advance `sync_state.local_hash` without touching `base_snapshots`.
- **Rule**: Never call `saveSyncState()` directly to update `local_hash` alone; always use `retrackLocalHashOnly()`.

---

## 4. Portable Text AST Conversion & Supported Markdown Syntax (`src/client/portable-text.ts`)

EmDash stores article bodies as Portable Text (an array of typed JSON blocks). Emit converts losslessly between Portable Text and Markdown (`portableTextToMarkdown` ⇔ `markdownToPortableText`):

### 4.1 Supported Markdown Constructs (Tier 1 & Tier 2)

- **Headings**: ATX headings `#` through `######` (`style: 'h1'..'h6'`). *Note: Setext underlined headings (`===` / `---`) are not supported and trigger Preflight Guard **G8**.*
- **Paragraphs & Inline Marks**: Bold (`**text**`), italic (`*text*`), inline code (`` `code` ``), strikethrough (`~~text~~`), and links (`[label](url)`).
- **Lists**: Unordered (`-`, `*`) and ordered (`1.`) lists, including nested indentation.
- **Blockquotes**: Standard `> quote` blocks.
- **Fenced Code Blocks**: Backtick code fences (` ```lang ... ``` `) of 3 or more backticks.
  - *Tilde Fence Warning*: Tilde fences (`~~~`) are **not** recognized as code blocks by the Portable Text mapper; they trigger Preflight Guard **G8** and are scanned as normal prose by image guards G5/G11.
  - *Unterminated Code Fence Warning*: Unclosed backtick fences are flagged by `detectCodeFenceIssues()` (Guard **G8**) during preflight to prevent the remainder of the article from being swallowed into a single code block.
- **GFM Tables**: Standard GitHub Flavored Markdown pipe tables (`| col1 | col2 |` with separator row `| --- | --- |`) round-trip to EmDash Portable Text `table` blocks (`_type: 'table'`, `rows: [{ _type: 'tableRow', cells: [...] }]`).
- **Thematic Breaks (Horizontal Rules)**: Standalone `---`, `***`, or `___` lines round-trip to Portable Text thematic break blocks (`_type: 'thematicBreak'` / `hr`).
  - *Accepted Setext Heuristic Limitation*: In `detectUnsupportedMarkdownSyntax()`, a line beginning with `*`, `+`, or a digit immediately followed by `---` on the next line still emits a Setext heading warning so legitimate Setext headings like `*emphasized*\n---` or `2026 was great\n---` are not silently missed. Always place a blank line before a horizontal rule `---`.

---

## 5. The Dual-Track Image Model & Tier 3 Opaque Fence Protection

EmDash supports both standard images and layout-styled images (`alignment: 'left' | 'center' | 'right'`, `displayWidth`, `displayHeight`, `caption`, `title`, or custom `asset` metadata) as well as custom visual blocks (`core:gallery`, callouts, embeds).

To balance **Local-First offline editing** with **100% CMS round-trip fidelity**, Emit separates images and blocks into two tracks:

| Track | Target Block | Markdown Representation | Local Editor Preview | Core Purpose & Behavior |
| --- | --- | --- | :---: | --- |
| **Track A: Plain Image (Tier 1)** | Image blocks with only standard `_type: 'image'`, `_key`, `alt`, and `asset: { url }` | `![alt](../../media/<storageKey>.<ext>)` | 🖼️ **Visible** | Mirrored into `media/` and rewritten to article-relative paths (`localMediaRefs: true`) for offline preview in VS Code / Obsidian. |
| **Track B: Preserved Block (Tier 3)** | Styled images (`alignment`, `displayWidth`, `caption`, etc.) & custom non-standard blocks | `<!--ec:block {"_type":"image",...,"url":"/_emdash/api/media/file/<storageKey>",...} -->` | ❌ **Hidden** (HTML comment) | Standard Markdown lacks layout/width syntax. Wrapping the raw Portable Text JSON in a single-line opaque comment fence prevents destructive reset of CMS styling on `push`. |

### Guard G9 (`MODIFIED_OPAQUE_BLOCK`) & Authoring Rules

- **Tamper Protection**: During `emit push` / `sync_push`, Preflight Guard **G9 (`MODIFIED_OPAQUE_BLOCK`)** compares every `<!--ec:block ... -->` fence against `base_snapshots`. Corrupted JSON or unauthorized payload tampering blocks the push.
- **Allowed Operations on Preserved Blocks**:
  - **Adding a new image**: Always write standard Markdown `![alt](../../media/drafts/new-image.png)`. Never hand-craft `<!--ec:block ... -->` lines.
  - **Reordering a preserved block**: Cut and paste the entire single-line `<!--ec:block ... -->` comment to a new line.
  - **Removing a preserved block**: Delete the entire `<!--ec:block ... -->` line (or pass `--force` if G9 flags an intentional attribute edit).
- **Referenced Media Mirroring Inside Opaque Fences**: Even though Track B images keep canonical `/_emdash/api/media/file/<storageKey>` URLs inside their JSON payload, `collectArticleStorageKeys()` (`src/sync/media/body_scan.ts`) scans inside `<!--ec:block ... -->` fences as well, so their binary assets are still mirrored into `media/` and protected from media pruning.
