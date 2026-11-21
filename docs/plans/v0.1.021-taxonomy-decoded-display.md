# EMIT v0.1.21 タクソノミー日本語デコード表示＆安全マッピング 実装計画書 (Rev.6 最終確定版)

> **対象リポジトリ**: `emdash-emit`  
> **起点バージョン**: `v0.1.20` (commit `067d763`, tag `v0.1.20`)  
> **リリース目標バージョン**: `v0.1.21` (Git タグ: `v0.1.21`)  
> **テスト健全性**: 46 files / 531 tests green (`npm run check` 通過確認済み)  
> **文書種別**: 実装基準確定仕様書 (Fix-Spec)  
> **対象要件**: Frontmatter タクソノミーの日本語デコード表示、二層表現（内部 Canonical / 直列化 Decoded）による既存不変条件（SHA-256 Byte 一致・CJK unquoted・Baseline Snapshot 整合・Taxonomy Hash 一貫性）の完全維持  
> **改訂履歴**:  
> - Rev.1: 初版策定  
> - Rev.2: `sync_new` 連携（誤警告防止・ヒント一覧デコード）の統合  
> - Rev.3: Phantom Diff 防止の Heal 機構統合、常時クォート撤回と CJK unquoted 維持、`slugToName` 両引き設計  
> - Rev.4: 二層表現不変条件（Internal Canonical vs. Serialized Decoded）の確立、状態遷移表、`diff.ts` / `status.ts` の `preferEncodedTaxonomy`、`CURRENT_CACHE_SCHEMA_VERSION = 5` 維持  
> - Rev.5: `commit.ts` の canonical snapshot 保証の明示化、`merge.ts` の `normalizeTermList` キー正規化、`carriesPercentEncodedTaxonomy` の厳密判定、全 9 テストファイルの分類表  
> - Rev.6: **N1〜N6 最終補強版**（未 push ローカル編集記事の heal 遅延仕様と実機手順明記、`preferredTermMap` の canonical 優先選択規則の明文化、heal 3 分岐［valid-encoded / broken-encoded / modified-broken］の厳密定義とテスト分離、`conflicts.test.ts` 等の影響なし確認行追加、`AGENTS.md` 更新対象 3 セクションの特定）  

---

## 1. 概要と背景 (Context & Goal)

### 背景と課題
現在、WordPress 等から移行された記事や日本語スラッグを持つ記事において、Frontmatter のタクソノミー（カテゴリ・タグ）は以下のようにパーセントエンコードされた形式で出力されています：

```yaml
taxonomies:
  categories:
    - "%e6%9c%aa%e5%88%86%e9%a1%9e" # 未分類
  tags:
    - "%e3%82%ab%e3%83%a1%e3%83%a9" # カメラ
```

これは EmDash（Cloudflare D1）データベース内の `slug` カラムに URL エンコードされた文字列そのものが格納されているためです。
現状、視認性を補うために `# 未分類` という YAML コメントが自動付与されていますが、以下の課題が存在します：
1. **視認性・可読性の低さ (DXの悪さ)**: パーセントエンコード文字列が並ぶことで、人間や AI が Frontmatter を読んだり編集したりする際の認知的負荷が高い。
2. **AI エージェントの誤編集**: AI がコメント部分をスラッグ本体と誤認したり、編集時にクォートを外して YAML 構文エラーを引き起こすリスクがある。
3. **`sync_new`（v0.1.20）との連携ギャップ**:
   - `sync_new` のヒント一覧に `"%e6%9c%aa%e5%88%86%e9%a1%9e" (未分類)` と難解なエンコード文字列が並んでしまう。
   - 人間や AI が自然な日本語で `emit new my-post -C 未分類` と渡した場合、ローカル定義の生 slug（`%e6%...`）と完全一致しないため「Unknown category slug '未分類'」という誤警告（Spurious Warning）が発生してしまう。

### 目的と中核アーキテクチャ不変条件（Invariants）
Frontmatter のタクソノミーを **自然な日本語（デコード文字列）で表示・入力** できるようにします。
同時に、以下の **Emit の中核的アーキテクチャ不変条件を 1mm も壊さずに実現** します：

1. **二層表現不変条件（Two-Layer Representation Invariant — 最重要）**:
   - **Layer A: 内部データ層（`base_snapshots.frontmatter_yaml` の JSON / `computeTaxonomyHash` / リモート API 通信）**: **常に canonical slug（`"%e6%9c%aa%e5%88%86%e9%a1%9e"`）を保持**する。
   - **Layer B: 直列化・表示層（`formatFrontmatterYaml` / `serializeMarkdown` / ディスク上の `.md` / ヒント出力）**: 入力が canonical slug でも decoded 文字列でも、**YAML 直列化時にデコード表記（`    - 未分類`）を出力**する（ただし旧表記互換オプション `preferEncodedTaxonomy: true` 指定時は除く）。
   - これにより、`baselineMarkdown()` が `base_snapshots.frontmatter_yaml`（canonical JSON）を `serializeMarkdown()` に通した瞬間、自動的に decoded 表記の Markdown が再構築され、**decoded ディスクファイルとの SHA-256 byte-identical 不変条件が恒久的に成立**し、push 時の表記反転（ピンポン現象）も一切発生しない。
2. **SHA-256 Byte 一致原則 & Phantom Diff 防止**:
   - v0.1.21 アップデート直後（`emit pull` 前）の旧表記（`"%e6%..."`）ディスクに対しても、`status` / `diff` は `preferEncodedTaxonomy`（メディアの `preferLegacyRef` と同型の機構）により差分ゼロ（`synced`）を維持する。
   - `emit pull` 実行時に fast-path heal が 1 回だけ発火し、未編集記事のディスク・`base_snapshots.hash`・`sync_state.local_hash` をアトミックに新表記の hash へ昇格させる（2 回目以降は完全 no-op / 冪等）。
3. **CJK Unquoted 不変条件の維持 (`tests/frontmatter.test.ts:223`)**:
   - 「常時ダブルクォート」は行わず、`formatYamlScalar` の安全判定規則（標準 CJK 文字は unquoted、記号入りは auto-quote）を維持する。
4. **キャッシュスキーマ互換 (`CURRENT_CACHE_SCHEMA_VERSION = 5` 維持)**:
   - `base_snapshots.frontmatter_yaml` の JSON 構造・値（canonical slug）は従来と完全同一であるため、DB スキーマバージョンのバンプやキャッシュ全破棄は一切不要。

---

## 2. 要件定義と仕様 (Specification)

### 2.1 Frontmatter の表記仕様

#### 新しい Frontmatter の完全な出力形式（`formatFrontmatterYaml` 準拠）
```yaml
---
id: 01M67N1B5AEVN0XXYSF62N8Y60
slug: my-awesome-post
title: "記事タイトル"
collection: posts
status: draft
publishedAt: null
locale: ja
featuredImage: 01M67P0MBMJQQXH2K95HHCYRYB
taxonomies:
  categories:
    - 未分類
  tags:
    - カメラ
    - "買い物(レビュー)"
    - "C#"
    - tech # 技術
seo:
  title: null
  description: "記事の概要"
  canonical: null
  noIndex: false
  image: null
bylines:
  - aroooy
---
```

#### クォートとコメントのルール（既存不変条件に完全準拠）
1. **デコード ＋ 既存 `formatYamlScalar` の適用**:
   - タクソノミー要素を出力する際（`preferEncodedTaxonomy: true` が指定されていない限り）、パーセントエンコード文字列は `tryDecodeTaxonomyTerm()` でデコードされた上で、既存の `formatYamlScalar()` に渡されます。
   - **安全な CJK 文字列（`未分類`, `カメラ` 等）**: `SAFE_PLAIN_SCALAR_RE`（`^[\p{L}\p{N}_]...`）に適合するため、**クォートなし（unquoted）** で出力されます（`tests/frontmatter.test.ts:223` の `expect(formatYamlScalar('未分類')).toBe('未分類')` をそのまま保護）。
   - **危険な記号を含む文字列（`買い物(レビュー)`, `C#`, `Tips: 設定` 等）**: `SAFE_PLAIN_SCALAR_RE` から外れるため、**既存のロジックにより自動的に `JSON.stringify`（ダブルクォート）** されます。
2. **コメント（`# 名前`）の復元ルール**:
   - `formatFrontmatterYaml` は、`displayTerm = options?.preferEncodedTaxonomy ? term : tryDecodeTaxonomyTerm(term)` を決定した上で、`humanName = slugMap?.[displayTerm] || slugMap?.[term] || slugMap?.[tryDecodeTaxonomyTerm(term)]` で表示名を検索します。
   - `displayTerm`（例: `未分類`）と `humanName`（例: `未分類`）が一致する場合（大文字小文字無視・trim 後）は、**冗長なコメントを自動省略** します。
   - 英語スラッグ等で異なる場合（例: `slug: "tech"`, `name: "技術"`）、または `preferEncodedTaxonomy: true` 指定時（`displayTerm: "%e5%8f%b0%e6%b9%be"`, `humanName: "台湾"`）には、`# 技術` や `# 台湾` のコメントを出力します。

---

### 2.2 二層表現アーキテクチャと状態遷移表 (Two-Layer Representation & State Transitions)

#### 二層表現の原則
- **Layer A（内部 Canonical 層）**:
  - `base_snapshots.frontmatter_yaml`（JSON 文字列内の `taxonomies.categories` / `tags`）
  - `computeTaxonomyHash` に渡される配列
  - `canonicalizeFrontmatterTaxonomies()` 実行後のインメモリ `Frontmatter`
  - リモート EmDash API のリクエスト／レスポンス
  - 👉 **これらは常に canonical slug（例: `"%e6%9c%aa%e5%88%86%e9%a1%9e"`）を保持する。**
- **Layer B（直列化 Decoded 層）**:
  - `formatFrontmatterYaml()` / `serializeMarkdown()` が生成する YAML テキスト（デフォルト時）
  - ワークスペースのディスク上の `.md` ファイル
  - `baselineMarkdown(snapshot, candidates)` が再構築するベースライン Markdown テキスト（デフォルト時）
  - `formatTaxonomiesHint()` が生成する CLI / MCP ヒント文字列
  - 👉 **これらは常に decoded 表記（例: `    - 未分類`）を出力する。**

#### 全オペレーションにおける状態遷移表

| 状態 / 操作 | ディスク (`.md` YAML) | `base_snapshots.frontmatter_yaml` (JSON) | `base_snapshots.hash` & `sync_state.local_hash` | `sync_state.remote_taxonomy_hash` | 備考・不変条件 |
|---|---|---|---|---|---|
| **① v0.1.20 以前（初期状態）** | `"%e6%9c%aa%e5%88%86%e9%a1%9e" # 未分類` | `["%e6%9c%aa%e5%88%86%e9%a1%9e"]` | `SHA256(旧ディスク)` | `SHA256(canonical)` | `local_hash === currentHash` のため `status` / `diff` は即座に `synced` |
| **② v0.1.21 適用後（`pull` 前に本文のみ編集して `status` / `diff`）** | `"%e6%9c%aa%e5%88%86%e9%a1%9e" # 未分類` (+本文変更) | `["%e6%9c%aa%e5%88%86%e9%a1%9e"]` | `SHA256(旧ディスク)` | `SHA256(canonical)` | `carriesPercentEncodedTaxonomy(disk)` が `true` のため、`baselineMarkdown` に `{ preferEncodedTaxonomy: true }` を渡す → タクソノミー行に偽の diff は出ず、本文変更のみが検出される |
| **③ `emit pull` 1 回目（未編集記事: Fast-path Heal 発火）** | `未分類` に書き換え | `["%e6%9c%aa%e5%88%86%e9%a1%9e"]` **(変更なし)** | `SHA256(新ディスク)` にアトミック更新 | `SHA256(canonical)` **(変更なし)** | ディスクの `%e6%...` が解消され、`local_hash` と `base_snapshots.hash` が新ディスク hash に一致 |
| **③' `emit pull` 時（未 push のローカル編集を持つ記事 — N1）** | `"%e6%9c%aa%e5%88%86%e9%a1%9e"` **(変更せず保護)** | `["%e6%9c%aa%e5%88%86%e9%a1%9e"]` | `SHA256(旧ベースライン)` | `SHA256(canonical)` | `currentDiskHash !== local_hash` のためローカル編集を保護して `skipped: true, localEditsPreserved: true`。その後 `emit push` または `emit pull --force` した時点で decoded 表記へ昇格 |
| **④ `emit pull` 2 回目以降（冪等・No-op）** | `未分類` | `["%e6%9c%aa%e5%88%86%e9%a1%9e"]` | `SHA256(新ディスク)` | `SHA256(canonical)` | `carriesPercentEncodedTaxonomy(disk)` が `false` のため heal 不発火。`skipped: true, updated: false`（`lastSyncedAt` 更新なし） |
| **⑤ `emit push` 実行時 (`commit.ts`)** | `commit.ts:214` の `serializeMarkdown` により **`未分類` で書き出し** | `commit.ts:303` の `savedFrontmatter`（canonicalize 済み）を JSON 保存するため **`["%e6%9c%aa%e5%88%86%e9%a1%9e"]` を維持** | `SHA256(新ディスク)` | `SHA256(canonical)` | **表記反転（ピンポン）は絶対に起きない**。push 後もディスクは `未分類`、JSON は canonical |
| **⑥ `emit new -C 未分類` 実行時 (`new.ts`)** | `serializeMarkdown` により **`未分類` で書き出し** | （未 push のため snapshot なし） | （未 push） | （未 push） | `createArticleScaffold` が誤警告ゼロで受理し、ディスクには `未分類` で出力 |

#### `computeTaxonomyHash` 全 6 箇所の Canonical 入力保証
`src/sync/terms.ts` の `computeTaxonomyHash(categories, tags)` は一切変更せず、全呼び出し箇所で **常に canonical slug** が渡されることを保証します：
1. `src/sync/push/tax_audit.ts:83`: `baseFm.taxonomies`（`base_snapshots.frontmatter_yaml` 由来 ＝ canonical）
2. `src/sync/push/tax_audit.ts:93`: `remoteTaxAudit`（リモート API 由来 ＝ canonical）
3. `src/sync/push/merge_stage.ts:278`: `remoteTaxAudit`（リモート API 由来 ＝ canonical）
4. `src/sync/push/commit.ts:308`: `parsed.frontmatter.taxonomies`（`push/index.ts:101` の `canonicalizeFrontmatterTaxonomies` 通過後 ＝ canonical）
5. `src/sync/push/commit.ts:317`: `baseFm.taxonomies`（`base_snapshots.frontmatter_yaml` 由来 ＝ canonical）
6. `src/sync/pull.ts:709, 1054`: `frontmatter.taxonomies`（リモート API 由来 ＝ canonical）

---

### 2.3 `sync_new` / `emit new` の連携仕様

1. **日本語スラッグのワンショット指定**:
   - `emit new my-slug -C "未分類" -T "カメラ,買い物(レビュー)"` を完全サポート。
   - `TaxonomyCandidates.categories` / `.tags` 配列自体は既存互換のため canonical slug 配列のまま維持します（`tests/taxonomies.test.ts:94-97` 互換）。
   - `src/sync/new.ts` の `createArticleScaffold` 側で、入力値 `t`（`tNorm = tryDecodeTaxonomyTerm(t).normalize('NFC').toLowerCase()`）が以下のいずれかに一致すれば有効（警告なし）と判定します：
     - `candidates.categories`（または `tags`）に含まれる
     - `candidates.categories.some(c => tryDecodeTaxonomyTerm(c).normalize('NFC').toLowerCase() === tNorm)`
     - `candidates.slugToName.category`（または `tag`）のキーまたは値（NFC 正規化・小文字化）に一致する
   - 生成されるファイルは `serializeMarkdown(frontmatter, initialBody, candidates)` によってディスク上に `    - 未分類`（decoded 表記）で書き出されます。
2. **ヒント一覧（`Available Categories / Tags`）のデコード表示**:
   - `formatTaxonomiesHint`（`src/sync/taxonomies.ts`）を改修。
   - `decodedSlug = tryDecodeTaxonomyTerm(item.slug)` を表示用スラッグとし、`formatYamlScalar(decodedSlug)` でフォーマット。
   - `decodedSlug` と `item.name` が同一（大文字小文字無視・trim 後）の場合は `未分類` と単一表示し、異なる場合のみ `tech (技術)` と併記。

---

## 3. レイヤー別実装詳細 (Architecture & Implementation)

### 3.1 Layer 0: `src/utils/frontmatter.ts` & `src/db/baseline.ts`
- **`tryDecodeTaxonomyTerm(term: string): string` の新設**:
  ```ts
  export function tryDecodeTaxonomyTerm(term: string): string {
    if (!term.includes('%')) return term;
    try {
      return decodeURIComponent(term);
    } catch {
      return term;
    }
  }
  ```
- **`carriesPercentEncodedTaxonomy(markdown: string): boolean` の新設（誤発火防止の厳密判定 — R5 対策）**:
  - 記事自身の `slug: '%e6%97%a5%e6%9c%ac%e8%aa%9e-slug'`（`tests/frontmatter.test.ts:240`）や `bylines: ['%e8%91%97%e8%80%85']`、あるいはデコードしても変化しないタグ `"50%off"` や不正バイト列 `"%E0%A4%A"`（`tests/taxonomies.test.ts:240`）で誤発火しないよう、以下の狭い判定とします：
    1. 先頭 `^---\r?\n([\s\S]*?)\r?\n---` で Frontmatter ブロックのみを切り出す（本文は走査しない）。
    2. 行単位で走査し、トップレベルの `taxonomies:` 行から次のトップレベルキー（`/^[a-zA-Z0-9_-]+:/`）の手前までのセクションに限定する（`slug:` や `bylines:` 等は完全に除外）。
    3. セクション内のリスト項目行（`/^\s+-\s+(.+)$/`）から末尾の `# comment` と外側のクォートを剥がした値 `rawScalar` を取り出し、**`tryDecodeTaxonomyTerm(rawScalar) !== rawScalar` が `true`（実際にデコードによって文字列が変化する）である項目が 1 つ以上存在する場合のみ `true`** を返す。
- **`SerializeMarkdownOptions` の拡張**:
  - `preferEncodedTaxonomy?: boolean` を追加（デフォルト `false`）。
  - `formatFrontmatterYaml(fm, candidates, options)` にて：
    - `displayTerm = options?.preferEncodedTaxonomy ? term : tryDecodeTaxonomyTerm(term)`
    - `humanName = slugMap?.[displayTerm] || slugMap?.[term] || slugMap?.[tryDecodeTaxonomyTerm(term)]`
    - `humanName && humanName.trim().toLowerCase() !== displayTerm.trim().toLowerCase()` のときのみ `# ${humanName}` コメントを付与。
    - スカラー値は `formatYamlScalar(displayTerm)` で出力。
- **`lenientRepairMarkdownFrontmatter` は非変更**:
  - `src/utils/frontmatter.ts:221` の `lenientRepairMarkdownFrontmatter` は、未クォート `- %e6%...` 行にクォートを補うだけの構文修復関数であり、値を変更しない不変条件を守るため変更しない（`tests/frontmatter.test.ts:292-356` を完全維持）。
- **`src/db/baseline.ts` (`BaselineSerializeOptions`) の拡張**:
  - `BaselineSerializeOptions` に `preferEncodedTaxonomy?: boolean` を追加し、`baselineMarkdown` から `serializeMarkdown` へ透過させる。

### 3.2 Layer 1: `src/sync/taxonomies.ts`
- **`loadLocalTaxonomyCandidates` の両引き対応**:
  - `catMap` および `tagMap`（`slugToName`）に、canonical `c.slug` だけでなく `tryDecodeTaxonomyTerm(c.slug)` もキーとして登録する。
  - `categories` / `tags` 配列自体は canonical slug のまま維持する。
- **`formatTaxonomiesHint` のデコード化**:
  - `tryDecodeTaxonomyTerm(item.slug)` を適用し、`item.name` と一致する場合はカッコ書きを省略。
- **`loadLocalTaxonomyMaps` の NFC 正規化**:
  - canonical slug（DB 由来）は byte 一致のため無変換を維持。
  - エイリアス登録時（`name`, `decodedSlug`）および `resolveTermId` の検索時に `.normalize('NFC')` を適用。

### 3.3 Layer 1: `src/sync/status.ts`, `src/sync/diff.ts`, `src/sync/merge.ts`
- **`status.ts` & `diff.ts` の旧表記ディスク互換（R6 対策 — 直積不要の O(1) 決定）**:
  - `preferEncodedTaxonomy` はディスク上の `localContent` 自体から `carriesPercentEncodedTaxonomy(localContent)` によって一意に決まります（同様にメディアの `preferLegacyRef` も `carriesDepthFreeMediaRef(localContent)` で `localContent` から一意に決まります）。
  - したがって `status.ts:156` と `diff.ts:166` で以下のように呼び出すだけで、4 パターンの直積探索を行うことなく `localContent` の表記に完全一致したベースラインが得られます：
    ```ts
    const baseFullMarkdown = baselineMarkdown(baseSnapshot, candidates, {
      preferEncodedTaxonomy: carriesPercentEncodedTaxonomy(localContent),
    });
    const localizedBase = localizeArticleMediaRefs(baseFullMarkdown, {
      workspaceRoot: options.workspaceRoot,
      articleRelPath: targetFile,
      fs,
      preferLegacyRef: carriesDepthFreeMediaRef(localContent),
    });
    ```
- **`merge.ts` (`normalizeTermList` と代表表記選択規則 — R2 / N2 対策)**:
  - AGENTS.md / v0.1.13 / v0.1.14 の「`mergeTaxonomies` の集合代数は変更しない」原則を厳守します。
  - 各タクソノミー名ごとのマージ処理（`merge.ts:125` ループ内）において、`base`, `remote`, `local` に含まれる全タームから `canonicalKey = tryDecodeTaxonomyTerm(String(t)).normalize('NFC')` をキーとする表記マップ `preferredTermMap = new Map<string, string>()` を構築します。
  - **代表表記の選択規則（N2 明文化）**:
    - **`preferredTermMap` は canonical slug（`tryDecodeTaxonomyTerm(raw) !== raw` となるパーセントエンコード表記）を最優先で採用**し、いずれの入力配列にもパーセントエンコード表記が存在しない場合のみ最初に出現した表記（NFC 正規化済み）を採用します。
    - `normalizeTermList` は各要素を `preferredTermMap.get(canonicalKey)` でこの代表表記に揃えてから `Set` + `sort()` します。
    - これにより、`union` 結果・`localAdded` / `localRemoved`・`remoteAdded` / `remoteRemoved`・`strategyAdoptions`（および push 時のマージログ表示）の表記もすべて canonical 代表表記で統一されます（ディスクへの decoded 変換は Layer B の `serializeMarkdown` が一括して担い、`merge.ts` 内では行いません）。

### 3.4 Layer 2: `src/sync/pull.ts`, `src/sync/push/commit.ts`, `src/sync/new.ts`
- **`pull.ts` (`tryFastPathOrHeal`) の 3 分岐と冪等な表記 Heal（N3 / N4 明文化）**:
  1. **分岐 1: 無編集・Valid YAML・旧 `%e6%...` 表記 (`currentDiskHash === existingSync.localHash` かつ `parseMarkdown` 成功)**:
     - `carriesPercentEncodedTaxonomy(currentDiskContent)` が `true` の場合、`serializeMarkdown(parsed.frontmatter, parsed.body, getTaxonomyCandidates())`（＋ `localMediaRefs` 適用時は `localizeArticleMediaRefs`）で decoded 表記に再直列化します。
     - 再直列化文字列が `currentDiskContent` と異なる場合、ディスクへ書き込み、`healedHash = calculateHash(respelled)` で `sync_state.local_hash` と（存在すれば）`base_snapshots.hash` をアトミックに更新し、`updated: true, healed: true, meaningChanged: false` を返します。
     - 2 回目の `pull` では `carriesPercentEncodedTaxonomy(currentDiskContent)` が `false` となるため、そのまま `skipped: true, updated: false`（`lastSyncedAt` 不変）となります。
  2. **分岐 2: 無編集・Broken YAML（未クォート `- %e6%...` 等で `currentDiskHash === existingSync.localHash` かつ `parseMarkdown` 失敗 — H1 / H3 経路）**:
     - ネットワーク通信（記事・ターム・執筆者 fetch）は一切発行せず、ローカル完結で以下の厳密な 4 ステップ順序により 1 回の heal で decoded 表記まで昇格させます：
       1. `repaired = lenientRepairMarkdownFrontmatter(currentDiskContent)` で構文修復（`"%e6%..."` クォート付与）。
       2. `parsedRepaired = parseMarkdown(repaired)` で Frontmatter（canonical slug）と body を抽出。
       3. `decodedMarkdown = serializeMarkdown(parsedRepaired.frontmatter, parsedRepaired.body, getTaxonomyCandidates())`（＋ `localMediaRefs` 適用）で decoded 表記の Markdown を生成。
       4. `decodedMarkdown` をディスクに書き込み、`healedHash = calculateHash(decodedMarkdown)` で `sync_state.local_hash`（および `existingBase` が存在する場合は `base_snapshots.hash`）を更新。
     - この順序により、`lenientRepairMarkdownFrontmatter` 自体は一切変更せずに、1 回目の `pull` で `'    - 未分類'` がディスクに確定し、直後の 2 回目の `pull`（`tests/sync.test.ts:963`）で `carriesPercentEncodedTaxonomy` が再発火せず確実に `skipped: true` となります。また、記事 fetch がゼロであることも厳格に維持されます。
  3. **分岐 3: 未 push のローカル編集あり (`currentDiskHash !== existingSync.localHash`)**:
     - `parseMarkdown(currentDiskContent)` が成功する場合は従来通り `skipped: true, localEditsPreserved: true` でローカルファイルを一切書き換えません（N1: 未 push 編集記事の保護）。
     - `parseMarkdown` が失敗する場合（`pull.ts:648`）は、ユーザーの未 push 編集ファイル（コメントや本文）を勝手に再フォーマットしないため、従来通り `lenientRepairMarkdownFrontmatter` の結果（`"%e6%..."` クォートのみ）をディスクに書き込みます（`tests/sync.test.ts:1677, 1793` を完全維持）。
- **`commit.ts` の Canonical Snapshot 保証の明示化（R1 対策）**:
  - `src/sync/push/commit.ts:214` でディスクへ書き出す `serializeMarkdown(parsed.frontmatter, parsed.body, candidates)` は Layer B（decoded 表記）を出力します。
  - 一方、`commit.ts:303` で `saveBaseSnapshot` に渡す `savedFrontmatter` については、`taxonomyMaps` が存在する場合は `canonicalizeFrontmatterTaxonomies` によって canonical slug 化されていることを保証し、万一 `merge_stage.ts` 等で decoded タームが残っていた場合でも `taxonomyMaps.slugToId` で canonical slug へ正規化してから `saveBaseSnapshot` に渡す防御処理を明示的に入れます。
- **`new.ts` (`createArticleScaffold` — R4 対策)**:
  - §2.3 に従い、未知ターム警告判定で decoded / `slugToName`（NFC 込み）を照合し、`serializeMarkdown` によりディスクへ decoded 表記で書き出します。

---

## 4. バリデーションと安全性 (Validation & Safety Guardrails)

| 潜在リスク | 対策 |
|---|---|
| **Push / Pull ごとの表記反転（ピンポン現象）** | 内部 JSON（`base_snapshots.frontmatter_yaml`）は常に canonical slug、直列化（`formatFrontmatterYaml`）は常に decoded とする二層分離＋`commit.ts` の明示的正規化により、push 後も pull 後もディスクは常に `未分類`、snapshot JSON は常に `["%e6%..."]` に保たれる。 |
| **`computeTaxonomyHash` の不一致による偽の競合 (G16/409)** | `base_snapshots.frontmatter_yaml` と `canonicalizeFrontmatterTaxonomies()` が canonical slug を維持するため、全 6 箇所の `computeTaxonomyHash` 入力は 100% canonical slug に統一される。 |
| **記事 `slug` や `"50%off"` / `"%E0%A4%A"` での Heal 無限発火** | `carriesPercentEncodedTaxonomy` は Frontmatter 内の `taxonomies:` セクションのリスト項目のみを検査し、かつ `tryDecodeTaxonomyTerm(val) !== val` のときのみ `true` を返すため、記事 `slug` やデコード不変文字列では絶対に発火しない。 |
| **未 push のローカル編集を持つ記事の Heal 遅延 (N1)** | `currentDiskHash !== existingSync.localHash` の記事はデータ保護のため `pull` 時に書き換えず旧表記のまま維持される（意図した挙動）。その記事を `emit push` または `emit pull --force` した時点で decoded 表記へ昇格する。 |
| **全記事の一斉 `modified` 化 (Phantom Diff)** | 未編集記事は `localHash === currentHash` で即 `synced`。`pull` 前に本文編集した記事も `preferEncodedTaxonomy: carriesPercentEncodedTaxonomy(localContent)` により旧表記 baseline と比較されるため偽 diff ゼロ。 |
| **既存の CJK unquoted 不変条件の破壊** | 既存の `formatYamlScalar` を通すことで、`expect(formatYamlScalar('未分類')).toBe('未分類')` を 100% 遵守。 |

---

## 5. 影響モジュールと全テストファイル分類表 (Impact & Complete Test Matrix)

### 5.1 実装モジュール・ドキュメント変更一覧

| ファイル | Layer | 変更内容 |
|---|---|---|
| `package.json` | Meta | バージョンを `0.1.21` へ更新 |
| `src/utils/frontmatter.ts` | Layer 0 | `tryDecodeTaxonomyTerm`・`carriesPercentEncodedTaxonomy`（`taxonomies:` 限定＆`tryDecode !== raw` 判定）新設、`SerializeMarkdownOptions.preferEncodedTaxonomy` 追加、`formatFrontmatterYaml` のデコード出力と両引きコメント復元（※`lenientRepairMarkdownFrontmatter` は非変更） |
| `src/db/baseline.ts` | Layer 0 | `BaselineSerializeOptions` に `preferEncodedTaxonomy?: boolean` を追加し `serializeMarkdown` へ透過 |
| `src/sync/taxonomies.ts` | Layer 1 | `loadLocalTaxonomyCandidates` の `slugToName` 両引き対応、`formatTaxonomiesHint` デコード化、`loadLocalTaxonomyMaps` のエイリアス NFC 正規化 |
| `src/sync/status.ts` | Layer 1 | `isBaselineSpellingMatch` に `preferEncodedTaxonomy: carriesPercentEncodedTaxonomy(localContent)` を追加 |
| `src/sync/diff.ts` | Layer 1 | `baselineMarkdown` 呼び出しに `preferEncodedTaxonomy: carriesPercentEncodedTaxonomy(localContent)` を追加 |
| `src/sync/merge.ts` | Layer 1 | `mergeTaxonomies` / `normalizeTermList` で `tryDecodeTaxonomyTerm` + NFC 正規化キーによる `preferredTermMap` 代表表記（canonical slug 優先）統一を追加（集合代数は非変更） |
| `src/sync/pull.ts` | Layer 2 | `tryFastPathOrHeal` に §3.4 の heal 分岐 1（valid-encoded）および分岐 2（broken-encoded の 4 ステップ一括 decoded 化）を追加 |
| `src/sync/push/commit.ts` | Layer 2 | `saveBaseSnapshot` に渡す `savedFrontmatter.taxonomies` が常に canonical slug であることの明示的保証・コメント追加 |
| `src/sync/new.ts` | Layer 2 | `createArticleScaffold` の未知ターム警告判定で decoded / `slugToName`（NFC 込み）を照合 |
| `CHANGELOG.md` | Doc | `[0.1.21]` セクション追加 |
| `AGENTS.md` | Doc | 以下の **3 箇所** を二層表現仕様に合わせて更新（N6 対策）：<br>1. **§3 Canonical Frontmatter Schema**: `taxonomies:` がディスク上では decoded 表記（`未分類`, `tech # 技術`）で出力されることを明記。<br>2. **§5 Baseline serialization invariant**: `base_snapshots.frontmatter_yaml` は canonical slug JSON を保持し、`baselineMarkdown`（`serializeMarkdown`）が decoded 表記（旧表記ディスク比較時は `preferEncodedTaxonomy: true`）を再構築することでディスクとの byte-identical 等式が成り立つ旨を明記。<br>3. **§5 YAML scalar quoting rule (`formatYamlScalar`)**: タクソノミータームは `tryDecodeTaxonomyTerm` 経由で `formatYamlScalar` に渡されること、および fast-path heal が valid-encoded と broken-encoded（`lenientRepair` → `parseMarkdown` → `serializeMarkdown`）の両方を decoded 表記へ 1 パス昇格させる旨を明記。 |

### 5.2 全関連テストファイルの分類表（R3 / N4 / N5 対策）

| テストファイル | 分類 | 該当行と具体的な扱い（Assert 更新 vs. Fixture 維持） |
|---|---|---|
| **`tests/frontmatter.test.ts`** | **Assert 更新 ＋ テスト追加** | ・**L255, L261-264 (更新)**: デフォルト `serializeMarkdown` の出力期待値を `'    - 未分類'` に更新し、`{ preferEncodedTaxonomy: true }` 指定時に `'    - "%e6%9c%aa%e5%88%86%e9%a1%9e"'` が出る assert を追加。<br>・**L226, L240, L260, L250, L271 (維持)**: `formatYamlScalar` 単体、記事 `slug`、`bylines` は変更なし。<br>・**L292-437 (維持)**: `lenientRepairMarkdownFrontmatter` 単体テストは変更なし。<br>・**新規追加**: `tryDecodeTaxonomyTerm`、`carriesPercentEncodedTaxonomy`（記事 `slug` が `%e6%...` や `"50%off"` / `"%E0%A4%A"` で `false` になる検証含む）のテストを追加。 |
| **`tests/corpus_taxonomy.test.ts`** | **Assert 更新** | ・**L160, L167 (更新)**: デフォルト `formatFrontmatterYaml` の出力を `'    - 台湾'`（同名コメント省略）に更新し、`{ preferEncodedTaxonomy: true }` 時に `'    - "%e5%8f%b0%e6%b9%be" # 台湾'` が出力される検証を併記。<br>・**L260 (更新)**: `pushArticle` 後のディスク内容を `'    - 台湾'` に更新（`res.resolvedTaxonomies` L243 は canonical のまま維持）。<br>・**L351 (更新)**: `pullArticle` 後のディスク内容を `'    - 台湾'` に更新。<br>・**L125, L129, L299 (維持)**: `findClosestTaxonomySuggestions` および Preflight G4 のサジェスト文字列（`'台湾 -> "%e5%8f%b0%e6%b9%be"'`）は変更なし。 |
| **`tests/taxonomies.test.ts`** | **Assert 更新 ＋ テスト追加** | ・**L262 (更新)**: `formatTaxonomiesHint` の期待値を `'"%e6%9c%aa%e5%88%86%e9%a1%9e" (未分類)'` から `'未分類'` に更新。<br>・**L246, L256 (維持)**: `maps.slugToId` の canonical 解決は変更なし。<br>・**新規追加**: `loadLocalTaxonomyCandidates` の両引き（canonical / decoded キー両方登録）と NFC 正規化のテストを追加。 |
| **`tests/pull_quarantine.test.ts`** | **Assert 更新** | ・**L157, L332 (更新)**: uncached 状態（`getSyncState` が null）からの full `pullArticle` 経路で `serializeMarkdown` 出力が書き込まれるため、期待値を `'"%e6%9c%aa%e5%88%86%e9%a1%9e"'` から `'    - 未分類'` に更新。<br>・**L212 (更新)**: cached かつ hash マッチ状態（`neverFetch`、article fetch 0 件）の fast-path heal（§3.4 分岐 2）経路で `serializeMarkdown` による decoded 出力が書き込まれるため、期待値を `'"%e6%9c%aa%e5%88%86%e9%a1%9e"'` から `'    - 未分類'` に更新（`articleFetches).toHaveLength(0)` は維持）。<br>・**L152 (維持)**: `posts/conflicts/` に退避された rescue copy の内容は元の壊れた文字列のまま byte-for-byte 維持。 |
| **`tests/sync.test.ts`** | **Assert 更新 ＋ テスト追加** | ・**L944, L946, L1079 (更新)**: 未変更 broken-encoded ファイルの fast-path heal（H1 / H3、§3.4 分岐 2）完了後のディスク期待値を `'    - 未分類'`（パース結果 `['未分類']`）に更新（これにより L963 の 2 回目 pull が確実に `skipped: true` となる）。<br>・**L1677, L1681, L1793 (維持)**: 未 push のローカル本文編集を持つ壊れたファイル（§3.4 分岐 3）の `lenientRepairMarkdownFrontmatter` 修復はクォート付与のみのため `'"%e6%9c%aa%e5%88%86%e9%a1%9e"'` のまま維持。<br>・**L1688, L1965, L1991 (維持)**: `base_snapshots` の JSON（`baseFm`）は canonical slug のまま維持。<br>・**新規追加**: 旧 `"%e6%..."` 表記ディスクに対する `status` / `diff` clean テスト（本文のみ編集時にタクソノミー diff が出ない検証含む）を追加。 |
| **`tests/pull_unified.test.ts`** | **テスト追加** | ・有効な旧表記（valid-encoded: `"%e6%9c%aa%e5%88%86%e9%a1%9e" # 未分類`、§3.4 分岐 1）ディスクに対する 1 回目 `pull` の fast-path heal 昇格、および 2 回目 `pull` の完全 no-op（`skipped: true, updated: false`）テスト、記事 `slug` が `%e6%...` の場合に再 heal しないテストを追加。 |
| **`tests/new_scaffold.test.ts`** | **テスト追加** | ・`categories: ['未分類']` 指定時に `warnings: []` となり、かつ生成されたディスクファイルに `'    - 未分類'` が書き出されるテストを追加。 |
| **`tests/merge.test.ts`** | **テスト追加** | ・`local: ['未分類']`, `base: ['%e6%9c%aa%e5%88%86%e9%a1%9e']`, `remote: ['%e6%9c%aa%e5%88%86%e9%a1%9e', 'tech']` の 3-way merge で二重登録が起きず canonical 優先で `['%e6%9c%aa%e5%88%86%e9%a1%9e', 'tech']` に統合されるテストを追加。 |
| **`tests/doctor.test.ts`** | **Fixture 維持（変更なし）** | ・**L180 (維持)**: 未クォート `- %e6%9c%aa%e5%88%86%e9%a1%9e` の壊れた YAML を `doctor` が warning 検出する入力 fixture のため変更不要。 |
| **`tests/mcp.test.ts`** | **Fixture 維持（変更なし）** | ・**L395 (維持)**: 未クォート `- %e6%9c%aa%e5%88%86%e9%a1%9e` の invalid 検出用入力 fixture のため変更不要。 |
| **`tests/mcp_tool_errors.test.ts`** | **Fixture 維持（変更なし）** | ・**L330 (維持)**: 未クォート `- %e6%9c%aa%e5%88%86%e9%a1%9e` の `FRONTMATTER_PARSE_ERROR` 検出用入力 fixture のため変更不要。 |
| **`tests/migration_hash_invariants.test.ts`** | **維持（変更なし）** | ・**L74-76 (維持)**: `serializeMarkdown` の出力をそのまま `localHash` と `base_snapshots.hash` に保存して `status` を検証しているため、変更なしで pass。 |
| **`tests/conflicts.test.ts`, `tests/local_media_refs.test.ts`, `tests/push_commit_symmetry.test.ts`** | **維持（影響なし確認 — N5）** | ・同じ `serializeMarkdown` で disk hash と snapshot hash を構築しており、`localMediaRefs` や `pendingFlagsFor` はタクソノミー表記と独立しているため変更不要（`npm run check` で実行確認）。 |

---

## 6. テスト計画 (Test Matrix)

1. **Frontmatter 直列化・二層表現・狭義判定テスト (`tests/frontmatter.test.ts`, `tests/corpus_taxonomy.test.ts`)**:
   - `"%e6%9c%aa%e5%88%86%e9%a1%9e"` が `formatFrontmatterYaml` で `    - 未分類`（unquoted、コメントなし）として出力されること。
   - `{ preferEncodedTaxonomy: true }` 指定時は従来通り `"%e6%9c%aa%e5%88%86%e9%a1%9e" # 未分類`（コメント付き）が出力されること。
   - `formatYamlScalar('未分類') === '未分類'` が green のままであること。
   - `C#`、`買い物(レビュー)`、`Tips: 設定` がダブルクォートされ、YAML パースエラーを起こさず完全往復すること。
   - `carriesPercentEncodedTaxonomy` が、記事 `slug: "%e6%97%a5%e6%9c%ac%e8%aa%9e-slug"` や `bylines: ["%e8%91%97%e8%80%85"]`、タグ `"50%off"` / `"%E0%A4%A"`、および本文（body）に含まれる `%ef%bc%81` や `50% discount` に対して `false` を返し、`taxonomies:` 内の `"%e6%9c%aa%e5%88%86%e9%a1%9e"` に対してのみ `true` を返すこと。
2. **`sync_new` 日本語指定＆ヒントテスト (`tests/new_scaffold.test.ts`, `tests/taxonomies.test.ts`)**:
   - `categories: ['未分類']` を渡した際、ローカル定義が `"%e6%9c%aa%e5%88%86%e9%a1%9e"` であっても `warnings: []` で受理され、生成されたディスクファイルに `    - 未分類` が書き出されること。
   - `formatTaxonomiesHint` の出力が `未分類` とデコードされ、`未分類 (未分類)` にならないこと。
3. **Phantom Diff 防止・Heal 3 分岐（valid-encoded / broken-encoded / modified-broken）冪等性・Push 非反転テスト (`tests/sync.test.ts`, `tests/pull_unified.test.ts`)**:
   - 旧表記（`"%e6%9c%aa%e5%88%86%e9%a1%9e"`）を持つ記事に対して、`emit status` / `emit diff` が `synced`（差分 0）を返すこと。また `pull` 前に本文のみを編集した場合、タクソノミー行に diff が出ないこと。
   - **valid-encoded（分岐 1）**: 1 回目の `emit pull` で fast-path heal が発火してディスクが `未分類` に書き換わり、`base_snapshots.frontmatter_yaml` は canonical JSON のまま `hash` と `local_hash` が更新され、2 回目の `emit pull` で `skipped: true, updated: false`（`lastSyncedAt` 不変）の完全 no-op になること。
   - **broken-encoded（分岐 2 — H1/H3）**: `lenientRepair` → `parseMarkdown` → `serializeMarkdown` の順序で 1 回目の `emit pull` で `'    - 未分類'` に確定し、2 回目の `emit pull` で `skipped: true` になること。
   - **modified-broken（分岐 3）**: 未 push のローカル編集を持つファイルは `lenientRepair` のクォート修復のみが行われ、ローカル編集内容が保護されること。
   - `emit push` 実行後もディスクが `未分類` のまま維持され、`base_snapshots.frontmatter_yaml` は canonical JSON（`["%e6%9c%aa%e5%88%86%e9%a1%9e"]`）を維持すること。
4. **マージ重複排除＆Canonical 代表表記保持テスト (`tests/merge.test.ts`)**:
   - `local: ['未分類']`, `base: ['%e6%9c%aa%e5%88%86%e9%a1%9e']`, `remote: ['%e6%9c%aa%e5%88%86%e9%a1%9e', 'tech']` の場合に、マージ結果で二重登録されず canonical 優先で `['%e6%9c%aa%e5%88%86%e9%a1%9e', 'tech']` に統合されること。
5. **実機受け入れ検証 (`/Volumes/ext/github/emdash.aroooy.net` — N1 反映)**:
   - 既存の 63 記事が存在する実機ワークスペースにて、まず v0.1.21 適用直後に `emit status` を実行し **`modified: 0`（全 63 記事 synced）** であることを確認（万一未 push の `modified` 記事が存在する場合は、意図通り `pull` で上書き保護されるため、先に `emit push` または `emit pull --force` で解消する）。
   - 1 回目の `emit pull` 実行で日本語タクソノミーを持つ既存記事が `未分類` 等の日本語表記へクリーンに heal され、直後の `emit status` でも **`modified: 0`**、さらに 2 回目の `emit pull` で **`0 updated, 63 skipped`** となることを確認。

---

## 7. 実施手順 (Step-by-Step Execution)

1. **レビューと計画承認**: 本計画書（Rev.6）の確認・承認。
2. **Layer 0 実装 & 単体テスト検証 (`src/utils/frontmatter.ts`, `src/db/baseline.ts`, `tests/frontmatter.test.ts`)**:
   - `tryDecodeTaxonomyTerm`・`carriesPercentEncodedTaxonomy` 新設、`preferEncodedTaxonomy` オプション対応、`formatFrontmatterYaml` のデコード化・両引きコメント復元。
   - `tests/frontmatter.test.ts` を更新・追加し、`npx vitest run tests/frontmatter.test.ts` の GREEN を確認。
3. **Layer 1 実装 & 単体テスト検証 (`src/sync/taxonomies.ts`, `src/sync/status.ts`, `src/sync/diff.ts`, `src/sync/merge.ts`)**:
   - `loadLocalTaxonomyCandidates` の両引き対応、NFC 正規化、`formatTaxonomiesHint` デコード化。
   - `status.ts` と `diff.ts` の `preferEncodedTaxonomy` 対応。
   - `merge.ts` の `normalizeTermList` / `preferredTermMap`（canonical 優先）重複排除。
   - `tests/taxonomies.test.ts`, `tests/merge.test.ts` を更新・追加し、単体テスト GREEN を確認。
4. **Layer 2 実装 & 統合テスト検証 (`src/sync/pull.ts`, `src/sync/push/commit.ts`, `src/sync/new.ts`)**:
   - `pull.ts` の fast-path heal（分岐 1・分岐 2・分岐 3）実装。
   - `commit.ts` の canonical snapshot 保証の明示化。
   - `new.ts` の誤警告防止。
   - `tests/corpus_taxonomy.test.ts`, `tests/pull_quarantine.test.ts`, `tests/sync.test.ts`, `tests/pull_unified.test.ts`, `tests/new_scaffold.test.ts` を更新・追加。
5. **全体チェック (`npm run check`)**:
   - レイヤリング検証（`tests/layering.test.ts`）および `tests/conflicts.test.ts`, `tests/local_media_refs.test.ts`, `tests/push_commit_symmetry.test.ts` を含む全テストスイート・型チェック・フォーマットチェック（`npm run check`）を実行し、全件 GREEN を確認。
6. **実機動作確認 (`/Volumes/ext/github/emdash.aroooy.net`)**:
   - `emit status`（pull 前 `modified: 0` 確認）→ `emit pull`（1 回目 heal 確認）→ `emit status`（`modified: 0` 確認）→ `emit pull`（2 回目 冪等 `0 updated, 63 skipped` 確認）→ 下書き記事の `emit new` / `emit push` 検証（※公開は絶対に行わない）。
7. **ドキュメント・バージョンバンプ (`0.1.21`)・コミット・タグ発行**:
   - `package.json`, `CHANGELOG.md`, `AGENTS.md`（§3・§5 の 3 箇所）を更新、コミットおよび `v0.1.21` タグ発行。
