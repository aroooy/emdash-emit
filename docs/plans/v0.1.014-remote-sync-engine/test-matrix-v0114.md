# テストマトリクス（v0.1.14 / fix-spec Rev.2 対応）— 課題 P1〜P6 検証計画

本ドキュメントは、v0.1.14 で実装される各修正項目（R1〜R6）の受け入れ条件および単体・統合テストの検証マトリクスを定義する。
**fix-spec-v0114.md Rev.2 の Invariant / 受け入れ条件 A1-1〜A6-4 に対応**させる（対応関係は fix-spec 付録 A を参照）。

判定基準は評価憲章と同一: CLI stdout/stderr・exit code / HTTP 状態 / `.emit/cache.db` の列値 / ファイルツリーの 4 種類。

---

## 1. テストマトリクス概要

### R1: Taxonomy 戦略（P1）— 単体 `tests/merge.test.ts` / 統合 `tests/sync.test.ts`

| ID | 検証項目 | 期待結果 | A |
|---|---|---|---|
| **T1-1** | `--resolve-taxonomy local`（Base `{t1,t2}` / Local `{t1}` / Remote `{t1,t2,t3}`） | remote の追加 term が 1 つも混入しない。union 基準は `{t1,t2,t3}`（Rev.1 の `{t1,t3}` 記述は誤り、fix-spec §0 C1） | A1-1 |
| **T1-2** | `--resolve-taxonomy remote` | local の削除意図が反映され remote 状態がそのまま採用。破棄した local 側 term が warning に列挙される | A1-2 |
| **T1-3** | strategy 未指定 / `union` | v0.1.13 の集合代数 union と `isUnionEqualLocal` clean 路径が**バイト単位で同一**（baseline hash 互換） | A1-3 |
| **T1-4**（追加） | Case 2（remote が name を削除 vs local が変更）で 3 戦略 | すべて merge 層で一貫解決。strategy 指定時に post-merge ブロック（`push.ts:1179-1208`）が走らない | A1-4 |
| **T1-5**（追加） | strategy=local 採用後にサーバ拒否（単一カテゴリ制約等、400/422） | `autoMergedTaxonomies` が空でも専用案内が発火し、union 誘導ではない文言になる | A1-5 |
| **T1-6**（追加） | strategy 指定と destructive wipe guard の関係 | strategy 明示時は wipe guard 免除。`--force` 由来の暗黙 union は `DESTRUCTIVE_TAXONOMY_WIPE` が従来通り発火 | R1 §2 |

### R2 / R4: pending 種別分離と退避メタデータ（P2・P4）— schema v3 migration を伴う

| ID | 検証項目 | 期待結果 | A |
|---|---|---|---|
| **T2-1** | 本文競合マーカー残存時の push | `TAXONOMY_CONFLICT_PENDING` ではなく **preflight G6 `UNRESOLVED_CONFLICT_MARKERS`**（Rev.1 の「Guard G8」表記は誤り） | A2-1 |
| **T2-2** | マーカーを手動解消後の再 push | strategy/force なしで成功。`body_conflict_pending = 0`、**`taxonomy_conflict_pending = 1` は残存** | A2-2 / A4-2 |
| **T2-3** | `taxonomy_apply_pending = 1` 時の push | 案内文に `--resolve-taxonomy` が含まれず `--allow-unapplied-taxonomies` のみ（**regression lock**: v0.1.13 の現行挙動を固定） | A2-4 |
| **T2-4**（追加） | taxonomy-only conflict 直後の bare push | G15 `TAXONOMY_CONFLICT_PENDING` で停止（マーカー検査による素通しが起きない） | A2-3 |
| **T2-5**（追加） | doctor の案内文 | 本文競合由来 pending に `--resolve-taxonomy` を勧めず、taxonomy 競合には勧める（種別別分割） | R2 §3(3) |
| **T4-1** | 競合解消 push 後の `saveSyncState` | `conflict_pending / body_conflict_pending / taxonomy_conflict_pending = 0` かつ退避列 3 値が `NULL` | A4-1 |
| **T4-2**（追加） | `emit conflicts resolve --accept-canonical` 後 | cache の pending と退避列がクリアされ、続けて bare push が成功（現状は cache 未更新） | A4-3 |
| **T4-3**（追加） | `emit conflicts resolve --accept-local` 経路 | conflict 列が明示的に更新される（暗黙クリアが起きない） | A4-4 |
| **T4-4**（追加） | 退避列 3 値のセット整合 | `conflict_copy_path` あり ⇔ `conflict_copy_hash` と `conflict_at` あり（現状この invariant のテストが無い） | A4-5 |
| **T4-5**（追加） | schema v2 → v3 migration 振り分け | 既存行が Rev.2 規則（マーカー有無 / `remote_taxonomy_hash`）で分配され、判別不能は両方 1。`conflict_pending = MAX(body, taxonomy)` が保つ | R2 §3(1) |
### R3: リモート削除＋ローカル編集の脱出（P3）

| ID | 検証項目 | 期待結果 | A |
|---|---|---|---|
| **T3-1** | 初回 PUT が 404 | `[REMOTE_ARTICLE_DELETED]` (404) と脱出案内 3 案 | A3-1 |
| **T3-2** | `pull <id> --force`（remote 404 + 未 push 編集） | 編集が **`posts/conflicts/*.local-dropped.md`** に退避（Rev.1 の `.local-orphan.md` は不採用）、canonical と DB レコード削除、`deleted: true, quarantined: true` | A3-2 |
| **T3-3** | `delete <file> --discard-local-edits`（remote 404 + 未 push 編集） | `.deleted.md` に退避後、local ファイルと DB が削除完了。published 保護は `--allow-delete-published` のまま | A3-3 |
| **T3-4**（追加） | 合成 409（taxonomy divergence）→ conflict 解決の remote GET 404 | `CONFLICT_REMOTE_FETCH_FAILED` ではなく `REMOTE_ARTICLE_DELETED` に翻訳（実測された詰まりの実経路） | A3-1 |
| **T3-5**（追加） | auto-merge 後の再 PUT 404 | `PUSH_RETRY_FAILED` ではなく `REMOTE_ARTICLE_DELETED` | A3-1 |
| **T3-6**（**実装前確認**） | 既存 `conflicts resolve --accept-canonical` だけで脱出可能か | 観測結果を記録し、R3(2)(3) の新規経路の要否を確定（過剰実装の防止） | R3 §2(4) |
| **T3-7**（追加） | 退避コピーの種別分類 | `.local-dropped.md` が `conflicts list / diff / resolve / prune` と doctor で `'dropped'` に分類される（新種別を増やさないことの担保） | R3 §2(2) |
| **T3-8**（追加） | 脱出後の状態表示 | `emit status` / `emit doctor` が当該記事を orphan・pending として報告しない | A3-4 |

テスト配置: `tests/sync.test.ts`（T3-1, T3-4, T3-5）、`tests/pull_quarantine.test.ts`（T3-2）、`tests/delete.test.ts`（T3-3）、`tests/conflicts.test.ts`（T3-6）、`tests/workspace.test.ts` または `tests/doctor.test.ts`（T3-7, T3-8）。

### R5: Doctor の網羅性（P5）— `tests/doctor.test.ts`

| ID | 検証項目 | 期待結果 | A |
|---|---|---|---|
| **T5-1** | `taxonomy_apply_pending = 1` | warning と復旧手順。案内に **remote 側の term 存在 / 権限確認**を含む（pull-taxonomies で済まないケース） | A5-1 |
| **T5-2**（追加） | `delete_pending = 1` | warning と「local cleanup」／「`--revive`」の両案（現状 doctor は未検査） | A5-2 |
| **T5-3**（追加） | 退避コピーを手動削除した taxonomy pending | doctor 実行で kind 単位 auto-clear され、続けて bare push が成功（現状は永久に G15 で閉塞） | A5-3 |

### R6: バックアップ機構（P6）— `tests/cache.test.ts`

| ID | 検証項目 | 期待結果 | A |
|---|---|---|---|
| **T6-1** | 新規 workspace（0 バイト DB + migration） | 生成された `.bak-*` が**有効な SQLite として開け `sync_state` を持つ**（Rev.1 の「生成しない」期待値は A6-1 に置き換え） | A6-1 |
| **T6-2**（追加） | 実データ入り DB の migration | backup が生成され、migration 後の DB とテーブル・行数が一致。保持世代は最大 3 | A6-2 / A6-3 |
| **T6-3**（追加） | 既存 0 バイト `.bak-*` の掃引 | 新規 backup を生成しないパスでも掃引が走り、size 0 は disk に残らない | A6-3 |
| **T6-4**（追加） | backup 名 | package.json の version を含む（ハードコード廃止の担保） | A6-4 |

---
## 2. 実機黒箱検証シナリオ（レビュアー向け）

実機環境（CLI / REST API / SQLite）で以下を再現・確認する。判定はソース非依存の contract のみで行う。

**この節の手順は内部ソースを知らないユーザー視点で読めることを要件とする。** 観測できる CLI 出力・
ファイルパス・SQL 列値のみで合否を判定でき、実装の内部構造（関数名・ガード番号・テスト ID）に
依存してはならない。テスト ID とガード番号は開発側との対応付けのための注記であり、手順の理解に
読者の知識を必要としない。

### シナリオ 1: `--resolve-taxonomy local` の検証 (P1 / T1-1)

1. 記事作成: カテゴリ `[qa-c1, qa-c2]`、push 完了（base = `{qa-c1, qa-c2}`）
2. リモート側で `qa-c3` を追加（EmDash 管理画面または API）→ remote = `{qa-c1, qa-c2, qa-c3}`
3. ローカル側で `qa-c2` を削除（frontmatter 編集: `[qa-c1]`）
4. `emit push <file> --resolve-taxonomy local` を実行
5. **検証**: remote カテゴリが `[qa-c1]` となり `qa-c3` が加わっていないこと。warning に破棄した `+qa-c3` が列挙されること。
6. **対照**: 同じ条件で strategy 未指定 push → `[qa-c1, qa-c2, qa-c3]`（union）。Rev.1 の `{qa-c1, qa-c3}` という期待値は誤り。

### シナリオ 2: リモート削除＋ローカル編集の脱出検証 (P3 / T3-1・T3-2・T3-6)

1. 記事作成・同期完了
2. ローカル記事の本文を編集（未 push）
3. リモート側の記事を削除（EmDash 管理画面または API で DELETE）
4. `emit push <file>` → `[REMOTE_ARTICLE_DELETED]` と脱出案内 3 案を確認
5. **先に T3-6**: 退避コピーがある場合、`emit conflicts resolve --accept-canonical` に続けて `emit push <file>`（オプションなし）が通るか観測して記録する
6. `emit pull <id> --force` → 未 push 編集が `posts/conflicts/*.local-dropped.md` に退避され、canonical と SQLite レコードが削除されること
7. **検証**: `emit status` / `emit doctor` に orphan・pending 警告が出ないこと

### シナリオ 3: 競合解消後の退避メタデータ消去検証 (P4 / T4-1・T4-2)

1. 競合を発生させ、退避コピーが `posts/conflicts/` に作られたことを確認する
2. 競合を解消して `emit push <file> --force`（または戦略指定）で push 成功
3. **検証**: `SELECT conflict_pending, body_conflict_pending, taxonomy_conflict_pending, conflict_copy_path FROM sync_state WHERE id = ?` が `0 | 0 | 0 | NULL`。`emit status` / `emit doctor` に退避警告が出ないこと
4. **逆方向の検証**: 本文の競合だけ解消した直後に、カテゴリ・タグの競合状態とその退避コピーパスが**残っている**こと（=`taxonomy_conflict_pending = 1` と `conflict_copy_path` が非 NULL）

### シナリオ 4: pending 混同の解消検証 (P2 / T2-1・T2-2)

1. リモート側で本文変更 → push で競合マーカーが書かれ「本文の競合」として記録される
2. そのまま再 push → `UNRESOLVED_CONFLICT_MARKERS` で停止し、`--resolve-taxonomy` を要求しないこと
3. マーカーを手動解消して再 push → strategy/force なしで成功すること

### シナリオ 5: schema v2 → v3 migration の振り分け検証 (P4 / T4-5) ★最優先

**目的**: v0.1.13 までのキャッシュを引き継いだ workspace で、以前に起きた競合が「本文の競合」
と「カテゴリ・タグの競合」のどちらとして扱われるかが正しく決まっているかを確認する。

**懸念の要点**: 振り分けは退避コピーのファイル名から推定されます。カテゴリ・タグの競合でも
同じ名前規則 (`*.conflict.md`) で退避されるため、誤って「本文の競合」と判定される可能性があります。

1. v0.1.13 の workspace でカテゴリ・タグの競合状態を作っておく（`emit push` が `TAXONOMY_CONFLICT_PENDING` で停止する状態）
2. v0.1.14 をインストールし `emit doctor` を実行
3. **検証 A**: 表示される警告が「Taxonomy Conflict Pending」側であり、「Body Conflict Pending」側に現れないこと
4. **検証 B**: `emit push <file>`（オプションなし）が `TAXONOMY_CONFLICT_PENDING` で停止し、案内が `--resolve-taxonomy=union|local|remote` であること
5. **検証 C**: `emit push <file> --resolve-taxonomy=local`（または remote）で成功し、直後に

   ```sql
   SELECT conflict_pending, body_conflict_pending, taxonomy_conflict_pending,
          conflict_copy_path, conflict_copy_hash, conflict_at
   FROM sync_state WHERE id = '<ULID>';
   ```

   が `0 | 0 | 0 | NULL | NULL | NULL` になること（`conflict_pending = MAX(body, taxonomy)` の整合も含む）
6. **検証 D**: 本文競合 pending の行が `Body Conflict Pending` 側に表示され、案内に `--resolve-taxonomy` が現れないこと
7. 誤分類（taxonomy 競合が body 側に出る等）が確認できた場合は、観測ログと当該 ULID をそのままレビュー担当へ提出する

---

## 3. 実施手順と完了条件

1. `npm run check`（`format:check` / `typecheck` / `test`）が exit 0。
2. schema v3 migration を伴うため、v2 → v3 の振り分けテスト（T4-5）と baseline hash 互換テスト（`tests/migration_hash_invariants.test.ts`）を必須で追加。
3. 新規テストの配置: `tests/merge.test.ts`（戦略単体） / `tests/sync.test.ts`（統合 push） / `tests/pull_quarantine.test.ts`（T3-2） / `tests/delete.test.ts`（T3-3） / `tests/conflicts.test.ts`（T4-2・T4-3） / `tests/cache.test.ts`（T4-1・T4-4・T4-5・T6-*） / `tests/doctor.test.ts`（T5-*） / `tests/preflight.test.ts`（T2-1）。
4. AGENTS.md と README.md のガード表・退避コピー種別説明を Rev.2 の実装に合わせて同時更新（新種別は増やさないため、既存 3 種のまま pending 列名と guard 番号のみ更新）。
