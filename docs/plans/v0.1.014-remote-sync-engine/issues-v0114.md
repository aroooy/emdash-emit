# Issue 一覧（v0.1.14）— 実機黒箱レビュー指摘のソース照合・背景・影響分析

**対象バージョン**: `0.1.13` → `0.1.14`  
**検証元ログ**: `docs/v0112-eval/logs/v13_*.log`  
**照合対象ソース**: `src/sync/merge.ts`, `src/sync/push.ts`, `src/sync/pull.ts`, `src/sync/delete.ts`, `src/db/cache.ts`, `src/sync/doctor.ts`  

---

## 課題一覧サマリ

| Issue ID | 重要度 | 課題概要 | 主な影響 |
|---|---|---|---|
| **P1** | **High** | `--resolve-taxonomy local\|remote` が通常競合パスで無視され常に union になる | ユーザーが明示した taxonomy 削除意図や選択戦略が無視される |
| **P2** | **Medium** | `TAXONOMY_APPLY_PENDING` / `TAXONOMY_CONFLICT_PENDING` の誘導文循環と内容競合の混同 | 本文競合で taxonomy フラグを要求されたり、不適切なフラグを誘導される |
| **P3** | **High** | 「リモート削除済みなのにローカルで追跡中＋ローカル編集あり」状態に出口がない（デッドロック） | 手動で DB やファイルを操作しないと通常コマンドで脱出不能になる |
| **P4** | **Medium** | 競合解消後も `conflict_copy_path` が SQLite `sync_state` に残り続ける | 解決済みにもかかわらず status/doctor が退避警告を出し続け、prune が不能になる |
| **P5** | **Medium/Low** | キャッシュベース検知の仕様明示不足 ＆ `emit doctor` の `taxonomy_apply_pending` 検査欠落 | status での未検知に対する誤解の発生、診断コマンドでの潜在不整合の見落とし |
| **P6** | **Low** | 初回 DB 作成時に 0 バイトの空バックアップファイルが生成・残存する | 障害復旧時に無効なバックアップを有効と誤認するリスク |

---

## 各課題の詳細分析

### P1 (High): `--resolve-taxonomy local|remote` が通常競合パスで無視され、常に union になる

#### 1. 背景と問題の発生経緯
- 同時編集環境において、Base `{t1, t2}` に対し、Remote が `t3` を追加し、Local が `t2` を削除した場合を考える。
- ユーザーは `--resolve-taxonomy local` を指定して「ローカルの削除意図（`{t1}`）を優先したい」、あるいは `--resolve-taxonomy remote` で「リモートの追加・保持（`{t1, t2, t3}`）を優先したい」と明示指示できる仕様になっている（CLI ヘルプにも記載）。
- しかし、実測では 3 つの戦略（default, local, remote）すべてで `union`（`{t1, t3}`）となり、ユーザーの削除意図が失われる。

#### 2. ソースコードの根本原因分析
- **`src/sync/merge.ts:229-235`**:
  両者変更（`localChanged && remoteChanged`）時、`strictRenameConflict` オプションが指定されない限り、マージ結果は自動的に `autoMergedTaxonomies` にプッシュされ、`conflicts` には追加されない。
- **`src/sync/push.ts:1179-1182`**:
  ```typescript
  // If taxonomy conflict occurred, check if resolveTaxonomy strategy was explicitly provided
  if (mergeResult.taxonomyConflicts && mergeResult.taxonomyConflicts.length > 0) {
    if (options.resolveTaxonomy || options.force) {
      const strategy = options.resolveTaxonomy || 'union';
      // ...
    }
  }
  ```
  `mergeResult.taxonomyConflicts` が空配列であるため、`options.resolveTaxonomy` の判定ブロックそのものに到達しない。
- また、`hybrid3WayMerge()` の引数に `options.resolveTaxonomy` が渡されていないため、マージ計算の段階で戦略が反映されない。

#### 3. 影響
- ユーザーが CLI で `--resolve-taxonomy local` や `--resolve-taxonomy remote` を指定しても無視され、強制的に union に統合される。

---

### P2 (Medium): `TAXONOMY_APPLY_PENDING` / `TAXONOMY_CONFLICT_PENDING` の誘導文循環と内容競合の混同

#### 1. 背景と問題の発生経緯
- Markdown 本文のコンフリクト（diff3 競合）が発生し、ファイル内に `<<<<<<< LOCAL` マーカーが書き込まれた際、`sync_state.conflict_pending = 1` が記録される。
- ユーザーがマーカーを手動で編集解消して再 push しようとすると、`TAXONOMY_CONFLICT_PENDING` エラーが発生し、「`--resolve-taxonomy=union` を指定せよ」と指示される。
- ユーザーがその指示に従って `emit push --resolve-taxonomy=union` を実行すると、もしマーカーが残っていた場合は Guard G8（`UNRESOLVED_CONFLICT_MARKERS`）で停止し、マーカーを消していても taxonomy 競合ではないのに taxonomy オプションを要求される。
- 一方、term 更新失敗による `taxonomy_apply_pending = 1` は `--resolve-taxonomy` では解除できないにもかかわらず、名前が類似しておりエラーコードの意味と推奨フラグの対応関係が混乱している。

#### 2. ソースコードの根本原因分析
- **`src/sync/push.ts:654-663`**:
  ```typescript
  // Guard against blind re-push when previous taxonomy conflict is still pending
  if (syncState?.conflictPending === 1 && !options.resolveTaxonomy && !options.force) {
    throw new ApiError({
      endpoint: `/_emdash/api/content/${collection}/${id}`,
      code: 'TAXONOMY_CONFLICT_PENDING',
      status: 409,
      message: `Article ${id} (${targetFilePath}) has an unresolved taxonomy conflict from a previous sync.`,
      suggestion: `Pass --resolve-taxonomy=union|local|remote (or --force) to explicitly resolve and confirm: "emit push ${targetFilePath} --resolve-taxonomy=union"`,
    });
  }
  ```
  `conflictPending === 1` を無条件で「taxonomy conflict」と断定している。本文競合（body conflict）の場合でもこのガードが発動してしまう。

#### 3. 影響
- 本文競合を解消したユーザーが不適切なエラーと推奨文に遭遇し、ワークフローが阻害される。

---

### P3 (High): 「リモート削除済みなのにローカルで追跡中＋ローカル編集あり」状態に出口がない

#### 1. 背景と問題の発生経緯
- リモート側で記事が削除（404）されたが、ローカルには未 push の編集が残っている状態。
- この状態でユーザーが脱出を試みても、以下のすべてのコマンドでブロックされる：
  1. `emit push`: 404 が返るが、generic な `PUSH_FAILED`（`Verify network connectivity...`）と表示され、リモートで削除されたことが分からない。
  2. `emit push --revive`: リモート側で既にリソースがないため 404 で失敗。
  3. `emit pull <id> --force`: `--force` を指定しているにもかかわらず、`diskHash !== localHash` だと orphan 保護が働き、何も更新・削除されない。
  4. `emit delete`: 未 push のローカル編集があるため abort する。
  5. `emit conflicts resolve`: canonical 側に編集があるため abort する。
- ユーザーが SQLite 内部を手動でいじるか、ファイルを退避・復元して同期状態偽装を行わない限り脱出不能になる。

#### 2. ソースコードの根本原因分析
- **`src/sync/push.ts:1331-1340`**:
  PUT 応答が 404 の場合、リモート削除専用のエラーコードや案内が存在しない。
- **`src/sync/pull.ts:731-742`**:
  ```typescript
  if (diskHash === existingSync.localHash) {
    fs.unlinkSync(fullPath);
    options.cache.deleteEntry(id);
    return { ... deleted: true };
  } else {
    // Local file has unpushed edits: preserve as orphan!
    return { ... orphan: true, localEditsPreserved: true };
  }
  ```
  `options.force` が全く参照されておらず、未 push 編集がある場合は強制削除・退避クリーンアップの手段が存在しない。
- **`src/sync/delete.ts`**:
  リモートが 404 の場合でもローカル編集保護が優先され、強制破棄（`--force`）のバイパスが完全でない。

#### 3. 影響
- リモートで削除された記事にローカル変更があると、通常コマンドでワークスペースを正常状態に戻せない。

---

### P4 (Medium): 競合解消後も `conflict_copy_path` が SQLite `sync_state` に残り続ける

#### 1. 背景と問題の発生経緯
- 競合が発生して退避コピーが作成された後、競合を解消して正常に push を完了すると `conflict_pending = 0` に復帰する。
- しかし、その後も `emit status` や `emit doctor` が「退避コピーが存在する」という警告を出し続ける。
- `emit conflicts prune` を実行しても「unpushed modifications」と判定されてスキップされ、手動削除を強いられる。

#### 2. ソースコードの根本原因分析
- **`src/db/cache.ts:464`**:
  ```sql
  conflict_copy_path = CASE WHEN excluded.conflict_copy_path IS NOT NULL THEN excluded.conflict_copy_path ELSE sync_state.conflict_copy_path END,
  ```
  `saveSyncState` に `conflictCopyPath: null` を渡しても、`excluded.conflict_copy_path IS NOT NULL` が false となり、`ELSE sync_state.conflict_copy_path`（旧値）がそのまま保持される（COALESCE 動作）。
  このため、一度設定された `conflict_copy_path` は `NULL` に更新されることが永久にない。

#### 3. 影響
- 競合が完全に解消された後も、ステータス表示や診断ツールがゴースト警告を出し続ける。

---

### P5 (Medium/Low): キャッシュベース検知の仕様明示不足 ＆ `emit doctor` の `taxonomy_apply_pending` 検査欠落

#### 1. 背景と問題の発生経緯
- out-of-band でリモート taxonomy が変更された直後に `emit status` を実行しても、"170 synced / divergence 警告なし" と表示される。
- Emit の `status` はローカルキャッシュ基準のオフラインファースト設計であるためだが、ユーザーから見ると「ドリフトを検知できていない」と誤認される。
- また、`emit doctor` は `conflict_pending` や `delete_pending` を検査するが、新設された `taxonomy_apply_pending` を検査対象に含めていない。

#### 2. ソースコードの根本原因分析
- **`src/sync/doctor.ts`**:
  `sync_state` を走査するロジックにおいて、`row.taxonomy_apply_pending === 1` の判定が存在しない。
- **ドキュメント**:
  `emit status` がローカル高速判定（オフライン対応）であり、リモートとの即時照会は `emit pull` や `emit push` の audit で行われることの説明が不足。

#### 3. 影響
- 診断ツールで潜在的な term 未反映状態が見落とされ、ユーザーが現状を正確に把握できない。

---

### P6 (Low): 初回 DB 作成時に 0 バイトの空バックアップファイルが生成・残存する

#### 1. 背景と問題の発生経緯
- `.emit/cache.db.bak-0.1.11-2026-11-09T09-43-03-832Z` という 0 バイトのバックアップファイルがディスク上に生成される。
- SQLite として開いてもテーブルが存在しないため、障害復旧時に「破損したバックアップ」と誤認される。

#### 2. ソースコードの根本原因分析
- **`src/db/cache.ts:214-218`**:
  ```typescript
  if (this.dbPath !== ':memory:' && fs.existsSync(this.dbPath)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bakPath = `${this.dbPath}.bak-0.1.12-${timestamp}`;
    fs.copyFileSync(this.dbPath, bakPath);
    // ...
  }
  ```
  `new DatabaseSync(this.dbPath)` の直後に 0 バイトの空ファイルが作られた状態でマイグレーションが走ると、サイズ検査を行わずにそのままバックアップを作成してしまう。

#### 3. 影響
- 無用な 0 バイトファイルがディスクを汚染し、運用・復旧時の混乱を招く。
