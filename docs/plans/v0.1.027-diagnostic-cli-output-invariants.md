# Emit v0.1.27 実装計画書: 残存重複の集約と診断・CLI 出力の不変条件構造保証 (Rev.3)

- **対象バージョン**: `v0.1.27`
- **作成日**: 2026-11-15
- **ステータス**: 最終レビュー反映・設計確定版（Rev.3）
- **対象リポジトリ**: `emdash-emit`（HEAD: `c1dcbca` / tag `v0.1.26` / `package.json` version `0.1.26`）
- **検証済み状態**: `npm run check`（58 test files / 599 tests green、`tests/taxonomies_two_layer.test.ts` 12 tests green）
- **対象領域**: `src/db/baseline.ts`, `src/sync/baseline-reconstruction.ts`, `src/sync/status.ts`, `src/sync/diff.ts`, `src/sync/doctor.ts`, `src/sync/delete.ts`, `src/sync/orchestrator.ts`, `src/sync/pull.ts`, `src/sync/taxonomies.ts`, `src/sync/preflight.ts`, `src/sync/preflight/image_probe.ts`, `src/utils/taxonomy-key.ts`, `src/cli/report-failure.ts`, `src/cli/commands/*`, `src/mcp/tools/*`

---

## 0. 位置づけと基本方針

v0.1.25（Phase 0）で「disk 書き込み + baseline 保存 + sync_state 保存」は `commitArticleSnapshot()` に集約され、
v0.1.25 修正コミット（`6913b92`）で `merge_stage.ts` の disk 出力 localization と MCP `sync_status` の draft 件数露出が閉じた。
v0.1.26（`c1dcbca`）で taxonomy 定義 YAML の Two-Layer 化が入り、**新しい重複が 4 件発生した**。

また、Rev.1 計画の実コード照合により、**`diff.ts` / `doctor.ts` / `delete.ts` における baseline 表記復元判定の未統合（呼び出し順序による `🟡 Modified` 自己矛盾および未修復ハッシュ誤検知）**と、**CLI エラー集約時の二重 `❌` プレフィックス罠**が新たに判明した。

本計画は、**残存する複製を潰し、AGENTS.md が文章で要求している不変条件（Invariants）をコード構造で保証する**とともに、上記の実バグ・診断不一致を根絶することを目的とする。

### 基本方針

1. **Invariant 直撃度を優先順位の唯一の尺度とする**: 「行数が多いから」ではなく、_Diagnostic alignment invariant_ / _Two-Layer Representation invariant_ / _CLI failure presentation invariant_ のどれを崩し得るかで順序づける。費用対効果の低い形式的ラッパー（P6）は見送る。
2. **集約は Layer gate を越えない**:
   - `retrackLocalHashOnly()` は Layer 0（`src/db/baseline.ts`）に配置し、Layer 1（`status.ts`, `diff.ts`）と Layer 2（`pull.ts`, `orchestrator.ts`, `doctor.ts`, `delete.ts`）の双方から Layer 境界例外なしで呼び出す。
   - Baseline 表記復元は Layer 1（`src/sync/baseline-reconstruction.ts`）に置き、Layer 1・Layer 2 から利用する。
   - `tests/layering.test.ts` の `LAYER_1_FILES` に新設 Layer 1 モジュールを登録し、Layer 2 allowlist を肥大化させない。
3. **テストを先に green のまま据える**: 集約の前に「集約後に成立すべき不変条件」を assert するテストを追加する。表記復元（`status` / `diff` / `doctor` / `delete` の順序非依存一致）と taxonomy collision winner（Layer A/B 一致）は専用テストで固定する（§5）。

---

## 1. 検出一覧（Detection Index・HEAD `c1dcbca` 実測）

### 1.1 v0.1.25 計画 §1.3 の再集計（解消済みの減算）

| 処理                                                    | v0.1.25 計画時点 | HEAD `c1dcbca` 実測                                                                                                                                                                 | 状態                                                       |
| ------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `serializeMarkdown(...)` 呼び出し                       | 8                | **7**（`new.ts:312`, `push/commit.ts:291`, `merge_stage.ts:260,317`, `pull.ts:599,655,736,966`, `db/baseline.ts:99`）                                                               | 集約済み（`db/baseline.ts` は wrapper であり複製ではない） |
| `saveSyncState({...})`                                  | 10               | **5**（`status.ts:245`, `conflicts.ts:505`, `workspace/commit.ts:117`, `orchestrator.ts:359`, `pull.ts:566`）                                                                       | 半減。うち 3 が sync_state-only 系統（§2 P1）              |
| `saveBaseSnapshot` / `createBaseSnapshot`               | 6                | **2**（`workspace/commit.ts:97,104-105`）のみ                                                                                                                                       | ✅ **集約完了**                                            |
| 「disk の表記を読んで baseline をその表記に寄せる」判定 | 4                | **2**（`status.ts:163-172`, `diff.ts:167-180`）＋ 表記由来の disk 書き換え 2（`orchestrator.ts:344-359`, `pull.ts:552-566`）＋ **未適用箇所 2（`doctor.ts:389`, `delete.ts:144`）** | 核心 2 系統の重複＋診断 2 箇所の適用漏れ（§2 P2）          |
| `PullResult` リテラル（うち `healed: true`）            | 10（うち 4）     | **10**（`grep -c 'return {' pull.ts`）、`healed: true` は `577 / 626 / 679 / 786`                                                                                                   | **見送り（§2 P6）**                                        |

### 1.2 対応項目の全体像

| ID        | 対象                                                                             | 実測位置                                                                                                                                                   | 崩し得る invariant / 実害                                                                        | 優先度                     |
| --------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------- |
| **P1**    | sync_state-only hash re-tracking（3 系統独立）                                   | `status.ts:245`, `orchestrator.ts:359`, `pull.ts:566`                                                                                                      | Two-Track revision / `local_hash` 真実性                                                         | **Critical**               |
| **P2**    | baseline 表記復元シーケンスの重複＋`diff` / `doctor` / `delete` の判定不一致     | `status.ts:148-172`, `diff.ts:162-208`, `doctor.ts:389`, `delete.ts:144`                                                                                   | Diagnostic alignment / `diff` 先行実行時に `hasChanges: false` なのに `🟡 Modified` となる実バグ | **Critical（bug 含む）**   |
| **P3**    | CLI 失敗出力の `reportActionFailure` 5 重定義と `❌` プレフィックス欠落          | `delete.ts:29`, `new.ts:30`, `conflicts.ts:39`, `doctor.ts:29`, `media.ts:41`                                                                              | CLI failure presentation（一般 `Error` 時の `❌` 欠落＋二重 `❌` 防止）                          | **High（bug）**            |
| **T1**    | `pullTaxonomies` の category/tag 保存＋prune ループ逐語一致                      | `taxonomies.ts:178-214` ↔ `223-259`                                                                                                                        | taxonomy 定義ファイル生成の一貫性                                                                | **Medium**（新規）         |
| **T2**    | 決定論的 sort（collision winner）三重定義                                        | `taxonomies.ts:372-378`, `526-534`, `536-541`                                                                                                              | Two-Layer Representation（Layer A/B winner 一致）                                                | **Medium**（新規・重要）   |
| **P4**    | MCP boilerplate（`resolveContext` ガード + `_meta` 手書き suffix）               | `resolveContext(` 呼び出し 11 か所、`_meta: ${JSON.stringify(...)}` **6 か所**（`sync-pull.ts` 4 / `sync-diff.ts` 1 / `sync-new.ts` 1 / `sync-push.ts` 1） | MCP tool error contract / `_meta` 形式統一                                                       | **Medium**                 |
| **P5**    | preflight の画像検証（存在・extension・size）二系統                              | `preflight.ts:553-588`（G11）↔ `668-703`（G5/G10）                                                                                                         | G5/G10/G11 判定基準（拡張子・50MiB 上限）の一致                                                  | **Medium**                 |
| **T3/T4** | `tryDecodeTaxonomyTerm(...).normalize('NFC')` と `canonicalSlug !== slug` の散在 | `new.ts:260-269`, `merge.ts:54,165-170`, `taxonomies.ts`, `frontmatter.ts:463-464`                                                                         | taxonomy 用語照合・Layer A/B 分岐の一貫性                                                        | **Low-Medium**（新規）     |
| **P6**    | `PullResult` リテラル（`updated: true` ×5 / `healed: true` ×4）                  | `pull.ts` 全体                                                                                                                                             | 型推論の直接性を損なう割にバグ抑止効果が薄い                                                     | **見送り（Out of Scope）** |

---

## 2. 各項目の詳細と是正方針

### P1（Critical）— sync_state-only hash re-tracking の Layer 0 集約

**実測**:

```ts
// status.ts:245  （表記 heal の追随、baseline は触らない）
cache.saveSyncState({ ...syncState, localHash: currentHash });

// orchestrator.ts:359  （media-ref localization パスの追随）
options.cache.saveSyncState({ ...tracked, localHash: calculateHash(localized) });

// pull.ts:566  （depth-free → article-relative respell、lastSyncedAt も更新）
options.cache.saveSyncState({ ...existingSync, localHash: calculateHash(respelled), lastSyncedAt: ... });
```

**問題**:
`commitArticleSnapshot()` は「disk + canonical + baseline を書く」モード（`bumpBaselineHashOnly` 含む）しか持たず、**baseline を一切触らず `local_hash` だけを進める**モードが存在しない。そのため 3 か所が `saveSyncState` を直接叩き、

- disk への書き込みと hash 計算の対応
- `lastSyncedAt` を更新するか否か
- 「untracked な記事は再 tracking しない」（`orchestrator.ts:357` の `if (tracked)`）

という同一知識を個別に書き分けている。`local_hash` は「disk が実際に持つバイト列」を表す唯一の真実であり、ここが 1 か所でも canonical 側に寄ると **every status pass が phantom modified を報告する**。

**是正方針（Rev.2 確定）**:
`CacheDatabase` と `BaseSnapshot` が既に属する **Layer 0 の `src/db/baseline.ts`** に `retrackLocalHashOnly()` を追加する。

```ts
/**
 * Sync-state-only re-tracking: the disk bytes changed (spelling), values did not.
 * Invariants:
 *  - local_hash strictly matches SHA-256 of the bytes now on disk
 *  - base_snapshots is NOT touched (baseline stays canonical / Layer A)
 *  - remote_rev, status, slug, conflict flags are preserved verbatim
 */
export function retrackLocalHashOnly(
  cache: CacheDatabase,
  input: {
    id: string;
    diskContent?: string; // Pass either diskContent (hash computed via SHA-256) or precomputed localHash
    localHash?: string;
    touchSyncedAt?: boolean; // pull fast-path: true / status, diff, doctor, orchestrator: false
  },
): { localHash: string } | null; // null when the article is untracked
```

- Layer 0（`src/db/baseline.ts`）に配置するため、Layer 1（`status.ts`, `diff.ts`）からも Layer 2（`orchestrator.ts`, `pull.ts`, `doctor.ts`, `delete.ts`）からも **Layer 境界違反ゼロ**で直接 import できる。

---

### P2（Critical・実バグ修正含む）— baseline 表記復元シーケンスの集約と全診断・保護経路への適用

**実測と Rev.2 で判明した実バグ（発見 ①・②）**:

1. **重複**: `status.ts:148-178` の `isBaselineSpellingMatch()` と `diff.ts:166-186` が、同一の 6 ステップ（`loadLocalTaxonomyCandidates` → `resolveDiskSpelling` → `baselineMarkdown` → `renderForDisk` → hash 比較）を独立に実装している。
2. **発見 ①（`diff.ts` の自己矛盾バグ）**:
   `src/sync/diff.ts:162` は `localizedBase` を計算する**前**に生ハッシュだけで
   ```ts
   const isModified = syncState ? syncState.localHash !== currentHash : true;
   ```
   を計算し、それを `:195`（`Status: 🟡 Modified`）と `:208`（`status: 'modified'`）にそのまま使用している（`tests/local_media_refs.test.ts:518-520` のコメントでも妥協が記録されていた箇所）。
   その結果、`emit status`（ハッシュ自己修復）より先に `emit diff`（または `sync_diff`）を呼ぶと、**`Changes: +0 / -0 lines`・`No changes detected.`（`diff.hasChanges === false`）なのに `Status: 🟡 Modified`（`status: 'modified'`）を返す自己矛盾**が発生する。
3. **発見 ②（`doctor.ts` と `delete.ts` の未修復ハッシュ誤検知）**:
   - `src/sync/doctor.ts:389`: `hasDivergence = diskHash !== state.localHash`
   - `src/sync/delete.ts:144`: `if (syncState && syncState.localHash !== currentHash && !options.discardLocalEdits)`
     これらも生ハッシュ不一致のみを見ているため、`emit status` 実行前に `emit doctor` や `emit delete` を走らせると、表記揺れ（メディア相対パス化など）だけの未編集ファイルを「未プッシュ変更あり（divergence）」と誤判定する。

**是正方針（Rev.2 確定）**:
Layer 1 に共有モジュール **`src/sync/baseline-reconstruction.ts`** を新設し、`status.ts` / `diff.ts` / `doctor.ts` / `delete.ts` の 4 箇所すべてを統一する。

```ts
export interface ReconstructedBaseline {
  canonicalMarkdown: string; // remote canonical spelling（diff の canonical フォールバック比較用）
  diskSpellingMarkdown: string; // disk 表記に寄せた再構築（untouched ファイルの比較用）
  spelling: DiskSpelling; // resolveDiskSpelling の結果
  matchesDisk: boolean; // calculateHash(diskSpellingMarkdown) === currentHash
}

export function reconstructBaseline(params: {
  workspaceRoot: string;
  snapshot: BaseSnapshot;
  localContent: string;
  currentHash?: string;
  syncState?: SyncState | null;
  relPath: string;
  candidates?: TaxonomyCandidates;
  fs?: typeof fs;
}): ReconstructedBaseline;

/**
 * Checks whether a tracked file on disk is unmodified against its cached sync_state or reconstructed baseline.
 * When raw localHash mismatches but reconstructed baseline matches disk bytes, automatically heals sync_state.local_hash
 * via retrackLocalHashOnly() so subsequent checks fast-path cleanly.
 */
export function isLocalFileUnmodified(params: {
  workspaceRoot: string;
  cache: CacheDatabase;
  id: string;
  relPath: string;
  localContent: string;
  currentHash?: string;
  syncState?: SyncState | null;
  healOnSpellingMatch?: boolean; // default: true
}): boolean;
```

- **`status.ts`**: `isLocalFileUnmodified`（または `reconstructBaseline` + `retrackLocalHashOnly`）を使用し、ローカルの `isBaselineSpellingMatch()` を削除。
- **`diff.ts`**: `reconstructBaseline()` を使用し、`syncState` が存在し `reconstructed.matchesDisk` が `true`（かつ `syncState.localHash !== currentHash`）の場合は `retrackLocalHashOnly()` で自己修復した上で、
  ```ts
  const isModified = syncState
    ? syncState.localHash !== currentHash && !reconstructed.matchesDisk
    : true;
  ```
  に修正する（`syncState === null` の未 tracking 境界ケースでは従来どおり `isModified = true` 固定を維持）。これにより `emit status` より先に `emit diff` を呼んでも `🟢 In Sync with base snapshot`（`status: 'synced'`）となる。
- **`doctor.ts`（`:389`）**: `diskHash !== state.localHash` のとき `isLocalFileUnmodified` で確認し、表記差のみであれば `hasDivergence = false`（同時にハッシュ自己修復）とする。
- **`delete.ts`（`:144`）**: `syncState.localHash !== currentHash` のとき `isLocalFileUnmodified` で確認し、表記差のみであれば `UnpushedModificationsError` を誤発火させない。

---

### P3（High・bug fix）— CLI 失敗出力 `reportActionFailure` の集約と二重 `❌` 防止

**実測と Rev.2 で判明した罠（発見 ③）**:
5 コマンド（`delete.ts`, `new.ts`, `conflicts.ts`, `doctor.ts`, `media.ts`）が `reportActionFailure` をローカル定義しており、`delete.ts:29-35` と `new.ts:30-36` は `console.error(error.message)` と書かれている。

しかし、実コードを確認すると以下の専用エラーは **`error.message` 自体が既に `❌` で始まっている**:

- `DuplicateSlugError`（`src/sync/new.ts:56`）: `❌ Conflict: An article with slug '...' already exists!`
- `UnpushedModificationsError`（`src/sync/delete.ts:39`）: `❌ ABORT: File contains unpushed local modifications: ...`
- `PublishedArticleDeletionForbiddenError`（`src/sync/delete.ts:59`）: `❌ ABORT: Article is published: ...`
- `src/sync/delete.ts:122,129`: ``throw new Error(`❌ Local file not found: ...`)``

そのため、無条件に `console.error(\`❌ Error: ${error.message}\`)` に統一すると、**`❌ Error: ❌ Conflict: ...`と二重プレフィックスになってしまう**（これが`new.ts`と`delete.ts`だけ`error.message`をそのまま出力していた理由であり、逆に一般の`Error`が投げられたときに`❌` が欠落する原因になっていた）。

また、`conflicts.ts:44` は `QuarantinedPathRequiredError` に対して `❌ Error: [QUARANTINED_PATH_REQUIRED] ${error.message}` とエラーコードをハードコードしている。

**是正方針（Rev.2 確定）**:
Layer 3 に **`src/cli/report-failure.ts`** を新設し、5 コマンドのローカル定義をすべて廃止して集約する。

```ts
export function reportActionFailure(error: unknown): never {
  if (error instanceof ApiError) {
    console.error(error.toActionableString());
  } else if (error instanceof CanonicalHasUnpushedEditsError) {
    console.error(`❌ ${error.message}`);
    console.error(`💡 Suggestion: ${error.suggestion}`);
  } else if (error instanceof QuarantinedPathRequiredError) {
    console.error(`❌ Error: [${error.code}] ${error.message}`);
    console.error(`💡 Suggestion: ${error.suggestion}`);
  } else if (error instanceof Error) {
    const msg = error.message;
    console.error(msg.trimStart().startsWith('❌') ? msg : `❌ Error: ${msg}`);
  } else {
    const raw = String(error);
    console.error(raw.trimStart().startsWith('❌') ? raw : `❌ Error: ${raw}`);
  }
  process.exit(1);
}
```

- これにより、既存の `DuplicateSlugError` / `UnpushedModificationsError` 等の出力フォーマット（および `tests/cli.test.ts` の既存アサーション）を一切壊さず、二重 `❌` を防ぎつつ、すべての未装飾 `Error` に確実に `❌ Error: ` を付与できる。
- あわせて `src/cli/commands/new.ts:24` の未使用 import `DuplicateSlugError` を削除する。

---

### T1（Medium・v0.1.26 新規重複）— taxonomy 保存＋prune ループの統合

**実測**:
`pullTaxonomies` 内の `taxonomies.ts:178-214`（categories 保存 + prune）と `223-259`（tags 保存 + prune）は識別子以外が完全一致している。

**是正方針**:
`src/sync/taxonomies.ts` 内に private ヘルパー `writeAndPruneTaxonomyDir()` を抽出する。

```ts
function writeAndPruneTaxonomyDir(params: {
  dir: string;
  items: RemoteTaxonomyTerm[];
  taxonomy: 'category' | 'tag';
}): { deletedCount: number };
```

- 呼び出し側の `if (categories !== null)` / `if (tags !== null)` ガードは維持し、片方のリモート取得失敗時に既存 YAML が prune されない不変条件をテスト（§5 #6）で固定する。

---

### T2（Medium・重要）— collision winner 決定論的 sort の単一実装化

**実測**:
`src/sync/taxonomies.ts` 内の 3 箇所（`loadLocalTaxonomyMaps:372-378`、`getLocalTaxonomiesSummary` categories `:526-534`、`getLocalTaxonomiesSummary` tags `:536-541`）に `count desc → ULID desc` の比較ロジックが重複している。

**是正方針（Rev.2 確定）**:

1. `compareTaxonomyTermDeterministically(a, b)` を export し、`count desc → ULID desc` を単一関数に固定する。
   ```ts
   export function compareTaxonomyTermDeterministically(
     a: { id: string; count?: number },
     b: { id: string; count?: number },
   ): number {
     const countDiff = (b.count ?? 0) - (a.count ?? 0);
     if (countDiff !== 0) return countDiff;
     return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
   }
   ```
2. `getLocalTaxonomiesSummary` の categories ソートは表示順として `slug` 昇順を第 1 キーに持つが、`dedupeBySlug` は**同一 `slug` を持つ要素間**で先頭要素を勝者として残す。同一 `slug` 間では `a.slug === b.slug` であるため、第 2 キーとして `compareTaxonomyTermDeterministically(a, b)` を呼べば、Layer A（`loadLocalTaxonomyMaps`）と Layer B（`getLocalTaxonomiesSummary`）の衝突勝者は数学的に 100% 一致する。この不変条件をコメントとテスト（§5 #5）で明文化する。

---

### P4（Medium）— MCP boilerplate の共通化

**実測**:

- `resolveContext(` 呼び出し: 9 ツール 11 か所。
- 手書き `<!-- _meta: ${JSON.stringify(...)} -->` suffix: 6 か所（`sync-pull.ts` ×4、`sync-diff.ts` ×1、`sync-new.ts` ×1、`sync-push.ts` ×1）。

**是正方針（Rev.2 確定）**:

- `src/mcp/tools/shared.ts` に **`formatToolTextWithMeta(text: string, meta: Record<string, unknown>)`** を新設し、6 か所の手書き `<!-- _meta: ... -->` テンプレートリテラルを置換する（既存の JSON シリアライズ用 `formatToolSuccess(data)` と責務・型を明確に分離）。
- `withResolvedContext(resolveContext, args, handler)` ヘルパーを `src/mcp/tools/shared.ts` に追加し、`resolveContext` が必ず `try / catch (formatToolError)` の内側で呼ばれる構造を保証する。

---

### P5（Medium）— preflight ローカル画像プローブの共通化

**実測**:
`src/sync/preflight.ts` の G11（本文ドラフト画像 `:560-588`）と G5/G10（`featuredImage` ドラフト画像 `:674-703`）で、`fs.statSync(absPath).isFile()`・`resolveImageMimeType(filename)`・`stat.size > MAX_MEDIA_UPLOAD_BYTES` の 3 段階検査が重複している。

**是正方針**:
Layer 1 の **`src/sync/preflight/image_probe.ts`** に `probeLocalImageFile(absPath, filename, maxBytes)` を抽出する。

```ts
export type LocalImageProbeFailureReason =
  | { code: 'MISSING_LOCAL_IMAGE_FILE'; reason: 'not_found' | 'not_regular_file' }
  | { code: 'INVALID_LOCAL_IMAGE_TYPE' }
  | { code: 'LOCAL_IMAGE_SIZE_EXCEEDED'; sizeBytes: number; maxBytes: number };

export type LocalImageProbeResult =
  { ok: true; sizeBytes: number } | { ok: false; failure: LocalImageProbeFailureReason };
```

- G11（本文画像）と G10（`featuredImage`）でエラーメッセージ・suggestion の文言が微妙に異なるため、**メッセージ構築は呼び出し側（`preflight.ts`）に残し、既存テスト・ガード仕様を 1 文字も壊さない**。

---

### T3 / T4（Low-Medium）— taxonomy キー正規化ヘルパーの Layer 0 集約

**是正方針**:
Layer 0 に **`src/utils/taxonomy-key.ts`** を新設し、散在する `tryDecodeTaxonomyTerm(...).normalize('NFC')` と `canonicalSlug` 解決を集約する。

```ts
export function normalizeTaxonomyKey(term: string): string;
export function canonicalSlugOf(item: { slug: string; canonicalSlug?: string }): string;
```

- `new.ts` の `isKnownTerm` における `.toLowerCase()` は大文字小文字非依存照合用の追加処理であるため、`normalizeTaxonomyKey` 自体は case を保持し、呼び出し側で必要に応じて `.toLowerCase()` する。

---

### P6（Low）— `PullResult` リテラル（見送り・スコープ外）

- **判定**: **見送り（Out of Scope）**。
- **理由**: `pull.ts` の `return { id, slug, status, filePath, updated: true, healed: true, ... }` は 5〜8 行のフラットなオブジェクトリテラルであり、ヘルパー関数化しても行数削減がわずかな一方で各分岐の返却フィールドの視認性・型推論の直接性が下がるため、本計画の対象外とする。

---

## 3. 実装フェーズと構成

すべての変更は単一のリリース `v0.1.27` として以下の論理ステップ順に進める。

| Step                         | 内容                                                                                                                                                                                                                                                | 対象ファイル                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Step 1 (P1 + P2)**         | `retrackLocalHashOnly()`（`src/db/baseline.ts`）と `reconstructBaseline()` / `isLocalFileUnmodified()`（`src/sync/baseline-reconstruction.ts`）を実装し、`status.ts` / `diff.ts` / `doctor.ts` / `delete.ts` / `orchestrator.ts` / `pull.ts` に適用 | `src/db/baseline.ts`, `src/sync/baseline-reconstruction.ts`, `src/sync/{status,diff,doctor,delete,orchestrator,pull}.ts` |
| **Step 2 (P3)**              | `src/cli/report-failure.ts` を新設し、5 コマンドの `reportActionFailure` を統合（二重 `❌` 防止付き）                                                                                                                                               | `src/cli/report-failure.ts`, `src/cli/commands/{delete,new,conflicts,doctor,media}.ts`                                   |
| **Step 3 (T1 + T2 + T3/T4)** | `src/utils/taxonomy-key.ts` 新設、`src/sync/taxonomies.ts` の保存・prune ループ統合および `compareTaxonomyTermDeterministically` 共通化                                                                                                             | `src/utils/taxonomy-key.ts`, `src/sync/taxonomies.ts`, `src/sync/merge.ts`, `src/sync/new.ts`                            |
| **Step 4 (P4 + P5)**         | MCP `formatToolTextWithMeta` / `withResolvedContext` 共通化、Preflight `src/sync/preflight/image_probe.ts` 抽出                                                                                                                                     | `src/mcp/tools/*`, `src/sync/preflight/image_probe.ts`, `src/sync/preflight.ts`                                          |
| **Step 5 (Tests & Gate)**    | `tests/layering.test.ts` の `LAYER_1_FILES` 更新、新規単体・統合テスト追加、ドキュメント（`AGENTS.md`, `CHANGELOG.md`, `package.json`）更新                                                                                                         | `tests/*`, `AGENTS.md`, `CHANGELOG.md`, `package.json`                                                                   |

---

## 4. アーキテクチャ Gate（`tests/layering.test.ts`）への適合検証

| 新設・変更モジュール                          | 配置 Layer  | 許可される import                                                                                                                                                      | Gate 影響                                                                                                                                                                                                         |
| --------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/db/baseline.ts` (`retrackLocalHashOnly`) | **Layer 0** | Layer 0 のみ（`node:crypto`, `utils/frontmatter`, `db/cache`）                                                                                                         | Gate 不変。Layer 1・Layer 2 の全モジュールから import 可能                                                                                                                                                        |
| `src/utils/taxonomy-key.ts`                   | **Layer 0** | Layer 0 のみ（`utils/frontmatter`）                                                                                                                                    | Gate 不変                                                                                                                                                                                                         |
| `src/sync/baseline-reconstruction.ts`         | **Layer 1** | Layer 0（`db/baseline`, `db/cache`, `utils/disk-spelling`, `utils/naming`）＋同層 `sync/taxonomies` ＋ Workspace Contracts（`sync/workspace`、Layer 0 相当の共通契約） | `tests/layering.test.ts` の `LAYER_1_FILES` に `'sync/baseline-reconstruction.ts'` を追加（**`LAYER_1_FILES` は検査対象列挙であり未登録時は Axis 1 検査が素通しになるため登録必須**）。Layer 2 allowlist 追加不要 |
| `src/sync/preflight/image_probe.ts`           | **Layer 1** | Layer 0（`node:fs`, `utils/media`）                                                                                                                                    | `tests/layering.test.ts` の `LAYER_1_FILES` に `'sync/preflight/image_probe.ts'` を追加（**未登録時は Axis 1 検査が適用されないため登録必須**）                                                                   |
| `src/cli/report-failure.ts`                   | **Layer 3** | Layer 0（`client/error`）＋ Layer 2 allowlist 既存シンボル（`CanonicalHasUnpushedEditsError`, `QuarantinedPathRequiredError`）                                         | `cli/commands/*` から import。MCP からは import しない（Axis 3 維持）                                                                                                                                             |
| `src/mcp/tools/shared.ts`                     | **Layer 3** | Layer 0 + MCP 型                                                                                                                                                       | `cli/commands/*` を import しない（Axis 3 維持）                                                                                                                                                                  |

---

## 5. テスト計画（不変条件を固定する Guard Tests）

| #   | テストファイル                                  | 保証する不変条件（Invariants）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 対応項目          |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 1   | `tests/baseline_reconstruction.test.ts`（新設） | ① `retrackLocalHashOnly()` が `base_snapshots` を変更せず `sync_state.local_hash` のみを更新すること（untracked 時は `null`）。<br>② `localMediaRefs` 等で生ハッシュがズレている未編集ファイルに対し、`emit status` より**先に** `inspectArticleDiff` / `runWorkspaceDoctor` / `deleteArticle(dryRun)` を呼んでも、`status: 'synced'`（`🟡 Modified` にならない）・divergence なし・未プッシュエラーなしと判定され、自己修復されること。<br>③ `syncState === null`（`saveBaseSnapshot()` のみ投入し `sync_state` レコードが無い人工フィクスチャ；`base_snapshots` すら無い `status: 'untracked'` とは区別）の境界ケースでは `inspectArticleDiff` が従来どおり `status: 'modified'` を返すこと。 | P1, P2, 発見 ①・② |
| 2   | `tests/cli.test.ts`（拡張）                     | `new` / `delete` 等で①専用エラー（`DuplicateSlugError` 等）発生時に `❌ Error: ❌ ...` と二重にならず 1 行目が `❌` で始まること、②一般 `Error` 発生時にも `❌ Error: ...` が付与されること、③スタックトレースが出ないこと。                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | P3, 発見 ③        |
| 3   | `tests/taxonomies_two_layer.test.ts`（拡張）    | ① Canonical slug 衝突時、`compareTaxonomyTermDeterministically` により **Layer A winner（`slugToId`）と Layer B 勝者（`getLocalTaxonomiesSummary`）が同一 term ID** に収束すること。<br>② `pullTaxonomies` で片方（例: tags）の fetch が失敗（null）した際、既存の定義 YAML が prune されず保持されること。                                                                                                                                                                                                                                                                                                                                                                                     | T1, T2, T3/T4     |
| 4   | `tests/layering.test.ts`（更新）                | `LAYER_1_FILES`（Axis 1 検査対象列挙）に `sync/baseline-reconstruction.ts` と `sync/preflight/image_probe.ts` を追加し、4 層アーキテクチャ制約を 100% 維持すること。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Gate 整備（§4）   |

---

## 6. Rev.1 未決定事項の設計決定記録（Resolved in Rev.2）

1. **`retrackLocalHashOnly()` の配置先** → **決定: Layer 0 (`src/db/baseline.ts`)**
   - `CacheDatabase` と `BaseSnapshot` が既に Layer 0（`src/db/`）に存在するため、`src/db/baseline.ts` に配置することで Layer 1（`status.ts`, `diff.ts`）と Layer 2（`pull.ts`, `orchestrator.ts`, `doctor.ts`, `delete.ts`）の双方からレイヤー境界の例外なしで呼び出せる。
2. **P3 エラー出力フォーマットの統一範囲** → **決定: 先頭 `❌` 判定付きの `❌ Error: ${msg}` 統一**
   - `DuplicateSlugError` / `UnpushedModificationsError` / `PublishedArticleDeletionForbiddenError` 等は既に `error.message` の先頭に `❌` を持つため、`msg.trimStart().startsWith('❌') ? msg : \`❌ Error: ${msg}\``とすることで二重`❌`を防ぎつつ全エラーで先頭`❌` 不変条件を保証する。
3. **T2 の categories `slug` 昇順ソート** → **決定: 表示用の第 1 キーとして維持し、同一 `slug` 内の第 2 キーに `compareTaxonomyTermDeterministically` を使用**
   - `dedupeBySlug` は同一 `slug` グループ内で先頭要素を選ぶため、第 1 キーが `slug` 昇順でも同一 `slug` 内では `a.slug === b.slug` となり、`compareTaxonomyTermDeterministically`（`count desc → id desc`）によって Layer A と完全に同じ勝者が選ばれる。
4. **P4 の MCP メタデータ付きテキスト応答ヘルパー** → **決定: `formatToolTextWithMeta(text, meta)` を `src/mcp/tools/shared.ts` に新設**
   - JSON シリアライズ用の `formatToolSuccess(data)` と責務を分離し、型安全性を保つ。
5. **`doctor.ts:389`（および `delete.ts:144`）の `diskHash !== state.localHash` 判定** → **決定: Step 1（P2）に統合して `isLocalFileUnmodified()` 経由に統一**
   - `emit status` 実行前に `emit doctor` や `emit delete`（や `emit diff`）を実行した場合でも、表記差のみのファイルを未プッシュ変更と誤認しないよう Step 1 で一括解消する。

---

## 7. 完了条件

- `npm run check`（`format:check` + `typecheck` + `test`）が **error ゼロ・全 test green**。
- `tests/layering.test.ts` が新設 Layer 1 モジュールを含めて green。
- `AGENTS.md` / `CHANGELOG.md` / `package.json`（`0.1.27`）が更新されていること。

---

## 8. v0.1.25 / v0.1.26 で閉じた項目（再発防止の参照）

| 項目                                          | 解決コミット          | 現在の実装                                                                                                              |
| --------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `merge_stage.ts` の disk 出力 localization    | `6913b92`             | `resolveDiskSpelling(currentDisk, syncState)` → `renderForDisk(...)`。taxonomy-only conflict では現 disk 内容を読み直す |
| MCP `sync_status` の draft 件数露出           | `6913b92`             | `summary.flags.hasUnpublishedDraft`（`status.ts:312` と `sync-status.ts:128`）                                          |
| commit 系（disk + baseline + sync_state）集約 | `312e2fe`             | `commitArticleSnapshot()`（`bumpBaselineHashOnly` モード含む）                                                          |
| taxonomy 定義 YAML Two-Layer 化               | `f7d57da` / `c1dcbca` | `serializeTaxonomyYaml()` + `canonicalSlug` 二層 + `readTaxonomyDir()` の legacy 互換読込                               |
