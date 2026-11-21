# v0.1.45 リファクタリング計画書: 検索系スキャナの収束・重複ロジックの正本化・層境界の是正（Rev.1）

- **対象バージョン**: `v0.1.45`
- **作成日**: 2026-11-21 (Rev.1)
- **ステータス**: 完了（Completed — P0〜P8 実装・`npm run check` 100% green、P9 は実測ゲートにより X-8 へ引き継ぎ）
- **起点**: `ed31d6eb`（v0.1.37 Phase 2 barrel 収束）から `HEAD`（v0.1.44）までの 42 コミット・src 約 +3,974 行の監査結果
- **目的**:
  1. **P1: 検索系の前段処理正本化** — 日付境界パース＋`ApiError` 生成が 4 モジュールで計 8 ブロック完全に複製されており、うちメディア検索 2 モジュールは**誤ったエラーコード**（`MEDIA_SEARCH_QUERY_REQUIRED`）を投げている。Layer 0 にリゾルバを集約し、エラーコードを `DATE_BOUNDARY_INVALID` に是正する。〔→ R-1〕
  2. **P2: メディア検索の層整合** — 実処理関数 `searchLocalMirrorMedia()`（130 行）が `src/sync/media/types.ts` に住んでおり、同モジュール唯一の `export function` として責務マップから外れている。`media/local_search.ts` へ分離する。〔→ R-2〕
  3. **P3: メディア検索プレゼンテーションの Layer 3 化** — v0.1.43 で記事検索は `src/presentation/article_report.ts` に 4 ヘルパーを置いたが、v0.1.42 のメディア検索は CLI に約 65 行インラインで、MCP は `[WALK_INCOMPLETE]` を**別文字列で再定義**している。`presentation/media_report.ts` へ集約し対称性テストを追加する。〔→ R-3〕
  4. **P4: Markdown パースの一本化** — `article_search/local.ts` だけが `gray-matter` を直接叩き、他 5 モジュールが使う `lenientRepairMarkdownFrontmatter()` フォールバックを踏まない。Layer 0 に `parseMarkdownLenient()` を新設し 6 系統を差し替える。〔→ R-4〕
  5. **P5: 記事ボディ→メディア参照スキャナの収束** — スキャナが 3 系統（`scanRawMediaReferences` / `scanArticleMediaDetailed` / `collectArticleStorageKeys`）並立し、fence policy と分類が食い違う。`body_scan.ts` 内の冗長 harvest（同一本文への二重正規表現走査）も除去する。〔→ R-5〕
  6. **P6: `executeScanSearch()` の fast-path 切り出し** — 372 行中 105 行・ネスト 8 段のベースライン fast-path を純粋関数へ抽出し、5 つの前条件を単体テスト可能にする。〔→ R-7〕
  7. **P7: 検索 limit 定数の正本化** — 同一値 20 が 3 定義、上限 50 が 2 定義、clamp 式が 4 箇所一字一句同一。`src/utils/search-options.ts` に集約する（maxScan の既定値差は**意図的なので維持**）。〔→ R-9〕
  8. **P8: workspace ディレクトリ走査の契約化** — 「draft/published を順に readdir して .md を読む」ループが 6 箇所に分散し、conflicts/ の含否・`.deleted.md` の除外判断がコメントでしか表現されていない。`sync/workspace/articles.ts` に Iterator を新設する（**AGENTS.md 更新を伴うため Ask First**）。〔→ R-6〕
  9. **P9: 死蔵 export の整理** — consumer ゼロの `scanArticleMediaDetailed` export を解除する（公開 façade 露出は X-6 へ回す）。〔→ R-8〕

> **番号体系**: `R-n` は課題 ID（§2）、`Pn` は実装 Phase ID（§4）です。両者は §3 の見出しで対応づけており、Phase 番号は実装順序（§8）と一致させています。

- **本計画書のスコープ外（意図的除外 / 将来版への引き継ぎ）**: §9 参照

---

## 1. 現状の実測スナップショット（2026-11-21 v0.1.44 時点）

すべての数値は実際のツールで計測した結果であり、推定を含まない。

| 項目                                               | 実測値                                                                 | 検査コマンド                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/` 総行数                                      | **29,263 行**（118 モジュール）                                        | `find src -name '*.ts' -exec wc -l {} +`                          |
| v0.1.37 起点からの増加                             | **+4,135 行 / +13 モジュール**（v0.1.36: 25,128 行・105 モジュール）   | 同上、`docs/v0137-refactor-plan/README.md` §1 と比較              |
| テスト                                             | 72 files / **871 tests 全 green**                                      | `npm test -- --run`                                               |
| `as any` / `@ts-ignore` / eslint-disable（src 内） | **0 件**                                                               | `grep -rn 'as any\|@ts-ignore\|eslint-disable' src`               |
| 非 CLI 層の `console.log` / `console.debug`        | **0 件**（Axis 5 PASS）                                                | `grep -rn 'console\.\(log\|debug\)' src \| grep -v 'src/cli/'`    |
| barrel リエントランスへの内部 import               | **0 件**（v0.1.37 P3 の効果維持）                                      | `grep -rn "from '\.\./sync/\(pull\|push\|media\)\.js'" src tests` |
| `gray-matter` 直接 import                          | **2 箇所**（`utils/frontmatter.ts` と `sync/article_search/local.ts`） | `grep -rn "from 'gray-matter'" src`                               |

### 1.1 v0.1.42〜v0.1.44 で新設された検索系モジュールの実測規模

| モジュール                                                        | 行数                                             | 新設バージョン |
| ----------------------------------------------------------------- | ------------------------------------------------ | -------------- |
| `src/sync/article_search/remote.ts`                               | **637**                                          | v0.1.43        |
| `src/sync/media/remote_index.ts`                                  | 436                                              | v0.1.42        |
| `src/sync/media/types.ts`（元からあるが +130 で検索実処理を追加） | 431                                              | v0.1.42 追記   |
| `src/presentation/article_report.ts`                              | 342                                              | v0.1.43        |
| `src/sync/article_search/local.ts`                                | 308                                              | v0.1.43        |
| `src/sync/media/body_scan.ts`                                     | 170                                              | —              |
| `src/cli/commands/media.ts`                                       | 186                                              | v0.1.42        |
| `src/mcp/tools/sync-media-search.ts`                              | 147                                              | v0.1.42        |
| `src/presentation/media_report.ts`                                | **33**（`formatMediaSearchHitLimitNotice` のみ） | v0.1.44        |

→ **記事検索は Layer 3 に表示層を持つのに対し、メディア検索は 33 行しか持たない。** この非対称が P3 の起点である。

### 1.2 巨大関数の実測内訳（v0.1.37 計画 §1 との差分）

| 関数                      | ファイル:行                               | 行数    | v0.1.37 時点からの経過                                          |
| ------------------------- | ----------------------------------------- | ------- | --------------------------------------------------------------- |
| `runMediaIntegrityChecks` | `src/sync/doctor.ts:465`                  | **465** | v0.1.37 P1 で分割済みの子関数。Check 6 が依然単一塊             |
| `tryFastPathOrHeal`       | `src/sync/pull/fast_path.ts:60-491`       | **432** | v0.1.37 では未着手。単一関数のまま                              |
| `executeScanSearch`       | `src/sync/article_search/remote.ts:318-`  | **372** | **v0.1.44 で新規生成**。fast-path 追加で +105 行                |
| `registerPullCommands`    | `src/cli/commands/pull.ts:365`            | 365     | v0.1.37 P1b で分解済み（`runBatchPull` 等へ委譲）だが本体は残存 |
| `pullMedia`               | `src/sync/media/pull_library.ts:55-315`   | **261** | v0.1.42 で targeted キー分岐が追加され成長                      |
| `searchLocalArticles`     | `src/sync/article_search/local.ts:78-308` | **231** | **v0.1.43 で新規生成**                                          |
| `registerProfileCommands` | `src/cli/commands/profile.ts:122`         | 231     | v0.1.38 で secret input が追加され成長                          |
| `searchRemoteMedia`       | `src/sync/media/remote_index.ts:206-415`  | **210** | **v0.1.42 で新規生成**                                          |

---

## 2. 課題分析と実測根拠

### 2.1 課題 R-1 (P1): 日付境界パース＋エラー生成の 4 重複製、うち 2 箇所は誤コード

`parseSearchDateBoundary()` 自体は v0.1.42 で Layer 0（`src/utils/search-date.ts`）へ集約済みだが、**呼び出し側の `ApiError` 生成ブロックが 8 箇所一字一句同一**で複製されている。

```text
src/sync/article_search/local.ts:85-109      code: 'DATE_BOUNDARY_INVALID'          ✅
src/sync/article_search/remote.ts:93-117     code: 'DATE_BOUNDARY_INVALID'          ✅
src/sync/media/remote_index.ts:213-236       code: 'MEDIA_SEARCH_QUERY_REQUIRED'    ❌
src/sync/media/types.ts:311-334              code: 'MEDIA_SEARCH_QUERY_REQUIRED'    ❌
```

同一メッセージが 8 回出現する：

```
Invalid date boundary: "...". Use "today", "yesterday", or YYYY-MM-DD.
```

**誤コードの実害**: メディア検索で `--since last-week` と入力すると、CLI/MCP は「A non-empty search query is required. / Provide a search keyword（filename, alt text...）」という**まったく無関係な示唆**を返す。ユーザーはクエリ引数の問題と誤解し、日付の誤りに辿り着けない。

`tests/guards.test.ts` Rule 2（rogue code 排除）は `MEDIA_SEARCH_QUERY_REQUIRED` が `OPERATIONAL_ERROR_CODES` に登録済みであるため** GREEN のまま**であり、この誤用を捕捉できない（実測: `src/sync/guards.ts:89,91` の両方が登録済み）。既存テストも誤コードを固定してしまっている：

```text
tests/media_search.test.ts:1177  T1-6: rejects invalid date boundary with MEDIA_SEARCH_QUERY_REQUIRED
```

→ **テストがバグを正規化している**。P1 では本テストの期待値更新を伴う（§5.1）。

### 2.2 課題 R-2 (P2): 実処理関数が `media/types.ts` に住む

`src/sync/media/types.ts` の export 実測:

```text
export const ×3        MEDIA_BINARY_EXTENSIONS / MEDIA_LIST_PAGE_SIZE / MEDIA_SEARCH_MAX_LIMIT
export interface ×12 / export type ×1
export function ×1     searchLocalMirrorMedia (:302, 約 130 行)   ← 唯一の実処理
```

`types.ts` は名前のとおり型モジュールであり、`pull_library.ts`・`remote_index.ts`・`companions.ts` は「型だけ」のつもりで import しているファイルに実行コードが混入している。v0.1.42 で追加されたばかりで、AGENTS.md の media モジュール記述にも現れない。

`ALLOWED_LAYER_2_SYMBOLS['media']`（`tests/layering.test.ts:98-103`）には `searchLocalMirrorMedia` が**既に登録済み**であり、Layer 3 の import 経路は `sync/media/index.js` barrel 経由（`export * from './types.js'`）なので、**ファイル移動のみで allowlist は無変更で済む**。

### 2.3 課題 R-3 (P3): メディア検索の表示が CLI にインライン、MCP は文言を再定義

`src/cli/commands/media.ts:104-176` に約 65 行の整形ロジックがインライン（header / empty notice / hit 行 / walk incomplete / usage hint）。一方 MCP（`src/mcp/tools/sync-media-search.ts:113`）は同じ `[WALK_INCOMPLETE]` を**別文字列リテラルで持つ**：

```text
CLI : ⚠️ [WALK_INCOMPLETE] read N record(s) and stopped at --max-scan; absence is not proven.
MCP : [WALK_INCOMPLETE] read N record(s) and stopped at maxScan; absence is not proven.
```

記事検索側は v0.1.43/v0.1.44 で既に Layer 3 集約済み（`formatArticleSearchWalkIncompleteNotice` `article_report.ts:302`）。同じ認識論的警告が**メディアと記事で 5 箇所に分散**している：

```text
src/cli/commands/media.ts:153                (inline)
src/mcp/tools/sync-media-search.ts:113       (inline)
src/mcp/tools/sync-article-search.ts:121     (inline)
src/presentation/article_report.ts:307       (集約済み・記事のみ)
src/sync/media/remote_index.ts:314           (コメント中の参照)
```

`tests/presentation_symmetry.test.ts`（実測 8 ケース）は pull 系・diff・profile の対称性のみを検査しており、**検索系の対称性は誰も守っていない**。

付随する小物：

- `formatSize()` が `src/cli/commands/media.ts:38` に private 定義（他に消費側なし）
- offline framing がメディア用（`formatOfflineSearchHeader` :103 / `OFFLINE_SEARCH_EMPTY_NOTICE` :112 / `buildOfflineSearchFraming` :117）と記事用（`:185,191,200`）で 2 系統並存し、`[SOURCE: LOCAL WORKSPACE ONLY (OFFLINE)]` 行が 2 回ハードコード
- `--suggest-keywords` の tag hint が CLI（`media.ts:171-179`）と MCP（`sync-media-search.ts:117-125`）で二重実装

### 2.4 課題 R-4 (P4): Markdown パースのフォールバックが 6 系統、検索だけ `gray-matter` 直叩き

正規ルートは `parseMarkdown()` → 失敗時 `lenientRepairMarkdownFrontmatter()` の 2 段構成で、status / doctor / conflicts / fast_path / media body_scan の 5 モジュールがこれを踏む（実測: `lenientRepairMarkdownFrontmatter` 呼び出し 7 箇所）。

一方 `src/sync/article_search/local.ts:175-187` は異なるフォールバックを持つ：

```ts
try {
  const parsed = parseMarkdown(content); // strict
} catch {
  try {
    const raw = matter(content); // ← gray-matter 直接（YAML 妥当性のみ、schema 検証なし）
  } catch {
    continue;
  } // ← invalid ファイルは黙って検索対象外
}
```

`gray-matter` の直接 import は `utils/frontmatter.ts:23` とこのファイルの 2 箇所のみ。結果として **lenient repair で救える invalid frontmatter の記事が、`emit status` / `emit doctor` では `healable: true` と表示されるのに `emit article-search --offline` ではヒットしない**。AGENTS.md §5「Diagnostic alignment invariant（`status` vs `diff` vs `doctor` vs `delete`）」の趣旨に抵触する。

### 2.5 課題 R-5 (P5): メディア本文スキャナ 3 系統と `body_scan.ts` の冗長 harvest

| スキャナ                    | 実体                                  | fence policy                               | opaque fence | 分類                             |
| --------------------------- | ------------------------------------- | ------------------------------------------ | ------------ | -------------------------------- |
| `scanRawMediaReferences`    | `utils/media-refs.ts:85`              | `FENCE_POLICY.guard` / `diagnostic` 選択可 | **除外**     | なし（URL 文字列集合）           |
| `scanArticleMediaDetailed`  | `sync/doctor.ts:164`（92 行・export） | diagnostic 固定                            | 除外         | normal / informational / invalid |
| `collectArticleStorageKeys` | `sync/media/body_scan.ts:61`          | —                                          | **含む**     | storageKey descriptor            |

`scanArticleMediaDetailed` は `scanRawMediaReferences` のループ（opaque fence 判定・fence delimiter 追跡・md/html 正規表現）をほぼ書き写しており、分類ロジックだけが追加されている。

さらに `collectArticleStorageKeys` は**同じ本文に素の正規表現を 2 回当てている**（実測 `body_scan.ts:81-86`）：

```ts
const scannedRefs = scanArticleMediaReferences(content).join('\n');
harvest(scannedRefs, keyPattern); // ①
harvest(content, keyPattern); // ②
harvest(scannedRefs, localRefPattern); // ③
harvest(content, localRefPattern); // ④
```

`scanArticleMediaReferences()` の戻りは本文の部分集合であり、**①は②に、③は④に含まれるため完全な冗長**（4 harvest → 2 harvest で同一結果）。コメントは「opaque fence 内も拾う」意図で書かれているが、①③は opaque fence を除外した集合なのでその意図を達成しておらず、実質的に効いているのは `harvest(content, ...)` のみである。

### 2.6 課題 R-6 (P8): workspace ディレクトリ走査ループの 6 重化と不文律の差異

`sync/workspace/index.ts` は「単一 ULID から canonical path を引く」ヘルパー（`findLocalFilesByUlid` :62）しか持たず、**status ディレクトリの列挙契約が存在しない**。実測で draft/published を順に readdir するループが 6 箇所：

```text
src/sync/status.ts:162                    subdirs = ['draft','published']              conflicts 含まず
src/sync/doctor.ts:484, :859              for (const status of [...])                  conflicts 含まず
src/sync/conflicts.ts:142                 for (const sub of [...])                     conflicts 含まず
src/sync/media/pull_library.ts:278        for (const status of [...])                  conflicts 含まず（census）
src/sync/article_search/local.ts:136-158  （status 分岐 + includeConflicts オプション） conflicts 任意
src/sync/media/prune_protect.ts:68        ['draft','published','conflicts']            conflicts 含む
```

差異は**いずれも意図的**だが、コードコメントでしか表現されていない。`.deleted.md` の除外判断も同様に分散している（prune_protect は除外、pull_library は全 `.md`）。新規の走査処理が増えるたびに「conflicts を含めるか」の判断が都度発生し、誤りがあっても静的検査は無い。

### 2.7 課題 R-7 (P6): `executeScanSearch()` の fast-path が検証不能なネスト塊

v0.1.44 P2 で追加されたベースライン fast-path（`remote.ts:431-535`、105 行・最深ネスト 8 段）は、5 つの前条件を `if` の入れ子で表現している：

```text
cache 存在 → syncState 存在 → pending 4 フラグ全 clear → rev 一致（isSameRev）
           → ディスク未編集（isLocalFileUnmodified, healOnSpellingMatch: false）
           → baseSnapshot 存在 → taxonomy 記録あり
```

現状この前条件は `tests/article_search.test.ts` の統合テスト経由でしか検証されておらず、「disk clean 判定が `healOnSpellingMatch: false` で cache を汚染しない」こと（v0.1.44 の最重要契約）を単独で固定するテストが存在しない。

### 2.8 課題 R-8 (P9): 死蔵 export・公開 façade への過剰露出

| シンボル                                                                                         | 場所                                  | 実測 consumer（出現ファイル数, src / tests）                      | 判定                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `isTaskListItem`                                                                                 | `client/portable-text.ts:178`         | src 1（自分）/ tests 1 のみ                                       | コード内コメントで「Currently uninvoked ... reserved for future EmDash task-list schema (P4)」と明記。将来予約 → X-5 |
| `parseArticleDates` / `resolveArticleDateField` / `inArticleDateRange` / `matchesArticleKeyword` | `sync/article_search/query.ts:39-101` | src 2（local/remote）のみ。**テストは一度も直接 import しない**   | `article_search/index.ts:24` が `export * from './query.js'` → `src/index.ts:57` 経由で npm 公開 façade に露出 → X-6 |
| `scanArticleMediaDetailed`                                                                       | `sync/doctor.ts:164`（export 済み）   | src 1（doctor.ts）/ tests 1（tests/doctor.test.ts で 4 回呼出し） | **実測で tests が直接 import 済み**。診断関数の単体テスト性を保護して export は維持、X-8 へ回す                      |
| `classifyMediaUrl` / `isInlineCodeSpan` / `countMirroredMedia`                                   | `sync/doctor.ts:123,138,148`          | doctor.ts 内のみ                                                  | private（export されていない）→ 問題なし。P5 で Layer 0 へ移動する                                                   |

### 2.9 課題 R-9 (P7): 検索定数の多重定義と clamp 式の 4 重複

| 項目            | 実測値・箇所                                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| limit 既定値 20 | `MEDIA_SEARCH_DEFAULT_LIMIT`（`media/remote_index.ts:40`）/ `LOCAL_MEDIA_SEARCH_DEFAULT_LIMIT`（`media/types.ts:30`, **private**）/ `ARTICLE_SEARCH_DEFAULT_LIMIT`（`article_search/types.ts:25`）→ **同一値 3 定義** |
| limit 上限 50   | `MEDIA_SEARCH_MAX_LIMIT`（`media/types.ts:45`）/ `ARTICLE_SEARCH_MAX_LIMIT`（`article_search/types.ts:26`）→ 同一値 2 定義                                                                                            |
| clamp 式        | `Math.max(1, Math.min(rawLimit, X_MAX_LIMIT))` が **4 箇所一字一句同一**（`media/remote_index.ts:252`, `media/types.ts:348`, `article_search/local.ts:134`, `article_search/remote.ts:125`）                          |
| maxScan 既定値  | media 500 / article 300 / taxonomy フィルタ時 50 → **これは意図的な差異**（v0.1.44 で確立）。統合しない                                                                                                               |

---

## 3. 詳細設計と改修仕様

### 3.1 R-1: `resolveSearchDateBoundaries()` — Layer 0 へ集約（`src/utils/search-date.ts`）

```ts
/**
 * Resolves both `since` / `until` boundaries into absolute instants and raises the typed
 * ApiError on failure, so the eight duplicated throw blocks collapse into one call.
 * The error code is a parameter because a media search must not claim an article search's
 * failure reason — and neither may reuse MEDIA_SEARCH_QUERY_REQUIRED for a date mistake.
 */
export function resolveSearchDateBoundaries(options: { since?: string; until?: string }): {
  sinceBoundary: number | null;
  untilBoundary: number | null;
};
```

- `since` は `parsed.since`、`until` は `parsed.since + DAY_MS`（inclusive な翌日境界）を現状どおり返す。
- 呼び出し側 4 箇所（`article_search/local.ts`, `article_search/remote.ts`, `media/remote_index.ts`, `media/types.ts`）を差し替え、**メディア検索 2 箇所のコードを `DATE_BOUNDARY_INVALID` に是正**する。
- エラーコードは `src/sync/guards.ts:89` の `OPERATIONAL_ERROR_CODES` に登録済みであり、**新規コード追加はゼロ**（`tests/guards.test.ts` Rule 2 は無変更で green）。
- `parseSearchDateBoundary()` は公開のまま据える（単体テストが直接叩いており、境界セマンティクスの契約本体であるため）。

### 3.2 R-2: `searchLocalMirrorMedia()` を `src/sync/media/local_search.ts` へ分離

```
src/sync/media/
├── types.ts            … 型・定数のみ（export function ゼロに戻る）
└── local_search.ts     … searchLocalMirrorMedia() + private helper（新設）
```

- `media/index.ts` に `export * from './local_search.js';` を追加（`./types.js` の re-export はそのまま）。
- 呼び出し側（`cli/commands/media.ts`, `mcp/tools/sync-media-search.ts`）は barrel 経由のため**無変更**。
- `media/remote_index.ts:34` の `import type { LocalMirrorIndex } from './types.js'` は型のみなのでそのまま。
- **新規 Layer 2 sibling edge を生まない**（`local_search.ts` は `./types.js` と `../../utils/*` のみ import）。`tests/layering.test.ts` の allowlist・sibling スナップショットは無変更で green。

### 3.3 R-3: メディア検索表示の Layer 3 集約（`src/presentation/media_report.ts`）

`media_report.ts`（現 33 行）へ以下を追加し、CLI・MCP 双方から呼ぶ：

```ts
export function formatMediaSearchHeader(
  result: MediaSearchResult,
  options: { subject: string; offline: boolean },
): string;
export function formatMediaSearchEmptyNotice(
  result: MediaSearchResult,
  options: { offline: boolean },
): string | null;
export function formatMediaSearchHit(hit: MediaSearchHit, index: number): string[]; // id 行 + detail 行
export function formatMediaSearchWalkIncompleteNotice(
  result: MediaSearchResult,
  options: { isMcp: boolean; limit: number | undefined },
): string | null;
export function formatMediaSearchUsageHint(): string; // 「To use a hit: ...」3 行
export function formatTagSearchHints(tags: Array<{ slug: string }>): string | null; // --suggest-keywords
export function formatSize(bytes: number | null | undefined): string | null;
```

- `[WALK_INCOMPLETE]` は `--max-scan`（CLI）/ `maxScan`（MCP）の語のみ分岐する。既存 `formatMediaSearchHitLimitNotice(hitCount, { isMcp })` と**同じ `isMcp` オプション規約**に揃える。
- offline framing の重複（記事用 / メディア用の 2 系統、`:103-135` と `:185-215`）は本版では**統合しない**（§9 X-7）。見出し行 `[SOURCE: LOCAL WORKSPACE ONLY (OFFLINE)]` が 2 箇所にあること自体は認識論的に安全であり、記事とメディアで「scanned N article(s)」/「scanned N mirrored asset(s)」の語が違うため、統合は文言変更を伴う。
- **CLI 出力はバイト単位で不変**とする（characterization test を先に追加、§5.3）。

### 3.4 R-4: `parseMarkdownLenient()` — Layer 0 に単一エントリポイント（`src/utils/frontmatter.ts`）

```ts
/**
 * Parses content with the canonical two-stage route: strict schema parse, then lenient
 * frontmatter repair, then strict re-parse. Returns null only when nothing can be salvaged.
 * This is the single entry point every read-only inspector (status / doctor / conflicts /
 * delete / search / media scan) must use so an invalid file is classified identically by
 * every diagnostic — AGENTS.md §5 diagnostic alignment invariant.
 */
export function parseMarkdownLenient(content: string, filePath?: string): ParsedMarkdown | null;
```

- 実装は `parseMarkdown()` → catch で `lenientRepairMarkdownFrontmatter()` → その結果を `parseMarkdown()`。いずれも失敗なら `null`。
- **呼び出し側 6 系統を差し替え**:
  - `sync/article_search/local.ts:175-187`（`gray-matter` 直接 import を削除）
  - `sync/status.ts:225`（既存の healability 判定は `parseMarkdownLenient()` の成否で `healable` を導出する形に短縮）
  - `sync/doctor.ts:498`, `sync/conflicts.ts:214,448`, `sync/media/body_scan.ts:122`（呼び出しの短縮のみ、挙動不変）
- **書き込み経路（`pull/fast_path.ts:339,397`）は差し替えない**。fast_path は repaired 文字列そのものを disk に書くため repair 結果のバイト列が必要であり、`null` 返却では情報を失う。現状の 2 段呼び出しを維持し、コメントで理由を明示する。
- `gray-matter` の直接 import は **`utils/frontmatter.ts` の 1 箇所に集約**される。

### 3.5 R-5: スキャナ収束と `body_scan.ts` の冗長 harvest 除去

**(a) `collectArticleStorageKeys` の harvest 半減（挙動完全一致）**

```ts
// BEFORE (4 harvests, 2 of them redundant subsets)
harvest(scannedRefs, keyPattern);
harvest(content, keyPattern);
harvest(scannedRefs, localRefPattern);
harvest(content, localRefPattern);

// AFTER (2 harvests — identical result set)
harvest(content, keyPattern);
harvest(content, localRefPattern);
```

`scanArticleMediaReferences()` は本文の部分集合を返すため、`content` への直接走査が上位集合である。`scannedRefs` 経由の 2 harvest を削除し、**コメントを実測根拠に合わせて書き換える**（「opaque fence 内も含む」を担っているのは `harvest(content, ...)` である旨）。
→ `scanArticleMediaReferences` の import が未使用になる場合は削除する（未使用 import を残さない）。

**(b) `scanArticleMediaDetailed` の分類統合（`utils/media-refs.ts`）**

`scanRawMediaReferences()` に分類オプションを追加し、doctor 側のループ写像を除去する:

```ts
export interface ClassifiedMediaRef {
  url: string;
  kind: 'normal' | 'informational' | 'invalid';
}

export function scanClassifiedMediaReferences(
  bodyMarkdown: string,
  options?: {
    fencePolicy?: FencePolicyType;
    classify?: (url: string) => 'valid' | 'placeholder' | 'invalid';
  },
): ClassifiedMediaRef[];
```

- `classifyMediaUrl` / `isInlineCodeSpan` は Layer 0（`utils/media-refs.ts`）へ**移動**し、doctor の private から外す（URL 分類は診断文言ではなく AST 知識であり Layer 0 所属）。
- doctor の `scanArticleMediaDetailed()` は薄いラッパ（約 15 行）になり、`ScannedMediaReferences` の戻り型と check 文言は**不変**。
- export 解除の可否は §3.8 の grep ゲートで判断する。

### 3.6 R-6 (P8): workspace 記事走査の契約化（`src/sync/workspace/articles.ts`）

```ts
export interface WorkspaceArticleEntry {
  relPath: string; // e.g. "posts/draft/20261121_01M..._title.md"
  fullPath: string;
  status: 'draft' | 'published' | 'conflicts';
}

/**
 * Iterates the workspace's article files for a collection. The conflicts/ boundary and the
 * `.deleted.md` rescue backup are expressed as explicit options so the intent that currently
 * lives in six separate comments becomes one declared contract.
 */
export function iterWorkspaceArticles(
  workspaceRoot: string,
  collection: string,
  options?: { includeConflicts?: boolean; excludeDeletedBackups?: boolean },
): Iterable<WorkspaceArticleEntry>;
```

| 呼び出し側                                                                      | `includeConflicts`         | `excludeDeletedBackups` |
| ------------------------------------------------------------------------------- | -------------------------- | ----------------------- |
| `status.ts:162`, `doctor.ts:484,859`, `conflicts.ts:142`, `pull_library.ts:278` | `false`                    | `true`                  |
| `media/prune_protect.ts:68`                                                     | `true`                     | `true`                  |
| `article_search/local.ts:136-158`                                               | `options.includeConflicts` | `true`                  |

- **Layer 0→Layer 1 の依存は増えない**（`sync/workspace/` は Layer 2 に属し、`node:fs` / `path` のみ import）。AGENTS.md「Workspace Contracts」の既存責務（`findLocalFilesByUlid`, `CONFLICTS_SUBDIR`, `isQuarantinedRelativePath`, `resolveCanonicalArticlePath`）の延長線上に収まる。
- **AGENTS.md の Workspace Contracts 行へ本ヘルパーを追記する必要がある** → Ask First カテゴリ 4。P8 はオーナー承認後にのみ着手する。

### 3.7 R-7 (P6): `readTaxonomiesFromBaseline()` — fast-path の純粋関数化

`src/sync/article_search/remote.ts` から private 関数へ抽出（**ファイル移動なし**）:

```ts
interface BaselineTaxonomyRead {
  /** null = fast-path 不成立 → 呼び出し側が remote terms GET へフォールバックする */
  terms: { categories: string[]; tags: string[] } | null;
  reason:
    | 'cache-hit'
    | 'no-cache'
    | 'pending-flag'
    | 'rev-mismatch'
    | 'disk-modified'
    | 'no-snapshot'
    | 'no-recorded-taxonomies';
}

function readTaxonomiesFromBaseline(params: {
  cache: CacheClient;
  itemId: string;
  item: Record<string, unknown>;
  workspaceRoot: string;
}): BaselineTaxonomyRead;
```

- `reason` を返すことで、**5 前条件の各不成立経路を単体テストが名指しで検証できる**（現状は統合テスト経由のみ）。
- `healOnSpellingMatch: false` は本関数内部に閉じ込め、「検索は read-only、cache を汚染しない」契約を 1 箇所のコメント＋テスト（T-8）で担保する。
- **rev 算出（`extractRev` → `extractComparisonRev`）は関数内へ含める**（呼び出し側に残すと前条件の境界がずれる）。
- taxonomy 一致判定（`canonicalizeTaxonomiesForBaseline` → `taxonomyTermMatchesFilter`）は呼び出し側に残り、fast-path は**terms の読み取りだけ**を担う（IO 境界の分離）。
- `executeScanSearch()` は 372 行 → 約 240 行、fast-path 塊は約 105 行 → 呼び出し 8 行＋関数本体 90 行。

### 3.8 R-8: `scanArticleMediaDetailed` の export 整理（実測確定）

- **ゲート判定（実測確定）**: `grep -rn 'scanArticleMediaDetailed' src tests` を実施した結果、`tests/doctor.test.ts:32, 741, 750, 757` にて直接単体テストが行われていることを確認。
- 診断関数の単体テスト性を損なわないため、本版では `export function` を維持し、安全側に倒して §9 X-8（将来版への引き継ぎ）として扱う。
- `isTaskListItem` と `article_search/query.ts` の façade 露出も同様に本版で触らない（§9 X-5, X-6）。

### 3.9 R-9: 検索 limit 定数の正本化（`src/utils/search-options.ts`）

```ts
/** Hit cap shared by every search command — a search returning hundreds of rows is a listing, not a search. */
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;

export function clampSearchLimit(
  raw: number | undefined,
  fallback: number = SEARCH_DEFAULT_LIMIT,
): number {
  return Math.max(1, Math.min(raw ?? fallback, SEARCH_MAX_LIMIT));
}
```

- 呼び出し 4 箇所（§2.9）を差し替え。`MEDIA_SEARCH_MAX_LIMIT` / `ARTICLE_SEARCH_MAX_LIMIT` は**削除せず同一値への re-export** を残す（`src/index.ts:57` が `sync/article_search/index.js` を公開 re-export しているため、façade から即削除は破壊的変更 → Ask First カテゴリ 3。本版は re-export 据え置き）。
- maxScan 既定値（media 500 / article 300 / taxonomy 50）は**統合しない**。v0.1.44 で確立した意図的な差異であり、認識論的コストの差そのもの。

---

## 4. 実装フェーズとコミット分割

各 Phase は単独で `npm run check` を green に保てる単位に切る。Phase P0 の characterization test を**必ず先に**入れる（v0.1.37 Rev.2 で確立した規則）。

| Phase  | 内容                                                                                                        | 挙動変更                                                                        | Ask First      |
| ------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------- |
| **P0** | characterization test 追加（CLI media-search 出力 snapshot、article search fast-path 統合スナップショット） | なし                                                                            | —              |
| **P1** | R-1 日付境界集約＋メディア検索のエラーコード是正、`tests/media_search.test.ts:1177` 期待値更新              | **あり（エラーコード）** — バグ修正として CHANGELOG `Fixed`                     | —              |
| **P2** | R-2 `local_search.ts` 分離                                                                                  | なし                                                                            | —              |
| **P3** | R-3 メディア検索 presentation 化＋symmetry test 追加                                                        | なし（バイト不変）                                                              | —              |
| **P4** | R-4 `parseMarkdownLenient()` と 6 系統差し替え、`gray-matter` import 集約                                   | **あり（invalid ファイルが検索ヒットする）** — バグ修正として CHANGELOG `Fixed` | —              |
| **P5** | R-5 harvest 半減＋分類統合                                                                                  | なし                                                                            | —              |
| **P6** | R-7 fast-path 抽出、前条件テスト追加                                                                        | なし                                                                            | —              |
| **P7** | R-9 limit 定数正本化（re-export 維持）                                                                      | なし                                                                            | —              |
| **P8** | R-6 workspace 走査ヘルパー＋AGENTS.md 更新                                                                  | なし                                                                            | **カテゴリ 4** |
| **P9** | R-8 export 解除（grep ゲート通過時のみ）                                                                    | なし                                                                            | —              |

コミットは「P0+P1」「P2〜P5」「P6〜P7」「P8〜P9」の 4 分割を推奨する。P1 と P4 は挙動変更を含むため単独 commit が望ましい。

---

## 5. テスト設計

### 5.1 R-1（新規 + 既存更新）

| ID  | ケース                                            | 期待                                                                            |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| D-1 | `searchRemoteMedia({ since: 'last-week' })`       | `code: 'DATE_BOUNDARY_INVALID'`, `status: 400`, suggestion に日付例             |
| D-2 | `searchLocalMirrorMedia({ until: '2026-02-31' })` | 同上（rollover 拒否は既存挙動の維持）                                           |
| D-3 | `searchRemoteArticles({ since: 'today' })`        | 挙動不変（回帰レール）                                                          |
| D-4 | 静的検査                                          | `grep -c 'Invalid date boundary:' src/` == **1**（`utils/search-date.ts` のみ） |

→ `tests/media_search.test.ts:1177` の T1-6 期待値を `MEDIA_SEARCH_QUERY_REQUIRED` → `DATE_BOUNDARY_INVALID` に更新。**T1-8（空クエリ拒否）は `MEDIA_SEARCH_QUERY_REQUIRED` のまま**（正しい用途であり変更しない）。

### 5.2 R-4

| ID  | ケース                                                | 期待                                                                         |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| F-1 | percent-encoded taxonomy が unquoted で壊れたファイル | `parseMarkdownLenient()` が non-null を返し、検索がヒットさせる              |
| F-2 | 同一ファイルを `getWorkspaceStatus()` で確認          | `invalid: true, healable: true` と**一致**（diagnostic alignment invariant） |
| F-3 | YAML として完全不成立のファイル                       | `null` を返し、検索は当該ファイルをスキップ（現状維持）                      |
| F-4 | 静的検査                                              | `grep -rn "from 'gray-matter'" src` == **1 件**（`utils/frontmatter.ts`）    |

### 5.3 R-3（characterization → symmetry）

- P0 で `tests/cli_media_search.test.ts` に offline / remote hit / empty / walk-incomplete の 4 経路の console 出力 snapshot を追加（既存 `cli_pull_snapshot.test.ts` と同じ vitest snapshot 機構）。
- `tests/presentation_symmetry.test.ts` に追加:
  - **S-1**: `formatMediaSearchWalkIncompleteNotice(result, {isMcp:false})` と `{isMcp:true}` の差分が `--max-scan` / `maxScan` の語のみであること
  - **S-2**: CLI と MCP が同一関数を import していること（静的検査。既存 :184 の pull 系パターンに倣う）

### 5.4 R-7（fast-path 前条件）

| ID  | 前条件                                                   | 期待 `reason` / 挙動                               |
| --- | -------------------------------------------------------- | -------------------------------------------------- |
| T-1 | cache なし                                               | `no-cache` → GET 経路                              |
| T-2 | `deletePending === 1`（他 3 フラグも同型）               | `pending-flag` → GET                               |
| T-3 | `sync_state.remoteRev` 不一致                            | `rev-mismatch` → GET                               |
| T-4 | disk hash 相違（未 push 編集）                           | `disk-modified` → GET                              |
| T-5 | baseSnapshot なし                                        | `no-snapshot` → GET                                |
| T-6 | snapshot に taxonomy 記録なし（legacy スナップショット） | `no-recorded-taxonomies` → GET                     |
| T-7 | 全条件成立                                               | `cache-hit`、`terms` に Layer A slug、**GET ゼロ** |
| T-8 | T-7 実行後 `sync_state.local_hash` が**変わらない**      | cache 非汚染（read-only 契約）                     |

### 5.5 R-5 / R-9

- **M-1**: opaque fence 内に `/_emdash/api/media/file/<key>.jpg` を持つ記事で、`collectArticleStorageKeys()` の結果が**変更前後で同一**（harvest 半減の等価性）。
- **M-2**: code fence 内の storageKey も従来どおり descriptor に含まれること（`content` 直接走査のため当然だが、固定テストとして追加する）。
- **L-1**: `clampSearchLimit(undefined)` == 20、`clampSearchLimit(0)` == 1、`clampSearchLimit(999)` == 50。
- **L-2**: 静的検査 `grep -c 'Math.max(1, Math.min' src/` == **1**（`utils/search-options.ts`）。

---

## 6. リスクと対策

| リスク                                                                                                 | 実測根拠                                                                                                                                                                                    | 対策                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| エラーコード是正が既存ユーザーのスクリプトを壊す                                                       | `MEDIA_SEARCH_QUERY_REQUIRED` を期待する外部スクリプトの有無は不明。ただし「クエリが必要」という誤示唆に依存する想定は困難                                                                  | CHANGELOG `Fixed` に破壊的変更として明記。`guards.ts` の registry は両コード登録済みのため guard gate は無変更                                                                                                                                     |
| CLI 出力のバイト漂移                                                                                   | `cli/commands/media.ts:104-176` に 65 行の整形がインライン、既存テストは検索ヒット検証のみで**出力文言を固定していない**（実測: `tests/cli_media_search.test.ts` は option 公開と件数のみ） | P0 で snapshot を先に取得。P3 の差分は import 移動のみとする                                                                                                                                                                                       |
| `parseMarkdownLenient()` が invalid ファイルを検索に乗せ、エージェントが壊れた記事を編集対象と誤認する | `article_search/local.ts` はヒット時に tracking status を返すため、`invalid` が untracked と同列に見える                                                                                    | ヒット行へ診断を表示する変更は本版のスコープ外。P4 の挙動変更を CHANGELOG に明記し、`emit status` / `doctor` が `healable` を報告していることを既存 hint（`formatArticleSearchOfflineHint`）の語彙で参照する                                       |
| harvest 半減で storageKey 検出が漏れる                                                                 | `scanArticleMediaReferences()` は opaque fence を除外するため、fence 内のみ出現する key は scannedRefs 側に無い。現行コードでも `harvest(content, ...)` が拾っている                        | M-1/M-2 で結果集合の同値を機械的に固定                                                                                                                                                                                                             |
| workspace ヘルパーが conflicts/ を含む走査意図を壊す                                                   | `prune_protect.ts:68` は conflicts/ を**含める**ことが契約。誤って `false` にすると quarantine 内の参照が保護されずメディアが削除される                                                     | `includeConflicts` の既定値を `false` とし、prune_protect 呼び出しに明示指定。`tests/media.test.ts` の prune 保護ケースを無変更で green にする                                                                                                     |
| fast-path 抽出で rev 比較の副次処理がずれる                                                            | `extractRev` / `extractComparisonRev` は `remote.ts:452-454` で inline 呼び出し。Base64 transport token から version を抜き出す挙動は v0.1.44 の実測修正に基づく                            | 抽出時に rev 算出を**関数内へ含める**（呼び出し側に残さない）。T-3 と T-7 で固定                                                                                                                                                                   |
| layering gate 誤検知                                                                                   | `local_search.ts` 新設で Layer 2 内部 edge が増える                                                                                                                                         | sibling coupling は name-by-name snapshot（`orchestrator`→pull/push/media、`doctor`→conflicts/media、`push\|pull/media_stage`→media）。`local_search.ts` は `types.js` と `utils/*` のみ import するため新規例外は不要。無変更 green を DoD とする |
| 循環依存の再導入                                                                                       | `body_scan.ts` から `scanArticleMediaReferences` import を削除するのは edge を減らす方向。classify 移動は Layer 0 内移動                                                                    | `npm run check:cycles` を各 Phase で実行（現在 0 件）                                                                                                                                                                                              |

---

## 7. Definition of Done (DoD)

1. [x] `src/utils/search-date.ts:resolveSearchDateBoundaries()` が新設され、日付境界の `ApiError` 生成が src 内で **1 箇所**になっている（`grep -c 'Invalid date boundary:' src/` == 1）。
2. [x] メディア検索の日付エラーが `DATE_BOUNDARY_INVALID` を返し、`tests/media_search.test.ts` T1-6 が更新済みで green。空クエリ拒否（T1-8）は `MEDIA_SEARCH_QUERY_REQUIRED` のまま。
3. [x] `src/sync/media/types.ts` の `export function` が **ゼロ**に戻り、`searchLocalMirrorMedia()` は `src/sync/media/local_search.ts` に所在。barrel と `ALLOWED_LAYER_2_SYMBOLS` は無変更。
4. [x] メディア検索の header / empty / hit / walk-incomplete / usage hint / tag hint / size がすべて `src/presentation/media_report.ts` 経由になり、`src/cli/commands/media.ts` のインライン整形がゼロ。CLI 出力は P0 snapshot と**バイト単位で一致**。
5. [x] `tests/presentation_symmetry.test.ts` に検索系の対称性ケース（S-1, S-2）が追加され green。
6. [x] `src/utils/frontmatter.ts:parseMarkdownLenient()` が新設され、`gray-matter` の直接 import が **`utils/frontmatter.ts` の 1 箇所のみ**。`sync/article_search/local.ts` は lenient ルートを使用し、F-2 で status / doctor と診断が一致。
7. [x] `collectArticleStorageKeys()` の harvest が 2 回に半減し、M-1/M-2 で結果集合の同値が固定済み。未使用 import ゼロ。
8. [x] `executeScanSearch()` が約 240 行へ縮小し、`readTaxonomiesFromBaseline()` の `reason` による前条件テスト T-1〜T-8 が green（T-8 で cache 非汚染を担保）。
9. [x] limit clamp 式が src 内で **1 箇所**（`grep -c 'Math.max(1, Math.min' src/` == 1）、maxScan 既定値は media / article / taxonomy の差異を維持。
10. [x] （オーナー承認後）`src/sync/workspace/articles.ts:iterWorkspaceArticles()` が新設され、6 箇所の走査ループが差し替え済み。AGENTS.md Workspace Contracts 行に本ヘルパーが追記されている。
11. [x] `tests/layering.test.ts`（Axis 0〜5）と `tests/guards.test.ts`（Rule 1〜5）が**無変更**で green。新規エラーコード追加ゼロ、`ALLOWED_LAYER_2_SYMBOLS` 無変更。
12. [x] 非 CLI モジュールに `console.log` / `console.debug` ゼロ（Axis 5）、循環依存 0 件（`npm run check:cycles`）。
13. [x] `CHANGELOG.md` に `## [0.1.45] - 2026-11-21` セクションが追記され、`package.json` / `package-lock.json` が `0.1.45`。P1・P4 の挙動変更は `Fixed`、リファクタリングは `Changed` に分離して記載。
14. [x] `npm run check`（format:check / typecheck / check:cycles / test）が 100% green。

---

## 8. 実装順序（推奨）

1. **P0 → P1**（日付境界・エラーコード）— 唯一のバグ修正群のうち最初で、影響範囲が最も狭い。D-1〜D-4 を先に RED から書く。
2. **P4**（`parseMarkdownLenient()`）— 同じくバグ修正（診断不整合）。F-1〜F-4。P1 とは独立だが commit は分ける。
3. **P2 → P3**（media types 分離 → presentation 集約）— P0 の snapshot が取れていれば P3 は import 移動のみの安全な差分になる。
4. **P5 → P6**（スキャナ収束 → fast-path 抽出）— P6 は v0.1.44 の追加コードに対する後追い検証強化であり、テストコストが最も高い。T-1〜T-8 を先に書く。
5. **P7**（limit 定数）— 純粋な機械的置換。
6. **P8**（workspace ヘルパー）— オーナー承認後にのみ着手。
7. **P9**（export 解除）— grep ゲート結果で可否を判断。

各 PR で `npm run check` を green に保ち、DoD の該当項目のみチェックする。

---

## 9. 本計画書が扱わない残存課題（将来版への引き継ぎ）

| ID       | 課題                                                                                                                         | 除外理由                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **X-1**  | `tryFastPathOrHeal`（432 行, `sync/pull/fast_path.ts:60-491`）の stage 分割                                                  | v0.1.37 から未着手で最長の残存関数。fast-path / heal / taxonomy prune の分岐が baseline snapshot 書き込みと不可分。characterization test なしに割ると Two-Layer 表現と 0-GET pruning の契約を壊す。次版の単独テーマにする                                                                                                                                                     |
| **X-2**  | `runMediaIntegrityChecks`（465 行, `sync/doctor.ts:465`）の further 分割                                                     | v0.1.37 P1 で 3 群へ分割済み。Check 6 は cache fallback / live probe / library census の 3 段だが、`--check-media-urls`・`--check-media-library` の opt-in HTTP が同一 scope の変数に依存しており、追加分割は副作用配置の実測再確認を要する（v0.1.37 Rev.2 の教訓）                                                                                                           |
| **X-3**  | cursor pagination ループの共通化（`pull/list.ts:150-182`, `media/remote_index.ts:146-190`, `article_search/remote.ts:332-`） | 3 系統は envelope unwrap・停止条件・収集先がすべて異なる（pull は targetTotal、media は maxItems＋`since` 境界、search は maxScan＋hit limit＋series 完遂）。共通化すると認識論的停止条件（`walkComplete` / `complete` の算出）が呼び出し側に漏れ、v0.1.42〜44 で確立した「不在を断定しない」規則を薄める。`unwrapEnvelope()` は既に Layer 0 集約済みで、重複はループ制御のみ |
| **X-4**  | `pullMedia()`（261 行）の targeted / article / library 3 分岐分離                                                            | v0.1.42 で targeted 分岐が前置され、census と prune protection が library 分岐に同居。分離は可能だが AGENTS.md §7「pruning authority is remote records only」の invariant を移設することになり、`collectLocalMediaIds()` 再導入リスクを伴う。単独テーマにすべき                                                                                                               |
| **X-5**  | `isTaskListItem`（`client/portable-text.ts:178`）の削除または実装                                                            | コード内コメントで「future EmDash task-list schema integration (P4)」と明記された予約ヘルパー。削除は将来の実装計画と矛盾し、実装は AST マッパーの変更（Portable Text round-trip 契約）を伴うため本版のスコープ外                                                                                                                                                             |
| **X-6**  | `article_search/query.ts` の 4 関数の公開 façade からの除外                                                                  | `src/index.ts:57` が `export * from './sync/article_search/index.js'` で内部 helper まで露出。`index.ts` を `types.js` と検索関数の明示 export へ絞る提案は**公開 npm API の縮小**であり Ask First カテゴリ 3。別途オーナー協議を要する                                                                                                                                       |
| **X-7**  | offline framing の記事 / メディア 2 系統統合（`article_report.ts:103-135` と `:185-215`)                                     | 「scanned N mirrored asset(s)」/「scanned N article(s)」の語差があり、統合はユーザー可见文言の変更を伴う。認識論的保護自体は両系統で成立しており、緊急度低い                                                                                                                                                                                                                  |
| **X-8**  | `scanArticleMediaDetailed` の export 解除とテスト直接 import の整理                                                          | `tests/doctor.test.ts:32` 等で直接単体テストが行われており、テストの import 経路を Layer 2 公開 API 経由へ寄せるのは診断関数の単体テスト性を損なうため本版では export を維持。AGENTS.md の doctor 記述との整合性整理とともに次版以降で扱う                                                                                                                                    |
| **X-9**  | `src/db/cache.ts`（709 行）・`src/db/migrations.ts`（360 行）の分割                                                          | Ask First カテゴリ 2。cohesion が高く分割メリットは薄い（v0.1.34 X-1/X-2 から継続据え置き）                                                                                                                                                                                                                                                                                   |
| **X-10** | `runPreflightChecks`（約 440 行）の stage 分割                                                                               | 同期的直列バリデーションであり過剰分割（v0.1.34 X-6, v0.1.37 X-5 から継続）                                                                                                                                                                                                                                                                                                   |
| **X-11** | `article_search` の AGENTS.md 層表記載                                                                                       | `tests/layering.test.ts:59` は Layer 2 として登録済みだが、AGENTS.md の Layer 1 / Layer 2 行に `article_search` が無く、**テストだけが知っている境界**になっている。P8 の AGENTS.md 更新時に併記するのが自然だが、コア原則の追記であるためカテゴリ 4 の確認事項として分離して扱う                                                                                             |
