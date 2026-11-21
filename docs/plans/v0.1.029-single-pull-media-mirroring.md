# Emit v0.1.29 リファクタリング・機能強化計画書（Rev.3）

**テーマ**: バッチ Pull の完全な無劣化（非デグレード）保証を前提とした、単一記事 Pull（`pullArticle`）の欠落処理補完とメディア自動同時ミラーリングの統合

- **対象リビジョン**: `v0.1.28`（commit `f44271c`）完了時点の `main` ブランチ（`src/` 94 ファイル、`tests/` 59 ファイル・615 tests）
- **ステータス**: Rev.3 — **Rev.2 レビュー指摘（4 つの設計リスク解消・実コード照合修正）を完全反映済み・実装着手可能**
- **Rev.2 → Rev.3 の改訂点**:
  1. **【リスク 1 解消】0-HTTP 短絡時における `media_state`（`mediaId` / `local_content_hash` / `remote_record_ref`）同期補完の明文化（正本: §2 P1 Step 2）**:
     - バイナリ＋companion `.yaml`（`mediaRecordIdForStem` で `id:` ULID が確認できるものに限る）により 0-HTTP 短絡する際、ローカルバイナリの実測 SHA-256（`localContentHash`）と `remoteRecordRef` を `cache.saveMediaState` へ Upsert する仕様を §2 P1 Step 2 に一元化。
  2. **【リスク 2 解消】Step 3 リモート取得失敗時の非破壊フォールバックと警告義務の分離・明文化（§2 P1 Step 3 & §4 T6）**:
     - `tests/local_media_refs.test.ts:55, 83-129` は `beforeEach` でバイナリのみを配置し（`.yaml` と `media_state` なし）、`fetchFn: vi.fn()`（`undefined` 返却）で `pullArticle` を呼ぶため、Step 2 の短絡条件は成立せず Step 3 に進む。
     - Step 3 でリモート取得が失敗・空応答となった場合、① ローカルにバイナリすら存在しない未解決キーは必ず `orphanStorageKeys` / `unresolvedFeaturedImageId`（および `mediaFetchFailed` 警告）に記録して CLI/MCP で警告出力することを義務化し、② 既にローカル `media/<storageKey>` にバイナリが実在している場合のみ `verifiedStorageKeys` としてローカル相対パス化を維持する 2 段階ルールを定義。
  3. **【リスク 3 解消】バッチ Pull テスト（T7〜T9）の 1 ページモック設計と走査回数 assert の明記（§4）**。
  4. **【実測記述の精緻化】§2.0 表の重複行（#8, #9）の整理と、`orchestrator.ts` における `loadLocalTaxonomyCandidates` 未呼び出し（0 箇所）の正確な記述への統一**。
- **Rev.1 → Rev.2 の重要改訂点（デグレード防止の厳密化＋Media / Taxonomies 横断調査の反映）**:
  1. **【原則の明確化】「現状の単一 Pull に合わせる」のではなく「バッチ Pull が持つ完全な処理（正）を損なわずに単一 Pull へ引き上げる」方針を §2.0 に明文化**。
  2. **【デグレード防止 ①】`pullBatch` における `RemoteStorageKeyIndex` 走査・`collectLocalMediaMirrorCandidates(mediaDir)`（`media/*.yaml` 全件パース）の 1 回実行保証と `batchResult.media` 返却互換性の完全維持**:
     - Rev.1 のまま各 `pullArticle` 内で個別に `mirrorReferencedAssetsFromIndex` を呼ぶと、`media/*.yaml` 全件のディスク走査が記事数 $N$ 回（例: 60 回）重複実行される I/O 劣化や、複数記事で共有される画像の `downloaded` / `skipped` 重複カウント、画像 0 件バッチ時に `batchResult.media` が `undefined` になる出力デグレードが発生する。
     - Rev.2 では **共有コンテキスト `MediaMirrorSession`** を導入し、`pullBatch` 時はリモート索引走査もローカル `media/*.yaml` 走査も **バッチ全体で 1 回のみ** 実行し、かつ記事に画像が 0 件でも従来どおり `batchResult.media`（`walkedCount`, `mirrored: 0` 等）を返す完全互換設計に修正。
  3. **【デグレード防止 ②】ローカルミラー短絡判定における `media_state` / `.yaml` 欠落防止（Push 時 `LOCAL_IMAGE_DETECTED` 誤発火の防止）**:
     - 単一 Pull で「バイナリファイルだけが存在し companion `.yaml` や `media_state` DB レコードがない状態」でネットワーク通信をスキップして `../../media/<storageKey>` に書き換えると、直後の `emit push` で Preflight Guard が `LOCAL_IMAGE_DETECTED` エラーでブロックするデグレードが起きる。
     - Rev.2 では、リモート走査を省略できる「ローカル完全ミラー済み」の条件を **「バイナリ実在 ＋（`media_state` DB 登録済み または companion `.yaml` 実在）」** に厳密化し、バイナリのみの場合はリモートからメタデータを取得して `.yaml` と `media_state` を確実に補完する設計に修正。
  4. **【デグレード防止 ③】Fast-Path return 時の `updateConfigSyncedVersion` 欠落修正と、単一 Pull 時の `--media`（`includeMedia`）・タクソノミー結果通知の対称化**:
     - `pullBatch` では全記事 skip 時でも末尾で `updateConfigSyncedVersion` が呼ばれる一方、`pullArticle` の Fast-Path（`tryFastPathOrHeal`）では呼ばれていなかった欠落を修正。
     - 単一 Pull 時に `--media` / `includeMedia: true` が無言無視されていた問題と、`pullTaxonomies` の失敗警告が `.catch(() => null)` で握り潰されていた問題を解消。
  5. **【Media / Taxonomies 横断調査の反映（発見 ⑥・⑦）】**:
     - **Media（発見 ⑥）**: 単一アイテム保存関数 `syncSingleMediaItem` は全経路で共通化されている一方、単一記事メディア取得 `pullArticleMedia`（`emit pull-media -a <id>`、`src/sync/media/pull_article.ts:149-186`）が旧式の「本文 ULID を `GET /_emdash/api/media/{id}` に投げて 404 になる実装」のまま取り残されており、移行記事（D1 `id` $\neq$ R2 `storageKey`）の本文画像をダウンロードできない問題、および `pullMedia({ storageKeys })`（`src/sync/media/pull_library.ts:52-72`）が `mirrorReferencedAssetsFromIndex` を使わず独自ループでフォールバック解決を欠いている問題を特定し、P2 に統合。
     - **Taxonomies（発見 ⑦）**: `pullTaxonomies` 自体は単一・バッチ共通だが、`pullBatch`（`src/sync/orchestrator.ts:174, 229`）が `PullOptions.candidates`（`loadLocalTaxonomyCandidates`）を渡しておらず、`categories/*.yaml`・`tags/*.yaml` の全件読み込みが記事数 $N$ 回重複実行されていた I/O 無駄を特定し、バッチ冒頭 1 回読み込み・注入に修正。

---

## 0. エグゼクティブサマリー

現状の Emit（`v0.1.28`）は、**バッチ Pull（`pullBatch`）側には正しい完全な同期パイプラインが実装されている一方、単一記事 Pull（`pullArticle` および CLI/MCP の単一記事分岐）には複数の処理ステージが欠落している状態**にある。

単純に「現状の不完全な単一記事 Pull を N 回回すだけ」にしたり、逆に「バッチの後処理を素朴に `pullArticle` の中へ移動するだけ」にすると、バッチ Pull が現在備えている **パフォーマンス特性（1 回のメディア一覧走査、1 回のローカル companion YAML 走査、0-GET 公開記事スキップ）** や **出力・統計の正確性（ユニークなメディア集計、常時 `batchResult.media` 返却）** が劣化するデグレードが発生する。

本計画（Rev.2）では、まずバッチ Pull と単一記事 Pull の全差分を洗い出し、**バッチ Pull の既存挙動・性能・出力を 1 ミリも劣化させないこと（Non-Degradation Invariant）** を絶対条件として、単一記事 Pull に欠落している機能を補完・統合する。

### 実コードで特定した 7 つの問題（発見 ①〜⑦）

1. **【発見 ①】単一記事 Pull（`emit pull <id>` / `sync_pull(id/filePath)`）にメディアミラーリング処理が欠落しており、`pullBatch` 側で 2 パス目の事後書き換えを行っていた非対称**
   - `src/sync/pull/index.ts:324-328` の `pullArticle` は、自身の処理内でメディアのミラーリングを行わず、その時点で既に `media/` に存在するファイルだけを対象に `localizeDiskMarkdown` を呼んでディスクへ書き出す。
   - 一方、`src/sync/orchestrator.ts:308-381` の `pullBatch` は、全記事に対して `pullArticle` を実行した**後**に `collectRemoteStorageKeys` → `mirrorReferencedAssetsFromIndex` を実行し、さらに `:346-370` で**全記事の Markdown をディスクから再読み込み・`localizeArticleMediaRefs` で再変換・ディスクへ二度目の上書き・`retrackLocalHashOnly` でハッシュ再追跡**を行っている。
   - このため、単一記事 Pull を実行すると参照画像が `media/` にダウンロードされず、ローカル Markdown 内の画像記法がリモート URL（`/_emdash/api/media/file/<storageKey>`）のまま残る。
2. **【発見 ②】Frontmatter `featuredImage`（アイキャッチ画像）がバッチ Pull・単一記事 Pull の双方でミラーリング対象から漏れている**
   - `src/sync/orchestrator.ts:323` は `collectArticleStorageKeys(fs.readFileSync(fullPath, 'utf8'))` のみを収集している。`collectArticleStorageKeys`（`src/sync/media/body_scan.ts:116-148`）は `/_emdash/api/media/file/<storageKey>` 形式の本文 URL のみを抽出し、Frontmatter の `featuredImage: "<26文字の MediaRecordId ULID>"` を走査しない。
3. **【発見 ③】CLI `emit pull [id]` がファイルパス指定（`posts/draft/...`）を受け付けず、そのまま API URL に埋め込んで 404/400 エラーになる**
   - MCP `sync_pull`（`src/mcp/tools/sync-pull.ts:104-108`）、`emit diff`、`emit delete` はいずれも `resolveArticleTarget` を通じて `id`（ULID）と `filePath` の双方向解決に対応しているが、CLI `emit pull [id]`（`src/cli/commands/pull.ts:128, 304`）のみが引数を生のまま `pullArticle(collection, id, ...)` に渡している。
4. **【発見 ④】単一記事 Pull における周辺処理の欠落（`--media` 無言無視・タクソノミー失敗警告の握り潰し・Fast-Path 時の `updateConfigSyncedVersion` 欠落）**
   - `src/cli/commands/pull.ts:162, 275` および `src/mcp/tools/sync-pull.ts:150-154` において、`--media`（MCP `includeMedia: true`）はバッチ分岐の内部でのみ評価され、単一記事モードでは無言で無視される。またオンデマンドメディア取得をスキップする `--no-media`（MCP `noMedia: true`）が存在しない。
   - 単一記事モードの `pullTaxonomies`（`pull.ts:297-302`, `sync-pull.ts:114-119`）は `.catch(() => null)` で失敗警告を握り潰している。
   - `pullArticle` の Fast-Path（`src/sync/pull/fast_path.ts`）で早期リターンした際、`updateConfigSyncedVersion(options.workspaceRoot)` が呼ばれない（`pullBatch` は `:383` で必ず呼ぶ）。
5. **【発見 ⑤】単一記事 Pull における Byline（著者）キャッシュの部分陳腐化バグ**
   - `pullBatch`（`src/sync/orchestrator.ts:116-122`）は冒頭で毎回 `syncRemoteBylines` を呼んで最新化するが、`pullArticle`（`src/sync/pull/index.ts:121-137`）は `Object.keys(cachedMaps.idToSlug).length > 0` しか判定しないため、ワークスペース作成後に追加された新規著者が単一記事 Pull では解決されない。
6. **【発見 ⑥】Media 専用コマンドにおける単一指定 vs バッチの乖離（`pullArticleMedia` の旧式 ID 空間検索と `pullMedia({ storageKeys })` の重複ループ）**
   - 個々のメディア保存プリミティブ `syncSingleMediaItem`（`src/sync/media/mirror_item.ts:19`）自体は全経路から共通呼び出しされている。
   - しかし、`emit pull-media --article <id>` が呼ぶ `pullArticleMedia`（`src/sync/media/pull_article.ts:149-186`）は、`pullBatch` が `v0.1.24` で `collectRemoteStorageKeys` + `mirrorReferencedAssetsFromIndex`（`storageKey` 索引方式）へ移行した際に取り残されており、いまだに本文の `/_emdash/api/media/file/<storageKey>` から ULID を抜いて `GET /_emdash/api/media/{id}`（D1 主キー検索）に投げている。このため移行記事（D1 `id` $\neq$ R2 `storageKey`）に対して `emit pull-media -a <id>` を実行すると未ミラーの本文画像が 404 となり、1 枚もダウンロードできず `orphanStorageKeys` 扱いになる。
   - また、`emit pull-media --storage-key <key>`（`src/sync/media/pull_library.ts:52-72`）も `mirrorReferencedAssetsFromIndex` を呼ばずに独自のインラインループを書いており、`recordsById` フォールバックや `verifiedStorageKeys` 判定が欠落している。
7. **【発見 ⑦】Taxonomies（カテゴリ・タグ）候補の `pullBatch` → `pullArticle` 受け渡し漏れによる $N$ 回重複ディスク読み込み**
   - `pullTaxonomies`（`src/sync/taxonomies.ts:177`）自体は単一・バッチ共通の単一関数で問題ないが、`pullBatch`（`src/sync/orchestrator.ts:174, 229`）が `PullOptions.candidates`（`loadLocalTaxonomyCandidates`）を `isLocalFileUnmodified` と `pullArticle` に渡していないため、バッチ Pull 中に記事数 $N$ 回（例: 60 回）にわたって `categories/*.yaml`・`tags/*.yaml` 全件のディスク読み込み＆YAML パースが重複実行されている。

---

## 1. 対応スコープ一覧と優先度マトリクス

| ID     | 優先度       | 対象領域                                                                   | 概要                                                                                                                                                 | 種別                     |
| ------ | ------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **P1** | **Critical** | `src/sync/pull/media_stage.ts`（新設）, `pull/index.ts`, `orchestrator.ts` | `MediaMirrorSession` による単一・バッチ共通の参照メディア同時ミラーリング（1 パスでの相対パス化）と、バッチ Pull の無劣化・I/O 1 回保証              | 機能追加 + 構造統一      |
| **P2** | **High**     | `src/sync/pull/media_stage.ts`, `src/sync/media/pull_article.ts`           | 本文 `storageKey` に加え、Frontmatter `featuredImage`（D1 `MediaRecordId` ULID）を単一・バッチ Pull 双方で同時ミラーリング（`media-id-spaces` 準拠） | 機能欠落修正             |
| **P3** | **High**     | `src/sync/pull/fast_path.ts`                                               | Fast-Path（リモート `_rev` 未変更時）における未ミラー画像の補完ミラーリング・相対パス自己修復、および `updateConfigSyncedVersion` 呼び出し保証       | 自己修復 + 欠落補完      |
| **P4** | **Medium**   | `src/cli/commands/pull.ts`, `src/mcp/tools/sync-pull.ts`, `diff.ts`        | CLI `emit pull [target]` の `id` / `filePath` 両対応、`--no-media` / `noMedia` 追加、単一 Pull での `--media`・タクソノミー警告・メディア統計表示    | CLI/MCP 対称化           |
| **P5** | **Low-Med**  | `src/sync/pull/index.ts`, `src/client/mapper.ts`                           | 単一記事 Pull 時における未知の Byline ID 検出時のオンデマンド `syncRemoteBylines` 再取得（発見 ⑤）                                                   | キャッシュ陳腐化バグ修正 |

---

## 2. 各項目の詳細設計（コード照合・デグレード防止検証済み）

### 2.0 バッチ Pull と単一記事 Pull の全差分対照表とデグレード防止設計（Rev.2 新設）

単一記事 Pull とバッチ Pull を統合するにあたり、現行のバッチ Pull が備えている正しい挙動が一切損なわれないよう、全 9 項目の不変条件を以下に定義する。

| #     | 機能・不変条件                                                                              | 現行のバッチ Pull（正）                                                                                               | 現行の単一記事 Pull（欠落あり）                                                                                                  | 素朴な統合で起きるデグレードリスク                                                                                                                                       | **Rev.3 における解決・非デグレード保証**                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | **公開済み記事の 0-GET Invariant**                                                          | `listRemoteArticles` の `rawItem` を `pullArticle` に渡し、`draftRevisionId === null` の公開記事は個別 GET を行わない | `rawItem` なしのため `GET /posts/{id}` を 1 回実行                                                                               | バッチを「ID だけ取って `pullArticle` を呼ぶ」形にすると N 回の GET が発生                                                                                               | `pullBatch` は従来通り `listRemoteArticles` で取得した `rawItem` を `pullArticle` に注入し、**0-GET Invariant を 100% 維持**                                                               |
| **2** | **ウィンドウ外 Prune と未プッシュ編集保護**                                                 | `candidatesToPrune` を算出し、`!isLocalFileUnmodified` があれば `SyncPruneConflictError` で中断、なければ削除         | 単一指定のためウィンドウ概念なし（404 時は `handleRemoteDeletedArticle`）                                                        | 単一 Pull の単純ループに置き換えるとウィンドウ外 Prune が消滅                                                                                                            | `pullBatch` のスライディングウィンドウ Prune 保護・削除ロジック（`orchestrator.ts:134-301`）はバッチオーケストレータの責務として**完全維持**                                               |
| **3** | **リモートメディア一覧走査（`collectRemoteStorageKeys`）の回数と `batchResult.media` 返却** | `mediaSync !== false` のときバッチ全体で **1 回**走査し、画像 0 件でも常に `batchResult.media` を返す                 | **未実装（0 回）**                                                                                                               | ① 各記事で走査すると最大 N 回 API を叩く<br>② 参照 0 件時に走査しないと `batchResult.media` が `undefined` になり CLI/MCP 出力が変わる                                   | **`MediaMirrorSession`** を `pullBatch` で生成して全ワーカーに共有。バッチ時は `results.some(r => !r.deleted)` なら従来通り **1 回だけ**走査して常に `batchResult.media` を返す            |
| **4** | **ローカル `media/*.yaml` 走査（`collectLocalMediaMirrorCandidates`）の回数と集計重複排除** | バッチ全体で **1 回だけ** `media/*.yaml` をパースし、ユニークな `Set<string>` で `downloaded` / `skipped` を集計      | **未実装**                                                                                                                       | 各記事の `pullArticle` 内で毎回 `collectLocalMediaMirrorCandidates` を呼ぶと、60 記事 × 数百 YAML のディスク I/O が発生し、共有画像の `skipped` 等が重複加算される       | `MediaMirrorSession` が `localMirrorCandidates` キャッシュと処理済みアセット Map（`processedAssets`）を保持。バッチ全体で **YAML 走査 1 回・各アセットの処理 1 回・重複カウント 0** を保証 |
| **5** | **ローカルミラー済み短絡時の `media_state` / `local_content_hash` 整合性**                  | 常に `syncSingleMediaItem` を通るため `.yaml` と `cache.saveMediaState` が確実に記録される                            | バイナリがあれば相対パス化するが `.yaml` / `media_state` は作られない                                                            | ① バイナリ存在のみで短絡すると直後の `emit push` が `LOCAL_IMAGE_DETECTED` で失敗する<br>② `.yaml` のみで短絡すると `media_state` や `local_content_hash` が不整合になる | 0-HTTP 短絡条件と `saveMediaState` Upsert 規約を **§2 P1 Step 2（正本）** に定義（`mediaRecordIdForStem` による `id:` 必須化＋実測 SHA-256 Upsert）                                        |
| **6** | **Byline（著者）マップの同期**                                                              | バッチ冒頭で `syncRemoteBylines` を **1 回**実行し `bylineMaps` を全記事に注入                                        | キャッシュが空のときしか `syncRemoteBylines` を呼ばず、新規追加著者が解決不能                                                    | `pullArticle` で毎回無条件に `syncRemoteBylines` を呼ぶとバッチで N 回通信する                                                                                           | バッチ時は従来通り冒頭 1 回で注入。単一 Pull 時は「キャッシュが空」または「記事内の byline ID にキャッシュ未登録 ID があるとき」のみ **オンデマンドで 1 回**同期                           |
| **7** | **`updateConfigSyncedVersion` と CLI/MCP 周辺処理**                                         | 全記事 skip 時も `updateConfigSyncedVersion` を実行。タクソノミー警告・`--media` 追加取得を実行                       | Fast-Path return 時に `updateConfigSyncedVersion` 未実行。`--media` 無視、タクソノミー失敗警告を `.catch(() => null)` で握り潰し | バッチは正常だが単一 Pull 時だけ config バージョン更新や `--media` が動かない                                                                                            | Fast-Path でも `updateConfigSyncedVersion` を実行し、CLI/MCP 単一 Pull でもタクソノミー失敗警告・`--media`（`includeMedia`）をバッチと完全対称に実行                                       |
| **8** | **Taxonomies 候補（`categories/*.yaml`, `tags/*.yaml`）の読み込み回数**                     | `PullOptions.candidates` が未指定のため、実は各記事で毎回 `loadLocalTaxonomyCandidates` を呼んでいた（$N$ 回重複）    | `pullArticle` 内で 1 回 `loadLocalTaxonomyCandidates` を呼ぶ                                                                     | バッチ側で `candidates` を事前共有しないと 60 記事で 60 回 YAML ディレクトリを走査し続ける                                                                               | `pullBatch` 冒頭で `loadLocalTaxonomyCandidates(workspaceRoot)` を **1 回だけ** 読み込み、`isLocalFileUnmodified` と全 `pullArticle` に注入                                                |
| **9** | **Media 単体コマンド（`pull-media -a <id>` / `--storage-key`）**                            | `pullBatch` は `collectRemoteStorageKeys` + `mirrorReferencedAssetsFromIndex` で `storageKey` を解決                  | `pullArticleMedia` は本文 ULID を `GET /media/{id}` に投げて 404 になり、移行記事の本文画像を DL できない                        | `emit pull <id>` だけ直しても `emit pull-media -a <id>` や `--storage-key` に旧ロジック・重複ループが残る                                                                | `pullArticleMedia`（未解決 `storageKey` がある場合は `collectRemoteStorageKeys` + `mirrorReferencedAssetsFromIndex` で解決）と `pullMedia({ storageKeys })` も同一の解決基盤に統一         |

---

### P1 & P2（Critical / High）— `src/sync/pull/media_stage.ts`（`MediaMirrorSession`）の新設と 1 パス完結化

#### 1. レイヤリング準拠のモジュール配置

`push/` パイプラインが `src/sync/push/media_stage.ts` を持つのと完全に対称な構造として、`src/sync/pull/media_stage.ts` を新設する。
[tests/layering.test.ts](../../tests/layering.test.ts)（`:248-252`）の `ALLOWED_LAYER_2_SIBLING_IMPORTS` に `'sync/pull/media_stage.ts': new Set(['../media.js'])` を登録する。

#### 2. `MediaMirrorSession` による単一／バッチのシームレスな共有設計

`src/sync/pull/media_stage.ts` に **`MediaMirrorSession`** を定義する。

- **`pullBatch` から呼ばれる場合**:
  - `pullBatch` の冒頭で 1 つの `MediaMirrorSession` インスタンスを生成し、各ワーカーの `pullArticle(..., { mediaSession })` に渡す。
  - `MediaMirrorSession` は以下を単一インスタンス内でメモ化・一元管理する：
    1. `getRemoteIndex()`: `collectRemoteStorageKeys` の `Promise<RemoteStorageKeyIndex>` をメモ化し、複数ワーカーから同時に呼ばれてもリモート走査は **必ず 1 回のみ** 実行する。
    2. `getLocalCandidates()`: `collectLocalMediaMirrorCandidates(mediaDir)` の結果をメモ化し、`media/*.yaml` のディスク走査を **必ず 1 回のみ** 実行する。
    3. `inFlightAssets`: `Map<string, Promise<AssetMirrorOutcome>>` により、同じ `storageKey` または `featuredImage` (`MediaRecordId`) を複数記事が同時に参照していても、`syncSingleMediaItem` の実行・ダウンロードを **1 回のみ** に合流させ、セッション全体の集計（`downloaded`, `skipped`, `mirroredStorageKeys`, `verifiedStorageKeys`, `orphanStorageKeys`）に重複なく記録する。
  - バッチ内の全 `pullArticle` 完了後、もしバッチ内の全記事に画像参照が 1 件もなかった場合でも、`options.mediaSync !== false && results.some((r) => !r.deleted)` であれば `await mediaSession.finalizeBatchMediaResult()` がリモート索引を 1 回確認して従来と完全同一の `PullBatchResult['media']` を返す（**既存の全バッチテスト・CLI/MCP 出力と 100% 互換**）。
- **`pullArticle` が単体で呼ばれる場合**:
  - `options.mediaSession` が渡されていない場合は、その記事専用の `MediaMirrorSession` を内部で自動生成する。

#### 3. 2 つのメディア ID 空間（`docs/media-id-spaces.md`）に準拠した 3 段階解決アルゴリズム

`pullArticle`（`src/sync/pull/index.ts:323`、`localizeDiskMarkdown` の直前）において、`options.mediaSync !== false` のときに `mirrorArticleReferencedMedia` を呼び出す：

1. **Step 1：記事からの参照抽出（0 ネットワーク通信）**:
   - **本文 `storageKey` 群**: `collectArticleStorageKeys(canonicalMarkdown)` により `/_emdash/api/media/file/<storageKey>` から `storageKey` セットを抽出する。
   - **Frontmatter `featuredImage`（`MediaRecordId`）**: `extractMediaUlid(frontmatter.featuredImage)` により 26 文字正規 ULID を抽出する。
   - **早期リターン ①**: 本文 `storageKey` が 0 件かつ `featuredImage` ULID も存在しない場合、**HTTP リクエストを一切行わず即座に完了する**。

2. **Step 2：単一記事 Pull 時のローカルミラー確認と `media_state` ハッシュ整合補完（安全な 0-HTTP 短絡最適化 — 正本仕様）**:
   - 単一記事 Pull（外部 `mediaSession` なし）の場合、各参照アセットが既にローカルで完全にミラー済みかを検査する：
     - **完全ミラー済み（0-HTTP 短絡）成立条件**:
       1. `media/<markdownRef>.<ext>` のバイナリファイルがディスク上に実在すること。
       2. `cache.getMediaStateByStorageKey(storageKey)`（`featuredImage` の場合は `cache.getMediaStateByMediaId(mediaId)`）にレコードが存在するか、または companion `.yaml` が実在し **`mediaRecordIdForStem(mediaDir, stem)` によって companion 内の `id:` から 26 文字正規 ULID（`mediaId`）が確定できること**。
          - **重要（実測制約）**: `saveMediaState` は `storage_key` を PRIMARY KEY とし、`media_id = excluded.media_id` を `COALESCE` で保護しない（`src/db/cache.ts:576-588`）。また `collectLocalMediaMirrorCandidates()`（`src/sync/media/companions.ts:98-100`）は `doc.id` が無い場合にファイル名接頭辞（`idMatch`）へフォールバックしてしまうため、Upsert 用の `mediaId` 取得には必ず `mediaRecordIdForStem()`（companion の `id:` のみを信頼し、ファイル名推測を禁止する AGENTS.md §7 準拠ヘルパー）を使用する。**companion に有効な `id:` が無いキーは Step 2 で短絡させず、必ず Step 3（リモート解決）へ進める**。
       3. companion `.yaml` に数値の `size` が記録されている場合はローカルバイナリの `fs.statSync(binaryPath).size === doc.size` であること（不一致の場合は破損・未完了とみなして短絡せず Step 3 へ進める。なお Step 2 は 0-HTTP のため、**remote record の `size` との突合自体は Step 3 の `syncSingleMediaItem`（`src/sync/media/mirror_item.ts:118, 128-134`）が担う**）。
     - **短絡時の `media_state`（`mediaId` / `local_content_hash` / `remote_record_ref`）Upsert**:
       - 上記条件を満たして短絡が成立した際、`media_state` にレコードが未登録の場合、または既存レコードの `localContentHash` が空／不一致の場合は、ローカルバイナリファイルの実測 SHA-256（`localContentHash`）を計算し、`media_state` へ Upsert する。
       - **Upsert 時の `mediaId` 確定優先順位**: `saveMediaState` の `ON CONFLICT(storage_key)` は `media_id = excluded.media_id` を無条件上書きするため、`mediaId` の取得元は **① 既存の `media_state` レコードが存在する場合はその `record.mediaId`（既存の正しい値をそのまま維持・再確認）／② companion のみなら `mediaRecordIdForStem(mediaDir, stem)`** とする。これにより、テスト fixture や既存レコードの `mediaId` 上書き事故を構造的に排除する。确定した `mediaId`・`storageKey`・`localHash: "media-record:<mediaId>"`・`remoteRecordRef: "media-record:<mediaId>"` とともに `cache.saveMediaState` へ保存する。これにより、[AGENTS.md](../../AGENTS.md) §7 の「`storageKey` 主キー＋コンテンツハッシュ分離設計」および後続 `emit push` の Preflight 検証と 100% 整合する。
     - すべての参照が「完全ミラー済み」であれば、リモート通信を一切行わずに `skipped` として即座に Step 3 をスキップし、`localizeDiskMarkdown` で `../../media/<storageKey>` に変換する。

3. **Step 3：未ミラー（またはメタデータ未登録）資産のリモート解決と非破壊フォールバック・警告義務**:
   - **ケース A：未ミラーの本文 `storageKey` が 1 件以上ある場合（またはバッチ `mediaSession` 共有時）**:
     - `session.getRemoteIndex()` で `RemoteStorageKeyIndex` を取得し、本文 `storageKey` 群を `mirrorReferencedAssetsFromIndex` ロジック（`session.inFlightAssets` で重複排除）により `media/` へミラーリングする。
     - `featuredImage` (`mediaId`) がある場合は、まず `index.recordsById.get(mediaId.toUpperCase())` からレコードを取得して `syncSingleMediaItem` でミラーリングする（追加の個別 GET 不要）。`index.recordsById` にない場合のみ `GET /_emdash/api/media/{mediaId}` にフォールバックする。
   - **ケース B：本文 `storageKey` は 0 件（または全て完全ミラー済み）で、`featuredImage`（`mediaId`）のみが未ミラーの単一記事 Pull の場合**:
     - `featuredImage` は D1 主キー（`MediaRecordId`）であるため、ライブラリ一覧走査（`collectRemoteStorageKeys`）を行わず、`GET /_emdash/api/media/{mediaId}`（`mediaDetailEndpoint`）を **1 回だけ** 呼び出して `syncSingleMediaItem` で保存する。
   - **リモート取得失敗・未モック時の非破壊フォールバックと警告義務（リスク 2 対応）**:
     - Step 2 の短絡条件が成立しないケース（例：`tests/local_media_refs.test.ts:55, 83-129` のように `beforeEach` でバイナリのみを配置して `.yaml` と `media_state` を置かず、`fetchFn: vi.fn()` で `undefined` を返す単体テスト、または本番でメディア API が空応答・エラーを返した場合）では Step 3 のリモート取得が試行される。
     - このときリモート取得が失敗（`res` が falsy / 非 200 / 例外）した場合、記事本体の Pull は中断せず、以下の 2 段階で厳密に処理する：
       1. **ローカルにバイナリファイルすら存在しない未解決キー**: サイレントに無視することは禁止し、必ず `res.media.orphanStorageKeys`（`featuredImage` の場合は `unresolvedFeaturedImageId`）および `mediaFetchFailed: true` に記録し、CLI / MCP で `formatOrphanMediaWarning` による警告を出力する（認識論的規律の維持）。
       2. **ローカル `media/<storageKey>` にバイナリファイルが既に実在しているキー**: ローカル相対パス `../../media/<storageKey>` のリンク切れは起きないため `verifiedStorageKeys` に分類して `localizeDiskMarkdown` による相対パス化を許容する（これにより既存 615 テストのモック互換性を 100% 維持する）。
   - **直後の 1 パス相対パス化**:
     - ミラーリング完了直後に `pullArticle` の `:324` で `localizeDiskMarkdown(canonicalMarkdown, relPath, ...)` が実行されるため、`media/` に揃ったすべての画像が **初回書き込みの 1 パス目から `../../media/<storageKey>` としてディスクに書き出され、`commitArticleSnapshot` でそのハッシュが `sync_state.local_hash` に記録される**。
     - これにより、`src/sync/orchestrator.ts:346-370` にあった「全記事ファイルをディスクから再読み込みして書き直し、`retrackLocalHashOnly` を呼ぶ 2 パス目ループ」は完全に不要となり削除できる。

---

### P3（High）— Fast-Path（`src/sync/pull/fast_path.ts`）における未ミラー画像の補完・自己修復と `updateConfigSyncedVersion` 保証

1. **Fast-Path での未ミラー画像補完と相対パス自己修復（`src/sync/pull/fast_path.ts:163-228`）**:
   - `tryFastPathOrHeal` の `if (isUnmodified)` ブロック内において、`options.mediaSync !== false` の場合：
     - `currentDiskContent`（および `parsedCurrent.frontmatter.featuredImage`）に未ミラーのメディア参照があれば `mirrorArticleReferencedMedia` を実行して `media/` にダウンロードする。
     - その後、`options.localMediaRefs` が有効で `localizeDiskMarkdown(currentDiskContent, existingSync.localFilePath)` が `currentDiskContent` と異なる場合（過去に canonical URL のまま保存されていた記事が、今回ミラー完了によって `../../media/<storageKey>` に変換可能になった場合）：
       - ディスクへ書き込み、`retrackLocalHashOnly(options.cache, { id, diskContent: localizedDisk, touchSyncedAt: true })` で `sync_state.local_hash` を更新し、`updated: true, healed: true, meaningChanged: false` を返す。
     - 2 回目の実行では画像もミラー済み・本文も `../../media/<storageKey>` 済みのため、0 通信で `skipped: true, updated: false` となる。
2. **Fast-Path return 時の `updateConfigSyncedVersion(options.workspaceRoot)` 保証**:
   - `pullArticle`（`src/sync/pull/index.ts:187, 248`）で `tryFastPathOrHeal` が非 null を返してリターンする際にも `updateConfigSyncedVersion(options.workspaceRoot)` を呼び出し、バッチ Pull と同じく skip / heal 時でも `.emit/config.json` のバージョン記録が最新化されるようにする。

---

### P4（Medium）— CLI `emit pull [target]` の `filePath` 対応・`--no-media` / `--media` 対称化・タクソノミー警告表示

1. **CLI `emit pull [target]` の `id` / `filePath` 両対応（`src/cli/commands/pull.ts`, `src/sync/diff.ts`）**:
   - `src/sync/diff.ts:60-66` の `resolveArticleTarget` に、ファイル名から ULID が抽出できない場合でもファイルがディスクに実在すれば `parseMarkdown` で `frontmatter.id` を読み取るフォールバックを追加する。
   - `src/cli/commands/pull.ts:128, 294` で `.command('pull [target]')` とし、`resolveArticleTarget` を通じて `emit pull 01M6...` と `emit pull posts/draft/20261115_01M6...-slug.md` の両方を受け付ける。解決不能なパスが渡された場合は `ApiError`（`ARTICLE_TARGET_UNRESOLVED`, status 400）をスローする。
2. **`--no-media`（MCP `noMedia`）の追加と、単一記事モードでの `--media`（MCP `includeMedia`）対応**:
   - CLI `emit pull` に `--no-media`（参照メディアのオンデマンドミラーリングをスキップ）を追加する。
   - Commander.js で `--media` と `--no-media` が同一の `options.media` ブール値にマッピングされる仕様を考慮し、`process.argv`（または Commander の `getOptionValueSource` / 生引数検査）により以下を厳密に区別する：
     - デフォルト（どちらも未指定）: `mediaSync = !postsOnly`, `includeMedia = false`
     - `--no-media` 指定時: `mediaSync = false`, `includeMedia = false`
     - `--media` 指定時: `mediaSync = !postsOnly`, `includeMedia = true`（単一記事モードでも、記事 Pull 後にバッチと同じく `pullMedia({ limit: mediaSyncLimit })` を実行する）
   - MCP `sync_pull` にも `noMedia: z.boolean().optional()` を追加し、単一記事モードでも `includeMedia: true` 指定時は `pullMedia` を実行するようにしてバッチとの非対称を完全に解消する。
3. **単一記事モードでのタクソノミー同期エラー警告とメディア結果サマリの表示**:
   - 単一記事 Pull 時も `pullTaxonomies` の結果に `categoriesFailed` / `tagsFailed` があれば警告を表示する（握り潰し廃止）。
   - 単一記事 Pull で参照メディアのミラーリングが行われた場合（`res.media && res.media.total > 0`）、CLI / MCP 双方でミラーリング結果サマリと `orphanStorageKeys` 警告を出力する。

---

### P5（Low-Med）— 単一記事 Pull 時における未知の Byline ID オンデマンド再同期

- `src/sync/pull/index.ts:120-137, 253` において、`options.bylineIdToSlug` が外部（`pullBatch`）から注入されている場合はそのまま使用する（バッチ時は追加通信 0 回）。
- 単一記事 Pull で `options.bylineIdToSlug` が未注入の場合、`options.cache.getBylineMaps()` を取得した上で、`rawItem` 内の byline 参照 ID（`extractRemoteBylineIds(rawItem)`）の中に `cachedMaps.idToSlug` に存在しない ID が 1 つでもある場合（またはキャッシュが空の場合）は `syncRemoteBylines` を呼び出してキャッシュを更新する。
  - **実測注記**: `extractRemoteBylineIds()` は**未存在のヘルパー**であり新規追加が必要（`src/client/mapper.ts:215-225` が読む raw 形 `bylines[].bylineId` / `bylines[].byline.id` / `bylines[].byline.slug` を走査して ULID 群を返す）。`apiResponseToLocal` は Layer 0（`src/client/mapper.ts`）なので、**Layer 1 の `src/sync/bylines.ts` に置くこと**（Layer 0 → Layer 1 方向の参照は不要、Layer 2 の `pull/index.ts` から参照する）。fast-path 経路（`tryFastPathOrHeal`）は rawItem の byline を再パースせずに済むため、**未知 ID 検出は full-pull 分岐のみ**で発火させ、T11 は「キャッシュ空 / 未知 ID あり」の 2 ケースに限定する。

---

## 3. アーキテクチャ・レイヤリング影響検証

| 新設・変更モジュール                                     | 所属レイヤー | Outbound Imports（依存先）                                                      | Inbound Consumers（利用元）                                                | Layering Gate（`tests/layering.test.ts`）への影響                                                                                      |
| -------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sync/pull/media_stage.ts`                           | **Layer 2**  | `node:fs`, `node:path`, Layer 0 (`client/`, `db/`, `utils/`), `../media.js`     | `src/sync/pull/index.ts`, `src/sync/pull/fast_path.ts`, `src/sync/pull.ts` | `ALLOWED_LAYER_2_SIBLING_IMPORTS` に `'sync/pull/media_stage.ts': new Set(['../media.js'])` を追加（`push/media_stage.ts` と完全対称） |
| `src/sync/pull/{index,fast_path,types}.ts`               | **Layer 2**  | Layer 0, Layer 1, `./media_stage.js`, `../workspace/index.js`                   | `src/sync/pull.ts`, `src/sync/orchestrator.ts`                             | すべて同一サブモジュール内または下位レイヤー参照のため違反 0 件                                                                        |
| `src/sync/orchestrator.ts`                               | **Layer 2**  | Layer 0, Layer 1, `./pull.js`, `./push.js`, `./media.js`                        | Layer 3 (`cli/`, `mcp/`)                                                   | 2 パス目の `localizeArticleMediaRefs` / `retrackLocalHashOnly` ループが消滅し、`MediaMirrorSession` 共有で 1 パス完結                  |
| `src/cli/commands/pull.ts`, `src/mcp/tools/sync-pull.ts` | **Layer 3**  | Layer 0, Layer 1 (`diff.ts`), Layer 2 public API (`pull.ts`, `orchestrator.ts`) | エントリポイント                                                           | Axis 2（Layer 2 allowlist）・Axis 3（CLI/MCP 分離）に完全準拠                                                                          |

---

## 4. テスト計画

既存の 59 テストファイル（615 tests）の全通過に加え、以下の検証テストを新設・拡張する。

1. **単一記事 Pull における参照メディア自動同時ミラーリング検証（`tests/local_media_refs.test.ts` 拡張）**:
   - **T1（初回単一記事 Pull・本文画像＋`featuredImage` 同時解決と直後の Push 成功保証）**: `media/` が空の状態で、本文に `/_emdash/api/media/file/<storageKey>`・Frontmatter に `featuredImage: "<mediaId>"` を持つ記事を `pullArticle(..., { localMediaRefs: true })` で Pull した際：
     - 1 回の `pullArticle` で両方のバイナリと `.yaml` が `media/` に保存され、`media_state` に登録されること。
     - ディスク上の Markdown 本文が即座に `../../media/<storageKey>` になり、`base_snapshots` は canonical URL を維持し、`getWorkspaceStatus` が `synced: 1, modified: 0`、`inspectArticleDiff` が `hasChanges: false` を返すこと。
     - さらにその記事の本文を編集して `pushArticle` を実行した際、`LOCAL_IMAGE_DETECTED` ガードに阻まれず正常に Push できること（デグレード防止 ② の検証）。
   - **T2（`featuredImage` のみを持つ記事の 1-GET 最適化検証）**: 本文画像を持たず未ミラーの `featuredImage: "<mediaId>"` のみを持つ記事を単一 Pull した際、`/api/media?`（一覧走査）を呼ばずに `GET /_emdash/api/media/<mediaId>` の単一 GET のみでミラーリングが完了すること。
   - **T3（完全ミラー済み時の 0-HTTP 短絡・`media_state` ハッシュ補完と、バイナリのみ存在時のメタデータ補完検証 — リスク 1 対応）**:
     - バイナリと `.yaml`（有効な `id:` あり）が揃っている状態で単一 Pull した際、メディア API への HTTP リクエストが 0 回であり、かつ `media_state` に Upsert された `mediaId` が companion の `id:` と一致し、実測 SHA-256（`localContentHash`）と `remoteRecordRef` が記録されること（なお companion に `id:` が無い場合は短絡せず Step 3 へ進むこと）。
     - バイナリのみが存在し `.yaml` と `media_state` が欠落している状態で単一 Pull（リモート API 応答あり）した際、バイナリの再ダウンロードはスキップ（`skipped: 1`）しつつ `.yaml` と `media_state` が補完生成されること。
   - **T4（Fast-Path 補完ミラーリングとべき等性検証）**: 過去に画像未ミラー・canonical URL のままキャッシュされた記事（リモート `_rev` 同一）に対して `--force` なしで `pullArticle` を実行した際、1 回目で未ミラー画像が取得されて `../../media/<storageKey>` に自己修復（`updated: true, healed: true`）され、続く 2 回目の `pullArticle` では 0 メディア通信で `skipped: true, updated: false` になること。
   - **T5（`mediaSync: false` / `--no-media` スキップ検証）**: `mediaSync: false` 指定時は単一記事 Pull でもメディア通信が一切行われず、canonical URL のまま保存されること。
   - **T6（リモート 404 / 空応答時の非破壊フォールバックと警告義務検証 — リスク 2 対応）**:
     - 本文の `storageKey` がリモートに存在しない（またはメディア API が空応答・エラーを返し、かつローカルにバイナリも存在しない）場合、記事 Markdown 自体の保存は成功しつつ、該当画像が canonical URL のまま維持され、**必ず `res.media.orphanStorageKeys` / `unresolvedFeaturedImageId` に記録されて `formatOrphanMediaWarning` の警告が出力されること**（サイレント無視の禁止）。
2. **バッチ Pull の非デグレード保証・`featuredImage` ミラーリング・並列重複排除検証（`tests/sync.test.ts` 拡張 — リスク 3 対応：1 ページ完結モック＋走査 1 回 assert）**:
   - **T7（`featuredImage` のバッチミラーリング）**: `pullBatch` で本文画像のない `featuredImage` 付き記事を Pull した際、共有 `RemoteStorageKeyIndex`（1 ページモック・`/api/media` 呼び出し 1 回）の `recordsById` から追加の個別 ID GET なしで `featuredImage` がミラーリングされること。
   - **T8（複数記事での同一画像共有時の 1 回処理・統計正確性保証 — デグレード防止 ①）**: `pullBatch`（`concurrency: 4`）で複数記事が同一の `storageKey` を参照している際、`/api/media` 一覧走査が 1 回・バイナリの HTTP GET が 1 回のみ実行され、`batchResult.media.downloaded` が重複カウントされず `1` となり、全記事のディスク表記が `../../media/<storageKey>` になること。
   - **T9（画像 0 件バッチ時の `batchResult.media` 返却互換性保証 — デグレード防止 ①）**: 画像を持たない記事のみの `pullBatch`（`mediaSync` デフォルト ON、1 ページ空モック）でも従来通り `batchResult.media` が定義され（`downloaded: 0, mirroredStorageKeys: []`）、既存挙動と完全一致すること。
3. **CLI `emit pull [target]` の `filePath` 解決 & MCP `sync_pull` 対称性テスト（`tests/cli.test.ts` / `tests/mcp.test.ts` 拡張）**:
   - **T10**: `emit pull posts/draft/20261115_<ulid>-slug.md` のようにファイルパスを渡した際に ULID が正しく解決されること、および解決不能なパスを渡した際に `ARTICLE_TARGET_UNRESOLVED` エラーが整形表示されること。
   - **T11**: 単一記事 Pull 時に未知の Byline ID が含まれている場合、自動的に `syncRemoteBylines` が呼ばれて Frontmatter の `bylines` に正しい著者スラッグが出力されること。

---

## 5. 実装ステップ（4 フェーズ）

1. **Step 1（P1 & P2: `src/sync/pull/media_stage.ts` 新設と `tests/layering.test.ts` 更新）**:
   - `src/sync/pull/types.ts` に `PullArticleMediaSummary`、`MediaMirrorSession` インターフェース、および `PullOptions` 拡張フィールドを追加。
   - `src/sync/pull/media_stage.ts` を実装（`MediaMirrorSession` によるリモート索引・ローカル `.yaml` 候補の 1 回走査メモ化、本文 `storageKey` + Frontmatter `featuredImage` 抽出、完全ミラー済み短絡判定と `media_state` ハッシュ Upsert、並列 In-Flight 重複排除）。
   - `tests/layering.test.ts` の `ALLOWED_LAYER_2_SIBLING_IMPORTS` に `'sync/pull/media_stage.ts': new Set(['../media.js'])` を登録。
2. **Step 2（P1, P3, P5: `pullArticle` / `tryFastPathOrHeal` / `pullBatch` の統合と 2 パス目ループ廃止）**:
   - `src/sync/pull/index.ts` に `mirrorArticleReferencedMedia`（`localizeDiskMarkdown` の直前）、Fast-Path return 時の `updateConfigSyncedVersion`、および未知の Byline ID 検出時の `syncRemoteBylines` 再取得を組み込む。
   - `src/sync/pull/fast_path.ts` に未ミラー画像補完・未ローカル化 URL の 1 ステップ修復を組み込む。
   - `src/sync/orchestrator.ts` の `pullBatch` に `MediaMirrorSession` 注入を追加し、`:346-370` の 2 パス目ディスク再書き換えループを削除して `mediaSession.finalizeBatchMediaResult()` に置き換える。
   - **注意（実測）**: `src/sync/orchestrator.ts` 内には現在 `loadLocalTaxonomyCandidates` の呼び出しが 0 箇所であり、`:174`（`isLocalFileUnmodified`）と `:229`（`pullArticle`）の双方に `candidates` が渡されていない。そのため `pullBatch` の冒頭（`:124` 付近）で `const candidates = loadLocalTaxonomyCandidates(options.workspaceRoot);` を 1 回だけ呼び出し、`:174` と `:229` の双方に注入する。
3. **Step 3（P4: CLI `emit pull` / MCP `sync_pull` / `resolveArticleTarget` の対称化）**:
   - `src/sync/diff.ts` の `resolveArticleTarget` にディスク上の Frontmatter `id` フォールバックを追加。
   - `src/cli/commands/pull.ts` で `[target]` の `id` / `filePath` 解決、`--no-media` と `--media` の厳密な分離と単一記事モードでの `--media` 対応、タクソノミー失敗警告表示、単一記事メディア結果サマリ・orphan 警告表示を実装。
   - `src/mcp/tools/sync-pull.ts` に `noMedia` オプション追加、単一記事モードでの `includeMedia`・タクソノミー警告・メディア結果サマリ出力を実装。
4. **Step 4（テスト追加・ドキュメント更新・全ゲート検証）**:
   - T1〜T11 の単体・結合テストを追加し、`npm run check`（`tsc --noEmit` + `vitest run` + `prettier --check`）を実行。
   - `package.json`（`0.1.29`）、`CHANGELOG.md`、`AGENTS.md` を更新。
