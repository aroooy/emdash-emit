# fix-spec v0.1.16 — Media Search Index（M1〜M8 実装仕様）

**対象**: `emdash-emit` v0.1.15 → **v0.1.16**
**前提**: README.md（本ディレクトリ）の設計思想 3 原則と §3 スコープに従う。本文は実装レベルの型・シグネチャ・error code・受け入れ条件を定義する。

---

## M1: `searchRemoteMedia()` — walk 内フィルタ検索

### 配置と既存コードの関係

`collectRemoteStorageKeys()`（`src/sync/media/remote_index.ts:6-45`）は既に
`limit` / `cursor` のページングループを持ち、`MEDIA_LIST_PAGE_SIZE = 100` で
`recordsByStorageKey` / `recordsById` を構築している。**新しい walk ループを書いてはならない**。
共通のページ取得関数を抽出し、`collectRemoteStorageKeys()` と `searchRemoteMedia()` の両方が呼ぶ。

### 新規型（`src/sync/media/types.ts` に追加）

```ts
/** One media-search hit, decorated with the local mirror state Emit actually holds. */
export interface MediaSearchHit {
  /** D1 media record id (uppercase ULID). NEVER usable in a body URL. */
  mediaId: string;
  /** R2 storage key — the only value valid in `/_emdash/api/media/file/<storageKey>`. */
  storageKey: string | null;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  alt: string | null;
  caption: string | null;
  createdAt?: string;
  /** True when Emit already mirrors this asset (media_state or companion YAML confirms it). */
  mirrored: boolean;
  /** Workspace-relative mirror path (`media/<markdownRef>.<ext>`), null when not mirrored. */
  localPath: string | null;
  /** Which field matched the query, so an agent can read why a row was returned. */
  matchedOn: Array<'filename' | 'alt' | 'caption' | 'storageKey' | 'mirrorStem'>;
}

export interface MediaSearchResult {
  hits: MediaSearchHit[];
  /** Records actually read from the list endpoint. */
  scannedCount: number;
  /** True only when the walk finished without hitting `maxScan`. Absence claims require this. */
  walkComplete: boolean;
  /** Server-reported totalCount when present (live EmDash reports none). */
  totalCount: number | null;
  /** True when hits were cut at `limit`. */
  truncated: boolean;
  /** Query as normalized for matching (lowercased), echoed so agents can audit. */
  normalizedQuery: string;
}
```

### 関数シグネチャ（`src/sync/media/remote_index.ts`）

```ts
export const MEDIA_SEARCH_DEFAULT_LIMIT = 20;
export const MEDIA_SEARCH_MAX_LIMIT = 50;
/** Default scan ceiling. `maxScan: 0` means unlimited (a complete walk). */
export const MEDIA_SEARCH_DEFAULT_MAX_SCAN = 500;

export interface SearchRemoteMediaOptions {
  workspaceRoot: string;
  origin: string;
  token: string;
  refreshToken?: string;
  /** Literal, case-insensitive substring match. Regex is never compiled from user input. */
  query: string;
  /** Max hits to return (default 20, clamped to 50). */
  limit?: number;
  /** Max records to read before stopping the walk (default 500; 0 = unlimited). */
  maxScan?: number;
  /** Restrict output to assets Emit already mirrors. The walk still covers the whole library. */
  mirroredOnly?: boolean;
  /** Decoration built by M2. When omitted, every hit reports mirrored: false. */
  mirrorIndex?: LocalMirrorIndex;
  fetchFn?: typeof fetch;
}

export async function searchRemoteMedia(
  options: SearchRemoteMediaOptions,
): Promise<MediaSearchResult>;
```

### 実装規則

1. **`q` を URL に載せない**。送るのは `limit` と `cursor` のみ（AGENTS.md §7）。fetch 層テストで `q=` の不在を固定する。
2. **マッチ判定**（`normalizedQuery = query.trim().toLowerCase()`）:
   - `filename`, `alt`, `caption` は remote record の値（小文字化して `includes`）
   - `storageKey` はキー文字列そのもの（小文字化して `includes`）
   - `mirrorStem` は `storageKeyToMarkdownRef(storageKey)` の結果（小文字化）— 移行資産で filename が無名称化していても mirror 名で引けるようにする
   - **空 query は拒否**: `MEDIA_SEARCH_QUERY_REQUIRED`（走査全量の列挙は分担表により公式 MCP の担当）
3. **早期打ち切り禁止**: `limit` 件揃っても `maxScan` まで walk を続けるのは、`walkComplete` の真偽を正確にするため。ただし `hits.length >= limit` 以降はマッチ行を破棄してメモリだけ節約してよい。`maxScan: 0` は完全 walk。
4. **エラー翻訳**: 既存 `collectRemoteStorageKeys()` と同じ `ApiError({ code: 'MEDIA_LIST_FAILED' })`（`OPERATIONAL_ERROR_CODES` に登録済み — `src/sync/guards.ts:65`）。新規 error code を増やさない。
5. **record id を body URL に混ぜない**: 返す `url` は使わない。canonical URL を組み立てる必要がある箇所は `MEDIA_FILE_ROUTE_PREFIX + storageKey`（`src/utils/media-refs.ts`）を通す。

---

## M2: `collectLocalMirrorIndex()` — mirror decoration 索引

### 型（`src/sync/media/types.ts`）

```ts
export interface LocalMirrorEntry {
  mediaId: string;
  storageKey: string;
  /** Workspace-relative binary path, read from media_state.markdown_ref / workspace_path. */
  localPath: string | null;
  /** Companion YAML metadata only — never guessed from a filename. */
  filename: string | null;
  alt: string | null;
  caption: string | null;
}

/** storageKey -> mirror entry. Built from confirmed metadata sources only. */
export type LocalMirrorIndex = Map<string, LocalMirrorEntry>;
```

### 関数シグネチャ（`src/sync/media/companions.ts`）

```ts
export function collectLocalMirrorIndex(
  workspaceRoot: string,
  cache?: CacheDatabase,
): LocalMirrorIndex;
```

### 構築規則（厳守）

1. **駆動は `cache.listMediaStates()`**（`src/db/cache.ts:975`）。`status` が `ready` / `uploaded` の行のみ mirror 扱い。
2. **companion YAML は storageKey stem で特定**する。stem は `media_state.markdown_ref` の basename、無ければ `storageKeyToMarkdownRef(record.storageKey)`。相補の `filename:` / `alt:` / `caption:` を読む。**相補が無い行は `filename/alt/caption = null`**（文件名からの推測は禁止 — `mediaRecordIdForStem()` が companion `id:` 以外を拒否する理由と同一）。
3. **cache が無い workspace** では `collectLocalMediaMirrorCandidates(mediaDir)`（`src/sync/media/companions.ts:90`）を使い、相補の `storageKeyFromMediaMeta(doc)` から storageKey を復元して索引を作る（`url:` からの復元は既存の正規路）。
4. **`legacy_*` 接頭辞の相補は除外**（実在レコードの裏付けが無い residue — `countMirroredMedia()` と同じ扱い）。
5. **pruning には使わない**。この索引は表示専用。AGENTS.md §7 の「pruning authority is remote records only」に触れない。
6. **`collectLocalMediaIds()` を復活させない**（v0.1.15 で削除された helper、AGENTS.md が再導入を明示禁止）。


---

## M3: CLI `emit media-search`

### 配置

新規ファイル **`src/cli/commands/media.ts`** に `registerMediaSearchCommand(program, resolveContext)` を置き、
`src/bin/emit.ts` の登録列（L48-55、`registerDoctorCommand` の直後）に追加する。
第二引数は既存 command と同じ `CliContextResolver`（`src/cli/context.ts`）。`pull-media` は `src/cli/commands/pull.ts:444` に残す。


```text
emit media-search <query>
  -l, --limit <number>        Max hits (default 20, max 50)
      --max-scan <number>     Records to read before stopping (default 500; 0 = whole library)
      --mirrored-only         Only assets Emit already mirrors
      --suggest-keywords      Append the top local tag slugs as search hints
  -p, --profile <name>        Explicitly use a specific connection profile
```

### 出力契約

```text
Media search: "夕焼け" (scanned 500 of an unknown-size library)
  1. 01M67P08DXFTYDPFRTJCC4XMP8  storageKey 01M67P07X2VPW0MYRRRGMA6T5A.jpg  [mirrored]
     media/01M67P07X2VPW0MYRRRGMA6T5A.jpg   alt: 夕焼けと雲   image/jpeg  148 KB
  2. 01KJ...                    storageKey uploads/2026/09/dusk.png  [not mirrored]
     alt: dusk over the harbour   image/png  92 KB

⚠️ [WALK_INCOMPLETE] read 500 record(s) and stopped at --max-scan; absence is not proven.
   Narrow the query or raise --max-scan (0 walks the whole library).

💡 To use a hit: write /_emdash/api/media/file/<storageKey> into the article body — pull/push mirrors it
   automatically. For an offline copy first: emit pull-media --storage-key <storageKey>.
   Fleet-scale listing stays on the official EmDash MCP / Admin Dashboard.
```

- 0 件時は `No match in the first N record(s).` と書き、`walkComplete: false` なら不在を主張しない（A4）。
- 失敗時（認証なし / network）は `ApiError.toActionableString()` を 1 行の `❌ ...` に整形し `process.exit(1)`（AGENTS.md の CLI failure presentation）。action が throw して commander に raw stack trace を出さない。
- 認証が解決できない場合は `MEDIA_SEARCH_AUTH_REQUIRED` を新規 operational code として `OPERATIONAL_ERROR_CODES`（`src/sync/guards.ts:40-70`）に追加し、`tests/guards.test.ts` の rogue-code 検査を通す（v0.1.15 R1 の 3 集合全分類を壊さない）。

---

## M4: MCP tool `sync_media_search`

### 配置と登録

新規 **`src/mcp/tools/sync-media-search.ts`** に `registerSyncMediaSearchTool(server, resolveContext)` を置き、
`src/mcp/server.ts` の既存登録列（L233-240、`registerSyncDoctorTool` の直後）に追加する。


```ts
server.tool(
  'sync_media_search',
  'Search the remote EmDash media library by keyword (filename, alt text, caption, storageKey, or local mirror stem) and report whether Emit already mirrors each hit. Returns up to 20 items plus walk coverage fields to conserve LLM context. Use "mirroredOnly:true" when only locally available assets matter. Absence is only proven when walkComplete is true — never conclude an asset does not exist from a truncated walk, and never propose inserting a media record.',
  {
    query: z.string().min(1).describe('Literal keyword (case-insensitive substring). Regex is not supported.'),
    limit: z.number().optional().describe('Max hits to return (default 20, capped at 50)'),
    maxScan: z.number().optional().describe('Records to read before stopping the walk (default 500; 0 = whole library)'),
    mirroredOnly: z.boolean().optional().describe('Restrict output to assets already mirrored locally'),
    suggestKeywords: z.boolean().optional().describe('Append top local tag slugs as extra search hints'),
    profile: z.string().optional().describe('Target profile name for multi-site setups'),
  },
  async (args) => { /* guarded */ },
);
```

### tool error contract（AGENTS.md 準拠）

- `resolveContext()` を **guarded try の内側**で呼ぶ（`AmbiguousProfileError` / "Not inside an Emit workspace" を `formatToolError()` で整形）。`tests/mcp_tool_errors.test.ts` の context tools 検査に本 tool も加える。
- 失敗はすべて `formatToolError(error)` に変換し、callback から throw させない。

### payload

`content[0].text` は JSON 1 個: `{ query, scannedCount, walkComplete, totalCount, truncated, hits[], note?, tagHints? }`。
`walkComplete: false` なら `note: "[WALK_INCOMPLETE] ..."` を必ず含める（A4）。

---

## M5: 個別 mirror 経路 `--storage-key`

### sync 層（`src/sync/media/pull_library.ts`）

`PullMediaOptions` に追加（既存呼び出しは不変）:

```ts
/** Mirror exactly these storageKeys, resolved from the library walk. */
storageKeys?: string[];
```

- `pullMedia()` は `collectRemoteStorageKeys({ maxItems })` を metadata-only で走査 → `recordsByStorageKey` から該当 `EmDashMediaItem` を引き、既存の mirror stage **`syncSingleMediaItem()`**（`src/sync/media/mirror_item.ts:17`）で binary + companion を書く。**新規 mirror 実装は不要**（AGENTS.md の "reuse a walked record instead of fetching GET /_emdash/api/media/{id} again" が既に意図している経路）。

- 解決できない key は `orphanStorageKeys` に載せ、**INSERT や修復を提案しない**（AGENTS.md §7 の epistemic rule）。
- 結果の `total / downloaded / skipped` は既存 formatter（`formatMediaCoverageLine`, `reportOrphanStorageKeys`）で表示。

### CLI / MCP

- `emit pull-media --storage-key <storageKey>`（複数回指定可）。`--article` / `--all` と排他。
- MCP `sync_pull_media` に `storageKey: z.string().optional()` を追加（配列ではなく 1 件。agent は 1 枚ずつ選ぶ）。tool description の選択肢列に targeted key を追記。

---

## M6: taxonomy keyword hints（新規ロジックほぼ無し）

`getLocalTaxonomiesSummary(workspaceRoot)`（`src/sync/taxonomies.ts:417`）は tag を **count 降順 → ULID 降順**で返す済み。
`suggestKeywords: true` 時は上位 **10** slug のみを `tagHints` に載せる（`DEFAULT_MAX_TAGS = 60` を検索 hint に流用せず絞る）。

理由: 移行コーパスでは storageKey が素の ULID で stem も ULID になり filename 検索が機能しない一方、
tag slug は人間の語彙に近い。fuzzy は行わない（README §3 Out of Scope）。

---

## M7: Guard G5 / G11 の suggestion 文更新

`src/sync/preflight.ts` の `LOCAL_IMAGE_DETECTED`（standalone L515 付近 / inline L608 付近）と
`MISSING_LOCAL_IMAGE_FILE`（L546 付近）の `suggestion` に検索経路を追記:

```text
If a media asset is already mirrored in this workspace, look it up with
"emit media-search <keyword>" (or MCP "sync_media_search") and replace the local path with
/_emdash/api/media/file/<storageKey> instead of re-uploading. Filename/alt lookup resolves only assets
Emit already mirrored (media_state plus media/*.yaml); a remote-only asset must be uploaded via the
official EmDash MCP or placed in media/drafts/.
```

**文面の必須条件**: 「filename/alt による解決は mirror 済み資産に限る」を error message 側でも言う。
`findAlreadyPromotedMedia()`（`src/sync/preflight.ts:175-275`）が `media_state` と companion YAML の**記録された metadata**に照合する実装であり、文件名推測ではないことと揃える（AGENTS.md §7 "never by filename guessing"）。code 自体は変更しない — Guard **G5** の codes（`LOCAL_IMAGE_DETECTED`, `INLINE_LOCAL_IMAGE_NOT_SUPPORTED`: `src/sync/guards.ts:123`）と Guard **G11** の codes（`MISSING_LOCAL_IMAGE_FILE`, `PROMOTED_MEDIA_NOT_FOUND_REMOTE` 等: `src/sync/guards.ts:178-181`）は不変とし、`tests/guards.test.ts` の整合検査を通す。


---

## M8: ドキュメント正本化

| ファイル | 変更 |
| --- | --- |
| `README.md` | Division of Labor 表に検索行を追加（README §6 の表を転記）。`emit media-search` をコマンド一覧と MCP tool 一覧に記載。`pull-media` 説明に `--storage-key` を追記 |
| `AGENTS.md` | §7 に epistemic rule を 1 項目追加（README §6 の引用文）。§5 Golden Path の [2. NEW/CHECK] に「画像を選ぶ場合の補助手順」として記載。**新規 Guard は追加しない**（G1〜G19 の連番体系を壊さない） |
| `docs/media-id-spaces.md` | identifier matrix に「media-search は両 id を併記するが、本文へ書けるのは storageKey だけ」の注记を追加 |
| `CHANGELOG.md` | `[Unreleased]` → `[0.1.16]`。Added: media search index / targeted storageKey mirror / keyword hints。Changed: G5/G11 suggestion 文面 |

---

## 受け入れ条件（A1〜A7）

| ID | 条件 |
| --- | --- |
| **A1** | 未 mirror のリモート資産が `mirrored: false` / `localPath: null` で一覧に出、提案文が pull-media へ誘導する |
| **A2** | filename が ULID のみの移行資産でも `alt` だけでヒットし、`matchedOn` に `alt` が入る |
| **A3** | サーバーへ送る URL に `q=` が含まれない（fetch stub で検証） |
| **A4** | `maxScan` 到達時に `walkComplete: false` と `[WALK_INCOMPLETE]` が出、文言が不在を断言しない。完全 walk 時は警告なし |
| **A5** | ミラー済み行の `localPath` が record id を含まない（衝突サフィックス以外の ULID を文件名に載せない） |
| **A6** | MCP の全失敗経路（context 解決含む）が `formatToolError()` 経由で `[CODE]` / status / suggestion を保つ |
| **A7** | CLI と MCP が同一 sync 層を呼び、同一 workspace・同一 query で件数と語彙が一致する |

