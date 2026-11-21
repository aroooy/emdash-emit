# v0.1.16 Plan — Media Search Index（`emit media-search` / MCP `sync_media_search`）

**策定日**: 2026-11-12
**対象リポジトリ**: `emdash-emit`（HEAD: `b0b9dd8` / `package.json` version `0.1.15`）
**目標バージョン**: **`0.1.16`**
**検証済み状態（策定時点）**: `npm run check` green、Guard Registry は G1〜G19、cache schema version **5**

本ディレクトリの文書構成:

| ファイル | 内容 |
| --- | --- |
| `README.md`（本書） | 動機・設計思想・スコープ境界・命名・分担表の更新方針 |
| `fix-spec-v0116.md` | 実装仕様（型定義、API シグネチャ、error code、CLI/MCP 契約、受け入れ条件 A1〜A7） |
| `test-matrix-v0116.md` | 単体/統合テストの検証マトリクス（T1-1〜T7-4 と受け入れ条件対応） |


---

## 1. 動機（v0.1.15 で残った唯一のエージェント向け欠口）

v0.1.15 の Local-first Media Pipeline により、参照資産の mirror・索引・命名は確定した。
しかし **AI エージェントが「どの画像を使えるか」を調べる手段が存在しない**。

| 事実 | 現状の実装 |
| --- | --- |
| リモートライブラリを walk する処理は既にある | `collectRemoteStorageKeys()`（`src/sync/media/remote_index.ts:6`）が cursor ページングで走査し `recordsByStorageKey` / `recordsById` に `EmDashMediaItem` を保持。docstring は *"nothing reads it unless a mirror stage asks for it"* と明記しており、**検索 consumer が欠けている**。`pullMedia()`（`src/sync/media/pull_library.ts:30`）は coverage 報告用に自前で walk を所有している（L60-65 のコメント） |

| walk 結果に検索可能な語彙が揃っている | `EmDashMediaItem`（`src/sync/media/types.ts:15-29`）= `id, filename, mimeType, size, width, height, alt, caption, url, storageKey, contentHash, status, createdAt` |
| ローカル mirror 状態の索引も既にある | `cache.listMediaStates()`（`src/db/cache.ts:975`）と companion YAML（`buildMediaMetaDoc()` が `id/filename/alt/caption/storageKey/url/...` を書く） |
| ただし `media_state` には検索語彙が無い | 列は `storage_key, media_id, local_content_hash, remote_record_ref, url, workspace_path, markdown_ref, status, uploaded_at` のみ。**`filename` / `alt` / `caption` 列は存在しない** |
| 文件名は人間もエージェントも読めない | mirror 名は `storageKeyToMarkdownRef()` 由来。移行コーパスの storageKey が素の ULID だと stem も ULID になり、名前からの特定は不可能 |

→ **データは揃っているが query interface が無い**。v0.1.16 の作業は「索引の構築」ではなく
**「既存 walk へのクエリ層」＋「検索結果から個別 mirror へ進む経路」** である。

---

## 2. 設計思想（Local-first を壊さないための 3 原則）

### 原則 1: 「一覧はリモート、mirror は個別」

エージェントが描くべきフロー:

```text
[1] emit media-search "<keyword>"        → リモートライブラリを検索（未 mirror も含む一覧）
    │                                    各行に mirrored: true/false と localPath を付与
[2] 対象の storageKey を選ぶ
    │
[3a] 記事本文に使うなら: body に /_emdash/api/media/file/<storageKey> を書き push/pull
    │     → pullArticleMedia() が自動的に mirror を落とす（新規 API 不要）
[3b] 先にローカルへ置きたいなら: emit pull-media --storage-key <key>（v0.1.16 で追加）
```

これは README の "Division of Labor"（L134-142）と矛盾しない。分担表が公式 EmDash MCP に委ねているのは
**mass upload / mass delete / full-library listing（艦隊規模の運用）** であり、
「執筆ループ内でこの記事に使う 1 枚を探す」は authoring loop そのものなので Emit の担当である。

### 原則 2: サーバーの `q` に依存しない（AGENTS.md §7）

> `GET /_emdash/api/media` is the only endpoint that reports each record's own `storageKey` and
> exposes no key filter (`q` matches filenames only)

したがって **サーバー側 filter は使わず、Emit が walk してローカルで filter する**。
利点は検索語彙が広がること（`alt` / `caption` / `storageKey` / mirror stem で引ける）で、
欠点は large library の走査コストである → §4 の scan budget と `walkComplete` で扱う。

### 原則 3: 「無い」主張には完全 walk が必要（epistemic rule）

AGENTS.md §7 の *"Only a key that survives a complete walk may be verified on the server"* より、
部分走査で不在を断言してはならない。結果には必ず次を載せる:

- `scannedCount`（実際に読んだレコード数）
- `walkComplete: boolean`（`maxScan` に当たらず走り切ったか）
- 切り詰め時は警告 `[WALK_INCOMPLETE]` を出し、**INSERT・サーバー修復を提案しない**

---

## 3. スコープ

### In Scope（v0.1.16 で実装）

| ID | 項目 | 層 |
| --- | --- | --- |
| **M1** | `searchRemoteMedia()` — walk 中にマッチ行だけを蓄積する検索関数 | `src/sync/media/remote_index.ts` |
| **M2** | `collectLocalMirrorIndex()` — `media_state` + companion YAML から `storageKey → { localPath, filename, alt, caption }` を構築 | `src/sync/media/companions.ts` |
| **M3** | CLI `emit media-search <query>` | `src/cli/commands/media.ts`（新規）＋ `src/bin/emit.ts` 登録 |
| **M4** | MCP tool `sync_media_search` | `src/mcp/tools/sync-media-search.ts`（新規）＋ `src/mcp/server.ts` 登録 |

| **M5** | 個別 mirror 経路 `emit pull-media --storage-key <key>` / MCP `sync_pull_media({ storageKey })` | `src/sync/media/pull_library.ts` |
| **M6** | taxonomy 語彙 hint（`suggestKeywords: true` 時に上位 tag slug を添える） | `src/sync/taxonomies.ts` の既存関数を流用 |
| **M7** | Guard G5/G11 の suggestion 文に検索経路を追加 | `src/sync/preflight.ts` |
| **M8** | 分担表・AGENTS.md §7 の文章更新（「filename/alt 解決は mirror 済み資産に限る」） | `README.md` / `AGENTS.md` |

### Out of Scope（明示的にやらない）

| 却下項目 | 理由 |
| --- | --- |
| **サーバー側 `q` による filter** | filename にしか効かず、他の語彙で探せないことがエージェントに伝わらず誤った不在判定を招く（原則 2） |
| **未 mirror 資産の filename fuzzy 解決（Levenshtein 等）** | AGENTS.md §7 の *"never infers a record id from a body URL segment"* と、`mediaRecordIdForStem()` が companion `id:` 以外を拒否する invariant に反する。ghost reference を生む |
| **本文 alt の逆引き（「この記事の画像 alt は?」）** | `scanRawMediaReferences()`（`src/utils/media-refs.ts:103`）は markdown regex `!\[.*?\]\(([^)\s]+)...` で **alt をグループ化せず破棄している**。alt 保持版を作ると G5/G11 guard 用スキャナと共有変更になり、backtick-only fence 互換の検証が増える。別イテレーション |
| **リモート資産への INSERT / 修復** | Emit mirrors records, never repairs server data（AGENTS.md §7） |
| **taxonomy fuzzy 検索の新設** | `findClosestTaxonomySuggestions()` は taxonomy 専用として既に存在。メディア側はリテラル部分一致のみ |

---

## 4. token / network budget（エージェント運用の現実制約）

| 項目 | 値 | 根拠 |
| --- | --- | --- |
| 1 ページサイズ | `MEDIA_LIST_PAGE_SIZE = 100`（既存定数を変更しない） | `src/sync/media/types.ts:13` |
| 検索結果 `limit` | 既定 **20**、上限 **50** | `sync_status` の `MAX_ACTION_REQUIRED = 30` / `MAX_INVALID_MCP_ITEMS = 10` と同一思想。超過は truncation note |
| 走査上限 `maxScan` | 既定 **500** レコード、`--max-scan 0` で無制限（完全 walk） | large library で MCP context を壊さないため。既定値では `walkComplete: false` になり得ることを結果に明記 |
| 1 行の出力フィールド | `id, storageKey, filename, mimeType, size, alt(200 字で切詰め), mirrored, localPath, createdAt` | `localPath` は `media/<markdownRef>.<ext>` のみ（record id を文件名に含めない — §7 invariant） |
| 正規表現 | **不可**。リテラル部分一致（case-insensitive）のみ | ReDoS と予期しないヒットの防止。テストで固定 |

---

## 5. 命名

- CLI: **`emit media-search <query>`**（`--limit`, `--max-scan`, `--mirrored-only`, `-p/--profile`）
- MCP: **`sync_media_search`**（`sync_pull_media` と対になる名前）
- 内部: `searchRemoteMedia()` / `collectLocalMirrorIndex()` / `formatMediaSearchSummary()`

「list」ではなく「search」を選ぶ。リモート walk を伴う操作なので、ローカル一覧と誤解される命名は避ける。

---

## 6. ドキュメント分担表の更新方針（M8）

README の "Division of Labor" 表に 1 行追加し、**Emit 側が扱う範囲が remote library の検索索引であることを明示**する:

| Operation | Right Tool |
| --- | --- |
| Finding a media asset to use in the article being drafted (keyword search over the remote library, with mirror status) | **Emit** (`emit media-search` / MCP `sync_media_search`) |
| Bulk media library management (mass upload, mass delete, full-library listing/export) | **Official EmDash MCP** / Admin Dashboard（変更なし） |

AGENTS.md §7 に epistemic rule を 1 項目追加:

> A media search that did not finish its walk reports `walkComplete: false` and must never assert
> that an asset is absent. Filename/alt resolution applies only to assets Emit already mirrored
> (`media_state` + companion YAML); a remote-only asset is searchable but carries no local mirror
> metadata, and fleet-scale listing remains the official EmDash MCP's responsibility.

---

## 7. リリース手順（v0.1.16）

1. `fix-spec-v0116.md` の M1→M2→M5（sync 層）を実装し、単体テストを先に green にする
2. M3 / M4（CLI・MCP presentation 層）を実装。MCP は必ず `formatToolError()` を通す（AGENTS.md の tool error contract、`resolveContext()` も guarded try 内）
3. M6 / M7（hint と guard 文面）を反映
4. `package.json` version を `0.1.16` に、`CHANGELOG.md` の `[Unreleased]` を `[0.1.16]` へ確定
5. `npm run check`（`format:check` → `typecheck` → `test`）で **exit 0 / all green** を確認
6. M8 のドキュメント正本化（README / AGENTS.md / `docs/media-id-spaces.md` への相互リンク）

---

## 8. リスクと既存 invariant への接触面

| 接触面 | 既存 invariant | 本計画の扱い |
| --- | --- | --- |
| `media_state` スキーマ | schema v5、`storage_key` が PK | **列追加しない**。検索語彙は companion YAML から読む（v0.1.15 で削除された `collectLocalMediaIds()` を復活させない — AGENTS.md §7 の明示的禁止） |
| pruning 権限 | remote record からのみ seed。ローカル scan では seed しない | `collectLocalMirrorIndex()` は **decoration 専用**で、pruning には一切使わない |
| mirror 命名 | `media/<markdownRef>.<ext>`、stem は storageKey 由来、record id は衝突サフィックスのみ | 検索結果の `localPath` は `media_state.markdown_ref` / `workspace_path` をそのまま返し、文件名から id を復元しない |
| baseline / hash | `base_snapshots`・canonical hash は常に canonical URL | 検索機能は本文を書き換えない。push payload にも無関係 |
| CLI/MCP 対称性 | `resolveOriginPriority()` を両者が共有 | search も同一 sync 層を呼び、profile 解決も同じ `resolveContext()` を経由させる |
| doctor の coverage 表示 | `runWorkspaceDoctor` の `checkMediaLibrary` が walk 結果で coverage を報告 | search は doctor を呼ばない。walk 実装を共有し、ページサイズ・cursor 処理を二重実装しない |

---

## 9. 受け入れ条件（概要 — 詳細は `fix-spec-v0116.md`）

- **A1**: 未 mirror のリモート資産が `mirrored: false` / `localPath: null` で一覧に出る
- **A2**: `alt` だけでヒットする（filename が ULID のみの移行資産でも検索できる）
- **A3**: サーバーへ送る URL に `q=` が現れない（fetch 層で検証）
- **A4**: 走査切り詰め時に `walkComplete: false` と `[WALK_INCOMPLETE]` 警告が出、不在を断言しない
- **A5**: ミラー済み行の `localPath` が record id を含まない
- **A6**: MCP 失敗はすべて `formatToolError()` 経由で `[CODE]` / suggestion を保つ
- **A7**: `emit media-search` と `sync_media_search` の結果件数・語彙が一致する（CLI/MCP 対称性）

すべての条件は `test-matrix-v0116.md` §8 の対応表でテスト ID に紐づく。完了条件は `npm run check` が exit 0（全 test green）。

