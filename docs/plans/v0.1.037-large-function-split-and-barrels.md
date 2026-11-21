# v0.1.37 実装計画書: 巨大関数の分割とコンシューマ境界の収束（Rev.2）

- **対象バージョン**: `v0.1.37`
- **作成日**: 2026-11-17 (Rev.2 — レビュー指摘反映版: upload state write 配置の実測整合、CLI batch pull 出力の characterization test 前置、コミット分割規則追加)
- **ステータス**: 起案（Pending Review — P3 は Ask First カテゴリ 3 のオーナー確認を要する）
- **目的**:
  1. **P1: 巨大関数・God Function の分割** — 機能追加のたびに成長し続けている `runWorkspaceDoctor`（約 617 行）、CLI batch pull ハンドラ、`uploadMediaFile`（約 250 行）を、既存の `pull/`・`push/` stage 分割パターンと同じ粒度の純粋な Move Function で分解し、今後の差分サイズと認知負荷を抑える。
  2. **P2: CLI ⇔ MCP のオプション解決ロジック単一ソース化** — v0.1.34 で表示層（`src/presentation/pull_report.ts`）は統合済みだが、**limit・concurrency のフォールバック式**が Layer 3 全体に計 12 箇所ハードコードされている。Layer 0 の純粋リゾルバへ集約し、`localMediaRefs` で確立済みの `resolveLocalMediaRefsOption()` と同じパターンに揃える。
  3. **P3: Barrel リエントランスの収束** — `src/sync/pull.ts` / `push.ts` / `media.ts` の後方互換 barrel へ、Layer 3（10 箇所）とテスト（25 import / 20 ファイル）が今も依存している。Layer 3 を実体モジュール（`sync/pull/index.js` 等）へ張り替え、barrel を **npm パッケージ公開 API のみ**に限定する。
- **本計画書のスコープ外（意図的除外 / 将来版への引き継ぎ）**:
  - `src/db/cache.ts`（709 行）・`src/db/migrations.ts`（360 行）の分割 → Ask First カテゴリ 2。cohesion が高く分割メリットは薄い（v0.1.34 計画 X-1/X-2 から継続据え置き）
  - `runPreflightChecks`（約 440 行）の stage 分割 → 同期的直列バリデーションであり過剰分割（v0.1.34 計画 X-6 から継続）
  - `src/utils/frontmatter.ts` の `formatYamlScalar` 分離 → Baseline serialization invariant と直結、単独 refactor は高リスク（X-5 から継続）
  - ライセンスヘッダーの一括削除・短縮 → git blame 汚染が大きく効果は見た目のみ（X-3 から継続）
  - `tests/` の `as any` 1 箇所（`pull_draft_revision.test.ts:753`）→ 低優先、本版では見送り

---

## 1. 現状の実測スナップショット（2026-11-17 v0.1.36 時点）

すべての数値は実際のツールで計測した結果であり、推定を含まない。

| 項目 | 実測値 | 検査コマンド |
| --- | --- | --- |
| `src/` 総行数 | **25,128 行**（105 モジュール） | `find src -name '*.ts' -exec wc -l {} +` |
| テスト | 64 files / 690 tests 全 green | `npm test` |
| 静的品質ゲート | `typecheck`（src+tests）/ `test` 全 green、循環依存 **0 件** | `npm run typecheck` / `npx --yes madge@8.0.0 --circular --extensions ts src/` |
| `as any` / `@ts-ignore` / eslint-disable（src 内） | **0 件**（tests に 1 件のみ） | `grep -rn 'as any\|@ts-ignore\|eslint-disable' src` |
| 非 CLI 層の `console.log` / `console.debug` | **0 件**（Axis 5 PASS） | `grep -rn 'console\.\(log\|debug\)' src \| grep -v 'src/cli/'` |

### 巨大関数の実測内訳

| 関数 | ファイル | 行数規模 | 内部ブロック数 |
| --- | --- | --- | --- |
| `runWorkspaceDoctor` | `src/sync/doctor.ts:243`（全 859 行） | **約 617 行** | `checks.push()` **21 箇所**、番号付きセクション 9 個（1, 2, 3, 4, 4b, 4c, 4d, 5, 6, 7） |
| CLI batch pull ハンドラ | `src/cli/commands/pull.ts:~190-330` | **約 140 行** | taxonomy sync → `pullBatch` → メディア統計 → quarantine notice → pruning の直列塊 |
| `uploadMediaFile` | `src/client/media.ts:447`（全 843 行） | **約 250 行** | 明示コメント `[Phase A] upload-url`(:531) / `[Phase B] PUT`(:655) / `[Phase C] confirm`(:687) に加え、事前 dedup 検証（:485-530）がインライン |

---

## 2. 課題分析と実測根拠

### 2.1 課題 R-1 (P1): 巨大関数の残存

モジュール分割（v0.1.15 の `pull/`・`push/`・`media/` 分解）は完了しているが、**各ファイルの最重要関数自体が未分割**のまま残っている。

#### R-1a: `runWorkspaceDoctor`（`src/sync/doctor.ts:243-859`）

実測セクション構成（コメント行より）:

```text
  // 1. Version Compatibility Check          (:250)
  // 2. Origin & Profile Consistency Check   (:267)
  // 3. Frontmatter Syntax & Schema Integrity(:287)
  // 4. Conflicts & Quarantine Check         (:344)
  // 4b. Conflict Pending Alignment          (:369)
  // 4c. Taxonomy Apply Pending Check        (:459)
  // 4d. Delete Pending Check                (:477)
  // 5. Sync Status & Pending Modifications  (:495)
  // 6. Media References Integrity Check     (:520) + cache fallback / live probe / library census が継続
  // 7. MCP Process Check                    (:827)
```

v0.1.36 でも preservedBlocks 診断がこの関数に追加されており、**機能追加のたびに成長している**。`checks.push()` が 21 箇所あり、戻り値の `DoctorReport` 組み立てと各 check の生成が混在する。

#### R-1b: CLI batch pull ハンドラ（`src/cli/commands/pull.ts`）

`!targetId` 分岐内の 1 コールバックに、taxonomy 同期通知 → `pullBatch` 呼び出し → media 統計整形 → quarantine notice → pruning 結果処理が直列で約 140 行。MCP 側 `sync-pull.ts` の batch 分岐と構造的に並列しており、片方だけ変更する drift が起きやすい形状。

#### R-1c: `uploadMediaFile`（`src/client/media.ts:447-697`）

コード内コメントが既に Phase A/B/C の境界を明示しているにもかかわらず、全 phase が 1 関数にインライン。事前 dedup 検証（media_state 復元 + remote GET 確認）も同じ関数内に約 45 行存在する。

### 2.2 課題 R-2 (P2): limit / concurrency フォールバック式の散在

実測 — `DEFAULT_CONFIG` 参照が Layer 3 に **12 箇所**ハードコード:

```text
postsSyncLimit（legacy syncLimit フォールバック込み、同一式 2 箇所）:
  src/cli/commands/pull.ts:198      ctx.config.postsSyncLimit || ctx.config.syncLimit || DEFAULT_CONFIG.postsSyncLimit
  src/mcp/tools/sync-pull.ts:208    （同上・完全一致）

mediaSyncLimit（同一式 8 箇所）:
  src/cli/commands/pull.ts:234, :306, :344, :490
  src/mcp/tools/sync-pull.ts:143, :231, :291, :444（:444 は args.limit || ... の前置付き）

concurrency（既定値 8 のマジックナンバー 2 箇所 — DEFAULT_CONFIG.concurrency を参照していない）:
  src/cli/commands/pull.ts:202      ctx.config.concurrency || 8
  src/sync/orchestrator.ts:371      options.concurrency || 8
```

- v0.1.15 計画 R4 は「DEFAULT_CONFIG を唯一の正本」と宣言したが、**参照側の統一（呼び出し箇所の集約）は未実施**で、v0.1.32 計画が「計 8 箇所にハードコード」と指摘した名残が実測 12 箇所として残存。
- `concurrency` は `DEFAULT_CONFIG.concurrency = 8` が存在するのに **2 箇所ともマジックナンバー 8 を直書き**しており、正本参照ですらない（R4 の趣旨に直接違反）。
- 表示層は v0.1.34 で統合済みだが、**オプション解決**は CLI/MCP に二重化されたまま。`localMediaRefs` は既に Layer 0 純粋リゾルバ（`src/utils/media-ref-precedence.ts:resolveLocalMediaRefsOption()`）へ統合済みで、**同じパターンを適用する前例が確立している**。

### 2.3 課題 R-3 (P3): Barrel リエントランスへの依存残存

`src/sync/pull.ts` / `push.ts` / `media.ts` は `export * from './<dir>/index.js';` のみの薄い互換層だが、**下流が今も barrel 経由で import** している:

- **Layer 3（10 箇所）**:
  ```text
  src/cli/commands/pull.ts:25 (formatQuarantineNotice ← pull.js), :35 (pullMedia ← media.js)
  src/cli/commands/push.ts:24 (pushArticle, PushResult ← push.js)
  src/cli/commands/media.ts:24 (collectLocalMirrorIndex, searchRemoteMedia ← media.js)
  src/cli/report-failure.ts:26 (PushValidationError ← push.js)
  src/mcp/tools/sync-pull.ts:26 (formatQuarantineNotice ← pull.js), :37 (pullMedia ← media.js)
  src/mcp/tools/sync-push.ts:26 (pushArticle ← push.js)
  src/mcp/tools/sync-media-search.ts:25 (collectLocalMirrorIndex, searchRemoteMedia ← media.js)
  src/mcp/tool-errors.ts:27 (PushValidationError ← push.js)
  ```
- **テスト（25 import / 20 ファイル）**: `tests/corpus_taxonomy.test.ts`, `tests/sync.test.ts`, `tests/pull_pagination.test.ts` など。
- **実体 import を使っている箇所との不整合**: `orchestrator.ts:378` は `./pull.js`（barrel）、`pull/media_stage.ts:51`・`push/media_stage.ts:35` は `../media.js`（barrel、layering スナップショットで許可済み）。一方 `media/pull_article.ts` 等の内部モジュールは実体を直接 import しており、**同一知識への到達経路が二重化**している。

barrel 自体は AGENTS.md が「backward-compatible barrel re-export」として明文化した設計であり撤廃しないが、**barrel の役割を npm 公開 API（`src/index.ts:47,52,53`）に限定し、リポジトリ内部の import は実体へ統一する**ことで、「public façade と内部配線の分離」を完成させる。

---

## 3. 詳細設計と改修仕様

### 3.1 R-1a: `runWorkspaceDoctor` の check 分割（Layer 2 内）

**方針**: v0.1.34 計画 X-7 が留保していた「粗粒度 3 分割」を、**同一ファイル内 private 関数への Move Function**として実施する。新設ディレクトリ・新規 barrel は作らない（過剰分割の回避）。

```
src/sync/doctor.ts（再編後）
├── runWorkspaceDoctor()            … オーケストレーター（約 60 行: check 呼び出し + overall status 判定）
├── runEnvironmentChecks(ctx)       … Check 1 (Version), 2 (Origin/Profile), 7 (MCP Process)
├── runContentIntegrityChecks(ctx)  … Check 3 (Frontmatter), 4/4b/4c/4d (Conflict/Pending/Delete), 5 (Sync Status)
└── runMediaIntegrityChecks(ctx)    … Check 6 (Media References + cache fallback + live probe + library census)
```

- 共通の `DoctorCheckContext = { options, config, collection, cache, checks: DoctorCheckResult[] }` を private interface として定義し、各 check 群が `checks.push()` する。
- **DB write 副作用**（conflict pending の整合時 `clearConflictsByKind()`）は現状どおり orchestrator 本体に留め、check 関数内からは DB read のみを行う（read-only 原則）。
- `scanArticleMediaDetailed` / `classifyMediaUrl` / `countMirroredMedia` / `isInlineCodeSpan` は既存のまま Check 6 群の helper として機能する。
- **公開シグネチャ `runWorkspaceDoctor(options): Promise<DoctorReport>` は完全不変**。`ALLOWED_LAYER_2_SYMBOLS['doctor'] = { runWorkspaceDoctor }` も不変。

### 3.2 R-1b: CLI batch pull ハンドラの分割（Layer 3 内）

`src/cli/commands/pull.ts` の `!targetId`（batch）コールバックを private 関数へ分解:

```
runBatchPull(ctx, options, ...)               … 約 40 行のオーケストレーター
├── printBatchPullHeader(...)                 … window label / concurrency 通知
├── printBatchPullResults(batchResult, ...)   … サマリ・preserved・quarantine notice（presentation 関数呼び出し）
└── runIncludeMediaStage(ctx, options, ...)   … `--media` 時の pullMedia と結果表示
```

- MCP 側（`sync-pull.ts` batch 分岐）は v0.1.34 で presentation を共有済みであり、**本 R-1b は CLI ファイル内の分解のみ**（Axis 3 制約により MCP から CLI private は参照不可、共有化は presentation 層が担う）。
- 出力文言・順序は **バイト単位で不変**とする。

**回帰レールの実測是正（Rev.2 改訂）**: Rev.1 では「`tests/cli.test.ts` がそのまま回帰レール」と記述したが、実測では同ファイルの pull 系テストは **コマンド定義・option 公開・invalid target 時のエラー行検証のみ**で、batch pull ハンドラが出力するサマリ行（`🎉 Articles: …`）、preserved/quarantine notice、media 統計行を console 出力として検証しているケースは **0 件**である（`pullBatch` を叩く `orchestrator_pull_batch.test.ts` 等はすべて Layer 2 レベルで、CLI ハンドラ経由ではない）。
したがって分解に先立ち、**characterization test を先に追加する**（Phase 1 の前段タスク、§5.4 参照）。出力 snapshot が取得できて初めて「バイト単位不変」がゲート化される。

### 3.3 R-1c: `uploadMediaFile` の phase 分割（Layer 0 内）

`src/client/media.ts` 内で private 関数へ分解（ファイル移動なし）:

```
uploadMediaFile()                    … 約 40 行のオーケストレーター（buffer 解決 → MIME/サイズ検証 → dedup → Phase A→B→C）
├── resolveReusableUpload(...)       … media_state dedup + GET /_emdash/api/media/{id} 検証（現 :485-530）
├── requestUploadTarget()            … 既存（Phase A、変更なし）
├── putBinaryStream(...)             … Phase B（same-origin streaming / signed URL の分岐）
└── confirmUpload(...)               … Phase C（POST .../confirm + syncRemoteMediaMetadata）
```

**state write 配置の実測根拠に基づく厳密化（Rev.2 改訂）**: Rev.1 では「phase 関数は state write を行わない」と記述したが、これは現状実測と矛盾するため撤回する。`uploadMediaFile` の `media_state` write は try 節・catch 節の両方に分散しており、**catch 補償だけを親に隔離しても正常系の state write は phase に内在**する（実測: pending 記録 `:646-653`〔try 直前〕、expired-target cleanup の `compensateOrphanMedia()` `:587`〔Phase A 内〕、confirm 遷移の `deleteMediaState` + `saveMediaState('uploaded')` `:739-785`〔Phase C 相当〕、catch 補償・`status:'failed'` 記録 `:776-830`）。

配置規則（Rev.2 確定版）:

| 処理 | 実測位置 | 分割後の配置 |
| --- | --- | --- |
| pending 記録（`saveMediaState(status:'pending')`） | `:646-653`（Phase B try 直前） | オーケストレーター本体に留置 |
| expired-target cleanup（`compensateOrphanMedia()` + 再リクエスト） | `:581-600`（Phase A の内部） | **Phase A に含めてよい**（Phase A は「純粋通信」ではなく target 解決と server record 管理の単位。ただし副作用である旨をコメントで明示） |
| confirm 遷移 state write（`deleteMediaState(initialKey)` + `saveMediaState('uploaded')`） | `:739-785` | **Phase C の正当な副作用として含める**（storageKey 書換えと不可分のため分離しない） |
| catch 補償（`compensateOrphanMedia()` → `alreadyReadyItem` 復帰時の state write + 成功 return、`compensated` 時 purge、失敗時 `status:'failed'` 記録） | `:776-830` | **オーケストレーター本体の catch に留置**。特に `alreadyReadyItem` 復帰は「失敗処理が成功完了パスと合体している」特異形状であり、phase 関数へ分散させない |

- 公開 API（`uploadMediaFile`, `MAX_MEDIA_UPLOAD_BYTES`, `computeMediaHashes`, `fetchRemoteMediaDetail`, `compensateOrphanMedia`）は完全不変。
- pending→ready 遷移と `compensateOrphanMedia()` の異常経路契約は現状のまま（テスト `tests/media_upload.test.ts` が無変更で通過すること）。

---

### 3.4 R-2: limit / concurrency 解決の Layer 0 単一ソース化

**新設**: `src/utils/sync-limit-precedence.ts`（Layer 0・純粋関数・disk access ゼロ。`media-ref-precedence.ts` と同型）

```ts
import type { EmitConfig } from './config.js';
import { DEFAULT_CONFIG } from './config.js';

/** CLI flag / MCP argument > postsSyncLimit > legacy syncLimit > default. */
export function resolvePostsSyncLimit(
  override: number | undefined,
  config: Pick<EmitConfig, 'postsSyncLimit' | 'syncLimit'>,
): number {
  return override ?? config.postsSyncLimit ?? config.syncLimit ?? DEFAULT_CONFIG.postsSyncLimit;
}

/** CLI flag / MCP argument > mediaSyncLimit > default. */
export function resolveMediaSyncLimit(
  override: number | undefined,
  config: Pick<EmitConfig, 'mediaSyncLimit'>,
): number {
  return override ?? config.mediaSyncLimit ?? DEFAULT_CONFIG.mediaSyncLimit;
}

/** CLI flag / MCP argument > concurrency > default (8). */
export function resolveConcurrency(
  override: number | undefined,
  config: Pick<EmitConfig, 'concurrency'>,
): number {
  return override ?? config.concurrency ?? DEFAULT_CONFIG.concurrency;
}
```

**張り替え対象（12 箇所すべて）**:

| 呼び出し側 | 現在 | 変更後 |
| --- | --- | --- |
| `cli/commands/pull.ts:198` | `postsSyncLimit \|\| syncLimit \|\| DEFAULT` | `resolvePostsSyncLimit(undefined, ctx.config)` |
| `mcp/tools/sync-pull.ts:208` | 同上 | 同上（CLI と同一関数） |
| `cli/commands/pull.ts:234, :344` / `mcp:143, :231` | `mediaSyncLimit \|\| DEFAULT` | `resolveMediaSyncLimit(undefined, ctx.config)` |
| `cli/commands/pull.ts:306`（`--media` 通知 + 呼び出し） | 同上 | 同上 |
| `cli/commands/pull.ts:490`（pull-media） | `options.limit ? parseInt : mediaSyncLimit \|\| DEFAULT` | `resolveMediaSyncLimit(options.limit ? parseInt(options.limit, 10) : undefined, ctx.config)` |
| `mcp/tools/sync-pull.ts:291, :444` | 同上（:444 は `args.limit ||` 前置） | `resolveMediaSyncLimit(args.limit, ctx.config)` |
| `cli/commands/pull.ts:202` | `ctx.config.concurrency \|\| 8` | `resolveConcurrency(options.concurrency ? parseInt(...) : undefined, ctx.config)` |
| `sync/orchestrator.ts:371` | `options.concurrency \|\| 8` | `options.concurrency ?? DEFAULT_CONFIG.concurrency`（Layer 2 は config を持たないため既定値のみ正本参照） |

- **`\|\|` → `??` の是正**: 現状の `\|\|` は `0` を falsy として握り潰すが、`\?\?` は `undefined`/`null` のみフォールバックする。`loadConfig()` が既に `\|\|` で 0 を既定値へ正規化しているため resolver に 0 は届かず挙動差は発生しない。「暗黙の 0 握り潰し」に依存しない実装へ移すことが目的で、override の優先順位は §3.4 のテストで固定する。
- **層境界**: 純粋 Layer 0 モジュールであり Axis 0〜5 に完全準拠。`ALLOWED_LAYER_2_SYMBOLS` は不変（Layer 3 → Layer 0 import は無制限）。MCP は CLI wrapper を経由せず直接この関数を呼ぶ（`media-ref-precedence.ts` の先例同様、**設定の永続化は一切行わない**）。
- **新規テスト**: `tests/sync_limit_precedence.test.ts` — override > config > legacy fallback > default の優先順位マトリクス、`syncLimit` 廃止移行（`postsSyncLimit` 優先）、純粋性（disk access・設定永続化ゼロ）を固定。

### 3.5 R-3: Barrel リエントランスの収束（AGENTS.md 更新を伴うためオーナー確認ゲート付き）

**方針**: barrel 3 ファイルは**削除せず維持**し、リポジトリ内部（Layer 2・Layer 3・テスト）の import を実体へ張り替える。

1. **Layer 3 の張り替え（10 箇所）** — 到達先は各ディレクトリの `index.ts` 実体:
   ```text
   sync/pull.js      → sync/pull/index.js    (formatQuarantineNotice)
   sync/push.js      → sync/push/index.js    (pushArticle, PushResult, PushValidationError)
   sync/media.js     → sync/media/index.js   (pullMedia, collectLocalMirrorIndex, searchRemoteMedia)
   ```
   - `tests/layering.test.ts` の Axis 2 は `resolved.startsWith(l2Path + path.sep)` でディレクトリ配下を同一モジュールとして扱うため、**張り替え後も allowlist（`pull: { pullArticle, formatQuarantineNotice, PullResult }` 等）がそのまま機能し、allowlist 変更は不要**（layering.test.ts の解決ロジックで実測確認済み）。
   - `orchestrator.ts`（`./pull.js`, `./push.js`, `./media.js`）等の Layer 2 内部 barrel import も `./pull/index.js` / `./push/index.js` / `./media/index.js` へ統一。`pull/media_stage.ts:51`・`push/media_stage.ts:35` の `../media.js`（layering スナップショットで明示許可済みの例外）も `../media/index.js` へ統一し、**スナップショット例外の恒久化を防ぐ**（スナップショット自体は新規 sibling 依存を失敗させる gate として機能継続）。
2. **テストの張り替え（20 ファイル / 25 import）** — `../src/sync/pull.js` → `../src/sync/pull/index.js` 等。機械的置換 + `npm test` で検証。
3. **barrel の位置づけ明文化** — `src/sync/{pull,push,media}.ts` の doc comment を「npm 公開 API（`src/index.ts`）専用の後方互換 façade。リポジトリ内部は実体を import する」に更新。AGENTS.md の Modular Pull/Push Architecture の barrel 記述にも「内部 import は実体へ、barrel は public façade 限定」の一文を追加。

**Ask First 判定**: Orchestrator API の signature・戻り値は不変のためカテゴリ 3 の文字面上は非該当。ただし AGENTS.md の設計記述（barrel の位置づけ）を更新するため、カテゴリ 4「core principles in AGENTS.md」に近接する変更として扱い、**Phase 2 着手前にオーナー承認を取得するゲート**を設ける。

---

## 4. 実装手順とタスク分解（Phase 計画）

| Phase | 作業内容 | 対象ファイル | 検証方法 |
| --- | --- | --- | --- |
| **Phase 0 (R-2)** | **limit / concurrency 単一ソース化**<br>・`src/utils/sync-limit-precedence.ts` 新設<br>・Layer 3 の 12 箇所張り替え（`\|\|` → `??` 是正込み）<br>・`orchestrator.ts:371` の `8` → `DEFAULT_CONFIG.concurrency`<br>・`tests/sync_limit_precedence.test.ts` 新規 | `src/utils/sync-limit-precedence.ts`<br>`src/cli/commands/pull.ts`<br>`src/mcp/tools/sync-pull.ts`<br>`src/sync/orchestrator.ts`<br>`tests/sync_limit_precedence.test.ts` | `npm run check` PASS 確認（既存テスト無変更で通過） |
| **Phase 1 (R-1)** | **巨大関数分割（挙動不変の Move Function）**<br>**⓪ 前段: characterization test 追加**（`emit pull` batch の console 出力全文 snapshot と doctor 出力 snapshot を先に green で追加）<br>・doctor: 3 check 群 private 関数化<br>・CLI batch pull ハンドラ分解<br>・`uploadMediaFile` phase 分解（state write 配置は §3.3 表に従う） | `tests/cli.test.ts`（または新規 `tests/cli_pull_output.test.ts`）<br>`tests/doctor.test.ts`<br>`src/sync/doctor.ts`<br>`src/cli/commands/pull.ts`<br>`src/client/media.ts` | ⓪ snapshot が分割前に green → 分割後も**無変更で** green（＝出力バイト不変の機械的担保）。`tests/media_upload.test.ts` の中断系ケースも無変更 green |
| **Phase 2 (R-3)** | **⚠️ オーナー承認ゲート後**<br>・Layer 2/Layer 3 の barrel import → 実体 import 張り替え<br>・`pull/media_stage.ts` / `push/media_stage.ts` の `../media.js` → `../media/index.js`<br>・テスト 20 ファイルの import 張り替え<br>・barrel doc comment + AGENTS.md 更新 | `src/sync/orchestrator.ts`, `src/cli/**`, `src/mcp/**`, `src/sync/pull/media_stage.ts`, `src/sync/push/media_stage.ts`, `tests/`（20 ファイル）, `AGENTS.md` | `npm run check` PASS、`tests/layering.test.ts` allowlist 無変更で green |

**コミット分割規則（Rev.2 追加）**: Phase 0 + Phase 1（R-1/R-2、挙動不変の実装）で **1 コミット**、Phase 2（R-3、import 機械置換＋AGENTS.md 更新で diff が大きくなる）を**独立コミット**とする。ゲート前後の差分が混在するとレビュー・追跡が困難になるため、Phase 2 のオーナー承認取得前に Phase 0/1 をコミット済み・green の状態へしておく。
| **Phase 3** | **ドキュメント同期とリリース**<br>・`CHANGELOG.md` の `[Unreleased]` 直下へ v0.1.37 セクション追記（Added: sync-limit precedence resolver / Changed: doctor・upload・pull ハンドラ内部分割 / Refactored: barrel 収束）<br>・バージョンバンプ `0.1.36 → 0.1.37`（`package.json`, `package-lock.json`）<br>・Commit Readiness Checklist 全項目レビュー | `CHANGELOG.md`, `package.json`, `package-lock.json` | `npm run check` 全 green（65 files / 690+ tests）＋ `check:cycles` 0 件 |

---

## 5. テスト影響範囲と新規テスト要件

### 5.1 既存テストへの影響

- **Phase 0**: limit 解決の挙動は同一値を返すため、`tests/workspace.test.ts:88`（既定 30/300 ロック）を含む全テスト無変更で通過。
- **Phase 1**: private 関数への Move Function のみ。`runWorkspaceDoctor` / `uploadMediaFile` / CLI 公開出力のシグネチャ不変。回帰レールは §5.4 の characterization test で事前的に確保してから分割に入る（`tests/cli.test.ts` 単独では batch pull 出力をカバーしない — §3.2 実測是正参照）。`tests/doctor.test.ts`, `tests/media_upload.test.ts` は無変更で通過すること。
- **Phase 2**: import パスのみの変更のためテストコードの assert は一切変更しない。barrel を経由する import を実体へ張り替えるだけなので解決先モジュールは同一。

### 5.2 新規テスト要件（`tests/sync_limit_precedence.test.ts`）

1. **優先順位マトリクス**: override > `postsSyncLimit` > legacy `syncLimit` > `DEFAULT_CONFIG.postsSyncLimit` の 4 段階、および media / concurrency 相当。
2. **legacy 移行保証**: `postsSyncLimit` と `syncLimit` が同時に存在する場合、必ず `postsSyncLimit` が勝つこと（CLI/MCP 同一関数共有の担保）。
3. **純粋性**: 関数が disk access・設定永続化を一切行わないこと（`resolveLocalMediaRefsOption()` の purity テストと同型）。

### 5.3 Symmetry レール拡張（新規静的検査）

- CLI（`src/cli/commands/pull.ts`）と MCP（`src/mcp/tools/sync-pull.ts`）が limit 解決関数を**同一の `src/utils/sync-limit-precedence.js` から import していること**をソース走査で検証（Rule 5 / Axis 3 と同型の静的検査）。これにより将来のフォールバック式直書きの再発を gate で防ぐ。
- **実装時追記**: 併せて「`src/cli/`・`src/mcp/`・`src/sync/orchestrator.ts` 内に `postsSyncLimit || ` / `mediaSyncLimit || ` / `|| 8;` のフォールバック式が復活していないこと」を grep ベースで検証する（散在の再発そのものを gate で遮断）。

### 5.4 Characterization test（Phase 1 前段・Rev.2 追加）

R-1b（CLI batch pull ハンドラ分割）と R-1a（doctor 分割）の「出力バイト不変」を機械的に担保するため、**分割前に**以下を追加し green を確認する:

1. **CLI batch pull 出力 snapshot**: mock fetch（既知の記事 2〜3 件 + taxonomy + referenced media）下で `program.parseAsync(['node', 'emit', 'pull'])` を実行し、`console.log` / `console.warn` の呼び出し引数列を丸ごと snapshot 化。per-item 行（`[n/total] ✅ Pulled …`）、サマリ行（`🎉 Articles: …`）、preserved/quarantine notice、media 統計行の**順序・空行・絵文字込み**で一致を検証。
2. **doctor 出力 snapshot**: `runWorkspaceDoctor` の戻り値 `checks[]` の id 順序と message を snapshot 化（既存 `tests/doctor.test.ts` の断片的 assert を補完し、check 順序入替えを即座に検出）。
3. **配置**: `tests/cli_pull_output.test.ts` 新規（CLI 経由テストが Layer 2 レベルテストと混在しないよう分離）＋ `tests/doctor.test.ts` 拡張。vitest snapshot 機構（`.snap`）を使用し、分割コミットで snapshot ファイルが一切更新されないことを DoD ゲートとする。

---

## 6. Ask First Policy との対応表

| 施策 | 該当カテゴリ判定 | 結論 |
| --- | --- | --- |
| **R-1 巨大関数分割** | 4 カテゴリいずれにも該当しない（新規パッケージなし、schema なし、公開シグネチャ不変、private 関数への移動のみ） | **承認不要** |
| **R-2 limit 単一ソース化** | カテゴリ 1〜3 非該当。Layer 0 純粋関数の新設と Layer 3 呼び出し側の張り替えのみ。`ALLOWED_LAYER_2_SYMBOLS` 不変 | **承認不要** |
| **R-3 barrel 収束** | Orchestrator API の signature・戻り値は不変のためカテゴリ 3 の文字面上は非該当。ただし AGENTS.md 記載の設計記述（barrel の位置づけ）を更新するため、カテゴリ 4「core principles in AGENTS.md」のコア原則修正に近接する変更として扱う | **Phase 2 着手前にオーナー確認（ゲート）** |

---

## 7. リスクと mitigation

| リスク | 発生条件 | mitigation |
| --- | --- | --- |
| doctor check の実行順序・出力文言 drift | `runWorkspaceDoctor` 分割時に `checks.push()` の順序が入れ替わる | セクション番号（1,2,3,4,4b,4c,4d,5,6,7）と push 順序をコメントで固定し、`tests/doctor.test.ts` の check id アサートを無変更 green で通過させる。overall status 判定は分割後も一元計算のまま動かさない |
| CLI 出力のバイト単位変化 | batch pull ハンドラ分解時に改行・絵文字・順序が変わる | `tests/cli.test.ts` に加え、分割前後で mock fetch 下 batch 出力の diff を目視検証。presentation 関数呼び出しは v0.1.34 の共有済み実装のまま動かさない |
| upload phase 分割での pending 状態喪失 | Phase A→B 間の例外経路がずれ、`media_state` pending レコードが残る | §3.3 の配置表に従う。pending 記録・catch 補償（`compensateOrphanMedia()` → `alreadyReadyItem` 復帰 / purge / `status:'failed'` 記録）はオーケストレーター本体に留置するが、**confirm 遷移の state write は Phase C の正当な副作用**であり分離しない（Rev.1 の「phase 関数は state write を行わない」は実測と矛盾するため撤回済み）。`tests/media_upload.test.ts` の中断系ケース（Phase B PUT 失敗補償、`status:'failed'` 記録、expired target cleanup）を無変更で通過させる |
| `\|\|` → `??` による挙動変化 | config に `0` が書き込まれた場合 | `loadConfig()` が `\|\|` で 0 を既定値へ正規化しているため resolver に 0 は届かない。同一結果になることをテストで固定（0 テストケース） |
| Phase 2 の import 張り替え見落とし | barrel import が 1 箇所残る | `grep -rn "from '\\.\\./sync/pull\\.js'\|'\\.\\./sync/push\\.js'\|'\\.\\./sync/media\\.js'" src/cli src/mcp tests` が **0 件**（`src/index.ts` の公開 re-export は許容）であることを DoD ゲートにする |
| layering gate 誤検知 | 実体 import 化で Axis 2 allowlist に引っかかる | `resolved.startsWith(l2Path + path.sep)` がディレクトリ配下を同一モジュール扱いすることを §3.5 で実測確認済み。allowlist は無変更で green（Phase 2 の検証手順に明記） |
| 循環依存の再導入 | check 群分割で doctor の新規 import edge が増える | `check:cycles` を各 Phase で実行（現在 0 件）。doctor の `collectRemoteStorageKeys` import（`./media.js` → `./media/index.js`）は同一モジュールへの張り替えであり新規 edge は生まれない |

---

## 8. 完了条件（DoD: Definition of Done）

1. [ ] `src/utils/sync-limit-precedence.ts` が新設され、`resolvePostsSyncLimit` / `resolveMediaSyncLimit` / `resolveConcurrency` が limit 解決 12 箇所すべてから共有されていること。
2. [ ] `src/cli/commands/pull.ts:202` と `src/sync/orchestrator.ts:371` のマジックナンバー `8` が消え、`DEFAULT_CONFIG.concurrency` が正本参照になっていること。
3. [ ] `runWorkspaceDoctor` が 3 つの check 群 private 関数へ分割され、オーケストレーター本体が約 60 行に収まっていること（公開シグネチャは不変）。
4. [ ] CLI batch pull ハンドラと `uploadMediaFile` が phase/private 関数へ分解され、出力文言・pending 状態契約がバイト単位で不変であること（state write 配置は §3.3 の Rev.2 確定表に従う）。
5. [ ] `tests/sync_limit_precedence.test.ts` が追加され PASS、limit 共有の静的 symmetry 検査が green であること。
6. [ ] **characterization test（§5.4）が分割前に追加済みで、分割コミットにおいて snapshot ファイル（`.snap`）が無変更**であること（CLI batch pull 出力・doctor check 順序のバイト不変の機械的担保）。
7. [ ] （オーナー承認後）Layer 2/Layer 3 と tests の barrel import（`sync/pull.js` / `sync/push.js` / `sync/media.js`）が実体 import へ張り替え済みで、barrel への内部 import が grep で 0 件（`src/index.ts` を除く）であること。
8. [ ] barrel doc comment と AGENTS.md の barrel 記述が「public façade 限定」の位置づけに更新されていること。
9. [ ] `ALLOWED_LAYER_2_SYMBOLS`・layering スナップショット例外リストが**無変更**で `tests/layering.test.ts` / `tests/guards.test.ts` が green であること。
10. [ ] `CHANGELOG.md` に v0.1.37 セクションが `[Unreleased]` 直下へ追記され、`package.json` / `package-lock.json` が `0.1.37` になっていること。
11. [ ] コミットが「Phase 0+1（挙動不変実装）」と「Phase 2（barrel 収束＋AGENTS.md 更新）」の **2 コミットに分離**されていること（§4 コミット分割規則）。
12. [ ] `npm run check`（Prettier, TypeScript, Cycles, Vitest）がすべて PASS すること。

---

## 9. 本計画書が扱わない残存課題（将来版への引き継ぎ）

| ID | 課題 | 除外理由 |
| --- | --- | --- |
| **X-1** | `src/db/cache.ts`（709 行）のドメイン別分割（article state / media state / taxonomy・baseline） | Ask First カテゴリ 2。cohesion 高く分割メリットは薄い（v0.1.34 X-1 から継続） |
| **X-2** | `src/db/migrations.ts`（360 行）の宣言的 migration 表への再構成 | Ask First カテゴリ 2。schema v5 までの履歴不変条件と直結（継続） |
| **X-3** | ライセンスヘッダー（105 ファイル × 約 19 行 ≒ 2,000 行）の参照形式への集約 | git blame 汚染が大きく効果は見た目のみ。一括編集のリスク対効果が悪い（継続） |
| **X-4** | barrel 3 ファイル自体の削除 | AGENTS.md が後方互換 re-export を明文化した設計。npm 公開 API の破壊的変更であり次期 major まで温存 |
| **X-5** | `runPreflightChecks`（約 440 行）の stage 分割 | 同期的直列バリデーションで過剰分割（v0.1.34 X-6 から継続） |
| **X-6** | `src/utils/frontmatter.ts` の `formatYamlScalar` 分離 | Baseline serialization invariant と直結、単独 refactor は高リスク（継続） |
| **X-7** | MCP batch 分岐と CLI batch 分岐のオーケストレーション統合 | Axis 3（MCP → CLI import 禁止）により現状は presentation 共有が解。これ以上の統合は orchestrator（Layer 2）側への処理寄与増を伴い、Public Facade 変更協議が必要 |
| **X-8** | `tests/pull_draft_revision.test.ts:753` の `as any` 型化 | 低優先。テスト 1 行の改善であり本版のスコープ締切から除外 |
