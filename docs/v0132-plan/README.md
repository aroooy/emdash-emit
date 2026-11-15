# v0.1.32 実装計画書 (Rev.3): Orchestrator 完全対称化による Pull セマンティクス統一とドラフト初回同期正常化

- **対象バージョン**: `v0.1.32`
- **作成日**: 2026-11-15 (Rev.3 最終確定)
- **ステータス**: 承認・確定（実装中）
- **目的**: 
  1. Consumer 層（CLI / MCP）に分散していた taxonomy sync とセマンティクス導出（`canPruneTaxonomies`, `mediaSyncLimit`, `localMediaRefs`）を Layer 2 の **`orchestrator.ts`（`pullBatch` & `pullSingleArticle`）に集約** し、真の完全対称性を実現するとともに、MCP batch pull のクラッシュバグを物理的に根絶する。
  2. 下書き記事の初回 PULL で一覧 API の未展開データが採用されてしまう判定不具合（`&& existingSync` 漏れ）を修正し、初回 PULL から最新本文を確実に取得できるようにする。
  3. レイヤリング規則（Axis 0〜4）を 100% 遵守し、新たなモジュール・シンボル新設および例外追加ゼロ（0 件）で達成する。

---

## 1. 背景と根本原因の分析

### 1.1 課題 1: Consumer 層でのセマンティクス導出の重複と非対称性（構造的弱点）
v0.1.31 の実装において、`pullSingleArticle`（単一記事 PULL）は Orchestrator 内部で taxonomy sync を安全に実行し、`canPruneTaxonomies` を自己導出して `pullArticle` に注入していました。
しかし、`pullBatch`（バッチ PULL）では呼び出し元（CLI / MCP）が外側で taxonomy sync を行って `canPruneTaxonomies` を渡す契約になっていたため、以下の構造的問題が発生していました。

1. **`canPruneTaxonomies` の導出が 3 箇所で重複**:
   * `src/cli/commands/pull.ts:272` (batch)
   * `src/mcp/tools/sync-pull.ts:252` (batch)
   * `src/sync/orchestrator.ts:169-172` (single)
2. **MCP batch pull における `pullTaxonomies` の try/catch 欠落（実害バグ）**:
   * CLI（`src/cli/commands/pull.ts:220-233`）および Orchestrator single（`src/sync/orchestrator.ts:150-166`）は、taxonomy 取得の例外を適切に catch して `taxonomiesFailed = true` とし、間引きを安全に抑制した上で記事 PULL を続行します。
   * しかし、MCP batch（`src/mcp/tools/sync-pull.ts:212`）では **try/catch が完全に欠落** しており、ネットワークエラー等で例外が発生した場合にツール全体が `formatToolError` で終了し、**記事 PULL が 1 件も実行されません**。
3. **パラメータ解決の重複**:
   * `mediaSyncLimit` のフォールバック（`DEFAULT_CONFIG.mediaSyncLimit`）が CLI / MCP 内の計 8 箇所にハードコード。
   * `localMediaRefs` の優先順位解決が CLI と MCP で重複。

---

### 1.2 課題 2: 下書き記事初回 PULL 時の未展開データ取得バグ
* **事象**: Web UI で作成・編集した下書き記事（またはドラフトリビジョンを持つ公開記事）を、未同期のワークスペースに初めて `emit pull` した際、最新のリビジョン本文ではなく、記事作成時の不完全な本文（空行やブロック欠落）が保存されてしまう。
* **原因**:
  `src/sync/pull/index.ts:233`:
  ```ts
  const needsFullDraftFetch = isDraft || hasDraftRevision;
  ...
  const remoteChanged = !existingSync || !isSameRev(existingSync.remoteRev, remoteComparisonRev);

  if (needsFullDraftFetch && existingSync && remoteChanged) {
    rawItem = undefined; // 一覧 API の古いデータを捨て、Single GET で最新本文を取る
  }
  ```
  初回 PULL では `existingSync` が `undefined`（ローカル未同期）であるため、`&& existingSync` のガードによって `rawItem = undefined` が実行されず、一覧 API の未展開データ（`posts.data`）がそのままローカルに保存されていました。
  その結果、`sync_state.remote_rev` に最新リビジョン（`4@draft:...`）が記録されてしまい、以降の PULL で Fast-path スキップされ続けるデッドロックが発生していました。

> **0-GET 不変条件との整合（検証済み）**:
> `fast_path.ts:80-82` の guard（`if (!existingSync || ...) return null`）により、**初回 PULL は fast-path に進入しません**。到達時点で `remoteChanged === true` が保証されているため、`&& existingSync` の除去は Single GET を走らせる方向にのみ働きます。既存の clean published に対する 0-GET 不変条件（`pull_published_no_extra_get.test.ts`）は追跡済み記事が対象であり、一切破壊されません。

---

## 2. 改修設計 (Rev.3)

### 2.1 設計方針: Orchestrator への完全集約と対称化

1. **`orchestrator.ts` への完全集約 (P-2, P-3 解消)**:
   * `pullBatch` と `pullSingleArticle` の両方で、taxonomy sync（try/catch 付き）と `canPruneTaxonomies` 導出を完全に内包。
   * 戻り値の `taxonomies` を `PullTaxonomiesResult & { error?: string }` に統一し、単一記事・バッチともに pruned 数を含む完全な結果を返す（A-1 推奨採用）。
   * レイヤリングの許可シンボルリスト（`ALLOWED_LAYER_2_SYMBOLS`）への**新規例外追加はゼロ（0 件）** を維持。
2. **`localMediaRefs` 解決の純関数化と責務分離 (P-4, R-5 解消)**:
   * Layer 0（`src/utils/media-ref-precedence.ts`）に `resolveLocalMediaRefsOption(arg, config)` 純関数を配置。
   * 永続化（`persistLocalMediaRefs`）は CLI 側の責任として残留させ、MCP は workspace 設定を変更しない原則を守る。
3. **T5 の mock 監査と破壊防止 (R-3 解消)**:
   * `pullBatch` が内包する taxonomy sync により、`tests/pull_taxonomy_pruning.test.ts` の T5 が誤って `tags/`・`categories/` を空同期して unlink してしまう事態を防ぐため、T5 の `mockFetch` に taxonomy 端点応答を追加。

---

### 2.2 詳細モジュール仕様

#### A. `src/utils/media-ref-precedence.ts`（新規・Layer 0）

```ts
import type { EmitConfig } from './config.js';

/**
 * Pure precedence resolver for localMediaRefs:
 * explicit argument/flag wins; otherwise falls back to config.
 */
export function resolveLocalMediaRefsOption(
  optionValue: boolean | undefined,
  config?: Pick<EmitConfig, 'localMediaRefs'> | null,
): boolean | undefined {
  return optionValue !== undefined ? optionValue : config?.localMediaRefs;
}
```

#### B. `src/sync/orchestrator.ts` の拡張

```ts
import type { PullTaxonomiesResult } from './taxonomies.js';

export type OrchestratorTaxonomiesResult = PullTaxonomiesResult & { error?: string };

export interface PullBatchOptions extends ListRemoteArticlesOptions {
  workspaceRoot: string;
  cache: CacheDatabase;
  collection: string;
  force?: boolean;
  concurrency?: number;
  prune?: boolean;
  localMediaRefs?: boolean;
  mediaSync?: boolean;
  mediaSyncLimit?: number;
  postsOnly?: boolean;               // ← 追加: false の場合に内部で pullTaxonomies を実行
  onProgress?: (progress: { current: number; total: number; item: PullResult }) => void;
  // canPruneTaxonomies は廃止（内部導出）
}

export interface PullBatchResult {
  total: number;
  updated: number;
  skipped: number;
  deleted?: number;
  preserved?: number;
  quarantined?: number;
  items: PullResult[];
  taxonomies?: OrchestratorTaxonomiesResult; // ← 完全な 6 フィールド型
}

export interface PullSingleArticleResult {
  article: PullResult;
  taxonomies?: OrchestratorTaxonomiesResult; // ← batch と完全同一型に統一
  media?: PullArticleMediaSummary;
}
```

#### C. `src/sync/pull/index.ts` の修正

```diff
- if (needsFullDraftFetch && existingSync && remoteChanged) {
+ if (needsFullDraftFetch && remoteChanged) {
    rawItem = undefined;
  }
```

---

## 3. テスト計画

### 3.1 テストケース一覧

| テストファイル | テスト項目 | 検証内容 |
|---|---|---|
| `tests/orchestrator_pull_batch.test.ts` | **TS-1: batch での taxonomy 内部同期** | `pullBatch` が `postsOnly: false` 時に自ら taxonomy を同期し、戻り値に `taxonomies`（4カウント含む）を返すこと |
| `tests/orchestrator_pull_batch.test.ts` | **TS-2: taxonomy 失敗時の安全なフォールバック** | `pullTaxonomies` が例外を投げても `pullBatch` がクラッシュせず、`canPruneTaxonomies: false` かつ `taxonomies.error` がセットされ記事 PULL を完遂すること |
| `tests/orchestrator_pull_batch.test.ts` | **TS-3: postsOnly 時のスキップ** | `postsOnly: true` 時に taxonomy 同期がスキップされ、`canPruneTaxonomies: false` になること |
| `tests/pull_draft_initial.test.ts` | **TD-1: 初回ドラフト PULL の Single GET (3段 assert)** | 未追跡の下書き記事をバッチ PULL した際、(a) Single GET が発行され、(b) ディスク本文が Single GET 由来となり、(c) 2回目 PULL で posts への HTTP GET が 0 本（Fast-path hit）でスキップされること |
| `tests/pull_taxonomy_pruning.test.ts` | **R-3 回帰検証 (T5)** | T5 の `mockFetch` に taxonomy 端点を補完し、ローカル定義の意図せぬ prune が発生しないこと |
| `tests/layering.test.ts` | **TL-1: レイヤリング不変条件** | Axis 0〜4 完全準拠、新規例外追加 0 件、`ALLOWED_LAYER_2_SYMBOLS` 違反なし |

---

## 4. 変更対象ファイル一覧

| レイヤー | ファイルパス | 変更種別 | 変更内容 |
|---|---|---|---|
| **Layer 0** | `src/utils/media-ref-precedence.ts` | **新規作成** | `resolveLocalMediaRefsOption` 純関数 |
| **Layer 2** | `src/sync/orchestrator.ts` | **修正** | `pullBatch` に taxonomy 同期・セマンティクス導出を内包、結果を戻り値に追加、`pullSingleArticle` との対称化 |
| **Layer 2** | `src/sync/pull/index.ts` | **修正** | `needsFullDraftFetch && remoteChanged` 条件修正（`&& existingSync` 除去） |
| **Layer 3** | `src/cli/commands/pull.ts` | **修正** | 重複する taxonomy 呼び出し・`canPruneTaxonomies` 導出を削除し、`pullBatch` 戻り値を利用 |
| **Layer 3** | `src/cli/context.ts` | **修正** | `resolveLocalMediaRefsOption` の利用 |
| **Layer 3** | `src/mcp/tools/sync-pull.ts` | **修正** | 未 catch の taxonomy 呼び出し・重複導出を削除し、`pullBatch` 戻り値を利用 |
| **Tests** | `tests/pull_taxonomy_pruning.test.ts` | **修正** | T5 mock に taxonomy 端点を追加 |
| **Tests** | `tests/orchestrator_pull_batch.test.ts` | **新規作成** | `pullBatch` の taxonomy 内包とフォールバックの網羅テスト |
| **Tests** | `tests/pull_draft_initial.test.ts` | **新規作成** | 初回ドラフト PULL の Single GET 保証検証（3段 assert） |
| **Root** | `package.json` | **修正** | バージョンを `0.1.32` に更新 |

---

## 5. 完了基準

1. [ ] `tests/layering.test.ts` が 6/6 PASS すること（新たな sibling coupling やレイヤー違反がないこと）。
2. [ ] `pullTaxonomies` が throw しても、CLI および MCP の batch pull が中断せず安全に記事 pull を継続すること。
3. [ ] 初回ドラフト PULL で一覧 API のデータが破棄され、Single GET を経由して完全な下書き本文が取得されること。
4. [ ] `npm run check` で 63 test files / 全テストが PASS すること。
