# v0.1.23 実装計画書: 下書き更新時の選択的単体GETフォールスルー (Rev.3 確定版)

**バージョン**: v0.1.23  
**作成日**: 2026-11-14 (Rev.3 確定・承認済み)  
**ステータス**: 実装中  
**対象リポジトリ**: `emdash-emit` (`emit`)

---

## 1. 背景と課題分析

### 1.1 背景
v0.1.22 において、下書き編集時に `posts.version` や `posts.updatedAt` が進まず `draftRevisionId` のみが更新される EmDash の特性に対応するため、Two-Track Revision Invariant（Track 1: 生トークン / Track 2: 複合キー `${version}@draft:${draftRevisionId}`）を導入した。
これにより、`emit pull` は下書きのリビジョン進展（リモート更新）を 100% 確実に検知（`✅ Pulled`）できるようになった。

### 1.2 発覚した課題（一覧 API の不完全な本文データ）
本番環境（`https://aroooy.net`）にて、EmDash 管理画面で下書きに画像ブロックやテキストを追記した記事（ID: `01M7BZH06K515A5NQWZ36QK7NQ`）に対し `emit pull` を実行したところ、以下の事象が発生した：

- `[30/60] ✅ Pulled v0119-featured-image-test -> posts/draft/...` と出力され、更新処理自体は実行された。
- しかし、ローカルの Markdown ファイルには、追記した画像ブロックやテキストが反映されず、作成時の古い本文のまま上書きされた。
- かつ、SQLite キャッシュ（`sync_state.remote_rev`）は最新の `draftRevisionId` に更新されたため、2回目以降の pull では `already up-to-date` としてスキップされ、編集が二度と同期されなくなった。

### 1.3 原因の構造（EmDash API の仕様と Emit の取得フロー）

#### (1) EmDash（Cloudflare Workers + D1）のライフサイクル
- **下書き（draft）記事**:
  - Web エディタ等で保存すると、`revisions` テーブルに最新本文（JSON 7ブロック等）が `INSERT` され、親テーブル `posts` の `draftRevisionId` のみが更新される。
  - 親テーブル自身の `data` カラム（作成時の JSON 3ブロック）は更新されない。
  - **一覧 API（`GET /posts?status=draft`）**: 親テーブルの `posts.data` をそのまま返すため、`draftRevisionId` は最新だが、**本文は作成時の古い 3 ブロックしか返さない**（OpenAPI 仕様上も展開オプションは存在しない）。
  - **単体 GET API（`GET /posts/{id}`）**: `draftRevisionId` を元に `revisions` テーブルから最新データを取得・結合して返すため、**完全な最新 7 ブロックが返却される**。
- **公開（published）記事**:
  - 公開時に親テーブル `posts.data` が確定コミットされる。
  - **一覧 API の `data.content` と単体 GET の内容は完全一致（バイト単位で同一）** している（実機検証済み）。

#### (2) Emit 側のコード（`src/sync/pull.ts:802-815`）の欠陥
- バッチ pull（`emit pull`）は、一覧 API から取得した `rawItem` を `pullArticle` に渡す。
- `pullArticle` は `tryFastPathOrHeal(rawItem)` でリビジョン進展を検知し、fast-path を抜ける（スキップしない）。
- しかし、直後の処理が `if (!rawItem)` というガードになっているため、「一覧の `rawItem` が既にある」と判定され、単体 GET が呼ばれなかった。
- その結果、**一覧 API の不完全な古い本文でローカルファイルが書き換えられてしまった**。

---

## 2. 設計方針とインバリアント

### 2.1 公開投稿のゼロオーバーヘッド維持（最重要要件）
- **要件**: 「公開投稿に関しては、現状の処理（emit pull）で正しく最新化される。これを壊さないように。または無駄な処理を増やさないように。」
- **設計**:
  - 公開記事（`status === 'published'`）が更新された場合、一覧 API の `data.content` は最新公開内容と完全一致しているため、**単体 GET は一切呼ばない**。
  - 一覧 API の `rawItem` をそのまま使ってローカル Markdown を更新する。
  - これにより、公開記事の同期処理は既存と全く同じ挙動を保ち、無駄な HTTP リクエストの増加は **ゼロ（0 件）** を維持する。

### 2.2 下書き更新時の選択的単体 GET フォールスルー
- **設計**:
  - 下書き記事（`status === 'draft'`）において、リモート更新を検知（fast-path ミス）した場合のみ、一覧 API の不完全な `rawItem` を破棄（`rawItem = undefined`）する。
  - 直後の Step 2（`if (!rawItem)`）が発火し、**単体 GET（`articleContentEndpoint`）から `revisions` 結合済みの完全な最新下書き本文（7ブロック）を取得**してローカルファイルを更新する。
  - 単体 GET が走るのは「実際にリモートで更新された下書き記事」の件数分のみ（通常 0〜1 件）に限定される。
  - **フェイルセーフ方針**: `status` が未定義または欠落している場合は、安全側に倒して `'draft'` 扱いとし、単体 GET を実行して不完全な本文書き込みを絶対に防止する。

### 2.3 未プッシュローカル編集がある場合のデータ保護（論点 A）
- リモートで下書きが更新された際、ローカル側にも未プッシュの編集が存在する場合：
  - `tryFastPathOrHeal` は `!isSameRev` により即座に `return null` となるため、Branch 3（編集保持スキップ）は発火しない。
  - 単体 GET で取得された完全な最新本文によりローカルファイルは更新されるが、**未プッシュのローカル編集内容は `quarantineDivergentLocalCopies`（`pull.ts:1000`）により `posts/conflicts/*.conflict.md` へ 100% 安全に隔離保存される**。
  - かつ `body_conflict_pending = 1` がセットされ、Guard G12 によりコンフリクト解決前の不用意なプッシュが確実にブロックされる。
  - ※公開記事（`published`）においてもリモート更新時は同様に隔離保護が発火するため、draft / published 間で競合保護の非対称性は存在しない（一貫した安全設計）。

---

## 3. 実装詳細と影響モジュール

### 3.1 レイヤリング遵守
- 変更は **Layer 2（`src/sync/pull.ts`）** のみに局所化される。
- Layer 0, Layer 1, Layer 3 への変更はなく、レイヤリングルール（`tests/layering.test.ts`）を 100% 遵守。

### 3.2 改修箇所: `src/sync/pull.ts`

[src/sync/pull.ts](file:///Volumes/ext/github/emdash-emit/src/sync/pull.ts#L802-L815) の Step 1〜2:

```typescript
  // 1. Fast-path check: If rawItem is provided in options, test fast-path / heal
  if (rawItem) {
    const fastResult = await tryFastPathOrHeal(rawItem);
    if (fastResult) return fastResult;

    // Fast-path missed: remote content changed.
    // EmDash list API returns stale creation-time posts.data for drafts (latest revision is in revisions table).
    // For published articles, EmDash list API returns the up-to-date committed content (no extra GET needed).
    // Fail-safe: Any non-published status defaults to 'draft' and fetches the full canonical item via single GET.
    const rawObj = rawItem as Record<string, unknown>;
    const itemStatus = String(rawObj.status || 'draft');
    if (itemStatus !== 'published') {
      rawItem = undefined;
    }
  }

  // 2. Fetch raw item if not passed in options (or discarded above for draft updates)
  if (!rawItem) {
    const url = articleContentEndpoint(options.origin, collection, id);
    ...
```

---

## 4. テスト計画

### 4.1 ユニット・統合テスト
1. **`tests/pull_draft_revision.test.ts`（既存ファイルへ追記、論点 B/F 対応）**:
   - `sync_state.remote_rev` に旧複合キー（例: `3@draft:01M7OLD...`）を seed して fast-path miss を再現（論点 F）。
   - 一覧 API の mock が古い `posts.data`（3ブロック）を返し、単体 GET の mock が新しい `revisions.data`（7ブロック）を返すシチュエーションを作成。
   - `pullArticle` 実行後、ローカルファイルに単体 GET 由来の最新本文（7ブロック）が反映されることを検証。
   - 単体 GET（`articleContentEndpoint(origin, collection, id)`）の fetch 呼び出し回数が **確実に 1 回（call-count = 1）** であることを検証。
2. **`tests/pull_draft_revision.test.ts`（未プッシュ編集競合テスト追加、論点 A 対応）**:
   - ローカルに未プッシュ編集がある下書きに対し、リモートで `draftRevisionId` が進んだ場合：
     - ローカル編集が `posts/conflicts/*.conflict.md` に安全隔離されること。
     - `body_conflict_pending = 1` が `sync_state` に記録され、Guard G12 で保護されること。
3. **`tests/pull_published_no_extra_get.test.ts`（新設、論点 C/G 対応）**:
   - `src/sync/orchestrator.ts` の `pullBatch` レイヤーを通した統合テスト（`mediaSync: false` を指定）。
   - 公開記事（`status: published`）が更新されたケースにおいて、一覧 API の `rawItem` だけで同期が完了すること。
   - id 付き `articleContentEndpoint(origin, collection, id)` への呼び出し回数が **完全に 0 回（call-count = 0）** であることを URL フィルタで厳密に検証。

### 4.2 実機ワークスペース（`aroooy.net`）での検証手順
1. 本番ワークスペース `/Volumes/ext/github/emdash.aroooy.net` で `emit pull` を実行。
2. 該当記事 `posts/draft/20261114_01M7BZH06K515A5NQWZ36QK7NQ-【検証】v0.1.19-アイキャッチLocal-First自動解決テスト.md` を確認し、サーバー側の追記（画像ブロック・追記テキスト）がローカルファイルに完全に反映されることを確認。
3. 続けて `emit pull` を再実行し、`0 updated, 60 skipped/up-to-date`（完全な冪等性）が維持されることを確認。
4. `emit status` で全 60 記事がクリーンな同期状態（`synced`）であることを確認。

---

## 5. リスク評価と互換性担保

1. **公開記事の完全保護とゼロオーバーヘッド**:
   - `itemStatus !== 'published'` のガードにより、公開記事（`published`）の処理フローには 1 行の影響も与えず、追加通信 0 件を維持。
2. **sync window との相互作用（論点 D）**:
   - 下書きとして pull された記事が後に公開され、かつ `postsSyncLimit`（既定 30 件）の外へ押し出された場合、ローカルに未プッシュ編集が残っていると AGENTS.md のプルーニング保護（`SyncPruneConflictError`）が発火して安全に pull が中断される。これは既存の安全仕様と完全に合致する。
3. **HTTP 409 連鎖の防止**:
   - v0.1.22 で確立した Two-Track Revision Invariant（PUT 送信時は Track 1 の生トークンを最優先）により、同期後のプッシュでも 409 コンフリクトは発生しない。

---

## 6. ドキュメントおよびリリース更新タスク

1. `package.json`: バージョンを `0.1.23` に更新。
2. `CHANGELOG.md`: `[0.1.23] - 2026-11-14` を新設し、下書き更新時の単体 GET 選択的フォールスルーを明記。
3. `AGENTS.md`: Two-Track Revision Invariant の直下に「一覧 API は draft 本文を持たないため、更新検知時は単体 GET へフォールスルーする（status 欠落時はフェイルセーフとして draft 扱い）」インバリアントを追記（論点 H）。
4. `docs/media-id-spaces.md`: draft 本文の出所が `revisions` テーブルであり一覧 API では展開されない事実、および `entries.rawJson` に保存される JSON が単体 GET 由来の完全なレスポンスになる旨を注記（論点 I）。
