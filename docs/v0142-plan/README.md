# v0.1.42 計画書: メディア検索の拡張（日付・オフライン）・同期リミット適正化と参照保護プルーニング

- **対象バージョン**: `v0.1.42`
- **作成日**: 2026-11-21（レビュー反映改訂版 / Ask First 承認済み）
- **ステータス**: **実装着手可（Approved）** — レビュー指摘 6 点および実測コード検証による 5 点を反映済み。Ask First の該当 2 件（カテゴリ 2: `mediaSyncLimit` 既定値 300→100、カテゴリ 4: プルーニング既定反転と空クエリ境界の発展的改訂）は **2026-11-21 に施主が全範囲（P1〜P5）を承認**。新規 npm パッケージ不使用、SQLite スキーマ変更なし、公開 facade（`pullBatch` / `pullSingleArticle` / `pushArticle` / `pushAll`）および MCP ツールのシグネチャ・引数形状は完全互換を維持。Guard レジストリ G1〜G19 に変更なし。承認内訳:
  - **カテゴリ 2（承認）**: `DEFAULT_CONFIG.mediaSyncLimit` の既定値 300→100 は `.emit/config.json` の既存キーの意味変更にあたる。
  - **カテゴリ 4（承認）**: P4 のプルーニング既定反転（opt-in → opt-out）は、`AGENTS.md` §7「Pruning authority is remote records only」不変条件および `docs/media-id-spaces.md` の記述改訂を伴う核心原則の変更にあたる。
- **起点**: v0.1.41 リリース後のメディア運用ディスカッションから浮上した 5 つの課題:
  1. 「管理画面やスマホから直近アップロードした画像（`IMG_xxxx` やスクショ等）は `alt` や `caption` が未設定でキーワード検索できない。日付や直近ブラウズで探したい」
  2. 「機内などの完全オフライン環境で手元資産（`cache.db` / `media/*.yaml`）を検索して執筆できない（現行の `--mirrored-only` はリモート API fetch が必須でオフラインでは通信エラーになる）」
  3. 「オフライン検索とリモート検索が混同されると、ローカルに無いだけで『サーバーに存在しない』と AI や人間が誤認し、オンライン復帰後に重複アップロードを招く（認識論的保護が必要）」
  4. 「サーバー側で削除されたゴミ画像がローカルに古いまま残ると、記事執筆後に push 時に初めて弾かれて大きな手戻りになる（プルーニングのデフォルト化要望）」
  5. 「しかし現状の `pull-media` のプルーニング処理は、手元記事の参照（本文および `featuredImage`、退避コピー）を無視して走査枠外の画像を誤消去してしまう欠陥（保護ガード欠落）があり、また走査不完全な状態での消去は epistemic rule に違反するためデフォルト化できなかった」
  6. 「メディア同期枠（`mediaSyncLimit = 300`）は 1 ページ 100 件の API に対して常に最低 3 回の通信を要し日常動作が重い。また `emit pull`（記事）には `--limit` がなく設定ファイル（`postsSyncLimit`）に一本化されているのに対し、`emit pull-media` だけ `--limit` があり非対称」
- **目的**:
  1. **P1: メディア検索の日付範囲・直近ブラウズ機能（`--since` / `--until` & クエリ任意化）** — キーワードなしでの直近メディア一覧表示、および作成日範囲指定（`today`, `yesterday`, `YYYY-MM-DD`）を導入。EmDash API の降順リスト特性を活かした早期打ち切り（Early-exit）と、日付フィルタ済み集合における `walkComplete` 意味論を確立する。v0.1.16 以来の「空クエリ拒否」境界を発展的に改訂する。
  2. **P2: 完全オフライン検索モード（`--offline`）と認識論的保護（Epistemic Framing）** — ネットワーク通信を一切遮断し、既存の `collectLocalMirrorIndex()`（Layer 2）を再利用して高速検索する `--offline` フラグを新設。暗黙フォールバックを禁止し、出力 1 行目で `[SOURCE: LOCAL WORKSPACE ONLY (OFFLINE)]` と大声で宣言し、0 件ヒット時の不在保護警告を徹底する。
  3. **P3: メディア同期リミットの適正化（300件 → 100件）と `--limit` 非推奨化** — 1 API ページ上限（100件）に合わせて `DEFAULT_CONFIG.mediaSyncLimit` を `300` から `100` へ変更し日常の pull を軽量化。CLI `--limit` は非推奨受容（deprecated 警告）とし、MCP 引数も互換維持しつつ `.emit/config.json` への一本化を進める（Ask First カテゴリ 3 遵守）。
  4. **P4: 記事参照保護・完全性ガード付きデフォルト・プルーニング（Referenced Media Protection & Complete Walk Gate）** — 記事本文、`featuredImage`、`posts/conflicts/` から参照される全アセットをプルーニングから絶対保護。さらに、**走査が完全（`remoteIndex.complete === true`）な場合のみ自動プルーニングを実行する「完全性ガード」**を組み込むことで、不完全な知識による誤消去（epistemic rule 違反）を完全に根絶する。安全性を担保した上でデフォルト有効とし、抑制用フラグ `--no-prune` を新設する。

---

## 1. 要望評価の要約と本計画での扱い

| #   | 要望・課題                                                      | 現状の実測事実                                                                                                                                                                                                                                                  | 判定                                                                                                                                                               | 本版での扱い                                                                                                                                                                           |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 直近アップロードされた画像が探せない                            | `src/sync/media/remote_index.ts:190-198` で `options.query?.trim()` の空判定があり、空の場合は `MEDIA_SEARCH_QUERY_REQUIRED` エラーで即座に投げる（v0.1.16 T1-8）。日付オプションはなくキーワード必須                                                           | 妥当。スマホ撮影やスクショは `alt`/`caption` が未設定でファイル名も無機質なためキーワード検索が不能。v0.1.16 の「分担表に基づく空 query 拒否」を発展的に見直す時期 | **P1 として採用**。クエリを optional に緩和し、`--since` / `--until` による日付指定を追加。降順 API 特性を活かした早期打ち切り（Early-exit）を実装。旧 T1-8 テストとドキュメントを更新 |
| 2   | オフラインで手元の画像が検索できない                            | 現行の `--mirrored-only`（`src/sync/media/remote_index.ts:244`）はリモート API（`fetchMediaListPage`）の走査ループ内でローカル存在判定を行っているためネットワーク必須。オフライン時は `fetch` エラーで即死する                                                 | 妥当。機内などでの完全オフライン執筆時に手元画像を探す手段が欠落している                                                                                           | **P2 として採用**。既存の `collectLocalMirrorIndex()` を再利用し、完全ローカルで動作する `--offline` モードを新設                                                                      |
| 3   | オフライン検索による「不在誤認」の危険                          | オフライン検索でヒットしなかった場合、AI や人間が「サーバー上に存在しない」と誤認して重複アップロードや破損と断定するリスク（Epistemic Confusion）がある                                                                                                        | 妥当。勝手な自動フォールバックは事故を誘発するため厳禁                                                                                                             | **P2 にて保護ガードを確立**。暗黙フォールバックを禁止し、出力冒頭での `[SOURCE: LOCAL WORKSPACE ONLY]` 宣言と 0 件時の不在警告を義務付ける                                             |
| 4   | メディアのプルーニングがデフォルト OFF でゾンビ資産が残る       | `emit pull-media` はデフォルトで `options.prune` が undefined のため削除を行わない（`src/sync/media/pull_library.ts:217`）。サーバーで削除されたゴミ画像がローカルに残り続け、記事 push 時に 404/400 となって初めて気づく                                       | 妥当。手戻りのコストが極めて高い                                                                                                                                   | **P4 として採用**。完全性ガードと参照保護を条件に、プルーニングをデフォルト ON に変更（エスケープハッチとして `--no-prune` を追加）                                                    |
| 5   | 部分走査時のプルーニングで記事の画像が巻き添え消去される欠陥    | 現状の `pull_library.ts:227-238` は、今回の走査結果 `activeMediaIds` にないものを一律 `unlinkSync` している。本文・`featuredImage`・退避コピーの参照検査がなく、また走査枠外（101件目以降）の画像を消去するのは epistemic rule 違反                             | 妥当。重大な安全性の穴（仕様欠陥）                                                                                                                                 | **P4 にて記事参照保護ガード（本文 + featuredImage + conflicts）と完全性ガード（`remoteIndex.complete === true` 必須）を新設**                                                          |
| 6   | メディア同期リミット 300 件が重く、`--limit` が記事同期と非対称 | `DEFAULT_CONFIG.mediaSyncLimit = 300`（`src/utils/config.ts:75`）。API の 1 ページ上限は 100 件（`src/sync/media/types.ts:36`）のため常に最低 3 回 fetch が走る。また `emit pull` は `postsSyncLimit` に一本化されているのに `pull-media` だけ `--limit` がある | 妥当。ただし 100 件引き下げは枠外参照（unresolved）の頻度を増やすトレードオフがある                                                                                | **P3 として採用**。既定値を 100 に変更し、トレードオフと P4 参照保護の緩和関係を明記。CLI `--limit` および MCP 引数は非推奨受容（破壊的変更なし）                                      |

---

## 2. 現状の実測スナップショット（2026-11-21 / v0.1.41）

すべて実際のコードに基づく計測結果であり、推定を含まない。

### 2.1 実測値一覧

| 項目                                | 実測値                                                                                                                                                                                                                                                 | 検査コード / コマンド                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| メディア検索のクエリ必須制約        | `if (!trimmed) throw new ApiError({ code: 'MEDIA_SEARCH_QUERY_REQUIRED' ... })`                                                                                                                                                                        | `src/sync/media/remote_index.ts:190-198`                                   |
| メディア検索の MCP スキーマ         | `query: z.string().min(1).describe(...)`（MCP 側も必須）および CLI は `program.command('media-search <query>')` で**必須引数**。クエリなし受理には両側の修正が必要                                                                                     | `src/mcp/tools/sync-media-search.ts:38-41`、`src/cli/commands/media.ts:42` |
| メディア API の 1 ページ上限        | `MEDIA_LIST_PAGE_SIZE = 100`                                                                                                                                                                                                                           | `src/sync/media/types.ts:36`（実測行数）                                   |
| メディア検索の既定走査上限          | `MEDIA_SEARCH_DEFAULT_MAX_SCAN = 500`（`:41`）、ヒット上限は `MEDIA_SEARCH_DEFAULT_LIMIT = 20` / `MEDIA_SEARCH_MAX_LIMIT = 50`（`:38-39`）                                                                                                             | `src/sync/media/remote_index.ts:38-41`                                     |
| メディア同期リミットの既定値        | `DEFAULT_CONFIG.mediaSyncLimit = 300`                                                                                                                                                                                                                  | `src/utils/config.ts:75`                                                   |
| メディアプルーニングの起動条件      | `if ((options.prune                                                                                                                                                                                                                                    |                                                                            | options.all) && fs.existsSync(mediaDir))` | `src/sync/media/pull_library.ts:217` |
| メディアプルーニングでの参照検査    | **一切存在しない**（`activeMediaIds.has(companionId)` のみ判定）                                                                                                                                                                                       | `src/sync/media/pull_library.ts:227-238`                                   |
| 記事参照走査ロジックの所在          | 本文走査 `scanArticleMediaReferences` は **Layer 0**（`src/utils/media-body-refs.ts:213`）。本文 + featuredImage 統合走査 `collectArticleReferencedMediaIds` および `collectArticleStorageKeys` は **Layer 2**（`src/sync/media/body_scan.ts:61, 98`） | `src/utils/media-body-refs.ts`／`src/sync/media/body_scan.ts`              |
| 記事プルのプルーニング仕様          | デフォルト有効（`prune: !options.noPrune`）、未プッシュ変更は `SyncPruneConflictError` で保護                                                                                                                                                          | `src/cli/commands/pull.ts:404`、`src/sync/orchestrator.ts:237`             |
| メディアプルの `--limit` オプション | `pull-media` に存在（`-l, --limit <number>`、`tests/cli.test.ts:107`）、`pull` には存在しない（`tests/cli.test.ts:145-151` で明示アサート）                                                                                                            | `src/cli/commands/pull.ts:546-551`                                         |
| `--limit` への案内文                | `pull.ts:616` / `sync-pull.ts:425` に `Run "emit pull-media --all" (or a larger --limit)` が存在                                                                                                                                                       | `src/cli/commands/pull.ts:616`、`src/mcp/tools/sync-pull.ts:425`           |

### 2.2 本計画が触るファイルの実測規模

| ファイル                             | 行数 | 本版での役割                                                                                                                                                             |
| ------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/sync/media/remote_index.ts`     | 341  | **P1 & P2 の中心**。`searchRemoteMedia` の query optional 化、日付パース（since/until）と早期打ち切り、`--offline` 時の `collectLocalMirrorIndex()` 経由検索の実装       |
| `src/sync/media/pull_library.ts`     | 284  | **P4 の中心**。`pullMedia` に記事参照保護ガード（本文 + featuredImage + conflicts）および完全性ガード（`remoteIndex.complete === true` 必須）を追加、デフォルト prune 化 |
| `src/sync/media/body_scan.ts`        | 170  | **P4 の参照抽出口（Layer 2）**。`collectArticleReferencedMediaIds()` を活用し、`posts/` 配下の全記事から保護すべき ID・キー集合を抽出                                    |
| `src/cli/commands/media.ts`          | 141  | **P1 & P2 の CLI 配線**。`emit media-search` に `--since`, `--until`, `--offline` オプションを追加しクエリを任意化                                                       |
| `src/cli/commands/pull.ts`           | 669  | **P3 & P4 の CLI 配線**。`emit pull-media` の `--limit` を非推奨受容化、案内文修正、`--prune` をデフォルト化し `--no-prune` を追加。ヘルプ表記の改善                     |
| `src/mcp/tools/sync-media-search.ts` | 103  | **P1 & P2 の MCP 配線**。`query` を optional 化、`since`, `until`, `offline` を追加、出力メタデータ（`source: "local_mirrors"`）の認識論的フレーム付け                   |
| `src/mcp/tools/sync-pull.ts`         | 258  | **P3 & P4 の MCP 配線**。`sync_pull_media` の引数互換維持、`noPrune` 対応、案内文の修正                                                                                  |
| `src/utils/config.ts`                | 249  | **P3 の設定値変更**。`DEFAULT_CONFIG.mediaSyncLimit` を `300` → `100` に変更（precedence ロジック自体は不変）                                                            |
| `src/presentation/article_report.ts` | 105  | P2: オフライン検索結果の提示ヘッダー・不在警告フォーマッター                                                                                                             |

---

## 3. 実装計画

### 3.1 P1: メディア検索の日付範囲・直近ブラウズ機能

#### 課題

スマホ撮影やスクショ画像は `alt` や `caption` が未設定でファイル名も無機質なためキーワード検索でヒットしない。また、キーワードなしで「直近の画像を一覧する」機能がなく、v0.1.16 の「空クエリ拒否」境界に縛られている。

#### 実装方針

1. **クエリの任意化（Optional 化）と境界移行**:
   - `searchRemoteMedia(options)` において、`options.query` が未指定（または空文字）であっても、日付指定がある場合やブラウズ用途として正常に受理する。
   - クエリも日付も未指定の場合は、「直近アップロードされたメディア一覧（最新 `limit` 件）」として動作する。
   - **CLI 側の新設（必須作業）**: 現行コマンドは `program.command('media-search <query>')`（`src/cli/commands/media.ts:42`）で**必須引数**として宣言しているため、クエリなしでは commander が usage エラーになる。`'media-search [query]'` へ変更し、`options.since` / `options.until` / `options.offline` を `.option()` 追加する（`--since` / `--until` は文字列値）。MCP 側は `src/mcp/tools/sync-media-search.ts:42` 付近に `since` / `until` / `offline` の optional 引数を追加する（既存 `query`・`limit`・`maxScan`・`mirroredOnly`・`suggestKeywords` は不変）。
   - **v0.1.16 由来の分担思想の更新**: v0.1.16 では「空 query 拒否: 走査全量の列挙は公式 MCP の担当」と定められていたが、本版では「執筆ループ内での直近アセットのブラウズ（上限 50 件）」として明確に再定義し、fleet-scale の全量列挙（Admin/公式MCP専任）との境界を維持する。README および AGENTS.md の記述を整合させる。
   - **既存テストの更新**: `tests/media_search.test.ts` T1-8（`:319`、空クエリ拒否と `MEDIA_SEARCH_QUERY_REQUIRED` をアサート）を、「query も日付もなし = 直近一覧の返却」を検証する正例テストへと書き換える。`src/sync/guards.ts:89` のコード自体は削除しない（他経路の分類として残る）。
2. **日付フィルター（`since`, `until`）の導入**:
   - `options.since?: string` および `options.until?: string` を受け付ける。
   - 自然言語ライクな日付（`today`, `yesterday`）および ISO 形式（`YYYY-MM-DD`）をパースする純粋ヘルパー `parseSearchDateBoundary()` を Layer 0 に新設。
   - レコードの `item.createdAt`（ISO 8601）と比較して範囲外のものを除外する。
3. **早期打ち切り（Early-exit）と epistemic rule（`walkComplete`）の意味論**:
   - **降順の前提**: EmDash のメディア API（Cloudflare D1）は `ORDER BY id DESC`（ULID 降順 = `createdAt` 降順）で返却される設計である。
   - **早期打ち切りの挙動**: 走査中に `since`（下限日時）よりも古い `createdAt` を持つレコードに遭遇した場合、それ以降のページに条件を満たすレコードは存在し得ないため、即座に走査ループを `break` して終了する。
   - **`walkComplete` の意味論（現行実装への追加として正確に記述）**:
     現行 `remote_index.ts:289-292` は「`page.rawItems.length === 0 || !page.nextCursor`」でしか `walkComplete = true` を設定しない。ここに **since 境界到達による打ち切り**の場合を加える:
     - `since` 境界到達によって早期打ち切りされた場合 → `walkComplete: true`。「指定された日付条件内の集合としては完全に走査された（フィルタ済み完全性）」ため、不当な `[WALK_INCOMPLETE]` 警告を抑止する。ただし `scannedCount` は実際に読んだ件数のまま計上し、`totalCount`（ライブラリ総数）と混同させない。
     - `maxScan` 上限に当たって打ち切られた場合 → 従来どおり `walkComplete: false`。不在を断定しない epistemic rule を厳格に維持する。
     - **判定可能な性急の限定**: 「since 早期打ち切り＝完全」は降順が壊れている環境では誤りになるため、この性急を適用するのはリモート走査のみ（オフライン検索ではない）とし、`hits` が空でも「日付条件内には無い」としか主張しない文言に留める。
   - **シグネチャ追加**: `SearchRemoteMediaOptions`（`remote_index.ts:43-58`）へ `query?: string`, `since?: string`, `until?: string` を**追加**する（既存必須フィールドの削除・意味変更はなく、呼び出し側 `src/cli/commands/media.ts:61-70` と `src/mcp/tools/sync-media-search.ts:66-74` の既存引数はそのまま成立する）。

### 3.2 P2: 完全オフライン検索モード（`--offline`）と認識論的保護

#### 課題

現行の `--mirrored-only` はリモート API の走査ループ内でローカル存在判定を行っているため、通信環境のない機内ではエラーになり使用できない。また、オフライン検索結果を「リモートの真実」と誤認するリスク（Epistemic Confusion）を排除しなければならない。

#### 実装方針

1. **既存インデックス（`collectLocalMirrorIndex`）の再利用**:
   - 新規にローカル走査ロジックを起こすのではなく、既に Layer 2 に存在する **`collectLocalMirrorIndex(workspaceRoot, cache)`**（`src/sync/media/companions.ts`）を再利用する。
   - これは `cache.db` の `media_state` と `media/*.yaml` のコンパニオンメタデータを完全に統合したインデックス（`Map<storageKey, LocalMirrorEntry>`）を提供する。
2. **完全オフライン検索パイプライン**:
   - `--offline` が指定された場合、リモートへの HTTP 通信（`fetch`）を一切行わず、上記 `collectLocalMirrorIndex` のエントリに対してクエリおよび日付（since/until）フィルターをインメモリ適用する。
   - **オフライン時のコンテキスト解決**: `resolveContext` はファイルベースの設定・プロファイルのみを読み、HTTP 疎通を行わないため、オフライン時でも安全に解決可能であることを保証する。
3. **暗黙フォールバックの禁止（Fail Fast）**:
   - オンライン検索（`--offline` なし）でネットワークエラーが発生した際、勝手にオフライン検索へ切り替える「親切な自動フォールバック」は絶対に実装しない。
   - ネットワーク遮断時は即座に失敗させ、「To search only local cached media, use --offline」という明確なガイダンスを出力する。
4. **認識論的フレーム付け（Epistemic Framing）**:
   - CLI 出力の先頭行で大声で宣言する:
     ```text
     [SOURCE: LOCAL WORKSPACE ONLY (OFFLINE)]
     Searched N mirrored assets in local workspace.
     Remote EmDash library was NOT queried.
     ```
   - MCP `sync_media_search` のレスポンス JSON の先頭にメタデータを付与する:
     ```json
     {
       "source": "local_mirrors",
       "remoteQueried": false,
       "warning": "Remote CMS was NOT checked. Absence from this list does NOT prove the asset does not exist remotely.",
       "hits": [...]
     }
     ```
5. **0 件ヒット時の不在保護警告（Absence Protection）**:
   - 該当なしの場合、単に `No hits found.` とだけ返すと AI が「サーバーにも存在しない」と推論するため、以下の警告を必ず添える:
     `No matching media found in local workspace. (Remote EmDash library was NOT checked. The asset may exist remotely.)`

### 3.3 P3: メディア同期リミットの適正化（300件 → 100件）と `--limit` 非推奨化

#### 課題

API の 1 ページ上限が 100 件であるのに対し、既定値が 300 件であるため、日常の pull で常に 3 ページの往復が発生して重い。また、記事の同期（`emit pull`）には `--limit` がなく設定ファイル（`postsSyncLimit`）に一本化されているのに対し、メディア側だけ `--limit` があり非対称である。

#### 実装方針

1. **既定値の変更とトレードオフの明示**:
   - `src/utils/config.ts` の `DEFAULT_CONFIG.mediaSyncLimit` を `300` から `100` に変更（`sync-limit-precedence.ts` の優先順位ロジック自体は不変）。
   - **トレードオフ**: ライブラリ規模が >100 件の環境では、日常の pull で一度に確認される枠が最新 100 件となるため、それより古いメディアは枠外（unresolved）として扱われる頻度が増える。ただし、手元記事から参照されている画像は P4 の記事参照保護ガードにより絶対に削除されないため、日常の執筆資産が壊れることはない。
   - より多くの履歴を一括同期したいユーザーは、`.emit/config.json` に `"mediaSyncLimit": 300` 等を明示設定する。
2. **CLI `--limit` の非推奨受容（後方互換性維持）**:
   - CLI オプションから `-l, --limit <number>` を即時削除するのではなく、非推奨（deprecated）として維持する。
   - `--limit` が渡された場合は警告（`⚠️ [DEPRECATED] --limit is deprecated. Configure "mediaSyncLimit" in .emit/config.json instead.`）を出力しつつ、動作としては受理する。
3. **MCP 引数互換性の維持（Ask First カテゴリ 3 厳守）**:
   - `sync_pull` および `sync_pull_media` の引数から `limit` を**削除しない**。外部エージェントスクリプトを破壊しないよう optional 引数として維持し、未指定時のフォールバック先が `100`（`DEFAULT_CONFIG`）となるようにする。
4. **既存案内文の更新**:
   - 走査枠外を案内する文言は 4 箇所に実在する。すべてから `(or a larger --limit)` を削除し、config キー参照に置き換える: `src/cli/commands/pull.ts:616`, `src/mcp/tools/sync-pull.ts:425`, `src/presentation/article_report.ts:45`, `src/sync/doctor.ts:1055-1058`（doctor の 2 行は「full library pass」案内であり、`--limit` を直接推奨していないため文言変更不要かどうかを実装時に確認する）。
   - **MCP 側の既定値表示**: `sync_pull_media` の `limit` 説明（`src/mcp/tools/sync-pull.ts:362-366`「defaults to 300」）および `sync_pull` の `includeMedia` 説明（`:59`, `:103`「default 300」）を `mediaSyncLimit`（既定 100）参照へ更新する。`limit` 引数自体は `resolveMediaSyncLimit(ctx.config, { mediaSyncLimit: args.limit })`（`:443`）経由で既に解決済みであり、既定値変更のみで自動的に 100 がフォールバックになる（コード追加なし）。
   - **CLI の非推奨警告**: `pull-media` の `-l, --limit <number>`（`src/cli/commands/pull.ts:546`）は受容継続し、指定時に限り `⚠️ [DEPRECATED] --limit is deprecated. Configure "mediaSyncLimit" in .emit/config.json instead.` を stderr へ出力する。ヘルプ文言の「default: 300 or config」も既定 100 に更新する。

### 3.4 P4: 記事参照保護・完全性ガード付きデフォルト・プルーニング

#### 課題

サーバー側で削除されたゴミ画像がローカルに残り続けると、ユーザーや AI が「使える」と誤認して記事を書いてしまい、push 時に手戻りとなる。しかし現行のプルーニングは、手元記事の参照（本文・featuredImage・conflicts）をチェックせず走査枠外の画像を誤消去してしまう欠陥があり、また走査不完全な状態での消去は epistemic rule（不完全な知識で破壊的操作をしない）と衝突する。

#### 実装方針

1. **保護対象の完全網羅（本文 + featuredImage + conflicts）**:
   - `src/sync/media/pull_library.ts` のプルーニング処理（`:217-240`）の直前で、手元のローカル記事を走査し、保護すべきキー集合を構築する。
   - 走査対象ディレクトリ: `<collection>/draft/`, `<collection>/published/`, および **`<collection>/conflicts/`**（退避コピー内の参照も保護）。コレクション名は `options.collection || 'posts'` から解決する（現行 census ループ `:246-250` も同じ解決を使い、`draft`/`published` のみを歩いている。conflicts を追加するのは新設する保護集合側のみ）。
   - 除外規則: `.deleted.md`（削除バックアップ）は参照集合に含めない。既に削除された記事の残骸を根拠にミラーを残すと、リモート削除済みレコードが永遠に掃除できなくなるため。`.conflict.md` と `.local-dropped.md` は保護対象に含める。
   - 抽出ロジック（いずれも Layer 2 `body_scan.ts` の既存関数を再利用し、新規パーサは書かない）:
     - 本文内の `storageKey`: `collectArticleStorageKeys()`（`:61`）→ `descriptor.storageKey`
     - フロントマターの `featuredImage`（record ULID）と本文画像 ULID: `collectArticleReferencedMediaIds()`（`:98`）
   - これらから `protectedStems: Set<string>` および `protectedRecordIds: Set<string>` を構築する。
   - **二つの ID 空間を突き合わせる正規化規則（必須）**: 本文 URL が担うのは R2 `storageKey`、companion YAML の `id:` が担うのは D1 レコード ULID であり、同一画像でも値が異なる（`docs/media-id-spaces.md`）。したがって比較は次の 2 系統に限定する:
     - **stem 系統**: `storageKeyToMarkdownRef(key)`（Layer 0 `src/utils/naming.ts:159`）で本文 storageKey をミラーステムへ正規化し、ファイル名から導出した stem と突き合わせる。衝突解決済み (`<stem>--<mediaId>`) ミラーは後段の companion 系統で救済される。
     - **id 系統**: companion YAML の `id:`（`mediaRecordIdForStem()` が既に ULID を大文字正規化して返す）と `protectedRecordIds` を突き合わせる。ファイル名先頭 26 文字からの id 推定は行わない（AGENTS.md §7「Ownership is read from companion YAML, never parsed from a filename」）。
2. **完全性ガード（Complete Walk Gate — Epistemic Rule 遵守）**:
   - **`remoteIndex.complete === false`（バウンド付き走査で末尾に達しなかった場合）は、プルーニング（ローカル削除）を絶対に実行しない（安全スキップ）**。
   - 理由: 走査が末尾に達していない場合、枠外の画像が「サーバーで削除されたのか、単に 101 件目以降に存在しているのか」を断定できないため。知識が不完全な状態での削除は AGENTS.md の核心原則に違反する。
   - **実測事実**: `remoteIndex.complete` は既に正しい唯一の情報源であり、`pull_library.ts:209-212` で `page.nextCursor` が消えた地点でのみ `true` になる（`targetTotal` に達して `break` した経路は `complete === false` のまま）。よってガードは状態管理を新設せず、このフラグを読むだけでよい。
   - **情報メッセージは Layer 3 で出力する**: `src/sync/media/` は非 CLI モジュールであり `console.log()` を使えない（Axis 5。実測で同ディレクトリに `console.*` は 0 件）。スキップ判定は `PullMediaResult` の新フィールド **`pruneSkippedReason?: 'incomplete_walk'`** として返し、CLI（`src/cli/commands/pull.ts:661`）と MCP（`src/mcp/tools/sync-pull.ts:472`）が既存の `deletedMsg` 生成箇所で文言を出す。文言は Layer 3 共通フォーマッタ（`src/presentation/`）に置き、CLI/MCP で分岐させない:
     `ℹ️ Pruning skipped: the media walk stopped at the limit (${limit}) and did not reach the end of the remote library, so deleted records cannot be proven. Run "emit pull-media --all" to prune safely.`
   - したがって自動プルーニングが発動するのは **`remoteIndex.complete === true`**（ライブラリ全件が枠内に収まっている場合、または `--all` で全件走査しきった場合）のみとする。
3. **プルーニング判定アルゴリズム（現行 `:217-240` への追加差分として正確に記述）**:
   現行ループは「`legacy_` スキップ → stem が `activeMediaBaseNames` にあればスキップ → companion の `id:` を読む → **id があり、かつリモート走査がその id を報告していない場合のみ unlink**」。本変更で追加するのは「完全性ガード」と「参照保護」の 2 節であり、companion 不在ファイル（`companionId === null`）を unlink しない既存不変条件はそのまま維持する:
   ```typescript
   // 完全性ガード: リモート全容が証明されていない場合は prune を一切実行しない
   const shouldPrune = pruneEnabled && remoteIndex.complete;
   if (pruneRequested && !remoteIndex.complete) {
     result.pruneSkippedReason = 'incomplete_walk'; // 表示は Layer 3 側
   }

   if (shouldPrune && fs.existsSync(mediaDir)) {
     for (const file of fs.readdirSync(mediaDir)) {
       if (file.startsWith('legacy_')) continue; // 旧 file-route 残骸は対象外（既存不変条件）
       const stem = file.replace(/\.[^.]+$/, '');

       // 1. 今回の走査でリモートに存在が確認されたものは安全（date-prefix ステムも従来どおり許容）
       if (
         activeMediaBaseNames.has(stem) ||
         activeMediaBaseNames.has(stem.replace(/^\d{8}_/, ''))
       ) {
         continue;
       }

       // 2. stem 系統の参照保護: 本文・featuredImage・conflicts が参照する storageKey のミラーは絶対保護
       if (protectedStems.has(stem) || protectedStems.has(stem.replace(/^\d{8}_/, ''))) {
         continue;
       }

       // 3. 所有権は companion YAML からのみ読む（ファイル名から id を推定しない）
       const companionId = mediaRecordIdForStem(mediaDir, stem);
       if (!companionId) continue; // 帰属不能なファイルは決して消さない（既存不変条件）

       // 4. id 系統の参照保護: featuredImage ULID 等で参照されるレコードは絶対保護
       if (protectedRecordIds.has(companionId)) continue;

       // 5. リモートに存在しないことが証明済みで、かつローカル記事からも参照されない孤立メディアのみ剪定
       if (activeMediaIds.has(companionId)) continue;
       fs.unlinkSync(path.join(mediaDir, file));
       deletedCount++;
     }
   }
   ```
4. **プルーニングのデフォルト有効化と `--no-prune` エスケープハッチ**:
   - 上記の二重ガード（参照保護 + 完全性ガード）により誤消去リスクが構造的に低減されたため、`emit pull-media` のプルーニングを**デフォルト有効**にする。
   - **コマンド別の適用範囲（混同防止）**: デフォルト有効化はライブラリ walk を行う経路のみ — `emit pull-media`（無指定および `--all`）、MCP `sync_pull_media` の非 target 経路、`emit pull --media` / MCP `includeMedia` のバウンド付きパス。`emit pull-media --article <id>` と `--storage-key <key>` は参照解決コマンドであり prune を行わない現行挙動を維持する（`pull.ts:590`, `:630` の呼び出しに `prune` を渡さない）。
   - 記事 pull（`emit pull --no-prune`）と完全に対称になるよう、プルーニングを明示的にスキップしたい場合のために **`--no-prune`** オプションを新設する。実装は commander の negation で `pull-media` に `--prune`（既存・受容継続）に加え `--no-prune` を追加し、`prune: options.all ? true : !options.noPrune` と解決して `PullMediaOptions.prune` へ渡す。MCP 側は `sync_pull_media` に `noPrune?: boolean` を**追加**する（既存引数の削除・意味変更は一切ない）。
   - `emit pull-media --all` のヘルプ表記に「(automatically prunes deleted records)」を明記する。
5. **レイヤリング上の配置決定（layering ゲートを事前に通す設計）**:
   - 保護集合の構築は `pull_library.ts` と同じ `src/sync/media/` 内の新モジュール **`prune_protect.ts`** に置く。同一ディレクトリ内 import は sibling 結合ではないため、`tests/layering.test.ts:257-261` の `ALLOWED_LAYER_2_SIBLING_IMPORTS` スナップショットを変更する必要がない。
   - **`src/sync/workspace/` には置かない**: `sync/pull/` は `sync/media/index.js` を import できる（許可済みスナップショット）が、`sync/media/` → `sync/workspace/` は未許可の新しい sibling エッジでありゲートが落ちる。conflicts ディレクトリ名は `CONFLICTS_SUBDIR` を参照せず、`pull_library.ts` が既に使う `'conflicts'` 解決をそのまま流用する（Layer 0 への集約は本スコープ外）。
   - `PullMediaOptions.prune` は**既存フィールド**（`types.ts:123`）であり、`PullMediaResult` への `pruneSkippedReason` 追加は戻り値の追加であって破壊的変更ではない。Layer 3 が import 可能な Layer 2 シンボル（`tests/layering.test.ts:91` の `media: new Set(['pullMedia', 'collectLocalMirrorIndex', 'searchRemoteMedia'])`）も変更しない。

---

## 4. ドキュメント更新スコープ（実装と同時）

| ファイル                  | 更新箇所                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`               | L303 / L314（既定値 300→100 と表）、L408（窓の説明文）、L545・L1033-1040（`emit pull-media` の書式と `--prune` / `--no-prune` の説明、`(automatically prunes deleted records)` の明記）、L768・L772（`--media` と `--no-prune` の記述）、L1038（`--limit` 既定値と非推奨注記）、L1144（MCP 引数一覧は変更なしであることを確認） |
| `AGENTS.md`               | 「空クエリ拒否」記述の直近ブラウズへの更新、`mediaSyncLimit` default 300→100 の記述更新、プルーニング既定反転と完全性ガード（`remoteIndex.complete === true` 時のみ unlink）の不変条件追記                                                                                                                                      |
| `docs/media-id-spaces.md` | プルーニングが storageKey と companion `id:` の二空間を突き合わせて判定する旨の一文（ID 空間の取り違え防止）                                                                                                                                                                                                                    |
| `CHANGELOG.md`            | `Changed` に mediaSyncLimit 既定値変更とプルーニング既定有効化、`Added` に `--since` / `--until` / `--offline` / `--no-prune` を記載                                                                                                                                                                                            |

---

## 5. テスト検証マトリクス（Vitest）

### P1（`tests/media_search.test.ts` + `tests/cli_media_search.test.ts`）

- **T1-1**: クエリ未指定（空文字または未定義）で `searchRemoteMedia` を呼び出し、最新順に最大 `limit` 件のメディアが返ること（旧 T1-8 の書き換え検証）。
- **T1-2**: `--since 2026-11-20`（または `today`）を指定し、指定日時以降のメディアのみが返ること。
- **T1-3**: `--until 2026-11-20` を指定し、指定日時以前のメディアのみが返ること。
- **T1-4**: リモート一覧走査中に `since` より古いアイテムに遭遇した時点で、後続ページの `fetchMediaListPage` が呼ばれずに早期終了し、かつ `walkComplete: true` と判定されること（Early-exit 最適化と意味論の検証）。
- **T1-5**: クエリと日付範囲を同時に指定し、両方の条件を満たすレコードのみが返ること（複合フィルター）。
- **T1-6**: 不正な日付形式（例: `--since invalid-date`）が渡された際、適切なエラーメッセージとコードで拒否されること。エラーコードは**新規コードを新設せず `MEDIA_SEARCH_QUERY_REQUIRED` を再利用**する。実測根拠: (a) `src/sync/guards.ts:89` の当該コードは `OPERATIONAL_ERROR_CODES` の一部で、`tests/guards.test.ts` Rule 2 が未分類コードを検出するため、`INVALID_DATE` 等の新コードを追加するなら `guards.ts` の台帳追加が必須になる、(b) `OPERATIONAL_ERROR_CODES` / `PROTECTION_ERROR_CODES` は `src/` 内で `guards.ts` 以外から参照されておらず、Rule 1（登録済みコードは `src/` 側に出現必須）の都合上「throw 箇所が存在しない宣言だけ」も置けない。よって新設なしが変更面積最小で、Guard 台帳ゲートも Rule 5 も無変更で通る。CLI は `reportActionFailure()` 経由で `❌ <message>` 1 行 + exit 1 に落とす。
- **T1-7**: MCP `limit` クラムプ（最大 50、既定 20）がクエリなし直近一覧でも正常に適用されること。

### P2（`tests/media_search.test.ts` + `tests/presentation_symmetry.test.ts`）

- **T2-1**: `--offline` モードで実行した場合、モック fetch が 1 回も呼ばれずに `collectLocalMirrorIndex` 経由でローカルキャッシュ/YAML から結果が返ること。
- **T2-2**: `--offline` 指定なしで fetch が失敗した場合、勝手にローカル検索にフォールバックせず、ネットワークエラーで終了すること（Fail Fast 原則）。
- **T2-3**: オフライン検索結果の CLI 出力冒頭に `[SOURCE: LOCAL WORKSPACE ONLY (OFFLINE)]` が表示され、MCP レスポンスに `source: "local_mirrors"`, `remoteQueried: false` が含まれること（認識論的フレーム付け）。
- **T2-4**: オフライン検索でヒット 0 件の際、不在保護警告（「サーバーには存在する可能性がある」）が出力されること。

### P3（`tests/sync_limit_precedence.test.ts` + `tests/cli.test.ts`）

- **T3-1**: `.emit/config.json` に設定がない場合、`resolveMediaSyncLimit` が `100` を返すこと（既定値変更の検証）。
- **T3-2**: `.emit/config.json` に `"mediaSyncLimit": 250` がある場合、それが正しく優先されること。
- **T3-3**: CLI `emit pull-media` で `--limit` を渡した際、非推奨警告が表示されつつ動作すること（後方互換性）。
- **T3-4**: MCP `sync_pull` / `sync_pull_media` に `limit` 引数を渡した場合、既存どおり動作しエラーにならないこと（Ask First カテゴリ 3 回帰防止）。
- **T3-5**: 走査枠外を案内する文言すべて（`src/cli/commands/pull.ts:616`, `src/mcp/tools/sync-pull.ts:425`, `src/presentation/article_report.ts:45`, `src/sync/doctor.ts:1055-1058` の 4 箇所）から `(or a larger --limit)` が削除されていること。

### P4（`tests/media.test.ts` + `tests/pull_pruning.test.ts`）

- **T4-1**: 手元の記事本文（`posts/draft/*.md`, `posts/published/*.md`）が参照している画像は、走査枠外であってもプルーニングで削除されず保護されること（**本文参照保護ガードの正例**）。
- **T4-2**: フロントマターの `featuredImage: <ULID>` のみで参照されている画像も、プルーニングで削除されず保護されること（**featuredImage 保護の正例**）。
- **T4-3**: `posts/conflicts/*.md`（退避コピー）が参照している画像も、プルーニングから保護されること（**conflicts 保護の正例**）。逆に `.deleted.md`（削除バックアップ）は参照集合から除外されること。
- **T4-4**: ミラーバイナリが無く companion `.yaml` だけが残っている場合（`--metadata-only` の結果など）でも、companion の `id:` から参照保護を判定できること。本文 URL は storageKey、companion はレコード ULID という**二つの ID 空間を突き合わせて比較する**ため、比較キーの正規化（storageKey → markdownRef ステム ↔ companion id）を検証対象に含める。
- **T4-5**: `remoteIndex.complete === false`（バウンド付き走査で末尾未到達）の場合、未参照画像であってもプルーニングがスキップされること（**完全性ガードの正例・epistemic rule 遵守**）。
- **T4-6**: `remoteIndex.complete === true`（ライブラリ全走査完了）の場合、未参照かつリモート削除済みの画像がデフォルトで剪定されること（**デフォルトプルーニングの正例**）。
- **T4-7**: `--no-prune` を渡した場合、走査完了時であってもプルーニングが抑止されること（エスケープハッチの検証）。
- **T4-8**: `media/drafts/` 内のオフライン下書き画像、およびコンパニオン不在（`unattributable`）ファイルが引き続きプルーニングから保護されること（既存不変条件の回帰）。
- **T4-9**: デフォルト反転により影響を受ける既存テスト（`tests/media.test.ts:275`, `tests/pull_pruning.test.ts:169,380`）が、完全性ガードの元で意図どおりグリーンを維持すること。

### P5（`tests/layering.test.ts` + `tests/guards.test.ts`）

- **T5-1**: レイヤリングゲート（Axis 0〜5）が 100% パスすること。新規ヘルパーは `src/sync/media/prune_protect.ts`（Layer 2、`pull_library.ts` と同一ディレクトリ）に置き、同一ディレクトリ内 import のみで解決するため `tests/layering.test.ts:257-261` の `ALLOWED_LAYER_2_SIBLING_IMPORTS` スナップショットを**変更しない**。`sync/media/` → `sync/workspace/` 等の新しい sibling エッジを追加しないこと（追加するとゲートが落ちる）。
- **T5-2**: ローカル参照スキャンが Layer 0 の `scanArticleMediaReferences()`（`src/utils/media-body-refs.ts:213`）および `storageKeyToMarkdownRef()`（`src/utils/naming.ts:159`）経由で行われていること。frontmatter の `featuredImage` 抽出は Layer 2 の `collectArticleReferencedMediaIds()`（既に `utils/frontmatter.ts` を import している既存箇所）に委ね、`src/sync/media/` の他のモジュールがパーサ依存を広げないこと。
- **T5-3**: `GUARD_REGISTRY` / `OPERATIONAL_ERROR_CODES` / `PROTECTION_ERROR_CODES` に新エラーコードを追加しないこと（P4 はガードではなくプルーニング安全策、P1 の不正日付は `MEDIA_SEARCH_QUERY_REQUIRED` 再利用）。Rule 1〜5 の分類変更が不要であることを確認すること。

### 共通ゲート

- `tests/layering.test.ts` Axis 0〜5: 新規追加する日付ヘルパーは Layer 0、検索ロジックは Layer 2/0 の依存規律を厳守。
- `tests/guards.test.ts` Rule 1〜5: ガード台帳 G1〜G19 不変。
- `npm run check`（format / typecheck / check:cycles / test）100% green。

---

## 6. Ask First ポリシー対応表

| カテゴリ                                           | 該当有無               | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 新規 npm パッケージ                             | **不使用**             | 日付パース（`today`, `yesterday`, ISO）を含め、すべて Node.js 標準（`Date`）と既存コードのみで実装                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2. 永続化スキーマ / config キー                    | **該当あり（要確認）** | `cache.db` スキーマ変更はなし。`.emit/config.json` の**既存キー `mediaSyncLimit` の既定値を 300→100 に変更**する（`src/utils/config.ts:75` の `DEFAULT_CONFIG` 書き換えのみで、新キー・新カラムは追加しない。実測で `prune` / `noPrune` は config キーではなく純粋な CLI/MCP フラグであり、`src/utils/config.ts` に存在しない）。既定値の意味変更は Ask First カテゴリ 2 に該当するため実装前に施主の確認を得る（CHANGELOG に Changed として明記）                                                                                                                                                |
| 3. 公開 facade / オーケストレーター API 破壊的変更 | **該当なし**           | `pullBatch` / `pullSingleArticle` / `pushArticle` / `pushAll` のシグネチャ・戻り値形状は不変（`PullMediaOptions.prune` は既存フィールド、`PullMediaResult.pruneSkippedReason` は追加のみ）。MCP ツールの `limit` 引数も削除せず非推奨受容として維持し、`noPrune` / `since` / `until` / `offline` はすべて optional 追加のため、外部エージェント契約を一切壊さない                                                                                                                                                                                                                                 |
| 4. 権威仕様削除 / 核心原則改訂                     | **該当あり（要確認）** | 「Local-first 原則」「スライディングウィンドウ」「不在を断定しない（epistemic rule）」「手元作業資産の保護」はすべて強化・維持する。ただし以下 2 点は既存権威記述の改訂を伴うため施主の確認を得る: (a) **プルーニングの opt-in→opt-out 反転**は `AGENTS.md` §7 の不変条件説明および README の `--prune` 記述（L1040 等）の書き換えを要する、(b) **P1 のクエリ任意化**は v0.1.16 由来の「空クエリ拒否」境界（AGENTS.md L239 の media search epistemic rule 記述を含む）を発展的に改訂する。いずれも削除ではなく安全性を強めた上での拡張であり、epistemic rule 自体は完全性ガードでさらに強化される |

---

## 7. スコープ外・見送り事項

- **自然言語による高度な相対日付（"last week", "3 days ago" 等）**: パースが複雑化し誤判定を招くため、本版では `today`, `yesterday`, および ISO 日付（`YYYY-MM-DD`）のみに絞る。
- **孤立メディアの自動一括削除コマンド（`emit media prune` 等）**: 未参照メディアの削除権限と判断は人間および `emit doctor` の診断領域に留め、本版では自動一括削除コマンドは新設しない。
- **メディアのあいまい検索（Fuzzy search）**: 誤判定による誤った storageKey 解決を防ぐため、リテラル部分一致の原則を維持する。

---

## 8. 完了条件（DoD）

- [ ] **Ask First 承認**: カテゴリ 2（`mediaSyncLimit` 既定値 300→100）およびカテゴリ 4（プルーニング既定反転 / 空クエリ境界の発展的改訂）について施主の明示的な承認を得ている（§6）
- [ ] `emit media-search`（CLI 引数を `[query]` の optional へ変更）および MCP `sync_media_search` でクエリなしの直近一覧表示ができる（P1/T1-1）
- [ ] 旧 T1-8 テストおよび README / AGENTS.md の「空クエリ拒否」記述が「直近一覧ブラウズ」仕様へ発展的に整合更新されている（P1/T1-1）
- [ ] `--since` / `--until` による日付範囲指定ができ、指定日より古いレコードで walk が早期打ち切りされ、`walkComplete: true` と判定される（P1/T1-2〜T1-4）
- [ ] 不正日付が新規エラーコードを新設せず `MEDIA_SEARCH_QUERY_REQUIRED` で拒否され、ガード台帳ゲートが無変更でパスする（P1/T1-6）
- [ ] `--offline` でネットワーク通信を一切行わずに `collectLocalMirrorIndex` 経由でローカル資産を検索できる（P2/T2-1）
- [ ] オフライン検索時に暗黙フォールバックが行われず、出力冒頭でのローカル宣言と 0 件時の不在保護警告が出る（P2/T2-2〜T2-4）
- [ ] `DEFAULT_CONFIG.mediaSyncLimit` が 100 に変更され、設定ファイルでのオーバーライドが正常に動作する（P3/T3-1, T3-2）
- [ ] CLI `emit pull-media` の `--limit` および MCP ツールの引数が非推奨受容として後方互換を維持している（P3/T3-3, T3-4）
- [ ] 走査枠外を案内する 4 箇所すべての stale な `--limit` 案内文が config キー参照に修正されている（P3/T3-5）
- [ ] 手元の記事本文、`featuredImage`、および `<collection>/conflicts/` から参照されている画像が、走査枠外であってもプルーニングから 100% 保護される（P4/T4-1〜T4-4）
- [ ] `remoteIndex.complete === false` の場合、プルーニングが安全にスキップされ誤消去が起きない（完全性ガード・epistemic rule 遵守）。スキップ情報は Layer 2 では出力せず `pruneSkippedReason` で返し、CLI/MCP 共通文言で表示する（P4/T4-5）
- [ ] `remoteIndex.complete === true` の場合、未参照かつリモート削除済みの画像がデフォルトで剪定される（P4/T4-6）
- [ ] `--no-prune` / MCP `noPrune` を渡すことでプルーニングを抑止できる。`--article` / `--storage-key` 経路は従来どおり prune しない（P4/T4-7）
- [ ] `media/drafts/`、コンパニオン不在ファイル、`legacy_*` 残骸が保護され続ける（所有権判定は companion YAML のみ）（P4/T4-8）
- [ ] レイヤリングゲート（Axis 0〜5）とガード台帳ゲート（Rule 1〜5）がスナップショット変更不要でパスする（P5/T5-1〜T5-3）
- [ ] `tests/layering.test.ts`、`tests/guards.test.ts` がパスし、`npm run check` が 100% green
