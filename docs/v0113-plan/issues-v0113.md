# Issue 更新（v0.1.13）— v0.1.12 Issue Pack のソース照合結果

共通環境: origin `https://aroooy.net` / collection `posts` / 評価時バイナリ 0.1.12
照合対象: 本リポジトリ `src/`（v0.1.12, `package.json` version 0.1.12）

凡例: **確認済** = レビュー指摘が源码と一致 / **部分実装済** = 一部は v0.1.12 で既に動作 /
**要再現確認** = 現行 dist での再実行後にスコープ確定

---

## S1 — データ不整合・消失リスク

### EMIT-001 (S1) taxonomy 単独の remote 変更が競合検知の対象にならず黙って上書きされる — **確認済（最重要）**

**源码での裏取り**

| 事実 | 箇所 |
|---|---|
| remote 割当を読む `fetchAssignedTaxonomies()` は **409 分岐の中でしか呼ばれない** | `src/sync/push.ts:951`（`if (res.status === 409)`）→ `:992` |
| out-of-band terms POST は entry `_rev` を動かさない → PUT が成功し merge 経路に到達しない | 評価実測（T1/T2/T3/T4/T8b）＋ 上記制御構造 |
| マージ算法は base/local/remote の 3 引数で正しく動作 | `src/sync/push.ts:1028` → `src/sync/merge.ts:94-175`（集合代数）, 評価 P7 |

**対応**: R1（PUT 前に自発 GET で divergence 検知 → 現行 3-way マージ／ガードへ合流）。算法は触らない。
**追加要件**: schema v2 migration と 3 状態判定（`fix-spec-v0113.md` §R1 参照）。

---

### EMIT-002 (S1) 割当反映失敗が warning 扱い＋ baseline に未反映の意図値が記録される — **確認済**

**源码での裏取り**

| 事実 | 箇所 |
|---|---|
| terms POST 失敗が `warnings` に落ちるだけ（exit 0 で通過） | `src/sync/push.ts:768-771` |
| 成功時と同じ baseline / sync_state 更新がそのまま走る（意図値で更新） | `src/sync/push.ts:1280-1300` |
| slug→term ID 解決がローカル定義に依存 | `src/sync/push.ts:711-729`（`loadLocalTaxonomyMaps()` `src/sync/taxonomies.ts:266`） |
| 単一 pull は taxonomy 定義を同期しない | CLI `src/cli/commands/pull.ts:203-212`（"Single article mode: articles only"）／MCP `src/mcp/tools/sync-pull.ts:147-150`（"unless postsOnly or single-article mode"） |

**対応**: R2。**CLI と MCP の両方**で単一 pull の taxonomy 同期が必要（レビューは CLI しか見ていない）。
baseline 巻き戻しは **taxonomy 項目と taxonomy hash の限定範囲**に限る（frontmatter 全体だと本文の clean-edit 判定が壊れる）。

---

### EMIT-008 (S1) 子 term が `pull-taxonomies` で取得されず階層 taxonomy が使用不能 — **確認済（実装範囲を拡大）**

**源码での裏取り**

| 事実 | 箇所 |
|---|---|
| `fetchTerms()` は `data.terms` をそのまま返し children を走査しない | `src/sync/taxonomies.ts:95-98` |
| YAML 書き出しは上位のみ。`parentId` フィールド自体は存在（常に null になる） | `src/sync/taxonomies.ts:127-134, 172-179` |
| その結果 preflight G4 が子 slug を拒否 | 評価実測 `[INVALID_TAXONOMY_ERROR] Unknown categories term: 'qa-cat-b1'` |

**対応**: R5（children 再帰 flatten＋`parentId` 保持）。加えて以下を同一 Issue のスコープに含める。

- **termId 解決経路**: `loadLocalTaxonomyMaps()`（`:266`）が同じ YAML を読む → flatten で自動的に解消するが、テストは必須
- **frontmatter canonicalize**: `src/sync/push.ts:601-615` `canonicalizeTerms()` も同じ集合を使用
- **prune 影響**: `:142-154, 187-199` は `activeFileNames` 基準。children 追加で既存環境の YAML が増える（件数変化を CHANGELOG に記載）

---

## S2 — 運用・状態復旧の阻害

### EMIT-003 (S2) `emit pull --force` が rescue コピー無しで破棄する — **部分実装済 → 要再現確認**

**源码での裏取り（v0.1.12 で退避は走る）**

| 事実 | 箇所 |
|---|---|
| force 経路も含め divergence を退避 | `src/sync/pull.ts:243-289`（`quarantineDivergentLocalCopies()`）, `isForce: Boolean(options.force)` `:275` |
| force 時は `.local-dropped.md` サフィックス（dedupe 分岐は非 force のみ） | `src/sync/pull.ts:200, 208, 224-226` |
| baseline 未キャッシュでも退避（`reason: 'no-cache-baseline'`） | `src/sync/pull.ts:267, 283` |

**残存する欠落（v0.1.13 の実スコープ）**

1. `emit pull --force` 実行時に `.local-dropped.md` が生成された旨の警告行が明示的か
   （非 force 経路の `🛡️` 案内と同等の可視性）
2. `.local-dropped.md` が `emit conflicts list` / `status` / `doctor` で **conflict copy と区別して**表示されるか
3. 評価ログ（`/tmp/repull.txt`）が上記実装より前のバイナリに対する観測でないことの確認

→ 再現結果により S2 → S3 相当の軽微な対応（警告文言）へ降格する。

---

### EMIT-004 (S2) conflict marker 書き込みが baseline を書き換え解除不能状態を作る — **確認済（原因を特定）**

**源码での裏取り**

| 事実 | 箇所 |
|---|---|
| taxonomy-only conflict では localHash を保持（body マーカーも書かない） | `src/sync/push.ts:1093-1105, 1114` |
| body conflict ありの場合はマーカー込みハッシュで localHash を更新 → **正常内容へ戻すと phantom `1 modified`** | `src/sync/push.ts:1107-1114` |
| **`conflict_at` あり / `conflict_copy_path` NULL の実原因**: `saveSyncState()` に `conflictCopyPath`/`conflictAt` を渡していない。全列 UPSERT なので未指定値が NULL で上書きされる | `src/sync/push.ts:1111-1121`（`conflictPending: 1, conflictCopyHash` のみ）＋ `src/db/cache.ts:412-442`（UPSERT 全列）／本来の setter は `src/db/cache.ts:445-461` |
| baseline は remote 実状態で更新されている（これは正しい・維持すべき） | `src/sync/push.ts:1123-1132` |

**対応**: R3 を **4 点セット**として仕様化（`fix-spec-v0113.md` §R3）。DB 直編集なしで解消できることを contract テスト化する。

---

### EMIT-005 (S2) canonical ファイル名が single pull と batch pull で flip-flop — **確認済（非対称点を特定）**

**源码での裏取り**

| 経路 | 名前算出 | 非対称点 |
|---|---|---|
| batch fast-path | `src/sync/pull.ts:537-558` `computeArticleRelativePath(collection, status, id, rawTitle, articleDate)` | date prefix 解決が `rawObj.publishedAt → item.publishedAt → **existingPrefix** → createdAt` の順（既存ファイルの日付を remote 日より後に挟む） |
| single pull | `src/sync/pull.ts:792-798` `frontmatter.title \|\| frontmatter.slug`, `dateInput` は別経路 | 既存パスの date prefix を優先しない |
| 共通 | `src/utils/naming.ts:152-162` | 入力解決と status ディレクトリ解決が非対称 |

**対応**: 決定論ルール（R7）。ULID は任意パスから追跡可能（`extractUlidFromFilename()` `src/utils/naming.ts:136-147`、
stale unlink は `src/sync/pull.ts:801-804` で case-insensitive FS 対策済）。

---

### EMIT-006 (S2) future-schema（user_version > 現行）で `emit status` が生スタックトレースでクラッシュ — **確認済**

**源码での裏取り**

| 事実 | 箇所 |
|---|---|
| future schema は `Error` を投げる（`ApiError` でない） | `src/db/cache.ts:195-199` `[CACHE_SCHEMA_MISMATCH]` |
| `emit status` の action は try/catch なし（同期 action） | `src/cli/commands/status.ts:82-85` |
| pull / pull-taxonomies / pull-media は `ApiError` だけ捕捉し他は `throw error` | `src/cli/commands/pull.ts:238-248, 293-299, 363-369` |

**対応**: AGENTS.md「CLI failure presentation」に従い **resolveContext / cache open を含む共通 pre-flight ガード**へ寄せる。
テストは `tests/cli.test.ts` の既存パターン（HOME / console.error / process.exit を stub して `program.parseAsync`）で追加可能。

---

### EMIT-009 (S2) quarantine copy が残っていても status の Flags に出ない — **部分実装済 → 要再現確認**

**源码での裏取り（CLI は既に報告する）**

| 事実 | 箇所 |
|---|---|
| `<collection>/conflicts/` を別カウント | `src/sync/status.ts:103-113`（`countQuarantinedCopies()`）→ `:211` `summary.conflicts` |
| CLI が Flags 行とは別行で警告 | `src/cli/commands/status.ts:178-192`（`🩹 N preserved local copy(ies) in posts/conflicts/`） |
| doctor も同一基準で WARN | `src/sync/doctor.ts:239-251`（`conflicts_quarantine`） |

**残存する欠落候補（再現後に確定）**

1. MCP `sync_status` の summary に `conflicts` が露出しているか（AI agent 側の入口）
2. 評価ログ T12 と status 出力が同一時点・同一バイナリであったか
3. `conflict_pending = 0` / `conflict_copy_path = null` かつ copy 残存、という状態自体が R3 の欠陥（EMIT-004）から生じていないか

→ 「新規追加」ではなく **再現 → 欠落層（MCP 側等）の補完**として扱う。

---

## S3 — 文書・インターフェース欠落

### EMIT-007 (S3) 文書化/ announced 機能のうち未実装項目 — **確認済（1 件はロジック実装済）**

| 項目 | 照合結果 | 箇所 |
|---|---|---|
| `emit doctor --strict-media` | **doctor ロジックは実装済み、CLI オプション未接続** → 作業量は `.option('--strict-media')` 追加＋MCP への引数透過のみ | `src/sync/doctor.ts:62`（`strictMedia?`）, `:419-424`（"--strict-media mode" メッセージ） |
| MCP `sync_conflicts` の prune | action enum は `list`/`diff`/`resolve` のみ → `prune` 追加が必要 | `src/mcp/tools/sync-conflicts.ts:37-39` |
| `emit conflicts list --all` | 未実装（既定で conflict/deleted 両型を一覧するため実害小）→ **対応不要**と判定 | `src/cli/commands/conflicts.ts:68` |
| pull 時の media 台帳（`media_state` 0 行） | 未着手。pull 側 media 冪等性の台帳化は別 Issue 扱い（Step 3 の任意項目） | — |
| MCP heartbeat の origin 識別 | `{pid, version, startedAt}` のみ → profile/origin を追加 | `src/mcp/heartbeat.ts` |
| 旧 MCP プロセスの追跡 WARN | 最新 1 プロセスのみ追跡、0.1.11 起動名が生存しても WARN なし | `src/mcp/heartbeat.ts` |
| heal 差分の開示 | 「Repaired frontmatter syntax」の変更内容・skip 理由が CLI/DB に残らない | `src/cli/commands/pull.ts:215-221`, `lenientRepairMarkdownFrontmatter` |

---

## 変更なし（Non-goals / 却下）

| 項目 | 判定 |
|---|---|
| マージ算法の書き直し | **不要**。評価 P7 が算法の正しさを実証済み（`src/sync/merge.ts:94-175`）。R1 は検知追加のみ |
| `TAXONOMY_UNION_REJECTED` の第三者検証 | 公開契約上構成不能（`test-matrix-taxonomy.md` E1: OpenAPI に排他フィールド無し、taxonomy 作成 POST 無し）。単体テストでのみ担保 |
| `emit conflicts list --all` | 実害なし。対応不要 |
| ガード意味・CLI フラグ名の変更 | `DESTRUCTIVE_TAXONOMY_WIPE` / `TAXONOMY_CONFLICT_PENDING` / `DELETE_PENDING_ARTICLE` と `--allow-wipe-taxonomies` / `--resolve-taxonomy` / `--revive` の契約は AGENTS.md §9 のまま維持 |

