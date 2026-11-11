# v0.1.15 Refactor Plan（改訂版）— 現行仕様の再集計とアーキテクチャの正本化

**策定日**: 2026-11-12  
**対象リポジトリ**: `emdash-emit`（HEAD: `62ea48c` / `package.json` version `0.1.14`）  
**検証済み状態**: `npm run check` → **36 test files / 414 tests 全 green**  
**位置づけ**: **正式リリース前に向けた現行確定仕様のドキュメント再集計**、およびコードベースの構造整理・ガード正本化・スキーマ分離

---

## 0. 前提と方針（正式リリース前の再集計）

本製品は現在正式リリース前の開発段階にあります。そのため、本計画書および各ドキュメント（README / AGENTS.md / docs）において**「過去にどう変更されてきたか」「誰が承認したか」といった履歴や弁明は一切含めず、現時点における確定仕様（Current Canonical Spec）とその設計思想を再集計・正本化すること**を主目的に据えます。

### 0.1 確定した現行仕様の定義

1. **`postsSyncLimit`: デフォルト `30`**
   - Cloudflare D1 / Workers 環境の制約、メモリ消費、およびローカル作業スペースの「Staging Desk（作業机）」モデルに基づき、スライディングウィンドウの規定値は **`30`**（published 30 + draft 30 = 最大 60 記事）を確定仕様とする。
   - ドキュメント内の旧表記（100）をすべて 30 に再集計し、コード内のデフォルト値参照を単一ソース化する。
2. **`localMediaRefs`: デフォルト `true`（Default-ON）**
   - ローカル Markdown でのプレビュー互換性（VS Code / Obsidian）を保つため、同期される画像参照は **記事相対パス（`../../media/<storageKey>`）** を標準とする。
   - キャッシュベースラインおよびリモート Push ペイロードは常に正統な API ルート（`/_emdash/api/media/file/<storageKey>`）を維持する。
3. **Local-first Media Pipeline の walk / mirror ポリシー**
   - **メタデータ走査 (walk)**: リモートのメディアライブラリ全体（JSON）を走査して `storageKey` 索引を構築する（上限なし / 無制限走査）。
   - **アセット取得 (mirror)**: バイナリ取得は**本文で参照されている必要なアセットのみ**をオンデマンドで取得する。
   - ※ ドキュメント上の Non-Goals 表をこの実挙動に合わせて再集計・明記する。

---

## 1. 整理対象の検出一覧（Detection Index）

現行コードとドキュメントの間で食い違いが生じている箇所（すべて実コード照合済み）：

| ID | 対象箇所 | 現状の不整合 | 是正方針（現行仕様への再集計） |
|---|---|---|---|
| **A-1** | `README.md` (147, 286, 666 行) | `postsSyncLimit` が一部で `100` と表記されている | 全ドキュメントを正統値 `30` に統一 |
| **A-2** | `CHANGELOG.md` (15 行) | `localMediaRefs` が `(default false)` と旧仕様のまま残存 | `default-ON` / 記事相対パス表記として再集計 |
| **A-3** | `README.md` / `AGENTS.md` | ガード番号（G1〜G17）の範囲外や、番号なしガード（DuplicateSlug / Wipe）が存在 | **G1〜G19 連番体系** に統一し、テストでコードと同期 |
| **A-4** | `AGENTS.md` (§4 見出し) | ガード節の中に不変条件（Invariant）が混在し参照が曖昧 | 節構造を整理し、ガードと不変条件を明確に分離 |
| **A-5** | `media.ts` (714-722 行) | コメントと実挙動の乖離、および `local_hash` のキー空間非対称 | コメント是正 ＋ **schema v5 分離** で根本解決 |
| **A-6** | `README.md` (672, 904 行) | `--media` オプション等の説明が旧来の一括取得前提のまま | local-first mirror stage（既定有効）の説明に更新 |
| **A-7** | `docs/` ディレクトリ | 過去の作業ログ（空ファイル含む 9 件）や `.DS_Store` の残存 | 削除し、`.gitignore` で混入を防止 |

---

## 2. タスク詳細（Task R1 〜 R6）

### R1 【P0・正本化】Guard Registry のコード一元化と G1〜G19 連番化（A-3 解消）

**目的**: ガード定義の正本をコード側に持ち、README / AGENTS.md の表を機械的に従属させる。未リリースであるため欠番を作らず、**G1〜G19 の隙間のない連番**で再集計する。

1. **`src/sync/guards.ts`（新規作成）**:
   メタデータと正統レジストリを定義：
   ```ts
   export interface GuardMeta {
     id: number;
     code: string;
     severity: 'error' | 'warning' | 'info';
     stage: 'preflight' | 'push' | 'conflicts' | 'new';
     source: string;
   }
   export const GUARD_REGISTRY: readonly GuardMeta[] = [ ... ];
   ```

2. **確定版 Guard マッピング（G1〜G19）**:

| ID | Code | Stage | 役割・検査内容 |
|---|---|---|---|
| **G1** | `SINGLE_TARGET_GUARD` | push | 単一ターゲット指定の強制（一括 Push の抑止） |
| **G2** | `ID_MISMATCH_ERROR` | preflight | ファイル名/パスと Frontmatter 内 ULID の整合性検証 |
| **G3** | `UNINTENDED_PUBLISH_GUARD` | preflight | 明示的な `allowPublish` なしの公開昇格を防止 |
| **G4** | `INVALID_TAXONOMY_ERROR` | preflight | 未定義カテゴリ・タグの指定検知 |
| **G5** | `LOCAL_IMAGE_DETECTED` | preflight | 未解決ローカル画像パスの混入検知 |
| **G6** | `UNRESOLVED_CONFLICT_MARKERS` | preflight | コンフリクトマーカー（`<<<<<<<` 等）の残存検知 |
| **G7** | `TITLE_DUPLICATION_AUTOTRIM` | push | 本文冒頭の重複 `# Title` 自動除去 |
| **G8** | `UNSUPPORTED_SYNTAX_WARNING` | preflight | Portable Text 非互換構文の警告 |
| **G9** | `MODIFIED_OPAQUE_BLOCK` | preflight | `<!--ec:block-->` 保護ブロックの改ざん検知 |
| **G10** | `INVALID_FEATURED_IMAGE` | preflight | アイキャッチ画像 ID の形式検証 |
| **G11** | `LOCAL_IMAGE_AUTO_UPLOAD` | preflight / push | `media/drafts/` からのリモート自動アップロードと置換 |
| **G12** | `QUARANTINED_COPY_NOT_PUSHABLE` | push | `conflicts/` 配下の退避ファイル直接 Push を禁止 |
| **G13** | `CANONICAL_HAS_UNPUSHED_EDITS` | conflicts | コンフリクト解消時の未 Push ローカル編集の上書き防止 |
| **G14** | `QUARANTINED_PATH_REQUIRED` | conflicts | コンフリクト対象パスの検証 |
| **G15** | `TAXONOMY_CONFLICT_PENDING` | push | タクソノミー未反映状態での Push 抑止 |
| **G16** | `DELETE_PENDING_ARTICLE` | push | 削除保留中記事の Push 抑止 |
| **G17** | `TAXONOMY_APPLY_PENDING` | push | タクソノミー同期保留中の Push 抑止 |
| **G18** | `DUPLICATE_SLUG_CONFLICT` | new | 記事作成時の重複スラッグ検証（旧 番号なし） |
| **G19** | `DESTRUCTIVE_TAXONOMY_WIPE` | push | タクソノミー全削除等の破壊的操作の抑止（旧 番号なし） |

3. **`tests/guards.test.ts`（新規作成）**:
   `preflight.ts`, `push.ts`, `conflicts.ts`, `new.ts` を走査し、コード中に現れるガードコードが `GUARD_REGISTRY` と 100% 一致することを検証。ドキュメントの漂移をテストで恒久的に防ぐ。

---

### R2 【P0・文書】現行確定仕様のドキュメント再集計（A-1, A-2, A-4, A-6 解消）

**目的**: 各ドキュメントを「現時点の確定仕様」として最新状態に一括再集計する。変更経緯や弁明は記載しない。

1. **`README.md`**:
   - `postsSyncLimit`: すべての記述・出力例を **`30`** に統一。
   - `localMediaRefs`: **`default: true`**（記事相対パス `../../media/<storageKey>`）として明記。
   - ガード一覧表: R1 の **G1〜G19** 表に差し替え、TOC や見出しの数値（G1–G14 等）を G1–G19 に修正。
   - `--media` オプション: local-first mirror（オンデマンド取得）とライブラリ全件同期の役割分担を最新化。
2. **`AGENTS.md`**:
   - ガード章（§4）を G1〜G19 に整合。
   - §4 内にあった「§7 Media Mirror Naming & Index-Based Pruning Invariant」を、ガードではなく独立した「アーキテクチャ不変条件（Invariants）」セクションとして見出し構造を整理。
3. **`CHANGELOG.md`**:
   - 途中経過のコミット履歴の言い訳を排除し、未リリース版のスペックサマリとして現行機能（`postsSyncLimit: 30`, `localMediaRefs: default-ON`, local-first pipeline）をすっきりと整理。
4. **`docs/local-first-media-pipeline-plan.md`**:
   - Non-Goals 表を実挙動（全ライブラリ JSON walk + 参照バイナリのみダウンロード）に合わせて更新。

---

### R3 【P0・構造】`src/sync/media.ts`（1494 行）の責務分離分割

**目的**: 巨大化した `media.ts` を 8 つの責務別モジュールに分割する。外部からの参照を壊さないため barrel パターンを採用し、既存テストおよびインポート元の挙動は完全に維持する。

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

- **互換性維持**: `src/sync/media.ts` は上記モジュールの re-export（barrel）とし、既存のすべてのインポートパス（orchestrator, doctor, cli, tests）を変更不要とする。

---

### R4 【P1・構造】Magic Number と規定値の単一ソース化

**目的**: 散在しているハードコードを `src/utils/config.ts` に集約し、二重管理を根絶する。

1. `pull.ts:229` および `sync-pull.ts:160` の `|| 30` を削除し、`DEFAULT_CONFIG.postsSyncLimit` を参照。
2. 5 箇所に散らばる `mediaSyncLimit ?? 300` を `DEFAULT_MEDIA_SYNC_LIMIT = 300` として定数化。
3. `media.ts` 内の `batchSize = 100` を `MEDIA_LIST_PAGE_SIZE = 100` に集約。
4. 回帰テスト `tests/workspace.test.ts` で、未設定時のデフォルト値（30）が正しく適用されることを保証。

---

### R5 【P1・構造】Media Reference Parser の統合（DRY 原則）

**目的**: 8 箇所に重複している Markdown / HTML 内の画像抽出正規表現とパースロジックを統合する。

1. **`src/utils/media-refs.ts`（新規作成）**:
   統一パーサー `parseArticleMediaRefs(content)` を提供。frontmatter と body の走査を効率化。
2. **Fence Policy の明示的定数化**:
   - Guard 判定: backtick のみ（`FENCE_POLICY.guard = 'backtick-only'`）
   - Diagnostic (doctor): backtick および tilde（`FENCE_POLICY.diagnostic = 'backtick-or-tilde'`）
   - ※ 挙動は変えず、意図的な差分であることをコード上で名前付けして管理。
3. `MEDIA_FILE_ROUTE_PREFIX`（`/_emdash/api/media/file/`）のリテラル直書きを全モジュールから排除。

---

### R6 【P2・設計】Cache Schema v5 への移行（`local_hash` 分離）

**目的**: リモートレコード ID とローカルバイナリ SHA-256 が同一列（`local_hash`）を上書きし合っている非対称性を、正式リリース前の今解消する。

1. **DB スキーマ v5 へのマイグレーション**:
   `media_state` テーブルにおいて、リモート走査用の識別子とローカルファイルのハッシュを明確に分離：
   - `remote_revision_hash`: リモート側の状態ハッシュ（または `media-record:<id>`）
   - `local_content_hash`: ローカルファイルの SHA-256
2. これにより、「ローカルファイルが更新されたがリモートは同一」という状態を正確に検知可能にする。

---

## 3. リグレッション防止ロック（Regression Locks）

挙動を変更しないことを担保するため、以下のテストを基準として運用：

| ID | 保証する不変条件 | テスト対象 |
|---|---|---|
| **L1** | `postsSyncLimit` 未指定時に published 30 + draft 30 が正しくロードされること | `tests/workspace.test.ts` (R4 で拡充) |
| **L2** | batch pull 時に local-first mirror が走り、`--posts-only` 時にスキップされること | `tests/sync.test.ts` (CLI 経由の検証を追加) |
| **L3** | 記事相対参照（`../../media/<key>`）が status / diff でファントム差分にならないこと | `tests/local_media_refs.test.ts` (既存 green 維持) |
| **L4** | ミラーファイル名が storageKey 由来であり、ULID は衝突時のみサフィックスとなること | `tests/media.test.ts` (既存 green 維持) |
| **L5** | Prune の正統性がリモートレコードのみに基づき、ローカル走査からシードされないこと | `tests/pull_pruning.test.ts` (既存 green 維持) |
| **L6** | Registry 内の全ガードコードが実装コード内のコード集合と完全一致すること | **新規 `tests/guards.test.ts`** (R1 で追加) |

---

## 4. 実施フェーズ（Phase 1 〜 5）

ドキュメントとコードの衝突を防ぎ、最も手戻りの少ない順序で進行します：

```text
Phase 1: Guard Registry のコード化＆テスト（R1）
  - src/sync/guards.ts 作成（G1〜G19 連番化）
  - tests/guards.test.ts 作成 → npm run check green
  → ガード体系の「正本」を確定

Phase 2: 全ドキュメントの最新仕様再集計＆リポジトリ整理（R2, OD-4）
  - 確定した Guard Registry から README / AGENTS.md の表を機械的に再集計
  - postsSyncLimit: 30 / localMediaRefs: default-ON を全文書に反映
  - docs/ 配下の不要ログ 9 件を削除、.gitignore に追加

Phase 3: media.ts 分割（R3）＆ Magic Number 集約（R4）
  - src/sync/media/ 8 モジュール作成 ＋ media.ts barrel 化
  - config.ts 定数集約 ＋ L1 回帰テスト拡充
  - 全 414 tests green を確認

Phase 4: Media Reference Parser 統合（R5）
  - src/utils/media-refs.ts 作成
  - 呼び出し側の置換、リテラル URL 接頭辞の排除
  - parser fixture テストで動作一致を検証

Phase 5: DB スキーマ v5 分離（R6）
  - media_state のハッシュ列分離マイグレーション
  - AGENTS.md のキャッシュ仕様記述を更新
```

---

## 5. 監査で「問題なし（変更禁止）」と確認した項目

以下の部分は正しく動作しており、リファクタリング時に誤って改変してはならない：

1. **`base_snapshots.frontmatter_yaml` の JSON-encoded Frontmatter 整合性**: `emit diff` の再構築バイト一致は検証済み。
2. **Fast path の heal 3 系統**: `base_snapshot` を汚染せず安全に再追跡している。
3. **Fence Policy の非対称性**: doctor が `~~~` を含め、ガードが backtick のみとする動作は仕様通り。
4. **Origin Resolution 優先順位**: CLI / MCP 共通の `resolveOriginPriority()` は正常稼働中。
5. **本番ワークスペースの命名移行**: すべての asset はすでに storageKey 由来名に移行済みであり、legacy コードは既存コーパス保護目的で安全に保持する。
