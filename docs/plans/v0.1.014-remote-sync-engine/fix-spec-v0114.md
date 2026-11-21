# 修正仕様書（v0.1.14 / Rev.2 差分形）— Taxonomy 戦略保証 / デッドロック解消 / キャッシュ整合性

本仕様書は、実機黒箱テストで特定された課題 P1〜P6 に対する設計仕様・不変条件・受入条件を定義する。

**Rev.2 は第三者レビュー（Rev.1 評価）の指摘 1〜6 を反映した差分版**である。
「どの文が Rev.1 から変わったか」は末尾の **付録 A: Rev.1 → Rev.2 差分一覧（D1〜D8）** に集約した。
Rev.1 の本文要点は **付録 B** に監査用として保持する（実装は Rev.2 に従う）。

- **Rev.1 からの設計変更（本改訂の本体）**
  1. `conflict_pending` の**種別分離**（本文競合 / taxonomy 競合）を schema v3 migration として導入 → R2 と R4 を単一の設計変更へ統合
  2. Taxonomy 解決戦略の**決定点一元化**（merge 層が唯一の決定点、post-merge ブロックは fallback のみ）
  3. `strategy: local|remote` の**破壊的意味論**と wipe guard との関係明文化
  4. 退避コピーの**種別体系を既存 3 種で確定**（新規 `.local-orphan.md` を撤回し `.local-dropped.md` に統一）
  5. ガード番号参照を実コード・README のガード表に照合して全面修正
  6. バックアップを `VACUUM INTO` へ置換し、名称を version から導出、空 backup を無条件掃引

- **判定基準（評価憲章と同一）**: CLI stdout/stderr・exit code / HTTP 状態 / `.emit/cache.db` の列値 / ファイルツリーの 4 種類。ソース非依存で合否判定できる contract のみを合否条件とする。

---

## 0. Rev.1 原因分析の訂正（先に確定する事実）

Rev.1 の `issues-v0114.md` の記述のうち、ソース照合で以下 3 点を訂正する。**課題の結論（P1〜P6 は実在）は変わらない**が、テストの期待値と修正対象箇所が変わる。

| # | Rev.1 の記述 | 実測（v0.1.13 ソース） | 影響 |
|---|---|---|---|
| C1 | 「3 戦略すべてで union が `{t1, t3}`」 | Base `{t1,t2}` / Local `{t1}` / Remote `{t1,t2,t3}` の union は **`{t1,t2,t3}`**（remote は `t2` を削除していない）。`merge.ts:196-201` の集合代数は正しい | 結論（local の削除意図が失われる）は有効。T1-1 の期待値を `{t1,t2,t3}` 基準へ修正 |
| C2 | 「マーカーが残っていれば Guard **G8**（`UNRESOLVED_CONFLICT_MARKERS`）で停止する」 | `UNRESOLVED_CONFLICT_MARKERS` は **preflight G6**（`src/sync/preflight.ts:522-529`）。**G8 は `UNSUPPORTED_SYNTAX_WARNING`**。かつ評価順序は `push.ts:654`（pending guard）→ `push.ts:679`（preflight G1–G11）なので、マーカー残存時は **先に `TAXONOMY_CONFLICT_PENDING` で停止し G6 に到達しない** | Rev.1 が描いた「循環」は現状一部発生しない。真因は §R2 の通りフラグ共有 |
| C3 | 「`TAXONOMY_APPLY_PENDING` の案内文が `--resolve-taxonomy` を誘導している」（修正として提示） | `push.ts:670-677` の suggestion は既に `emit pull-taxonomies` / `--allow-unapplied-taxonomies` を案内し、`--resolve-taxonomy` に言及しない | R2(3) は**新規修正ではなく現行挙動の regression lock**。実測された循環の本体は doctor 側（`src/sync/doctor.ts:295` が本文競合由来 pending にも `--resolve-taxonomy=union|local|remote` を勧める）→ R2 の修正対象に doctor を追加 |

**ガード番号の正式対応（本書の一貫した表記）**

| 記号 | code | 実装位置 |
|---|---|---|
| **G6** | `UNRESOLVED_CONFLICT_MARKERS` | `src/sync/preflight.ts:522` |
| **G12** | `QUARANTINED_COPY_NOT_PUSHABLE` | `src/sync/push.ts:549-562` |
| **G13** | `CANONICAL_HAS_UNPUSHED_EDITS` | `src/sync/conflicts.ts:422-439` |
| **G14** | `QUARANTINED_PATH_REQUIRED` | `src/sync/conflicts.ts`（resolve/diff 入口） |
| **G15** | `TAXONOMY_CONFLICT_PENDING` | `src/sync/push.ts:654-662` |
| **G16** | `DELETE_PENDING_ARTICLE` | `src/sync/push.ts:643-651` |
| **G17** | `TAXONOMY_APPLY_PENDING` | `src/sync/push.ts:665-677` |

---
## R1: Taxonomy 解決戦略（`--resolve-taxonomy union|local|remote`）の履行保証と決定点の一元化（P1 対応）

### 1. Invariant（不変条件）

> **(I1-a) 履行**: ユーザーが `--resolve-taxonomy <strategy>` を明示した場合、**両者に差分が存在する taxonomy は merge 層で決定論的に解決され**、指定戦略以外の結果が生じてはならない。
> **(I1-b) 決定点一元化**: 戦略の決定点は `mergeTaxonomies()` **ただ 1 箇所**である。呼び出し元（`push.ts`）が merge 結果を事後上書きする路径を持ってはならない。
> **(I1-c) 意味論（破壊的であることの明示）**: `local` は Git の `ours`、`remote` は Git の `theirs` と同じ単側採用であり、**他側の追加・削除を区別なく破棄する**。これは v0.1.13 まで存在しなかった挙動の解禁であり、warning で必ず可視化しなければならない。
> **(I1-d) 既定値の不変**: strategy 未指定時は v0.1.13 の集合代数 3-way union および `union == local` 時の clean 判定（`merge.ts:203-210`）を**バイト単位で同一**に維持する。

### 2. 戦略の定義（用語の確定）

`base / local / remote` の各集合に対し、差分のある taxonomy name について:

| strategy | 採用結果 | 他側の変更 | 記録 |
|---|---|---|---|
| `union`（既定） | `(base \ (localRemoved ∪ remoteRemoved)) ∪ localAdded ∪ remoteAdded` | 統合 | `autoMergedTaxonomies{remoteAdded, remoteRemoved}` |
| `local` | `local` をそのまま採用 | **追加も削除も区別なく破棄** | `strategyAdopted{name, side:'local', discardedRemoteAdded, discardedRemoteRemoved}` |
| `remote` | `remote` をそのまま採用 | **追加も削除も区別なく破棄** | `strategyAdopted{name, side:'remote', discardedLocalAdded, discardedLocalRemoved}` |

- 差分のない taxonomy（`eq(l,r)` / 単側変更）は戦略の対象外（既存の clean 路径を維持）。
- **wipe guard との関係**: strategy 指定時は union 由来の destructive wipe 検知（`merge.ts:212-219`）に依存しない。local 採用で local が空集合になる場合、または remote 採用で remote が空集合になる場合は、**戦略が明示されたことをもって確認済みとみなす**。ただし `--force` 由来の暗黙 union はこの免除を与えない（G15 の `--force` 経路は union を選び、`DESTRUCTIVE_TAXONOMY_WIPE`（`push.ts:1154-1167`）は従来通り発火させる）。

### 3. 詳細仕様

#### (1) `src/sync/merge.ts`

```typescript
export interface TaxonomyMergeOptions {
  strictRenameConflict?: boolean;
  /** Single decision point for diverged taxonomies. Absent = v0.1.13 union algebra. */
  strategy?: 'union' | 'local' | 'remote';
}

export interface TaxonomyStrategyAdoption {
  name: string;
  side: 'local' | 'remote';
  discardedAdded: string[];
  discardedRemoved: string[];
}
```

`mergeTaxonomies()` の両側変更分岐（`merge.ts:194-235`）を次の順序に改修する。

```typescript
if (localChanged && remoteChanged) {
  // (a) 戦略指定は union 評価より前に、全 case で優先される
  if (options?.strategy === 'local') { merged[name] = lRaw; adoptions.push({ ... }); continue; }
  if (options?.strategy === 'remote') { merged[name] = rRaw; adoptions.push({ ... }); continue; }
  // (b) 未指定: v0.1.13 の union（3a isUnionEqualLocal / 3b wipe guard / 3c strictRenameConflict を現状のまま維持）
}
```

- **Case 2（remote 削除 vs local 変更、`merge.ts:127-143`）にも戦略を適用する**。現状は `conflicts.push(name)` のみ。strategy=local → local 採用、strategy=remote → 「remote は該当 name を削除」を採用（`= []` または key 除去）、strategy=union → 既存の conflict 扱いを維持。**ここが未対応だと結果が路径依存になる**（T1-4）。
- Case 3（local 側が name を省略、`merge.ts:145-149`）と base 欠落（`merge.ts:162-167`）は戦略の適用対象としない（base 欠落は Rev.1 通り conflict のまま）。
- `TaxonomyMergeResult` / `MergeResult` に `strategyAdoptions?: TaxonomyStrategyAdoption[]` を追加。

#### (2) `src/sync/push.ts`

- `hybrid3WayMerge(parsed, baseInfo, remoteInfo, { strategy: options.resolveTaxonomy })` と**第 4 引数を必ず渡す**（現状 `push.ts:1146` は未渡。`strictRenameConflict` も使わないなら削除して未使用オプションを残さない）。
- **post-merge 解決ブロック（`push.ts:1179-1208`）は「strategy 未指定で `taxonomyConflicts` が発生した場合」のみ発動する fallback に縮小**する。strategy 指定時にここが残ると二重解決になる（I1-b 違反）。
- `strategyAdoptions` を warnings に展開し、破棄した term を列挙する:
  `🏷️ Resolved 'categories' with strategy 'local': discarded remote +qa-c3, -qa-c2.`
- `TAXONOMY_UNION_REJECTED`（`push.ts:1305-1317`）の発火条件を `autoMergedTaxonomies.length > 0 || strategyAdoptions.length > 0` に拡張する。strategy=local 採用でサーバが単一カテゴリ制約等を拒否した場合に、**union 誘導ではなく「他側変更が破棄済みのため拒否された」旨と残る選択肢（remote / frontmatter 手動編集）を案内**する。

#### (3) 受け入れ条件

- **A1-1**: `--resolve-taxonomy local` → remote の追加 term が 1 つも混入しない（C1 の訂正後期待値で検証）。
- **A1-2**: `--resolve-taxonomy remote` → local の削除意図が反映され、remote 状態がそのまま採用される。
- **A1-3**: strategy 未指定時の出力が v0.1.13 とバイト単位で同一（baseline hash 互換 = `tests/migration_hash_invariants.test.ts` の契約を維持）。
- **A1-4**: Case 2（remote 削除 vs local 変更）で 3 戦略がすべて merge 層で一貫解決され、post-merge ブロックに依存しない。
- **A1-5**: strategy 採用後にサーバが拒否した場合、`strategyAdoptions` が空でも専用案内が発火する。

---
## R2: pending 種別の分離と誘導文の適正化（P2 対応・R4 と統合）

### 1. Invariant（不変条件）

> **(I2-a) 混同禁止**: 「本文（Markdown body）の競合」と「taxonomy 割当の競合」は**別フラグ**として保持され、互いの解消手順を要求してはならない。
> **(I2-b) 案内の対応関係**: 本文競合 pending → マーカー解消または `emit conflicts` 経路のみを案内し、taxonomy フラグを要求しない。taxonomy 競合 pending → `--resolve-taxonomy` のみを案内する。`taxonomy_apply_pending`（G17）は本文/taxonomy 競合と独立であり、`--resolve-taxonomy` を一切案内しない。
> **(I2-c) 種別分離の完全性**: どちらかの pending だけ解決したとき、**他方の pending とその退避メタデータが残存**しなければならない（Rev.1 の CASE WHEN 案はこの残存を壊す。§R4 参照）。

### 2. 実測された混同の真因

`sync_state.conflict_pending` は **taxonomy 専用ではなく汎用フラグ**であり、本文競合（`push.ts:1210-1255` の body marker 路径）でも taxonomy-only 競合（`isTaxonomyOnlyConflict`、`push.ts:1211-1213, 1222`）でも同じ 1 が立つ。G15（`push.ts:654`）はこの 1 を無条件に見るため、本文競合の解消後も taxonomy オプションを要求する。**Rev.1 の「マーカーの有無で分岐させる」案は採用しない** — taxonomy-only conflict では canonical にマーカーが書かれない（`push.ts:1222`）ため、その分岐は本来塞ぐべき taxonomy pending を素通しする。

### 3. 詳細仕様

#### (1) schema v3 migration（`src/db/cache.ts`）

```sql
-- CURRENT_CACHE_SCHEMA_VERSION = 3
ALTER TABLE sync_state ADD COLUMN body_conflict_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_state ADD COLUMN taxonomy_conflict_pending INTEGER NOT NULL DEFAULT 0;
```

- `conflict_pending`（v1〜v2 の列）は**残し、派生値として保持**する: `conflict_pending = max(body_conflict_pending, taxonomy_conflict_pending)`。既存の読み取り側（`status.ts:157`, `doctor.ts:260`, G13/G15 判定）を段階移行するため、新列のみへの置換は行わない。
- migration 時の既存行の振り分け規則（決定論的・1 回限り）:
  1. `conflict_copy_path` が `.conflict.md` を指し、canonical に `CONFLICT_MARKER_REGEX`（`preflight.ts:100`）相当のマーカーがある → `body_conflict_pending = 1`
  2. `remote_taxonomy_hash` が設定済みで canonical にマーカーが無い → `taxonomy_conflict_pending = 1`
  3. 判別不能 → 両方 1（安全側。解決後に doctor の整合検査で整理）

#### (2) ガードの再配線（`src/sync/push.ts`）

| 条件 | 発動 code | 案内文 |
|---|---|---|
| `body_conflict_pending = 1` かつ canonical にマーカー残存 | **G6** `UNRESOLVED_CONFLICT_MARKERS`（pending guard より前に評価） | 「マーカーを解消して再 push」または「`emit conflicts diff/resolve` で退避コピーと照合」 |
| `body_conflict_pending = 1` かつマーカー無し（手動解消済み） | **発動しない**（bare push を通し、解決扱いで pending を clear） | — |
| `taxonomy_conflict_pending = 1` かつ strategy/force 未指定 | **G15** `TAXONOMY_CONFLICT_PENDING` | `--resolve-taxonomy=union\|local\|remote`（or `--force`）のみ |
| `taxonomy_apply_pending = 1` | **G17**（現状維持） | `emit pull-taxonomies` → re-push、または `--allow-unapplied-taxonomies`（`--resolve-taxonomy` に言及しない） |

- **評価順序の固定**: ① G6（マーカー）→ ② G15（taxonomy pending）→ ③ G17（apply pending）→ ④ preflight G1–G11。Rev.1 の「マーカー検査の先行」は、pending guard を**種別ごとに分割した上で**成立させる（単に前倒ししても I2-a は満たされない）。
- `--force` は Rev.1 通り全 pending を bypass できるが、**どの pending をどう解決したかを warnings に必ず記録**する（暗黙解決の不可視化防止）。

#### (3) doctor の案内文修正（`src/sync/doctor.ts:290-298`）

現状 `manualResolutionRequired` は本文競合由来にも `--resolve-taxonomy=union|local|remote` を勧めている。種別ごとに分割する:

- 本文競合 → 「Resolve body markers, or run `emit conflicts diff <file>` then `emit conflicts resolve`」
- taxonomy 競合 → 「Run `emit push <file> --resolve-taxonomy=union|local|remote`」
- 判別不能（両方 1）→ 両手順を列挙し、解決後に `emit doctor` 再実行を指示

#### (4) 受け入れ条件

- **A2-1**: 本文競合マーカー残存時の初回 push が `UNRESOLVED_CONFLICT_MARKERS` で停止し、`--resolve-taxonomy` を要求しない。
- **A2-2**: マーカーを手動解消した再 push が strategy/force なしで成功し、`body_conflict_pending` が 0 になる（`taxonomy_conflict_pending` は 1 のまま残る）。
- **A2-3**: taxonomy-only conflict 直後の bare push が G15 で停止する（マーカー検査による素通しが起きない）。
- **A2-4**: `taxonomy_apply_pending = 1` の案内文に `--resolve-taxonomy` が現れない（Rev.1 T2-3 を regression lock として維持）。

---
## R3: リモート削除＋ローカル編集状態の脱出経路（P3 対応）

### 1. Invariant（不変条件）

> **(I3-a)** remote で削除された記事に未 push のローカル編集がある場合、**SQLite やファイルを手操作せずに**通常コマンドだけで追跡解除できる。
> **(I3-b)** どの脱出経路でもローカル編集内容は退避コピーとして残存し、失われてはならない（データ消失ゼロ保証）。
> **(I3-c)** 404/410 は generic `PUSH_FAILED` に吸収されず、**リモート削除を示す専用 code と脱出手順**として提示される。

### 2. 詳細仕様

#### (1) 404 検知の全経路化（`src/sync/push.ts`）— Rev.1 の局所解を拡張

実測の詰まりは PUT 応答そのものより **conflict 解決中の remote GET** で起きる。3 経路すべてで `REMOTE_ARTICLE_DELETED` を発火させる:

| 経路 | 現状の code | 改修後 |
|---|---|---|
| 初回 PUT の応答（`push.ts:1057-1064` → `:1331-1340`） | `PUSH_FAILED` | `REMOTE_ARTICLE_DELETED` (404) |
| 合成 409（taxonomy divergence, `push.ts:1050-1056`）→ conflict 解決の remote GET（`push.ts:1085-1102`） | `CONFLICT_REMOTE_FETCH_FAILED` | `REMOTE_ARTICLE_DELETED` (404) |
| auto-merge 後の再 PUT（`push.ts:1293-1328`） | `PUSH_RETRY_FAILED` | 上位分岐で 404 を先に処理 |

**案内文（3 経路共通、順序付き）**

```text
💡 Suggestion:
  1. Keep your edits and re-create as a new article: remove the `id:` field from frontmatter, then "emit push <file>".
  2. Discard local edits and untrack: "emit pull <id> --force"   (local copy is preserved under posts/conflicts/)
  3. Delete with rescue backup: "emit delete <file> --discard-local-edits"
```

#### (2) `src/sync/pull.ts` の強制クリーンアップ（`pullArticle`、現状 `:706-745`）

`options.force` が 404/410 分岐で参照されていない実バグを修正する。

```typescript
if (res.status === 404 || res.status === 410) {
  if (existingSync && fs.existsSync(fullPath)) {
    if (diskHash === existingSync.localHash) { /* 現行通り unlink + deleteEntry */ }
    else if (options.force) {
      const quarantineRel = quarantineLocalCopy(
        options.workspaceRoot, collection, existingSync.localFilePath, diskContent,
        { isForce: true },                                   // → .local-dropped.md
      );
      fs.unlinkSync(fullPath);
      options.cache.deleteEntry(id);
      return { id, ..., deleted: true, quarantined: true, quarantineFilePath: quarantineRel };
    } else {
      return { ...orphan: true, localEditsPreserved: true,
               suggestion: 'Pass --force to preserve your edits under posts/conflicts/ and remove tracking.' };
    }
  }
}
```

- **退避コピーの種別（Rev.1 からの設計変更）**: 新規 `.local-orphan.md` は**導入しない**。既存 `quarantineLocalCopy(..., { isForce: true })` が書く **`.local-dropped.md`**（`pull.ts:221`）を使用する。退避体系は既に `ConflictFileType = 'conflict' | 'dropped' | 'deleted' | 'unknown'`（`src/sync/conflicts.ts:30`）で 3 種を定義済みであり、`listConflicts`（`:177-183`）・diff（`:302-308`）・prune・doctor・AGENTS.md の契約がその 3 種前提だからである。第 4 種別を増やすと同数の改修と新規 guard が必要になり得る利得がない。
- 既存の orphan 保護（force なし）は Rev.1 通り維持し、**案内文のみ追加**する。

#### (3) `src/sync/delete.ts` の安全バイパス — force の意味論を確定

現状 `deleteArticle` に force は存在せず、`UnpushedModificationsError`（`:165-167`）は「まず push せよ」と案内する。Rev.1 の `--force` は**編集破棄の意図と他の guard（published 保護等）の意味を混同するため**、専用フラグとする:

- **新規 `--discard-local-edits`（MCP `discardLocalEdits: true`）** を追加:
  1. `UnpushedModificationsError` の検査のみ通過させる（published 保護は従来通り `--allow-delete-published` で個別確認）
  2. remote DELETE を試行（404/410 は idempotent success、現状 `:278-281` を維持）
  3. 退避コピー `<name>.deleted.md` に**編集済み内容**を書き（現状 `:303-309` の順序を維持）、canonical unlink、`deleteEntry(id)`
  4. 完了メッセージに退避先と「remote は既に削除済みだった」旨を明記
- CLI ヘルプ・README の delete 節に「編集を保持したい場合は先に push」の対比として記載する。

#### (4) 既存経路での脱出可能性の切り分け（実装前の必須確認）

新規経路を増やす前に、**既存機構で足りるケースをテストで確定**する:
- `emit conflicts resolve --accept-canonical` は canonical を保ったまま退避コピーだけ除去するが、**cache を一切更新しない**（`conflicts.ts:379-388`）→ pending が残り bare push 不能。R4 でクリアされれば脱出経路として機能しうる。
- 足りる／足りないを T3-6 で観測し、足りない場合のみ (2)(3) の新規経路を有効化する（過剰実装の防止）。

#### (5) 受け入れ条件

- **A3-1**: 上記 3 経路すべてで `REMOTE_ARTICLE_DELETED` と案内 3 案が出力される。
- **A3-2**: `emit pull <id> --force` が `.local-dropped.md` を書き、canonical と DB レコードを削除（`deleted: true, quarantined: true`）。
- **A3-3**: `emit delete <file> --discard-local-edits` が remote 404 でも退避 → local/DB 削除まで完了する。
- **A3-4**: 脱出後に `emit status` / `emit doctor` が当該記事を orphan・pending として報告しない。

---
## R4: pending 解消時の退避メタデータ整合（P4 対応・R2 の schema v3 と一体）

### 1. Invariant（不変条件）

> **(I4-a)** 種別 p の pending が 0 になったとき、**その種別の退避メタデータは必ず NULL にクリア**される（ゴースト警告と prune スキップの根絶）。
> **(I4-b)** 未解決の他種別があるとき、その退避メタデータは**保持**されなければならない（Rev.1 の `conflict_pending = 0 → 全 conflict 列 NULL` はこの残存を壊すため採用しない）。
> **(I4-c)** `conflict_at` / `conflict_copy_hash` / `conflict_copy_path` は**必ず同一種別・同一時刻のセット**として整合する（AGENTS.md の原則。現状テスト化されていない）。

### 2. 実測挙動（Rev.1 の原因特定は正しい）

- `saveSyncState` の UPSERT（`cache.ts:463-465`）は「excluded が NULL なら旧値保持」であり **NULL を書き込めない**。
- push 成功時は `conflictPending: 0`（`push.ts:1448-1451`）だが path は COALESCE で残存 → status/doctor が警告継続、prune は「unpushed modifications」判定でスキップ。
- **Rev.1 が見落とした第 2 の閉塞**: `emit conflicts resolve --accept-canonical`（`conflicts.ts:379-388`）は退避コピーを unlink するだけで cache を更新しない → pending=1 が残り bare push 不能。
- **Rev.1 が見落とした第 3 の不整合**: `resolveConflict` の accept-local は `saveSyncState` を conflict 列なしで呼ぶ（`conflicts.ts:462-470`）→ Rev.1 の SQL 案では pending=1 が**暗黙にクリア**される（v0.1.13 spec が課した「解除は conflicts resolve 経路でのみ」という原則がここだけ未実装）。

### 3. 詳細仕様（`src/db/cache.ts`）

#### (1) UPSERT を種別単位にする

```sql
ON CONFLICT(id) DO UPDATE SET
  /* local_file_path / local_hash / remote_rev / status / slug / last_synced_at は excluded のまま */
  delete_pending             = excluded.delete_pending,
  body_conflict_pending      = excluded.body_conflict_pending,
  taxonomy_conflict_pending  = excluded.taxonomy_conflict_pending,
  conflict_pending           = MAX(excluded.body_conflict_pending, excluded.taxonomy_conflict_pending),
  conflict_copy_hash = CASE WHEN excluded.conflict_copy_path IS NOT NULL THEN excluded.conflict_copy_hash
                            WHEN COALESCE(excluded.body_conflict_pending,0) + COALESCE(excluded.taxonomy_conflict_pending,0) = 0 THEN NULL
                            ELSE sync_state.conflict_copy_hash END,
  conflict_copy_path = CASE WHEN excluded.conflict_copy_path IS NOT NULL THEN excluded.conflict_copy_path
                            WHEN COALESCE(excluded.body_conflict_pending,0) + COALESCE(excluded.taxonomy_conflict_pending,0) = 0 THEN NULL
                            ELSE sync_state.conflict_copy_path END,
  conflict_at        = CASE WHEN excluded.conflict_copy_path IS NOT NULL THEN excluded.conflict_at
                            WHEN COALESCE(excluded.body_conflict_pending,0) + COALESCE(excluded.taxonomy_conflict_pending,0) = 0 THEN NULL
                            ELSE sync_state.conflict_at END,
  remote_taxonomy_hash   = CASE WHEN excluded.remote_taxonomy_hash IS NOT NULL THEN excluded.remote_taxonomy_hash
                                ELSE sync_state.remote_taxonomy_hash END,
  taxonomy_apply_pending = excluded.taxonomy_apply_pending
```

- **規則**: 「退避コピーが明示された（`conflict_copy_path` あり）なら必ずセットで上書き」「**全 pending が 0 のときのみ**退避列を NULL」「いずれか pending が残る限り保持」。これにより I4-a と I4-b を同時に満たす。
- `remote_taxonomy_hash` の COALESCE は Rev.1 通り維持（baseline taxonomy hash の静かな消失防止、v0.1.13 spec §baseline と整合）。

#### (2) setter の整備

- `setConflictPending(id, pending, copyHash?, copyPath?)` を **`setConflictPending(id, kind: 'body' | 'taxonomy', pending, copyHash?, copyPath?)`** に拡張（既存呼び出しは移行期間 kind 既定値で受け、R2 完了後に既定値を削除）。
- 追加 `clearConflictsByKind(id, kind)`: 該当 kind の pending を 0 にし、**両 kind が 0 になったときのみ**退避列と `conflict_pending` を NULL。

#### (3) 呼び出し側の整合（`src/sync/conflicts.ts`）

- **accept-canonical**: unlink 後に `clearConflictsByKind(id, detectedKind)` を必ず呼ぶ（detectedKind は退避コピーの suffix から決定: `.conflict.md` → body、`.local-dropped.md` → body、taxonomy-only の記録がある場合 → taxonomy）。cache 更新なしの現状を塞ぐ。
- **accept-local**: `saveSyncState` に conflict 列を**明示的に渡す**（解決済みなら pending 0 + NULL、未解決保持なら現値を再送）。暗黙クリアを禁止する。

#### (4) 受け入れ条件

- **A4-1**: 競合解消 push 後 `SELECT conflict_pending, body_conflict_pending, taxonomy_conflict_pending, conflict_copy_path FROM sync_state WHERE id = ?` が `0|0|0|NULL`。
- **A4-2**: 本文競合だけ解決した直後、`taxonomy_conflict_pending = 1` とその退避 path が**残存**する（Rev.1 案の副作用防止）。
- **A4-3**: `emit conflicts resolve --accept-canonical` 後に bare push が成功する。
- **A4-4**: accept-local 経路で pending のクリア/保持が意図通り（暗黙クリアが起きない）。
- **A4-5**: 退避列 3 値のセット整合を `tests/cache.test.ts` で検査（現状この invariant のテストが存在しない）。

---

## R5: 診断エンジン（Doctor）の網羅性強化とキャッシュ運用の明示（P5 対応）

### 1. Invariant（不変条件）

> **(I5-a)** `emit doctor` は DB 内の**すべての pending 状態**（`body_conflict_pending`, `taxonomy_conflict_pending`, `delete_pending`, `taxonomy_apply_pending`）を漏れなく検出し、種別別の復旧手順を案内する。
> **(I5-b)** 「退避コピーが存在しないのに pending=1」は自動解消し、ユーザーが手動削除した後に bare push 不能な状態へ固定されない。

### 2. 詳細仕様（`src/sync/doctor.ts`）

- `runWorkspaceDoctor()` の §4b（`:258-298`）を種別別に拡張。現状 `taxonomy_apply_pending` の検査が存在しない（欠落は実測済み。`status.ts:159,220` は既に検査している）:
  - `status: 'warning'`, message: `Article ${id} (${local_file_path}) has unapplied taxonomy terms from a previous failed sync.`
  - suggestion: `Run "emit pull-taxonomies", verify the terms exist on remote (missing terms or permission errors must be fixed there first), then "emit push ${local_file_path}".`（AGENTS.md §11 の「verify term permissions」相当を必ず含める。pull-taxonomies で済まないケースを案内しないと復旧不能なままになる）
- **`delete_pending` を検査対象に追加**（現状 doctor は未検査、status flags のみに存在）:
  - suggestion: `Confirm the remote deletion, then "emit delete <file>" to finish local cleanup, or "emit push <file> --revive" to intentionally revive.`
- **auto-clear 条件の再定義**（Rev.1 が触れなかった閉塞）: 現状は退避コピーが残る限り pending を auto-clear しない（`:272` の条件）。ユーザーが退避コピーを手動削除すると G15 で永久に push 不能になる。→ 「該当 kind の退避コピーが存在せず、canonical に divergence（マーカー / hash 不一致）もない」なら **kind 単位で auto-clear**（`clearConflictsByKind` を使用）。
- `emit status` のオフラインファースト設計の明文化（README.md / AGENTS.md）: status はキャッシュ基準のローカル高速判定であり、remote との照会は `emit pull` / `emit push` の taxonomy audit で行う旨を追記（Rev.1 通り）。

### 3. 受け入れ条件

- **A5-1**: `taxonomy_apply_pending = 1` で warning と復旧手順（remote 側確認を含む）が出力される。
- **A5-2**: `delete_pending = 1` で warning が出力される。
- **A5-3**: 退避コピーを手動削除した taxonomy pending が doctor 実行で auto-clear され、続けて bare push が成功する。

---
## R6: DB バックアップ機構の置換と空バックアップ抑止（P6 対応）

### 1. Invariant（不変条件）

> **(I6-a)** マイグレーションは**復旧に使える backup を必ず 1 世代以上保持**する（抑止のみで復旧能力を落とさないこと）。
> **(I6-b)** 0 バイト・無効な `.bak-*` を生成せず、既存の無効なものも掃引する。
> **(I6-c)** backup 名は version から導出し、**手で更新する必要を持たない**。

### 2. Rev.1 案の評価と差し替え

Rev.1 の `stats.size > 0` チェックは原因特定（`cache.ts:214-218` にサイズ検査が無い）が正しいものの対症療法である:

1. 初回 workspace では必ず migration が走るため、空 backup を生む条件自体が消えない
2. `copyFileSync` は WAL の中間状態を写しうる（現状 `wal_checkpoint(TRUNCATE)` に依存、`:206-211`）
3. prune が「新規 backup を作ったときだけ」走るため既存の 0 バイト `.bak-*` が残る（`:220-237`）
4. 名称が `bak-0.1.12` にハードコード（`:217`）され、次版でもズレる

**採用案: SQLite ネイティブ `VACUUM INTO` への置換**（node:sqlite で検証済み。Node v26.11.1 で `prepare('VACUUM INTO ?').run(path)` が WAL DB から完全な単一ファイルを出力することを実測。なお `PRAGMA user_version = ?` はバインド不可（syntax error）のため、version 書き込みは現状通り `exec()` のリテラル形式を維持する）

```typescript
if (this.dbPath !== ':memory:') {
  const version = getPackageVersion();               // package.json version（取得不能時 CURRENT_CACHE_SCHEMA_VERSION にフォールバック）
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bakPath = `${this.dbPath}.bak-${version}-${timestamp}`;
  this.db.prepare('VACUUM INTO ?').run(bakPath);      // 0 バイト DB からも有効な SQLite へ正規化される
}
// 生成有無に関わらず必ず掃引を走らせる（Rev.1 の条件付き prune を無条件化）
pruneCacheBackups(this.dbPath, { maxKeep: 3 });       // size === 0 を常に削除 → その上で newest 3 を保持
```

- `PRAGMA wal_checkpoint(TRUNCATE)` は不要になる（`VACUUM INTO` が整合した単一ファイルを書く）。ただし**既存 backup との互換性のため撤去は本リリースで同時に行う**（片方だけ残すと WAL 中間コピーが残り続ける）。
- **名称の導出**: ハードコードを廃止し package.json version から導出する。次版で手動更新を不要にする。
- 旧形式 `.bak-0.1.11-*` / `.bak-0.1.12-*` も prune の対象パターンに含める（現行の `startsWith(`${dbBase}.bak-`)` は既に網羅しているため維持）。

### 3. 受け入れ条件

- **A6-1**: 新規 workspace（0 バイト DB + migration）で生成された `.bak-*` が、**有効な SQLite として開け `sync_state` テーブルを持つ**。
- **A6-2**: 実データ入り DB の migration で backup が生成され、migration 後の DB と矛盾しない（テーブル・行数が一致）。
- **A6-3**: 0 バイトの `.bak-*` は掃引され disk に残らない。保持世代は最大 3。
- **A6-4**: backup 名が package.json の version を含む（`tests/cache.test.ts:254` の既存検査を name 導出込みで拡張）。

---

## Non-goals（明示的な変更対象外）

- `mergeTaxonomies()` の**集合代数そのものは書き換えない**（union 式 `merge.ts:196-201`、`isUnionEqualLocal` `:203-210` は現行維持。R1 は「戦略をそこに到達させる」検知と決定点の移動のみ）。
- `taxonomy_apply_pending` の baseline 巻き戻し設計（v0.1.13 R2 / EMIT-002）は変更しない。R5 は doctor 側の可視化のみ。
- MCP ツール schema への追加（`resolveTaxonomy`, `discardLocalEdits`）は既存 tool の optional 追加に留め、必須パラメータ化は行わない。
- `posts/conflicts/` への**新規ファイル種の追加は行わない**（R3(2) で `.local-dropped.md` に統一）。
- `emit pull` の prune / fast-path 算法、`resolveCanonicalArticlePath` の title 解決順序（`docs/v0114-backlog.md` §1）は本仕様のスコープ外。

---
## 付録 A: Rev.1 → Rev.2 差分一覧

| # | Rev.1 の記述 | Rev.2 の変更 | 理由 |
|---|---|---|---|
| **D1** | R2(2)「マーカーの有無で `TAXONOMY_CONFLICT_PENDING` 発動を分岐」/ R4「`conflict_pending = 0` なら全 conflict 列 NULL」 | **schema v3 で `body_conflict_pending` / `taxonomy_conflict_pending` に分離**し、R2 と R4 を単一の設計変更として記述。UPSERT は種別単位（全 pending が 0 のときのみ退避列 NULL） | 真因は「1 系統フラグの共有」。Rev.1 案は (a) taxonomy-only conflict で canonical にマーカーが書かれないため taxonomy pending を素通し、(b) 本文競合解決で taxonomy 退避情報を消す、という 2 つの副作用を持つ |
| **D2** | R1「`hybrid3WayMerge` に `options.resolveTaxonomy` を渡す」＋ post-merge 解決ブロック（`push.ts:1179-1208`）は現状維持 | **決定点を merge 層に一元化**。post-merge ブロックは strategy 未指定時の fallback に縮小。Case 2（remote 削除 vs local 変更）にも戦略を適用。`strategyAdoptions` を新設し `TAXONOMY_UNION_REJECTED` の発火条件を拡張 | Rev.1 では merge 層解決と post-merge 上書きが併存し二重解決。Case 2 未対応で路径依存。strategy=local でサーバ拒否時の案内経路（`autoMergedTaxonomies` 要求）が消える |
| **D3** | R1 invariant「local: ローカルの変更が完全に優先、リモートの追加・変更は破棄」 | **Git の ours/theirs と同じ単側採用**と明記し、無変更 term も落ちうる破壊性を invariant に格上げ。union 由来 wipe guard への免除関係を明文化（`--force` 由来の暗黙 union は免除しない） | v0.1.13 に無かった破壊的挙動の解禁であり、警告での可視化と確認条件を仕様上固定する必要があるため |
| **D4** | R3(2)「`posts/conflicts/<filename>.local-orphan.md` に退避」/ R3(3)「`emit delete --force`」 | **既存 `.local-dropped.md`（`quarantineLocalCopy(..., {isForce:true})`）へ統一**。delete の force は新規 `--discard-local-edits` として導入。加えて脱出の要否を切り分ける T3-6 を実装前確認として追加 | 退避体系は既に `'conflict' \| 'dropped' \| 'deleted' \| 'unknown'`（`conflicts.ts:30`）で 3 種定義済み。第 4 種別は list/diff/resolve/prune/doctor/AGENTS.md の同時改修と新規 guard を要求し利得が無い。delete の `--force` は published 保護等と意味が衝突する |
| **D5** | issues-v0114「Guard G8（`UNRESOLVED_CONFLICT_MARKERS`）」、R2(3)「案内文から `--resolve-taxonomy` を除去」 | §0 でガード番号を実コードに照合（G6 / G12 / G13 / G14 / G15 / G16 / G17）し全面修正。R2(3) は regression lock へ降格、**doctor の案内文（`doctor.ts:295`）を修正対象に追加**。404 検知は 3 経路すべてに拡張 | `UNRESOLVED_CONFLICT_MARKERS` は preflight G6（G8 は syntax warning）。評価順序上マーカー残存時は G15 が先で G6 に到達しない。apply pending の案内は現行 already 正しい。実測された循環の本体は doctor。詰まりの実経路は conflict 解決中の remote GET 404 |
| **D6** | R6「`stats.size > 0` で backup 生成をスキップ」＋「prune 処理内で既存 0 バイト削除」 | **`VACUUM INTO` へ置換**（WAL checkpoint 不要）、名称を package.json version から導出、**掃引を生成有無に関わらず無条件実行**し size 0 を常時削除 | Rev.1 案は対症療法で復旧能力の低下を検知できない。prune は新規 backup 生成時にしか走らない（`cache.ts:220-237`）ため既存空 backup が残る。名称の `0.1.12` ハードコードは次版でもズレる |
| **D7** | （Rev.1 に記載なし） | R4(3)「accept-canonical は cache を更新しない（`conflicts.ts:379-388`）」「accept-local は conflict 列なしで saveSyncState（`:462-470`）」を修正対象として追加。R5 に `delete_pending` 検査と auto-clear 条件再定義を追加 | Rev.1 が見落とした 2 つの閉塞（bare push 不能の固定、pending の暗黙クリア）と doctor の網羅性 invariant への欠落 |
| **D8** | issues-v0114「union は `{t1, t3}`」 | §0 C1 で `{t1,t2,t3}` に訂正（T1-1 の期待値基準を変更） | remote が `t2` を削除していないため集合代数の結果は `{t1,t2,t3}`。結論（local の削除意図喪失）は不変 |

### 差分の検証状態（Rev.2 起草時に実測済み）

| 主張 | 実測方法 | 結果 |
|---|---|---|
| `VACUUM INTO ?` は node:sqlite でバインド可能・WAL DB から完全な単一ファイルを出力 | Node v26.11.1 / `prepare('VACUUM INTO ?').run(path)` を WAL 有効 DB で実行 | 8192 byte の有効 DB が生成され、内容（テーブル・行）が一致 |
| `PRAGMA user_version = ?` はバインド不可（リテラル必須） | 同上で `prepare('PRAGMA user_version = ?').run(3)` | `near "?": syntax error` → R6 の「version 書き込みは exec() リテラル維持」の根拠 |
| R4 の UPSERT 規則（全 pending 0 のときのみ退避列 NULL、他種別は保持） | `sync_state` 相当テーブルで A2-2/A4-2・A4-1 の SQL を実行 | 本文解消直後 `conflict_copy_path` は残存（`posts/conflicts/x.conflict.md`）、全解消後に `NULL`／`conflict_pending = 0`。I4-a と I4-b が両立することを確認 |

---
## 付録 B: Rev.1 本文の保持（監査用）

以下は Rev.1 の R1〜R6 の原文要点であり、上の Rev.2 が置き換える。**参照用のみ**（実装は Rev.2 に従う）。Rev.1 全文の照合は git 履歴の `fix-spec-v0114.md`（Rev.1 commit）を参照すること。

### Rev.1 R1
- `TaxonomyMergeOptions` に `strategy?: 'union' | 'local' | 'remote'` を追加。両側変更時 `strategy === 'local'` → `merged[name] = lRaw`（`autoMergedTaxonomies.push({ name, remoteAdded: [], remoteRemoved: [] })`）、`strategy === 'remote'` → `merged[name] = rRaw`、既定 union。
- `src/sync/push.ts`: `hybrid3WayMerge` / `mergeFrontmatter` 呼び出しに `options.resolveTaxonomy` を伝達。

### Rev.1 R2
- マーカー検査（`UNRESOLVED_CONFLICT_MARKERS`）を pending guard より先行。マーカー無しで真の taxonomy 競合がある場合のみ `TAXONOMY_CONFLICT_PENDING`。本文競合解消後は `--resolve-taxonomy` を要求しない。
- `TAXONOMY_APPLY_PENDING` の suggestion を `Run "emit pull-taxonomies" then re-push, or pass --allow-unapplied-taxonomies (or --force).` に固定。

### Rev.1 R3
- PUT 404 で `[REMOTE_ARTICLE_DELETED]`（404）を発報。案内: `emit pull <id> --force` / `emit delete <file> --force` / frontmatter の `id` を削除して再 push。
- `pullArticle`: 404/410 + 未 push 編集 + `options.force` → `posts/conflicts/<filename>.local-orphan.md` へ退避、canonical 削除、`deleteEntry(id)`、`deleted: true, quarantined: true`。force なしは orphan 保護 + 案内追加。
- `deleteArticle`: remote 404 でも退避後に local/DB を削除完了。

### Rev.1 R4
- UPSERT を `conflict_pending = 0` なら conflict 列（`conflict_copy_hash`, `conflict_copy_path`, `conflict_at`）を無条件 NULL に改修。

### Rev.1 R5
- doctor に `row.taxonomy_apply_pending === 1` の走査を追加（WARN + `pull-taxonomies` → push 案内）。README / AGENTS.md に status のオフラインファースト設計を明記。

### Rev.1 R6
- backup 生成前に `fs.statSync(this.dbPath).size > 0` を検査、名称を `bak-0.1.13-<timestamp>` へ更新、既存 0 バイト `.bak-*` は prune 内で削除。
