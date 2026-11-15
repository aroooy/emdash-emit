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
   - `src/cli/commands/pull.ts:272` (batch)
   - `src/mcp/tools/sync-pull.ts:252` (batch)
   - `src/sync/orchestrator.ts:169-172` (single)
2. **MCP batch pull における `pullTaxonomies` の try/catch 欠落（実害バグ）**:
   - CLI（`src/cli/commands/pull.ts:220-233`）および Orchestrator single（`src/sync/orchestrator.ts:150-166`）は、taxonomy 取得の例外を適切に catch して `taxonomiesFailed = true` とし、間引きを安全に抑制した上で記事 PULL を続行します。
   - しかし、MCP batch（`src/mcp/tools/sync-pull.ts:212`）では **try/catch が完全に欠落** しており、ネットワークエラー等で例外が発生した場合にツール全体が `formatToolError` で終了し、**記事 PULL が 1 件も実行されません**。
3. **パラメータ解決の重複**:
   - `mediaSyncLimit` のフォールバック（`DEFAULT_CONFIG.mediaSyncLimit`）が CLI / MCP 内の計 8 箇所にハードコード。
   - `localMediaRefs` の優先順位解決が CLI と MCP で重複。

---

### 1.2 課題 2: 下書き記事初回 PULL 時の未展開データ取得バグ

- **事象**: Web UI で作成・編集した下書き記事（またはドラフトリビジョンを持つ公開記事）を、未同期のワークスペースに初めて `emit pull` した際、最新のリビジョン本文ではなく、記事作成時の不完全な本文（空行やブロック欠落）が保存されてしまう。
- **原因**:
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
   - `pullBatch` と `pullSingleArticle` の両方で、taxonomy sync（try/catch 付き）と `canPruneTaxonomies` 導出を完全に内包。
   - 戻り値の `taxonomies` を `PullTaxonomiesResult & { error?: string }` に統一し、単一記事・バッチともに pruned 数を含む完全な結果を返す（A-1 推奨採用）。
   - レイヤリングの許可シンボルリスト（`ALLOWED_LAYER_2_SYMBOLS`）への**新規例外追加はゼロ（0 件）** を維持。
2. **`localMediaRefs` 解決の純関数化と責務分離 (P-4, R-5 解消)**:
   - Layer 0（`src/utils/media-ref-precedence.ts`）に `resolveLocalMediaRefsOption(arg, config)` 純関数を配置。
   - 永続化（`persistLocalMediaRefs`）は CLI 側の責任として残留させ、MCP は workspace 設定を変更しない原則を守る。
3. **T5 の mock 監査と破壊防止 (R-3 解消)**:
   - `pullBatch` が内包する taxonomy sync により、`tests/pull_taxonomy_pruning.test.ts` の T5 が誤って `tags/`・`categories/` を空同期して unlink してしまう事態を防ぐため、T5 の `mockFetch` に taxonomy 端点応答を追加。

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
  postsOnly?: boolean; // ← 追加: false の場合に内部で pullTaxonomies を実行
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

| テストファイル                          | テスト項目                                             | 検証内容                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/orchestrator_pull_batch.test.ts` | **TS-1: batch での taxonomy 内部同期**                 | `pullBatch` が `postsOnly: false` 時に自ら taxonomy を同期し、戻り値に `taxonomies`（4カウント含む）を返すこと                                                                                  |
| `tests/orchestrator_pull_batch.test.ts` | **TS-2: taxonomy 失敗時の安全なフォールバック**        | `pullTaxonomies` が例外を投げても `pullBatch` がクラッシュせず、`canPruneTaxonomies: false` かつ `taxonomies.error` がセットされ記事 PULL を完遂すること                                        |
| `tests/orchestrator_pull_batch.test.ts` | **TS-3: postsOnly 時のスキップ**                       | `postsOnly: true` 時に taxonomy 同期がスキップされ、`canPruneTaxonomies: false` になること                                                                                                      |
| `tests/pull_draft_initial.test.ts`      | **TD-1: 初回ドラフト PULL の Single GET (3段 assert)** | 未追跡の下書き記事をバッチ PULL した際、(a) Single GET が発行され、(b) ディスク本文が Single GET 由来となり、(c) 2回目 PULL で posts への HTTP GET が 0 本（Fast-path hit）でスキップされること |
| `tests/pull_taxonomy_pruning.test.ts`   | **R-3 回帰検証 (T5)**                                  | T5 の `mockFetch` に taxonomy 端点を補完し、ローカル定義の意図せぬ prune が発生しないこと                                                                                                       |
| `tests/layering.test.ts`                | **TL-1: レイヤリング不変条件**                         | Axis 0〜4 完全準拠、新規例外追加 0 件、`ALLOWED_LAYER_2_SYMBOLS` 違反なし                                                                                                                       |

---

## 4. 変更対象ファイル一覧

| レイヤー    | ファイルパス                            | 変更種別     | 変更内容                                                                                                   |
| ----------- | --------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| **Layer 0** | `src/utils/media-ref-precedence.ts`     | **新規作成** | `resolveLocalMediaRefsOption` 純関数                                                                       |
| **Layer 2** | `src/sync/orchestrator.ts`              | **修正**     | `pullBatch` に taxonomy 同期・セマンティクス導出を内包、結果を戻り値に追加、`pullSingleArticle` との対称化 |
| **Layer 2** | `src/sync/pull/index.ts`                | **修正**     | `needsFullDraftFetch && remoteChanged` 条件修正（`&& existingSync` 除去）                                  |
| **Layer 3** | `src/cli/commands/pull.ts`              | **修正**     | 重複する taxonomy 呼び出し・`canPruneTaxonomies` 導出を削除し、`pullBatch` 戻り値を利用                    |
| **Layer 3** | `src/cli/context.ts`                    | **修正**     | `resolveLocalMediaRefsOption` の利用                                                                       |
| **Layer 3** | `src/mcp/tools/sync-pull.ts`            | **修正**     | 未 catch の taxonomy 呼び出し・重複導出を削除し、`pullBatch` 戻り値を利用                                  |
| **Tests**   | `tests/pull_taxonomy_pruning.test.ts`   | **修正**     | T5 mock に taxonomy 端点を追加                                                                             |
| **Tests**   | `tests/orchestrator_pull_batch.test.ts` | **新規作成** | `pullBatch` の taxonomy 内包とフォールバックの網羅テスト                                                   |
| **Tests**   | `tests/pull_draft_initial.test.ts`      | **新規作成** | 初回ドラフト PULL の Single GET 保証検証（3段 assert）                                                     |
| **Root**    | `package.json`                          | **修正**     | バージョンを `0.1.32` に更新                                                                               |

---

## 5. 完了基準

1. [ ] `tests/layering.test.ts` が 6/6 PASS すること（新たな sibling coupling やレイヤー違反がないこと）。
2. [ ] `pullTaxonomies` が throw しても、CLI および MCP の batch pull が中断せず安全に記事 pull を継続すること。
3. [ ] 初回ドラフト PULL で一覧 API のデータが破棄され、Single GET を経由して完全な下書き本文が取得されること。

---

# 実装レビュー（commit `a4092c1` / v0.1.32）— 設計意図は完全に達成。残課題は 4 件（うち AGENTS.md 不整合 1 件）

**検証方法**: `git show HEAD` の差分全読、`npm run check` 再実行、AGENTS.md との突合、テスト mock の実挙動追跡。
**結論**: **Rev.3 の設計およびレビュー指摘（R-1〜R-5 / A-1 / A-2）はすべて実装されており、品質ゲートは Green。**
ただし **AGENTS.md §Two-Track の記載が実装と食い違ったまま**残っています。

---

## ✅ 設計意図の達成確認（コード実体で確認済み）

| 計画項目                                     | 実装                                                                                                                                                         | 確認結果                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **§2.2A** taxonomy sync の orchestrator 内包 | `orchestrator.ts:214-246` で try/catch 付き `pullTaxonomies()`（`:219`）→ 失敗時 `error` 設定（`:233-241`）                                                  | ✅ MCP 側の生呼び出し（旧 `sync-pull.ts:212`）を削除 → **try/catch 欠落バグは物理的に消滅**                                     |
| 単一記事側との対称性（A-1）                  | `OrchestratorTaxonomiesResult = PullTaxonomiesResult & { error?: string }`（`:64`）を**両側**へ適用（`PullBatchResult:114` / `PullSingleArticleResult:137`） | ✅ **A-1 (a) を採用**。単一記事側も counts を保持（成功時 `taxonomiesResult = taxRes`、`:160`）                                 |
| 4 カウント保持＋即時表示                     | `onTaxonomySync?: (result: OrchestratorTaxonomiesResult) => void`（`:86`）＋ CLI `pull.ts:245-252` の `printTaxonomySyncSummary`                             | ✅ pruned 数を含む既存 CLI 出力を維持。MCP も `deletedCategoriesCount` / `deletedTagsCount` を表示（`sync-pull.ts:239-246`）    |
| `canPruneTaxonomies` 内部導出                | 公開 option を `PullBatchOptions` から**削除**し `postsOnly?: boolean`（`:85`）を導入、内部で `!options.postsOnly && !taxonomiesFailed`（`:244-246`）        | ✅ R-3 の「黙って無視」を回避する**最も安全な形**（型エラーで呼び出し元を強制修正）                                             |
| **§2.2B** Layer 0 純関数                     | `src/utils/media-ref-precedence.ts:29-34`（import は `type EmitConfig` のみ、disk アクセスなし）                                                             | ✅ 軸 0 遵守（Axis 0 検査は `src/utils` を走査、`layering.test.ts:318-320`）。CLI 側のみ persist 維持（`context.ts:284-289`）   |
| MCP が設定を変更しない                       | `sync-pull.ts:111` は `resolveLocalMediaRefsOption()` のみ                                                                                                   | ✅ 不変条件維持                                                                                                                 |
| **§2.2C** 初回ドラフト Single GET            | `pull/index.ts:223` → `hasDraftRevision \|\| (isDraft && Boolean(existingSync))`                                                                             | ✅ 目的は達成（注記は C-3）                                                                                                     |
| T5 mock 是正                                 | `pull_taxonomy_pruning.test.ts:369-384` に taxonomy 端点分岐を追加、`canPruneTaxonomies: true` を削除                                                        | ✅ 破壊的 unlink を防止                                                                                                         |
| allowlist 例外 0 件                          | `ALLOWED_LAYER_2_SYMBOLS` は無変更                                                                                                                           | ✅ `OrchestratorTaxonomiesResult` は `orchestrator`（既存登録、`:66-72`）経由、`PullTaxonomiesResult` は Layer 1 で gate 対象外 |

**想定より良く処理できた点**:

- `sync.test.ts:1064` に `postsOnly: true` を追加し「Unexpected fetch」ガードを taxonomy sync から隔離 — **R-3 の監査が T5 以外にも及んで正しい**。
- TD-1 は A-2 を採用し (c) を `/_emdash/api/content/posts/${draftId}` への GET **0 本**（`pull_draft_initial.test.ts:186-191`）で assert。Track 2 rev 整合（`:167`）も確認済み。

---

## ⛔ C-1【AGENTS.md 不整合】Two-Track invariant の記載が実装と食い違い

AGENTS.md:83 は現在も `needsFullDraftFetch = isDraft || hasDraftRevision` /
`needsFullDraftFetch && existingSync && remoteChanged` のまま。実装後は両方変化しています（`pull/index.ts:223,233`）:

```ts
const needsFullDraftFetch = hasDraftRevision || (isDraft && Boolean(existingSync));
if (needsFullDraftFetch && remoteChanged) {
  rawItem = undefined;
}
```

**次の改修者が旧条件へ戻す（= v0.1.32 の修正を元に戻す）リスク**があります。推奨文言:

> `needsFullDraftFetch = hasDraftRevision || (isDraft && existingSync)`, evaluated as `needsFullDraftFetch && remoteChanged`.
> A **published** article's draft body is never carried by the list payload, so a tracked published article with any
> `draftRevisionId` always re-fetches. An **untracked** draft without a revision token has no evidence of staleness and
> reuses the list item (initial-pull cost unchanged; clean published 0-GET invariant preserved).

---

## ⚠️ C-2【テストカバレッジギャップ】TD-1 は `postsOnly: true` で走り、新導出経路を通っていない

TD-1 Step 1（`pull_draft_initial.test.ts:138-148`）は `postsOnly: true` です。よって
**「`pullBatch` が実際に taxonomy sync を走る経路で初回ドラフト Single GET が成立すること」**が未検証です。
TD-1 の mock に taxonomy 端点分岐が無い（`grep taxonom` → 0 hit）ため、現状の mock では `postsOnly: false` 版を検証できません。

→ TD-1 に `postsOnly: false` 版を 1 ケース追加（taxonomy 端点分岐を持つ mock を共有）、または TS-1 の mock に未追跡ドラフト記事を加え
**両効果を同一経路で検証**するのが確実です。

---

## ⚠️ C-3【方針の未明文化】`isDraft && existingSync` は「初回 pull で作成時本文が採用される」ケースを明示的に残す

§1.2 の目的は「初回 PULL から最新リビジョン本文を確実に取得」ですが、実装条件は
**未追跡＋`draftRevisionId` 無し**のケースを Single GET 対象から除外します（`remoteChanged === true` でも除外）。

- 技術的正当性: `extractComparisonRev()` は draft で `draftRevisionId` が無いと `version` のみを返し（`tests/api_rev.test.ts:11`）、
  一覧 `posts.data` が作成時固定か最新版かの判別手段がない → **GET を強制する根拠が存在しない**。判断自体は妥当。
- ただし「初回 PULL で作成時の不完全な本文が保存される」事象はこのケースで**未解決のまま**です
  （`draftRevisionId` は draft 編集で生成されるため、作成直後無編集の記事が該当し得ます）。

→ plan / AGENTS.md に「判別根拠が無いため意図的に list item を採用する」と 1 行明記し、既知の残存限界として記録してください。

---

## ⚠️ C-4【軽微】taxonomy import の責務注記が無い

`pull.ts:30,33` と `sync-pull.ts:33` は `pullTaxonomies` / `PullTaxonomiesResult` をまだ import していますが、
バッチ経路では不使用です（`pull.ts:442`、`sync-pull.ts:325` の `emit pull-taxonomies` / `sync_pull_taxonomies` で依然必要）。
import は正当ですが、将来またバッチ経路で再利用されるリスクがあるため、AGENTS.md の facade 節に
「taxonomy hint 表示は `getLocalTaxonomiesSummary` / `formatTaxonomiesHint`（Layer 1）のみを使い、taxonomy sync 自体は orchestrator の責務」と 1 行追加を推奨。

---

## ✅ 品質ゲート再確認（本レビューで実測）

```
npm run check
All matched files use Prettier code style!
 Test Files  63 passed (63)
      Tests  667 passed (667)
```

`npm run typecheck`（`tsc --noEmit && tsc -p tsconfig.test.json`）: PASS ／ layering gate: 例外 0 件で PASS ／ `package.json`: `0.1.32`。

---

## 総合判定

| 観点                                              | 判定                                       |
| ------------------------------------------------- | ------------------------------------------ |
| MCP batch クラッシュバグ根絶                      | ✅ **達成**（構造的に存在不能）            |
| CLI/MCP 対称性・4 カウント保持                    | ✅ **達成**（A-1 (a) を採用し両側統一）    |
| allowlist 例外 0 件・軸 0〜4                      | ✅ **達成**                                |
| 初回ドラフト Single GET（`draftRevisionId` あり） | ✅ 達成（TD-1 の 3 段 assert＋0-GET）      |
| AGENTS.md §Two-Track の同期                       | ⛔ **未実施**（C-1）— 旧条件へ戻される危険 |
| `postsOnly: false` 経路での初回ドラフト検証       | ⚠️ ギャップ（C-2）                         |
| 「判別根拠なし」ケースの方針明文化                | ⚠️ 未記載（C-3）                           |

**次の推奨作業**: C-1（AGENTS.md 更新・最優先で低コスト）→ C-2（TD-1 の `postsOnly: false` ケース追加）→ C-3（方針明記）。
いずれも v0.1.32 の安定性を損なわない文書・テストの追補です。

---

## ✅ レビュー残課題（C-1〜C-4）の反映結果

1. **C-1 & C-3 反映**: `AGENTS.md` §Draft Selective Single GET Invariant を更新。
   - `needsFullDraftFetch = hasDraftRevision || (isDraft && Boolean(existingSync))`（evaluated as `needsFullDraftFetch && remoteChanged`）に同期。
   - 未追跡で `draftRevisionId` が存在しないドラフトは判別根拠が無いため、N+1 回避のため意図的にリスト項目を採用する旨を明文化。
2. **C-2 反映**: `tests/pull_draft_initial.test.ts` に `TD-2` を追加。
   - `postsOnly: false`（デフォルトのバッチ pull）経路において、taxonomy sync と未追跡ドラフトの Single GET が干渉なく成立することを検証完了。
3. **C-4 反映**: `AGENTS.md` §Batch Pull Orchestration Facade に注記を追加。
   - バッチ pull における taxonomy 同期は `orchestrator.ts:pullBatch` に集約され、CLI/MCP 側の `pullTaxonomies` import はスタンドアロン専用（`emit pull-taxonomies` / `sync_pull_taxonomies`）であることを明記。
4. **品質ゲート**: `npm run check` → 63 files / 668 tests passed, Prettier clean, TypeScript typecheck clean, Layering gate 6/6 passed。

---

# 追加レビュー（commit `7c8ea3d`）— C-1〜C-4 は妥当な解決。残りは §2.2B の文档欠落 1 件

**検証方法**: `git show HEAD` 差分全読、TD-2 の assert 実体追跡、`npm run check` / `vitest run tests/layering.test.ts` 再実行。

## ✅ C-1〜C-4 の解決を確認

| 指摘                                | 解決実体                                                                                                                                                                                                                               | 判定                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **C-1** AGENTS.md 旧条件            | AGENTS.md §Draft Selective Single GET Invariant が `hasDraftRevision \|\| (isDraft && Boolean(existingSync))` / `&& remoteChanged` に同期。published＋`draftRevisionId` は常に再取得、untracked＋rev token なしは list item 採用と明記 | ✅ **旧条件へ逆戻りする危険は解消**。実装（`pull/index.ts:223,233`）と完全一致 |
| **C-3** 方針の未明文化              | 同一節に「no evidence of staleness / N+1 を避けるため意図的に list item を採用」を追記                                                                                                                                                 | ✅ 判断根拠が文書化され、将来の「修正」で GET 強制へ寄る危険を封止             |
| **C-2** `postsOnly: false` ギャップ | TD-2（`pull_draft_initial.test.ts:197-326`）: taxonomy 端点分岐を持つ mock、`postsOnly: false`、(a) `taxonomies.categoriesCount/tagsCount` = 1、(b) content endpoint への GET **1 本**、(c) disk に canonical 本文＋`remoteRev` 一致   | ✅ C-2 の要求を満たす。TD-1 と異なり taxonomy sync が実際に走る経路を通過      |
| **C-4** import 責務                 | AGENTS.md §Batch Pull Orchestration Facade（`:59-60`）に「consumers は `pullTaxonomies()` を直接実行しない / import は standalone 専用」を明記。§Two-Track 更新とあわせて 7 行変更                                                     | ✅ 「batch 経路で再利用してはならない」境界が明示された                        |

**TD-2 の品質**: taxonomy 端点 URL を個別分岐させ fallthrough を排除し、GET 集計は `u.split('?')[0].endsWith(...)` で query を除外 — TD-1 に課した A-2 相当の精度を TD-2 にも適用できています。`beforeEach` の `categories/`・`tags/` 作成（`:38-39`）で taxonomy 書き出し先を準備済み。

**品質ゲート実測**: `npm run check` → Prettier clean / **63 files・668 tests**。`vitest run tests/layering.test.ts` → **6/6 PASS**（例外追加 0 件）。docs のみ変更で `src/` は無変更 = v0.1.32 の挙動は無傷。

## ⚠️ N-1【残る文档欠落】§2.2B の Layer 0 ユーティリティが AGENTS.md に不在

レビューの達成表は §2.2B（軸 0 遵守）を ✅ としていますが、**AGENTS.md 側にはその事実が書かれていません**:

- `grep -n "media-ref-precedence|resolveLocalMediaRefsOption" AGENTS.md` → **0 hit**
- 一方コードは稼働中: `src/utils/media-ref-precedence.ts:30`（`import type { EmitConfig }` のみ）、
  利用側は MCP `sync-pull.ts:48,111`（persist しない）と CLI `context.ts:32,284`（`resolveAndPersistLocalMediaRefs` が persist）。

AGENTS.md §7 の `localMediaRefs` 節（`:245`）は挙動（default-ON、CLI flag、MCP 引数）だけを書き、
**「precedence 解決は Layer 0 の純関数で行い、disk 永続化は CLI 専用」**という境界を書いていません。
この欠落は C-4 と同じ性質（将来 MCP に persist を足す／CLI 側へ関数を移す改修を招く）を持つため、
§7 もしくは §5 の code-quality 不変条件に 1 行追加することを推奨します。推奨文言:

> **`localMediaRefs` precedence lives in Layer 0 (`src/utils/media-ref-precedence.ts:resolveLocalMediaRefsOption`)** — a pure
> argument-over-config resolver with no disk access. MCP tools call it directly and must never persist the resolved value;
> only the CLI wrapper `resolveAndPersistLocalMediaRefs()` (`src/cli/context.ts`) writes `.emit/config.json`. Never move this
> resolution into `src/cli/` (Axis 3) or let MCP write workspace config.

## 総合判定（v0.1.32 クロージング）

| 観点                                  | 判定                                                             |
| ------------------------------------- | ---------------------------------------------------------------- |
| C-1 / C-3（AGENTS.md 同期・方針明記） | ✅ **解決**（実装と完全一致）                                    |
| C-2（`postsOnly: false` 経路検証）    | ✅ **解決**（TD-2、A-2 準拠の endpoint 限定 assert）             |
| C-4（import 責務注記）                | ✅ **解決**（facade 節に明記）                                   |
| 品質ゲート                            | ✅ 63 files / 668 tests・typecheck・layering 6/6・Prettier clean |
| §2.2B の AGENTS.md 記載               | ✅ **解決**（N-1: AGENTS.md §Layer 0 および §7 に明記完了）      |

**クロージング完了**: N-1 を AGENTS.md に追記し、v0.1.32 の実装・テスト・文書の全整合性を完全に確立しました。
