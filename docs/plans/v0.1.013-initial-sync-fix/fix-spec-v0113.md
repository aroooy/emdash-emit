# Fix specification v0.1.13 — taxonomy divergence / baseline integrity / CLI robustness

評価元 `docs/v0112-eval/fix-spec-taxonomy.md`（R1〜R6, A1〜A7）を、ソース照合で確定した
微調整（`issues-v0113.md`）に沿って改訂したもの。判定は CLI 出力 / HTTP 状態 / `.emit/cache.db` の列値 /
ファイルツリーの 4 種類だけで行える contract のみとする。

---

## R1: taxonomy 変更を entry rev と独立に検知する（EMIT-001）

### Invariant（必須不変条件）
> 「remote の taxonomy 割当」が baseline 記録と異なる場合、その記事の push は
> (a) 3-way merge を経由する、または (b) conflict pending フラグを立てて bare push を拒否する。
> いずれでもなければ push してはならない。

### Required behaviour

1. **PUT/POST に先立つ audit**: push 対象の記事に `taxonomies.categories` / `taxonomies.tags` のいずれかが
   ローカルに存在する場合、`GET /_emdash/api/content/{collection}/{id}/terms/categories` と
   `.../terms/tags` を必ず発行する（最大 2 リクエスト）。
2. **3 状態判定（必須）**: remote 割当は `assigned[]` / `none ([])` / `unknown (fetch failed)` の 3 状態で扱う。
   現行 `fetchAssignedTerms()` は失敗時に `null` を返す設計を維持する（`src/sync/terms.ts:31,53,59`）。
   **`unknown` を `none` と解釈してはならない**（誤 wipe を生む）。`unknown` の場合は
   baseline 割当を remote 側とみなして merge に進み、`⚠️ Remote taxonomy state unknown` を警告出力する。
3. **baseline hash**: `sync_state.remote_taxonomy_hash` = `sha256(sorted(categorySlugs) + '|' + sorted(tagSlugs))`
   （`base_snapshots` 側にも同じ定義で保持してよい）。pull 成功時・push 成功時に必ず更新する。
4. **divergence 合流**: `hash(remote now) != hash(baseline)` なら **rev の一致に関係なく**
   現行の 409 相当処理へ合流させる（`hybrid3WayMerge()` → `DESTRUCTIVE_TAXONOMY_WIPE` /
   `TAXONOMY_CONFLICT_PENDING`）。**算法は変更しない**（`src/sync/merge.ts:94-175`）。
5. **remoteTax の再利用**: 409 が発生した場合、audit で取得済みの remote 割当を再利用し再取得しない
   （成功時の追加リクエストは 1 記事 2 GET に抑える）。
6. **マージ成功時**: `🏷️ Merged remote taxonomy change(s): …` を出力し、baseline の taxonomy と hash を
   **実際に POST した結果の GET** で更新する。
7. **taxonomies 欠落記事**: ローカルに taxonomies が無い記事は GET を省略してよい（性能保護）。
   `taxonomies:` 欠落は「変更なし」と解釈する（空配列のみ wipe）。**この場合 R1 の検知対象にならないことを
   CHANGELOG に明記する**。
8. **コスト制御**: `--no-taxonomy-audit`（その旨警告付き）または 5 分 TTL キャッシュを推奨。

### Migration（必須）

- `remote_taxonomy_hash` は新列 → `CURRENT_CACHE_SCHEMA_VERSION` を **1 → 2** に上げる（`src/db/cache.ts:84`）。
- v0.1.12 の migration 手順を踏む: `PRAGMA wal_checkpoint(TRUNCATE)` → `.bak-0.1.12-<timestamp>` バックアップ
  （3 generation retention）→ `ALTER TABLE ADD COLUMN`（`src/db/cache.ts:239-271` の既存パターン）。
- future guard（`CACHE_SCHEMA_MISMATCH`, `src/db/cache.ts:195-199`）は R4（EMIT-006 対応）で全 CLI に波及させる。
- **後方互換テスト**: v2 DB を旧バイナリで開いた時に `[CACHE_SCHEMA_MISMATCH]` 案内のみ出ることを assert する
  （`tests/cache.test.ts:280` の対照パターン）。

---

## R2: 割当反映失敗を partial failure として扱う（EMIT-002）

### Invariant
> remote に反映できていない値を baseline に書いてはならない。失敗がある限り exit code は 0 以外、
> または解決済みとみなされない pending フラグが立つ。

### Required behaviour

1. **単一 pull でも taxonomy 定義を同期する**（NOT_FOUND の未然防止）。CLI（`src/cli/commands/pull.ts:203-212`）と
   MCP `sync_pull`（`src/mcp/tools/sync-pull.ts:147-150`）の**両方**で実施。`postsOnly: true` は明示指定時のみ。
2. **失敗の扱い**: 本文 PUT 成功後に term 割当 POST が失敗した場合
   - `emit push` は **非ゼロ終了**、または `sync_state.taxonomy_apply_pending = 1`（新ガード G17
     `TAXONOMY_APPLY_PENDING`）を立て bare push を拒否する。MCP は `formatToolError()` 経由で `[CODE]` を返す。
   - **baseline の taxonomy 項目と taxonomy hash のみを旧値に戻す**（frontmatter 全体を巻き戻さない。
     本文が正常に push 済みなのに phantom conflict 化するため）。
   - 是正手順 `emit pull-taxonomies` → 再 push を指示として出力する。
3. **失敗 slug は保持**: ローカル frontmatter は壊さず、原因を term 名で列挙する。

### スキーマ影響
`taxonomy_apply_pending`（または同等の pending 列）も schema v2 へ同時に追加する（R1 と同一 migration）。
---

## R3: baseline / sync_state 書き換え規則の明確化（EMIT-004）— 4 点セット

1. **マーカー込み内容で local_hash を更新しない**
   `emit push` が conflict marker をローカルへ書く場合、`sync_state.local_hash` は
   マーカー込みハッシュへ更新しない（現行 taxonomy-only 分岐 `src/sync/push.ts:1114` の挙動を
   body conflict ありの場合にも拡張）。マーカー付き内容は `conflict_copy_hash` 側に保持する。
2. **baseline は remote 実状態で更新する**（現行 `src/sync/push.ts:1123-1132` を維持）。
   baseline を古いままだと再 push 時の base が remote と一致して clean-edit 誤判定で remote 変更を潰す。
3. **`conflict_at` / `conflict_copy_path` / `conflict_copy_hash` は必ずセットで整合させる**
   実原因は `saveSyncState()` に `conflictCopyPath` / `conflictAt` を渡していないこと
   （`src/sync/push.ts:1111-1121`）。全列 UPSERT（`src/db/cache.ts:412-442`）で未指定が NULL になるため、
   全列を明示的に渡すか `setConflictPending()`（`src/db/cache.ts:445-461`）を使って conflict 列を書き換えない。
   **どちらか一方のみを立てる状態を禁止**（doctor で検出し解消手順へ誘導）。
4. **解除は `emit conflicts resolve` 経路でのみ行い、resolve 完了時に local_hash を再計算する**。
   auto-clear（`src/sync/doctor.ts:281-288`）は「conflict copy なし かつ divergence なし」のみで発火する。

**受け入れ**: どのテストの後も **DB を直接編集せずに** `emit conflicts resolve` / `--resolve-taxonomy` で
解除できること（A7）。

---

## R5: 下位 term の取得と用語集合の一元化（EMIT-008）

1. `GET /_emdash/api/taxonomies/{name}/terms` の `children` を **再帰 flatten** して
   `categories/<id>-<label>.yaml` / `tags/<id>-<label>.yaml` に書き出す。`parentId` を YAML に保持し、
   深さ順（親 → 子）で出力する（`src/sync/taxonomies.ts:95-98,127-134,172-179`）。
2. **用語検証・ID 解決はフラット化した集合に対して行う**（3 経路すべて）:
   - preflight G4（`INVALID_TAXONOMY_ERROR`）
   - slug→term ID 解決 `loadLocalTaxonomyMaps()`（`src/sync/taxonomies.ts:266`）
   - frontmatter 用語 canonicalize（`src/sync/push.ts:601-615`）
3. **prune 整合**: 既存 YAML の prune（`src/sync/taxonomies.ts:142-154,187-199`）は flatten 後の全 term を
   active として扱う。件数増加を pull 出力と CHANGELOG に報告する。
4. **同一 slug の親子が共存した場合**の決定論（count → ULID desc の既存規則 `src/sync/taxonomies.ts:273-280`）を維持し、
   衝突時は警告を出す。

---

## R6: quarantine の可視性（EMIT-009 / EMIT-003）

1. **CLI は既に報告する**（`src/sync/status.ts:103-113,211` → `src/cli/commands/status.ts:178-192`）。
   v0.1.13 の作業は **欠落層の補完**に限定する:
   - MCP `sync_status` の summary に `conflicts` 件数を露出し、未解決 copy が 1 件以上ある場合は
     `⚠️ N unreviewed quarantine copy(ies)` を doctor と同一基準で返す。
2. **型を区別して表示**: `.conflict.md`（pull divergence）/ `.local-dropped.md`（`--force` で破棄されたローカル）/
   `.deleted.md`（削除 backup）を list/status/doctor で分類する。
3. `emit pull --force` 実行時に退避が走った旨の警告行を出す（非 force 経路の `🛡️` 案内と同等）。

---

## R4: CLI 共通のエラーハンドリング（EMIT-006）

1. **全コマンド共通の pre-flight guard** を 1 箇所（context 解決直後、action 実行前）で実施し、
   `CACHE_SCHEMA_MISMATCH` を含むローカル失敗を `❌ <message>` 1 行＋`process.exit(1)` に変換する
   （AGENTS.md「CLI failure presentation」）。`emit status`（`src/cli/commands/status.ts:82-85`）と
   `throw error` を残す pull 系（`src/cli/commands/pull.ts:247,298,368`）を対象に含める。
2. 生スタックトレースを stdout/stderr に出さない。`emit doctor` の既存案内文言を基準として全コマンドで統一する。
3. MCP 側は `formatToolError()`（`src/mcp/tool-errors.ts`）で `[CODE]` / status / suggestion を保持する
   （AGENTS.md「MCP tool error contract」）。

---

## R7: canonical ファイル名の決定論的ルール（EMIT-005）

1. 単一 pull と一括 pull で **同じ入力解決**を使う（title || slug、date prefix、status ディレクトリ）。
   date prefix の優先順位を固定する: `remote publishedAt` → `remote createdAt` → `既存ファイルの date prefix`。
2. **title 変更のみでは rename しない**: 既存ファイル名を正とし、rename は
   status 変更・date prefix 変更のみに限定し、**1 回だけ rename + 通知**（`↔️ Renamed …`）。
3. 同一 ULID のローカルファイルは常に 1 本（`extractUlidFromFilename()` による追跡と
   `src/sync/pull.ts:801-804` の stale unlink を維持。case-insensitive FS で casing 差のみで消さない）。

---

## R8: S3 インターフェース整備（EMIT-007）

| 作業 | 内容 |
|---|---|
| `emit doctor --strict-media` | `.option('--strict-media')` を追加し `runDoctor({ strictMedia })` へ接続（ロジックは既存 `src/sync/doctor.ts:62,419-424`）。MCP `sync_doctor` にも引数透過 |
| MCP `sync_conflicts` | action enum に `prune` を追加（`olderThan` / `dryRun` / `allowOrphanRescues` を CLI と同じ安全条件で） |
| MCP heartbeat | origin / profile 名 / workspace root を record に追加し、複数サイト運用で識別可能にする |
| 旧 MCP プロセス追跡 | 現行 version・origin と異なる生存プロセスを検出して WARN |
| heal 差分の開示 | `Repaired frontmatter syntax` の変更内容（frontmatter キー単位）と skip 理由を CLI 出力＋DB に記録 |
| pull 時の media 台帳 | （任意）pull 後の media 冪等性を `media_state` で担保 |

---

## 受け入れテスト（第三者が CLI/API/FS だけで合否判定）

A1〜A7 は評価元の契約を維持し、A8〜A14 を追加する。全テストで
**remote terms・local terms・CLI exit code・status Flags・doctor 最終行**の 5 点に加え、
必要に応じて `.emit/cache.db` の列値とファイルツリーで判定する。

| # | 手順（out-of-band 含む） | 合否判定 |
|---|---|---|
| A1 | pull → 直接 API で tag 追加 → local の別 tag を追加して push → 直接 API で terms 取得 | 追加した tag が **両方残る**。CLI に merge 通知または conflict 案内。静かな消失は不可 |
| A2 | 同上で local 側が同一 tag を削除 → push | 相互削除なら tag 消失＋警告なし、片側削除なら remote 側の意図が保持される |
| A3 | `tags: []` で push | `DESTRUCTIVE_TAXONOMY_WIPE`（400 相当）＋ `--allow-wipe-taxonomies` 指示 |
| A4 | `tags: [] --allow-wipe-taxonomies` | 全削除が反映され、`🏷️ Cleared all N …` 相当の警告と成功終了 |
| A5 | `categories/`,`tags/` 無い新規 workspace で `pull <id>` → taxonomy 変更して push | NOT_FOUND が出ない（definitions 自動取得）、または **非ゼロ終了 + baseline 非更新**（remote terms は無変化） |
| A6 | A5 失敗後に `pull-taxonomies` → 再 push | remote terms が期待値になる。baseline hash と remote terms の hash が一致 |
| A7 | どのテスト後も `emit doctor` = HEALTHY / `status` Flags 説明可能 / `posts/conflicts/` に未解決コピーが残らない | 残る場合は **DB 直編集なしで**解除手順が CLI に存在すること |
| A8 | 階層 taxonomy（親+子）を作り `pull-taxonomies` → local 定義件数を確認、`categories: [<childSlug>]` を push | local 定義件数 = remote フラット件数。push 成功し remote terms に子が現れる。YAML に `parentId` が保持されている |
| A9 | taxonomy audit 中に `GET .../terms/{taxonomy}` を 500 で失敗させる（mock） | **remote 割当を `[]` と解釈しない**。baseline 割当で merge に進み `⚠️ Remote taxonomy state unknown` 相当の警告。remote terms は無変化 |
| A10 | schema v2 化後の DB を旧バイナリ（v1 対応）で開く | `[CACHE_SCHEMA_MISMATCH]` の案内のみで終了しデータ破壊なし。`.bak-0.1.12-*` が保持されている |
| A11 | 409 → taxonomy-only conflict を起こし、マーカー付き状態を確認 → 正常内容へ戻す | `emit status` は phantom `modified` を報告しない。`conflict_at` / `conflict_copy_path` / `conflict_copy_hash` が **すべて非 NULL**（またはすべて NULL）。`emit conflicts resolve` で解除可能 |
| A12 | 同一 ULID を `pull <id>` → `pull`（一括）の順で実行（title を 1 度変更した場合を含む） | ファイル名が flip-flop しない。rename が起きるのは status/date 変更時のみで、その場合は通知が 1 回 |
| A13 | fixture DB の `user_version = 3` で `emit status` / `emit diff` / `emit pull` / `emit push` | 全コマンドが `❌ … [CACHE_SCHEMA_MISMATCH] …` 1 行＋exit 1。生スタックトレースなし |
| A14 | `posts/conflicts/` に `.conflict.md` / `.local-dropped.md` / `.deleted.md` を各 1 件残して `emit status`, `emit conflicts list`, MCP `sync_status` | 3 状態が **型を区別して** CLI と MCP の両方に警告として出る。`emit pull --force` は退避時に警告行を出す |

### 単体テストでのみ担保する領域（第三者検証不能）

- `mergeTaxonomies()` の内部順序・排他 taxonomy で union がサーバ制約に拒否される case
  （`TAXONOMY_UNION_REJECTED`, `test-matrix-taxonomy.md` E1）→ `tests/` の direct unit test
- baseline serialization invariant: `base_snapshots.frontmatter_yaml` は JSON-encoded Frontmatter であり、
  `serializeMarkdown(JSON.parse(...), body)` の出力が pull/push の disk 出力と byte-identical であること
  （AGENTS.md。R1/R3 の変更に伴い `tests/diff.test.ts` を更新）

---

## Step 順と依存関係

| Step | Issue | 依存 |
|---|---|---|
| 0 | EMIT-009 / EMIT-003 の再現確認（現行 dist で T11/T12・`pull --force` を再実行） | — |
| 1a | EMIT-008（R5） | なし。**先に実施**すると階層 term で A1/A8 が組める |
| 1b | EMIT-001（R1 + schema v2 migration） | R5（子 term を用いた divergence テスト）, R4（migration 失敗時の案内） |
| 1c | EMIT-002（R2） | R1（taxonomy hash が baseline 保護の基準になる） |
| 2a | EMIT-006（R4） | なし（先に実施すると migration エラー経験が安全になる） |
| 2b | EMIT-004（R3 4点セット） | R1（divergence 検知で conflict 経路の発生頻度が上がる） |
| 2c | EMIT-005（R7） | なし |
| 3 | EMIT-007（R8）＋ EMIT-009/003 の警告文言強化（R6） | R3（conflict copy の型区別） |

## 完了条件

`npm run check`（`format:check` + `typecheck` + `test`）が green、A1〜A14 が本番 QA ハーネス
（`/tmp/qa.mjs`, `/tmp/qa_local.mjs`, `/tmp/qa_run_*.sh`）で合格し、collateral（テスト記事以外の記事の
base_snapshots digest）が不変であること。AGENTS.md の §9 ガード記述と Canonical Frontmatter Schema、
CHANGELOG を同時更新すること。

