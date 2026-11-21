# Issue pack — emdash-emit 0.1.12（black-box 検証由来）

共通環境: 0.1.12 / Node 26.3.1 / origin https://aroooy.net / workspace 169 記事 / collection `posts`

---

## EMIT-001 (S1) taxonomy 単独の remote 変更が競合検知の対象にならず、黙って上書きされる
**Class**: `[OBS]`（`/tmp/api_probe.mjs`, `/tmp/tax_compare.mjs`, `/tmp/tax_audit.mjs`）

**Precondition**: 同一記事 A を 2 ワークスペース（`/home/hiroaki/src/aroooy.net` = Device A, `/tmp/ws_b` = Device B）で pull 済み。A の remote tag 割当 = {anker, bose, dahon, gopro-hero13, %fit}。

**Steps**
1. out-of-band（CLI 経由不经由、管理画面相当）で tag を 1 つ追加:
   `POST /_emdash/api/content/posts/{A}/terms/tag` (slug `tools`) → `200`
2. entry を `GET` → **`_rev` が追加前と同一**（例 `OToyMDI2LTExLTA5VDA5OjUxOjQ2LjM1OVo=`）
3. Device A でローカル frontmatter を編集（既存 tags に `anker` を追加）→ `emit push <file>`
4. `GET .../terms/tag` で remote を確認

**Expected**: taxonomy 割当の divergence が検知される（競合フラグ / マージ / 少なくとも警告）。
**Actual**: push は成功し、remote 割当は local の集合で全置換 → 追加された `tools` が**消失**。
`emit status` の Flags は 0/0/0、`posts/conflicts/` は空、警告出力なし。

**Impact**: 管理画面・他端末で行うタグ編集が、次の push で無警告に失われる。Phase 4 の 3-way merge は
entry `_rev` が動いたときだけ発火するため、この経路に到達しない。

**Requested behaviour**: taxonomies を含む push では、entry rev とは独立に
remote 割当（`GET .../terms/{taxonomy}`）と baseline 割当を比較し、差異があれば merge or flag。

---

## EMIT-002 (S1) taxonomy 割当の反映失敗が warning 扱い + baseline に「未反映の意図値」が記録される
**Class**: `[OBS]`（`/tmp/wsBpush.txt` 6–7 行）

**Precondition**: 新規ワークスペース（`categories/`, `tags/` 未取得）で `emit pull <ULID>` した直後。

**Observed**
```
✅ Successfully pushed ... (rev: Nzoy...)
⚠️ Warnings (2):
   👉 Failed to update category terms:  {"success":false,"error":{"code":"NOT_FOUND","message":"Term ID 'development' not found"}}
   👉 Failed to update tag terms:     {"success":false,"error":{"code":"NOT_FOUND","message":"Term ID 'dahon' not found"}}
```
- 本文 push は成功扱い（exit 0・rev 前进）、taxonomy 割当は **remote に一切反映されていない**
- にもかかわらず `.emit/cache.db` の baseline 側 frontmatter は **意図した taxonomy 値**を保持
  → 3-way merge の "base" が remote の事実と食い違う（EMIT-001 の検知能力を further 低下させる）
- `emit pull-taxonomies` 実行後の再 push で是正できた（remote tags: dahon, gopro-hero13, %fit / anker 削除）
  → 失敗原因は slug→term ID 解決がローカル定義ファイルに依存していること

**Requested behaviour**
1. 単一記事 pull でも taxonomy 定義を同期する（またはサーバ側 slug 解決で term ID を引く）
2. 割当反映の失敗は **partial failure としてフラグ化**（exit != 0 or pending flag）し、
   baseline の taxonomy 項目は **remote 実状態のまま**更新しない
3. メッセージに是正手順（`emit pull-taxonomies`）を明示

---

## EMIT-003 (S2) `emit pull --force` が divergence のあるローカルを rescue コピー無しで破棄
**Class**: `[OBS]`（`/tmp/repull.txt`）

`posts/conflicts/` に `.local-dropped.md` 等の退避が発生しないことを `emit conflicts list` で確認
（`✅ No conflicts or rescue backups found`）。非 `--force` 経路では退避されることを対照として確認済み。

**Requested**: `--force` でも退避コピーを書く、少なくとも「退避しない」旨の警告を出す。

---

## EMIT-004 (S2) conflict markers 書き込みが baseline を書き換 え、解除不能状態を作る
**Class**: `[OBS]`（`/tmp/flags.log`, `/tmp/cleanup.log`, `/tmp/restore.log`, `/tmp/final.log` の digest 差異）

- `--resolve-taxonomy=local` の merge 経路でマーカー付きファイルが書かれた後、
  `sync_state.local_hash` が **マーカー込み内容のハッシュ**へ更新される
- その結果、元の正常な内容を復元すると `emit status` が `1 modified` を reporting し、
  doctor は `Taxonomy Conflict Pending` WARN、auto-clear は「unpushed edits あり」で発火しない
- `conflict_at` は設定されつつ `conflict_copy_path` は NULL（不整合ペア）
- 解消には `.emit/cache.db` の直接更新（local_hash/conflict_* の復元）が必要だった

**Requested**: マーカー書き込み時は baseline/local_hash を更新しない（または separate "pending draft" 列）。
`conflict_at` と `conflict_copy_path` はセットで整合させる。解除手順を CLI で提供
（例: `emit conflicts resolve --accept-local` 経由でのみ local_hash 更新）。

---

## EMIT-005 (S2) canonical ファイル名が single pull と batch pull で flip-flop
**Class**: `[OBS]`（`/tmp/repull.txt` と後続 `emit pull` の観察）

- `emit pull <id>` → title 由来の名前へ rename（`…-競合検証テスト記事-HOGE-HOGE.md`）
- 直後の `emit pull`（バッチ）→ 旧名（`…-競合検証テスト記事.md`）へ revert
- 同一 ULID のファイルは常に 1 本のみ（重複なし・status は synced）、ただし名前が安定しない

**Impact**: エディタのバッファ、AI ツールのパス参照、外部リンク運用が不安定。rename が毎 pull で起きうる。

**Requested**: 単一/一括で canonical 名算出の入力解決を統一し、既存ファイル名がある場合は
「title 変更のみでは rename しない」等の決定論的ルール（変更時は 1 回だけ rename + 通知）。

---

## EMIT-006 (S2) future-schema（user_version > 現行）時に `emit status` が未捕捉例外でクラッシュ
**Class**: `[OBS]`（fixture DB に `user_version=3` を設定して再現）

- `emit doctor` → `❌ Error: [CACHE_SCHEMA_MISMATCH] ... Please upgrade emdash-emit.`（exit 1）良好
- `emit status` → **Node の生スタックトレース**（exit 1、データ破壊はなし）

**Requested**: 全コマンド共通の pre-flight guard（起動直後に 1 回）で同じ案内を出す。

---

## EMIT-007 (S3) 文書化/ announced 機能のうち未実装・欠落している項目
**Class**: `[OBS]`（`--help` 出力、`tools/list`、DB 内容）

| 項目 | 観測 |
|---|---|
| `emit doctor --strict-media` | `error: unknown option '--strict-media'`（help は `-c/-p` のみ） |
| `emit conflicts list --all` | 未実装（既定で conflict/deleted 両型を一覧するため実害は小） |
| MCP からの `conflicts prune` | `sync_conflicts` の action enum は list/diff/resolve のみ → AI agent が掃除不能 |
| pull 時の media 台帳 | `media_state` は 0 行のまま（pull 後の media 冪等性が台帳で担保されない） |
| MCP heartbeat の origin | `{pid, version, startedAt}` のみ（複数サイト運用で識別不能） |
| 旧 MCP プロセスの追跡 | 最新 1 プロセスのみ追跡。0.1.11 起動名の MCP が 4 本生存しても WARN が出ない |
| heal 差分の開示 | 「Repaired frontmatter syntax」の具体的な変更内容・skip 理由が CLI/DB に残らない |

---

## EMIT-008 (S1) 下位（子）term が `pull-taxonomies` で取得されず、階層 taxonomy が使用不能
**Class**: `[OBS]`（`/tmp/v0112-eval/logs/T5_T9.log` T8c / `01_state_after_setup.log`）

- `POST /_emdash/api/taxonomies/category/terms {slug:"qa-cat-b1", parentId:<qa-cat-b id>}` → 201 で作成本地 OK、
  `GET .../terms/tag|category` の **children 配下**に返る（remote 階層フラット化で category 48 件）
- `emit pull-taxonomies` 後のローカル定義は **47 件（上位のみ）**。`tags/categories` に子 term の YAML が作られない
- その結果、記事 frontmatter に `categories: [qa-cat-b1]` を書いて push すると
  `❌ Push blocked by Preflight Guards: [INVALID_TAXONOMY_ERROR] Unknown categories term: 'qa-cat-b1'.`
  （exit 1）→ **hierarchical: true の taxonomy の子用語が emit 経由で一切使えない**

**Requested**: `pull-taxonomies` が children を再帰取得してローカル定義に含める（`parentId` を YAML に保持）。
preflight 検証もフラット化した用語集合に対して行う。

---

## EMIT-009 (S2) quarantine copy が残っていても `conflict_pending` は 0 で `status` の Flags にも出ない
**Class**: `[OBS]`（`/tmp/v0112-eval/logs/T12.log` の doctor 出力と同一時点の status/DB）

- 409→hybrid merge 解決後に `posts/conflicts/<file>.conflict.md` が 1 件残存
- 同一時点: `sync_state.conflict_pending = 0`, `conflict_copy_path = null`, `emit status` = `170 synced / Flags 0-0-0`,
  `emit push`（bare）は exit 0 で成功。`emit doctor` だけが `⚠️ Conflicts & Quarantine: 1 quarantined file(s)` を報告
- 解消手段（`emit conflicts resolve --accept-canonical`）は機能するが、**status 側に入口が表示されない**ため
  ユーザ/AI agent は doctor を実行するまで気づかない

**Requested**: `status` の Flags に unreviewed quarantine 件数を出す（または doctor WARN と同じ基準で警告行）。

---

## ✅ 第三者検証で「効いている」と確認できたガード（positive findings）
| # | 観測 | 証跡 |
|---|---|---|
| P1 | 全消し bare push が HTTP 400 で拒否（`DESTRUCTIVE_TAXONOMY_WIPE`）。`--allow-wipe-taxonomies` 時のみ成功＋明示警告 | `T5_T9.log` L13–34 |
| P2 | 存在しない term slug は **push 前に** local preflight で遮断（remote 無変化・exit 1・「Did you mean」候補） | `T5_T9.log` L80–111 |
| P3 | サーバも taxonomy 跨ぎ term ID を拒否（`400 VALIDATION_ERROR: Term ID ... does not belong to taxonomy 'tag'`） | `T5_T9.log` L75 |
| P4 | `delete_pending` 記事の bare push 拒否＋`--revive` で復帰（flag は 0 に戻る） | `T10_cleanup.log` |
| P5 | 端末 A で削除した記事は端末 B の `emit pull` で prune され zombie 化しない | ws_b `🗑️ Pruned v0112-e2e-verification-20261109` / `qa-taxonomy-harness` |
| P6 | **local が taxonomy を変更していない push では remote の taxonomy 変更が保持される**（正しい挙動） | `T12.log` T12-2 |
| P7 | 相互変更 case では 3-way union が正しい結果になる：`🏷️ Merged remote taxonomy change(s) for tags: +qa-t1, qa-t4` → remote {t1,t2,t4} | `T12_3.log` |
| P8 | 削除時に rescue copy、孤島 copy の prune は `--allow-orphan-rescues` が必要（安全側） | `T10_cleanup.log`, prune dry-run |

## EMIT-001 の射程（実施後の訂正）
`Merged remote taxonomy change(s)` パス（= 3-way マージ機構）は **到達すれば正しい**（P7）。
問題は「out-of-band の taxonomy 変更が entry `version`/`updatedAt` を動かさないため
`remote_rev` が一致し、409→merge に到達しない」こと（T1/T2/T3/T4/T8b で全て無警告上書き）。
したがって本命修正は **R1（taxonomy 独立 divergence 検知）** であり、マージ算法の書き直しは不要。

