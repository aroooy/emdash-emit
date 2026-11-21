# emdash-emit v0.1.14 改善計画（Plan Pack / fix-spec Rev.2）

本ディレクトリは、`emdash-emit v0.1.13` の実機黒箱レビューで特定された課題（P1〜P6）を解消するための改善計画書一式を格納する。

**現在の状態**: `fix-spec-v0114.md` は **Rev.2（差分形）**。第三者レビューの指摘 1〜6 を反映し、
R2 と R4 を「pending 種別の分離（schema v3 migration）」として統合した。差分の一覧は fix-spec の **付録 A（D1〜D8）**。

---

## 構成ドキュメント

1. **[`issues-v0114.md`](file:///Volumes/ext/github/emdash-emit/docs/v0114-plan/issues-v0114.md)**:
   - 課題 P1〜P6 の背景、なぜ修正が必要なのか（ユーザー影響・システム影響）、ソースコード照合に基づく根本原因の分析。
   - **注意**: ガード番号と union 集合の記述に誤りがある（`UNRESOLVED_CONFLICT_MARKERS` は G8 ではなく **preflight G6**、G8 は `UNSUPPORTED_SYNTAX_WARNING`。Base `{t1,t2}` / Local `{t1}` / Remote `{t1,t2,t3}` の union は `{t1,t2,t3}`）。**訂正は fix-spec §0（C1〜C3）が優先する**。
2. **[`fix-spec-v0114.md`](file:///Volumes/ext/github/emdash-emit/docs/v0114-plan/fix-spec-v0114.md)**（Rev.2・差分形）:
   - 各課題（R1〜R6）の不変条件（Invariants）、設計方針、関数レベルの詳細修正仕様。
   - §0 = Rev.1 原因分析の訂正とガード番号の正式対応 / 付録 A = Rev.1→Rev.2 差分一覧 / 付録 B = Rev.1 本文要点（監査用）。
3. **[`test-matrix-v0114.md`](file:///Volumes/ext/github/emdash-emit/docs/v0114-plan/test-matrix-v0114.md)**:
   - 単体・統合テストの検証マトリクス、およびレビュアー向けの実機黒箱検証シナリオ。

---

## 修正対象課題の概要（P1〜P6）と Rev.2 における実装方針の変更点

| 課題番号 | 重要度 | 課題名称 | Rev.2 の実装方針 |
|---|---|---|---|
| **P1** | **High** | `--resolve-taxonomy` の履行保証 | 戦略の**決定点を `mergeTaxonomies()` に一元化**。post-merge 上書き（`push.ts:1179-1208`）は strategy 未指定時の fallback に縮小。Case 2（remote 削除 vs local 変更）にも戦略を適用 |
| **P2** | **Medium** | ガード分離と案内文の適正化 | マーカーの有無で分岐させるのではなく **`body_conflict_pending` / `taxonomy_conflict_pending` を別列に分離**（schema v3）。doctor の案内文も種別別に分割 |
| **P3** | **High** | リモート削除＋ローカル編集のデッドロック解消 | 404 検知を **3 経路すべて**（初回 PUT / conflict 解決中の remote GET / auto-merge 後再 PUT）に拡張。退避は新規種別を作らず既存 **`.local-dropped.md`** に統一。delete は `--discard-local-edits` を新設 |
| **P4** | **Medium** | 退避メタデータ残存の解消 | UPSERT を**種別単位**に改修（全 pending が 0 のときのみ退避列 NULL）。accept-canonical の cache 未更新と accept-local の暗黙クリアも併せて修正 |
| **P5** | **Medium/Low** | 診断（Doctor）の網羅性向上 | `taxonomy_apply_pending` に加え **`delete_pending` も検査**。退避コピー手動削除後の auto-clear 条件を kind 単位で再定義 |
| **P6** | **Low** | 空バックアップファイルの生成抑止 | サイズ検査によるスキップではなく **`VACUUM INTO` へ置換**し、名称を package.json version から導出、掃引を無条件化 |

---

## Rev.2 の設計判断（レビュー指摘 1〜6 の反映対応表）

| # | レビュー指摘 | fix-spec Rev.2 の反映箇所 |
|---|---|---|
| 1 | `conflict_pending` 単一系統の共有が真因。R2 と R4 を統合すべき | **付録 A D1** / R2 §3(1) schema v3・R4 §3(1)(2) |
| 2 | 戦略決定点の一元化（merge 層 vs post-merge の二重解決） | **付録 A D2** / R1 Invariant (I1-b)・§3(2) |
| 3 | `strategy: local/remote` の破壊的意味論と wipe guard の関係 | **付録 A D3** / R1 Invariant (I1-c)・§2 |
| 4 | 退避コピーの種別体系確定と list/diff/resolve/prune/doctor/AGENTS.md の同時更新 | **付録 A D4** / R3 §2(2)・Non-goals |
| 5 | ガード番号参照の実コード照合（G6 / G13 / G15 / G17） | **付録 A D5** / fix-spec §0 C2・ガード番号表 |
| 6 | バックアップ名を version から導出し、空 backup を無条件掃引 | **付録 A D6** / R6 §2 |

---

## 承認フロー

1. `fix-spec-v0114.md`（Rev.2）の妥当性・安全性・エッジケース網羅性を第三者レビューで承認（LGTM）。
   - 承認の判定基準は評価憲章と同一: CLI stdout/stderr・exit code / HTTP 状態 / `.emit/cache.db` の列値 / ファイルツリーの 4 種類。
2. Rev.2 で追加した **実装前確認 T3-6**（既存 `conflicts resolve --accept-canonical` 経路で脱出可能かの切り分け）を実施し、R3 の新規経路の要否を確定。
3. テストマトリクス（T1-1〜T6-2 と追加ケース）を実装し、`npm run check`（format:check / typecheck / test）が 0 exit で通ること。
4. schema v3 migration を伴うため、既存 workspace の cache 移行テスト（v2 → v3 の振り分け規則）を `tests/cache.test.ts` / `tests/migration_hash_invariants.test.ts` で担保。
5. 全テスト Green およびビルド成功を確認の上、正式コミットを作成。

