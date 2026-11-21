# v0.1.24 実装計画書: 公開記事上の未公開ドラフト同期とステータス可視化 (Rev.4)

**バージョン**: v0.1.24  
**作成日**: 2026-11-14 (Rev.4: 2026-11-14)  
**ステータス**: 実装計画承認（最終確認）  
**対象リポジトリ**: `emdash-emit` (`emit`)

---

## 1. 背景と課題分析

### 1.1 背景
EmDash CMS（Cloudflare Workers + D1）は、一般的な CMS（WordPress 等）と異なり、**「公開中の記事（`status: published`）に対して、本番公開を維持したまま未公開の下書き変更（draft revision）を重ねて保存する」** 機能を備えている。

### 1.2 発覚した課題
本番環境（`https://aroooy.net`）にて、公開記事（ID: `01M77VFT15HSH2M1XW8MJPTCPQ` / カワセミ記事）に対し、Web 管理画面から「未公開の変更（下書き保存）」を行った後、`emit pull` を実行したところ、以下の事象が発生した：

- ローカルファイル（`posts/published/...カワセミ....md`）に、サーバー側で追記した「未公開の変更（10ブロック）」が反映されず、公開中の古い本文（7ブロック）のままとなった。
- かつ、SQLite キャッシュ（`sync_state.remote_rev`）は最新の下書き ULID（`19@draft:01M7CD9YGWNPAEP1Z7NC8600ZD`）に進んだため、2回目以降の pull では `already up-to-date` としてスキップされ、編集が同期されなくなった。

### 1.3 実サーバー（`https://aroooy.net`）の実測証跡

該当記事の API レスポンスを直接調査・比較した結果：

| 項目 | 一覧 API（`GET /posts?status=published`） | 単体 GET API（`GET /posts/{id}`） |
|---|---|---|
| `status` | `'published'` | `'published'` |
| `liveRevisionId` | `01M7CCGC748FQWMC3FDBP4WDY7`（公開中 ULID） | `01M7CCGC748FQWMC3FDBP4WDY7`（公開中 ULID） |
| `draftRevisionId` | **`01M7CD9YGWNPAEP1Z7NC8600ZD`**（最新下書き ULID） | **`01M7CD9YGWNPAEP1Z7NC8600ZD`**（最新下書き ULID） |
| `data.content` ブロック数 | **7 ブロック（公開中の古い liveData のみ）** | **10 ブロック（「未公開の変更」を含む最新ドラフト本文）** |
| `liveData.content` ブロック数 | null（未返却） | 7 ブロック（現在 Web 上に公開中の本文） |

### 1.4 原因の構造
v0.1.23 で導入した選択的単体 GET フォールスルー（`src/sync/pull.ts:822`）において：
```typescript
if (itemStatus !== 'published' && existingSync && remoteChanged) {
  rawItem = undefined;
}
```
公開記事への影響を避けるために `itemStatus !== 'published'` と厳密に制限していたため、**「`status` は `published` だが、未公開のドラフト変更（`draftRevisionId`）が存在する記事」** が除外され、単体 GET が呼ばれなかった。

---

## 2. 設計方針とインバリアント

### 2.1 ドラフトリビジョン検出による選択的単体 GET（`needsFullDraftFetch`）
単体 GET を呼び出して完全な本文を取得すべき本質的な条件は、「`status !== 'published'`」ではなく、
**「記事に未公開のドラフト変更が存在する（`draftRevisionId` が存在する）場合」** である。

```typescript
const rawObj = rawItem as Record<string, unknown>;
const hasDraftRevision = Boolean(rawObj.draftRevisionId);
const isDraft = String(rawObj.status || 'draft') !== 'published';
const needsFullDraftFetch = isDraft || hasDraftRevision;

const existingSync = options.cache.getSyncState(id);
const rawRevCandidate = String(rawItem._rev || rawItem.rev || rawItem.version || rawObj._rev || '');
const remoteRev = extractRev(rawObj, rawRevCandidate);
const remoteComparisonRev = extractComparisonRev(rawObj, remoteRev);
const remoteChanged = !existingSync || !isSameRev(existingSync.remoteRev, remoteComparisonRev);

if (needsFullDraftFetch && existingSync && remoteChanged) {
  rawItem = undefined; // 一覧の不完全なデータを破棄し、単体 GET で最新ドラフト本文 (10ブロック) を取得！
}
```

- **純粋な公開記事（`draftRevisionId === null`）**:
  - `needsFullDraftFetch` は false。
  - 単体 GET は **一切呼ばない（0-GET を完全維持、ゼロオーバーヘッド）**。
- **下書き記事、および「未公開の変更がある公開記事」（`draftRevisionId` あり）**:
  - `needsFullDraftFetch` は true。
  - リモートでリビジョンが進んでいる場合のみ、単体 GET から最新本文（10ブロック）を取得してローカルへ反映。

### 2.2 ディレクトリ配置の不変条件（ディレクトリ分離は行わない）
- 「未公開の変更がある公開記事」を `posts/draft/` に移動させたり、新たなディレクトリ（`posts/published-drafts/` 等）を新設することは **行わない**。
- **理由**:
  1. 記事は現在本番 Web 上に公開されており、`status: published` であるため、`draft/` に移動させると状態の誤認を招く。
  2. ディレクトリ移動による相対画像パス（`../../media/...`）の破損や Git 履歴の複雑化を防ぐ。
  3. Git の「公開タグに対して手元の作業ツリーに変更が乗っている」モデルと整合させ、ファイルは `posts/published/` のまま最新の編集内容を保持する。

### 2.3 未公開ドラフト状態の可視化（`emit status` & MCP `sync_status`）
ディレクトリを動かさない代わりに、ユーザーが一目で「公開中だが未公開の変更がある」と認識できるよう、ステータス表示を拡張する。

- **`emit status` の表示イメージ**:
  ```text
  --- Workspace Status (posts | origin: https://aroooy.net) ---
    🟢 [synced  ] published   posts/published/... (通常の公開記事)
    🟣 [synced  ] published*  posts/published/20261113_01M77VFT... (カワセミ...)  [has unpublished draft]
  ```
- **判定ロジック**:
  - `syncState.status === 'published'` かつ `syncState.remoteRev` が `@draft:` を含む場合に `hasUnpublishedDraft = true` と判定。
  - **オフラインファースト設計の堅持**: `emit status` は完全オフライン・副作用なしのコマンドであるため、前回の pull/push 成功時点のキャッシュ情報を表示する。Web 側で publish や discard が行われた場合、次回の `emit pull` で同期されるまで `@draft:` 表示が残る（詳細は §5 リスク評価）。
- **`emit doctor` での補助診断**:
  - `emit doctor` 実行時に、退避コピーが存在せずローカル本文がベースラインと一致しているにもかかわらず `remoteRev` が `@draft:` を保持している場合、「ドラフト表示がリモートの操作により stale になっている可能性があるため、`emit pull` で最新化を推奨する」旨の info メッセージを表示する。

### 2.4 プッシュセマンティクス（Push Semantics for Published Posts with Drafts）
公開記事の手元編集を `emit push` した場合の挙動について、EmDash サーバー仕様および Emit の安全設計に基づき以下のセマンティクスを確立・保証する：

1. **EmDash サーバー側のステージング仕様（大前提）**:
   - EmDash の `content_update` API 仕様（`content_update.json`）では：
     > *"When status is not set, a change to a published item is staged as a draft, so the response shows the new values while the live version keeps the old ones until content_publish."*
   - Emit の PUT ペイロードは `status` を省略（omit）しているため（`src/client/mapper.ts:134-136`）、**通常の `emit push <file>`（`allowPublish: false`）では、EmDash サーバー側の仕様により本番公開面は上書きされず、「未公開の下書き（staged draft）」として安全に保存される**。
   - ※注: `publishedAt` は PUT ペイロードに含まれますが（`mapper.ts:138-140`）、これは公開日時のメタデータであり status 自体のステージング挙動を変更するものではありません。
2. **`--allow-publish` フラグとの相互作用と安全ガイド**:
   - 手元で編集した内容を本番公開面にも即時反映させたい場合は、`emit push <file> --allow-publish` を明示する。
   - **注意すべき相互作用**: Web 画面で作成された下書き（10ブロック）を `emit pull` した後、ローカルで軽微な編集を加えて `--allow-publish` を付与して push した場合、**手元の修正だけでなく Web 画面で書かれていた下書き内容も含めて本番に公開される**。
   - **安全通知**:
     - `remoteRev` が `@draft:` を含む公開記事に対して `allowPublish: true` で push した場合、「リモートの未公開ドラフトを含む内容が本番公開されました」という警告/通知メッセージを出力する。
     - 逆に `allowPublish: false` で push した場合、「変更はリモート上で下書き（draft revision）として保存されました。本番公開するには --allow-publish を指定してください」という案内を出力する。

### 2.5 （展望/ロードマップ）未公開ドラフト破棄機能 (`emit discard-draft`)
EmDash 公式 REST API `POST /_emdash/api/content/{collection}/{id}/discard-draft`（"Reverts the content item to its live (published) version."）が存在することを確認済み。
Web 画面等で行った下書き変更を破棄して本番公開版にロールバックする機能（`emit discard-draft`）を次期マイナーアップデート（v0.1.25）で新設するロードマップを策定する。

---

## 3. 実装詳細と影響モジュール

### 3.1 レイヤリング遵守
- `src/sync/pull.ts` (Layer 2): `needsFullDraftFetch` 条件分岐の改修
- `src/sync/status.ts` (Layer 1): 未公開ドラフト状態の判定と `ArticleStatusItem` 拡張
- `src/cli/commands/status.ts` (Layer 3): `published* [has unpublished draft]` の CLI 整形表示
- `src/mcp/tools/sync-status.ts` (Layer 3): `hasUnpublishedDraft` の透過返却

### 3.2 改修箇所: `src/sync/pull.ts`
[src/sync/pull.ts](file:///Volumes/ext/github/emdash-emit/src/sync/pull.ts#L807-L828) の条件判定を改修：

```typescript
  // 1. Fast-path check: If rawItem is provided in options, test fast-path / heal
  if (rawItem) {
    const fastResult = await tryFastPathOrHeal(rawItem);
    if (fastResult) return fastResult;

    // Fast-path missed: remote content changed or local repair required.
    // EmDash list API returns stale creation-time posts.data for drafts, and liveData for published articles.
    // When a published article has unpublished draft changes (draftRevisionId exists), list API does NOT expand
    // the draft body (it returns only liveData).
    // Therefore, if this is an existing tracked article whose remote draft revision has advanced, we must discard
    // the stale list rawItem so Step 2 fetches the full canonical item via single GET!
    const rawObj = rawItem as Record<string, unknown>;
    const hasDraftRevision = Boolean(rawObj.draftRevisionId);
    const isDraft = String(rawObj.status || 'draft') !== 'published';
    const needsFullDraftFetch = isDraft || hasDraftRevision;

    const existingSync = options.cache.getSyncState(id);
    const rawRevCandidate = String(rawItem._rev || rawItem.rev || rawItem.version || rawObj._rev || '');
    const remoteRev = extractRev(rawObj, rawRevCandidate);
    const remoteComparisonRev = extractComparisonRev(rawObj, remoteRev);
    const remoteChanged = !existingSync || !isSameRev(existingSync.remoteRev, remoteComparisonRev);

    if (needsFullDraftFetch && existingSync && remoteChanged) {
      rawItem = undefined;
    }
  }

  // 2. Fetch raw item if not passed in options (or discarded above)
  if (!rawItem) {
    const url = articleContentEndpoint(options.origin, collection, id);
    ...
```

### 3.3 改修箇所: `src/sync/status.ts` & `src/cli/commands/status.ts`
1. `src/sync/status.ts`:
   - `ArticleStatusItem` インターフェースに `hasUnpublishedDraft?: boolean` を追加：
     ```typescript
     export interface ArticleStatusItem {
       ...
       hasUnpublishedDraft?: boolean;
     }
     ```
   - status 判定ループ内：
     ```typescript
     const hasUnpublishedDraft =
       syncState?.status === 'published' &&
       Boolean(syncState.remoteRev && syncState.remoteRev.includes('@draft:'));
     ```
2. `src/cli/commands/status.ts`:
   - 行 114〜130 の整形部において：
     ```typescript
     if (item.hasUnpublishedDraft) {
       icon = '🟣';
     }
     const statusDisplay = item.hasUnpublishedDraft ? 'published*' : (item.status || '');
     const paddedStatus = statusDisplay.padEnd(9, ' ');
     const draftTag = item.hasUnpublishedDraft ? ' [has unpublished draft]' : '';
     console.log(
       `  ${icon} [${label}] ${paddedStatus} ${item.filePath}${titleDisplay}${cacheTag}${draftTag}${errorDisplay}`,
     );
     ```

---

## 4. テスト計画

### 4.1 ユニット・統合テスト
1. **`tests/pull_draft_revision.test.ts` (テストケース追加)**:
   - 公開記事（`status: 'published'`）に対し、サーバー側で未公開ドラフト（`draftRevisionId`）が追加されたシチュエーションを作成。
   - `pullArticle` 実行後：
     - 一覧 API の古い liveData（7ブロック）ではなく、単体 GET 由来の最新ドラフト本文（10ブロック）がローカルファイルに反映されること。
     - 単体 GET が確実に 1 回呼ばれること（call-count = 1）。
2. **`tests/pull_published_no_extra_get.test.ts` (ゼロオーバーヘッド維持確認)**:
   - 純粋な公開記事（`draftRevisionId: null`）が更新されたケースにおいて、単体 GET が **0 回（call-count = 0）** であり、ゼロオーバーヘッドが維持されていることを継続検証。
3. **公開記事での未プッシュ編集退避保護テスト (`tests/pull_draft_revision.test.ts`)**:
   - `status: published` かつリモートで未公開ドラフトが進んでいる状態で、ローカルに未プッシュ編集がある場合：
     - ローカルファイルが `posts/conflicts/*.conflict.md` に安全に退避隔離されること。
     - `sync_state.body_conflict_pending === 1` および `conflictCopyPath` がセットされること。
     - 退避コピー（`posts/conflicts/...`）を直接 push しようとした場合は Guard G12（`QUARANTINED_COPY_NOT_PUSHABLE`）で拒否されること（既存の `tests/pull_quarantine.test.ts:392` パターン）。
4. **ステータス表示テスト (`tests/status_unpublished_draft.test.ts`)**:
   - `status: published` かつ `remoteRev: '19@draft:...'` の記事が、`hasUnpublishedDraft: true` と判定され、CLI 出力で `published*` および `[has unpublished draft]` となることを検証。
   - MCP `sync_status` 出力の JSON オブジェクトに `hasUnpublishedDraft: true` が透過されることを検証。
5. **プッシュセマンティクステスト (`tests/push_published_draft.test.ts`)**:
   - 公開記事の手元編集を push する際、`allowPublish` なしの場合は status 遷移エンドポイントが呼ばれず EmDash 上でドラフトとして更新されること。
   - `allowPublish: true` の場合は status 遷移エンドポイントが呼ばれて本番公開されること。
6. **`publishedAt` 保持テスト**:
   - `publishedAt` を持つ公開記事のドラフト fetch において、`apiResponseToLocal` 経由で frontmatter の `publishedAt` が保持され、push 時に `payload.publishedAt` として送信されること。
7. **一括 pull での冪等性テスト**:
   - ローカルに 10 ブロックが書き込まれた後、再度 `pullBatch` を実行した際、fast path がヒットして単体 GET が 0 回（call-count = 0）となり、`synced` 状態が維持されること。

### 4.2 実機ワークスペース（`aroooy.net`）での検証手順
1. 本番ワークスペース `/Volumes/ext/github/emdash.aroooy.net` で `emit pull` を実行。
2. 該当記事 `posts/published/20261113_01M77VFT15HSH2M1XW8MJPTCPQ-【野鳥撮影】枝にとまるカワセミの静寂な佇まいに出会った日.md` を確認し、サーバー側で追記された「未公開の変更（10ブロック）」が完全にローカルファイルに反映されていることを確認。
3. `emit status` を実行し、該当記事が `published* [has unpublished draft]` として可視化されることを確認。
4. 続けて `emit pull` を再実行し、`0 updated, 60 skipped/up-to-date`（完全な冪等性）が維持されることを確認。

---

## 5. リスク評価と互換性担保

1. **純粋な公開記事への影響ゼロ**:
   - `draftRevisionId === null` の公開記事は `needsFullDraftFetch === false` となるため、単体 GET は一切呼ばれず、通信コスト・既存ロジックともに 100% 維持される。
2. **stale なキャッシュによる表示残留リスク（オフライン設計のトレードオフ）**:
   - `emit status` は完全オフライン・副作用なしの高速コマンドであるため、Web UI 上でドラフトが破棄されたり公開された場合でも、手元で `emit pull` を実行するまではキャッシュの `@draft:` 表示が残る。
   - これは status コマンドのオフラインファースト設計における正常な挙動であり、不自然なタイムスタンプ窓やオンライン通信を入れず、`emit pull` による同期を正とする仕様として位置づける。なお、`emit doctor` による stale ドラフトの info 診断機能は v0.1.25 での拡張課題とする。
3. **プッシュ時の意図しない公開破壊リスクの防止**:
   - EmDash の PUT エンドポイントは status なしの更新をドラフトとしてステージングするため、手元からの通常 push で本番公開面が不意に破壊・公開されることはない。
   - ただし `--allow-publish` を付与して push した場合は Web 画面由来の下書きも含めて本番公開されるため、明示的な通知・案内によりユーザーへの注意喚起を行う。
4. **未プッシュローカル編集時のデータ保護と今後の課題**:
   - リモートで未公開ドラフトが進んだ場合も、ローカルに未プッシュ編集があれば `quarantineDivergentLocalCopies` により安全に `posts/conflicts/` に退避隔離され、`body_conflict_pending = 1` がセットされる。
   - ※なお、退避コピーが存在する状態での canonical ファイルの直接 push 阻止（`emit push --all` 経由でも同様に素通しする点を含む `bodyConflictPending === 1` を検査する新ガードの導入）は、Emit 全体のガードレール設計に関わるため、次期バージョン（v0.1.25）の検討課題とする。
5. **レイヤリング整合性**:
   - Layer 0〜3 の依存関係ルールに完全準拠。

---

## 6. ドキュメントおよびリリースタスク

- [ ] `package.json`: バージョンを `0.1.24` にバンプ
- [ ] `CHANGELOG.md`: `[0.1.24] - 2026-11-14` を追記
  - 公開記事でも `draftRevisionId` が存在すれば選択的単体 GET を呼び出すよう拡張（v0.1.23 の記述と矛盾しないよう「純粋な公開記事の 0-GET 維持」と「ドラフト変更がある公開記事の最新化」を整理して記載）
  - ステータス表示（`published* [has unpublished draft]`）の追加
  - プッシュセマンティクスと `--allow-publish` 相互作用の明記
- [ ] `AGENTS.md`:
  - **Draft Selective Single GET Invariant** の記述を更新（`itemStatus !== 'published'` から `needsFullDraftFetch = isDraft || hasDraftRevision` へ更新）
  - 公開記事上の未公開ドラフトに関するプッシュセマンティクス（Two-Track Invariant または Guardrails 節）を追記
- [ ] `npm run check`（`format:check` + `typecheck` + `test` 全件合格）
- [ ] Git コミット & `v0.1.24` タグ作成
