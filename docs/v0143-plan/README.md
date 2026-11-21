# v0.1.43 計画書: 過去記事（Posts）の多次元検索基盤（メタ属性・日付範囲・オフライン）とピンポイント取得連携

- **対象バージョン**: `v0.1.43`
- **作成日**: 2026-11-21
- **最終改訂**: 2026-11-21（Phase 0: M1〜M5 の live instance 実測完了。サーバー側 FTS 正常稼働、trigram 3 文字制約なし、リスト API の createdAt 降順・日付プロパティ完備を確認し設計確定）
- **ステータス**: **実装着手可（Approved）** — Phase 0 実測ゲート通過済み。
- **起点**:
  1. v0.1.42 にてメディア検索（`emit media-search` / `sync_media_search`）が拡充され、日付範囲検索・直近ブラウズ・オフライン検索・認識論的保護（不在保護）が確立された。
  2. 一方で、記事（Posts）側の検索機能は `emit status --search <term>` のみであり、これは**ローカルの SQLite キャッシュ / ワークスペースに存在する記事しか対象としない**。
  3. Emit は大容量ブログを軽量に扱うためスライディングウィンドウ方式（既定 30 件: `postsSyncLimit`）を採用しているが、この仕様により**ウィンドウ外（過去記事）がローカルから不可視**になっている。
  4. 過去記事を編集したい場合、本来は `emit pull <id>`（または MCP `sync_pull(id: "...")`）によるピンポイント取得が設計されているが、**「その ID を調べる手段」が Emit 内に存在しない**ため、AI エージェントやユーザーは `emit pull --all` で全件同期するか、Web 管理画面等で ID を手動カンニングするしかない。
  5. また、記事はメディアと比較してメタ属性（カテゴリー、タグ、ステータス、スラッグ、複数日付、著者）が極めて豊富であり、単なるフリーワード検索だけでなくこれらメタ属性を直交して絞り込める検索基盤が必須である。
- **目的**:
  1. **P1: リモート記事検索 CLI / MCP（`emit article-search` / `sync_article_search`）** — キーワード検索、クエリ任意化による直近記事一覧ブラウズ、および主要メタ属性（タグ・カテゴリー・ステータス・スラッグ）による直交絞り込みを導入。**EmDash のサーバー側 FTS を本命経路**とし、使えない場合のみクライアントサイド走査へフォールバックする二段構え（§3.0, §3.1）。
  2. **P2: 日付範囲絞り込み（`--since` / `--until`）と日付基準（`--date-field`）** — Layer 0 の `search-date.ts` を再利用し、**Phase 0 実測で降順が確認できた場合に限る**早期打ち切り（Early-exit）と完全走査判定を実装。さらに公開日（`publishedAt`）・起草日（`createdAt`）・更新日（`updatedAt`）を選択可能な日付基準を導入。
  3. **P3: ローカル同期状況（Local vs Remote Only）の可視化とピンポイント取得連携** — 検索結果各行に `[local: posts/...]` または `[remote only]` を表示し、未取得記事に対して `emit pull <id>` / `sync_pull(id: "...")` への直結アクションガイダンスを出力。
  4. **P4: 完全オフライン記事検索（`--offline`）と認識論的保護（Epistemic Framing）** — ネットワーク通信を一切遮断し、**ワークスペース上の Markdown ファイル（frontmatter + 本文）** から高速検索。SQLite キャッシュは ULID・パスの整合確認にのみ使用（本文はキャッシュに存在しない）。出力冒頭の `[SOURCE: LOCAL WORKSPACE ONLY]` 宣言と、0 件ヒット時の不在保護警告を徹底。
  5. **P5: アーキテクチャ階層（Layer 0〜3）の厳格順守とテスト拡充** — 検索ロジックを Layer 1 / Layer 2 に配置し、CLI/MCP 間の表示・文言を統一。`sync/article_search` を layering gate の走査対象へ登録し、追加エラーコードを registry に分類した上で包括的テストマトリクスを整備。

---

## 1. 課題認識とアプローチの要約

| #   | 課題                                           | 現状の実測事実                                                                                                                         | 判定                                         | 本版でのアプローチ                                                                                    |
| --- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | ウィンドウ外の過去記事が検索できない           | `emit status --search` はローカル `entries` テーブルのみを走査するため、既定 30 件のスライディングウィンドウ外の記事は一切ヒットしない | 妥当。重大な機能欠落（メディアとの非対称性） | **P1 として採用**。リモート走査型検索 `emit article-search` / `sync_article_search` を新設            |
| 2   | ピンポイント `pull` のための ID 特定手段がない | `emit pull <id>` の単一取得機能はあるが、ID 自体を探す手段がなく、実質的に全件 pull を強要される                                       | 妥当。エージェントの自律ワークフローを阻害   | **P1 & P3 として採用**。検索結果に ULID・スラッグを明示し、`emit pull <id>` への誘導を出力            |
| 3   | 記事特有のリッチなメタ属性で絞り込めない       | メディアと異なり、記事はカテゴリー・タグ・ステータス・スラッグ・複数の日付を持つが、検索手段がない                                     | 妥当。ブログ運用の基本要件                   | **P1 & P2 として採用**。`--tag`, `--category`, `--status`, `--slug`, `--date-field` をサポート        |
| 4   | 機内等の完全オフライン環境で過去記事を探せない | ローカルに存在する記事であっても、`emit status` の簡易表示しかなく、本文やメタ属性の柔軟な検索ができない                               | 妥当。メディアの `--offline` と同等のニーズ  | **P4 として採用**。ワークスペースの Markdown（frontmatter + 本文）を走査する `--offline` モードを新設 |
| 5   | オフライン検索による「不在誤認」の危険         | ローカル検索でヒットしなかった場合、エージェントが「その記事は存在しない」と誤認して新規作成（重複）するリスク                         | 妥当。AGENTS.md の Epistemic Rule に直結     | **P4 にて保護確立**。`[SOURCE: LOCAL WORKSPACE ONLY]` 宣言と 0 件時の不在保護警告を実装               |

---

## 2. 現状の実測スナップショット（v0.1.42 コード + Phase 0 live 実測）

コード由来の値は実際のソースに基づく計測結果、`【実測済】` と明記した値は 2026-11-21 の Phase 0 live 実測によるものであり、推定を含まない。

### 2.1 実測値一覧

| 項目                               | 実測値                                                                                                                                                                                                                                                                                                                         | 検査コード / コマンド                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 現行の記事検索 CLI                 | `emit status -s, --search <term>`（title, slug, ID, filePath でローカル配列を filter）。加えて `--slug` / `--status` / `--sync-status` フィルタが**既に存在**するため、「検索手段が皆無」ではない点に注意。本版の新規性は **リモート走査** と **メタ属性（タグ・カテゴリー・日付）の直交絞り込み**、および **本文検索** にある | `src/cli/commands/status.ts:104-107, 119-121`                            |
| 現行の記事検索 MCP                 | **存在しない**（`sync_status` に `search` / `slugFilter` / `status` / `syncStatus` フィルタがあるのみでリモート検索ツールなし）                                                                                                                                                                                                | `src/mcp/tools/sync-status.ts:47-58`                                     |
| 記事同期リミット既定値             | `postsSyncLimit: 30`（draft 30 + published 30）                                                                                                                                                                                                                                                                                | `src/utils/config.ts:74`                                                 |
| EmDash 記事リスト API              | `GET /_emdash/api/content/{collection}`。**Emit が送信するクエリは `status` / `limit` / `cursor` の 3 のみ**（`orderBy`・`sort` は一切送っていない）                                                                                                                                                                           | `src/sync/pull/list.ts:107-110, 129`                                     |
| **記事リストのソート順**           | **【実測済】`createdAt` 降順（新着順）**。EmDash 仕様で `orderBy: 'createdAt' (default)`, `order: 'desc' (default)` と定義。実機レスポンスも `2026-11-20 -> 11-19 -> 11-19 -> 11-13 -> 11-12` と完全な降順であることを確認。                                                                                                   | Phase 0 実測 M4、`emdash` MCP `content_list` スキーマ・実レスポンス      |
| **リストアイテムの日付フィールド** | **【実測済】トップレベルに `createdAt`, `updatedAt`, `publishedAt`（ISO 文字列）が完備**。よってリスト走査時の日付判定に追加 GET は**不要（0-GET 走査可能）**。ただし `RemoteArticleItem` 型には未マッピングのため、`rawItem` からのパースが必要                                                                               | Phase 0 実測 M5、`src/sync/pull/types.ts:136-143`                        |
| **リストアイテムの taxonomy**      | **【実測済】リストレスポンスにカテゴリー・タグは含まれない**。リモートの taxonomy 取得は記事ごとに `GET /content/{collection}/{id}/taxonomies/{taxonomy}` を **category / tag で 1 回ずつ（= 2 GET）**発行する                                                                                                                 | Phase 0 実測 M3、`src/sync/terms.ts:46, 99-100`                          |
| EmDash 記事 API 1ページ上限        | openapi.json より動的取得（フォールバック既定 100 件）                                                                                                                                                                                                                                                                         | `src/sync/pull/list.ts:50-84`                                            |
| **EmDash サーバー側検索 API**      | **【実測済】`GET /_emdash/api/search` は正常稼働中**（スコア・タイトル・スニペット付きでヒット返却）。日本語 1〜2 文字（「日」「日記」）でも正常にマッチし、**trigram 3 文字制約は存在しない**。ただしレスポンスに taxonomy や日付は含まない（`id, slug, title, snippet, score` 等のみ）                                       | Phase 0 実測 M1〜M3、`emdash` MCP `search` 実測                          |
| 日付パースヘルパー                 | `parseSearchDateBoundary(raw)` が Layer 0 に配備済み（`today`, `yesterday`, `YYYY-MM-DD`）。ただし **`DAY_MS` は Layer 0 には存在せず** `media/remote_index.ts:31` に独自定義されている                                                                                                                                        | `src/utils/search-date.ts:34`、`src/sync/media/remote_index.ts:31, 237`  |
| メディア検索の先行実装             | `searchRemoteMedia`（Layer 2 `remote_index.ts`）、`searchLocalMirrorMedia`（`types.ts`）。認識論的フィールドは `scannedCount` / `walkComplete` / `totalCount` / `truncated` / `normalizedQuery`                                                                                                                                | `src/sync/media/remote_index.ts:208-`、`src/sync/media/types.ts:281-293` |
| オフライン検索に使えるキャッシュ列 | `entries` テーブルは `title, slug, status, published_at, raw_json` を持つが **本文 Markdown は含まない**。本文は `base_snapshots.body_markdown` にあるが、これは同期ベースラインでありディスク上の現在内容ではなく、untracked 記事には存在しない                                                                               | `src/db/schema.sql`、`src/db/cache.ts:162`（`getEntry(id)`）             |

---

## 3. 詳細設計仕様

### 3.0 Phase 0: API 能力の実測確定（実測完了）

2026-11-21 に live instance (`https://aroooy.net`) を対象に実測を実施し、すべての設計前提を確定した。

| #   | 実測項目                                                                  | 方法                                                           | 実測結果と確定した設計帰結                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | `GET /_emdash/api/search` が有効か（posts collection で search が on か） | 認証付き GET、既知タイトルで `q` を実行                        | **【有効】** 200 OK、スコア・タイトル・スニペット付きで返却。→ **サーバー側検索を本命経路（Primary）に採用決定**                                                                                                                                                                                                                                                  |
| M2  | search の日本語挙動（trigram 制約）                                       | 1 文字 / 2 文字 / 3 文字の日本語クエリで比較                   | **【短クエリでもヒット】** 1 文字「日」（20件）、2 文字「日記」（5件）でも正常ヒット。**ただし公式ドキュメントは trigram トークナイザについて「Queries shorter than three Unicode characters return no matches」と明記しており、本実測結果と矛盾する**（→ §3.0.1 の再検証 M6 を追加）。当面は「短クエリは FTS で 0 件になり得る」前提で scan フォールバックを残す |
| M3  | search が `taxonomy`（tag/category）や日付範囲を返すか                    | レスポンススキーマ確認                                         | **【返さない】** `id, slug, title, snippet, score` のみ。→ taxonomy/日付フィルタ指定時はクライアント側走査（Scan 経路）と連携                                                                                                                                                                                                                                     |
| M4  | `GET /_emdash/api/content/{collection}` の既定ソート順                    | openapi.json のパラメータ一覧 + 実レスポンスの `id` / 日付列挙 | **【`createdAt` 降順（DESC）】** 実レスポンスの日付降順を確認。→ **P2 の早期打ち切り（Early-exit）の実装を確定**                                                                                                                                                                                                                                                  |
| M5  | リスト API が `publishedAt` / `createdAt` / `updatedAt` を返すか          | 実レスポンスのキー列挙                                         | **【含む】** 各アイテムのトップレベルに全日付プロパティあり。→ **日付走査の追加 GET は不要（0-GET 走査可能）**                                                                                                                                                                                                                                                    |

**確定した検索アーキテクチャ**:

- **キーワードのみ検索**: サーバー側 FTS（`searchMode: 'fts'`）を優先使用し、爆速レスポンスを実現。
- **新着ブラウズ（クエリなし）**: リスト API を新着順（降順）で走査（`searchMode: 'scan'`）。
- **taxonomy フィルタ指定時**: クライアント側走査へ切り替え、該当記事のみ追加 GET（記事あたり 2 GET）で terms を検証。HTTP 爆発を防ぐため `maxScan` 既定を 50 に抑制。
- **日付範囲フィルタ指定時**: リスト API に日付が含まれるため、追加 GET なし（0-GET）でクライアント走査判定。`dateField: 'createdAt'`（既定）なら `--since` 到達で早期打ち切り。

### 3.0.1 Phase 0 で未確定だった項目（実測により全件解消・設計確定）

Phase 0（M1〜M5）の初回実測後に残っていた課題（M6〜M9）について、live instance（`https://aroooy.net`）に対する認証付き OpenAPI レスポンスおよび REST クエリの再実測を実施し、すべての疑義を解消した。

| #   | 項目                                                     | 実測結果                                                                                                                                                                                                                                                                             | 確定した設計帰結                                                                                                                                                                                       |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M6  | **search の tokenizer と短クエリ挙動**                  | **【公式ドキュメント通りの制約を実証】** `q=カワ`（2文字）で検索したところ、タイトルに「カワセミ」を含む記事（`01M77VFT...`）が **FTS ではヒットしなかった**。一方で `q=カワセ`（3文字）および `q=カワセミ`（4文字）では確実にヒット。単独文字「日」がヒットしたのは境界文字で区切られていた特殊ケース。 | **短クエリ（Unicode 3 文字未満）における scan 経路へのフォールバックを必須化**。FTS が 0 件を返した場合でも、クエリが 3 文字未満なら scan へフォールバックさせて不在誤認を防止する。                 |
| M7  | **`GET /_emdash/api/search` の OpenAPI 掲載状況**        | **【OpenAPI に正式掲載を確認】** `GET /_emdash/api/openapi.json`（認証付き）の `paths` に **`/_emdash/api/search` が明記**されていることを確認（パラメータ: `q`, `collections`, `status`, `locale`, `limit` (max 100), `cursor`, `scope`）。                                    | **REST 検索は EmDash の公式サポート契約であると確定**。外部クライアント向け非公式ルートの懸念は解消されたため、FTS を本命経路とする方針は契約上も完全に安全。                                       |
| M8  | **search のページネーション上限と `totalCount`**         | **【`limit` 上限 100、`totalCount` なし】** OpenAPI 定義で `limit: maximum: 100`。レスポンスは `data: { items: [...], nextCursor?: string }` であり、`totalCount` プロパティは存在しない。                                                                                       | FTS 経路の `walkComplete` は `!res.data.nextCursor` で判定。`totalCount` は `null` として扱い、`scannedCount` は返却アイテム数とする。                                                               |
| M9  | **search レスポンスのラップ構造と日付・status フィルタ** | **【標準エンベロープ】** `{ success: true, data: { items: [...], nextCursor?: string } }` であり、Emit の `unwrapEnvelope()` に完全合致。`status` は search クエリで指定可能だが、日付範囲パラメータ（`since`/`until`）は存在しない。                                         | §3.1 の「単一の決定ルール」をそのまま維持。`since`/`until` 指定時および taxonomy 指定時は scan 経路に確定させ、`query` のみ（または `query` + `status`）の場合に FTS 経路を使用する。 |

**確定した設計上の取り決め**:

- **短クエリ時の安全策**: クエリ文字数が 3 文字未満（Unicode length < 3）の場合、または FTS が 0 件かつ短クエリの場合は、scan 経路（クライアント側走査）へフォールバックしてローカル・リモートの完全性を担保する。
- **FTS スコアと recency**: FTS 経路ではサーバー側の `score` 順を尊重し、クライアント側での並べ替えは行わない。新着順（`createdAt` DESC）を確実に得たい場合は、クエリなしブラウズまたは scan 経路を用いる。
- **決定ルールの不変**: offline > tag/category (scan) > since/until (scan) > query のみ (FTS) > 条件なし (scan) の優先順序を厳格に適用。

---

### 3.1 P1: リモート記事検索（`emit article-search` / `sync_article_search`）

#### 検索経路の選択（単一の決定ルール）

**判定順序（上位から順に評価し、最初に応じた経路へ確定する。以後フォールバックしない）**:

1. **`offline: true`** → ローカル Markdown 走査（§3.4）。ネットワーク通信はゼロ。
2. **`tag` / `category` 指定あり** → **scan 経路**（`searchMode: 'scan'`）。FTS は taxonomy を返さないため（M3）、taxonomy 条件を FTS と組み合わせることはできない。`maxScan` 既定 50。
3. **`since` / `until` 指定あり** → **scan 経路**。search に日付パラメータが存在しないため（§3.0.1 M9）、FTS では範囲絞り込みができない。`createdAt` 基準なら早期打ち切りが有効（§3.2-4）。
4. **`query` のみ指定** → **FTS 経路**（`searchMode: 'fts'`）。
5. **条件なし** → **scan 経路**（新着ブラウズ、`createdAt` 降順）。

**フォールバック**: FTS が HTTP エラー（404 / 5xx / 未掲載）を返した場合のみ scan へ落ちる。その場合 `searchMode: 'scan'` と `fallbackReason` を必ず出力し、「サーバーが検索できた」と誤認させない。**FTS が 0 件を返した場合はフォールバックしない**（0 件は正当な結果であり、無宣言で再走査するとコストと結果の両方が読めなくなる）。ただし M6 の短クエリ問題が確認された場合のみ、`query` 長が短いときに scan を併走させる例外を許す。

- **FTS**: `GET /_emdash/api/search?q=...&collections={collection}&status=...&limit=...&cursor=...`
  - メディア検索に存在しなかった「サーバー側絞り込み」であり、`maxScan` 走査コストと認識論的限界の両方を根本的に削減する。
  - エンドポイント URL ヘルパー `searchEndpoint(origin)` を `src/client/endpoints.ts`（Layer 0）に新設する（現行コードには `openApiEndpoint()` はあるが該当ヘルパーがない）。
- **scan**: `listRemoteArticles()` 相当の cursor ページネーションで `maxScan` まで読み、Layer 1 の純フィルタで絞り込む。

#### HTTP コスト宣言（重要）

- **キーワードのみ（FTS 経路）**: `GET /_emdash/api/search` **1 本**。メディア検索より 1 桁軽い。ただし FTS ヒットに日付や taxonomy が含まれないため、それらを要求した場合は scan 経路へ切り替わる（§3.1 の決定ルール）。
- **新着ブラウズ（scan 経路）**: list 1 本 for `maxScan` 件（メディア検索と同桁）。
- **`--tag` / `--category` 指定時**: リストアイテムに taxonomy が乗らないため、リモート実態に基づく絞り込みは **記事あたり 2 GET**（category + tag）を要求する。`maxScan: 300` をそのまま適用すると **最大 600 GET** になり、メディア検索と桁が異なる。したがって:
  - taxonomy フィルタ指定時は scan 経路に確定し、**`maxScan` 既定値を 50 に引き下げる**（明示指定は可能）。FTS は taxonomy を返さないため優先経路にはならない。
  - **追加 GET は「候補として上位まで読んだ記事」に対してのみ発行する**。list を先に `maxScan` 件集めてから順に検証し、`limit` に到達した時点で残りの検証を打ち切る（`taxonomyFetchCount ≤ limit × 2` に有界）。
  - 追加 GET を発行した件数を `taxonomyFetchCount` として結果に含め、CLI/MCP で表示する。
  - taxonomy 取得には **Layer 1 の既存 `fetchAssignedTerms()`（`src/sync/terms.ts:46`）を再利用**する。新規実装はしない。**ただしこの関数は `(options) => Promise<string[] | null>` の形であり、`pull/index.ts:117` が薄いクロージャで包んで使っているのが既存パターン**。検索側も同様にクロージャを注入する形を採る（Axis 1 は Layer 2 → Layer 1 を禁止していないため利用可）。レイヤリングテストの sibling / allowlist 記述にこの依存を登録する。
- **`--since` / `--until` 指定時**: **M5 で日付が list に含まれることが確認済みのため、追加 GET なし（0-GET）で判定できる**。`maxScan` は taxonomy 時のような引き下げは不要（キーワードなしの新着ブラウズと同じ 300 据え置き可）。

#### CLI 仕様

```bash
emit article-search [query] [options]
```

**引数・オプション**:

- `[query]`: 検索キーワード（任意）。FTS 経路ではサーバー側 FTS、走査フォールバック時はタイトル・スラッグ・抜粋（excerpt）の部分一致（大文字小文字不問）。省略時は新着一覧ブラウズ。
- `-t, --tag <slug>`: 指定タグを持つ記事に限定。
- `-c, --category <slug>`: 指定カテゴリーを持つ記事に限定。
- `--status <draft|published>`: 公開ステータスで限定（省略時は両方）。
- `--slug <slug>`: スラッグ完全一致または前方一致で限定。
- `-l, --limit <n>`: 表示件数上限（既定: 20、最大: 50）。
- `--max-scan <n>`: **scan 経路にのみ意味を持つ**走査上限。既定は **新着ブラウズ / 日付フィルタ時 300**、**taxonomy フィルタ指定時 50**（§3.1 の HTTP コスト宣言参照）。`0` = 全件走査（明示要求時のみ）。FTS 経路で指定された場合は無視し、出力に `maxScan is scan-only; ignored for FTS path.` を添える。
- `-p, --profile <name>`: 接続プロファイル指定。

#### MCP ツール仕様 (`sync_article_search`)

- `query?: z.string().optional()`: 検索キーワード（省略時は新着ブラウズ）。
- `tag?: z.string().optional()`: タグスラッグ。
- `category?: z.string().optional()`: カテゴリースラッグ。
- `status?: z.enum(['draft', 'published']).optional()`: 公開ステータス。
- `slug?: z.string().optional()`: スラッグ。
- `since?: z.string().optional()`: 日付範囲開始（`today`, `yesterday`, `YYYY-MM-DD`）。
- `until?: z.string().optional()`: 日付範囲終了（`today`, `yesterday`, `YYYY-MM-DD`）。
- `dateField?: z.enum(['publishedAt', 'updatedAt', 'createdAt']).optional()`: 比較対象の日付フィールド。
- `offline?: z.boolean().optional()`: ローカルのみ検索。
- `limit?: z.number().optional()`: 最大返却件数（既定: 20、最大: 50）。
- `maxScan?: z.number().optional()`: 走査上限（既定は §3.1 の HTTP コスト宣言に従い、taxonomy・日付フィルタ指定時は 50、`0` = 全件走査）。
- `profile?: z.string().optional()`: プロファイル名。

#### 認識論的フィールド（メディア検索との対称）

結果オブジェクトには必ず以下を含め、Layer 3 がそのまま出力する:

- `searchMode: 'fts' | 'scan'` — どの経路で得た結果かを宣言させる。
- `scannedCount` / `walkComplete` / `totalCount` / `truncated` / `normalizedQuery` — メディア検索（`src/sync/media/types.ts:281-293`）と同一の趣旨。
- `taxonomyFetchCount` — taxonomy 検証のために発行した追加 GET の件数。
- `walkComplete === false` のとき、**不在は断定しない**。CLI は `[WALK_INCOMPLETE] read <n> article(s) and stopped at --max-scan; absence is not proven.` を、MCP は同旨の `note` を出力する（既存のメディア実装 `src/cli/commands/media.ts:152` / `src/mcp/tools/sync-media-search.ts:108` と文言を揃える）。

---

### 3.2 P2: 日付範囲絞り込みと日付基準（Date Boundary & Field Selection）

1. **日付境界パースの再利用**:
   - `src/utils/search-date.ts` の `parseSearchDateBoundary()`（Layer 0）を使用。
   - `since` と `until` を独立パースし、同一日指定（same-day boundary: 当日 0:00 〜 翌日 0:00）を完全に保証。
   - **`DAY_MS` は Layer 0 に昇格させる**: 現状 `src/sync/media/remote_index.ts:31` に独自定義されており、記事側に同じ値を再定義すると二重定義になる。`search-date.ts` へ移設し、**メディア側も差し替える**（対称性）。これは既存コードの変更だが挙動不変であり Ask First 対象外。
2. **日付ソースの解決（必須）**:
   - `RemoteArticleItem` 型には日付フィールドが未マッピングだが、**list レスポンスのトップレベルに `createdAt` / `updatedAt` / `publishedAt` が揃っていることは M5 で確認済み**。よって `rawItem` から読むヘルパーを Layer 1 に新設すれば足り、**追加 GET は不要**。
   - ヘルパーは不正値・欠損に対して `null` を返し、例外を投げない（T2-5）。
3. **日付基準フィールド（`dateField`）の解決ルール**:
   - 明示指定がない場合の既定値:
     - `status === 'published'`: `publishedAt` を優先、未設定時は `createdAt`。
     - `status === 'draft'`: `createdAt` を優先、未設定時は `updatedAt`。
     - 混在時: 各記事のステータスに応じた上記の判定を適用。
   - 明示指定時: 指定されたフィールド（`publishedAt` / `updatedAt` / `createdAt`）の ISO タイムスタンプを使用（未設定の記事は範囲外としてスキップ）。
4. **降順走査と早期打ち切り（Early-exit）— 実装確定、ただし条件付き**:
   - **M4 でリスト API の既定が `createdAt` 降順（DESC）であることが仕様・実レスポンスの両面で確認済み**。よって早期打ち切りの実装を確定する。
   - **打ち切りが有効なのは `dateField === 'createdAt'` のときのみ**。`publishedAt` / `updatedAt` を比較対象にした場合、リストは `createdAt` 順で並んでいるため「以降がすべて範囲外」を保証できず、打ち切ると**該当記事を漏らす**（＝不在の誤認）。この不一致時は常に全走査し、`walkComplete` を正直に報告する。
   - 打ち切り成立時は `since` 境界より古いレコードへ到達した時点で walk を即時中断し、`walkComplete: true`（指定範囲内の全走査が完了した正当な完了）として `[WALK_INCOMPLETE]` 警告を出さない。
   - **status 未指定時の注意**: Emit は draft と published を**並列取得して連結**する（`pull/list.ts:206-211`）。各系列はそれぞれ `createdAt` 降順だが、連結結果は降順ではない。早期打ち切りは**系列ごとに独立して評価**し、連結後に再整列して `--until` 境界で切る。連結列に対して単一の打ち切り位置を使ってはならない。
   - **明示的に `orderBy` / `order` を送らないこと**: 既定が降順である以上、パラメータを追加すると将来のサーバー側既定変更時に挙動が発散する。既存の送信クエリ（`status` / `limit` / `cursor`）を変えない。

---

### 3.3 P3: 同期状況（Local vs Remote Only）の可視化とアクション誘導

1. **ローカル照合判定**:
   - 取得したリモート記事の `id`（ULID）をローカル SQLite キャッシュ（`cache.getEntry(id)` — 実在シンボルはこれ。`getArticleEntryById` は存在しない）およびワークスペースファイル（`findLocalFilesByUlid(root, collection, id)`、`src/sync/workspace/index.ts:56`）と照合。
   - ヒット項目に以下のフラグを付与:
     - `isLocal: true` / `localPath: 'posts/published/20261115_...md'`
     - `isLocal: false`（手元に存在しない）
2. **プレゼンテーション表示（CLI / MCP）**:
   - 手元にある記事: `[local: posts/published/...]` と緑色アイコンで表示。
   - 手元にない記事: `[remote only]` と表示し、末尾に次の一手を明示:
     ```text
     --> To edit or pull locally: emit pull <id>
     ```
   - MCP のレスポンスにも `suggestion: "Call sync_pull with id '...' to pull into workspace"` を含め、エージェントが次のツール呼び出しを即座に判断可能にする。

---

### 3.4 P4: 完全オフライン記事検索（`--offline`）と認識論的保護

1. **走査対象**:
   - ネットワーク fetch を一切行わない。
   - `posts/draft/`、`posts/published/` 配下の全 `.md` ファイル（frontmatter + 本文）を走査。**本文検索が成立するのはこのディスク走査のみ**であり、SQLite キャッシュには本文が存在しない（§2.1）。
   - **`posts/conflicts/` は既定で除外する**。AGENTS.md は conflicts を「read-only rescue copies / never articles」と規定し、`getWorkspaceStatus` も `CONFLICTS_SUBDIR` を別カウントしている。quarantine copy が本文付きで検索結果に混在すると、エージェントが canonical 記事と誤認して編集する危険がある。必要なら明示フラグ `--include-conflicts` を設け、**その場合も該当行に `[quarantined — never push]` を必須表示**し、canonical 結果と同じ一覧に混ぜず別セクションに分離する。
   - SQLite キャッシュ（`entries`）は **ULID・パスの整合確認と `isLocal` 判定のためだけに**照合する。「キャッシュから本文検索できる」という表現は使わない。
2. **既存 `emit status --search` / `sync_status --search` との役割分担（README・AGENTS.md に明記必須）**:
   - `status --search`: **ローカル同期済み記事のステータスビュー**（title/slug/ID/path のメタ照合のみ、フィルタは `--slug` / `--status` / `--sync-status`）。
   - `article-search --offline`: **本文を含む全文検索**。
   - この分担を定義しない限り、エージェントがどちらを呼ぶべきか判断できない。MCP サーバー説明文（`src/mcp/server.ts` のツール一覧）も併せて更新する。
3. **認識論的保護（Epistemic Framing）**:
   - CLI 出力冒頭および MCP レスポンスの 1 行目に以下を必ず出力:
     ```text
     [SOURCE: LOCAL WORKSPACE ONLY (OFFLINE)]
     ```
   - 0 件ヒット時、不在保護警告を出力:
     ```text
     ℹ️ No matching articles found in local workspace.
        This does NOT prove the article does not exist on remote.
        Run without --offline to search the remote library.
     ```

---

## 4. アーキテクチャ配置とレイヤリング制約（Axis 0〜5）

`tests/layering.test.ts` に準拠し、以下のレイヤリングを厳格に保持する：

- **Layer 0 (`src/utils/search-date.ts`)**:
  - `parseSearchDateBoundary` は既存。`DAY_MS` は現在 `src/sync/media/remote_index.ts:31` に私的定義されているため、**Layer 0 へ昇格**させメディア側も差し替える（§3.2-1）。
- **Layer 0 (`src/client/endpoints.ts`)**:
  - サーバー側検索 `searchEndpoint(origin)` を新設する（現行コードに該当ヘルパーなし。URL 組み立ては必ずこの層に集約する）。
- **Layer 1 (`src/sync/article_search/query.ts`)**:
  - 純粋なメモリ内フィルタ関数（キーワード、タグ、カテゴリー、ステータス、日付の判定ロジック）。副作用なし、I/O なし。
  - `rawItem` から `publishedAt` / `createdAt` / `updatedAt` を読み出すヘルパーもここ（§3.2-2）。
- **Layer 2 (`src/sync/article_search/index.ts`)**:
  - リモート検索 `searchRemoteArticles()`（FTS 優先・走査フォールバック）およびローカルオフライン検索 `searchLocalArticles()` を配置。
  - `tests/layering.test.ts` の Layer 2 公開シンボル allowlist に `searchRemoteArticles` / `searchLocalArticles` を登録。
  - **`LAYER_2_MODULE_NAMES` に `article_search` を追加**し、併せて `layer2Dirs`（現在 `sync`, `sync/pull`, `sync/push`, `sync/media`, `sync/workspace` のみ）に `path.join(SRC_ROOT, 'sync', 'article_search')` を登録する。**これをしないと新ディレクトリが gate の走査対象から外れ、sibling 結合違反が素通りする。**
  - taxonomy 検証で Layer 1 の `fetchAssignedTerms()`（`src/sync/terms.ts`）へ依存する。Layer 2 → Layer 1 は許可されているため新規の例外登録は不要だが、**Layer 1 が Layer 2 を import していないこと（Axis 1）** は維持される。
- **Layer 3 (`src/presentation/article_report.ts`, `src/cli/commands/article-search.ts`, `src/mcp/tools/sync-article-search.ts`)**:
  - 出力フォーマッタ `formatArticleSearchHeader()`, `formatArticleSearchHit()` を集約。
  - CLI コマンドおよび MCP ツールを実装。CLI は失敗を `reportActionFailure()`（`src/cli/report-failure.ts`）で必ず `❌ <message>` + exit 1 に変換する。
- **エラーコードの registry 分類（Rule 2）**:
  - 検索系の新エラーコード（例: `ARTICLE_SEARCH_FAILED`, `DATE_BOUNDARY_INVALID`）を起こす場合、`src/sync/guards.ts` の `OPERATIONAL_ERROR_CODES`（現在 `MEDIA_SEARCH_QUERY_REQUIRED` は line 89 に登録済み）へ分類登録が必須。未分類だと `tests/guards.test.ts` の Rule 2 が落ちる。
  - 新しい guard を追加する場合は ID が 1..19 の連続を壊さないこと（Rule 3）。guard を増やさない運用（コードのみ追加）を推奨する。

---

## 5. Ask First ポリシーの自己申告

- **カテゴリ 1（破壊的 API/CLI 変更）**: **非該当**。`emit article-search` と MCP `sync_article_search` は新規コマンド／ツールの追加であり、既存コマンドの挙動を破壊しない。**短縮エイリアス `emit search` は意図的に設けない**（AGENTS.md の 4 ステップサイクルは CHECK を `sync_status` に置いており、将来「status の検索拡張」に `search` を渡したくなった瞬間に衝突するため）。
- **カテゴリ 2（設定ファイル仕様変更）**: **非該当**。`.emit/config.json` の必須キー追加や型変更なし。
- **カテゴリ 3（依存関係の追加）**: **非該当**。外部 npm パッケージの追加なし（Node.js 標準ライブラリと既存の `js-yaml`, `zod` を使用）。
- **カテゴリ 4（核心原則の変更）**: **非該当**。ローカルファースト、認識論的保護（不在を断定しない）、レイヤリング不変条件を厳格に遵守。

---

## 6. テストマトリクス（Test Matrix）

| ID       | テスト分類            | 検証内容                                                                                                                                                                                                |
| -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T0-1** | 検索経路              | `query` のみの実行で FTS が呼ばれ `searchMode: 'fts'` になること。list API へはリクエストしないこと                                                                                                     |
| **T0-2** | 検索経路              | FTS が HTTP エラー（404 / 5xx）を返した場合のみ scan へフォールバックし、`searchMode: 'scan'` と `fallbackReason` が出力に現れること。**FTS が 0 件を返した場合はフォールバックしない**                 |
| **T0-3** | 検索経路              | 決定ルールの優先順が守られること: `offline` > `tag`/`category`（scan）> `since`/`until`（scan）> `query` のみ（fts）> 条件なし（scan）。taxonomy 指定時に FTS を呼ばないこと                            |
| **T0-4** | 検索経路              | `--max-scan` が FTS 経路で無視され、その旨が出力されること。FTS の `limit` と scan の `maxScan` が混同されないこと                                                                                      |
| **T1-1** | リモート検索          | クエリなし実行時に最新記事一覧が取得できること（新着ブラウズ）                                                                                                                                          |
| **T1-2** | リモート検索          | タイトル・スラッグ・抜粋によるキーワード部分一致検索ができること（走査フォールバック時）                                                                                                                |
| **T1-3** | メタ属性フィルタ      | `--tag` による指定タグ所持記事の絞り込み                                                                                                                                                                |
| **T1-4** | メタ属性フィルタ      | `--category` による指定カテゴリー所持記事の絞り込み                                                                                                                                                     |
| **T1-5** | メタ属性フィルタ      | `--status draft` / `--status published` によるステータス絞り込み                                                                                                                                        |
| **T1-6** | メタ属性フィルタ      | `--slug` によるスラッグピンポイント検索                                                                                                                                                                 |
| **T1-7** | HTTP コスト           | taxonomy フィルタ指定時に発行される追加 GET が `taxonomyFetchCount` で報告され、`limit` 到達で検証を打ち切るため `taxonomyFetchCount ≤ limit × 2` に収まること。既定 `maxScan` が 50 に下がること       |
| **T1-8** | 認識論的保護          | `walkComplete: false` のとき `[WALK_INCOMPLETE] ... absence is not proven.` が出力され、不在を断定しないこと                                                                                            |
| **T2-1** | 日付範囲              | `--since` / `--until` による日付範囲絞り込み                                                                                                                                                            |
| **T2-2** | 日付範囲              | same-day boundary（`--since` と `--until` が同日）が当日を正しく包含すること                                                                                                                            |
| **T2-3** | 日付範囲              | 早期打ち切り（Early-exit）と `walkComplete: true` の判定は **`dateField === 'createdAt'` のときのみ**発火すること。`publishedAt` / `updatedAt` 指定時は全走査し、範囲内記事が後ろにあっても必ず拾うこと |
| **T2-6** | 日付範囲              | status 未指定（draft + published 並列取得・連結）時に、各系列で独立して打ち切り評価されること。連結列の先頭だけ見て打ち切る実装にならないこと                                                           |
| **T2-4** | 日付基準              | `--date-field` による `publishedAt` / `updatedAt` / `createdAt` の切り替え                                                                                                                              |
| **T2-5** | 日付ソース            | `rawItem` に日付キーが無い／不正な値の記事が例外にならず範囲外扱いになること                                                                                                                            |
| **T3-1** | 同期状況可視化        | ローカル存在する記事が `isLocal: true` と判定されパスが表示されること                                                                                                                                   |
| **T3-2** | 同期状況可視化        | 未取得記事に `[remote only]` と `emit pull <id>` の誘導が表示されること                                                                                                                                 |
| **T4-1** | オフライン検索        | `--offline` 時に一切のネットワーク fetch なしでローカル記事（本文含む）が検索できること                                                                                                                 |
| **T4-2** | 認識論的保護          | オフライン検索ヘッダー `[SOURCE: LOCAL WORKSPACE ONLY]` が出力されること                                                                                                                                |
| **T4-3** | 認識論的保護          | オフライン検索 0 件時に不在保護警告が出力されること                                                                                                                                                     |
| **T4-4** | quarantined 排除      | `posts/conflicts/` の copy が既定の検索結果に含まれないこと。`--include-conflicts` 時は `[quarantined — never push]` が付き、canonical と別セクションになること                                         |
| **T5-1** | 品質・レイヤリング    | `npm run check` 100% 合格、`tests/layering.test.ts` Axis 0〜5 順守。`sync/article_search` が `layer2Dirs` に登録済みで、新規 sibling 結合が gate に検出されること                                       |
| **T5-2** | エラーコード registry | 検索系で追加した全エラーコードが `OPERATIONAL_ERROR_CODES` に分類済みで、`tests/guards.test.ts` Rule 2 / Rule 3 / Rule 5 がグリーンであること                                                           |
| **T5-3** | MCP エラー契約        | `sync_article_search` の失敗が `formatToolError()` 経由になり、`[CODE]` / status / suggestion が落ちないこと（`resolveContext()` も guarded try 内）                                                    |

---

## 7. Definition of Done (DoD)

0. [x] **Phase 0（§3.0）の実測 M1〜M5 が完了し、結果が §2.1 に反映されている**。特に M4（リストの `createdAt` 降順）が確認でき、P2 の早期打ち切りは実装可と確定した。
       0b. [x] **§3.0.1 の残存項目 M6〜M9 を実測解決済み**。M7 で OpenAPI に `/search` が掲載されている公式契約であることを確認。M6 で trigram の 1〜2 文字制限（「カワ」で「カワセミ」が取れない現象）を実証し、短クエリ（< 3 文字）時の scan フォールバックを確定。
1. [x] `src/sync/article_search/` 配下に検索コアロジック（FTS 経路・走査フォールバック・オフライン走査・フィルタ）が実装されている。
2. [x] `src/client/endpoints.ts` に検索エンドポイントヘルパーが追加され、URL 組み立てが Layer 0 に集約されている。
3. [x] `DAY_MS` が `src/utils/search-date.ts`（Layer 0）へ昇格され、`src/sync/media/remote_index.ts` の私的定義が置き換えられている。
4. [x] CLI `emit article-search [query]`（**エイリアスなし**）が登録され、各オプションが正常に動作する。失敗は `reportActionFailure()` 経由で `❌` 1 行 + exit 1 になる。
5. [x] MCP `sync_article_search` が登録され、AI エージェントが自律的に利用できる。失敗は `formatToolError()` 経由。
6. [x] `tests/layering.test.ts` の `LAYER_2_MODULE_NAMES` / `layer2Dirs` / allowlist に追加され、レイヤリング Axis 0〜5 がすべてグリーンである。
7. [x] 追加した全エラーコードが `OPERATIONAL_ERROR_CODES` に分類済みで、`tests/guards.test.ts` Rule 1〜5 がグリーンである。
8. [x] テストマトリクス T0〜T5 の全単体テストが作成され、`npm run check` が 100% パスする（`format:check`, `typecheck`, `check:cycles`, `test`）。
9. [x] `README.md` および `AGENTS.md` に新しい記事検索コマンドと推奨ワークフローが追記され、**`status --search` と `article-search` の役割分担**が明記されている。
10. [x] MCP サーバー説明文（`src/mcp/server.ts`）に新ツールと使い分けが反映されている。
