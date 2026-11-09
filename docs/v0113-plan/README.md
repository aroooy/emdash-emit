# emdash-emit v0.1.13 — Fix Plan（v0.1.12 第三者レビュー反映）

本ディレクトリは `docs/v0112-eval/`（black-box 第三者評価）の Issue Pack に対し、
**現行ソース（v0.1.12, `src/`）との照合で確定した微調整**を反映した改修仕様書です。

- 評価元の証跡: `docs/v0112-eval/issues.md` / `fix-spec-taxonomy.md` / `test-matrix-taxonomy.md` / `logs/`
- 本仕様の判定基準: CLI stdout/stderr・exit code / HTTP 状態 / `.emit/cache.db` の列値 / ファイルツリーの 4 種類
  （評価憲章と同じ「ソース非依存で合否判定できる contract」を維持する）

## 成果物

| ファイル | 内容 |
|---|---|
| `README.md` | 本ファイル（スコープ・原則・マイルストーン） |
| `issues-v0113.md` | Issue 更新表（v0.1.12 実装済みの切り分け、原因特定、変更なし判定を含む） |
| `fix-spec-v0113.md` | 改修仕様書（R1〜R8 の微調整版＋受け入れ条件 A1〜A14） |

## v0.1.12 レビューに対する照合の要点（微調整の内訳）

第三者レビューの骨子（R1 本命／算法は書き直さない／R2 baseline 保護／R5 再帰 flatten／
CLI 共通エラー捕捉／quarantine 可視化／Step 順序）は **源码レベルで妥当**であることを確認した。
以下 4 点を微調整として本仕様に織り込む。

1. **EMIT-009 と EMIT-003 は v0.1.12 で部分的に実装済み**
   - `emit status` は既に `<collection>/conflicts/` を別カウントで報告する
     （`src/sync/status.ts:103-113` `countQuarantinedCopies()`、`:211`、CLI 出力 `src/cli/commands/status.ts:178-192` の `🩹` 行）。
   - `emit pull --force` は既に退避コピーを書く（`src/sync/pull.ts:269-278` → `quarantineLocalCopy()`、
     `:200` で `.local-dropped.md` サフィックス、`:283` `reason: 'no-cache-baseline'` 分岐）。
   - → **新規実装ではなく「再現確認 → 欠落層（MCP / 警告文言）の特定」**に格下げする。

2. **R1 には schema v2 migration と 3 状態判定が必須**
   - `remote_taxonomy_hash` は新列＝`CURRENT_CACHE_SCHEMA_VERSION` を 2 に上げる
     （`src/db/cache.ts:84`, future guard `:195`, migration `:239-271`）。
   - remote 割当の取得は `null`（失敗）と `[]`（割当ゼロ）を区別する必要がある
     （`src/sync/terms.ts:31,53,59` が既に `null` を返す設計）。混同すると**誤 wipe** を生む。

3. **R3 は「baseline を汚染しない」だけでは不十分（4 点セット）**
   - 現行は 409 解決後に baseline を remote 実状態で更新している（`src/sync/push.ts:1123-1132`）。
     これを消すと再 push 時の base が古いままになり clean-edit 誤判定で remote 変更を潰す。
   - `conflict_at` あり / `conflict_copy_path` NULL の不整合ペアの実原因は
     **`saveSyncState()` に `conflictCopyPath` / `conflictAt` を渡していないこと**
     （`src/sync/push.ts:1111-1121` は `conflictPending: 1, conflictCopyHash` のみ。
     `saveSyncState` は全列 UPSERT なので未指定が NULL で上書きされる: `src/db/cache.ts:412-442`）。

4. **EMIT-008 は pull 側だけでなく termId 解決/frontmatter canonicalize 経路も同時に直す**
   - preflight（G4）だけでなく、slug→term ID 解決（`loadLocalTaxonomyMaps()` `src/sync/taxonomies.ts:266`）と
     frontmatter の用語 canonicalize（`src/sync/push.ts:601-615`）も同じローカル YAML ディレクトリを読む。
   - YAML prune（`:142-154, 187-199`）は `activeFileNames` 基準のため、children 追加で**既存環境のファイル数が増える**。

## 改修マイルストーン（Step 0〜3）

| Step | Issue | 目的 |
|---|---|---|
| **Step 0** | EMIT-009 / EMIT-003 | 再現確認と欠落層の確定（実装済み部分を Issue 側に反映） |
| **Step 1 (S1)** | EMIT-008 → EMIT-001 → EMIT-002 | データ整合性・欠落防止。EMIT-008 を先に行うと階層 term で R1 の受け入れテストが組める |
| **Step 2 (S2)** | EMIT-006 → EMIT-004（R3 4点セット）→ EMIT-005 | 状態整合性・CLI 堅牢化 |
| **Step 3 (S3)** | EMIT-007（＋EMIT-003 の警告文言強化） | MCP / オプション整備 |

## 変更しないこと（明示的な Non-goal）

- `hybrid3WayMerge()` / `mergeTaxonomies()` の**算法は書き換えない**
  （`src/sync/merge.ts:94-175, 368-399`。評価の P7 `🏷️ Merged remote taxonomy change(s) for tags: +qa-t1, qa-t4` が
  算法の正しさを実証済み。R1 は「そこに到達させる」検知のみを追加する）。
- `DESTRUCTIVE_TAXONOMY_WIPE` / `TAXONOMY_CONFLICT_PENDING` / `DELETE_PENDING_ARTICLE` の
  ガード意味と CLI フラグ名は変更しない（AGENTS.md §9 の契約を維持）。
- 排他 taxonomy（`TAXONOMY_UNION_REJECTED`）の第三者検証は公開契約上構成不能
  （`test-matrix-taxonomy.md` E1）。単体テストでのみ担保する。
