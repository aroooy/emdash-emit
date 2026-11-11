# v0.1.15 Refactor Plan（改訂版 v2）— 実装整合性を担保した現行仕様の再集計

**策定日**: 2026-11-12  
**対象リポジトリ**: `emdash-emit`（HEAD: `62ea48c` / `package.json` version `0.1.14`）  
**検証済み状態**: `npm run check` → **36 test files / 414 tests 全 green**  
**位置づけ**: **正式リリース前に向けた現行仕様の再集計・正本化**、および実コード照合で判明した R1（Guard Registry）と R6（スキーマ設計）の整合性修正を取り込んだ確定計画書。

---

## 0. 基本方針（正式リリース前の再集計）

1. **過去の履歴・弁明の排除**: 過去のコミット経緯や「誰が承認したか」といった履歴は含めず、**「現時点の確定仕様（Current Canonical Spec）」とその設計思想**をドキュメント（README / AGENTS.md / docs）に再集計・正本化する。
2. **確定仕様の定義**:
   - `postsSyncLimit: 30`（Cloudflare D1/Worker 環境制約および Staging Desk モデルに基づく規定値）
   - `localMediaRefs: default-ON`（記事相対パス `../../media/<storageKey>` 表記）
   - Local-first Media Pipeline（全ライブラリ JSON walk による索引構築 ＋ 参照バイナリのオンデマンド取得）
3. **実コード照合に基づく安全な設計**:
   - Guard Registry は **1 Guard : N Codes** の構造とし、CLI/MCP 呼び出し層の制約や Warning を正しく型定義する。
   - DB スキーマ v5 移行は PRIMARY KEY の再定義と API シグネチャ変更を見積もりに含める。

---

## 1. 整理対象の検出一覧（Detection Index）

| ID | 対象箇所 | 現状の不整合 | 是正方針（実コード整合の再集計） |
|---|---|---|---|
| **A-1** | `README.md` (147, 286, 666 行) | `postsSyncLimit` が一部で `100` と表記 | 正統値 **`30`** に統一 |
| **A-2** | `CHANGELOG.md` (15 行) | `localMediaRefs` が `(default false)` のまま | **`default-ON` / 記事相対パス** として再集計 |
| **A-3** | `README.md` / `AGENTS.md` | ガード番号の不整合・欠番・sub-code の未定義 | **G1〜G19 連番 ＋ 1:N sub-code 表** に整理しテストで保証 |
| **A-4** | `AGENTS.md` (§4) | ガード節内にアーキテクチャ不変条件（Invariant）が混在 | セクション見出しを分離し構造を整理 |
| **A-5** | `media.ts` (714-722 行) | コメント不整合および `local_hash` キー空間非対称 | コメント修正 ＋ **schema v5（列分離・PK再設計）** |
| **A-6** | `README.md` (672, 904 行) | `--media` オプションの説明が旧仕様のまま | local-first mirror（オンデマンド）と全取得の分担を明記 |
| **A-7** | `docs/` 配下ログ | `docs/v0112-eval/logs/` 内に追跡済みログ 9 件が残存 | **Git 追跡済み 9 件を削除** ＋ `.gitignore` に `docs/**/logs/` 追加 |

---

## 2. タスク詳細（Task R1 〜 R6）

### R1 【P0・正本化】Guard Registry のコード一元化（1:N 設計・G1〜G19 連番）

**目的**: ガード定義の正本をコード側に置き、`tests/guards.test.ts` でコードの実態と完全に一致させる。

#### 1. 型定義の設計（`src/sync/guards.ts`）
1 ガードに対して複数のエラーコードが存在する実態、および呼び出し層ガードや Warning の存在を型で正確に表現する：

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
}

export const GUARD_REGISTRY: readonly GuardMeta[] = [ ... ];
```

#### 2. 確定版 Guard Registry マッピング（G1〜G19）

| ID | Name | Codes (Primary + Sub-codes) | Stage | Severity | 実装箇所・役割 |
|---|---|---|---|---|---|
| **G1** | `SINGLE_TARGET_GUARD` | *(invocation constraint)* | `cli-mcp` | error | CLI / MCP 呼び出し層での単一ファイル指定強制 (`preflight.ts:358`) |
| **G2** | `ID_MISMATCH_ERROR` | `['ID_MISMATCH_ERROR']` | `preflight` | error | パスと Frontmatter ULID の整合性検証 (`preflight.ts:377`) |
| **G3** | `UNINTENDED_PUBLISH_GUARD` | `['UNINTENDED_PUBLISH_GUARD']` | `preflight` | error | 明示的確認なしの公開昇格を防止 (`preflight.ts:389`) |
| **G4** | `INVALID_TAXONOMY_ERROR` | `['INVALID_TAXONOMY_ERROR']` | `preflight` | error | 未定義カテゴリ・タグの指定検知 (`preflight.ts:440`) |
| **G5** | `LOCAL_IMAGE_DETECTED` | `['LOCAL_IMAGE_DETECTED', 'INLINE_LOCAL_IMAGE_NOT_SUPPORTED', 'MISSING_LOCAL_IMAGE_FILE']` | `preflight` | error | 不正なローカル画像パス検知 (`preflight.ts:515,545,555,608`) |
| **G6** | `UNRESOLVED_CONFLICT_MARKERS` | `['UNRESOLVED_CONFLICT_MARKERS']` | `preflight` | error | マージコンフリクトマーカー（`<<<<<<<` 等）残存検知 (`preflight.ts:642`) |
| **G7** | `TITLE_DUPLICATION_AUTOTRIM` | *(auto-trim mutation)* | `preflight` | info/warning | 本文冒頭の重複 `# Title` 自動除去 (`preflight.ts:650-663`) |
| **G8** | `UNSUPPORTED_SYNTAX_WARNING` | *(detectUnsupportedMarkdownSyntax)* | `preflight` | warning | Portable Text 非互換構文の警告 (`portable-text.ts:618`) |
| **G9** | `MODIFIED_OPAQUE_BLOCK` | `['MODIFIED_OPAQUE_BLOCK']` | `preflight` | error | `<!--ec:block-->` 保護ブロック改ざん検知 (`preflight.ts:672`) |
| **G10** | `INVALID_FEATURED_IMAGE` | `['INVALID_FEATURED_IMAGE']` | `preflight` | error | アイキャッチ画像 ID の形式検証 (`preflight.ts:630`) |
| **G11** | `LOCAL_IMAGE_AUTO_UPLOAD` | `['LOCAL_IMAGE_AUTO_UPLOAD', 'INVALID_LOCAL_IMAGE_TYPE', 'LOCAL_IMAGE_SIZE_EXCEEDED', 'PROMOTED_MEDIA_NOT_FOUND_REMOTE']` | `preflight` / `push` | error | `media/drafts/` からの自動アップロード処理 (`preflight.ts:564`, `push.ts:489`) |
| **G12** | `QUARANTINED_COPY_NOT_PUSHABLE` | `['QUARANTINED_COPY_NOT_PUSHABLE']` | `push` | error | `conflicts/` 配下の退避ファイル直接 Push 禁止 (`push.ts:581`) |
| **G13** | `CANONICAL_HAS_UNPUSHED_EDITS` | `['CANONICAL_HAS_UNPUSHED_EDITS']` | `conflicts` | error | コンフリクト解消時の未 Push ローカル編集上書き防止 (`conflicts.ts:67`) |
| **G14** | `QUARANTINED_PATH_REQUIRED` | `['QUARANTINED_PATH_REQUIRED']` | `conflicts` | error | コンフリクト対象パスの検証 (`conflicts.ts:86`) |
| **G15** | `DELETE_PENDING_ARTICLE` | `['DELETE_PENDING_ARTICLE']` | `push` | error | 削除保留中記事の Push 抑止 (`push.ts:674`) |
| **G16** | `TAXONOMY_CONFLICT_PENDING` | `['TAXONOMY_CONFLICT_PENDING']` | `push` | error | タクソノミー未反映状態での Push 抑止 (`push.ts:711`) |
| **G17** | `TAXONOMY_APPLY_PENDING` | `['TAXONOMY_APPLY_PENDING']` | `push` | error | タクソノミー同期保留中の Push 抑止 (`push.ts:726`) |
| **G18** | `DUPLICATE_SLUG_CONFLICT` | `['DUPLICATE_SLUG_CONFLICT']` | `new` | error | 記事作成時の重複スラッグ検証 (`new.ts:45`) |
| **G19** | `DESTRUCTIVE_TAXONOMY_WIPE` | `['DESTRUCTIVE_TAXONOMY_WIPE']` | `push` | error | タクソノミー全削除等の破壊的操作抑止 (`push.ts:803,1232`) |

> **G15〜G17 の順序整合**:
> 実コード（`push.ts:670` = delete pending, `push.ts:702` = taxonomy conflict, `push.ts:718` = taxonomy apply）の実行順に合わせて **G15 を DELETE_PENDING_ARTICLE、G16 を TAXONOMY_CONFLICT_PENDING** に配置。
> これに伴い、`cli/commands/push.ts:46` および `mcp/tools/sync-push.ts:58`（`bypasses Guard G17`）との整合性を維持しつつ、コード内コメントおよびドキュメントを整合させます。

#### 3. `tests/guards.test.ts`（新規作成）
- `stage` が `preflight` / `push` / `conflicts` / `new` かつ `severity === 'error'` のガードについて、コードベース内に現れるエラーコード文字列リテラルと `GUARD_REGISTRY.codes` の完全一致を検証。
- `stage === 'cli-mcp'`（G1）および Warning/Mutation（G7, G8）は専用の個別アサーションでカバー。

---

### R2 【P0・文書】確定仕様のドキュメント再集計と文言・コメント追従

**目的**: 確定した Guard Registry および仕様に基づき、ドキュメントとコード内コメントを一括再集計。

1. **ドキュメント反映**:
   - `README.md`: `postsSyncLimit: 30`, `localMediaRefs: true`、G1〜G19 表の反映、TOC 修正。
   - `AGENTS.md`: G1〜G19 への更新、§7（不変条件）の独立見出し化。
   - `CHANGELOG.md`: 試行錯誤の履歴を排し、最新仕様のスペックサマリとして再集計。
   - `docs/local-first-media-pipeline-plan.md`: Non-Goals 表を実挙動（全件 walk ＋ 参照分オンデマンド取得）に更新。
2. **コード内コメント / CLI ヘルプの追従**:
   - `push.ts:670, 702, 718` のガード番号コメントを最新 G15〜G17 に整合。
   - `cli/commands/push.ts:46`, `mcp/tools/sync-push.ts:58` の説明文が Guard G17（TAXONOMY_APPLY_PENDING）と正確に対応していることを確認・更新。
3. **リポジトリ Hygiene（A-7 対応）**:
   - `docs/v0112-eval/logs/` 内の Git 追跡済みログ 9 件（`baseline_compare.txt`, `v13_conflicts_now.txt` 等）を `git rm`。
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
2. 5 箇所の `mediaSyncLimit ?? 300` を `DEFAULT_MEDIA_SYNC_LIMIT = 300`（`src/utils/config.ts`）に集約。
3. `batchSize = 100` を `MEDIA_LIST_PAGE_SIZE = 100` に集約。
4. `tests/workspace.test.ts` で未設定時の既定値（30）の適用をロック。

---

### R5 【P1・構造】Media Reference Parser の統合

1. `src/utils/media-refs.ts`（新規）に統一パーサー `parseArticleMediaRefs` を設置。
2. Fence Policy を定数化（`FENCE_POLICY.guard = 'backtick-only'`, `FENCE_POLICY.diagnostic = 'backtick-or-tilde'`）。
3. `MEDIA_FILE_ROUTE_PREFIX`（`/_emdash/api/media/file/`）のリテラル直書きを全廃。

---

### R6 【P2・設計】Cache Schema v5 への移行（列分離・PK再設計・API更新）

**目的**: `media_state` において、リモートレコード ID とローカルバイナリ SHA-256 が同一列（`local_hash`）を上書きし合っているキー空間の非対称性を根本解消する。

#### 1. テーブル設計の見直し
- **現行（schema v4）**:
  `local_hash TEXT PRIMARY KEY`（pull 経路は `media-record:<id>`、push 経路はコンテンツ SHA-256 を代入）
- **改訂後（schema v5）**:
  ```sql
  CREATE TABLE media_state_v5 (
    storage_key TEXT PRIMARY KEY,          -- 一意な StorageKey を主キー化
    media_id TEXT NOT NULL,                 -- Remote Media Record ULID
    local_content_hash TEXT,               -- ローカルファイルの SHA-256（存在する場合）
    remote_revision_hash TEXT,             -- リモート側の状態ハッシュ / media-record:<id>
    url TEXT,
    workspace_path TEXT,
    markdown_ref TEXT,
    status TEXT,
    uploaded_at TEXT
  );
  CREATE INDEX idx_media_state_media_id ON media_state_v5 (media_id);
  CREATE INDEX idx_media_state_local_hash ON media_state_v5 (local_content_hash);
  ```

#### 2. API シグネチャと呼び出し側の変更見積もり
- `deleteMediaState(localHash: string)` → `deleteMediaState(storageKey: string)`（または `deleteMediaStateByMediaId`）に変更。
- `cache.ts:850` (`getMediaState`) の取得キーを `storage_key` 主体に見直し。
- `push.ts:485` 等の呼び出し箇所をシグネチャ変更に追従。

#### 3. 既存データのマイグレーション / backfill 規則
- 既存の `local_hash` が `media-record:` 接頭辞を持つ場合は `remote_revision_hash` に退避。
- 64 文字の hex SHA-256 の場合は `local_content_hash` に格納。
- `storage_key` が空のレガシー行が存在する場合は、YAML コンパニオンまたは URL から補完。

---

## 3. リグレッション防止ロック（Regression Locks）

| ID | 不変条件 | テスト対象 |
|---|---|---|
| **L1** | `postsSyncLimit` 未指定時に 30+30 が適用されること | `tests/workspace.test.ts` |
| **L2** | batch pull で local-first mirror が走り、`--posts-only` でスキップされること | `tests/sync.test.ts` |
| **L3** | 記事相対参照（`../../media/<key>`）が status/diff でファントム差分にならないこと | `tests/local_media_refs.test.ts` |
| **L4** | ミラー名が storageKey 由来であり、ULID は衝突時のみ付与されること | `tests/media.test.ts` |
| **L5** | Prune がリモートレコードのみを基準としローカル走査からシードされないこと | `tests/pull_pruning.test.ts` |
| **L6** | Registry の全 codes 集合が実コードのエラーコード集合と完全一致すること | **新規 `tests/guards.test.ts`** |

---

## 4. 実施フェーズ（Phase 1 〜 5）

```text
Phase 1: Guard Registry のコード化＆整合性テスト（R1）
  - src/sync/guards.ts 作成（1:N 設計、G1〜G19 連番）
  - tests/guards.test.ts 作成 → npm run check green
  → ガード定義の正本をコード側で確定

Phase 2: 全ドキュメントの再集計＆コードコメント追従＆リポジトリ整理（R2）
  - README / AGENTS.md / docs を確定 Registry と新仕様（30 / default-ON）に一括更新
  - push.ts および CLI/MCP ヘルプ文言の G15〜G17 コメントを整合
  - docs/ 追跡済みログ 9 件削除 ＋ .gitignore に docs/**/logs/ 追加

Phase 3: media.ts 分割（R3）＆ Magic Number 集約（R4）
  - src/sync/media/ 8 モジュール作成 ＋ barrel 互換
  - config.ts 定数集約 ＋ L1 回帰テスト拡充 → npm run check green

Phase 4: Media Reference Parser 統合（R5）
  - src/utils/media-refs.ts 作成 ＋ 共通化
  - リテラル URL 接頭辞の排除 ＋ parser fixture テスト

Phase 5: DB スキーマ v5 分離（R6）
  - media_state_v5 マイグレーション（PK を storage_key 化、ハッシュ列分離）
  - deleteMediaState 等のシグネチャ変更追従
  - AGENTS.md キャッシュ仕様の更新
```
