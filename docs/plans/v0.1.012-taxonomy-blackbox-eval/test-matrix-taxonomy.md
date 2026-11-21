# Test matrix (black-box): Phase 4 taxonomy merge / union rejection

## 実行に必要な環境（現状の欠落）
| # | 必要もの | 現状 |
|---|---|---|
| E1 | **排他（exclusive / 1 記事 1 tag 系）制約を持つ taxonomy**。`TAXONOMY_UNION_REJECTED` を発火させるには、union した集合がサーバ制約に拒否される状況が必要 | arooy.net の `tags/` 58 件・`categories/` 45 件すべてに `exclusive` フィールドなし → **本番では発火不能**。管理者側で作成してもらう必要あり |
| E2 | 同一 origin の 2 ワークスペース | 確保済み（`/home/hiroaki/src/aroooy.net`, `/tmp/ws_b`） |
| E3 | out-of-band 操作（管理画面相当の直接 API 呼出し） | 確保済み（`/tmp/api_probe.mjs`, `/tmp/tax_audit.mjs`, `/tmp/remote_check.sh`） |
| E4 | 破壊的操作を許容する検証記事・taxonomy（既存コンテンツに触れない） | 検証用記事は作成/削除済み。**taxonomy 側の作成は未実施** |
| E5 | 可能なら staging の EmDash インスタンス（本番汚染回避） | 未提供（profile は arooy.net の 1 本のみ） |

## シナリオマトリクス
凡例: ✅=実施済（証跡あり） / 🟡=実施可能（書き込み要） / ⛔=E1 が必要

| ID | 初期状態 (base / local / remote) | 操作 | 期待される観測 | 状態 |
|---|---|---|---|---|
| T1 相互追加 | base {a,b} / local {a,b,c} / remote {a,b,d} | `emit push` | 集合 {a,b,c,d} が remote に。merge 通知。conflicts 空 | 🟡（rev が動かないと発火しない＝EMIT-001） |
| T2 相互削除 | base {a,b,c} / local {a} / remote {a,b} | push | {a}。警告なしでクリーン | 🟡 |
| T3 片側追加・local 無視 | base {a} / local {a} / remote {a,d} | local 本文のみ編集して push | **remote の d が保持**される | 🟡（本文 rev が動く場合は merge 到達を確認済） |
| T4 片側削除 vs 他側維持 | base {a,d} / local {a} / remote {a,d} | push | d 削除が反映 or conflict 提示（静かな無変化は不可） | 🟡 |
| T5 wipe (bare) | local `tags: []` / remote 5 件 | push | `[DESTRUCTIVE_TAXONOMY_WIPE]` + 指示 | ✅ `/tmp/all.log:171` |
| T6 wipe (explicit) | 同上 | push `--allow-wipe-taxonomies` | 全削除 + `🏷️ Cleared all 5 tag assignment(s)` | ✅ `/tmp/all.log:182` |
| T7 排他 taxonomy で union 拒否 | exclusive tag 群 {x,y} / local {x} / remote {y} | push | 統合集合 {x,y} が 400/422 で拒否 → `TAXONOMY_UNION_REJECTED` 相当 + 解決手順提示。baseline 非更新 | ⛔ E1 |
| T8 排他 taxonomy で safe union | exclusive / local 無変更 / remote {y} | push | remote 維持 + 通知 | ⛔ E1 |
| T9 未定義 term 割当 | `categories/`,`tags/` 未取得 | pull\<id\> → push | NOT_FOUND を **失敗として**扱い baseline 非更新 | ✅ 観測済（EMIT-002 `/tmp/wsBpush.txt`）→ 修正後の合否は A5/A6 |
| T10 delete→再 push（delete_pending） | `delete_pending=1` | push / `--revive` | bare push 拒否 / revive で復帰 | ✅ `/tmp/all.log:192`, `/tmp/flags.log` |
| T11 conflict pending bare push | `conflict_pending=1` | push / `--resolve-taxonomy=local` | exit 1 / resolve 受理 | ✅ `/tmp/flags.log:19` |
| T12 2 台同時 push（本文＋taxonomy 同時変更） | 両端末で別々に変更 | A→B 順に push | 2 台目が 409→merge or conflict。データ消失なし | 🟡 |

## 第三者実行ハーネス（E1/E4 が揃った時点で回せる形）
```bash
# 0) 共通初期化
WS_A=/home/hiroaki/src/aroooy.net
WS_B=/tmp/ws_b
ULID=<検証記事ULID>

# 1) 初期状態の作込み（remote に base 集合を配置）
node /tmp/api_probe.mjs set-terms $ULID tag t1,t2

# 2) 両端末で pull（base を同期）
( cd $WS_A && emit pull $ULID ) ; ( cd $WS_B && emit pull $ULID )

# 3) out-of-band 変更（管理画面相当）で remote 側だけ t3 を追加
node /tmp/api_probe.mjs add-term $ULID tag t3
node /tmp/api_probe.mjs get-entry $ULID   # _rev 不変であることを証跡化

# 4) 端末 A で local 変更（t4 を追加）→ push
( cd $WS_A && emit push posts/draft/*-$ULID-*.md ); echo "exit=$?"

# 5) 判定
node /tmp/tax_audit.mjs $ULID      # remote terms 期待集合との突合
( cd $WS_A && emit status ) | grep -E 'Summary|Flags'
( cd $WS_A && emit conflicts list )
( cd $WS_A && emit doctor ) | tail -3   # HEALTHY であること（未解決残り不可）
node -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.WS_A+"/.emit/cache.db",{readOnly:true});console.log(JSON.stringify(db.prepare("select conflict_pending,delete_pending,local_hash,remote_rev from sync_state where id=?").get(process.env.ULID)));'
```
各 scenario は「local terms」「remote terms」「CLI exit」「status Flags」「doctor 最終行」の 5 点で合否判定する
（= ソースを見ずに検証可能な contract として固定）。

## 残る検証不能領域（ソース無しでは確定できない）
- union 計算の内部順序（相互追加で local/remote のどちらが優先されるかの細部）
- 排他 taxonomy をまたぐ base 復元（旧 base 集合が排他制約に抵触する場合の扱い）
- `TAXONOMY_UNION_REJECTED` の存在そのもの（サーバ制約が無いため発火経路を観測できない）
→ これらは maintainer 側の単体テスト（`hybrid3WayMerge` 相当への direct unit test）での担保が必須。
  第三者としては **受け入れ条件（A1–A7 / T1–T12）の充足**のみを保証できる。

---

# 実施結果（2026-11-09 / 本番 arooy.net / 後片付け済み）

使用記事: `qa-taxonomy-harness` = ULID `01M6ZZX746T8GRVXZ5D1WW9DXH`（検証後に削除）
使用用語: tag `qa-t1..qa-t4` / category `qa-cat-a`, `qa-cat-b`, 子 `qa-cat-b1`（検証後に全削除）
端末: A `/home/hiroaki/src/aroooy.net`, B `/tmp/ws_b`。out-of-band 操作は `POST /_emdash/api/content/posts/{id}/terms/{taxonomy}`。
ログ: `/tmp/v0112-eval/logs/{T1_T4,T5_T9,T12,T12_3,T10_cleanup}.log`

## 排他 taxonomy（E1）についての実現可否
OpenAPI 3.1 上に排他制約を表すフィールドが無く、taxonomy 定義の作成 POST も無いため、
**「排他 taxonomy で union 拒否（TAXONOMY_UNION_REJECTED）」は公開契約上構成不能**だった。
代わりに実際に到達できるサーバ側拒否（400 wipe / 400 VALIDATION_ERROR / 404 NOT_FOUND）で置換して実施。

| ID | 実行 | 結果（remote の最終状態） | 判定 |
|---|---|---|---|
| T1 相互追加 | ✅ | remote {t1,t2,t4} — out-of-band の **t3 消失**。追加前に entry `version=1` 不変を確認 | ❌ 無警告消失（EMIT-001） |
| T2 相互削除 | ✅ | remote {t1,t2} — out-of-band の **t2 削除が復活** | ❌（EMIT-001） |
| T3 本文のみ編集 + remote 追加 | ✅ | remote {t1,t2} — **t3 消失** | ❌（EMIT-001） |
| T4 remote のみ削除 + 本文編集 | ✅ | remote {t1,t2} — **t2 削除が復活** | ❌（EMIT-001） |
| T8b 階層 remote 変更の上書き | ✅ | remote category {qa-cat-a} — out-of-band の **{qa-cat-b,qa-cat-b1} 消滅** | ❌（EMIT-001） |
| T5 wipe bare | ✅ | `❌ [DESTRUCTIVE_TAXONOMY_WIPE] ... Status: HTTP 400` exit 1 / remote 無変化 | ✅ ガード有効 |
| T6 wipe explicit | ✅ | 成功 + `🏷️ Cleared all 2 tag assignment(s)` | ✅ |
| T5c/T6c category 版 | ✅ | 400 → explicit で `Cleared all 1 category assignment(s)` | ✅ |
| T7a cross-taxonomy 注入 | ✅ | サーバ `400 VALIDATION_ERROR: Term ID ... does not belong to taxonomy 'tag'` | ✅ サーバ防衛 |
| T7b local に category slug | ✅ | `❌ Push blocked by Preflight Guards [INVALID_TAXONOMY_ERROR]` exit 1 / remote 無変化 | ✅ |
| T9 未知 slug | ✅ | 同上 exit 1 / remote 無変化 | ✅ |
| T8c 子 term 利用 | ✅ | local 定義に子が無い（remote 48 / local 47）→ preflight で遮断 | ❌ 新 bug（EMIT-008） |
| T10 delete_pending | ✅ | `[DELETE_PENDING_ARTICLE]` exit 1 → `--revive` で成功・flag 0 | ✅ |
| T11 conflict pending | △ | auto-merge 解決後は flag=0 で bare push 成功。残存 copy は doctor だけが報告 | ⚠️ EMIT-009 |
| T12-2 stale base・local 変更なし | ✅ | remote {t2,t3} 維持（B の変更が保持） | ✅ 正しい |
| T12-3 相互変更 | ✅ | `🏷️ Merged remote taxonomy change(s) for tags: +qa-t1, qa-t4` → remote {t1,t2,t4} | ✅ **マージ算法は正しい** |
| T13 端末間削除伝播 | ✅ | B 側 `emit pull` が削除記事を prune（zombie 無し） | ✅ |

## 片付けと collateral 検証
- QA 記事: `emit delete --yes` → local 削除 + `🌐 Remote article deleted` + rescue copy → `conflicts prune --allow-orphan-rescues` で消却
- QA 用語: `DELETE /_emdash/api/taxonomies/{name}/terms/{slug}` ×7 → remote 復帰 tags 58 / category 45
- local 定義: `emit pull-taxonomies` が `2 categories pruned, 4 tags pruned` を報告し QA YAML を削除（A/B とも 58/45）
- collateral: 移行時バックアップ DB と現 DB の **テスト記事以外 168 件の base_snapshots digest が一致**
  （`/tmp/baseline_compare.txt`: 両者 `rows:168 digest:87071f4ef2c52cd8`）
- 最終状態: `emit status` = 169 total / 169 synced / 0 modified / Flags 0-0-0、`emit doctor` = HEALTHY、conflicts 無し

