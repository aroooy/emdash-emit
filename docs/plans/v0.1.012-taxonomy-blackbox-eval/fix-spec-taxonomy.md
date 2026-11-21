# Fix specification (black-box): taxonomy divergence detection & failure integrity

> ソースを見ずに、**観測可能な contract だけ**で書いた修正案。受け入れ判定は CLI 出力 / HTTP 状態 /
> `.emit/cache.db` の列値 / ファイルツリーの 4 種類だけで判定できるもののみ。

## 前提として確認できた API 実状（第三者観測）
| 観測 | 内容 |
|---|---|
| `GET /_emdash/api/content/posts/{id}` | `_rev` を返すが **taxonomy 割当を含まない** |
| `GET /_emdash/api/content/posts/{id}/terms/{taxonomy}` | 割当一覧を返す（emit 自身が 409 処理で利用している） |
| `POST /_emdash/api/content/posts/{id}/terms/{taxonomy}` | 割当成功。ただし **entry の `_rev` を変化させない**（EMIT-001 の実測） |
| 未知 term に対する割当 | `404 {"code":"NOT_FOUND","message":"Term ID 'x' not found"}` を返す |

## R1: taxonomy 変更は entry rev と独立に検知する（EMIT-001 対策）
**Invariant (必須不変条件)**
> 「remote の taxonomy 割当」が baseline 記録と異なる場合、その記事の push は
> (a) 3-way merge を経由する、または (b) conflict pending フラグを立てて bare push を拒否する。
> いずれでもなければ push してはならない。

**Required client behaviour**
1. push 対象の記事に `taxonomies.categories` / `taxonomies.tags` のいずれかが **ローカルに存在する場合**は、
   PUT/POST に先立って `GET .../terms/categories` と `GET .../terms/tags` を必ず発行する（最大 2 リクエスト）。
2. baseline 側にも「最後に観測した remote 割当」を保持する。
   建议列（新 schema）: `base_snapshots.remote_taxonomy_hash`（または `sync_state.remote_taxonomy_hash`）=
   `sha256(sorted(categorySlugs) + '|' + sorted(tagSlugs))`。
3. `hash(remote now) != hash(baseline)` なら **rev 一致に関係なく** divergence 扱い → 現行の 409 相当処理
   （3-way merge、`DESTRUCTIVE_TAXONOMY_WIPE` guard、`TAXONOMY_CONFLICT_PENDING`）へ合流させる。
4. マージ成功時は `🏷️ Merged remote taxonomy change(s): …` を出力し、
   baseline の taxonomy/hash を **実際に POST した結果の GET** で更新する。
5. ローカルに taxonomies が無い記事は GET を省略してよい（性能保護）。その場合 `taxonomies:` 欠落は
   「変更なし」と解釈する（＝削除と非削除の区別は現行どおり、空配列のみ wipe として扱う）。

**Cost**: taxonomy を持つ記事の push 1 本につき GET 2 回。169 記事一括 push なら最大 338 リクエスト。
   抑えたい場合 `--no-taxonomy-audit` で無効化（その旨警告）、または 5 分 TTL キャッシュを推奨。

## R2: 割当反映失敗は partial failure として扱う（EMIT-002 対策）
**Invariant**
> remote に反映できていない値を baseline に書いてはならない。失敗がある限り exit code は 0 以外、
> または解決済みとみなされない pending フラグが立つ。

**Required client behaviour**
1. 本文 PUT 成功後に term 割当 POST が失敗したら
   - `emit push` は **非ゼロ終了**（または `TAXONOMY_APPLY_PENDING` を sync_state に立てる）
   - baseline の taxonomy 項目・taxonomy hash は **変更前の値**のまま
   - 「是正: `emit pull-taxonomies` → 再 push」を指示として出力
2. 単一記事 pull（`emit pull <id>`）でも taxonomy 定義を同期する。CLI 自身の help は
   `pull` が taxonomies を自動取得すると説明しており、`tags/categories` 未取得での NOT_FOUND は
   ドキュメントとの不整合でもある（EMIT-002）。
3. term 解決に失敗した slug は **保持**（ローカル frontmatter は壊さない）し、原因を term 名で列挙。

## R3: baseline 書き換え規則の明確化（EMIT-004 対策）
- conflict markers をローカルに書く操作は **baseline（base_snapshots）と sync_state.local_hash を更新しない**
- `conflict_at` を立てる場合は `conflict_copy_path` を必ず同時に立てる（どちらか一方のみは禁止）
- 解除は `emit conflicts resolve` 経路でのみ行い、resolve 完了時に local_hash を再計算する

## R4: 受け入れテスト（第三者が CLI/API だけで合否判定）
| # | 手順（out-of-band 含む） | 合否判定 |
|---|---|---|
| A1 | pull → 直接 API で tag 追加 → local の別 tag を追加して push → 直接 API で terms 取得 | 追加した tag が **両方残る**。CLI に merge 通知または conflict 案内。`status` の Flags > 0 でも可（静かな消失は不可） |
| A2 | 同上で local 側が同一 tag を削除 → push | 「相互削除」なら tag 消失＋警告なし、片側削除なら remote 側の意図が保持される |
| A3 | `tags: []` で push | `DESTRUCTIVE_TAXONOMY_WIPE`（400 相当）＋ `--allow-wipe-taxonomies` 指示 |
| A4 | `tags: [] --allow-wipe-taxonomies` | 全削除が反映され、`🏷️ Cleared all N …` 相当の警告と成功終了 |
| A5 | `categories/`,`tags/` 無い新規 workspace で pull\<id\> → taxonomy 変更して push | NOT_FOUND が出ない（ definitions 自動取得 ）、または **非ゼロ終了 + baseline 非更新**（remote terms は無変化） |
| A6 | A5 失敗後に `pull-taxonomies` → 再 push | remote terms が期待値になる。baseline hash と remote terms の hash が一致 |
| A7 | どのテスト後も `emit doctor` = HEALTHY / `status` Flags 説明可能 / `posts/conflicts/` に未解決コピーが残らない | 残る場合は解除手順が CLI に存在すること |

## R5: 下位 term の取得（EMIT-008 対応）
- `GET /_emdash/api/taxonomies/{name}/terms` は `children` をネストして返す。
  ローカル定義へは **再帰フラット化**して書き出す（`parentId` を YAML に保持し、深さ順に出力）。
- preflight の用語検証もフラット化した集合に対して行う（現状は上位のみのため子 term が `INVALID_TAXONOMY_ERROR`）。
- 追加テスト: 親+子を持つ taxonomy を作り `pull-taxonomies` → local 定義件数 = remote フラット件数、
  `categories: [<childSlug>]` の push が成功し、remote terms に子が現れる。

## R6: quarantine の可視性（EMIT-009 対応）
- `posts/conflicts/` に未 review の copy が 1 件でもある場合、`emit status` は Flags 行とは別に
  `⚠️ 1 unreviewed quarantine copy` を出し、`emit doctor` と同一基準で警告する。

## 実施で確定した事実（本番 QA ハーネス / 2026-11-09）
- out-of-band の terms POST は entry の `version` / `updatedAt` を **変化させない**
  → `remote_rev`（= base64("<version>:<updatedAt>")）が一致し 409→merge に到達しない（T1/T2/T3/T4/T8b で再現）
- 逆に `version` が動けば（＝もう一方の端末が push した場合）**現行の 3-way union は正しい結果を返す**
  （`🏷️ Merged remote taxonomy change(s) for tags: +qa-t1, qa-t4`）
  ⇒ **算法の書き直しは不要。R1 の検知追加のみで T1〜T4/T8b は解消する見込み**（受け入れ条件 = 下記 A1〜A4 が {union} になること）

## 実在ハーネス（この仕様の受け入れテストを実際に回したスクリプト）
- `/tmp/qa.mjs` — out-of-band API（list-terms / create-term / delete-term / get-terms / set-terms / get-entry / probe-cross / probe-unknown）
- `/tmp/qa_local.mjs` — frontmatter 読写（set-tags/set-cats/body）、`.emit/cache.db` の sync_state + base_snapshots 読取（`QA_WS` 環境変数でワークスペース切替）
- `/tmp/qa_run_T1_T4.sh`, `/tmp/qa_run_T5_T9.sh`, `/tmp/qa_run_T12.sh`, `/tmp/qa_run_T12_3.sh`, `/tmp/qa_run_T10_cleanup.sh`
- `/tmp/baseline_compare.mjs` — バックアップ DB と現 DB の base_snapshots digest 比較（collateral ゼロの証明）

