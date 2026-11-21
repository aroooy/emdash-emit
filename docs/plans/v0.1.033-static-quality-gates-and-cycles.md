# v0.1.33 実装計画書: 静的品質ゲート拡充・循環依存根絶・運用ガバナンス強化

- **対象バージョン**: `v0.1.33`
- **作成日**: 2026-11-15 (Rev.3 最終確定)
- **ステータス**: 承認・確定（Ready for Implementation）
- **目的**:
  1. レイヤリング検査の盲点であった「同一層内およびバレル再エクスポート経由の循環 import」を完全に根絶し、CI 上での機械的検査（`check:cycles`）を定常化する。
  2. MCP 接続時のプロトコル破壊（JSON-RPC 破壊）や下位レイヤーの副作用を防ぐため、非 CLI レイヤー（Layer 0〜2 & MCP）での `console.log` / `console.debug`（stdout 出力）混入を禁止する静的ゲート（Axis 5）を新設する。
  3. Preflight Guard G1〜G19 のうち唯一エラーコード名の直接 assert が抜けていた G17（`TAXONOMY_APPLY_PENDING`）のテストを是正し、さらに将来のガード登録漏れを防ぐ Guard Test Coverage Gate（`tests/guards.test.ts` Rule 5）を新設する。
  4. AI エージェントおよび開発者が実装・コミット前に自律的に自己検査できるよう、`AGENTS.md` に「Ask First（事前承認制）」と「Commit Readiness Checklist（コミット前自己点検制）」を制度化する。
  5. 肥大化した `docs/` ディレクトリ（21 世代の plan フォルダ群）を整理し、最新の正典仕様書（Truth）と歴史的計画（Archive）を明確に峻別する正典索引（`docs/README.md`）を整備する。

---

## 1. 背景と課題分析

### 1.1 課題 1: 循環 import の潜在（Layering gate の盲点）

- **現状**: `tests/layering.test.ts` は 4 層アーキテクチャ（Layer 0〜3）の垂直方向（Axis 0〜4）の依存を厳格に検査している。
- **問題**: レイヤー間の方向性検査に特化しているため、**「同一層内での相互参照」** や **「バレルファイル（`index.ts`）を経由した循環」** は検出されない。
- **実測結果**: `npx -y madge --circular --extensions ts src/` で走査した結果、以下の **2 件の循環依存** が実在している：
  ```text
  ✖ Found 2 circular dependencies!
  1) sync/workspace/index.ts > sync/workspace/commit.ts
  2) utils/media-body-refs.ts > utils/media-refs.ts
  ```
- **発生メカニズムの詳細**:
  1. `sync/workspace/index.ts` ↔ `sync/workspace/commit.ts`:
     - `index.ts:161` に `export { commitArticleSnapshot, ... } from './commit.js'` があり、ECMAScript モジュール仕様（Section 16.2.1.5 `[[RequestedModules]]`）および静的解析ツール（`madge`）において `index.ts → commit.ts` の依存エッジが生成される。
     - 一方で `commit.ts:28` が `import { calculateHash } from './index.js'` を行っているため、逆向きのエッジ `commit.ts → index.ts` が存在し、双方向サイクル（`index.ts ↔ commit.ts`）が形成される。
  2. `utils/media-body-refs.ts` ↔ `utils/media-refs.ts`:
     - `media-refs.ts:10` が `import { MEDIA_FILE_ROUTE_PREFIX } from './media-body-refs.js'` を実行。
     - `media-body-refs.ts:48` が `import { FENCE_POLICY, scanRawMediaReferences, ... } from './media-refs.js'` を実行。
     - 相互 import による典型的な循環が発生している。
- **リスク**: Node.js ESM 環境では循環参照がロード時に即座に例外とならず、実行時に `undefined` アクセス（TDZ: Temporal Dead Zone）として突如発現する危険がある。

### 1.2 課題 2: 非 CLI 層のログ出力による MCP プロトコル破壊リスク

- **現状**: Emit MCP サーバーは標準入出力（`stdin` / `stdout`）を JSON-RPC 2.0 通信のトランスポート層（`StdioServerTransport`, `src/mcp/server.ts:253`）として使用している。
- **問題**: `src/mcp/` 配下や下位レイヤー（`src/sync/`, `src/utils/`, `src/db/`, `src/client/`, `src/presentation/`）で誤って `console.log` や `console.debug`（stdout への書き出し）を実行すると、JSON-RPC ストリームに不正なテキストが混入し、MCP クライアント（Claude Desktop, Cursor, Antigravity 等）との接続が即座に切断される。
- **実測結果**: 現在、`src/cli/` 以外の全モジュールで `console.log` / `console.debug` の使用件数は **完全に 0 件**。なお、非 CLI 層で唯一存在する `src/mcp/server.ts:260` の `console.error(...)` は stderr 出力であり、JSON-RPC トランスポートを汚染しない（致命的エラー通知として正当）。
- **対策**: 今 0 件である状態を固定し、将来の混入を構造的に防止する静的ゲートが必要である。

### 1.3 課題 3: Guard エラーコードのテスト網羅性ギャップ（G17 & G11）

- **現状**: `src/sync/guards.ts` に定義された 16 ガード（計 20 種の平坦化エラーコード）のうち、18 コードはテストスイート内で直接アサートされている。
- **問題**: 以下の **2 つのエラーコード** が、テストコード全体で一度も直接アサートされていない：
  1. `TAXONOMY_APPLY_PENDING` (G17): `tests/sync.test.ts:2652` においてエラーメッセージの正規表現一致しか検証されておらず、コード名のアサートが欠落。
  2. `LOCAL_IMAGE_SIZE_EXCEEDED` (G11): 画像サイズ上限（50 MiB）超過時の拒否コードだが、テスト内に直接のアサートが不在。
- **対策**: 既存の流儀に合わせて 2 コードのアサートテストを追加し、さらに全 20 種のガードコードがテスト内で検証されているかを自動監査する Rule 5 を新設する。

### 1.4 課題 4: 文書とコードの不整合を未然に防ぐ運用ガバナンスの欠如

- **現状**: v0.1.32 の開発過程において、AGENTS.md と実装コードの判定条件乖離（C-1）や、検査仕様の誤引用（N-2）が発生し、人間によるコードレビューで初めて発覚した。
- **原因**: Workspace のデータ破壊を防ぐ実行時ガード（G1〜G19）は豊富だが、**コード構造や仕様文書の整合性を守るための「変更前承認制」や「コミット前チェックリスト」** が `AGENTS.md` に存在しなかった。

### 1.5 課題 5: ドキュメント正典と過去計画の混在

- **現状**: `docs/` 配下に過去のバージョン計画（`v0112-eval` 〜 `v0133-plan`）が計 21 ディレクトリ並列しており、どれが現在のシステム挙動を定義する「正典（Authoritative Source of Truth）」かが外部から判別しにくい。
- **基準**: AGENTS.md から直接参照されている文書（現在: `docs/media-id-spaces.md`）および公式運用手順（`docs/npm-publish-guide.md`）を正典とし、計画書やバックログと明確に分類する索引が必要である。

---

## 2. 詳細設計と改修仕様

### 2.1 循環依存の根絶と機械検査（`madge --circular`）の導入

#### A. 既存の循環依存 2 件の解消

1. **`src/sync/workspace/index.ts` ↔ `commit.ts` の解消**:
   - `calculateHash` を新設モジュール `src/sync/workspace/hash.ts` に切り出す。
   - `src/sync/workspace/index.ts` は `hash.ts` から `calculateHash` を re-export する（外部インターフェース 100% 後方互換維持）。
   - `src/sync/workspace/commit.ts:28` は `./index.js` ではなく `./hash.js` から直接 `calculateHash` を import する。
   - これにより、`commit.ts → index.ts` の逆参照エッジが完全に消滅し、循環が解消する。

2. **`src/utils/media-body-refs.ts` ↔ `media-refs.ts` の解消**:
   - `MEDIA_FILE_ROUTE_PREFIX` の正典定義を `src/utils/media-refs.ts` に移動する。
   - `src/utils/media-body-refs.ts` は `media-refs.ts` から `MEDIA_FILE_ROUTE_PREFIX` を import する。
   - `src/utils/media-refs.ts` 内の `import { MEDIA_FILE_ROUTE_PREFIX } from './media-body-refs.js'` を削除する。
   - 派生修正: `src/sync/preflight.ts:40` の import 元を `../utils/media-refs.js` に変更する。
   - これにより、`media-refs.ts → media-body-refs.ts` の逆参照エッジが消滅し、循環が解消する。

#### B. 静的検査スクリプトの追加と CI 連携

- `package.json` の `devDependencies` に `madge` を追加（Ask First 承認事項）。
- `package.json` に scripts を追加：
  ```json
  "check:cycles": "madge --circular --extensions ts src/"
  ```
- `package.json` の `"check"` スクリプトを更新：
  ```json
  "check": "npm run format:check && npm run typecheck && npm run check:cycles && npm test"
  ```
- `.github/workflows/ci.yml` に `check:cycles` ステップを追加（`npm run typecheck` の直後に配置）。

---

### 2.2 非 CLI 層における `console.log` 禁止ゲート（Axis 5）

`tests/layering.test.ts` に **Axis 5: Non-CLI logging isolation** を追加する。外部パッケージを追加せず、既存テストのファイル走査機構（`fs.readFileSync`）を活用してゼロオーバーヘッドで実装する。

- **検査対象ディレクトリ**:
  - `src/sync/`
  - `src/utils/`
  - `src/db/`
  - `src/client/`
  - `src/mcp/`
  - `src/presentation/`
- **禁止パターン**:
  - `console.log(...)`
  - `console.debug(...)`（stdout への出力）
- **許可対象と理由**:
  - `src/cli/`: コマンドラインツールとしての標準出力（ユーザー表示）として正当。
  - `console.error(...)` / `console.warn(...)`: stderr への書き出しであり、JSON-RPC トランスポート（stdout）を汚染しないため許可（現状 `src/mcp/server.ts:260` の致命的エラー出力 1 箇所のみ）。
- **違反時挙動**:
  - 違反ファイル、行番号、該当コード行を一覧出力してテストを FAIL させる。

---

### 2.3 Guard テスト是正（G17 / G11）と Coverage Gate（Rule 5）

#### A. G17 テスト是正 (`tests/sync.test.ts`)

既存テストの流儀（2910〜2920 行付近）に合わせ、`try/catch` + `expect(err.code).toBe(...)` の形式で直接検証する：

```ts
try {
  await pushArticle(syncState!.localFilePath, {
    workspaceRoot: tempDir,
    cache,
    origin: 'https://test.emdash.local',
    token: 'test-token',
    fetchFn: mockFetch as unknown as typeof fetch,
  });
  expect.fail('Expected TAXONOMY_APPLY_PENDING error');
} catch (err: any) {
  expect(err.code).toBe('TAXONOMY_APPLY_PENDING');
  expect(err.message).toMatch(
    /has an unconfirmed taxonomy assignment from a previous failed update/,
  );
}
```

#### B. G11 `LOCAL_IMAGE_SIZE_EXCEEDED` テスト追加 (`tests/preflight.test.ts`)

ローカル画像が最大許容サイズ（50 MiB = 52,428,800 バイト）を超過した場合に `runPreflightChecks` が `LOCAL_IMAGE_SIZE_EXCEEDED` を返すことを直接アサートするテストケースを追加する。

- **I/O 最適化**: 実体 53 MB のバイナリ作成を避け、スパースファイル（`fs.openSync` + `fs.ftruncateSync(fd, 52_428_801)` または `fs.truncateSync`）を用いることでディスク消費・書き込み時間をゼロ化する。
- **境界値検証**: 52,428,800 バイト（上限ちょうど）は通過、52,428,801 バイト（+1 バイト）で拒否される両系を検証する。

#### C. Guard Test Coverage Gate の新設（`tests/guards.test.ts` Rule 5）

静的解析専用である `tests/layering.test.ts` ではなく、すでに `GUARD_REGISTRY` 監査基盤を持つ **`tests/guards.test.ts` に Rule 5 を新設** する（A-1〜A-3, R-1〜R-3 を反映）：

- `GUARD_REGISTRY` 内の全 19 ガードから、`guard.codes` が空配列である 3 種（G1: `SINGLE_TARGET_GUARD`, G7: `TITLE_DUPLICATION_AUTOTRIM`, G8: `UNSUPPORTED_SYNTAX_WARNING`）を除外した **16 ガード**（単一 code 14 ガード ＋ G5 2 code ＋ G11 4 code）を対象とする。
- 対象ガードの `codes` 配列を平坦化し、計 **20 種の一意なエラーコード** を走査対象とする。
- `tests/` 配下の全テストコードのうち、名前列挙 snapshot で固定した除外リスト `['tests/guards.test.ts', 'tests/presentation_symmetry.test.ts']`（動的走査ファイル）を除く全ファイルを走査し、各エラーコード名が string リテラルとして 1 回以上アサート・参照されていることを検証する。
- 順序依存対策: G17 および G11 の是正と Rule 5 の追加は同一ステップ（Step 4）で実施し、テストスイートの Green を維持する。

---

### 2.4 AGENTS.md ガバナンス規則の制度化と Workspace Contracts 同期

#### A. Ask First（事前承認制ルール）

以下の操作は、コードの変更・追加・削除を実行する前に **必ず人間のユーザーに確認を取り、承認を得てから着手する**：

1. **新規 npm パッケージの追加**: `package.json` の `dependencies` / `devDependencies` に新たな外部ライブラリを追加する場合。
2. **ストレージ・基底スキーマの変更**: SQLite `cache.db` スキーマ（`migrations.ts`）、`base_snapshots` テーブル、Frontmatter スキーマ（`FrontmatterSchema`）の定義を変更する場合。
3. **公開 Facade / Orchestrator API の破壊的変更**: `pullBatch`, `pullSingleArticle`, `pushArticle`, `pushAll` などの引数・戻り値の型シグネチャを改変する場合。
4. **仕様ドキュメントの削除・大幅改変**: `docs/` 直下の正典仕様書（`media-id-spaces.md` 等）や `AGENTS.md` のコア原則を削除・変更する場合。

#### B. Commit Readiness Checklist（コミット前自己点検チェックリスト）

コミットを作成する前に、AI エージェントおよび開発者は以下のチェックリストをすべて検証しなければならない：

- [ ] **変更差分の局所化**: `git status` / `git diff` を確認し、要求されたタスクに無関係なファイルや不要なリファクタリングが含まれていないこと。
- [ ] **ドキュメント・コードの整合性**: 実装コードの条件分岐や不変条件（例: Two-Track リビジョン、レイヤー境界）が、`AGENTS.md` の記述と 1 文字の矛盾もなく同期していること。
- [ ] **非 CLI ログの非汚染**: `src/cli/` 以外のモジュールに `console.log` / `console.debug` が混入していないこと（Axis 5 PASS）。
- [ ] **循環依存の非混入**: `npm run check:cycles` が 0 件で通過すること。
- [ ] **レイヤリング・ガード網羅性の遵守**: `tests/layering.test.ts`（Axis 0〜5）および `tests/guards.test.ts`（Rule 1〜5）が PASS し、`ALLOWED_LAYER_2_SYMBOLS` に不要なシンボルが追加されていないこと。
- [ ] **テストの完全性**: `npm test` で全テストが PASS し、変更した機能に直接対応するテストケース（成功系＋ガード拒否系）が存在すること。
- [ ] **静的品質ゲート通過**: `npm run check`（Prettier, TypeScript 型検査, 循環検査, Vitest）がすべて Green であること。

#### C. Workspace Contracts の AGENTS.md 同期

- AGENTS.md:42 の Workspace Contracts 定義に、`hash.ts` 新設（`calculateHash in src/sync/workspace/hash.ts`）を明記し、ドキュメントとの完全一致を維持する。

---

### 2.5 ドキュメント正典索引（`docs/README.md`）の構築

`docs/README.md` を作成し、ドキュメントの役割を明確に分類する。

```markdown
# Emit Documentation Index

Emit ワークスペースのドキュメント索引です。現在の実装仕様の真理（Truth）は「1. 正典仕様書」に定義されています。

## 1. 正典仕様書（Authoritative Specifications）

AGENTS.md 等から直接参照され、現在のシステム挙動、データモデル、外部連携仕様を定義する最新の正典です。

- [media-id-spaces.md](./media-id-spaces.md) — D1 record `id` と R2 `storageKey` の二重識別子空間仕様（AGENTS.md:20-22 で指定）
- [npm-publish-guide.md](./npm-publish-guide.md) — パッケージ公開およびリリース手順

## 2. 過去の設計仕様書（Historical Specifications & Backlogs）

過去の大型改修時の設計仕様書およびバックログです。

- [local-first-media-pipeline-plan.md](./local-first-media-pipeline-plan.md) — ローカルファーストメディア同期設計（v0.1.29）
- [v0114-backlog.md](./v0114-backlog.md) / [v0125-backlog.md](./v0125-backlog.md) — バックログアーカイブ

## 3. バージョン実装計画書（Historical Implementation Plans）

各リリースごとの設計、レビュー、検証記録のアーカイブです（計 21 ディレクトリ）。

- [v0.1.33 計画書](./v0133-plan/README.md) — 静的品質ゲート拡充・循環依存根絶・運用ガバナンス
- [v0.1.32 計画書](./v0132-plan/README.md) — バッチ PULL の Orchestrator 集約・ドラフト初回取得是正
- ... (過去の v0.1.12〜v0.1.31 計画書)
```

---

## 3. 実装手順とタスク分解

| Step       | 作業内容                                                                   | 対象ファイル                                                            | 検証方法                                                                              |
| ---------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Step 1** | 循環 import 2 件の解消（`hash.ts` 新設、`MEDIA_FILE_ROUTE_PREFIX` 移動）   | `src/sync/workspace/`, `src/utils/`, `src/sync/`                        | `npx -y madge --circular --extensions ts src/` が 0 件になること                      |
| **Step 2** | `madge` の devDependency 追加と scripts / CI 更新                          | `package.json`, `.github/workflows/ci.yml`                              | `npm run check:cycles` で確認（exit code 0）                                          |
| **Step 3** | `tests/layering.test.ts` に Axis 5（`console.log` 禁止）を追加             | `tests/layering.test.ts`                                                | `npx vitest run tests/layering.test.ts` PASS 確認（6→7 passed）                       |
| **Step 4** | Guard G17 / G11 テスト是正 & `tests/guards.test.ts` に Rule 5 追加（同時） | `tests/sync.test.ts`, `tests/preflight.test.ts`, `tests/guards.test.ts` | `npx vitest run tests/sync.test.ts tests/preflight.test.ts tests/guards.test.ts` PASS |
| **Step 5** | `docs/README.md` 索引ドキュメントの新規作成                                | `docs/README.md`                                                        | ファイル配置とリンク検証                                                              |
| **Step 6** | `AGENTS.md` に Ask First 節、Checklist 節、`hash.ts` 契約同期を追加        | `AGENTS.md`                                                             | ドキュメント整形と記述確認                                                            |
| **Step 7** | `package.json` のバージョンバンプ (`0.1.33`) と総合品質検証                | `package.json`, 全体                                                    | `npm run check` が完全 Green であること                                               |

---

## 4. 完了条件（DoD: Definition of Done）

1. [ ] `npx madge --circular --extensions ts src/`（`npm run check:cycles`）が **0 circular dependencies** を出力すること。
2. [ ] `tests/layering.test.ts` に Axis 5（Non-CLI log isolation）が追加され、全 7 テストが PASS すること。
3. [ ] `tests/guards.test.ts` に Rule 5（Guard test coverage check）が追加され、全 20 種のエラーコードが網羅されて全 5 テストが PASS すること。
4. [ ] `tests/sync.test.ts` で Guard G17 のエラーコード `TAXONOMY_APPLY_PENDING`、および `tests/preflight.test.ts` で `LOCAL_IMAGE_SIZE_EXCEEDED` が直接 assert されていること。
5. [ ] `.github/workflows/ci.yml` に `check:cycles` ステップが組み込まれていること。
6. [ ] `AGENTS.md` に「Ask First」、「Commit Readiness Checklist」、および `hash.ts` 契約が記載されていること。
7. [ ] `docs/README.md` が作成され、正典とアーカイブが整理されていること。
8. [ ] `package.json` のバージョンが `0.1.33` に更新されていること。
9. [ ] `npm run check`（Prettier, TypeScript, Cycles, Vitest）がすべて PASS すること。
