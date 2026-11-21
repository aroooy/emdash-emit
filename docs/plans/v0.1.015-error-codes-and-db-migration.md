# v0.1.15 Refactor Plan（改訂版 v4）— 全 error code の網羅と DB 移行語義を確定させた現行仕様の再集計

**策定日**: 2026-11-12  
**対象リポジトリ**: `emdash-emit`（HEAD: `62ea48c` / `package.json` version `0.1.14`）  
**検証済み状態**: `npm run check` → **36 test files / 414 tests 全 green**  
**位置づけ**: **正式リリース前に向けた現行確定仕様のドキュメント再集計・正本化**。v3 までで判明した L6（ガード整合テスト）の集合設計と、R6（cache schema v5）の移行語義を実測に基づき確定させた版。

---

## 0. 基本方針（正式リリース前の再集計）

1. **履歴・弁明の排除**: 過去のコミット履歴や「誰が承認したか」といった経緯はドキュメントに含めず、**「現時点の確定仕様（Current Canonical Spec）」とその設計思想**をドキュメント（README / AGENTS.md / docs）に再集計・正本化する。
2. **確定仕様の定義**:
   - `postsSyncLimit: 30`（Cloudflare D1/Worker 環境制約および Staging Desk モデルに基づく確定規定値）
   - `localMediaRefs: default-ON`（記事相対パス `../../media/<storageKey>` 表記）
   - Local-first Media Pipeline（全ライブラリ JSON walk による索引構築 ＋ 参照バイナリのオンデマンド取得）
3. **実コード照合に基づく安全な設計**:
   - Guard Registry は **1 Guard : N Codes** の構造とし、ガードでも運用系でもない未知 code を検出するため、`src/` 全体の error code を **Guard / Operational / Protection の 3 集合で全分類**する（v3 までのは部分リストで、実測 44 code 中 12 件が未分類だった → §2 R1）。
   - DB スキーマ v5 移行は、アップロード復旧ルート（content-hash 検索）を維持し、インデックスと型（INTEGER）の整合性を確保したうえで、**storageKey が書き換わる pending→ready 遷移の語義変更と影響テスト 6 ファイル**を作業範囲として明示する（§2 R6）。

---

## 1. 整理対象の検出一覧（Detection Index）

| ID | 対象箇所 | 現状の不整合 | 是正方針（実コード完全整合の再集計） |
|---|---|---|---|
| **A-1** | `README.md` (147, 286, 666 行) | `postsSyncLimit` が一部で `100` と表記 | 正統値 **`30`** に統一 |
| **A-2** | `CHANGELOG.md` (15 行) | `localMediaRefs` が `(default false)` のまま | **`default-ON` / 記事相対パス** として再集計 |
| **A-3** | `README.md` / `AGENTS.md` | ガード番号体系の破綻・欠番・sub-code 未定義 | **G1〜G19 連番 ＋ 1:N sub-code 表** に整理しテストで保証 |
| **A-4** | `AGENTS.md` (§4) | ガード節内にアーキテクチャ不変条件が混在 | セクション見出しを分離し構造を整理 |
| **A-5** | `media.ts` (714-722 行) | コメント不整合および `local_hash` キー空間非対称 | コメント修正 ＋ **schema v5（列分離・PK再設計・復旧メソッド新設）** |
| **A-6** | `README.md` (672, 904 行) | `--media` オプションの説明が旧仕様のまま | local-first mirror（オンデマンド）と全取得の分担を明記 |
| **A-7** | `docs/` 配下ログ | `docs/v0112-eval/logs/` 内に追跡済みログ 9 件が残存 | **追跡済み 9 件を削除** ＋ `.gitignore` に `docs/**/logs/` 追加 |

---

## 2. タスク詳細（Task R1 〜 R6）

### R1 【P0・正本化】Guard Registry のコード一元化（1:N 型設計・G1〜G19 連番）

**目的**: ガード定義の正本をコード側に置き、`tests/guards.test.ts` で実コードと完全に整合させる。

#### 1. 型定義の設計（`src/sync/guards.ts`）
ガードの多対一関係（sub-code）、呼び出し層制約、および運用系 ApiError の除外リストを型として定義：

```ts
export type GuardStage = 'cli-mcp' | 'preflight' | 'push' | 'conflicts' | 'new';
export type GuardSeverity = 'error' | 'warning' | 'info';

export interface GuardMeta {
  id: number;
  name: string;
  /** Primary code and all associated sub-codes emitted by this guard. */
  codes: readonly string[];
  stage: GuardStage;
  severity: GuardSeverity;
  source: string;
  description: string;
}

/**
 * Operational ApiErrors (network, lock, HTTP transport, server reject). They are NOT guards:
 * they report a failed operation rather than a rejected authoring intent.
 * Enumerated exhaustively against `src/` so the rogue-code check in tests/guards.test.ts is total.
 */
export const OPERATIONAL_ERROR_CODES = [
  // push / publish transport
  'PUSH_CREATE_FAILED',
  'PUSH_FAILED',
  'PUSH_RETRY_FAILED',
  'PUBLISH_FAILED',
  'UNPUBLISH_FAILED',
  'REMOTE_ARTICLE_DELETED',
  'CONFLICT_REMOTE_FETCH_FAILED',
  // taxonomy transport (push.ts / taxonomies.ts)
  'TAXONOMY_UPDATE_FAILED',
  'TAXONOMY_DIVERGENCE',
  'TAXONOMY_UNION_REJECTED',
  'TAXONOMY_FETCH_FAILED',
  // lock lease (client/lock.ts, thrown as EntryLockError('ENTRY_LOCKED'))
  'ENTRY_LOCKED',
  // media upload transport (client/media.ts)
  'MEDIA_UPLOAD_URL_FAILED',
  'MEDIA_BINARY_UPLOAD_FAILED',
  'MEDIA_CONFIRM_FAILED',
  'MEDIA_NOT_READY',
  // list / fetch failures
  'ARTICLE_LIST_FAILED',
  'ARTICLE_PULL_FAILED',
  'ARTICLE_NOT_FOUND',
  'MEDIA_LIST_FAILED',
  'NETWORK_ERROR',
  // delete transport (sync/delete.ts)
  'REMOTE_DELETE_FAILED',
  'REMOTE_DELETE_UNCONFIRMED',
] as const;

/**
 * Standing protection errors raised by dedicated error classes rather than ApiError. They guard a
 * destructive operation but are not numbered preflight guards, so they live outside GUARD_REGISTRY.
 */
export const PROTECTION_ERROR_CODES = [
  'UNPUSHED_CHANGES_PROTECTION', // sync/delete.ts:32 (UnpushedModificationsError)
  'PUBLISHED_ARTICLE_PROTECTION', // sync/delete.ts:52 (PublishedArticleDeletionForbiddenError)
  'FRONTMATTER_PARSE_ERROR', // utils/frontmatter.ts:78 (FrontmatterParseError)
] as const;

export const GUARD_REGISTRY: readonly GuardMeta[] = [ ... ];
```

> **網羅性の根拠（実測）**: `src/` を走査すると error code は **44 件**（`code: '...'` 38 件 + `public (readonly )?code = '...'` 6 件）。
> v4 の 3 集合（Guard 20 / Operational 23 / Protection 3 = **ユニーク 46 件**）は **この 44 件を一つ残らず含む**（`comm -23` で差集合 0 を検証済み）。
> 46 = 44 + 2 の内訳: `SINGLE_TARGET_GUARD`（G1、README 由来の論理名で code として実在しない）と `LOCAL_IMAGE_AUTO_UPLOAD`（G11 primary label、警告接頭辞であって code ではない）。
> うち 2 件は三項演算子で生成されるため機械走査では抽出できない: `push.ts:167` の
> `code: isPublishing ? 'PUBLISH_FAILED' : 'UNPUBLISH_FAILED'` → テストの正規表現は **三項形式**（`code: [^?]*\? '[A-Z_]+' : '[A-Z]+'`）も拾うこと。
> v3 までの `OPERATIONAL_ERROR_CODES`（11 件）では **12 件が未分類**で、未知コード排除検査は必ず fail した。
> 未分類の内訳: `MEDIA_UPLOAD_URL_FAILED`, `MEDIA_BINARY_UPLOAD_FAILED`, `MEDIA_CONFIRM_FAILED`, `MEDIA_NOT_READY`,
> `ARTICLE_LIST_FAILED`, `ARTICLE_PULL_FAILED`, `ARTICLE_NOT_FOUND`, `MEDIA_LIST_FAILED`, `NETWORK_ERROR`,
> `REMOTE_DELETE_FAILED`, `REMOTE_DELETE_UNCONFIRMED`, `TAXONOMY_FETCH_FAILED`。

#### 2. 確定版 Guard Registry マッピング（G1〜G19）

| ID | Name | Codes (Primary + Sub-codes) | Stage | Severity | 実装箇所・役割 |
|---|---|---|---|---|---|
| **G1** | `SINGLE_TARGET_GUARD` | *(invocation constraint)* | `cli-mcp` | error | CLI / MCP 呼び出し層での単一ファイル指定強制 (`preflight.ts:358`) ※名前は README 由来の論理名 |
| **G2** | `ID_MISMATCH_ERROR` | `['ID_MISMATCH_ERROR']` | `preflight` | error | パスと Frontmatter ULID の整合性検証 (`preflight.ts:377`) |
| **G3** | `UNINTENDED_PUBLISH_GUARD` | `['UNINTENDED_PUBLISH_GUARD']` | `preflight` | error | 明示的確認なしの公開昇格を防止 (`preflight.ts:389`) |
| **G4** | `INVALID_TAXONOMY_ERROR` | `['INVALID_TAXONOMY_ERROR']` | `preflight` | error | 未定義カテゴリ・タグの指定検知 (`preflight.ts:440`) |
| **G5** | `LOCAL_IMAGE_DETECTED` | `['LOCAL_IMAGE_DETECTED', 'INLINE_LOCAL_IMAGE_NOT_SUPPORTED']` | `preflight` | error | 本文内の未解決ローカル画像パス検知 (`preflight.ts:515,608`) |
| **G6** | `UNRESOLVED_CONFLICT_MARKERS` | `['UNRESOLVED_CONFLICT_MARKERS']` | `preflight` | error | マージコンフリクトマーカー（`<<<<<<<` 等）残存検知 (`preflight.ts:642`) |
| **G7** | `TITLE_DUPLICATION_AUTOTRIM` | *(auto-trim mutation)* | `preflight` | info/warning | 本文冒頭の重複 `# Title` 自動除去 (`preflight.ts:651-663`) |
| **G8** | `UNSUPPORTED_SYNTAX_WARNING` | *(detectUnsupportedMarkdownSyntax)* | `preflight` | warning | Portable Text 非互換構文の警告 (`portable-text.ts:617`) |
| **G9** | `MODIFIED_OPAQUE_BLOCK` | `['MODIFIED_OPAQUE_BLOCK']` | `preflight` | error | `<!--ec:block-->` 保護ブロック改ざん検知 (`preflight.ts:672`) |
| **G10** | `INVALID_FEATURED_IMAGE` | `['INVALID_FEATURED_IMAGE']` | `preflight` | error | アイキャッチ画像 ID の形式検証 (`preflight.ts:630`) |
| **G11** | `LOCAL_IMAGE_AUTO_UPLOAD` | `['MISSING_LOCAL_IMAGE_FILE', 'INVALID_LOCAL_IMAGE_TYPE', 'LOCAL_IMAGE_SIZE_EXCEEDED', 'PROMOTED_MEDIA_NOT_FOUND_REMOTE']` | `preflight` / `push` | error | `media/drafts/` からの自動アップロード処理 (`preflight.ts:545,564`, `client/media.ts:410`, `push.ts:489`) ※ 警告として `[MEDIA_EXISTENCE_UNVERIFIED]` を含む。**`LOCAL_IMAGE_AUTO_UPLOAD` は primary label であり error code ではない**（`push.ts:429,436,441` は警告メッセージ内の接頭辞であり `code:` プロパティではない）→ codes 配列には含めず、G1/G7/G8 と同じ個別アサーションで検証する |
| **G12** | `QUARANTINED_COPY_NOT_PUSHABLE` | `['QUARANTINED_COPY_NOT_PUSHABLE']` | `push` | error | `conflicts/` 配下の退避ファイル直接 Push 禁止 (`push.ts:581`) |
| **G13** | `CANONICAL_HAS_UNPUSHED_EDITS` | `['CANONICAL_HAS_UNPUSHED_EDITS']` | `conflicts` | error | コンフリクト解消時の未 Push ローカル編集上書き防止 (`conflicts.ts:67`) |
| **G14** | `QUARANTINED_PATH_REQUIRED` | `['QUARANTINED_PATH_REQUIRED']` | `conflicts` | error | コンフリクト対象パスの検証 (`conflicts.ts:86`) |
| **G15** | `DELETE_PENDING_ARTICLE` | `['DELETE_PENDING_ARTICLE']` | `push` | error | 削除保留中記事の Push 抑止 (`push.ts:674`) |
| **G16** | `TAXONOMY_CONFLICT_PENDING` | `['TAXONOMY_CONFLICT_PENDING']` | `push` | error | タクソノミー未反映状態での Push 抑止 (`push.ts:711`) |
| **G17** | `TAXONOMY_APPLY_PENDING` | `['TAXONOMY_APPLY_PENDING']` | `push` | error | タクソノミー同期保留中の Push 抑止 (`push.ts:726`) |
| **G18** | `DUPLICATE_SLUG_CONFLICT` | `['DUPLICATE_SLUG_CONFLICT']` | `new` | error | 記事作成時の重複スラッグ検証 (`new.ts:45`) |
| **G19** | `DESTRUCTIVE_TAXONOMY_WIPE` | `['DESTRUCTIVE_TAXONOMY_WIPE']` | `push` | error | タクソノミー全削除等の破壊的操作抑止 (`push.ts:803,1232`) |

#### 3. テスト設計（`tests/guards.test.ts`）

- **走査パターン**（3 形式を必ずすべて走査する）:
  1. オブジェクトリテラル / 引数としての `code: '...'`（`ApiError` 生成、`PreflightError` リテラル）
  2. 三項演算子による生成 `code: cond ? '...' : '...'`（`push.ts:167` の `PUBLISH_FAILED` / `UNPUBLISH_FAILED`。形式 1 のみの正規表現では両方を取りこぼす）
  3. クラスプロパティ宣言 `public (readonly )?code = '...'`（`CanonicalHasUnpushedEditsError`, `QuarantinedPathRequiredError`, `DuplicateSlugError`, `UnpushedModificationsError`, `PublishedArticleDeletionForbiddenError`, `FrontmatterParseError`）
  - v3 までは形式 1 のみであり、形式 2 で **2 code**・形式 3 で **6 code** が抽出できず、包含検査と未知コード排除検査の双方が fail する。
- **走査対象**:
  `src/` 配下の全 `.ts` を再帰走査する（**ファイル名の固定列表を使わない**）。
  R3 で `src/sync/media.ts` は 8 モジュールに分割されるため、列表方式では Phase 3 直後にテストが黙って範囲を失う。実測で guard 系 code を持つファイルは v3 の 5 ファイル以外に `src/sync/media.ts`（`ARTICLE_NOT_FOUND`, `MEDIA_LIST_FAILED`）、`src/client/http.ts`（`NETWORK_ERROR`）、`src/sync/delete.ts`、`src/sync/pull.ts`、`src/sync/taxonomies.ts`、`src/utils/frontmatter.ts` に及ぶ。
- **アサーション規則**（4 規則）:
  1. **包含検査**: `GUARD_REGISTRY` の全 `codes` は、実コードのいずれかの走査形式に 1 箇所以上出現すること。ただし `LOCAL_IMAGE_AUTO_UPLOAD` は code として実在しないため対象外（規則 4 で検証）。
  2. **未知コード排除検査**: 走査で抽出された全 code 集合 ⊆ `(GUARD_REGISTRY の全 codes ∪ OPERATIONAL_ERROR_CODES ∪ PROTECTION_ERROR_CODES)`。外れた code が 1 件でもあれば即 fail。
  3. **重複排他検査**: 同一 code が複数 guard に属していないこと（`ENTRY_LOCKED` は Operational 側のみに置く）。また registry 内 primary label と codes の和集合が registry 内で一意であること。
  4. **G1 / G7 / G8 / G11-label の個別アサーション**（いずれも code を持たないため、関数挙動・警告文言で検証する）:
     - **G1** `SINGLE_TARGET_GUARD`: 実コードに文字列として存在しない論理名。`preflight.ts:356-357` のコメント「`(G1 is enforced at the MCP / CLI invocation layer)`」が根拠であり、`runPreflightChecks()` は **G2 から G11 までを実行する**ことを挙動で検証する（`preflight.ts:358` 参照）。
     - **G7** `TITLE_DUPLICATION_AUTOTRIM`: `preflight.ts:651` 以降の「body starts with an H1/H2 that duplicates frontmatter.title, trim it safely」自動除去。code を持たない mutation として検証。
     - **G8**: `detectUnsupportedMarkdownSyntax()`（`client/portable-text.ts:618`、`preflight.ts:682` で呼び出し）が返す警告配列として検証。
     - **G11 label** `LOCAL_IMAGE_AUTO_UPLOAD`: `push.ts:429,436,441` の警告接頭辞 `[LOCAL_IMAGE_AUTO_UPLOAD]` の文言として検証（code 検索では検出不可）。

---

### R2 【P0・文書】確定仕様のドキュメント再集計とコードコメント追従

1. **ドキュメント反映**:
   - `README.md`: `postsSyncLimit: 30`, `localMediaRefs: true`、G1〜G19 表の反映、TOC 修正。
     - **ガード番号の実帰属に合わせる**: `MISSING_LOCAL_IMAGE_FILE` は現在 README:550 で **G5 の配下**に記載されているが、実 emit 箇所は `preflight.ts:545,555`（media/drafts 解決失敗経路）であり v4 レジストリでは **G11** 配下。README を G11 に移す（G5 は `LOCAL_IMAGE_DETECTED` + `INLINE_LOCAL_IMAGE_NOT_SUPPORTED` の 2 code のみ）。
   - `AGENTS.md`: G1〜G19 への更新、§7（不変条件）の独立見出し化。
   - `CHANGELOG.md`: 試行錯誤の履歴を排し、最新仕様のスペックサマリとして再集計。
   - `docs/local-first-media-pipeline-plan.md`: Non-Goals 表を実挙動に合わせて更新。
2. **コード内コメント / CLI ヘルプの追従**:
   - `push.ts:670, 702, 718` のガード番号コメントを最新 G15〜G17 に整合。
   - `cli/commands/push.ts:46`, `mcp/tools/sync-push.ts:58`（`bypasses Guard G17`）が正しく G17 を参照していることを確認（変更不要）。
3. **リポジトリ Hygiene（A-7 対応）**:
   - `docs/v0112-eval/logs/` 内の追跡済みログ 9 件（`.txt`）を `git rm`。
   - `.gitignore` に `docs/**/logs/` を追加（※ `.DS_Store` は登録済みのため変更不要）。

---

### R3 【P0・構造】`src/sync/media.ts`（1494 行）の責務分離分割

**目的**: 巨大な `media.ts` を 8 つの責務別モジュールに分割。barrel パターンで後方互換性を 100% 維持。

```text
src/sync/media/
  ├── types.ts          # 型定義（EmDashMediaItem, PullMediaOptions 等）
  ├── naming_mirror.ts  # ミラー命名規則・衝突解決・移動処理
  ├── companions.ts     # メタデータ YAML 生成および補助処理
  ├── body_scan.ts      # Markdown 本文からのメディア参照抽出
  ├── remote_index.ts   # リモート StorageKey 索引構築
  ├── mirror_item.ts    # 単一アセットのダウンロード・昇格処理
  ├── pull_library.ts   # ライブラリ全体の取得・Prune 処理
  └── pull_article.ts   # 記事単位のオンデマンドメディア同期
```
- `src/sync/media.ts` は上記モジュールの re-export のみとし、外部のテストやモジュールは修正不要。

---

### R4 【P1・構造】Magic Number と規定値の単一ソース化

1. `pull.ts:229`, `sync-pull.ts:160` の `|| 30` を削除し、`DEFAULT_CONFIG.postsSyncLimit` を参照。
2. 5 箇所の `mediaSyncLimit ?? 300` / `|| 300`（`sync-pull.ts:247,353`, `pull.ts:315,467`, `media.ts:1048`）は、**既存の `DEFAULT_CONFIG.mediaSyncLimit`** を参照する形に統一（新たな定数は作らず、`config.ts` を唯一の正本とする）。
3. `batchSize = 100` を `MEDIA_LIST_PAGE_SIZE = 100` に集約。
4. `tests/workspace.test.ts` で未設定時の既定値（30）の適用をロック。

---

### R5 【P1・構造】Media Reference Parser の統合

1. `src/utils/media-refs.ts`（新規）に統一パーサー `parseArticleMediaRefs` を設置。
2. Fence Policy を定数化（`FENCE_POLICY.guard = 'backtick-only'`, `FENCE_POLICY.diagnostic = 'backtick-or-tilde'`）。
3. `MEDIA_FILE_ROUTE_PREFIX`（`/_emdash/api/media/file/`）のリテラル直書きを全廃。

---

### R6 【P2・設計】Cache Schema v5 への移行（列分離・PK再設計・復旧メソッド新設）

**目的**: `media_state` において、リモートレコード ID とローカルバイナリ SHA-256 が同一列（`local_hash`）を上書きし合っている非対称性を根本解消する。

#### 1. テーブル設計（`media_state_v5`）
```sql
CREATE TABLE media_state_v5 (
  storage_key TEXT PRIMARY KEY,          -- 一意な StorageKey を主キー化
  media_id TEXT NOT NULL,                 -- Remote Media Record ULID
  local_content_hash TEXT,               -- ローカルファイルの SHA-256
  remote_record_ref TEXT,                -- リモート側の状態参照（media-record:<id>）
  url TEXT NOT NULL,
  workspace_path TEXT,
  markdown_ref TEXT,
  status TEXT NOT NULL,
  uploaded_at INTEGER                     -- epoch seconds（INTEGER を維持）
);
CREATE INDEX idx_media_state_media_id ON media_state_v5 (media_id);
CREATE INDEX idx_media_state_status ON media_state_v5 (status);
CREATE INDEX idx_media_state_content_hash ON media_state_v5 (local_content_hash);
```

#### 2. アップロード復旧ルートの保証と API シグネチャ更新
- **復旧メソッド新設**: `client/media.ts:430` の「アップロード成功→記事 PUT 失敗」ウィンドウからの復旧のため、**`getMediaStateByContentHash(contentHash: string)`** を新設。
- **削除 API**: `deleteMediaState(storageKey: string)` および `deleteMediaStateByContentHash(contentHash: string)` を提供。
- `push.ts:485` や `client/media.ts:451` 等の呼び出し箇所を新シグネチャに追従。

#### 3. PK 再設計に伴う `pending → ready` 遷移の語義変更（v4 で新規追加・阻断項目）

**実測**: 現行 `saveMediaState()` は `INSERT INTO media_state ... ON CONFLICT(local_hash) DO UPDATE ... COALESCE(...)`（`db/cache.ts:823-835`、現行 PK は `local_hash TEXT PRIMARY KEY`、`cache.ts:183`）で **1 行を upsert** する。confirm 時点で storageKey が単一 ULID から 2 連 ULID に書き換わっても同じ行が更新される。PK を `storage_key` に変更すると、この遷移は **別主キーへの 2 回目の INSERT（行が増える）** になる。

- **影響**: `tests/cache.test.ts:142-178` の「pending（単一 ULID key）→ confirm 後 ready（2 連 ULID key）」シナリオで `listMediaStates('ready') === 1` / `listMediaStates('pending') === 0` が崩れる（pending 行が残り 1 になる）。**このテストを v5 の語義に合わせて書き換える作業を R6 に含む**。
- **採用する語義（決定事項）**: confirm 時は旧 storageKey 行を `deleteMediaState(oldStorageKey)` で除去してから新 storageKey で INSERT する（「1 media record = 1 active row」を保つ）。単なる upsert 追加にしないこと。
- **COALESCE 不変条件の維持**: 「後の upsert が `workspacePath` を省略・null にしても promote 済みパスを保持する（R-5）」挙動（`tests/cache.test.ts:180-224`）は conflict 標的が `local_hash` → `storage_key` に変わっても規則として維持すること。クリアは常に `deleteMediaState()` 経由のみ、という現行規約も変更しない。
- **影響テスト範囲（実測 6 ファイル）**: `saveMediaState` / `getMediaState*` / `deleteMediaState` を直接叩くテストは `tests/cache.test.ts`, `tests/push_media_pipeline.test.ts`, `tests/media_upload.test.ts`, `tests/doctor.test.ts`, `tests/media.test.ts`, `tests/local_media_refs.test.ts`。v5 では 6 ファイルすべてを追従検証する。

#### 4. 既存データのマイグレーション / backfill 規則
- 既存の `local_hash` が `media-record:` 接頭辞を持つ場合は `remote_record_ref` に退避。
- 64 文字 hex SHA-256 の場合は `local_content_hash` に格納。
- `storage_key` が空のレガシー行は YAML コンパニオンまたは URL から補完。
- **PK 変更は `ALTER TABLE ADD COLUMN` では実現できない**（現行マイグレーションは列追加のみ、`db/cache.ts:321`）。v5 は **テーブル再作成型**（`CREATE TABLE media_state_v5` → `INSERT ... SELECT` → `DROP TABLE media_state` → `ALTER TABLE ... RENAME TO media_state`）を単一トランザクション内で行う。
- `CURRENT_CACHE_SCHEMA_VERSION` を **4 → 5** に引き上げる（`db/cache.ts:95`）。上位バージョン拒否ガード（`CACHE_SCHEMA_MISMATCH`, `cache.ts:210-214`）は現行のまま有効。
- **追加すべき移行テスト**: `tests/cache.test.ts` は既に v0 起点（:286, :469）と v2 起点（:430）の昇格を assert している。**v4 起点（`PRAGMA user_version = 4` + `media_state` に `local_hash='media-record:<id>'` と SHA-256 の混在行）からの v5 昇格ケースを 1 本追加**し、列分離結果と行数保存（行が増えないこと）を検証する。

---

## 3. リグレッション防止ロック（Regression Locks）

| ID | 不変条件 | テスト対象 |
|---|---|---|
| **L1** | `postsSyncLimit` 未指定時に 30+30 が適用されること | `tests/workspace.test.ts` |
| **L2** | batch pull で local-first mirror が走り、`--posts-only` でスキップされること | `tests/sync.test.ts` |
| **L3** | 記事相対参照（`../../media/<key>`）が status/diff でファントム差分にならないこと | `tests/local_media_refs.test.ts` |
| **L4** | ミラー名が storageKey 由来であり、ULID は衝突時のみ付与されること | `tests/media.test.ts` |
| **L5** | Prune がリモートレコードのみを基準としローカル走査からシードされないこと | `tests/pull_pruning.test.ts` |
| **L6** | `src/` 内の全 error code が Guard / Operational / Protection のいずれかに分類され、registry の codes と完全整合すること（包含・排他・部分集合の 3 検査） | **新規 `tests/guards.test.ts`** |

---

## 4. 実施フェーズ（Phase 1 〜 5）

```text
Phase 1: Guard Registry のコード化＆整合性テスト（R1）
  - src/sync/guards.ts 作成（1:N 設計、G1〜G19 連番、OPERATIONAL_ERROR_CODES 23 件 ＋ PROTECTION_ERROR_CODES 3 件）
  - tests/guards.test.ts 作成（src/ 全走査・3 形式パターン・包含/排他/部分集合の 3 検査）→ npm run check green
  → ガード定義の正本をコード側で確定

Phase 2: 全ドキュメントの再集計＆コードコメント追従＆リポジトリ整理（R2）
  - README / AGENTS.md / docs を確定 Registry と新仕様（30 / default-ON）に一括更新
  - push.ts の G15〜G17 コメントを整合
  - docs/ 追跡済みログ 9 件削除 ＋ .gitignore に docs/**/logs/ 追加

Phase 3: media.ts 分割（R3）＆ Magic Number 集約（R4）
  - src/sync/media/ 8 モジュール作成 ＋ barrel 互換
  - DEFAULT_CONFIG.mediaSyncLimit 参照統一 ＋ L1 回帰テスト拡充 → npm run check green

Phase 4: Media Reference Parser 統合（R5）
  - src/utils/media-refs.ts 作成 ＋ 共通化
  - リテラル URL 接頭辞の排除 ＋ parser fixture テスト

Phase 5: DB スキーマ v5 分離（R6）
  - media_state_v5 テーブル再作成型マイグレーション（storage_key PK 化、uploaded_at INTEGER 維持、CURRENT_CACHE_SCHEMA_VERSION 4→5）
  - pending→ready 遷移を「旧 storageKey 行 delete → 新 storageKey INSERT」に統一（COALESCE 保持規則は維持）
  - getMediaStateByContentHash / deleteMediaState シグネチャ更新追従 ＋ 影響テスト 6 ファイル追従
  - v4 起点の移行テスト追加 → npm run check green
  - AGENTS.md キャッシュ仕様の更新
```

---

## 5. 実施ステータス（完了）

全 Phase（R1〜R6）を実装し、`npm run check`（Prettier / typecheck / Vitest）は **38 テストファイル / 426 テスト green** で確定した。

| Task | 状態 | 実装成果 |
|---|---|---|
| **R1** | ✅ | `src/sync/guards.ts`（`GUARD_REGISTRY` G1〜G19 連番・`codes: string[]` の 1:N、`OPERATIONAL_ERROR_CODES` 23 件、`PROTECTION_ERROR_CODES` 3 件）＋ `tests/guards.test.ts`（`src/` 全走査、3 形式の抽出パターン、包含 / 排他 / 部分集合の 3 検査）。抽出 44 code ⊆ registry 集合（差集合 0） |
| **R2** | ✅ | README / AGENTS.md / CHANGELOG を確定 Registry と新仕様（`postsSyncLimit` 30+30、`localMediaRefs` default-ON）に一括更新。`push.ts` の G15〜G17 コメントを実装順に整合。`docs/v0112-eval/logs/` の追跡済みログ 9 件削除 ＋ `.gitignore` に `docs/**/logs/` 追加 |
| **R3** | ✅ | `src/sync/media/` を 8 モジュール ＋ barrel（`index.ts`）に分割、`media.ts` は barrel 互換の薄い re-export 層へ。旧 export 23 件の欠落 0 |
| **R4** | ✅ | `DEFAULT_CONFIG` を `src/utils/config.ts` で export し `postsSyncLimit` / `mediaSyncLimit` 参照に統一（src 内にマジックナンバー残存 0）。`localMediaRefs: true` も正本として `DEFAULT_CONFIG` に集約し、`loadConfig()` の不在時・catch 時フォールバックが同じ値を参照 |
| **R5** | ✅ | `src/utils/media-refs.ts` に `MEDIA_FILE_ROUTE_PREFIX` / `VALID_MEDIA_FILE_KEY` / `FENCE_POLICY`（`guard: 'backtick-only'` ／ `diagnostic: 'backtick-or-tilde'`）／ `isCodeFenceDelimiter()` ／ `scanRawMediaReferences(body, fencePolicy)` を集約。`doctor.ts` はリテラル判定を廃止して `FENCE_POLICY.diagnostic` を参照、`delete.ts` の `scanArticleMediaReferences` は shim として共通 parser に委譲。`tests/media_refs.test.ts`（7 tests）でフェンス方針と parser を固定 |
| **R6** | ✅ | `media_state_v5` 再作成型マイグレーション（`storage_key` PRIMARY KEY、`local_content_hash` / `remote_record_ref` 列分離、単一トランザクション）。同一 `storageKey` の v4 複数行は `GROUP BY computed_key` ＋ `MAX(...)` で 1 行に統合し両ハッシュと最新 `uploaded_at` を保持（tautology だった `OR media_id IS NOT NULL` を WHERE から除去）。`getMediaState` / `deleteMediaState` は `WHERE storage_key = ?` 専用へ、検索・削除は `...ByContentHash` / `...ByMediaId` に分離。pending→ready は「旧 storageKey delete → 新 storageKey INSERT」。v4 起点の移行テスト（重複 key 統合を検証）追加。README の `media_state` 説明を v5 定義へ更新 |

### 実測値

- `npm run check` → Prettier clean / `tsc --noEmit` ＋ `tsc -p tsconfig.test.json` OK / **Test Files 38 passed, Tests 426 passed**
- Regression Locks: L1〜L6 すべて対応テストが存在し green（L6 は `tests/guards.test.ts`、L5 は `tests/pull_pruning.test.ts`）
- OD-1（guard 番号固定）・OD-3（schema v5 移行）はいずれも計画側の推奨どおり決定・実装済み
