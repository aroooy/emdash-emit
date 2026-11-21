# v0.1.36 計画書 (Rev.5): Local-First メディア解決と Tier 3 不透明ブロック保護の共存モデル確立・ドキュメント体系化および実行時ガイダンス実装

## 1. 概要・目的

v0.1.35 において、EmDash Web 管理画面で画像に対して設定された装飾・レイアウト属性（`alignment: left/center/right`、`displayWidth/Height` 等）が `emit pull` 時に脱落し、`emit push` で初期化される事故を防止するため、拡張属性付き画像ブロックを **Tier 3 不透明ブロック（`<!--ec:block ... -->`）** へ自動フォールバックさせる保護機構を導入した。

この保護機構によりサーバー側の属性完全保持（Round-trip Fidelity）は達成されたが、Emit が誇る中核機能である **「メディア PULL 時のローカル相対パス自動変換（Local-First）」** と共存した結果、1つの記事ファイル内に以下の2つの異なる表現が混在することとなった：

1. **プレーンな画像（拡張属性なし）**: `![alt](../../media/<storageKey>.<ext>)`（標準 Markdown 記法 ＆ ローカル相対パス）
2. **装飾・レイアウト付き画像**: `<!--ec:block {"_type":"image",...,"url":"/_emdash/api/media/file/<storageKey>",...} -->`（HTML コメント ＆ リモート相対パス）

ここで重要なアーキテクチャ上の事実は、**「装飾・拡張属性付き画像（Tier 3）は、サーバー側の属性保持（Round-trip Fidelity）を最優先した結果として、ローカルプレビュー（Local-First）を意図的に諦める代償を払っている」** という点である。

このトレードオフと言語化が不足していると、ローカルエディタで執筆・推敲を行う人間および自律的に記事を編集する AI エージェント双方にとって：
- 「なぜ一部の画像だけプレビューで見えて、別の画像は見えない（コメント化されている）のか？」
- 「ローカルの `media/` に画像がダウンロードされているのに、なぜ本文で参照されないのか？」
- 「`<!--ec:block ... -->` の中にある URL や JSON は編集して良いのか？ 消したらどうなるのか？」
- 「新しく画像を追加・挿入する際は、どちらの記法で記述すべきなのか？」

という重大な認知的負荷・混乱を招くリスクがある。

本計画では、この **「Local-First プレビュー」と「Round-trip 属性保護」の二重モデル（The Dual-Track Image Model）** をドキュメントおよびプログラムの双方で体系化・可視化し、執筆者が迷わず安全に執筆・編集できる環境を確立する。

---

## 2. 現状の課題と技術的検証（Real Gaps）

### 2.1 課題 1: ドキュメントの乖離とトレードオフの未言語化
- **`README.md` の記述が陳腐化**:
  - `EmDash Custom Block Preservation` セクション（469–471行目）が旧来の2行ブロック構文（`<!--ec:block type="core:gallery"...--><!--/ec:block-->`）のサンプルとなっており、現在の単行 JSON 構文（`<!--ec:block {...} -->`）および v0.1.35 で追加された画像ブロックのフォールバック仕様が反映されていない。
  - `localMediaRefs`（Local-First）と Tier 3 不透明フェンスの関連性が未説明であり、「なぜローカルミラーが存在するのにリモート URL のままコメント化されるのか」の理由（生 JSON をそのまま EmDash に返すため）が言語化されていない。
- **執筆ルールの欠落**:
  - 画像を新規追加するときの手順（素の Markdown で書けば自動解決されること）や、保護されたブロックの移動・削除方法が明文化されていない。
- **`AGENTS.md` の規範不足**:
  - AI エージェントに対する指示として、`<!--ec:block ... -->` を通常のテキストとして勝手に書き換えたり JSON を壊したりしないための行動規範が不足している。

### 2.2 課題 2: 執筆時・編集時の混乱（UX / DX）
- Markdown プレビュー（VS Code, Obsidian, Typora 等）で記事を開いた際、素の画像は美しくプレビューされるのに対し、位置揃えやサイズ指定された画像は「コメント」扱いとなりプレビューから消える。
- 執筆者が「Pull に失敗して画像が壊れたのではないか」と誤認する恐れがある。

### 2.3 課題 3: プログラム実行時フィードバックの欠如と制約（設計上の穴の特定）
- `emit pull` や `sync_pull` を実行した際、記事内に不透明ブロックが保護された事実が出力サマリに表示されない。
- **fast-path skip 経路におけるカウント保持（Real Gap 1）**:
  - リモート改版が進んでいない記事は `tryFastPathOrHeal`（`src/sync/pull/fast_path.ts`）で 0-HTTP スキップ（`skipped: true`）される。
  - この skip には以下の 2 種類が存在する：
    1. **純粋 skip（L326）**: リモート改版一致かつローカル未編集（`skipped: true`）。
    2. **ローカル編集保持 skip（L377–386）**: リモート改版一致だがローカルに未 push 編集あり（`skipped: true, localEditsPreserved: true`）。
  - **重要**: ローカル編集を行っている最中こそ、ユーザーや AI が誤って `<!--ec:block ... -->` を消したり改変したりしやすい最も危険な局面である。したがって、純粋 skip のみならず **`localEditsPreserved` 分岐においても `preservedBlocks` を格納し、ヒントを表示する（推奨 A を採用）**。
  - **不変性（Invariance）**: Tier 3 フェンス（`<!--ec:block ... -->`）は `localizeArticleMediaRefs` の書き換え対象外であるため、canonical（baseline）でも disk でも不透明フェンスの内容・行数は 100% 同一である。
  - `fast_path.ts:90` では既に `currentDiskContent`（ディスク上の本文）が読み込み済みであり、各分岐で再利用されているため、追加 I/O やネットワーク通信を発生させることなく、手元の `currentDiskContent` からブロック数を 0 コストで算出可能である。
- **フル pull 経路におけるカウント基準（Real Gap 1-B）**:
  - ローカル編集と baseline が乖離し `quarantineDivergentLocalCopies` が発火して旧コピーが `posts/conflicts/` に隔離された場合、`preservedBlocks` は**新しくディスクに書き込まれた canonical（remote 由来）本文**のブロック数を集計・報告する（隔離通知 `formatQuarantineNotice` と合わせて表示するため基準の混乱は生じない）。
- **コードフェンス内の誤検知（Real Gap 2）**:
  - 単純な正規表現スキャン（`extractOpaqueBlockLines`）を行うと、Markdown のコードブロック（```` ``` ````）内に書かれた解説用サンプルコードを実在の保護ブロックとして誤カウントしてしまう。
  - 既存の preflight guard（`src/sync/preflight.ts:458`）と同様に、`stripCodeBlocks()` を経由させてコードブロックを除外してカウントする必要がある。
  - `stripCodeBlocks` が挿入するプレースホルダー sentinel（`\u0000__EMIT_CODE_BLOCK__\u0000`）は `OPAQUE_FENCE_PATTERN` にマッチしないため、コードブロック内サンプルは正確に 0 件として除外される。
- **レイヤリング責務の純粋性（Real Gap 3）**:
  - Presentation 層（`src/presentation/`）が Markdown 本文を解析してブロック数を数えると、ドメイン計算が表示層に漏洩する。
  - カウント関数本体は Layer 0（`src/client/portable-text.ts`）に配置し、Layer 2（`src/sync/pull/`）がこれを呼んで `PullResult.preservedBlocks` に格納、Layer 3（`src/presentation/pull_report.ts`）は純粋な文字列整形に徹する。

---

## 3. 設計方針と解決策（The Triad Model）

本リビジョンでは、**「① ドキュメンテーション」・「② 実行時フィードバック（CLI / Presentation）」・「③ AI ガイダンス（MCP）」** の 3 軸で補強を実施する。

```text
┌─────────────────────────────────────────────────────────────┐
│                 The Triad Guidance Model                    │
├──────────────────────────────┬──────────────────────────────┤
│ 1. Documentation (思想・規範) │ 2. Presentation (実行時認知) │
│ - README.md: Dual-Track 解説  │ - pull サマリでの block 数表示│
│ - AGENTS.md: AI 編集安全規範  │ - 扱い方のワンラインヒント   │
├──────────────────────────────┴──────────────────────────────┤
│ 3. Agent Protocol (MCP)                                     │
│ - sync_pull / sync_push / sync_diff Description ガイダンス  │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 設計思想の言語化: The Dual-Track Image Model

Emit における画像表現は、対立する2つの価値を両立するための「必然的な二重トラック」として定義・説明する。特に **Track B は CMS 属性保持のためにローカルプレビューを意図的に諦めている** ことを明確にする：

| トラック | 対象画像 | 本文での出力表現 | エディタプレビュー | 設計思想・主目的とトレードオフ |
|---|---|---|:---:|---|
| **Track A: Plain Image** | 拡張属性なしの素の画像 | `![alt](../../media/<storageKey>.<ext>)` | 🖼️ **可能** | **Local-First（オフラインプレビュー最優先）**<br>ローカル Markdown エディタでの視認性とポータビリティを確保。 |
| **Track B: Preserved Block** | `alignment`, `displayWidth` 等の属性付き画像、カスタムブロック | `<!--ec:block {"_type":"image",...,"url":"/_emdash/api/media/file/<storageKey>",...} -->` | ❌ **不可**（コメント） | **Round-trip Fidelity（CMS属性保持最優先）**<br>標準 Markdown で表現不能な属性の消失・先祖返りを完全防止。<br>※サーバー生 JSON を保護するため、ローカルプレビューは意図的に犠牲にされる。 |

### 3.2 執筆ルール標準（Golden Path for Images）

人間および AI が記事を執筆・編集する際のシンプルな鉄則を確立する：

1. **画像の新規追加**:
   - 常に標準 Markdown 記法 `![alt](../../media/drafts/my-image.png)`（または既存の `/_emdash/api/media/file/<storageKey>`）で記述する。
   - 執筆者が手動で `<!--ec:block ... -->` を組み立てる必要は一切ない。Push 時に Emit が自動的に適切なブロックとして EmDash に登録する。
2. **保護された画像の移動**:
   - コメント行（`<!--ec:block ... -->`）全体をそのまま切り取り、目的の位置に貼り付ける。
3. **保護された画像の削除**:
   - コメント行（`<!--ec:block ... -->`）全体を削除する。
4. **属性（alignment 等）の変更**:
   - EmDash Web 管理画面で行うことを強く推奨。手動での JSON 直接編集は非推奨（構文破壊時は Guard G9 で安全に弾かれる）。

### 3.3 データ経路とレイヤリング設計（Layer 0 → Layer 2 → Layer 3）

ドメイン計算と表示整形の責務を厳格に分離する：

```text
[Layer 0: client/portable-text.ts]
  countPreservedOpaqueBlocks(markdown: string): number
  - stripCodeBlocks(markdown) を通してコードフェンスを除外
  - extractOpaqueBlockLines() でブロック数を安全にカウント
         ▲
         │ (import)
[Layer 2: sync/pull/ (index.ts & fast_path.ts)]
  pullArticle / tryFastPathOrHeal
  - Markdown 生成後または fast-path 各判定時に countPreservedOpaqueBlocks() を呼ぶ
  - PullResult.preservedBlocks に格納
         │
         ▼ (result)
[Layer 3: presentation/pull_report.ts]
  formatPreservedBlocksHint(count: number, indent?: string): string
  - count <= 0 のときは空文字列 '' を返却（既存フォーマッタ慣行に完全準拠）
  - 純粋な文字列生成（console.log は呼ばず Axis 5 準拠）
```

- **Layer 0 カウント関数の新設 (`src/client/portable-text.ts`)**:
  ```ts
  /**
   * Counts valid opaque block fences (`<!--ec:block ... -->`) in Markdown body,
   * strictly excluding code fences (``` ... ```).
   */
  export function countPreservedOpaqueBlocks(markdown: string): number {
    const cleaned = stripCodeBlocks(markdown);
    return extractOpaqueBlockLines(cleaned).length;
  }
  ```
- **Layer 3 ヒント文字列フォーマッタ (`src/presentation/pull_report.ts`)**:
  ```ts
  /**
   * Formats a hint message when an article contains preserved opaque blocks.
   * Returns empty string when count is 0 or negative.
   */
  export function formatPreservedBlocksHint(count: number, indent = ''): string {
    if (count <= 0) return '';
    return `${indent}💡 Preserved ${count} styled/custom block(s) (<!--ec:block ... -->) retaining alignment/layout.`;
  }
  ```

### 3.4 出力スコープと各経路の挙動（推奨 A）

ヒント出力のスコープを網羅的かつ的確に定義する：

1. **単一記事 pull (`emit pull <path|id>`, `sync_pull(filePath|id)`)**:
   - **更新時（`updated: true`）**: `✅ Pulled ...` の直下にインデント付きでヒントを出力。
   - **純粋スキップ時（`skipped: true && !localEditsPreserved`）**: `ℹ️ Article ... is already up-to-date` の直下にヒントを出力。
   - **ローカル編集保持時（`localEditsPreserved: true`）**: `🛡️ Kept 1 local edit(s)...` の直下にヒントを出力。
     ※執筆中のユーザーに対して「保護ブロックが存在するため、編集時に消さないよう注意」を確実に喚起する。
2. **バッチ pull (`emit pull`, `sync_pull`)**:
   - 実際に更新された記事（`updated: true` かつ `!skipped`）の進行ログ行、およびローカル編集が保持された記事（`localEditsPreserved: true`）の進行ログ行に表示。
   - 未改版でスキップされた大量の純粋スキップ記事（`skipped: true && !localEditsPreserved`）に対してはノイズ防止のため個別表示しない。

### 3.5 MCP Tool Description の改訂

`src/mcp/tools/sync-pull.ts`, `src/mcp/tools/sync-push.ts`, `src/mcp/tools/sync-diff.ts` の tool description / parameters description に、AI エージェント向けガイダンスを追加する：

> *"Note on preserved blocks: Articles may contain `<!--ec:block ... -->` comment fences that preserve custom blocks or styled images (alignment, displayWidth). Keep these comment lines intact when editing text. To add new images, always use standard Markdown syntax (`![alt](../../media/drafts/...)`)."*

---

## 4. Ask First Policy 該当事項の確認と承認記録

本計画における `PullResult` へのフィールド追加について、AGENTS.md §5 のポリシー適合性を確認し、承認を記録する：

| カテゴリ | 該当性 | 承認ステータス・影響 |
|---|:---:|---|
| 1. New npm packages | 該当なし | 外部パッケージ追加なし（0 依存）。 |
| 2. Persistence schema modifications | 該当なし | SQLite キャッシュや `config.json` スキーマ変更なし。 |
| **3. Public Facade / Orchestrator API breaking changes** | **確認対象** | **【承認済み】** `PullResult`（`src/sync/pull/types.ts`）にオプショナルプロパティ `preservedBlocks?: number` を追加。シグネチャの破壊（breaking change）ではなく後方互換な拡張であり、`orchestrator.ts` 経由でも自動透過される。 |
| 4. Specification deletions / core revisions | 該当なし | 正典仕様の削除なし。エピステミック原則・Local-First 原則と完全合致。 |

---

## 5. 影響範囲・ファイル変更リスト

| ファイル | Layer | 変更区分 | 変更内容 |
|---|---|---|---|
| `src/client/portable-text.ts` | Layer 0 | 追加 | `countPreservedOpaqueBlocks()` 関数の実装（`stripCodeBlocks` 経由で sentinel 影響なし） |
| `src/sync/pull/types.ts` | Layer 2 | 改訂 | `PullResult` に `preservedBlocks?: number` を追加 |
| `src/sync/pull/index.ts` | Layer 2 | 改訂 | pull 成功時に `countPreservedOpaqueBlocks()` でブロック数を集計し格納 |
| `src/sync/pull/fast_path.ts` | Layer 2 | 改訂 | `tryFastPathOrHeal()` の純粋 skip、heal、および `localEditsPreserved` 分岐の全戻り値に手元の `currentDiskContent` から集計した `preservedBlocks` を格納 |
| `src/presentation/pull_report.ts` | Layer 3 | 追加 | `formatPreservedBlocksHint()` 純粋フォーマッタの実装（0件時は `''` 返却） |
| `src/cli/commands/pull.ts` | Layer 3 | 改訂 | 単一 pull（updated / skipped / localEditsPreserved）およびバッチ pull ログにヒント出力を統合 |
| `src/mcp/tools/sync-pull.ts` | Layer 3 | 改訂 | pull レスポンス文字列にヒントを反映、Tool Description を改訂 |
| `src/mcp/tools/sync-push.ts` | Layer 3 | 改訂 | Tool Description に AI 向け保護規範を追加 |
| `src/mcp/tools/sync-diff.ts` | Layer 3 | 改訂 | Tool Description に AI 向け保護規範を追加 |
| `README.md` | Docs | 改訂 | `EmDash Custom Block Preservation` 刷新（最新単行 JSON 構文）、Dual-Track 表と執筆ルール、目次・相互リンク更新 |
| `AGENTS.md` | Docs | 改訂 | AI 向け行動規範に Tier 3 不透明ブロック保護と画像執筆手順を追加 |
| `tests/pull_report.test.ts` | Test | 新設 | `formatPreservedBlocksHint()` の単体テスト（0件、1件、複数件、インデントの網羅） |
| `tests/portable-text.test.ts` | Test | 追加 | `countPreservedOpaqueBlocks()` のコードフェンス除外テスト（fence 内サンプル → 0件、sentinel 混入でも正常）を追加 |

---

## 6. 実装および検証手順

### Phase 1: カウント関数・データ経路・フォーマッタの実装
1. `src/client/portable-text.ts` に `countPreservedOpaqueBlocks()` を実装し、`tests/portable-text.test.ts` でコードフェンス除外（code fence 内のサンプルは 0 件、sentinel 影響なし）を検証。
2. `src/sync/pull/types.ts` の `PullResult` に `preservedBlocks?: number` を定義。
3. `src/sync/pull/index.ts` および `src/sync/pull/fast_path.ts`（純粋 skip、heal、`localEditsPreserved` 分岐を含む全経路）で `countPreservedOpaqueBlocks()` を呼び出し、`preservedBlocks` を格納。
4. `src/presentation/pull_report.ts` に `formatPreservedBlocksHint` を実装（0件時は `''` 返却）。
5. `tests/pull_report.test.ts` を新設し、単体テストを網羅。

### Phase 2: CLI / MCP 出力への統合と Tool Description 改訂
1. `src/cli/commands/pull.ts` の単一 pull（更新・スキップ・ローカル編集保持の 3 経路）およびバッチ pull ログにヒントを接続。
2. `src/mcp/tools/sync-pull.ts`, `sync-push.ts`, `sync-diff.ts` の Description を改訂。
3. `npm run check`（フォーマット、型チェック、テスト全通過）を確認。

### Phase 3: ドキュメンテーション体系化
1. `README.md` を改訂：
   - 469–471 行目の旧構文サンプルを単行 JSON 構文へ刷新。
   - Dual-Track Image Model の表（エディタプレビュー可否を含む）と執筆鉄則を追加。
   - 目次のアンカーおよび `localMediaRefs` セクションとの相互リンクを整合。
2. `AGENTS.md` を改訂：
   - AI エージェントの Golden Path に不透明フェンス保護・画像執筆ルールを追記。
3. `docs/README.md` のインデックスを確認・更新。

### Phase 4: 実機検証
1. 拡張属性付き画像を含む実機ファイル（`posts/draft/20261115_01M7EYR88T87H4Q6DMQV8XD9BD-メディアPULLしたときの体裁確認.md`）に対して `emit pull` を実行し、ヒント表示が更新時・スキップ時・ローカル編集保持時で意図通り出力されることを確認。
2. 全 64 テストファイルが通過することを確認。

---

## 7. Commit Readiness Checklist

- [ ] **Localized Diff**: 変更がドキュメント、プレゼンテーション層、MCP 定義、`PullResult` の非破壊拡張、および Layer 0 の純粋な集計関数追加（既存挙動への改変なし）に限定されているか。
- [ ] **Architectural Layering**: Layer 3 が本文解析を行わず（Layer 0 の関数を Layer 2 が呼び出し、Layer 3 は受け取ったカウントを表示するのみ）、非 CLI モジュールで `console.log` を呼んでいないか（Axis 0〜5 完全準拠）。
- [ ] **Code Fence Exclusion**: Markdown コードブロック（```` ``` ````）内のサンプルを誤カウントしないことが単体テストで担保されているか。
- [ ] **Expectation Honesty**: 単一 pull でのスキップ時およびローカル編集保持時（`localEditsPreserved`）にも手元ディスクからカウントが提供され、バッチ pull では更新時・ローカル編集保持時のみ表示される仕様が遵守されているか。
- [ ] **Round-trip Fidelity**: 既存の Tier 3 不透明ブロック保護テスト（`tests/portable-text.test.ts`, `tests/preflight.test.ts`）が 100% 通過しているか。
