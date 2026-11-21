# v0.1.43 計画書: 過去記事（Posts）の多次元検索基盤（メタ属性・日付範囲・オフライン）とピンポイント取得連携

- **対象バージョン**: `v0.1.43`
- **作成日**: 2026-11-21
- **ステータス**: **設計・計画段階（Proposed）**
- **起点**:
  1. v0.1.42 にてメディア検索（`emit media-search` / `sync_media_search`）が拡充され、日付範囲検索・直近ブラウズ・オフライン検索・認識論的保護（不在保護）が確立された。
  2. 一方で、記事（Posts）側の検索機能は `emit status --search <term>` のみであり、これは**ローカルの SQLite キャッシュ / ワークスペースに存在する記事しか対象としない**。
  3. Emit は大容量ブログを軽量に扱うためスライディングウィンドウ方式（既定 30 件: `postsSyncLimit`）を採用しているが、この仕様により**ウィンドウ外（過去記事）がローカルから不可視**になっている。
  4. 過去記事を編集したい場合、本来は `emit pull <id>`（または MCP `sync_pull(id: "...")`）によるピンポイント取得が設計されているが、**「その ID を調べる手段」が Emit 内に存在しない**ため、AI エージェントやユーザーは `emit pull --all` で全件同期するか、Web 管理画面等で ID を手動カンニングするしかない。
  5. また、記事はメディアと比較してメタ属性（カテゴリー、タグ、ステータス、スラッグ、複数日付、著者）が極めて豊富であり、単なるフリーワード検索だけでなくこれらメタ属性を直交して絞り込める検索基盤が必須である。
- **目的**:
  1. **P1: リモート記事検索 CLI / MCP（`emit article-search` / `sync_article_search`）** — キーワード検索、クエリ任意化による直近記事一覧ブラウズ、および主要メタ属性（タグ・カテゴリー・ステータス・スラッグ）による直交絞り込みを導入。
  2. **P2: 日付範囲絞り込み（`--since` / `--until`）と日付基準（`--date-field`）** — Layer 0 の `search-date.ts` を再利用し、降順リスト API に基づく早期打ち切り（Early-exit）と完全走査判定を実装。さらに公開日（`publishedAt`）・起草日（`createdAt`）・更新日（`updatedAt`）を選択可能な日付基準を導入。
  3. **P3: ローカル同期状況（Local vs Remote Only）の可視化とピンポイント取得連携** — 検索結果各行に `[local: posts/...]` または `[remote only]` を表示し、未取得記事に対して `emit pull <id>` / `sync_pull(id: "...")` への直結アクションガイダンスを出力。
  4. **P4: 完全オフライン記事検索（`--offline`）と認識論的保護（Epistemic Framing）** — ネットワーク通信を一切遮断し、ローカル Markdown ファイルおよび SQLite キャッシュ（`entries` テーブル）から高速検索。出力冒頭の `[SOURCE: LOCAL WORKSPACE ONLY]` 宣言と、0 件ヒット時の不在保護警告を徹底。
  5. **P5: アーキテクチャ階層（Layer 0〜3）の厳格順守とテスト拡充** — 検索ロジックを Layer 1 / Layer 2 に配置し、CLI/MCP 間の表示・文言を統一。包括的テストマトリクスを整備。

---

## 1. 課題認識とアプローチの要約

| # | 課題 | 現状の実測事実 | 判定 | 本版でのアプローチ |
|---|---|---|---|---|
| 1 | ウィンドウ外の過去記事が検索できない | `emit status --search` はローカル `entries` テーブルのみを走査するため、既定 30 件のスライディングウィンドウ外の記事は一切ヒットしない | 妥当。重大な機能欠落（メディアとの非対称性） | **P1 として採用**。リモート走査型検索 `emit article-search` / `sync_article_search` を新設 |
| 2 | ピンポイント `pull` のための ID 特定手段がない | `emit pull <id>` の単一取得機能はあるが、ID 自体を探す手段がなく、実質的に全件 pull を強要される | 妥当。エージェントの自律ワークフローを阻害 | **P1 & P3 として採用**。検索結果に ULID・スラッグを明示し、`emit pull <id>` への誘導を出力 |
| 3 | 記事特有のリッチなメタ属性で絞り込めない | メディアと異なり、記事はカテゴリー・タグ・ステータス・スラッグ・複数の日付を持つが、検索手段がない | 妥当。ブログ運用の基本要件 | **P1 & P2 として採用**。`--tag`, `--category`, `--status`, `--slug`, `--date-field` をサポート |
| 4 | 機内等の完全オフライン環境で過去記事を探せない | ローカルに存在する記事であっても、`emit status` の簡易表示しかなく、本文やメタ属性の柔軟な検索ができない | 妥当。メディアの `--offline` と同等のニーズ | **P4 として採用**。ローカル Markdown & キャッシュを走査する `--offline` モードを新設 |
| 5 | オフライン検索による「不在誤認」の危険 | ローカル検索でヒットしなかった場合、エージェントが「その記事は存在しない」と誤認して新規作成（重複）するリスク | 妥当。AGENTS.md の Epistemic Rule に直結 | **P4 にて保護確立**。`[SOURCE: LOCAL WORKSPACE ONLY]` 宣言と 0 件時の不在保護警告を実装 |

---

## 2. 現状の実測スナップショット（v0.1.42 時点）

すべて実際のコードに基づく計測結果であり、推定を含まない。

### 2.1 実測値一覧

| 項目 | 実測値 | 検査コード / コマンド |
|---|---|---|
| 現行の記事検索 CLI | `emit status -s, --search <term>`（title, slug, ID, filePath でローカル配列を filter） | `src/cli/commands/status.ts:104, 119` |
| 現行の記事検索 MCP | **存在しない**（`sync_status` に `search` フィルタがあるのみでリモート検索ツールなし） | `src/mcp/tools/sync-status.ts` |
| 記事同期リミット既定値 | `postsSyncLimit: 30`（draft 30 + published 30） | `src/utils/config.ts:74` |
| EmDash 記事リスト API | `GET /_emdash/api/content/{collection}`（cursor ページネーション、status フィルタ対応） | `src/sync/pull/list.ts:89-135` |
| EmDash 記事 API 1ページ上限 | openapi.json より動的取得（フォールバック既定 100 件） | `src/sync/pull/list.ts:50-84` |
| 日付パースヘルパー | `parseSearchDateBoundary(raw)` が Layer 0 に配備済み（`today`, `yesterday`, `YYYY-MM-DD`） | `src/utils/search-date.ts:40-75` |
| メディア検索の先行実装 | `searchRemoteMedia`（Layer 2 `remote_index.ts`）、`searchLocalMirrorMedia`（`types.ts`） | `src/sync/media/remote_index.ts:180-430` |

---

## 3. 詳細設計仕様

### 3.1 P1: リモート記事検索（`emit article-search` / `sync_article_search`）

#### CLI 仕様
```bash
emit article-search [query] [options]
```

**引数・オプション**:
- `[query]`: 検索キーワード（任意）。タイトル、スラッグ、抜粋（excerpt）、本文（走査範囲内）を部分一致検索（大文字小文字不問）。省略時は新着一覧ブラウズ。
- `-t, --tag <slug>`: 指定タグを持つ記事に限定。
- `-c, --category <slug>`: 指定カテゴリーを持つ記事に限定。
- `--status <draft|published>`: 公開ステータスで限定（省略時は両方）。
- `--slug <slug>`: スラッグ完全一致または前方一致で限定。
- `-l, --limit <n>`: 表示件数上限（既定: 20、最大: 50）。
- `--max-scan <n>`: 走査するリモート記事の最大件数（既定: 300、`0` = 全件走査）。
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
- `profile?: z.string().optional()`: プロファイル名。

---

### 3.2 P2: 日付範囲絞り込みと日付基準（Date Boundary & Field Selection）

1. **日付境界パースの再利用**:
   - `src/utils/search-date.ts` の `parseSearchDateBoundary()`（Layer 0）を使用。
   - `since` と `until` を独立パースし、同一日指定（same-day boundary: 当日 0:00 〜 翌日 0:00）を完全に保証。
2. **日付基準フィールド（`dateField`）の解決ルール**:
   - 明示指定がない場合の既定値:
     - `status === 'published'`: `publishedAt` を優先、未設定時は `createdAt`。
     - `status === 'draft'`: `createdAt` を優先、未設定時は `updatedAt`。
     - 混在時: 各記事のステータスに応じた上記の判定を適用。
   - 明示指定時: 指定されたフィールド（`publishedAt` / `updatedAt` / `createdAt`）の ISO タイムスタンプを使用（未設定の記事は範囲外としてスキップ）。
3. **降順走査と早期打ち切り（Early-exit）**:
   - リスト API が降順（新着順）で返るため、`dateField` がリストのソート順と一致する場合、`since` 境界より古いレコードに到達した時点で walk を即時中断。
   - 早期打ち切り時は `walkComplete: true`（指定範囲内の全走査が完了した正当な完了）として扱い、`[WALK_INCOMPLETE]` 警告を出さない。

---

### 3.3 P3: 同期状況（Local vs Remote Only）の可視化とアクション誘導

1. **ローカル照合判定**:
   - 取得したリモート記事の `id`（ULID）をローカル SQLite キャッシュ（`cache.getArticleEntryById(id)`）およびワークスペースファイル（`findLocalFilesByUlid(root, collection, id)`）と照合。
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
   - `posts/draft/`、`posts/published/`、`posts/conflicts/` 配下の全 `.md` ファイル（frontmatter + 本文）を走査。
   - SQLite キャッシュ（`entries` テーブル）のメタデータとも照合。
2. **認識論的保護（Epistemic Framing）**:
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
  - `parseSearchDateBoundary`、`DAY_MS` などの日付演算ヘルパーを配置（既存）。
- **Layer 1 (`src/sync/article_search/query.ts`)**:
  - 純粋なメモリ内フィルタ関数（キーワード、タグ、カテゴリー、ステータス、日付の判定ロジック）。副作用なし、I/O なし。
- **Layer 2 (`src/sync/article_search/index.ts`)**:
  - リモート走査型検索 `searchRemoteArticles()` およびローカルオフライン検索 `searchLocalArticles()` を配置。
  - `tests/layering.test.ts` の Layer 2 公開シンボル allowlist に `searchRemoteArticles` / `searchLocalArticles` を登録。
- **Layer 3 (`src/presentation/article_report.ts`, `src/cli/commands/search.ts`, `src/mcp/tools/sync-article-search.ts`)**:
  - 出力フォーマッタ `formatArticleSearchHeader()`, `formatArticleSearchHit()` を集約。
  - CLI コマンドおよび MCP ツールを実装。

---

## 5. Ask First ポリシーの自己申告

- **カテゴリ 1（破壊的 API/CLI 変更）**: **非該当**。`emit article-search`（および短縮名 `emit search`）と MCP `sync_article_search` は新規コマンド／ツールの追加であり、既存コマンドの挙動を破壊しない。
- **カテゴリ 2（設定ファイル仕様変更）**: **非該当**。`.emit/config.json` の必須キー追加や型変更なし。
- **カテゴリ 3（依存関係の追加）**: **非該当**。外部 npm パッケージの追加なし（Node.js 標準ライブラリと既存の `js-yaml`, `zod` を使用）。
- **カテゴリ 4（核心原則の変更）**: **非該当**。ローカルファースト、認識論的保護（不在を断定しない）、レイヤリング不変条件を厳格に遵守。

---

## 6. テストマトリクス（Test Matrix）

| ID | テスト分類 | 検証内容 |
|---|---|---|
| **T1-1** | リモート検索 | クエリなし実行時に最新記事一覧が取得できること（新着ブラウズ） |
| **T1-2** | リモート検索 | タイトル・スラッグ・抜粋によるキーワード部分一致検索ができること |
| **T1-3** | メタ属性フィルタ | `--tag` による指定タグ所持記事の絞り込み |
| **T1-4** | メタ属性フィルタ | `--category` による指定カテゴリー所持記事の絞り込み |
| **T1-5** | メタ属性フィルタ | `--status draft` / `--status published` によるステータス絞り込み |
| **T1-6** | メタ属性フィルタ | `--slug` によるスラッグピンポイント検索 |
| **T2-1** | 日付範囲 | `--since` / `--until` による日付範囲絞り込み |
| **T2-2** | 日付範囲 | same-day boundary（`--since` と `--until` が同日）が当日を正しく包含すること |
| **T2-3** | 日付範囲 | `--since` 到達時の早期打ち切り（Early-exit）と `walkComplete: true` の判定 |
| **T2-4** | 日付基準 | `--date-field` による `publishedAt` / `updatedAt` / `createdAt` の切り替え |
| **T3-1** | 同期状況可視化 | ローカル存在する記事が `isLocal: true` と判定されパスが表示されること |
| **T3-2** | 同期状況可視化 | 未取得記事に `[remote only]` と `emit pull <id>` の誘導が表示されること |
| **T4-1** | オフライン検索 | `--offline` 時に一切のネットワーク fetch なしでローカル記事が検索できること |
| **T4-2** | 認識論的保護 | オフライン検索ヘッダー `[SOURCE: LOCAL WORKSPACE ONLY]` が出力されること |
| **T4-3** | 認識論的保護 | オフライン検索 0 件時に不在保護警告が出力されること |
| **T5-1** | 品質・レイヤリング | `npm run check` 100% 合格、`tests/layering.test.ts` Axis 0〜5 順守 |

---

## 7. Definition of Done (DoD)

1. [ ] `src/sync/article_search/` 配下に検索コアロジック（リモート走査・オフライン走査・フィルタ）が実装されている。
2. [ ] CLI `emit article-search [query]`（エイリアス: `emit search`）が登録され、各オプションが正常に動作する。
3. [ ] MCP `sync_article_search` が登録され、AI エージェントが自律的に利用できる。
4. [ ] `tests/layering.test.ts` の allowlist に追加され、レイヤリング Axis 0〜5 がすべてグリーンである。
5. [ ] テストマトリクス T1〜T5 の全単体テストが作成され、`npm run check` が 100% パスする。
6. [ ] `README.md` および `AGENTS.md` に新しい記事検索コマンドと推奨ワークフローが追記されている。
