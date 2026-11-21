# v0.1.25 実装課題・バックログ (Backlog & Future Specs)

v0.1.24 の実装およびレビューを通じて特定された、次期マイナーアップデート（v0.1.25）での実装課題および設計仕様です。

---

## 1. `bodyConflictPending === 1` 検査ガードの導入と `push --all` の保護

### 1.1 背景と課題
- 現在、`posts/conflicts/` 配下の退避コピーを直接 push しようとした場合は Guard G12（`QUARANTINED_COPY_NOT_PUSHABLE`）で拒否される。
- しかし、退避コピーが存在する（`sync_state.bodyConflictPending === 1`）状態であっても、canonical ファイル（`posts/published/...md` または `posts/draft/...md`）を手元で直接編集して `emit push <file>` または `emit push --all` を実行した場合、これを阻止する guard は存在しない。
- 特に `src/sync/orchestrator.ts:416-418` の一括 push（`emit push --all`）は `getWorkspaceStatus` で `modified` と判定された記事を無条件に対象とするため、退避コピーに手元の旧編集が残されたまま、素通しで push されてしまうリスクがある。

### 1.2 設計方針（新ガード G20 相当）
- `src/sync/push/guards.ts` の `evaluatePrePreflightGuards` に `checkBodyConflictGuard` を新設。
- `syncState.bodyConflictPending === 1` かつ `--force` が指定されていない場合、`ApiError`（`BODY_CONFLICT_PENDING`）をスローして push を安全に停止する。
- 解除手順: `emit conflicts resolve <id>` または退避コピーの削除・マージを案内。
- `tests/guards.test.ts` の G1..G19 連続性検査を G1..G20 へ更新。

---

## 2. `emit doctor` による stale ドラフト補助診断

### 2.1 背景
- `emit status` は完全オフライン・副作用なしの設計であるため、Web UI 上でドラフトが discard されたり publish された場合、手元で `emit pull` を実行するまではキャッシュの `@draft:` 表示（`published* [has unpublished draft]`）が残る。

### 2.2 設計方針
- `src/sync/doctor.ts` の診断ループ（`:392-406`）において：
  - 退避コピーが存在せず、ローカル本文の hash がベースラインと一致しているにもかかわらず、`remoteRev` が `@draft:` を保持している場合：
  - `info` レベルの診断メッセージとして「ドラフト表示がリモートの操作（Web UI での公開や破棄）により stale になっている可能性があります。最新化するには "emit pull <id>" を実行してください」を出力する。

---

## 3. 未公開ドラフト破棄機能 (`emit discard-draft`)

### 3.1 背景
- EmDash 公式 REST API `POST /_emdash/api/content/{collection}/{id}/discard-draft`（"Reverts the content item to its live (published) version."）が存在する。
- Web UI 等で誤って作成・ステージングされた未公開ドラフトを、CLI から安全に破棄して本番公開版（liveData）にロールバックする機能を提供する。

### 3.2 設計方針
- `src/client/endpoints.ts` に `articleDiscardDraftEndpoint` を新設。
- CLI コマンド `emit discard-draft <file-or-id>` を追加。
- 実行時にローカルの未プッシュ編集がある場合は、通常通り退避コピーを作成してからリモートの discard-draft を呼び出し、最新の liveData をローカルに反映して `sync_state.remote_rev` を `@live:` に戻す。
