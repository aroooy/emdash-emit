# Emit v0.1.28 リファクタリング計画書（Rev.5）

**テーマ**: Layer 2 未変更判定の完全統一・4 層レイヤリング Gate の完全化・`pull.ts` モジュール分割・静的解析（`noUnusedLocals`）の恒久化

- **対象リビジョン**: `v0.1.27`（commit `180417d`）完了時点の `main` ブランチ
- **ステータス**: Rev.4 レビュー指摘反映済み・設計確定（未決定事項 0 件）
- **Rev.4 → Rev.5 の改訂点**:
  1. **§2 H1-5（`tryFastPathOrHeal`）において `:552-556` の生ハッシュ比較を維持し、`:587` のみを `isUnmodified` に置換する設計へ確定**: `:552-556`（レガシー depth-free メディア参照修復）は [AGENTS.md](../../AGENTS.md) §7 の「追跡ハッシュが depth-free バイト列そのものを記録している状態からの自己修復」を前提とするため `currentDiskHash === existingSync.localHash` を維持し、`:587` のみを `if (isUnmodified)` に置換する設計へ最小化・明確化（併せて `tests/local_media_refs.test.ts:422-457` の不変条件維持を §4 に明記）。
- **Rev.3 → Rev.4 の改訂点**:
  1. **§0 の `src/` ファイル数の訂正**: `wc -l src/**/*.ts`（深さ 2 のみ一致）による `64 ファイル` の誤記を、`find src -name '*.ts' | wc -l` の実測値 **`94 ファイル`**（22,934 行）に訂正。
  2. **§2 H1-5（`tryFastPathOrHeal`）の条件置換コードの明示と回帰テスト ⑤ の追加**: `:587` の `currentDiskHash === existingSync.localHash` 条件自体を `isUnmodified` に置換するスニペットを明記し、§4 #1 に fast-path 誤報告防止の回帰テスト ⑤ を追加。
- **Rev.2 → Rev.3 の主な改訂点**:
  1. **§2 L1-2 の関数名訂正と未使用引数削除方針の対称化**: `src/sync/push/transport.ts:90` の関数名を実コードどおり **`throwRemoteArticleDeleted`** に訂正し、`src/utils/media-body-refs.ts:227` の内部関数名も **`isLocalizedIn`** に訂正。片方を `_` 改名・片方を引数削除としていた非対称を改め、**両方とも未使用引数自体をシグネチャおよび呼び出し元から削除する**方針に完全統一。
  2. **§2 H1-5（`tryFastPathOrHeal`）における SQLite 二重書き込みの完全排除**: `tryFastPathOrHeal` 冒頭の `isLocalFileUnmodified` 判定も `healOnSpellingMatch: false` とし、後続の深さなしメディア参照修復（`retrackLocalHashOnly`）やフロントマター修復（`commitArticleSnapshot`）と書き込みが重複しないよう設計を精緻化。
  3. **§2 L2（`computeContextDiff`）の `contextLines > 0` 時のハンクヘッダ算式の明文化**: 前後コンテキスト行数（`preCount`, `postCount`）に基づくオフセット・行数算式を数式で定義し、`contextLines === 0`（既定）のときに現行式 `@@ -${b1.offset + 1},${b1.length} +${b2.offset + 1},${b2.length} @@` と完全一致することを明記。

---

## 0. エグゼクティブサマリー

`v0.1.27` 完了後の全コードベース（`src/` 94 ファイル・22,934 行、`tests/` 59 ファイル・606 tests）を精査した結果、以下の **3 つの実挙動上の問題（発見 ①〜③）** と **6 つの構造的負債** を特定した。

### 実測で特定した実バグ・アーキテクチャ違反（発見 ①〜③）

1. **【発見 ①】Layer 2（`orchestrator` / `conflicts` / `pull`）に残存する生 `localHash` 直接比較による誤判定バグ**
   - `v0.1.27` の P2 で `status` / `diff` / `doctor` / `delete` の 4 モジュールは `reconstructBaseline` / `isLocalFileUnmodified` に統一されたが、Layer 2 の `orchestrator.ts:176`（ウィンドウ外 prune 保護）・`conflicts.ts:476`（`accept-local` 保護）・`pull.ts:225, 587, 850`（quarantine / fast-path / 404 削除）の **5 箇所** が依然として `currentHash !== syncState.localHash` を生比較している。
   - そのため、`emit status` を一度も経由せずに `emit pull` や `emit conflicts resolve --strategy accept-local` を実行した場合、表記差（ローカルメディア相対パスや decoded タクソノミー）のみの未変更記事が「未プッシュ編集あり」と誤判定され、`SyncPruneConflictError` や `CanonicalHasUnpushedEditsError` が誤発火する。
2. **【発見 ②】`src/sync/doctor.ts:43`（Layer 2）から `src/mcp/heartbeat.ts`（Layer 3）への逆方向 import 違反と Layering Gate の検査漏れ**
   - [AGENTS.md](../../AGENTS.md) §1 は「Layer 3（`cli/`, `mcp/`, `presentation/`）は Layer 0, 1, 2 から決して import されない」と定めているが、`src/sync/doctor.ts:43` が `../mcp/heartbeat.js` を直接 import している。
   - さらに `src/mcp/heartbeat.ts:49-58` は Layer 0 `src/utils/version.ts:30-42` と同一の `getPackageVersion()` を重複定義している。
   - [tests/layering.test.ts](../../tests/layering.test.ts) に「Layer 0/1/2 → Layer 3 禁止」および「Layer 0 → Layer 1/2/3 禁止」のテスト軸が存在しなかったため、この違反が素通しになっていた。
3. **【発見 ③】CLI `pull.ts` の未捕捉例外スローと `--local-media-refs` / `PushResult` 出力の重複**
   - `v0.1.27` の P3 で 5 つの CLI コマンドが `reportActionFailure` に統一された一方、`src/cli/commands/pull.ts`（`:355, :406, :532`）は `ApiError` / `SyncPruneConflictError` 以外の例外を `throw error;` で再スローしており、`FrontmatterParseError` や一般 `Error` 発生時に生スタックトレースが露出する。

---

## 1. 対応スコープ一覧と優先度マトリクス

| ID     | 優先度       | 対象領域                                                   | 概要                                                                                                                     | 種別                  |
| ------ | ------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| **H1** | **Critical** | `orchestrator.ts`, `conflicts.ts`, `pull.ts`               | Layer 2 に残存する生 `localHash` 比較 5 箇所の `isLocalFileUnmodified` 統一と自己修復（発見 ①）                          | 実バグ修正 + 構造保証 |
| **H2** | **High**     | `utils/mcp-heartbeat.ts`, `tests/layering.test.ts`         | `heartbeat.ts` の Layer 0 移設（重複 `getPackageVersion` 廃止）、`orchestrator` / `doctor` の import 正規化、Gate 完全化 | レイヤリング違反是正  |
| **H3** | **High**     | `cli/report-failure.ts`, `cli/commands/{pull,push}.ts`     | CLI 全コマンドへの `reportActionFailure` 適用（発見 ③）および `--local-media-refs` 永続化・`PushResult` 出力の共通化     | CLI 出力一貫性 + DRY  |
| **M1** | **Medium**   | `src/sync/pull/`（新設 5 ファイル）+ `pull.ts`             | 1,163 行のモノリス `src/sync/pull.ts` を `src/sync/pull/{types,list,quarantine,fast_path,index}.ts` へ責務分割           | モジュール分割        |
| **M2** | **Medium**   | `src/db/migrations.ts` + `src/db/cache.ts`                 | 1,047 行の `src/db/cache.ts` からスキーマ初期化・マイグレーション定義を `src/db/migrations.ts` へ分離                    | モジュール分割        |
| **L1** | **Low-Med**  | `src/`（12 ファイル 23 件 + 引数 2 件）+ `tests/`（34 件） | 未使用 import / 変数 / 無駄な `calculateHash()` 呼び出しの完全除去と `"noUnusedLocals": true` の有効化                   | 静的解析ゲート恒久化  |
| **L2** | **Low**      | `src/sync/diff.ts`, `tests/*.test.ts`                      | `computeContextDiff` の未参照 `contextLines` 不整合解消（既定 `0` で現行出力維持＋指定時コンテキスト出力）とテスト整理   | 仕様整合 + テスト整理 |

---

## 2. 各項目の詳細設計（コード照合済み）

### H1（Critical）— Layer 2 残存 5 箇所の `isLocalFileUnmodified` 統一（発見 ①）

`src/sync/baseline-reconstruction.ts:88-137` の `isLocalFileUnmodified(params)` は以下のシグネチャを持つ：

```ts
export function isLocalFileUnmodified(params: {
  workspaceRoot: string;
  cache: CacheDatabase;
  id: string;
  relPath: string;
  localContent: string;
  syncState: SyncState | null | undefined;
  candidates?: TaxonomyCandidates;
  /** Default true: updates sync_state.local_hash when disk matches reconstructed baseline. */
  healOnSpellingMatch?: boolean;
}): boolean;
```

#### 修正対象 5 箇所と `healOnSpellingMatch` 制御設計

1. **`src/sync/orchestrator.ts:174-182`**（`pullBatch` ウィンドウ外 prune 安全チェック）:
   - **現状**: `if (currentHash !== candidate.localHash)` で生比較しているため、表記差のみの未変更ファイルがウィンドウ外に出ると `SyncPruneConflictError` でバッチ pull が中断する。
   - **修正**: `healOnSpellingMatch: false`（ウィンドウ外の記事はこの直後のステップ `:258-274` で prune されるか、`prune: false` 時も対象外のため DB 再書き込み不要）を指定して `!isLocalFileUnmodified({ workspaceRoot: options.workspaceRoot, cache: options.cache, id: candidate.id, relPath, localContent: content, syncState: candidate, healOnSpellingMatch: false })` のときのみ `unpushedConflicts` に追加する。

2. **`src/sync/conflicts.ts:466-481`**（`resolveConflict` の `accept-local` Major 1 ガード）:
   - **現状**: `if (syncState && syncState.localHash !== canonicalHash)` で生比較しているため、canonical ファイルが未変更（表記差のみ）でも `CanonicalHasUnpushedEditsError` がスローされる。
   - **修正**: 直後に `accept-local` の解決処理が canonical ファイルとキャッシュを上書きするため `healOnSpellingMatch: false` とし、`if (syncState && !isLocalFileUnmodified({ workspaceRoot: options.workspaceRoot, cache: options.cache, id: canonicalId, relPath: canonicalRel, localContent: canonicalContent, syncState, healOnSpellingMatch: false }))` に置換する。

3. **`src/sync/pull.ts:847-851`**（`pullArticle` リモート 404/410 削除時のクリーンアップ判定）:
   - **現状**: `if (diskHash === existingSync.localHash)` で生比較しているため、リモートで削除された記事がローカルで未変更（表記差のみ）のとき、自動削除されず `orphan: true, localEditsPreserved: true` になる。
   - **修正**: 直後に `options.cache.deleteEntry(id)` でレコードごと削除するため、`healOnSpellingMatch: false` を指定して `isLocalFileUnmodified({ workspaceRoot: options.workspaceRoot, cache: options.cache, id, relPath: existingSync.localFilePath, localContent: diskContent, syncState: existingSync, healOnSpellingMatch: false })` に置換する。

4. **`src/sync/pull.ts:201-247`**（`quarantineDivergentLocalCopies`）:
   - **現状**:
     ```ts
     if (localContent === canonicalContent) continue;
     if (baselineHash && calculateHash(localContent) === baselineHash) continue;
     ```
   - **設計上の留意点**:
     - ① 本関数は `pullArticle` の後半（`:1028`）、すなわち `commitArticleSnapshot`（`:1120`）の直前に呼ばれるため、`healOnSpellingMatch: false` で純粋な判定のみを行い、直後の `commitArticleSnapshot` との SQLite 二重書き込みを回避する。
     - ② `existingSync` が存在しない未キャッシュファイル（`reason: 'no-cache-baseline'`）の場合、`isLocalFileUnmodified` は `syncState: undefined` に対して即座に `false` を返すため、**[AGENTS.md](../../AGENTS.md) §8 の「キャッシュ baseline を持たないローカルファイルは上書き前に必ず `conflicts/` へ隔離保護される」不変条件が 100% 維持される**。
   - **修正**: `existingSync` を渡し、生ハッシュ一致または `isLocalFileUnmodified({ ..., syncState: existingSync, healOnSpellingMatch: false })` が `true` の場合は baseline と同一とみなして隔離をスキップする。

5. **`src/sync/pull.ts:587`**（`tryFastPathOrHeal` 内の未変更判定 — **Rev.5 `:552-556` 生ハッシュ維持・`:587` 単独置換**）:
   - **現状**: `:587` の `if (currentDiskHash === existingSync.localHash)` が生ハッシュ比較であるため、表記差のみで `localHash` が未修復のファイルは `:587` ブロックに入れず `:689-701` の `localEditsPreserved: true` 分岐へ落ち、`emit pull` 実行時に「ローカル編集あり（`localEditsPreserved: true`）」と誤報告される。
   - **Rev.5 精緻化（`:552-556` の生ハッシュ維持と `:587` の単独置換）**:
     - `:552-556`（レガシー depth-free `media/<storageKey>` 表記から article-relative `../../media/<storageKey>` への修復）は、[AGENTS.md](../../AGENTS.md) §7（および `tests/local_media_refs.test.ts:422-457`）が規定する「追跡ハッシュが depth-free バイト列そのものを記録している状態からの自己修復」であるため、`currentDiskHash === existingSync.localHash` の生ハッシュ比較を**そのまま維持**する。
     - その直後（`:587`）の未変更判定のみ、`healOnSpellingMatch: false` を指定した `isUnmodified` に置換する：
       ```ts
       if (
         options.localMediaRefs &&
         currentDiskHash === existingSync.localHash &&
         carriesDepthFreeMediaRef(currentDiskContent)
       ) {
         // 既存の深さなしメディア参照修復（変更なし・AGENTS.md §7 不変条件を完全維持）
         ...
       }

       const isUnmodified =
         currentDiskHash === existingSync.localHash ||
         isLocalFileUnmodified({
           workspaceRoot: options.workspaceRoot,
           cache: options.cache,
           id,
           relPath: existingSync.localFilePath,
           localContent: currentDiskContent,
           syncState: existingSync,
           candidates: getTaxonomyCandidates(),
           healOnSpellingMatch: false,
         });

       if (isUnmodified) {
         try {
           const parsedCurrent = parseMarkdown(currentDiskContent);
           ...
           if (carriesPercentEncodedTaxonomy(currentDiskContent) || needsDraftRevisionHeal) {
             // Branch 1: commitArticleSnapshot を 1 回実行して return
             ...
           }

           // いずれの修復も不要な純粋スキップ出口（旧 :636-644）:
           // 生ハッシュが未修復だった場合のみ 1 回だけ local_hash を自己修復し、
           // localEditsPreserved を含まない純粋な skipped: true を返す
           if (currentDiskHash !== existingSync.localHash) {
             retrackLocalHashOnly(options.cache, {
               id,
               diskContent: currentDiskContent,
               touchSyncedAt: true,
             });
           }
           return {
             id,
             slug: existingSync.slug,
             status: existingSync.status,
             filePath: existingSync.localFilePath,
             updated: false,
             skipped: true,
             title: rawTitle,
           };
         } catch {
           // Branch 2: commitArticleSnapshot を 1 回実行して return
           ...
         }
       }
       ```
     - これにより、[AGENTS.md](../../AGENTS.md) §7 の depth-free 自己修復不変条件（`tests/local_media_refs.test.ts:422-457`）に一切影響を与えず、かつ表記差のみの未変更記事が `:692-701` の `localEditsPreserved: true` に誤落下することを防ぎ、全経路で SQLite 書き込みを最大 1 回に抑えられる。

---

### H2（High）— `heartbeat.ts` の Layer 0 移設と 4 層 Layering Gate の完全化（発見 ②）

#### 是正方針

1. **Layer 0 `src/utils/mcp-heartbeat.ts` の新設**:
   - `src/mcp/heartbeat.ts` の実装を Layer 0 `src/utils/mcp-heartbeat.ts` に移設し、内部の重複 `getPackageVersion()`（`:49-58`）を廃止して `./version.js` から import する。
   - `src/mcp/heartbeat.ts` は `export * from '../utils/mcp-heartbeat.js';` の 1 行バレルとして維持し、既存テスト（`tests/doctor.test.ts` 等）の import パス互換性を保つ。
   - `src/sync/doctor.ts` は `../utils/mcp-heartbeat.js`（Layer 0）を import する。これにより Layer 2 → Layer 3 の逆方向依存が **0 件** になる。
2. **Workspace Contracts / Layer 0 直参照への正規化**:
   - `src/sync/orchestrator.ts`: `calculateHash`, `findLocalFilesByUlid` を `./workspace/index.js` から import し、未使用の `carriesDepthFreeMediaRef` import を削除する。
   - `src/sync/doctor.ts`: `storageKeyFromMediaMeta` を `../utils/media-companion.js`（Layer 0）から import し、未使用の `scanArticleMediaReferences` と `findUnmirroredStorageKeys` を削除する。
3. **`tests/layering.test.ts` の Gate 完全化（4 テスト → 6 テスト）**:
   - **新規追加 1（Axis 0）**: Layer 0（`src/utils/`, `src/db/`, `src/client/`）は Layer 1 / Layer 2 / Layer 3（`src/sync/`, `src/cli/`, `src/mcp/`, `src/presentation/`）を決して import しない。
   - **新規追加 2（Axis 4）**: Layer 0 / Layer 1 / Layer 2（`src/utils/`, `src/db/`, `src/client/`, `src/sync/` 配下すべて、`sync/pull/`, `sync/push/`, `sync/media/`, `sync/workspace/`, `sync/preflight/` を含む）は Layer 3（`src/cli/`, `src/mcp/`, `src/presentation/`）を決して import しない。

---

### H3（High）— CLI `pull` / `push` のエラーハンドリング統一と重複ロジック集約（発見 ③）

#### 是正方針

1. **`src/cli/report-failure.ts` の拡張と `pull.ts` / `push.ts` への適用**:
   - `reportActionFailure` に以下 2 つの構造化エラー分岐を追加する：
     - `PushValidationError`: 既存の `push.ts:223-231` と同一フォーマット（`\n❌ Push blocked by Preflight Guards (${err.errors.length} error(s)):` + 各エラーコード・メッセージ・suggestion）で出力して `process.exit(1)`。
     - `SyncPruneConflictError`: 既存の `pull.ts:347-350` と同一フォーマット（`\n❌ ${error.message}`）で出力して `process.exit(1)`。
   - `src/cli/commands/pull.ts` の 3 つの `catch` ブロック（`:346`, `:401`, `:527`）および `src/cli/commands/push.ts:222` を `reportActionFailure(error)` に統一する。
2. **`resolveAndPersistLocalMediaRefs` ヘルパーの抽出**:
   - `pull.ts:142-152` と `push.ts:65-75` に重複している `--local-media-refs` / `--no-local-media-refs` の解決・`.emit/config.json` 永続化ロジックを `src/cli/context.ts` の `resolveAndPersistLocalMediaRefs(ctx, optionValue)` に集約する。
3. **`printPushArticleDetails` / `printTaxonomySyncSummary` の共通化**:
   - `push.ts:110-135`（`--all`）と `push.ts:195-220`（単一ファイル）の `PushResult` 付随情報（`previousId`, `previousFilePath`, `resolvedTaxonomies`, `warnings`）出力を `printPushArticleDetails(res)` に統合する。
   - `pull.ts:167-188` と `pull.ts:376-392` のタクソノミー同期サマリー出力を `printTaxonomySyncSummary(res, indent)` に統合する。

---

### M1（Medium）— `src/sync/pull.ts`（1,163 行）のモジュール分割とクロージャ依存解消設計

`src/sync/push/` および `src/sync/media/` と同じパターンで、`src/sync/pull.ts` を `src/sync/pull/` 配下の 5 モジュールへ分割し、`src/sync/pull.ts` は後方互換バレル（`export * from './pull/index.js'`）とする。

| モジュール                       | 推定行数 | 責務と公開シンボル                                                                                                                  |
| -------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/sync/pull/types.ts`         | ~110 行  | `PullOptions`, `PullResult`, `QuarantinedLocalCopy`, `RemoteArticleItem`, `ListRemoteArticlesOptions`, `FastPathContext`            |
| `src/sync/pull/list.ts`          | ~180 行  | `getRemoteMaxBatchLimit`, `listRemoteArticles`, `extractCanonicalRemoteTitle`（OpenAPI バッチ上限検出・カーソルページネーション）   |
| `src/sync/pull/quarantine.ts`    | ~170 行  | `formatQuarantineNotice`, `quarantineDivergentLocalCopies`, `handleRemoteDeletedArticle`（404/410 削除時の隔離・削除・orphan 保護） |
| `src/sync/pull/fast_path.ts`     | ~320 行  | `tryFastPathOrHeal(ctx: FastPathContext, item: Record<string, unknown>): Promise<PullResult \| null>`                               |
| `src/sync/pull/index.ts`         | ~260 行  | `pullArticle` 本体オーケストレーションおよび全シンボルのバレル再エクスポート                                                        |
| `src/sync/pull.ts`（バレル維持） | ~25 行   | `export * from './pull/index.js';`（既存の全 import パスを 100% 維持）                                                              |

#### `tryFastPathOrHeal` のクロージャ依存解消設計

現行の `tryFastPathOrHeal`（`src/sync/pull.ts:503-798`）は `pullArticle` 関数スコープ内の変数・クロージャ関数 7 個を暗黙に捕捉している。これを `src/sync/pull/fast_path.ts` へ純粋に切り出すため、`src/sync/pull/types.ts` に以下の `FastPathContext` を定義して明示的に注入する：

```ts
export interface FastPathContext {
  collection: string;
  id: string;
  options: PullOptions;
  fetchAssignedTerms: (taxonomy: 'category' | 'tag') => Promise<string[] | null>;
  getBylineIdToSlug: () => Promise<Record<string, string>>;
  getTaxonomyCandidates: () => TaxonomyCandidates | undefined;
  localizeDiskMarkdown: (
    canonicalContent: string,
    articleRelPath?: string,
    preferLegacyRef?: boolean,
  ) => string;
}
```

- これにより `fast_path.ts` はクロージャ状態を持たず、`pull/index.ts` で構築した `fastPathCtx` を 2 箇所の呼び出し（`:802` のリスト rawItem 検査、および `:927` の単一 GET 後検査）に渡すだけの明快な構造になる。
- **Layering Gate 対応**: `tests/layering.test.ts` の `layer2Dirs` に `path.join(SRC_ROOT, 'sync', 'pull')` を追加し、分割後のサブモジュールもすべて Layer 2 境界検査の対象に含める。

---

### M2（Medium）— `src/db/cache.ts`（1,047 行）からのマイグレーション分離

- `src/db/cache.ts` のスキーマ作成およびマイグレーション処理（`initSchema` 内の `CREATE TABLE` `:129-209` および `ALTER TABLE` / `media_state_v5` テーブル再構築 `:209-400`、計約 270 行）を Layer 0 の **`src/db/migrations.ts`**（`runCacheMigrations(db: DatabaseSync): void`）へ抽出する。
- `CacheDatabase` クラス本体はクエリ実行と CRUD 操作に専念し、約 780 行へスリム化する。公開メソッド・型は一切変更しない。

---

### L1（Low-Medium）— 未使用コード全件の完全除去と `"noUnusedLocals": true` の恒久化

#### 実測件数とスコープ

1. **`src/` 側の `--noUnusedLocals` 検出分（12 ファイル 23 件：TS6133 × 22 + TS6196 × 1）**:
   - `src/client/api.ts:30-31`（`ContentEnvelope`, `ContentItem`）
   - `src/client/lock.ts:36`（`authenticatedFetch`）
   - `src/client/mapper.ts:28`（`unwrapEnvelope`）
   - `src/client/media.ts:34`（`asStorageKey`）
   - `src/sync/diff.ts:237`（`contextLines` — L2 にて実装・解消）
   - `src/sync/doctor.ts:35, 40`（`scanArticleMediaReferences`, `findUnmirroredStorageKeys`）
   - `src/sync/media/companions.ts:11`（`LocalMirrorEntry` — TS6196）
   - `src/sync/orchestrator.ts:44`（`RemoteStorageKeyIndex`、および H2 で不要になる `carriesDepthFreeMediaRef`）
   - `src/sync/pull.ts:25, 27, 30, 37, 42, 49, 52, 742, 969`（未使用 import 7 件 + 未使用の `calculateHash` 計算 `remoteCanonHash`, `contentHash` 2 件 = 9 件）
   - `src/sync/push/commit.ts:28, 303`（`createBaseSnapshot`, 未使用の `calculateHash` 計算 `newHash`）
   - `src/sync/push/merge_stage.ts:29`（`createBaseSnapshot`）
   - `src/utils/frontmatter.ts:23`（`path`）
2. **`src/` 側の未使用引数 2 件（Rev.3 削除方針に統一）**:
   - `src/utils/media-body-refs.ts:227-231`（ファイル内プライベート関数 `isLocalizedIn` の未使用第 3 引数 `fs` — 呼び出し元 `:279` とともに引数自体を削除）
   - `src/sync/push/transport.ts:90-95`（Layer 2 内部ヘルパー `throwRemoteArticleDeleted` の未使用第 1 引数 `collection: string` — 呼び出し元 4 箇所 `src/sync/push/index.ts:361, 419, 456` および `src/sync/push/merge_stage.ts:123` とともに引数自体を削除）
   - ※ 両方とも公開 API ではなく内部関数であるため、`_` プレフィックスで残すのではなく**未使用引数自体をシグネチャおよび呼び出し元から削除する**対称な方針に統一する（なお `noUnusedParameters` はコールバック型への影響を避けるため `tsconfig.json` では強制しない）。
3. **`tests/` 側の `--noUnusedLocals` 検出分（16 ファイル 34 件：TS6133 × 33 + TS6198 × 1）**:
   - `tsconfig.test.json` は `"extends": "./tsconfig.json"` であるため、`tsconfig.json` に `"noUnusedLocals": true` を追加すると `npm run typecheck`（`tsc --noEmit && tsc -p tsconfig.test.json`）で `tests/` 側の 34 件も検査対象となる。
   - Step 5 で `tests/` 側の未使用 import・未使用変数 34 件もすべて除去し、`src/`・`tests/` 双方で `"noUnusedLocals": true` がエラー 0 件（TS6133 / TS6196 / TS6198 すべて 0 件）で通過する状態を確立する。

---

### L2（Low）— `computeContextDiff` の `contextLines` 不整合解消とテスト import 正規化

#### 1. `src/sync/diff.ts:219-272` (`computeContextDiff`) の現状とハンクヘッダ算式（Rev.3 明文化）

- **現状の実コードと実挙動の乖離**:
  - 現行コード（`src/sync/diff.ts:237`）は `const contextLines = options?.contextLines ?? 3;` と宣言しているが、直後のパッチ出力ループ（`:245-264`）で `contextLines` を一度も参照していない。
  - その結果、**実際のランタイム出力は「前後コンテキスト 0 行（変更チャンクの `-` / `+` 行のみ）」に固定**されている。
- **採択方針（選択肢 A）とハンク生成算式**:
  - 既定値を現行の実出力に合わせて **`0`**（`const contextLines = Math.max(0, options?.contextLines ?? 0);`）に変更し、`contextLines > 0` が明示指定された場合のみ各パッチハンクの前後最大 `contextLines` 行の共通行を出力する。
  - 各パッチハンク `(b1, b2)` に対する開始位置・行数・出力行の算式は以下のとおり定義する：
    ```ts
    const preCount = Math.min(contextLines, b1.offset, b2.offset);
    const postCount = Math.min(
      contextLines,
      baseLines.length - (b1.offset + b1.length),
      localLines.length - (b2.offset + b2.length),
    );
    const start1 = b1.offset - preCount + 1;
    const len1 = preCount + b1.length + postCount;
    const start2 = b2.offset - preCount + 1;
    const len2 = preCount + b2.length + postCount;

    output.push(`@@ -${start1},${len1} +${start2},${len2} @@`);
    for (let i = b1.offset - preCount; i < b1.offset; i++) {
      output.push(` ${baseLines[i]}`);
    }
    for (const line of b1.chunk) {
      output.push(`-${line}`);
    }
    for (const line of b2.chunk) {
      output.push(`+${line}`);
    }
    for (let i = 0; i < postCount; i++) {
      output.push(` ${baseLines[b1.offset + b1.length + i]}`);
    }
    ```
  - `contextLines === 0`（既定）のとき `preCount = 0`, `postCount = 0` となり、`start1 = b1.offset + 1`, `len1 = b1.length`, `start2 = b2.offset + 1`, `len2 = b2.length` となって現行のループと **1 文字の差もなく完全一致**する。

#### 2. テストファイルの `calculateHash` import 正規化

- `tests/` 配下で `../src/sync/pull.js` から `calculateHash` を import している **14 ファイル**（単一行 import 13 ファイル + 複数行 import 1 ファイル `tests/pull_quarantine.test.ts`）を、Workspace Contracts の正規パス `../src/sync/workspace/index.js` に統一する。

---

## 3. アーキテクチャ・レイヤリング影響検証

| 新設・変更モジュール                                       | 所属レイヤー | Outbound Imports（依存先）                   | Inbound Consumers（利用元）            | Layering Gate（`tests/layering.test.ts`）への影響                    |
| ---------------------------------------------------------- | ------------ | -------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| `src/utils/mcp-heartbeat.ts`                               | **Layer 0**  | `node:fs`, `node:os`, `node:path`, `version` | `doctor.ts` (L2), `mcp/heartbeat` (L3) | Axis 0（L0→上位禁止）および Axis 4（L0/1/2→L3 禁止）の双方に完全準拠 |
| `src/db/migrations.ts`                                     | **Layer 0**  | `node:sqlite` (`DatabaseSync`)               | `src/db/cache.ts` (L0)                 | Layer 0 内部完結                                                     |
| `src/sync/pull/{types,list,quarantine,fast_path,index}.ts` | **Layer 2**  | Layer 0, Layer 1, `sync/workspace`           | `src/sync/pull.ts`, `orchestrator`     | `layer2Dirs` に `sync/pull` を追加し、L2 sibling 検査・Axis 4 に登録 |

---

## 4. テスト計画

既存の 59 テストファイル（606 tests）の全通過に加え、以下の検証テストを追加する。

1. **H1 回帰テスト（`tests/baseline_reconstruction.test.ts` 拡張）**:
   - ① `localMediaRefs: true` でディスク上が相対パス表記・`sync_state.local_hash` が旧 canonical ハッシュのままの未変更記事がスライディングウィンドウ外に出た際、`pullBatch` が `SyncPruneConflictError` を誤発火せず正常に prune できること。
   - ② 同じ状態の未変更 canonical 記事に対して `resolveConflict({ strategy: 'accept-local' })` を `--force` なしで実行した際、`CanonicalHasUnpushedEditsError` が誤発火せず正常に解決できること。
   - ③ 同じ状態の未変更記事がリモートで 404 削除された際、`pullArticle` が orphan 誤判定せずクリーンにローカルファイルを削除できること。
   - ④ キャッシュ baseline を持たない未キャッシュのローカルファイル（`no-cache-baseline`）が存在する状態で `pullArticle` を実行した際、H1 適用後もスキップされず従来どおり `posts/conflicts/` に隔離保護されること。
   - ⑤ **（Rev.4 追加）** `localMediaRefs: true` でディスク上が相対パス表記・`sync_state.local_hash` が旧 canonical ハッシュのままの未変更記事に対し、リモート `_rev` 同一状態で `pullArticle` を実行した際、`localEditsPreserved` が付かず純粋な `skipped: true, updated: false` が返り、かつ `sync_state.local_hash` がディスクハッシュへ自己修復されること（あわせて既存の `tests/local_media_refs.test.ts:422-457` における depth-free レガシー表記の自己修復不変条件がそのまま通過すること）。
2. **H2 Layering Gate テスト（`tests/layering.test.ts` 拡張）**:
   - **Axis 0**: Layer 0（`utils`, `db`, `client`）が Layer 1 / 2 / 3 を一切 import していないこと。
   - **Axis 4**: Layer 0 / 1 / 2（`sync/pull/*` を含む全サブディレクトリ）が Layer 3（`cli`, `mcp`, `presentation`）を一切 import していないこと。
3. **H3 CLI エラー出力テスト（`tests/cli.test.ts` 拡張）**:
   - `reportActionFailure` が `PushValidationError` と `SyncPruneConflictError` を先頭 `❌` 付きで整形出力すること。
4. **L2 `computeContextDiff` テスト（`tests/diff.test.ts` 拡張）**:
   - ① デフォルト（`contextLines` 未指定）の出力が従来の context 0 行フォーマット（`--- base\n+++ local\n@@ -2,1 +2,1 @@\n-line 2\n+line 2 (modified)`）と完全一致することを `toBe(...)` で固定するテスト。
   - ② `contextLines: 1` 明示指定時に前後の共通行（` line 1`, ` line 3`）が含まれ、ハンクヘッダが `@@ -1,3 +1,3 @@` として正しく出力されること。

---

## 5. 実装ステップ（5 フェーズ）

1. **Step 1（H2: Layer 0 整理 + Gate 完全化）**:
   - `src/utils/mcp-heartbeat.ts` 新設、`src/mcp/heartbeat.ts` バレル化、`src/sync/doctor.ts` / `src/sync/orchestrator.ts` の import 正規化、`tests/layering.test.ts` に Axis 0 / Axis 4 を追加。
2. **Step 2（H1: Layer 2 未変更判定の完全統一）**:
   - `src/sync/orchestrator.ts`、`src/sync/conflicts.ts`、`src/sync/pull.ts` の 5 箇所を `isLocalFileUnmodified` に統一し、`tests/baseline_reconstruction.test.ts` に回帰テスト ①②③④⑤ を追加。
3. **Step 3（M1 + M2: `pull.ts` と `cache.ts` のモジュール分割）**:
   - `FastPathContext` によるクロージャ解消を含め `src/sync/pull/{types,list,quarantine,fast_path,index}.ts` へ分割（`src/sync/pull.ts` はバレル維持）し、`src/db/migrations.ts` を分離。
4. **Step 4（H3: CLI `pull` / `push` のエラーハンドリング・重複統合）**:
   - `src/cli/report-failure.ts`、`src/cli/context.ts`、`src/cli/commands/pull.ts`、`src/cli/commands/push.ts` のリファクタリングと CLI テスト追加。
5. **Step 5（L1 + L2 + Docs: 未使用コード全件除去・`noUnusedLocals` 有効化・文書更新）**:
   - `computeContextDiff` の `contextLines` 対応、`src/` および `tests/` の未使用宣言（計 57 件 + 未使用引数 2 件）の一掃、`tests/` の `calculateHash` import 正規化（14 ファイル）、`tsconfig.json` の `"noUnusedLocals": true` 有効化、`package.json`（`0.1.28`）・`CHANGELOG.md`・`AGENTS.md` の更新。
