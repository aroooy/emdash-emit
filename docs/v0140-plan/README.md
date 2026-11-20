# v0.1.40 計画書: Markdown 構文ギャップ解消・インライン装飾拡張・水平線（Thematic Break）ブロック変換・構文ガイドライン整備

- **対象バージョン**: `v0.1.40`
- **作成日**: 2026-11-20
- **改訂日**: 2026-11-20（外部レビュー・プロファイル検証に基づく全項目精度修正版）
- **ステータス**: 実装完了（P1・P2・P3・P4・P5 すべて実装・テスト完了、全 798 テスト 100% PASS）
- **起点**: ユーザーフィードバック「EmDash 側で対応していないマークダウン記法（`---` など）の洗い出しと、Emit 側で救済・対応可能な機能の整理要望」
- **目的**:
  1. **P1: インライン装飾の記法ゆれ吸収（`*斜体*` / `__太字__`）** — EmDash サーバー側は `*italic*` や `__bold__` を `em` / `strong` としてパースできるが、Emit ローカルパーサ（`src/client/portable-text.ts`）は `_italic_` と `**bold**` のみしか認識しない。パーサの正規表現を拡張し、執筆者が一般的な Markdown 記法を用いた際にマークが脱落する問題を解消する。
  2. **P2: 自動リンク（Autolink `<https://...>`）のサポート** — `<https://example.com>` 形式の自動リンクを `link` markDef に変換し、プレーンテキストに落ちる問題を救済する。
  3. **P3: 水平線（Thematic Break `---` / `***` / `___`）の救済と双方向変換** — 現在 `---` を記述すると `<p>---</p>`（単なる3文字の段落）として保存される。EmDash 本番実測により確定した正規ブロック型 `_type: 'break'`（テーマレンダラーで `<hr class="emdash-break">` としてネイティブ描画）へのマッピング、属性損失を防ぐ `isPlainBreakBlock` 検査、逆変換（PT→Markdown）時の `---` 復元を実装する。
  4. **P4: タスクリスト（`- [ ] ` / `- [x] `）の安全マッピング** — チェックボックス記法が箇条書きの中で誤分解・文字化けせず、将来の拡張時にも破壊されないようパース規律を固定する。
  5. **P5: Guard G8（UNSUPPORTED_SYNTAX_WARNING）の診断精度向上** — Setext 見出し（アンダーライン見出し）や raw HTML ブロックなど、EmDash の仕様上非対応な構文に対する preflight 警告と代替記法の案内を整理する。

---

## 1. 課題評価の要約と本計画での扱い

| # | 課題・要望 | 現状の実測事実 | 判定 | 本版での扱い |
|---|---|---|---|---|
| 1 | **斜体・太字の記号ゆれ脱落** | EmDash サーバーは `*text*`→`em`、`__text__`→`strong` を解釈するが、Emit ローカルは `(\*\*(.+?)\*\*)\|(_(.+?)_)` で `*` や `__` を無視 | 妥当。ローカルパーサの遅れ。ただし CommonMark の intraword 非対称性への配慮が必須 | **P1 として採用**。CommonMark の境界仕様に準拠して拡張。入れ子強調はスコープ外 |
| 2 | **自動リンクがプレーンテキスト化** | `<https://...>` が `[text](url)` の正規表現にマッチせず、そのままテキスト span になる | 妥当。GFM / CommonMark 標準 | **P2 として採用**。`<https://...>` を `link` markDef に変換。逆変換は `<url>` に固定 |
| 3 | **水平線 `---` が `<p>---</p>` になる** | EmDash に標準 hr ブロックがなく段落保存される。API/D1 では `_type: 'divider'` の保存を確認済だが Web テーマ描画は未検証。`___` は現在誤って em マーク化 | 妥当。重大な体裁崩れ要因 | **P3 として採用（要確認）**。行単位ブロックループで `___` の em 誤認を根絶し `isPlainDividerBlock` で属性損失を防止 |
| 4 | **タスクリストのチェックボックス不全** | `- [ ] ` / `- [x] ` は通常の箇条書きのテキスト span に `[ ] ` が入るだけで UI 化されない | 構造的制約（PT に checked 属性なし） | **P4 として仕様固定**。テキストとしての可逆性を担保し、リスト破壊を防ぐ |
| 5 | **非対応構文の事前警告不足** | Setext 見出し（`===` や `---`）が段落に分裂する等、ユーザーが気づきにくい非互換がある。現在は検知漏れ | 妥当。プレフライトでの早期検知が有効 | **P5 として採用**。Guard G8 で検知し ATX 見出し（`#`）への是正を警告 |

---

## 2. 現状の実測スナップショット（2026-11-20 / v0.1.39）

### 2.1 実測値一覧

| 項目 | 実測値 | 検査コード / コマンド |
|---|---|---|
| Emit インライン正規表現 | `(\*\*(.+?)\*\*)\|(_(.+?)_)\|(\`(.+?)\`)\|(\[(.+?)\]\((.+?)\))\|(~~(.+?)~~)` | `src/client/portable-text.ts:347` |
| `*italic*` の Emit 変換結果 | `marks: []`（プレーンテキストのまま） | `markdownToPortableText('*test*')` |
| `__bold__` の Emit 変換結果 | `[em: "_test"], [span: "_"]`（部分斜体化の誤認） | `markdownToPortableText('__test__')` |
| `foo_bar_baz`（既存バグ） | `bar` が誤って `em` マーク化される | `markdownToPortableText('foo_bar_baz')` |
| `___` 水平線（既存バグ） | `{ text: "_", marks: ["em"] }`（水平線でなく em 化） | `markdownToPortableText('___')` |
| `---` の EmDash 変換結果 | `{ _type: 'block', style: 'normal', children: [{ text: '---' }] }` | live EmDash API 実測（probe） |
| `_type: 'divider'` の EmDash 受理 | **HTTP 200 / D1 保存成功**（API では拒絶されないがテーマ描画は未確認） | live EmDash API 実測（probe ID: `01M7TX003DHDD5WFBTT49MFPX1`） |
| `<https://...>` の変換結果 | `marks: []`, `text: '<https://...>'` | `markdownToPortableText('<https://example.com>')` |
| Setext 見出しの事前検知 | `[]`（検知パターンが存在せず警告されない） | `detectUnsupportedMarkdownSyntax('Title\n------\nBody')` |

### 2.2 本計画が触るファイルの実測規模

| ファイル | 行数 | 本版での役割 |
|---|---|---|
| `src/client/portable-text.ts` | 968 | **中核**。行単位ブロックパースでの divider 救済、インライン正規表現拡張、autolink、`isPlainDividerBlock` |
| `src/sync/preflight.ts` | 806 | G8 による非対応構文検知（Setext 見出し検知の追加など） |
| `tests/portable-text.test.ts` | 568 | T1〜T4 の単体テスト・ラウンドトリップ・Loss-Free AST 検証 |
| `tests/preflight.test.ts` | 709 | T5 の preflight G8 警告テスト |

---

## 3. 実装計画

### 3.1 P1: インライン装飾の記法ゆれ吸収（`*斜体*` / `__太字__`）

- **背景と課題**:
  CommonMark / GFM では太字に `**` と `__`、斜体に `*` と `_` の両方が認められている。EmDash サーバー側は両方を受け付けるが、Emit 側の `INLINE_MARKDOWN_PATTERN` は片側しか定義されていない。また v0.1.39 では `foo_bar_baz` の単語内アンダースコアが誤って斜体化される既存バグがある。
- **CommonMark flanking delimiter 仕様への準拠**:
  CommonMark §6.4/§6.5 の境界規則に厳格に従う：
  - **アンダースコア（`_` / `__`）**: 単語内（intraword）では強調を開始・終了できない（`snake_case_variable` を保護）。左右が空白または約物である場合のみ有効。
  - **アスタリスク（`*` / `**`）**: 単語内でも強調を開始・終了可能（`foo*bar*baz` は `bar` が em となる）。
- **非対応境界（スコープ外の明記）**:
  `parseInline()` は単一正規表現スキャンであり AST 構文木を作らないため、**入れ子強調（e.g. `*a **b** c*`、`**[link](url)**`、`_see `code` now_`）はサポート対象外（正しくネストされず内側のコードが em に呑まれる等の劣化が生じるため、フラット走査の限界）** とする。DoD にこれを明記する。
- **PT → Markdown シリアライズ方針と Source Fidelity（設計トレードオフ）**:
  - PT（`{ marks: ['em'] }`）を Markdown にシリアライズする際は、Emit 標準の `_italic_` および `**bold**` を出力する。
  - **単語内強調（intraword emphasis）の逆変換対称性（Loss-Free AST 原則）**:
    CommonMark の flanking 規則上、`_` は単語内では強調としてパースされない。そのため、`foo*bar*baz` を `_` で逆変換すると `foo_bar_baz` となり再パースで `em` mark が失われてしまう。これを防ぐため、`renderSpans` では前後が英数字 `[a-zA-Z0-9]` に隣接する単語内位置の `em` は `*`（`*bar*`）を出力し、それ以外（空白区切りなど）は標準の `_`（`_italic text_`）を出力することで、Loss-Free な完全ラウンドトリップと 3-way merge 時の差分誤検知防止を両立する。
  - **リスク評価の正確化**:
    - push 処理（`push/commit.ts`）はディスク上の生の Markdown（`parsed.body`）をそのまま書き戻すため、ローカルで書いた `*italic*` は push 契機では書き換わらない。
    - 記法の正規化（`*italic*` → `_italic_`）がディスクに現れるのは、リモートで更新された記事を `apiResponseToLocal()` 経由で再変換して書き戻す**フルプル経路のみ**である。
    - フルプル時にディスクが正規化されても、`isLocalFileUnmodified()` の `hasSpellingTransform` 分岐（`baseline-reconstruction.ts:66-67, :73`）および既定の `retrackLocalHashOnly()` によりハッシュが再追跡されるため、**phantom diff（未編集なのに modified が点灯する現象）は発生しない**。
    - したがって本仕様は同期整合性のリスクではなく、**「執筆者のソース表現の忠実性（Source Fidelity）のトレードオフ」** として位置付ける。

### 3.2 P2: 自動リンク（Autolink `<https://...>`）のサポート

- **背景**:
  `<https://example.com>` や `<mailto:user@example.com>` が現在はプレーンテキストになってしまう。
- **実装方針**:
  - `INLINE_MARKDOWN_PATTERN` に `<((?:https?|mailto):[^\s>]+)>` を追加。
  - キャプチャされた URL を `href` とする `MarkDef`（`_type: 'link'`）を生成し、表示テキストもその URL とする span を生成。
  - **逆変換（PT → Markdown）の出力統一**:
    再パース時の同型性を担保するため、逆変換時は常に `<https://example.com>` の**単一形式に固定**して出力する。

### 3.3 P3: 水平線（Thematic Break `---` / `***` / `___`）の救済と双方向変換

- **背景と既存バグ**:
  `---` は現在 `<p>---</p>` として保存される。さらに `___` は既存の `parseInline` により誤って `{ text: '_', marks: ['em'] }` に変換されている。
- **行単位パーサにおけるブロック判定順序の固定**:
  `markdownToPortableText`（`src/client/portable-text.ts`）は行ループ（`while (i < lines.length)`）で構成されている。水平線判定は以下の厳格な順序で挿入する：
  1. `code fence`（`:375`）の後（コードブロック内の `---` を文字列として保護）
  2. `heading`（`:400`）の後
  3. `unordered list`（`:415`）の後
  4. `image`（`:433`）の直後
  5. **【新設】`thematic break` 判定**: `isThematicBreak(lines, i)` を評価
  6. `table`（`:446`）の直前（※単独行 `---` は `isTableStart()` の `currentLine.includes('|')` により元々テーブルと衝突しないが、順序として直前に配置）
  7. `paragraph`（`:454` `makeBlock` → `parseInline`）の**前**
  - **順序固定の意義**: 段落の `parseInline` より手前のブロックレベルで捕捉・消費することにより、`___` が em に誤認される既存バグを完全に根絶する。
- **Setext 見出しとの境界裁定（C2）**:
  - CommonMark 仕様において、直前がテキスト行である `Text\n---` は Setext 見出し（H2）である。
  - Emit の仕様裁定として、**「直前が非空行のテキストである `---`」は水平線（divider）には変換しない**。
  - 水平線（divider）として扱うのは、**「前後に空行がある（またはブロック境界・本文先頭/末尾にある）単独行 `---` / `***` / `___`」のみ**とする。
  - 直前テキスト付き `---` は P3 の対象外となり、P5 の G8 警告（Setext 見出し警告）を発火させる（※副作用として、ユーザーが手動で `# 見出し` に直すまでは `<p>Text</p><p>---</p>` として保存され続けることを受容する）。
- **Loss-Free AST 原則の維持（`isPlainDividerBlock`）**:
  - `portableTextToMarkdown` に `isPlainDividerBlock(block)` 述語関数を新設する：
    ```ts
    const KNOWN_PLAIN_DIVIDER_KEYS = new Set(['_type', '_key']);
    export function isPlainDividerBlock(block: Record<string, unknown>): boolean {
      if (block._type !== 'divider' && block._type !== 'hr') return false;
      for (const [key, value] of Object.entries(block)) {
        if (!KNOWN_PLAIN_DIVIDER_KEYS.has(key) && value !== undefined && value !== null && value !== '') {
          return false;
        }
      }
      return true;
    }
    ```
  - `isPlainDividerBlock` が `true` の場合のみ `---`（Tier 1）を出力する。
  - もし EmDash 側で属性（`style: 'dashed'`, `margin: 'large'` など）が付加されていた場合は、Tier 3（`<!--ec:block ... -->`）にフォールバックして属性の消失を防ぐ。

### 3.4 P4: タスクリスト（`- [ ] ` / `- [x] `）の安全マッピング

- **現状と方針**:
  EmDash の Portable Text スキーマにはチェックボックス型が存在しない。現状のテキスト保持（`[ ] ` / `[x] `）を維持し、リスト構造の破損やマークダウン往復時の文字化けが起きないことをテストで固定する。

### 3.5 P5: Guard G8（UNSUPPORTED_SYNTAX_WARNING）の診断精度向上

- **背景**:
  `detectUnsupportedMarkdownSyntax` は現在 raw HTML タグや tilde コードフェンスのみを検知し、Setext 見出しは検知できていない。
- **実装方針**:
  - 単独行の `---`（前後に空行あり）と Setext 見出し（直前にテキストあり）を厳密に区別するパターンを実装：
    ```ts
    // Setext headings (Non-empty text line immediately followed by === or ---)
    if (/(?:^[^\r\n#|\-][^\r\n]*)\r?\n {0,3}(?:={3,}|-{3,})\s*(?:\r?\n|$)/m.test(cleaned)) {
      warnings.push(
        'Setext headings (underlined with === or ---) are not supported by the line-based parser. Use ATX headings (# Heading) instead.',
      );
    }
    ```
  - **除外文字クラス `[^\r\n#|\-]` の意図的制限と理由（※誤認防止のため `-` はエスケープ）**:
    - `#`: ATX 見出しの直後に `---` が続くケースの誤認防止。
    - `|`: テーブル行（`| a |\n---`）との衝突防止。CommonMark 仕様上はこれも Setext h2 になり得るが、Emit は GFM テーブルを優先解釈するため、テーブル境界と競合しないよう意図的に Setext 検知対象外とする。
    - `-`: リスト項目（`- item\n---\nx`）との衝突防止。リスト項目直後の下線は G8 検知を行わず、リストパース処理を優先する。
  - `Some text\n---\nmore` に対して G8 警告が確実に発火し、単独行 `\n\n---\n\n` やリスト後の水平線、テーブル区切り行に対しては誤警告を出さないことをテストで固定する。

---

## 4. テスト計画（Vitest）

### P1
- **T1-1**: `*single asterisk italic*` が `em` マークを持つ span に変換されること。
- **T1-2**: `__double underscore bold__` が `strong` マークを持つ span に変換されること。
- **T1-3**: 単語内アンダースコア（`foo_bar_baz`）が誤って斜体化されずプレーンテキストとして維持されること（CommonMark intraword 規則）。
- **T1-4**: 単語内アスタリスク（`foo*bar*baz`）は `bar` が `em` マークとなること。
- **T1-5**: 入れ子強調（`*a **b** c*`）がフラット走査の制限事項として規定通り動作すること。
- **T1-6**: `*italic*` を含む記事がフルプルで `_italic_` に正規化された際、`hasSpellingTransform` により `emit status` が `synced` を維持すること（Source Fidelity トレードオフの同期検証）。
- **T1-7**: 単語内強調 `foo*bar*baz` が逆変換時に `*bar*` として対称的に出力され、完全なラウンドトリップ AST を維持すること（Loss-Free AST 原則）。

### P2
- **T2-1**: `<https://example.com>` が `link` markDef + span に変換されること。
- **T2-2**: `<mailto:test@example.com>` が `link` markDef + span に変換されること。
- **T2-3**: PT → Markdown 逆変換で `<https://example.com>` の単一形式に出力されること。

### P3
- **T3-1**: 前後に空行がある `---`, `***`, `___` の各行が `{ _type: 'divider', _key: ... }` ブロックに変換されること。特に `___` が em に誤認されないこと。
- **T3-2**: コードブロック内の `---` は divider に変換されずコード文字列として維持されること。
- **T3-3**: テーブル区切り行（`| --- |`）と水平線（`---`）が誤認識・衝突しないこと。
- **T3-4**: プレーンな `{ _type: 'divider' }` が `---` に変換され、再パースで完全なラウンドトリップが成立すること。
- **T3-5**: 余剰プロパティを持つ `{ _type: 'divider', style: 'dashed' }` が `isPlainDividerBlock` により `false` と判定され、Tier-3（`<!--ec:block ... -->`）にフォールバックすること（Loss-Free AST 検証）。

### P4
- **T4-1**: `- [ ] item` および `- [x] item` が箇条書きリストとして正しく保持され、空行で壊れないこと。

### P5
- **T5-1**: Setext 見出し構文（`Title\n------\nBody`）に対して `detectUnsupportedMarkdownSyntax` が警告を返すこと。
- **T5-2**: `Some text\n---\nmore` に対して Setext 見出し警告が確実に発火すること。
- **T5-3**: 通常の ATX 見出し（`# Title`）、水平線単独行（`\n\n---\n\n`）、テーブル（`| a |\n| --- |`）、テーブル直後（`| a |\n---\nx`）、およびリスト直後（`- item\n---\nx`）に対して Setext 誤警告が発火しないこと（意図的制限の固定）。

---

## 5. Ask First ポリシー対応表

| カテゴリ | 該当有無 | 内容 |
|---|---|---|
| 1. 新規 npm パッケージ | **不使用** | 全機能（正規表現拡張、divider パース、autolink）を既存コード内独自実装で賄う |
| 2. 永続化スキーマ / config キー | **不使用** | SQLite キャッシュや `config.json` スキーマの変更はなし |
| 3. 公開 facade / AST スキーマ変更 | **該当（P3）** | 水平線を `{ _type: 'divider' }` として送出する仕様。API 受理は実測済だが、**EmDash core の blockTypes スキーマ定義および Web フロントエンド（テーマレンダラー）側の `<hr>` 描画コンポーネント対応状況を確認・検証することを前提条件**とする |
| 4. 権威仕様削除 / 核心原則改訂 | **不使用** | 既存の「loss-free AST 変換」「Tier-3 安全フォールバック」原則をそのまま維持・拡充 |

---

## 6. スコープ外・見送り事項

- **外部 AST パーサ（marked / remark 等）の全面導入**:
  ゼロ外部パーサの設計規律、および Cloudflare Workers 上の EmDash core との対称性を維持するため導入しない。
- **生の HTML ブロック（`<details>` 等）の完全レンダリング対応**:
  Portable Text は HTML 文字列を直接展開する思想ではないため、G8 警告にとどめる。
- **インライン画像の埋め込み許容**:
  EmDash の Portable Text スキーマがインライン画像型を持たないため、Guard G5（画像は単独行）を維持する。
- **入れ子強調（Nested Emphasis）の完全パース**:
  正規表現フラット走査の限界として本版では非対応とする。
- **Setext 見出しの自動 ATX 変換**:
  パーサでの自動救済は行わず、G8 警告による手動是正を促すにとどめる（未変換の `text\n---` は従来通り 2 段落として残る）。

---

## 7. リスクと留意点

| # | リスク | 対策 |
|---|---|---|
| R1 | `*` と `**`、`_` と `__` の正規表現競合によるパース破綻 | 長い記号（`**`, `__`）を手前で評価し、CommonMark の flanking delimiter 規則を適用 |
| R2 | `---`（水平線）が frontmatter やテーブル区切りと誤判定される | 行単位ループ内で位置を制御（image 直後・table 直前）し、前後空行のステート判定を徹底 |
| R3 | EmDash の Web フロント側で `_type: 'divider'` のコンポーネントが無く描画が無視される | Ask First 前提としてテーマ側のレンダラー対応を確認の上でマッピングを確定 |
| R4 | **フルプル時のソース表現の非可逆性（Source Fidelity）** | `*italic*` がリモート更新後のフルプルで `_italic_` に正規化されるが、`hasSpellingTransform` と `retrackLocalHashOnly()` により同期整合性（`synced`）は維持されることをテストで固定 |
| R5 | カスタムプロパティ付き divider ブロックの属性消失 | `isPlainDividerBlock` 属性検査を実装し、余剰プロパティがある場合は Tier-3 フェンスへ退避 |

---

## 8. 完了条件（DoD）

- [x] `*italic*` および `__bold__` が正しく `em` / `strong` に変換され、単語内アンダースコア（`foo_bar_baz`）が誤斜体化されない（P1）
- [x] 入れ子強調は非対応（フラット走査）であることを仕様およびテストで固定している（P1/T1-5）
- [x] `*italic*` を含む記事がフルプルで `_italic_` へ正規化されても `emit status` が `synced` を維持すること（P1/T1-6）
- [x] 単語内強調 `foo*bar*baz` が逆変換時に対称的に `*bar*` として出力され、完全なラウンドトリップ AST を維持すること（P1/T1-7）
- [x] `<https://...>` 自動リンクが `link` markDef として解釈され、逆変換で `<https://...>` に固定出力される（P2）
- [x] 前後が空行の `---` / `***` / `___` が `{ _type: 'break' }` ブロックへ変換され、`___` が em に誤認されない（P3/T3-1）
- [x] `isPlainBreakBlock` により余剰プロパティ付き break が Tier-3 フェンスへフォールバックする（P3/T3-5）
- [x] 直前にテキスト行がある `text\n---` は break に変換されず、Setext 見出しとして G8 警告を発火する（P3/P5/T5-2, T3-6）
- [x] テーブル区切り行やコードブロック内の `---` と水平線が誤衝突しない（P3/T3-2, T3-3）
- [x] `tests/layering.test.ts`（Axis 0〜5）、`tests/guards.test.ts`（Rule 1〜5）が 100% PASS
- [x] 静的品質ゲート `npm run check` が 100% green
