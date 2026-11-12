# テストマトリクス（v0.1.16 / fix-spec-v0116 対応）— Media Search Index 検証計画

本ドキュメントは v0.1.16 の実装項目 M1〜M8 の受け入れ条件と単体・統合テストの検証マトリクスを定義する。
**fix-spec-v0116.md の受け入れ条件 A1〜A7 に対応**させる（対応関係は §8 を参照）。

判定基準は既存の評価憲章と同一: CLI stdout/stderr・exit code / HTTP リクエスト URL と query params / `.emit/cache.db` の列値 / ファイルツリーの 4 種類。

新規テストファイル: **`tests/media_search.test.ts`**（sync 層）と **`tests/cli_media_search.test.ts`**（CLI 層）。
既存ファイルへの追記: `tests/mcp_tool_errors.test.ts`, `tests/guards.test.ts`, `tests/preflight.test.ts`, `tests/pull_pruning.test.ts`, `tests/media.test.ts`, `tests/mcp.test.ts`。

---

## 1. M1 / M2: `searchRemoteMedia()` と mirror decoration — 単体 `tests/media_search.test.ts`

| ID | 検証項目 | 期待結果 | A |
|---|---|---|---|
| **T1-1** | remote にのみ存在する資産（`media_state` なし・companion なし）を検索 | ヒットする。`mirrored: false`, `localPath: null`, `alt` は remote 値そのまま | A1 |
| **T1-2** | filename が ULID のみの移行資産（storageKey `01ARZ3NDEKTSV4RRFFQ69G5FAV.jpg`）を `alt` で検索 | ヒットし `matchedOn = ['alt']`。filename 検索ではヒットしない | A2 |
| **T1-3** | 同じ query を `storageKey` の一部で検索 | `matchedOn = ['storageKey']` でヒット（key 文字列そのものの一致） | A2 |
| **T1-4** | mirror 済み資産（schema v5 の `media_state` + companion YAML）を検索 | `mirrored: true`, `localPath = media/<markdownRef>.<ext>`, companion の `alt` / `caption` が付く。`matchedOn` に `mirrorStem` が含まれ得る | A1 / A5 |
| **T1-5** | `media_state` 行はあるが companion YAML が無い資産 | `filename/alt/caption = null`（文件名から推測しない）。`localPath` は `markdown_ref` から返す | A5 |
| **T1-6** | 旧式 mirror（`media/<yyyyMMdd>_<mediaId>-<name>.<ext>`）を持つ workspace | 索引は companion の `storageKey:` / `url:` から復元して当たり、表示パスは disk 上の実名をそのまま返す（生成はしない） | A5 |
| **T1-7** | query に正規表現メタ文字（`.*`, `[a-z]`, `(foo)`）を含む | リテラル一致のみ。メタ文字として扱わない | A2 |
| **T1-8** | 空 / 空白のみの query | `MEDIA_SEARCH_QUERY_REQUIRED` で拒否（走査全量の列挙を行わない） | — |
| **T1-9** | `limit: 100` を指定 | 50 に clamp され `truncated: true` と truncation note | — |
| **T1-10** | fetch stub が受け取る URL | `limit` と `cursor` のみ。**`q=` が存在しない**（ページサイズは `MEDIA_LIST_PAGE_SIZE = 100` のまま） | A3 |
| **T1-11** | サーバーが 500 を返す | `ApiError({ code: 'MEDIA_LIST_FAILED' })`。新規 code を増やさない | — |
| **T1-12** | `maxScan: 200` でライブラリ 350 件 | `scannedCount = 200`, `walkComplete: false`。ヒットがあっても打ち切りを報告 | A4 |
| **T1-13** | `maxScan: 0`（完全 walk） | `walkComplete: true`、警告なし。不在時に「first N record(s)」ではなく検索範囲を明示 | A4 |
| **T1-14** | ヒット 0 件 + `walkComplete: false` | 文言が不在を断言しない（"No match in the first N record(s)"）＋ `[WALK_INCOMPLETE]`。INSERT・修復を提案しない | A4 |
| **T1-15** | `mirroredOnly: true` | 表示は mirror 済みのみ。ただし walk 範囲は library 全体（`scannedCount` は mirrored 数と一致しない） | A1 |

---

## 2. M2 の invariant 接触検査 — 単体 `tests/cache.test.ts` / `tests/pull_pruning.test.ts` 追記

| ID | 検証項目 | 期待結果 | A |
|---|---|---|---|
| **T2-1** | `collectLocalMirrorIndex()` が pruning を改变しない | `pullMedia({ prune: true })` の active-id seed は remote record のみ。索引を渡しても既存 mirror ファイルが self-exempt にならない（v0.1.15 で修正済みの bug の regression lock） | A5 |
| **T2-2** | `legacy_*` companion の除外 | `legacy_*.yaml` は索引に出ず、mirror 数にも数えられない（`countMirroredMedia()` と整合） | — |
| **T2-3** | 相補 `id:` 以外からの record id 復元を行わない | stem が 26 字 ULID に見える資産でも、companion の `id:` が無ければ `mediaRecordIdForStem()` は null を返し、索引は filename-prefix 帰属しない | A5 |
| **T2-4** | cache 無し workspace（`.emit/cache.db` 不在） | `collectLocalMediaMirrorCandidates()` 経路で索引が構築され、`localPath` が companion stem から決まる | A1 |


---

## 3. M3: CLI — 統合 `tests/cli_media_search.test.ts`

| ID | 検証項目 | 期待結果 | A |
|---|---|---|---|
| **T3-1** | `emit media-search <kw>`（正常） | stdout に件数・`scannedCount`・各 hit の storageKey と `[mirrored]/[not mirrored]`。exit 0 | A1 |
| **T3-2** | 未認証（token 解決不可） | `❌ ...` 1 行＋`process.exit(1)`。raw `file://` stack trace が出ない（`tests/cli.test.ts` の profile 系と同型検査） | — |
| **T3-3** | `--max-scan` 打ち切り時 | `⚠️ [WALK_INCOMPLETE]` ブロックと「不在は証明されない」旨の文言。`💡` 案内が pull-media へ誘導 | A4 |
| **T3-4** | `--suggest-keywords` | 上位 tag slug が 10 件以下で出る（count 降順）。categories は出さない | — |
| **T3-5** | `--mirrored-only` と `--limit` の組み合わせ | 件数が limit 以内、truncation note が正しい | A1 |
| **T3-6** | `-p <profile>` 解決 | `resolveContext()` 経由。env / profile / config の優先順位警告が既存 CLI と同一（origin invariant） | A7 |

---

## 4. M4: MCP — 統合 `tests/mcp.test.ts` / `tests/mcp_tool_errors.test.ts` 追記

| ID | 検証項目 | 期待結果 | A |
|---|---|---|---|
| **T4-1** | tool 登録 | `sync_media_search` が一覧に出る（既存 tool 群と並ぶ） | — |
| **T4-2** | 正常検索 payload | JSON に `query, scannedCount, walkComplete, totalCount, truncated, hits[]`。context 節約のため hits は既定 20 以下 | A1 |
| **T4-3** | workspace 外で呼ぶ | `formatToolError()` 経由の `isError: true`。throw が callback から漏れない（context tools 検査に追加） | A6 |
| **T4-4** | `AmbiguousProfileError` | `[CODE]` と suggestion を保ち、message だけの簡素化が起きない | A6 |
| **T4-5** | network 失敗 | `MEDIA_LIST_FAILED` の status / endpoint / suggestion が payload に残る | A6 |
| **T4-6** | `walkComplete: false` | `note` に `[WALK_INCOMPLETE]` を含み、「asset does not exist」表現を避ける。INSERT 提案文言が存在しない（文字列検査） | A4 / A6 |

---

## 5. M5: `--storage-key` 個別 mirror — 統合 `tests/media.test.ts` / `tests/push_media_pipeline.test.ts` 追記

| ID | 検証項目 | 期待結果 | A |
|---|---|---|---|
| **T5-1** | `emit pull-media --storage-key <key>`（walk で解決可能） | `media/<markdownRef>.<ext>` と `.yaml` が書かれ、`media_state` に storageKey PK・`markdown_ref`・`local_content_hash` が登録。GET `/media/{id}` の再 fetch なし（walk record を再利用） | A5 |
| **T5-2** | 解決不能 key | `orphanStorageKeys` に載り、binary はダウンロードされない。修復・INSERT 提案文言なし | A4 |
| **T5-3** | 既存 mirror の再実行 | idempotent（skipped）。companion が上書きされても `alt` / `caption` は保持される（`buildMediaMetaDoc()` の existingMeta フォールバック） | — |
| **T5-4** | `--article` / `--all` との排他 | 複数指定は CLI レベルで拒否（exit 1、案内 1 行） | — |

---

## 6. M6 / M7: hint と guard 文面 — 単体 `tests/preflight.test.ts` 追記

| ID | 検証項目 | 期待結果 | A |
|---|---|---|---|
| **T6-1** | `LOCAL_IMAGE_DETECTED`（standalone / inline 両経路） | suggestion に media-search 経路と「mirror 済み資産に限る」条件の両方が含まれる。code は不変（G5 codes: `src/sync/guards.ts:123` / G11 codes: `src/sync/guards.ts:178-181`） | — |

| **T6-2** | `MISSING_LOCAL_IMAGE_FILE` | 既存の promoted mirror 案内に加え検索経路が加わり、「文件名推測ではない」ことが読み取れる | — |
| **T6-3** | 既に promoted 画像（companion 一致）の再参照 | v0.1.15 の reuse 挙動が無変更で成功（`[MEDIA_EXISTENCE_UNVERIFIED]` / `PROMOTED_MEDIA_NOT_FOUND_REMOTE` の regression lock） | — |
| **T6-4** | hint の件数上限 | tag hints は 10 以下。taxonomy が無い workspace では `tagHints` 省略（空配列ではない） | — |

---

## 7. CLI/MCP 対称性（A7）と invariant regression lock

| ID | 検証項目 | 期待結果 | A |
|---|---|---|---|
| **T7-1** | 同一 workspace・同一 query で CLI と MCP を実行 | `hits` の件数・storageKey・`mirrored` が一致（同一 sync 層を呼んでいることの証明） | A7 |
| **T7-2** | 検索機能が本文 hash を改变しない | 検索前後で `sync_state.local_hash` と `base_snapshots` がバイト単位で同一（localMediaRefs の canonical invariant に触れない） | — |
| **T7-3** | doctor と walk 実装の共有 | `doctor --check-media-library` の coverage 数値が search の `scannedCount` / `totalCount` と矛盾しない（ページ取得関数の二重実装がないこと） | — |
| **T7-4** | error code 全分類 | `tests/guards.test.ts` の rogue-code 検査が green。新規 `MEDIA_SEARCH_QUERY_REQUIRED` / `MEDIA_SEARCH_AUTH_REQUIRED` を追加した場合は `OPERATIONAL_ERROR_CODES` に登録済み | A6 |

---

## 8. 受け入れ条件 ↔ テスト対応表

| 受け入れ条件 | テスト ID |
| --- | --- |
| **A1**（未 mirror が一覧に出る） | T1-1, T1-15, T2-4, T3-1, T4-2 |
| **A2**（alt だけでヒット） | T1-2, T1-3, T1-7 |
| **A3**（サーバーへ `q` を送らない） | T1-10 |
| **A4**（epistemic: 完全 walk なくして不在主張なし） | T1-12, T1-13, T1-14, T3-3, T4-6, T5-2 |
| **A5**（mirror 命名 / 帰属 invariant） | T1-4, T1-5, T1-6, T2-1, T2-3, T5-1 |
| **A6**（MCP error contract） | T4-3, T4-4, T4-5, T7-4 |
| **A7**（CLI/MCP 対称性） | T3-6, T5-5, T7-1, T7-2, T7-3 |

完了条件: `npm run check`（`format:check` → `typecheck` → `test`）が exit 0、全 test green。

---

## 9. テスト実装の注意（hermeticity）

- **ambient env を消す**: `tests/setup/env-isolation.ts`（vitest `setupFiles`）が `EMDASH_ORIGIN` / `EMDASH_WORKSPACE` / `EMDASH_TOKEN` / `EMDASH_API_TOKEN` を各 test 前に削除する。search の profile 解決テストはこの前提に依存するため、`process.env` を直接設定する場合は test 後に復元する。
- **fetch は必ず stub**: `searchRemoteMedia()` / `pullMedia()` には `fetchFn` を注入し、実ネットワークを出ないこと。cursor ページングは `tests/pull_pagination.test.ts` の既存パターンに従う。
- **cache は `:memory:`**: `CacheDatabase(':memory:')` を使い、schema v5 の列（`storage_key` PK・`markdown_ref`）を直接検証する。
- **CLI 検査は `program.parseAsync`**: `tests/cli.test.ts` に倣い `HOME` / `console.error` / `process.exit` を stub して exit code と stdout/assert を行う。action の throw を許さない。
- **Prettier 準拠**: `printWidth: 100`, `singleQuote: true`, `trailingComma: all`。テスト内の長い tool description 文字列は `format:check` を通す形で折る。

| **T5-5** | MCP `sync_pull_media({ storageKey })` | CLI と同一 sync 層を呼び、disk 上の mirror が一致 | A7 |
