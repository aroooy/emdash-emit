# v0.1.15 Refactor Plan — 前提資料の整合回復と Media Pipeline の構造整理

**策定日**: 2026-11-12
**対象リポジトリ**: `emdash-emit`（HEAD: `62ea48c` / `package.json` version `0.1.14`）
**監査区間**: `51fd974b200d9d3f44d21b6d5c0c212a9412ad07..HEAD`（16 commits / 未リリースの v0.1.14 作業分）
**検証済み状態**: `npm run check` → **36 test files / 414 tests 全 green**（format:check + typecheck(src+tests) + vitest）

---

## 0. この計画書の位置づけ（最初に読むこと）

監査で検出した問題は **2 種類に明確に分かれる**。この区別を崩すと修正を誤る。

| 区分 | 内容 | 処置方針 |
|---|---|---|
| **A. 実装の品質** | 挙動・ガード・hash 整合性・テスト網 | 概ね良好。**挙動を変えずに構造だけ直す**（R1 以降） |
| **B. 前提資料と実装の乖離** | README / AGENTS.md / CHANGELOG がコードと食い違い、互いにも食い違い | **コードを直さず文書を正す**。ただし 1 件は人間の承認で決着済み（下記 §0.1） |

### 0.1 確定した前提：`postsSyncLimit` 100 → 30 は**人間の承認済み変更**

commit `4c0e41e` が行った記事スライディングウィンドウの縮小（100 → 30）は、
設計上・パフォーマンス上の都合により **オーナ（hiroaki）が明示的に許容した**。したがって:

- **これは「AI が都合よく変えた疑い」ではない。** 疑いの対象から除外する。
- 残る欠陥は**伝達だけ**: この承認が `git log` のコミット本文にしか存在せず、
  `CHANGELOG.md` / `README.md` / `AGENTS.md` のいずれにも記録されていない。
  さらに README は 3 箇所で default を **100 のまま**記述している（→ A-1 で文書側のみ修正）。
- 実データは承認と整合している: `/Volumes/ext/github/emdash.aroooy.net/.emit/config.json` は
  `"postsSyncLimit": 30` を保持し、`published` 30 本 / `draft` 30 本が window に乗っている。

### 0.2 「Non-Goals との整合」表は**陳腐化した記述として更新する**（本書で確定させる）

`docs/local-first-media-pipeline-plan.md` §1.3 は「bulk 移行は対象外（limit 思想を維持）」とした。
実装された local-first mirror stage（`orchestrator.ts:299-378`）は次のとおりであり、**§1.3 の意図は
"binary を落とさない" という点では守られているが、"walk しない" とは書かれていない**:

```text
collectRemoteStorageKeys(maxItems 未指定 = Infinity)  → 全ライブラリの JSON walk（cursor 100 件ずつ）
mirrorReferencedAssetsFromIndex(...)                  → 本文が参照した key の binary のみダウンロード
```

つまり **local-first mirror stage による binary 転送量は §1.3 の約束どおりに抑制されている**が、**D1 list 走査は full-library 無制限**である。
これは §1.3 の範囲外ではなく、§1.3 が想定していなかった第 3 の経路である。→ **R2 で §1.3 を実測に合わせて書き換え、
walk の上限 policy を明示する**。本書の実装タスクは「walk を止めること」ではなく
**「walk が走ることを隠さないこと」**（診断出力とドキュメントでの明示）である。

---

## 1. Detection Index（監査で確定した不整合の一覧）

すべて実コードに照合済み。番号はこの後の task の参照先になる。

### A-1 `postsSyncLimit` の default が README 3 箇所で 100 のまま（承認済みの値と文書が不一致）

| 場所 | 記述 | 実装 |
|---|---|---|
| `README.md:286` | init 出力例 `"postsSyncLimit": 100` | `src/utils/config.ts:74` → **30** |
| `README.md:147` | "default: latest 100" | 同上 |
| `README.md:666` | "sliding window (`postsSyncLimit`, default `100`)" | 同上 |
| `README.md:297` | Default 表は `30`（**ここだけ正しい**） | — |
| `CHANGELOG.md` | v0.1.14 エントリに記載なし | `git log 4c0e41e` にのみ存在 |
| `AGENTS.md` | 言及なし | — |

さらに同じ 30 が **3 重管理**: `DEFAULT_CONFIG.postsSyncLimit = 30` /
`src/cli/commands/pull.ts:229` の `|| 30` / `src/mcp/tools/sync-pull.ts:160` の `|| 30`。→ **R2 + R4**。

### A-2 `localMediaRefs` の既定値が 3 文書で 3 様

```text
CHANGELOG.md:15  "New workspace setting ... (default false) ... workspace-relative media/<storageKey>"  ← 初版 5fc6b07 の記述が残存
README.md:299    localMediaRefs | true | Default-ON ... ../../media/<storageKey>                         ← 正しい
AGENTS.md:152    default-ON ... ../../media/<storageKey>                                                 ← 正しい
config.ts:175    parsed.localMediaRefs !== false                                                         ← default-ON / 記事相対
```
CHANGELOG の当該項は `2afc7f3`（既定 ON・記事相対化）以降更新されていない。**opt-in 機能だと読むと誤る**。→ **R2**。

### A-3 ガード番号体系が三重に破綻（AI agent が最も誤誘導される箇所）

```text
AGENTS.md:104   "Preflight Guards (G1–G17)"
AGENTS.md:182   Guard G18 (DESTRUCTIVE_TAXONOMY_WIPE)      ← 宣言範囲 G1–G17 を超える
AGENTS.md:177   見出し「(G15 / G16)」配下に G15・G18・番号なし DELETE_PENDING_ARTICLE が混在
README.md:37    TOC "Preflight Safety Guardrails (G1–G12)"
README.md:542   見出し "(G1–G14)" / 本文 "enforces 14 strict preflight guardrails"
README.md:562   | **Guard** | DUPLICATE_SLUG_GUARD |       ← 番号セルが壊れている
実コード        preflight.ts の code は G1〜G10 + G11 のみ。G12〜G17 は push.ts / conflicts.ts 側、
              DELETE_PENDING_ARTICLE (push.ts:674), TAXONOMY_CONFLICT_PENDING (push.ts:711),
              TAXONOMY_APPLY_PENDING (push.ts:726), DESTRUCTIVE_TAXONOMY_WIPE=番号なし (push.ts:803,1232),
              DuplicateSlugError.code = 'DUPLICATE_SLUG_CONFLICT' (new.ts:45) ← 文書は DUPLICATE_SLUG_GUARD
```

**影響**: README を読む agent には G15〜G17 が存在しない。`docs/v0114-plan/fix-spec-v0114.md:28` は既に
「issues-v0114 の Guard G8 は実は G6」を指摘済みで、**この種の誤りは再現している**。→ **R1**。

### A-4 AGENTS.md の見出し番号が章構造から外れ、被参照が解決しない

`## 4` 配下が `### 1 … ### 12`。うち `### 7 Media Mirror Naming & Index-Based Pruning Invariant` は
**ガードではなく invariant**。ところが `docs/local-first-media-pipeline-plan.md`（冒頭 NOTE 2 件）と README が
「権威ある仕様は **AGENTS.md §7**」と参照する。§7 の直後が §8〜§12 まで guard 節のため、AI は目的の節に辿り着けない。→ **R2**。

### A-5 コード内の説明コメントが実挙動と矛盾（コードは正しい）

```text
media.ts:714-715  "…the upload path uses the content hash and simply overwrites"
media.ts:722      localHash: `media-record:${item.id}`   ← pull / push が交互に上書きする非対称が残る
```
→ **R3**（comment）＋ **R6**（本体、設計判断）。

### A-6 文書に残存する旧記述（実装は先行済み）

| 場所 | 記述 | 実装 |
|---|---|---|
| `README.md:672` | `--media`: "Also pull media assets ... bounded by `mediaSyncLimit`" | `--media` は**フルライブラリ追加取得**。既定で local-first mirror が走る（CLI option 本文は `pull.ts:147-150` で修正済み） |
| `AGENTS.md` step 1 / `README.md:904-922` / `mcp/server.ts:90,97` | 「`includeMedia:true` で media も pull」 | batch は `mediaSync: !postsOnly` が既定 ON（`pull.ts:254`, `sync-pull.ts:205`）。README の該当 NOTE に `localMediaRefs` への言及なし |
| `docs/local-first-media-pipeline-plan.md` §1.3 | 「limit 思想を維持」 | walk は `maxItems = Infinity`（§0.2 で確定扱い） |

→ **R2**。

### A-7 リポジトリ hygiene（AI が残した副産物）

- commit `a69dca9 chore: remove the temporary commit-message scratch file` — **AGENTS.md §1「throwaway files 禁止」を
  コミット自体が破った履歴**。scratch は削除済みだが、再発防止のルールが AGENTS.md に追加されていない。
- `51fd974` が診断ログ 9 個（空ファイル含む: `v13_conflicts_now.txt`, `v13_gsum.txt`）を `docs/v0112-eval/logs/` に
  混入させたまま。`docs/.DS_Store` も gitignore 外。→ **OD-4**。

### A-8 命名迁移の実測状態（本番ワークスペース、参考データ）

`/Volumes/ext/github/emdash.aroooy.net`: `media/` 配下 **196 ファイル = 98 asset × (binary + .yaml)**、
**すべて storageKey 由来の bare ULID 名**（例 `01M67NWMZZHDFXP9QQB0MR7P6X.jpg` + `.yaml`）。
`legacy_*` 残留 **0 件**、旧 `<yyyyMMdd>_<id>-<name>` 形も 0 件。本文は `![](../../media/<storageKey>.jpg)` に再表記済み。
→ **b978bbb / 2afc7f3 の迁移は本番で完結している**。legacy 対応コードは**新規作成ではなく既存 corpus 保護** purpose と明記する（§4.1）。

---

## 2. Task Breakdown（R1〜R6）



各 task は **独立して merge 可能**（依存は R1 → R2 のみ）。挙動変更を伴う task は §3 の regression lock を必須とする。

### R1 【P0・文書】Guard Registry の一元化（A-3 解消）

**目的**: ガード番号の正本をコード側に生成させ、README / AGENTS.md の表を従属させる。
**対象**: `src/sync/guards.ts`（新規）, `README.md`, `AGENTS.md`, `tests/guards.test.ts`（新規）

1. `src/sync/guards.ts` にメタデータを宣言する（挙動は一切変更しない、**記述だけの新 module**）:

```ts
export interface GuardMeta {
  /** Canonical number used in every document and every user-facing message. */
  id: number;
  code: string;
  severity: 'error' | 'warning' | 'info';
  /** Where the guard actually runs — documents must not claim "preflight" for push-side guards. */
  stage: 'preflight' | 'push' | 'conflicts' | 'new';
  /** Exact source location, so a document can never drift again. */
  source: string;
}
export const GUARD_REGISTRY: readonly GuardMeta[] = [ /* G1..G21 */ ];
```

2. 実コードの照合結果に基づく確定表（**本書が権威**。開発者はこの表を `GUARD_REGISTRY` に転写すること）:

| id | code | stage | source |
|---|---|---|---|
| G1 | `SINGLE_TARGET_GUARD` | push | `src/sync/push.ts` (target resolution) |
| G2 | `ID_MISMATCH_ERROR` | preflight | `src/sync/preflight.ts:377` |
| G3 | `UNINTENDED_PUBLISH_GUARD` | preflight | `preflight.ts:389` |
| G4 | `INVALID_TAXONOMY_ERROR` | preflight | `preflight.ts:440` |
| G5 | `LOCAL_IMAGE_DETECTED` / `INLINE_LOCAL_IMAGE_NOT_SUPPORTED` / `MISSING_LOCAL_IMAGE_FILE` | preflight | `preflight.ts:515,545,555,608` |
| G6 | `UNRESOLVED_CONFLICT_MARKERS` | preflight | `preflight.ts:642` |
| G7 | `TITLE_DUPLICATION_AUTOTRIM` | push | `src/sync/push.ts` (autotrim) |
| G8 | `UNSUPPORTED_SYNTAX_WARNING` | preflight | `src/client/portable-text.ts` via preflight |
| G9 | `MODIFIED_OPAQUE_BLOCK` | preflight | `preflight.ts:672` |
| G10 | `INVALID_FEATURED_IMAGE` | preflight | `preflight.ts:630` |
| G11 | `LOCAL_IMAGE_AUTO_UPLOAD` (+ `INVALID_LOCAL_IMAGE_TYPE`, `LOCAL_IMAGE_SIZE_EXCEEDED`, `PROMOTED_MEDIA_NOT_FOUND_REMOTE`, `[MEDIA_EXISTENCE_UNVERIFIED]`) | preflight / push | `preflight.ts:564,574` + `src/sync/push.ts` |
| G12 | `QUARANTINED_COPY_NOT_PUSHABLE` | push | `src/sync/push.ts:581` |
| G13 | `CANONICAL_HAS_UNPUSHED_EDITS` | conflicts | `src/sync/conflicts.ts:67` |
| G14 | `QUARANTINED_PATH_REQUIRED` | conflicts | `src/sync/conflicts.ts:86` |
| G15 | `TAXONOMY_CONFLICT_PENDING` | push | `src/sync/push.ts:711` |
| G16 | `DELETE_PENDING_ARTICLE` | push | `src/sync/push.ts:674` |
| G17 | `TAXONOMY_APPLY_PENDING` | push | `src/sync/push.ts:726` |
| **G20（新）** | `DUPLICATE_SLUG_CONFLICT` | new | `src/sync/new.ts:45` |
| **G21（新）** | `DESTRUCTIVE_TAXONOMY_WIPE` | push | `src/sync/push.ts:803,1232` |

> **番号政策**: 上表は AGENTS.md の現行呼称（G15 = taxonomy conflict pending / G16 = delete pending /
> G17 = apply pending）を**そのまま固定**し、これまで番号を持たなかった 2 つを末尾 **G20 / G21** に置く。
> 既存の CLI 出力・テスト文言・ユーザーの記憶を壊さないためである（OD-1 の推奨）。
> 段差（G18 / G19 が欠番）が生まれる場合は `GUARD_REGISTRY` 側に「reserved, never assigned」のコメントを置き、
> 文書には "G1–G17 + G20–G21" と正直に書くこと。

3. `tests/guards.test.ts`: registry と実コードの code 文字列集合が一致することを assert する
   （`preflight.ts` / `push.ts` / `conflicts.ts` / `new.ts` に現れる literal code を走査し、registry 外 code を検出したら fail）。
   これが「文書が再度漂移しない」ための唯一の構造的担保になる。
4. README の表を registry から生成した内容に差し替え（TOC `G1–G12` → 実際の範囲、"14 strict guardrails" → 正しい数）、
   AGENTS.md §4 冒頭の "G1–G17" を宣言範囲に修正、`README.md:562` の壊れた番号セルを修復。

**完了条件**: `npm run check` green + `tests/guards.test.ts` が registry↔code の一致を保証。
**禁止**: この task で guard の挙動・評価順序を変えない（順序変更は §4 OD-2 に分離）。

### R2 【P0・文書】既定値の伝達を復元（A-1 / A-2 解消）

1. `CHANGELOG.md` `[Unreleased]`:
   - `localMediaRefs` 項を**現状どおりに書き換え**: default **ON**、disk 表記は **article-relative `../../media/<storageKey>`**。
   - **"Changed" セクションを新設**し `postsSyncLimit: 100 → 30` を独立項にする。
     「window から落ちる記事が prune 対象になる」影響と、**オーナ承認済み（設計上・パフォーマンス上の都合）**である旨を明記。
2. `README.md`: 147 / 286 / 666 の **100 → 30**。§「Sliding Window "Staging Desk" Model」に
   「default 30（published 30 + draft 30 = 最大 60 ファイル）」の実数を追記。二重 `|| 30` は R4 で除去。
3. `AGENTS.md` §3 Golden Path step 1 に window default と local-first media mirror stage（既定 ON）の一文を追加。
4. `docs/local-first-media-pipeline-plan.md` §1.3 の Non-Goals 表を §0.2 の実測に合わせて更新
   （「binary は参照分のみ」は維持、「list walk は full-library 無制限」を明記）。
5. **R1 完了後に実施**（CHANGELOG / README の guard 表を触るため）。

### R3 【P0・構造】`src/sync/media.ts`（1494 行）の分割

**目的**: 5 职责の分離。**挙動不変**が条件。呼び出し側は import 経路のみ変更する。
**安全性根拠**: `tests/media.test.ts` が 29 tests で表面（naming / index / mirror / pull-article / prune）をカバー済み。

```text
src/sync/media/
  types.ts          EmDashMediaItem, OrphanMediaDescriptor, LocalMediaMirrorCandidate,
                    MediaMirrorNames, PullMediaOptions, PullMediaResult, RemoteStorageKeyIndex,
                    MirroredAssetResult, PromotedMediaFile, PromoteDraftMediaOptions
  naming_mirror.ts  mediaMirrorNames, resolveMarkdownRefCollision, mediaRecordIdForStem,
                    cleanupDuplicateMediaFilesForId, moveFileSafe, MEDIA_BINARY_EXTENSIONS
  companions.ts     storageKeyFromMediaMeta, collectLocalMediaMirrorCandidates, buildMediaMetaDoc
  body_scan.ts      collectArticleReferencedMediaIds, collectArticleStorageKeys,
                    dedupeDescriptorsByStorageKey   ← R5 の共通 parser に接続点を残す
  remote_index.ts   collectRemoteStorageKeys, findUnmirroredStorageKeys
  mirror_item.ts    syncSingleMediaItem, promoteDraftMediaFile
  pull_library.ts   pullMedia（library 経路 + --prune）
  pull_article.ts   pullArticleMedia
```

**互換性要件**: `src/sync/media.ts` を **barrel（re-export のみ）**として残す。
`pullMedia` / `pullArticleMedia` / `collectRemoteStorageKeys` / `findUnmirroredStorageKeys` /
`storageKeyFromMediaMeta` / `promoteDraftMediaFile` / `collectArticle*` / `mediaMirrorNames` を
既存の import 元（`orchestrator.ts`, `doctor.ts`, `preflight.ts`, `push.ts`, `cli/commands/pull.ts`,
`mcp/tools/sync-pull.ts`, 全 tests）がそのまま解決できること。**テストの import 文は変更しない**。

**追加の是正（同じ file で行う、挙動は変えない）**:
- `media.ts:714-715` のコメントを実挙動に合わせる（A-5）。**コード側 `local_hash` の非対称そのものは R6 に分離**。
- `RemoteStorageKeyIndex.mediaIdsByStorageKey` は現状 `pullMedia` が set するが読む側がない
  （`tests/media.test.ts:1181,1216,1336` が assert）。**削除せず**「reporting-only field」とコメントで役割を固定する
  （暗黙削除による test churn を避ける）。

### R4 【P1・構造】magic number と default の単一ソース化

| 現在 | 処置 |
|---|---|
| `pull.ts:229` / `sync-pull.ts:160` の `|| 30` | 削除して `DEFAULT_CONFIG.postsSyncLimit` を参照（default の唯一の定義を `src/utils/config.ts` に寄せる） |
| `mediaSyncLimit ?? 300` が `media.ts:1048`, `pull.ts:315,467`, `sync-pull.ts:247,353` | `DEFAULT_MEDIA_SYNC_LIMIT` を config から export し参照（値は 300 のまま変更しない） |
| `batchSize = 100` が `media.ts:1050,1286` に 2 重 | `MEDIA_LIST_PAGE_SIZE` 定数へ（**live EmDash は `totalCount` を返さない**前提をコメントで明記） |
| `DEFAULT_MAX_MEDIA_REF_BYTES = 180`, article filename 120 B | 変更しない。POSIX NAME_MAX 255 B との関係を `naming.ts` のコメントで 1 箇所に集約 |

**回帰テスト**: `tests/workspace.test.ts` の config round-trip（現 86-91 行）に
「`postsSyncLimit` 未設定 → 30」「明示 250 → 250」を現状維持として assert 追加。

### R5 【P1・構造】media reference parser の統合（DRY）

**実測した重複**（すべて別 regex で同じ asset を読んでいる）:

```text
src/utils/media-body-refs.ts   MEDIA_FILE_ROUTE_PREFIX（唯一の定数）+ storageKeyFromCanonicalUrl / storageKeyFromMirrorRef
src/client/media.ts:92         `/_emdash/api/media/file/${storageKey}` を再構築
src/sync/media.ts:71,651,720   同上をリテラル 3 箇所
src/sync/preflight.ts:259      同上
src/sync/delete.ts:79-95       scanArticleMediaReferences（mdRegex / htmlRegex）
src/sync/doctor.ts             VALID_MEDIA_FILE_KEY, MEDIA_ULID_IN_URL, mdRegex, htmlRegex, legacyContainerRegex
src/sync/media.ts:432-508      collectArticleReferencedMediaIds（yaml.load → parseMarkdown → lenientRepair → raw regex の 4 段）
src/sync/media.ts:318          collectArticleStorageKeys が scanArticleMediaReferences(...).join('\n') に再 regex（二重走査）
```

**方針**:
1. `src/utils/media-refs.ts`（新規）に共通 parser を置く:
   `parseArticleMediaRefs(content): { canonical[], local[], opaque[], informational[], invalid[] }`
   — frontmatter は 1 度だけ parse（`parseMarkdown` → 失敗時 `lenientRepairMarkdownFrontmatter` の 2 段で十分。
   yaml.load と raw regex の 4 段フォールバックは廃止）、body は**行単位**で 1 走査。
2. fence policy を**コード上で 1 か所に宣言する**。現状 doctor は backtick と `~~~` を fence 扱い、
   G5/G11 は backtick のみ（`doctor.ts:173-176` にコメントで説明済み）。→
   `FENCE_POLICY = { guard: 'backtick-only', diagnostic: 'backtick-or-tilde' }` を定数化し、
   **挙動は変えない**（diagnostic が広いのは意図的である旨をコードに残す。AGENTS.md §6 の
   「Only backtick fences are exempted」と対応づける）。
3. 呼び出し側（delete / doctor / media / preflight）を共通 parser に載せ替え、`scanArticleMediaReferences` は
   **互換 shim として 1 期残す**（`tests/delete.test.ts:119-129` が直接 import しているため）。
4. `MEDIA_FILE_ROUTE_PREFIX` を全経路で使い、リテラル `/_emdash/api/media/file/` を src 内から排除する
   （`client/media.ts:92`, `media.ts:71,651,720`, `preflight.ts:259`）。

**回帰テスト**: 既存 `tests/delete.test.ts`（scanArticleMediaReferences）, `tests/doctor.test.ts`（26 tests）,
`tests/media_body_refs.test.ts`（18 tests）を**変更通しで green**。載せ替え前後で normalRefs / orphanStorageKeys の
集合が同一であることを 1 つの新 test で assert する。fixture は本番ワークスペースの実 body 形状:
`![](../../media/<ULID>.jpg)` / `<!--ec:block ... -->` / `[dimage url="..."]` を含む。

### R6 【P2・設計判断要】`media_state.local_hash` のキー空間非対称（A-5 の本体）

**事実**: pull 経路は `localHash = "media-record:<id>"`（`media.ts:722`）、upload 経路はコンテンツ SHA-256。
同一 `(mediaId, storageKey)` 行を交互に上書きするため、**「ローカルファイルが変わったが remote は同じ」を検知できない**。

**選択肢**（OD-3 で決定）:
- **(a) 記録分離**: schema v5 で `content_hash` を別列化。pull は walk 由来の `contentHash`（server sha1）を保持し、
  local hash は push / `--prune` の判定専用にする。**推奨**（AGENTS.md §7「cache schema v4 carries the mirror path」に
  続けて記載可能）。
- **(b) 現状維持 + コメント是正のみ**: R3 でコメントは直す。検知能力の欠如を AGENTS.md に既知制限として明記。

**禁止（どちらを選ぶ場合も）**: pull 経路でローカルファイルの実 bytes から sha256 を計算して `local_hash` を上書きすること。
window 外の mirror を再ハッシュすると prune 判定（active-id 起点の規則、AGENTS.md §7）と衝突する可能性がある。

---

## 3. Regression Locks（挙動に触る task で先に書くべき test）

| ID | 保証する不変条件 | 現状 |
|---|---|---|
| L1 | `postsSyncLimit` 未設定 → window は published 30 + draft 30。明示値は尊重される | 部分（`tests/workspace.test.ts:86-91`, `tests/pull_pruning.test.ts`）。R4 で追加 |
| L2 | batch pull は local-first mirror stage を走らせる。`--posts-only` では走らせない | index / mirror の test は `tests/sync.test.ts` にあり。**CLI flag 経由の assert が欠落** → 追加 |
| L3 | 未編集 article（local ref 表記済み）が `status` / `diff` で phantom edit にならない | green（`tests/local_media_refs.test.ts`, 90ad8dc / 55e37c6 の lock） |
| L4 | mirror 名は storageKey 由来。record id は collision suffix としてのみ現れる | green（`tests/media.test.ts`, `tests/naming.test.ts`） |
| L5 | prune の authority は remote record のみ。local scan から seed しない | green（`collectLocalMediaIds()` 削除済み — **再導入禁止**、AGENTS.md §7） |
| L6 | registry の code 集合 == 実コードの guard code 集合 | **新規**（R1 の `tests/guards.test.ts`） |

---

## 4. Non-goals / Open Decisions

### 4.1 Non-goals（この計画でやらないこと）

- local-first mirror stage を廃止しない、walk に上限を課して機能を縮小しない（§0.1 / §0.2 で承認済み前提）。
- guard の評価順序を変更しない（OD-2 に分離）。
- `legacy_*` 対応コードの削除。本番 workspace では残留 0 件だが（A-8）、既存 corpus 保護 purpose を持つため
  **削除ではなく "purpose 明記" で残す**（AGENTS.md §7 は legacy 名を known-key set から除外する規則を保持している）。
- `localMediaRefs` の default を OFF に戻さない。
- `@types/node` の追加（AGENTS.md §5: 設定済み）。

### 4.2 Open Decisions（実装前にオーナの回答が必要）

| ID | 決定事項 | 推奨 |
|---|---|---|
| **OD-1** | guard 番号を stage 順に再割当てするか（G15〜G19 が後ろへ 1 ずれる）、現行番号を固定して `DUPLICATE_SLUG_CONFLICT` / `DESTRUCTIVE_TAXONOMY_WIPE` を G20 / G21 にするか | **固定**（R1 の表どおり）。CLI 出力・テスト文言・既存ユーザーの記憶を壊さない |
| **OD-2** | AGENTS.md:173 が主張する「G6（マーカー）→ G15（taxonomy pending）」の順序は、`push.ts` の実順序（pending guard → preflight）と照合して**文書を直す**か**コードで順序を実現する**か | `docs/v0114-plan/fix-spec-v0114.md:28` は「現状マーカー残存時は taxonomy pending が先で G6 に到達しない」と記録済み。**まず taxonomy-only conflict → bare push の実測を 1 本の test で確認してから**決める |
| **OD-3** | `media_state.local_hash` を schema v5 で分離するか、既知制限として明記するか | (a) 分離。AGENTS.md §7 の cache 記述と同一箇所に追記できる |
| **OD-4** | `docs/v0112-eval/logs/` の診断ログ 9 個（空 2 含む）と `docs/.DS_Store` を削除 / gitignore するか | 削除 + `.gitignore` に `docs/**/logs/` と `.DS_Store`。診断ログは再取得可能 |

---

## 5. 実施順序と見積り

```text
Phase 1（文書のみ・コード無変更・1 commit）
  R2 → A-1 / A-2 の伝達復元 + OD-4 の hygiene
Phase 2（ガード正本化・新 test 1 本）
  R1（OD-1 決定後）→ tests/guards.test.ts green
Phase 3（構造・挙動不変）
  R3 media/ 分割（barrel 互換維持）→ npm run check green
  R4 default 単一ソース化 → L1 lock 追加
Phase 4（DRY 統合）
  R5 共通 parser 載せ替え → L3 / L4 / L5 green 維持 + 新 fixture test
Phase 5（設計判断）
  R6（OD-3 決定後、schema v5 なら AGENTS.md §7 を同時更新）
```

**各 commit で必須**: `npm run check` が format:check / typecheck(src+tests) / 414+ tests すべて green。

**AGENTS.md §5 の invariant を触る task**（baseline serialization、YAML scalar quoting、
status↔doctor 診断整合、origin resolution、CLI failure presentation）は本計画の対象外。
触る必要がある場合は本書にタスクを追加してから実施すること。

---

## 6. 監査で「問題なし」と確認した項目（誤って触らないこと）

構造整理のついでに壊しやすいので、明示的に緑として記録する。

- **`base_snapshots.frontmatter_yaml` は JSON-encoded `Frontmatter`** であり、
  `emit diff` 側の再構築（`serializeMarkdown(JSON.parse(...), bodyMarkdown)`）は disk の byte と一致している
  （AGENTS.md §5 invariant、`tests/migration_hash_invariants.test.ts` が緑）。
- **fast path の heal 3 系統**（frontmatter lenient repair / depth-free ref re-spell / hash-matched parse 検証）は
  いずれも `base_snapshot` を触らず、repair 後の own hash で再 track している（`pull.ts:657-720`）。
  共通 `healAndRetrack()` への集約は**任意の改善**であり、この計画では必須としない（挙動変更リスクより保守優先）。
- **`doctor` と guard の fence 非対称**（doctor は `~~~` も exempt、G5/G11 は backtick のみ）は意図的。
  R5 では統合せず policy として名前を与えるだけにする。
- **origin resolution**（`resolveOriginPriority()` を CLI / MCP が共有、`envOrigin` 分離）は緑。
- **MCP tool error contract**（`formatToolError`）は全 context tool で適用済み（`tests/mcp_tool_errors.test.ts`）。
- **命名迁移は本番で完結済み**（A-8: `media/` 196 ファイルすべて storageKey 由来名、`legacy_*` 残留 0 件）。
  legacy 対応コードは既存 corpus 保護 purpose で保持する。

