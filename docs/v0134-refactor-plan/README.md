# v0.1.34 実装計画書: CLI/MCP 表示整形の集約とスタイル統一（Rev.7）

- **対象バージョン**: `v0.1.34`
- **作成日**: 2026-11-15 (Rev.7 — 部分失敗セマンティクス是正明記版)
- **ステータス**: 起案（Pending Review — オーナー承認不要範囲・高 ROI 項目に集中）
- **目的**:
  1. CLI と MCP に分散している pull 系の表示整形ロジック（taxonomy 同期失敗通知 / 成功サマリ / media サマリ / ウィンドウ表示）を Layer 3 の共有モジュール `src/presentation/` に集約し、**CLI-MCP 間の文言ズレを構造的に排除**する。
  2. 部分失敗時（片方のみ失敗時）の出力セマンティクスを MCP 側（警告優先・不完全サマリ抑止）に統一し、CLI-MCP 間の挙動乖離を意図的に是正する。
  3. `src/cli/commands/pull.ts` にて後方互換 re-export を 2 ブロックで正確に維持し、既存テスト（`tests/presentation_symmetry.test.ts`, `tests/media.test.ts` 等）を 100% 無変更で通過させる。
  4. `tests/presentation_symmetry.test.ts` を拡張し、CLI と MCP が同一の presentation 関数を使用していることを静的走査および動的出力一致で保証する（drift 防止レール）。
  5. バレルファイル・import 配置のスタイル不整合を解消し、欠落している 12 ファイルにライセンスヘッダーを追加してリポジトリの規約遵守性を完全化する。
  6. 未記載となっている CHANGELOG（v0.1.29 / v0.1.32 / v0.1.33 / v0.1.34）を降順で正確な位置に同期する。
- **本計画書のスコープ外（意図的除外 / 将来送り）**:
  - `buildPullMediaOptions` の集約（`PullMediaOptions` の import が `ALLOWED_LAYER_2_SYMBOLS['media']` に抵触し Axis 2 違反となるため、表示層の改修スコープから除外し、将来の Sync/Orchestrator 課題へ分離）
  - `runPreflightChecks` の細切れ分割（同期的な直列バリデーションであり、9 ファイル分割は認知負荷増大・過剰分割となるため見送り）
  - `runWorkspaceDoctor` の分割（粗粒度分割は将来的な検討事項とし、本改修のスコープを絞るため保留）
  - Ask First Policy 該当事項（`cache.ts` / `migrations.ts` の変更、`ALLOWED_LAYER_2_SYMBOLS` の変更）

---

## 1. 現状の実測スナップショット（2026-11-15 v0.1.33 時点）

すべての数値は実際のツールで計測した結果であり、推定を含まない。

| 項目 | 実測値 | 検査コマンド |
| --- | --- | --- |
| `src/` 総行数 | **24,700 行**（104 モジュール） | `find src -name '*.ts' \| xargs wc -l` |
| テスト | 63 files / 674 tests 全 green | `npm run test` |
| 静的品質ゲート | `format:check` / `typecheck` / `check:cycles` / `test` 全 green | `npm run check` |
| 循環依存 | **0 件**（v0.1.33 で解消済み） | `npx --yes madge@8.0.0 --circular --extensions ts src/` |
| 非 CLI 層の `console.log` / `console.debug` | **0 件**（Axis 5 PASS） | `grep -rn 'console\.\(log\|debug\)' src \| grep -v 'src/cli/'` |
| TODO / FIXME / deprecated マーカー | **0 件** | `grep -rn 'TODO\|FIXME\|XXX\|HACK\|@deprecated' src` |
| ライセンスヘッダー保有ファイル | 92 / 104（12 ファイル欠落） | `grep -rl 'Copyright (C) 2026 SPORT-SERVICE' src` |

---

## 2. 課題分析と実測根拠

### 2.1 課題 R-2: CLI / MCP の pull 表示ロジック重複と文言ズレ（主課題）

`AGENTS.md` は「Layer 3 intra-layer 隔離（MCP → `src/cli/commands/` import 禁止）」「共有整形は `src/presentation/` に置く」を規則化し、`tests/layering.test.ts` の Axis 3 でこれを検査している。しかし現状の実装は規約に完全には追随していない。

#### 実測 A — taxonomy 失敗通知の文言が CLI と MCP で 7 パターンに分裂:
```text
src/cli/commands/pull.ts:121   "⚠️  Failed to fetch remote categories: preserved existing local definitions."
src/cli/commands/pull.ts:125   "⚠️  Failed to fetch remote tags: preserved existing local definitions."
src/cli/commands/pull.ts:368   "⚠️ Warning: Failed to sync taxonomies: ${singlePull.taxonomies.error}"
src/cli/commands/pull.ts:371   "⚠️ Warning: Failed to sync some remote taxonomies (preserved existing local definitions)."
src/mcp/tools/sync-pull.ts:149 "⚠️ Taxonomies: Failed to fetch remote {categories and tags} (preserved existing local definitions)."
src/mcp/tools/sync-pull.ts:232 "⚠️ Taxonomies: Failed to sync remote taxonomies ({error}, preserved existing local definitions)."
src/mcp/tools/sync-pull.ts:341 "⚠️ Warning: Failed to fetch remote {…} (preserved existing local definitions in categories/ and tags/)."
```
同一事象（taxonomy 同期失敗 + ローカル定義保持、または error 発生）に対し、接頭辞（`⚠️ ` / `⚠️ Warning:` / `⚠️ Taxonomies:`）、区切り（`: ` / `( … )`）、用語（`fetch remote categories` / `sync remote taxonomies` / `sync some remote taxonomies`）が分裂している。
AI エージェントが CLI 出力の正規表現パターンを MCP 出力に流用できず、挙動の差異や解析ミスの要因となる。

#### 実測 B — 整形関数の配置不整合:
| 関数 | 現在の実体 | 参照元 | 判定の理由 |
| --- | --- | --- | --- |
| `formatOrphanMediaWarning` | `src/presentation/article_report.ts:37` | CLI, MCP 両方 | ✅ 規約準拠（共有 presentation） |
| `formatMediaCoverageLine` | `src/presentation/article_report.ts:56` | CLI, MCP 両方 | ✅ 規約準拠（共有 presentation） |
| `formatPrunedTaxonomiesNotice` | `src/presentation/article_report.ts:113` | CLI, MCP 両方 | ✅ 規約準拠（共有 presentation） |
| `printTaxonomySyncSummary` | `src/cli/commands/pull.ts:109` | CLI のみ（`:246`, `:448`） | ❌ 文言生成ロジックが CLI private に閉じており MCP と非共有 |
| `formatArticleMediaSummary` | `src/cli/commands/pull.ts:77` | CLI と `tests/media.test.ts:41` | ❌ CLI 内 export（MCP は独自整形） |
| `formatPullStatusBreakdown` | `src/cli/commands/pull.ts:99` | CLI と `tests/cli.test.ts:29` | ❌ CLI 内 export（Presentation 層未集約） |
| `formatPullWindowLabel` | `src/cli/commands/pull.ts:52` | CLI と `tests/cli.test.ts:29` | ❌ CLI 内 export（Presentation 層未集約） |

`src/presentation/article_report.ts`（126 行）とは別に、pull 系の整形関数が `src/cli/commands/pull.ts`（596 行）に残置されている。

---

### 2.2 課題 R-3: バレルファイルおよび import 配置・ヘッダーのスタイル不整合

1. **バレル 3 ファイルの不整合**:
   - `src/sync/pull.ts` (23 行): ヘッダーあり、説明コメントなし
   - `src/sync/push.ts` (26 行): ヘッダーあり、説明コメントあり
   - `src/sync/media.ts` (1 行): ヘッダーなし、説明コメントなし（`export * from './media/index.js';` のみ）
2. **import 文の位置の不統一**:
   - `src/cli/commands/pull.ts` で `presentation/article_report.ts` からの import が 64〜68 行目（関数定義・doc comment の直後）に置かれ、70 行目でそのまま re-export されている。
3. **ライセンスヘッダー欠落 12 ファイル**:
   - `src/utils/media-refs.ts`, `src/sync/guards.ts`, `src/sync/media.ts`, `src/sync/media/{mirror_item, remote_index, body_scan, pull_article, companions, types, naming_mirror, pull_library, index}.ts`。これらは v0.1.32 以降に追加された新規モジュールであり、既存 92 ファイルと不整合。

---

## 3. 詳細設計と改修仕様

### 3.1 R-2: 表示整形の `src/presentation/` 集約（Layer 3）

**新設モジュール**: `src/presentation/pull_report.ts`  
既存 `article_report.ts`（diff / media レポート中心）とは責務を分離し、pull 実行時のサマリ・通知表示を独立モジュールとして配置する。

#### 提供する公開関数:

1. **`formatTaxonomySyncFailure(options)`**:
   - 責務: taxonomy 同期失敗時の警告メッセージ文字列生成（端末装飾や改行を含まないプレーンテキスト）。
   - 入力: `{ categoriesFailed?: boolean; tagsFailed?: boolean; error?: string }`
   - 統一後文言:
     - エラー詳細あり: `⚠️ Taxonomies: Failed to sync remote taxonomies ({error}, preserved existing local definitions).`
     - 両方失敗: `⚠️ Taxonomies: Failed to fetch remote categories and tags (preserved existing local definitions).`
     - カテゴリ失敗: `⚠️ Taxonomies: Failed to fetch remote categories (preserved existing local definitions).`
     - タグ失敗: `⚠️ Taxonomies: Failed to fetch remote tags (preserved existing local definitions).`
2. **`formatTaxonomySyncSuccess(counts, options?)`**:
   - 責務: taxonomy 同期成功時のサマリ行文字列生成。
   - 入力: `{ categoriesCount: number; tagsCount: number; deletedCategoriesCount?: number; deletedTagsCount?: number }`, `{ label?: string }`
   - 統一後文言: `✅ {label ?? 'Taxonomies'}: {n} categories, {m} tags{, k categories pruned}{, l tags pruned}`
3. **移動対象（CLI から presentation へ移管）**:
   - `formatArticleMediaSummary`（`pull.ts:77` より移動。引数は inline 構造体のため Layer 2 型に依存しない）
   - `formatPullStatusBreakdown`（`pull.ts:99` より移動）
   - `formatPullWindowLabel`（`pull.ts:52` より移動）

#### `printTaxonomySyncSummary` の処方と意図的なセマンティクス是正:
`src/cli/commands/pull.ts:109` の `printTaxonomySyncSummary` は、CLI 側の既存呼び出し（`:246` の `OrchestratorTaxonomiesResult`、`:448` の `PullTaxonomiesResult`）の両方を型安全に受け取れるよう、引数宣言を交差型とする：

```ts
function printTaxonomySyncSummary(
  res: PullTaxonomiesResult & { error?: string },
  indent = '',
  successLabel = 'Taxonomies:',
  suffix = '',
): void {
  if (res.error || res.categoriesFailed || res.tagsFailed) {
    const failureMsg = formatTaxonomySyncFailure({
      categoriesFailed: res.categoriesFailed,
      tagsFailed: res.tagsFailed,
      error: res.error,
    });
    console.warn(`${indent}${failureMsg}`);
    return;
  }

  const successLine = formatTaxonomySyncSuccess(res, {
    label: successLabel.replace(/:$/, ''),
  });
  console.log(`${indent}${successLine}${suffix}`);
}
```

- **意図的な部分失敗セマンティクス是正（Behavioral Alignment）**:
  現状の CLI 実装（`pull.ts:127` `if (!res.categoriesFailed || !res.tagsFailed)`）は、片側失敗時（例: categories 失敗、tags 成功）に「失敗警告」と「成功サマリ行」の**両方を出力**していた。一方、MCP 側（`sync-pull.ts:231-246`）は片側失敗時に警告のみを出力し不完全な成功行を出力しない。
  本改修では、片側失敗時に「不完全な成功サマリ」を出力することはユーザーおよび AI エージェントに誤認を与えるため、**MCP 側のセマンティクス（部分失敗時は警告に倒し、成功行を出力しない）に統一することを意図的な仕様改善として採用**する。
- **単一記事 pull 側（`pull.ts:366-373`）の統合**:
  単一記事 pull 側の 2 分岐警告（`Failed to sync taxonomies:` / `Failed to sync some remote taxonomies`）も `formatTaxonomySyncFailure(singlePull.taxonomies)` の単一呼び出しへ移行し、実測 A のパターン 3・4 の文言分裂を完全に解消する。

#### 後方互換 re-export の維持（2 ブロック構成）:
`src/cli/commands/pull.ts` において、移動元モジュールごとに 2 つの明確なブロックで後方互換 re-export を配置する：

```ts
// 1. Re-exports from presentation/article_report.js (existing, required by tests/presentation_symmetry.test.ts)
export {
  formatOrphanMediaWarning,
  formatMediaCoverageLine,
  formatPrunedTaxonomiesNotice,
} from '../../presentation/article_report.js';

// 2. Re-exports from presentation/pull_report.js (new, required by tests/media.test.ts and tests/cli.test.ts)
export {
  formatArticleMediaSummary,
  formatPullStatusBreakdown,
  formatPullWindowLabel,
  formatTaxonomySyncFailure,
  formatTaxonomySyncSuccess,
} from '../../presentation/pull_report.js';
```

これにより、`formatPrunedTaxonomiesNotice` の欠落を防ぎ、既存の `tests/presentation_symmetry.test.ts`、`tests/media.test.ts`、`tests/cli.test.ts` の import を一切壊すことなく通過させる。

#### 層境界とアクセス規則:
- `src/presentation/pull_report.ts` は **Layer 0 のみ**（型や基本ユーティリティ）を参照し、Layer 2（`sync/media` 等）は一切 import しない。
- これにより、`tests/layering.test.ts` の `ALLOWED_LAYER_2_SYMBOLS` を改変することなく、Axis 0〜5 の静的レイヤリング検査を 100% Green のまま維持する。
- CLI コマンド（`src/cli/commands/pull.ts`）および MCP ツール（`src/mcp/tools/sync-pull.ts`）の双方が `src/presentation/pull_report.js` を import して使用する。

---

### 3.2 R-3: バレル・import・ヘッダーのスタイル統一

1. **バレル統一**:
   - `src/sync/media.ts` にライセンスヘッダーと説明コメントを追加し、`pull.ts` / `push.ts` と同一の体裁（ヘッダー → 説明コメント → `export * from './<dir>/index.js';`）に統一。
2. **import 位置の統一**:
   - `src/cli/commands/pull.ts` の 64〜68 行目にあった presentation からの import を先頭ブロック（27 行目まで）に統合。
3. **ライセンスヘッダー欠落 12 ファイルへの追加**:
   - 既存ファイルと同一の MIT ライセンスヘッダー（SPORT-SERVICE RS★R 著作権表示）を先頭に付与。

---

## 4. 実装手順とタスク分解（Phase 計画）

| Phase | 作業内容 | 対象ファイル | 検証方法 |
| --- | --- | --- | --- |
| **Phase 0** | **スタイル・ヘッダー統一 (R-3)**<br>・欠落 12 ファイルへヘッダー付与<br>・`src/sync/media.ts` バレルコメント整備<br>・`src/cli/commands/pull.ts` import 位置是正 | `src/sync/media.ts`<br>`src/cli/commands/pull.ts`<br>ヘッダー欠落 12 ファイル | `npm run check` PASS 確認 |
| **Phase 1** | **表示ロジック集約と文言統一 (R-2)**<br>・`src/presentation/pull_report.ts` 新設<br>・`printTaxonomySyncSummary` および単一 pull 警告を presentation 関数呼び出しへリファクタリング（部分失敗セマンティクス是正）<br>・CLI / MCP の taxonomy 失敗/成功通知呼び出し移行<br>・`src/cli/commands/pull.ts` に 2 ブロックの後方互換 re-export を配置 | `src/presentation/pull_report.ts`<br>`src/cli/commands/pull.ts`<br>`src/mcp/tools/sync-pull.ts`<br>`tests/mcp.test.ts` | `npm test` PASS 確認（`tests/mcp.test.ts:366` の反転 assert を含む） |
| **Phase 2** | **Symmetry テスト拡張と CHANGELOG 同期**<br>・`tests/presentation_symmetry.test.ts` に CLI / MCP の pull 整形共有アサートを追加<br>・`CHANGELOG.md` に 0.1.29 / 0.1.32 / 0.1.33 / 0.1.34 を追記・同期（降順・既存 `[Unreleased]` 保持）<br>・バージョンバンプ (`0.1.34`) と最終品質検査 | `tests/presentation_symmetry.test.ts`<br>`CHANGELOG.md`<br>`package.json`<br>`package-lock.json` | `npm run check`<br>全 63 files / 674+ tests PASS |

---

## 5. テスト影響範囲と新規テスト要件

### 5.1 既存テストへの影響
- `src/cli/commands/pull.ts` で 2 ブロックの後方互換 re-export を維持するため、`tests/cli.test.ts`、`tests/media.test.ts`、`tests/presentation_symmetry.test.ts` の既存テストは変更なしでそのまま通過する。
- **実測上の重要事項（未保護領域の認識）**:
  現状のテストスイートには taxonomy 同期通知文言（`preserved existing local definitions`、`Failed to sync taxonomies:` 等）を直接検証する golden assertion は存在しない。そのため文言変更や単一 pull 警告の 1 経路統合によって既存テストが壊れることはないが、逆に「正しく統一されたか」を既存テストで検証することはできないため、§5.2 の新規テストが不可欠な検証基盤となる。
- **反転 assert の監視**:
  `tests/mcp.test.ts:366`（`expect(resPostsOnly.content[0].text).not.toContain('Taxonomies:');`）は、`postsOnly: true` 時に `'Taxonomies:'` を含まないことを要求する。新設する `formatTaxonomySyncSuccess` / `formatTaxonomySyncFailure` の呼び出し移行後も、`postsOnly: true` 時にこの文言が出力に含まれないことを確実に維持する。

### 5.2 新規テスト要件（`tests/presentation_symmetry.test.ts` 拡張）
1. **静的走査検査**: CLI（`src/cli/commands/pull.ts`）と MCP（`src/mcp/tools/sync-pull.ts`）が、taxonomy 同期通知関数（`formatTaxonomySyncFailure`, `formatTaxonomySyncSuccess`）を同一の `src/presentation/pull_report.js` から import していることをソース走査で検証する（Rule 5 / Axis 3 と同型の静的検査）。
2. **動的出力一致検査**: `formatTaxonomySyncFailure` および `formatTaxonomySyncSuccess` に同一入力を与えたとき、CLI re-export 経由と presentation モジュール直接呼び出しでバイト単位で同一の結果が得られることを検証する（既存の `formatOrphanMediaWarning` テストと同型）。

---

## 6. Ask First Policy との対応表

| 施策 | 該当カテゴリ判定 | 結論 |
| --- | --- | --- |
| **R-3 スタイル・ヘッダー統一** | 4 カテゴリいずれにも該当しない（新規ファイルへの既存規約適用、コメント修正のみ） | **承認不要** |
| **R-2 表示整形集約** | カテゴリ 3「Public Facade / Orchestrator API breaking changes」に該当しない（Orchestrator の signature や戻り値は不変。Layer 3 内部の整形関数集約のみ）<br>※ `ALLOWED_LAYER_2_SYMBOLS` にも一切変更を加えないため、Commit Readiness Checklist 項目 5 に抵触しない。 | **承認不要** |

---

## 7. リスクと mitigation

| リスク | 発生条件 | mitigation |
| --- | --- | --- |
| `tests/mcp.test.ts:366` の反転 assert 破壊 | `postsOnly: true` 時に誤って `Taxonomies:` 文言を出力する | `sync-pull.ts:229` の既存ガード `if (batchResult.taxonomies)` 内にのみ通知構築を限定し（`postsOnly: true` 時に orchestrator が `taxonomies` を `undefined` として返す契約と整合）、反転テストを green に維持する。 |
| 部分失敗時の出力変更によるユーザー影響 | 片側失敗時に成功サマリ行が出なくなる | MCP 側との整合（不完全なサマリによる誤認防止）を目的とした意図的な改善であることをドキュメント化し、警告メッセージ側に失敗項目を明記することで透明性を担保する。 |
| Axis 3 違反（MCP → CLI の不正 import） | 共有関数を CLI に残したまま MCP から参照する | `src/presentation/pull_report.ts` に関数を完全に配置してから、CLI・MCP 双方から import する順序を徹底する。 |
| 循環依存 | presentation が下位層と相互参照する | `pull_report.ts` は Layer 0 のみを参照し、完全な一方向依存を保証する（Layer 2 は import しない）。 |
| re-export 欠落による既存テスト破壊 | `formatPrunedTaxonomiesNotice` 等が抜け落ちる | §3.1 の 2 ブロック re-export 規約を遵守し、既存の symmetry テストがそのまま通過することを検証する。 |

---

## 8. 完了条件（DoD: Definition of Done）

1. [ ] `src/presentation/pull_report.ts` が新設され、`formatTaxonomySyncFailure`、`formatTaxonomySyncSuccess`、`formatArticleMediaSummary`、`formatPullStatusBreakdown`、`formatPullWindowLabel` が集約されていること。
2. [ ] `src/cli/commands/pull.ts` および `src/mcp/tools/sync-pull.ts` が `src/presentation/pull_report.ts` を共有し、taxonomy 同期失敗通知の文言分裂（7 パターン）が解消されていること。
3. [ ] `src/cli/commands/pull.ts` の `printTaxonomySyncSummary` がリファクタリングされ、部分失敗時の出力セマンティクスが MCP 側（警告優先・不完全サマリ抑止）と統一されていること。
4. [ ] `src/cli/commands/pull.ts` に 2 ブロックの後方互換 re-export（`article_report.js` 由来 3 関数 + `pull_report.js` 由来 5 関数）が配置され、既存の `tests/presentation_symmetry.test.ts` および `tests/media.test.ts` が無変更で通過すること。
5. [ ] `tests/presentation_symmetry.test.ts` に pull 整形の共有アサート（静的走査＋動的一致）が追加され PASS すること。
6. [ ] ライセンスヘッダー欠落 12 ファイルにヘッダーが付与され、バレルファイル（`src/sync/media.ts` 等）の体裁が統一されていること。
7. [ ] `CHANGELOG.md` において、既存 `[Unreleased]` を保持したまま、降順で `v0.1.34`, `v0.1.33`, `v0.1.32` が `0.1.31` の前に挿入され、`v0.1.29` が `0.1.30` と `0.1.28` の間に追記・同期されていること。
8. [ ] `package.json` および `package-lock.json` のバージョンが `0.1.34` に更新されていること。
9. [ ] `npm run check`（Prettier, TypeScript, Cycles, Vitest）がすべて PASS すること。

---

## 9. 本計画書が扱わない残存課題（将来版への引き継ぎ）

| ID | 課題 | 除外理由 |
| --- | --- | --- |
| **X-1** | `src/db/cache.ts`（709 行）のドメイン別分割 | Ask First カテゴリ 2・3。cohesion は高く分割メリットは薄い |
| **X-2** | `src/db/migrations.ts`（360 行）の宣言的 migration 表への再構成 | Ask First カテゴリ 2。schema v5 までの履歴不変条件と直結 |
| **X-3** | 全既存 92 ファイルのライセンスヘッダー一括削除・短縮 | Ask First カテゴリ 4 に近接。全ファイル一括編集は git blame 履歴への影響大 |
| **X-4** | `src/sync/merge.ts` と `push/merge_stage.ts` の G19 評価重複整理 | AGENTS.md が「merge path scope は意図的に厳格」と明記しており、仕様変更となる |
| **X-5** | `src/utils/frontmatter.ts` の `formatYamlScalar` 分離 | Baseline serialization invariant と直結しており、単独 refactor は高リスク |
| **X-6** | `runPreflightChecks`（約 440 行）の stage 分割 | 同期的な直列バリデーションであり、9 ファイル分割は認知負荷増大・過剰分割となるため見送り |
| **X-7** | `runWorkspaceDoctor`（約 610 行）の check 分割 | 必要性が高まった段階で「環境系 / データ整合系 / メディア系」の粗粒度 3 分割として別途検討（唯一の DB 副作用 `clearConflictsByKind()` の orchestrator 集約が論点） |
| **X-8** | `pullMedia` オプション構築（7 箇所）の集約 | `PullMediaOptions` が Layer 2 型であり、Presentation 層の集約に含めると Axis 2（`ALLOWED_LAYER_2_SYMBOLS`）違反となるため、将来の Sync/Orchestrator 課題へ分離 |
