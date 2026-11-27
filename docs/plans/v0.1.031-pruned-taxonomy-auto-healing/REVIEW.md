# Emit v0.1.31 改善計画書（Rev.1）— 妥当性評価

**評価対象**: `docs/v0131-plan/README.md`
**評価基準コミット**: `e3948b3`（v0.1.30、現 `main` HEAD）
**結論**: **方向性は妥当（承認）。ただし実装前に 5 件の必須修正が必要。**

---

## 0. 総評

| 項目                               | 判定                                          | 根拠                                                                                                                                                      |
| ---------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 根本原因の特定                     | ✅ **正確**                                   | `fast_path.ts:111-266` の fast-path は `candidates` と frontmatter を突合せず `skipped: true` で return する。§0.3 の記述は実コードと一致                 |
| 自動 FORCE 却下（§1）              | ✅ **妥当**                                   | G13（`CANONICAL_HAS_UNPUSHED_EDITS`）および quarantine 不変条件と整合                                                                                     |
| 非破壊条件（未編集限定）           | ✅ **正しく、実装済みのガードで自動的に成立** | 新規ロジックは `isUnmodified === true` の分岐内にのみ置ける（`fast_path.ts:151-164`）。T4 は冗長だが回帰防止として有用                                    |
| レイヤリング設計（§4）             | ✅ **妥当**                                   | Layer 1 helper → Layer 2 consumer は `tests/layering.test.ts` の軸 1・2 に適合。Layer 2 兄弟結合は発生しない                                              |
| `resolveTaxonomyTermToId`          | ❌ **存在しない関数**                         | §3.1 のコード片は現状コンパイル不能。§3.2 の call site も同様（→ 問題 1）                                                                                 |
| 「完全な 0-GET を維持」（§2 / §4） | ❌ **誤り**                                   | `pullArticle` は fast-path 前に `fetchAssignedTerms` を 2 回実行済み。本計画は per-article GET を追加しないが、"0-GET" は元から成立していない（→ 問題 2） |
| ベースライン整合性（§3.3）         | ❌ **重大な欠陥**                             | `bumpBaselineHashOnly: true` は `frontmatter_yaml` を更新しないため、計画の cache 状態は自己修復直後の `emit diff` で phantom diff を生む（→ 問題 3）     |
| テストマトリクス T1〜T5            | ⚠️ **不十分**                                 | 上記 3 の欠陥を検出できない。追加テストが必要（→ 問題 3・4・5、§5）                                                                                       |

---

## 1. 【必須】`resolveTaxonomyTermToId` は存在しない — ULID 判定の二重バグ

### 現状

ターム解決の唯一の真実は `loadLocalTaxonomyMaps()`（`src/sync/taxonomies.ts:363-433`）が返す
`slugToId` / `idToSlug` であり、これを消費しているのは **push 側だけ**です：

- `src/sync/push/taxonomy_plan.ts:51-65`（canonicalize）
- `src/sync/preflight.ts:403-452`（Guard G4。`knownTaxonomies` は `Object.keys(taxonomyMaps.slugToId.*)`
  から構築 — `push/index.ts:110-118`）

`TaxonomyCandidates`（`src/utils/frontmatter.ts:51-56`）には **ULID が入りません**。
`categories` / `tags` は `aliasesOf(item)` の平坦化、すなわち `slug` と `canonicalSlug` のみです
（`taxonomies.ts:469-470`）。

### バグの発生経路

計画の `carriesPrunedTaxonomies` を素直に candidates 照合で実装すると、**frontmatter に ULID で
タームを書いた記事が誤って間引きされる**可能性があります。ULID は slug でも canonicalSlug でも
ありません。さらに危険なのは次のケースです：

```yaml
taxonomies:
  tags:
    - 01M6DEADTAG00000000000000 # リモートで削除されたタームの ULID（= G4 stale の典型）
    - tech # 生存ターム
```

`parseMarkdown()` は Zod で文字列をそのまま通すため、ULID は candidates 照合で必ず失敗します。
「生存タームだけ残す」方向では間引きは正しく見えますが、**G4 が stale として検知すべき ULID を
沈黙のうちに除去**します（§2 の確実な論理的証明は成立せず、`meaningChanged: false` は噓になる）。

### 修正方針

1. **Layer 0 に共有 predicate を新設**（`src/utils/taxonomy-key.ts`）— push/pull で単一の実装を共有し、
   G4 と pull の判定が永遠に乖離しないようにする：

```ts
/** True when `term` resolves to a locally defined taxonomy term (ULID, canonical slug, decoded slug, or unique name alias). */
export function isKnownTaxonomyTerm(
  term: string,
  taxName: 'category' | 'tag',
  maps: {
    slugToId: { category: Record<string, string>; tag: Record<string, string> };
    idToSlug: { category: Record<string, string>; tag: Record<string, string> };
  },
): boolean {
  if (maps.idToSlug[taxName]?.[term]) return true; // ULID（Layer A）
  const id = maps.slugToId[taxName]?.[term];
  return Boolean(id && maps.idToSlug[taxName]?.[id]); // canonical / decoded slug / 一意 name alias
}
```

2. **pull 側は `loadLocalTaxonomyCandidates()` ではなく `loadLocalTaxonomyMaps()` を使う**。
   fast-path の heal レールは既に `serializeMarkdown(..., getTaxonomyCandidates(), ...)` を呼ぶため、
   candidates は別途必要。両者を混同しないこと（役割が異なる：maps = 妥当性判定、candidates = 表記生成）。
3. **`pullArticle` / `FastPathContext` に maps を渡す**。`src/sync/pull/index.ts:150-156` の
   candidates memoize と同様に `getTaxonomyMaps()` を lazy + memoize で追加する。
   `pullBatch` は `orchestrator.ts:208` で candidates を 1 回ロードして各記事に渡しているため、
   maps も同じ位置で 1 回ロードして注入すれば batch での FS 走査は増えません。

---

## 2. 【必須】「完全な 0-GET を維持」は誤り — fast-path は既に per-article GET を発行している

### 現状（`src/sync/pull/index.ts:196-215`）

```ts
// 1. Fast-path check
if (rawItem) {
  const [categoriesTerms, tagsTerms] = await Promise.all([
    fetchAssignedTerms('category'),   // GET /_emdash/api/content/{collection}/{id}/terms/category
    fetchAssignedTerms('tag'),        // GET /_emdash/api/content/{collection}/{id}/terms/tag
  ]);
  ...
  const fastResult = await tryFastPathOrHeal(fastPathCtx, rawItem);
```

`fetchAssignedTerms` は **fast-path の評価より前に、skip される記事を問わず 2 回**実行されます。
つまり「pull は記事ごとに GET を発行しない」という前提自体が現状のコードと矛盾しています。

実測（既存テスト）:

- `tests/pull_published_no_extra_get.test.ts` — 0-GET を主張しているのは
  **`GET /posts/{id}`（単一記事本文取得）が呼ばれないこと**のみ（mock の 5 番分岐）。
- `tests/sync.test.ts:1074` — batch heal 2 記事で `expect(mockFetch).toHaveBeenCalledTimes(4)`。
  この 4 回に per-article の terms GET は含まれていません（fast-path に到達しないケースのため）。

### 計画への影響

§1-3 の「パフォーマンスの崩壊」を回避するという論点と、§2・§4 の「0-GET 特性完全維持」という
主張は、**fast-path 内の taxonomy 間引きが追加リクエストを 0 にする**という意味では正しいものの、
"0-GET" という物差し自体が既存挙動とズレています。この誤った前提で T2/T5 を
「fetch 呼び出し回数 = N」で固定すると、テストは existing terms GET の存在を見落として脆くなります。

### 修正方針

- 計画の主張を **「`GET /posts/{id}`（本文再取得）を追加しない」** に書き換える。
- T2/T5 の検証は「リクエスト数が既存挙動に対して増えないこと」で判定する:
  `mockFetch` の URL を分類し、`/posts/${id}` 単一 GET が **0 件**であること、
  そして terms GET の回数が記事数 × 2 を超えないことを assert する。
- （任意・推奨）skip される published 記事では `fetchAssignedTerms` を遅延させる余地がある。
  ただしこれは本計画の範囲外であり、§3.1 の fast-path 内分岐が **`fetchAssignedTerms` の結果より
  あとに eval される**（`index.ts:206-215` → `fast_path.ts`）ことを plan に明記すべきです。

---

## 3. 【必須・最重要】`bumpBaselineHashOnly: true` は Layer A を更新しない — phantom diff と stale baseline

### 計画のコードが生成する cache 状態

```ts
commitArticleSnapshot(..., {
  diskContent: respelled,               // 間引き済み（例: tags: []）
  canonicalContent: respelledCanon,     // 間引き済み -> 新しい baselineHash
  frontmatter: healedFrontmatter,       // 間引き済み ... だが使われない
  bumpBaselineHashOnly: true,           // <- ここが問題
  flags: { remoteTaxonomyHash: computeTaxonomyHash(healed...) },
});
```

`src/sync/workspace/commit.ts:94-102` を見ると、`bumpBaselineHashOnly: true` の場合
**既存 snapshot の `hash` と `savedAt` だけを更新し、`frontmatter_yaml` はそのまま**です：

```ts
if (input.bumpBaselineHashOnly) {
  const existingBase = cache.getBaseSnapshot(input.id);
  if (existingBase) {
    cache.saveBaseSnapshot({ ...existingBase, hash: baselineHash, savedAt: timestamp });
  }
}
```

つまり `base_snapshots.frontmatter_yaml` には **削除済みタームが Layer A に残存**します。

### 実際に壊れるもの

1. 間引き pull 完了 -> disk は `tags: []`、baseline hash は新値、`frontmatter_yaml` は旧ターム保持。
2. `emit status` / `emit diff` を実行すると `reconstructBaseline()`（`src/sync/baseline-reconstruction.ts:56-73`）が
   **Layer A（旧ターム入り）から disk 表記を再構成**する：

```ts
const canonicalMarkdown = baselineMarkdown(params.snapshot, candidates, {...});
...
matchesDisk = calculateHash(diskSpellingMarkdown) === currentHash && (...);
```

disk は `[]`、reconstruct は `[oldTag]` -> **`matchesDisk === false`**
（`syncState.localHash === currentHash` の escape hatch が status 経路で効くかどうかは経路依存で、
当てにできません）。結果:

- `emit diff` / `inspectArticleDiff`（`src/sync/diff.ts:176`）が **phantom taxonomy diff を表示**。
  これは AGENTS.md の phantom-diff 防止不変条件（§5 Baseline serialization invariant）に直接違反します。

3. push 時の 409 / divergence 判定が stale な Layer A に依存する：
   - `src/sync/push/tax_audit.ts:81-84` — baseline hash を `syncState.remoteTaxonomyHash` から取るため
     ここは計画の flags で救われます。
   - **しかし** `src/sync/push/commit.ts:359-361` と `taxonomy_plan.ts:150-152` は
     `readBaselineFrontmatter(baseSnapshot)` を読み、**間引き前のターム**で wipe 判定（G19）と
     prev-terms 警告を行います。-> **存在しない remote タームを「消す」と誤報告する**恐れ。

### なぜ既存 heal レールでこの問題が顕在化しなかったか

Branch 1（`fast_path.ts:210-247`）は percent-encoded -> decoded の**表記変換のみ**で、
Layer A に保存されている canonical slug と disk の decoded slug は
`baselineMarkdown(..., { preferEncodedTaxonomy })` によって再構成時に一致します。
**内容（ターム集合）を変える heal は Layer A 更新が必須** — これが今回のケースだけ壊れる理由です。

### 修正方針

- **`bumpBaselineHashOnly: false`（full baseline rewrite）にすること**。加えて Layer A には
  **canonical slug 表記の frontmatter** を保存する必要があります（AGENTS.md invariant）。
  `parsedCurrent.frontmatter.taxonomies` は disk から読んだ **decoded 表記**（Layer B）です。
  したがって healed frontmatter のタームを canonical slug に正規化してから渡すこと：

```ts
const maps = getTaxonomyMaps(); // 問題 1 で追加
const healedTaxonomies = canonicalizeTaxonomies(
  // Layer 1 helper（新規）
  pruneNonexistentTaxonomies(parsedCurrent.frontmatter.taxonomies, maps),
  maps, // decoded slug -> canonicalSlug
);
const healedFrontmatter = { ...parsedCurrent.frontmatter, taxonomies: healedTaxonomies };

commitArticleSnapshot(options.cache, options.workspaceRoot, {
  id,
  relPath: existingSync.localFilePath,
  diskContent: respelled, // decoded 表記（disk / Layer B）
  canonicalContent: respelledCanon, // decoded 表記（baseline hash 用）
  frontmatter: healedFrontmatter, // canonical slug（Layer A）
  bodyMarkdown: parsedCurrent.body,
  revForTransport: existingSync.remoteRev,
  revForComparison: existingSync.remoteRev,
  bumpBaselineHashOnly: false, // <- Layer A を更新
  flags: {
    remoteTaxonomyHash: computeTaxonomyHash(healedTaxonomies.categories, healedTaxonomies.tags),
  },
});
```

- **`flags` の欠落に注意**（問題 4）。
- 代替案として「disk 表記のまま Layer A に保存し、`reconstructBaseline` 側で canonicalize する」ことも
  考えられますが、それは `computeTaxonomyHash` の安定性 invariant を壊すため **採用しないこと**。

---

## 4. 【必須】`flags` の部分指定で conflict / pending フラグが失われる

`commitArticleSnapshot` は `saveSyncState({ ..., ...input.flags })`（`commit.ts:117-126`）で
**upsert** します。計画の flags は `remoteTaxonomyHash` しか渡していませんが、同じ関数の既存の
fast-path 呼び出し（Branch 3 の on-demand terms heal、`fast_path.ts:386-398`）は次を明示的に再掲しています：

```ts
flags: {
  remoteTaxonomyHash: ...,
  taxonomyApplyPending: 0,
  conflictPending: existingSync.conflictPending,
  bodyConflictPending: existingSync.bodyConflictPending,
  taxonomyConflictPending: existingSync.taxonomyConflictPending,
  conflictCopyPath: existingSync.conflictCopyPath,
  conflictCopyHash: existingSync.conflictCopyHash,
  conflictAt: existingSync.conflictAt,
},
```

計画どおり `remoteTaxonomyHash` だけで commit すると、**body / taxonomy conflict pending と
quarantine copy 参照がリセットまたは stale 化**し、G12・G14・G16 の挙動と schema v3 の
「両 kind が 0 のときのみ conflict copy を NULL」 invariant が壊れます。

-> 既存パターンに従い **全 conflict / pending フラグを `existingSync` から引き継ぐ**こと。
（`taxonomyApplyPending` は 0 にしない — 元の値を保持。）

---

## 5. 【重要】空配列 `[]` が Guard G19（`DESTRUCTIVE_TAXONOMY_WIPE`）と衝突する — T3 は現状では通らない

### 事実確認

- `formatFrontmatterYaml` は空配列を `    []` として出力します（`src/utils/frontmatter.ts:455-456`）。
  -> §2 の「フロントマターは自動的に `tags: []` などに更新される」は **disk 表記として正しい**。
- push 時、`taxonomy_plan.ts:148-167` は `resolvedTermIds.length === 0` かつ baseline に prev terms が
  あれば、`allowWipeTaxonomies` / `force` / `resolveTaxonomy` のいずれもない限り
  **`DESTRUCTIVE_TAXONOMY_WIPE`（status 400）を throw** します。

### 問題

T3 は「全タグが削除された記事が `tags: []` に自己修復され、次回 `pushArticle` 時に Guard G4 を
引き起こさず正常プッシュできる」と主張しますが、G4 は消えて **G19 が発火**します。
ユーザーのデッドロックは G4 から G19 に移動しただけになります。

（G19 の意図は「remote にタームが残っているのに空配列で消す」ことの防止です。リモート側で
タームが削除されたケースでは remote には既にタームがないため、この wipe は実質的に no-op です。）

### 修正方針（いずれかを選択し plan に明記）

- **案 A（推奨・安全）**: 間引き結果が空配列になる taxonomy は `[]` を書かず
  **キーごと除去**する（`taxonomies: { categories: [...] }` から `tags` キーを落とす）。
  ただし `updateTaxonomy` は `parsed.frontmatter.taxonomies.tags` が truthy のときだけ呼ばれるため
  （`taxonomy_plan.ts:192-197`）、remote の stale assignment を清理する HTTP POST は発火しません。
  -> **リモートに削除済みタームの post_terms レコードが残存し続ける**可能性があることを plan に明記し、
  `emit status` / pull 時に「リモートが参照する未定義ターム」を診断表示する（次項）。
- **案 B**: `[]` を保ち、push 側で **baseline の prev terms がすべてローカル定義に存在しない場合**は
  wipe を automatic とみなして G19 を bypass する。判定根拠が「remote の実際状態」ではなく
  baseline である点に注意（`tax_audit.ts` は既に remote audit を行う仕組みを持つ — ここに寄せる方が誠実）。
- **どちらの場合も**: T3 の検証内容を
  「G4 も G19 も発火しない」**かつ**「remote の taxonomy 参照が実際に解決される」まで踏み込んで記述する。

---

## 6. 【重要】間引きの前提が成立しないケース — `pullTaxonomies()` 失敗時と `--posts-only`

### (a) taxonomy fetch 失敗時

`pullTaxonomies()` は失敗した taxonomy を **prune せず保持**します（`taxonomies.ts:224-247`、
`categoriesFailed / tagsFailed`）。このとき candidates/maps は「前回 pull 時点の有効一覧」であり、
計画 §2 の論理証明（candidates = 現在の有効一覧）は成立しません。

- 影響: fetch 失敗時に間引きが走ると、**まだ remote に存在するタームを frontmatter から除去**し得る。
- 修正: fast-path 内では `categoriesFailed / tagsFailed` を **unknown として扱い間引きしない**。
  ただし CLI batch（`src/cli/commands/pull.ts:216-225`）と MCP（`sync-pull.ts:207`）は taxonomy 失敗を
  orchestrator に伝えないため、**fast-path 側で独立して判定**する必要があります。
  最小実装: `categories/`・`tags/` のいずれもが存在しない workspace では間引きしない
  （G4 と同じ「検証不能なら断定しない」epistemic rule）。加えて taxonomy 失敗時に pull が間引きを
  skip できる経路（例: `PullOptions.taxonomiesSyncFailed: true`）を設ける。

### (b) `--posts-only` / `postsOnly: true`

taxonomy を同期せずに記事だけ pull するパスでは candidates は stale のままです。ここでも間引きは
発火させてはいけません（同じ epistemic rule）。plan に「間引きは taxonomy 同期が成功した pull でのみ」
の条件を追記すること。

---

## 7. 【重要】診断・表示の問題 — 「Repaired frontmatter syntax」では誤解を招く

`healed: true` は Layer 3 で次の文言に固定されています：

- `src/cli/commands/pull.ts:266-269`（batch）:
  `🛠️  Repaired frontmatter syntax for ... (local body preserved). Push the file to apply changes to the server.`
- `src/cli/commands/pull.ts:377-383`（single）: 同じ文言 + push 誘導
- `src/mcp/tools/sync-pull.ts:174`: 同じ actionText

taxonomy 間引きは **syntax 修復ではなく content の意味変更**です。同じ文言を流用すると:

1. ユーザー/AI は「表記だけ直った、push 不要」と誤読する（実際は push して remote を揃えるべき）。
2. AGENTS.md の `meaningChanged` 語彙と矛盾する（§5 T2/T5 は `healed: true` を要求しつつ意味変更を伏せる）。

### 修正方針

- `PullResult` に **`prunedTaxonomies?: { categories: string[]; tags: string[] }`**（除去されたターム）を追加し、
  Layer 3 で専用メッセージを出す：
  `🏷️ Pruned N deleted taxonomy term(s) from frontmatter for <slug>. Push the file to apply on remote.`
  （表示ロジックは Layer 3 共通化のため `src/presentation/` に置く — MCP が `src/cli/commands/` を
  import できない軸 3 制約に注意。）
- `meaningChanged` の扱いを plan で明確にする。本文は無変更だが frontmatter の意味は変わるため、
  `meaningChanged: false` のままでは `healed` の語義（既存は「syntax-only」）と衝突します。
  -> **`meaningChanged: true` が誠実**（既存の quarantine/divergence 判定に副作用がないか確認が必要）。

---

## 8. 軽微な指摘

1. **関数シグネチャの型**: `taxonomies: Record<string, string[]> | undefined` は
   `Frontmatter['taxonomies']`（`z.record(z.array(z.string())).optional().default({})`、
   `frontmatter.ts:44`）と整合させ `Frontmatter['taxonomies']` を使うこと。`pruneNonexistentTaxonomies` の
   戻り値 `Record<string, string[]>` は `categories` / `tags` 以外のキー（自定义 taxonomy）を暗黙に
   保持する設計になっており、これは G4 が `Object.entries(frontmatter.taxonomies)`（`preflight.ts:413`）で
   全キーを検査する挙動と揃える必要があります。plan は `categories` / `tags` しか扱わないため、
   **自定义 taxonomy キーの扱いを明記**してください。
2. **slug の解決は winner に解決される**（AGENTS.md §Collision resolution）。共有 canonical slug を持つ
   loser タームを ULID で保持していた記事は、間引き後に winner へ解決され意味が変わり得ます。
   T1 にこのケースを含めること。
3. **テスト配置**: T2〜T5 は `tests/sync.test.ts`（3800+ 行）ではなく `tests/pull_taxonomy_pruning.test.ts`
   のような専用ファイルに分離することを推奨（既存の `pull_pruning.test.ts` は**記事** pruning 用で紛らわしい）。
4. **リリース手順**: `package.json` version と `CHANGELOG.md` 更新は妥当。加えて **AGENTS.md への反映**が
   plan に欠けています。§5（Taxonomy Validation / G4）と §6 に「削除済みタームの自動間引き」不変条件、
   そして問題 3 の「内容を変更する heal は Layer A を更新しなければならない」を追記すべきです
   （AGENTS.md:302 の Baseline serialization invariant と同一箇所に書く）。

---

## 9. 承認済み / そのまま採用できる部分

- §1（自動 FORCE 却下）の 3 リスク分析は正確で、既存 Guard 体系と整合。
- 「未編集記事のみ間引き」の安全条件は `isUnmodified` ガード（`fast_path.ts:151-164`、
  `currentDiskHash === existingSync.localHash` または baseline reconstruction 一致）によって
  **新規コードを書かずに**成立する。T4 はこの回帰防止として維持すべき。
- Layer 1 helper + Layer 2 consumer の分離方針、および既存 Branch 1 heal レールへ統合する方針は妥当
  （問題 3・4 を修正したうえで）。
- `flags.remoteTaxonomyHash` に `computeTaxonomyHash`（canonical slug ベース、`src/sync/terms.ts:30`）を
  反映する方針は push 側 divergence 判定と整合。

---

## 10. 推奨する修正後の実装ステップ

| Step | 内容                                                                                                                                                                                                     | 追加テスト                                                                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | `src/utils/taxonomy-key.ts` に `isKnownTaxonomyTerm()`（Layer 0）追加。preflight G4 と taxonomy_plan を同一 predicate 経由に寄せる                                                                       | `tests/taxonomy_key.test.ts`（ULID / canonical / decoded / alias / 削除後）                                                                                                                                        |
| 1    | `src/sync/taxonomies.ts` に `carriesPrunedTaxonomies` / `pruneNonexistentTaxonomies` / `canonicalizeTaxonomies`（Layer 1、maps 受け取り）                                                                | T1（+ winner/loser slug 衝突ケース）                                                                                                                                                                               |
| 2    | `pull/index.ts` に `getTaxonomyMaps()` memoize 追加、`FastPathContext` に maps 露出。`orchestrator.pullBatch` で maps を 1 回ロードして注入                                                              | —                                                                                                                                                                                                                  |
| 3    | `fast_path.ts` の Branch 1 レールに間引きを実装。**full baseline rewrite**（`bumpBaselineHashOnly: false`）+ Layer A は canonical slug + conflict/pending フラグ全引き継ぎ + taxonomy sync 失敗時は skip | T2（`GET /posts/{id}` 0 件を URL 分類で assert）、T4、**新規 T6: 間引き直後の `emit status`/`diff` が phantom diff を出さない**、**T7: push 時に G4 も G19 も発火せず、prev-terms 警告が間引き後ターム集合と一致** |
| 4    | 空配列戦略（案 A or B）決定と実装                                                                                                                                                                        | T3（G4・G19 非発火 + remote taxonomy 解決）                                                                                                                                                                        |
| 5    | `PullResult.prunedTaxonomies` と Layer 3 表示（`src/presentation/` 経由）追加、CLI/MCP の文言分離                                                                                                        | `tests/cli.test.ts` / `tests/mcp.test.ts` に出力検証                                                                                                                                                               |
| 6    | AGENTS.md（§5・§6・§5 Development invariant）更新、`npm run check` Green、version + CHANGELOG                                                                                                            | `tests/layering.test.ts` Green                                                                                                                                                                                     |

---

## 11. 最終判定

**採用可（条件付き）。** 「0-GET で未編集記事の frontmatter のみを間引く」という中核方針は、
既存アーキテクチャ（fast-path heal レール、Layer A/B 二層表現、Guard 体系）と整合し、
ユーザー報告された G4 デッドロックを実際に解消します。

ただし現状の Rev.1 のまま実装すると **3 つの確実な障害**が発生します：

1. `resolveTaxonomyTermToId` が存在せず ULID 参照が誤間引きされる（→ §1）。
2. `bumpBaselineHashOnly: true` により Layer A が stale 化し、phantom diff と誤 wipe 警告を引き起こす（→ §3）。**これが最も重大**。
3. 全ターム削除ケースで G4 の代わりに G19 が発火し、報告されたデッドロックが解消しない（→ §5）。

これらを反映した Rev.2 を作成すれば実装着手可と判断します。

---

# Rev.2 検証レビュー（第 2 ラウンド）

**対象**: 上記レビューに対するユーザーの照合・修正回答
**結論**: **6 項目のうち 5 項目は正確。ただし指摘 5 の G19 分析に 1 つの事実誤認があり、
「キー自体を除去する」対策は採用してはいけない（remote に stale な `post_terms` が残存する）。**

---

## R2-1. 正確に検証された項目（そのまま承認）

| 指摘                                              | 照合結果        | 追加で確認した事実                                                                                                                                                |
| ------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `resolveTaxonomyTermToId` 不在 / ULID 誤間引き | ✅ **完全正确** | regex 検索で該当は `docs/v0131-plan/README.md` と本 REVIEW の記述のみ。`src/` 下に 1 定義もなし。`loadLocalTaxonomyMaps()`（`taxonomies.ts:363-433`）が唯一の真実 |
| 2. 「完全な 0-GET」表現補正                       | ✅ **妥当**     | `pull/index.ts:196-215` で fast-path 前に terms GET ×2。単一記事 pull でも発生する点は指摘どおり                                                                  |
| 3. `bumpBaselineHashOnly` の Layer A 不更新       | ✅ **完全正确** | `commit.ts:94-102` は `{ ...existingBase, hash, savedAt }` のみ保存。`frontmatterYaml` は verbatim 通過（`db/baseline.ts:82` が JSON encode 位置）                |
| 4. `flags` 部分指定によるフラグ喪失               | ✅ **完全正确** | `commit.ts:117-126` は `saveSyncState({ ...固定値, ...input.flags })` の upsert。未指定の conflict / pending 系は stale 化または NULL 化                          |
| 6. 前提条件保護・表示文言                         | ✅ **妥当**     | `taxonomies.ts:224-247` は失敗時 prune しない。既存文言は `pull.ts:266-269,377-383` / `sync-pull.ts:174`                                                          |

---

## R2-2. 【要修正】指摘 5 の G19 分析 — 前提が 2 つとも実コードと不一致

ユーザーの反論:

> 「指摘 3 でベースライン（baseSnapshot）も空配列に正しく更新されていれば `prevTerms.length === 0` となり G19 は発火しません」

### 誤り 1 — Zod の `.default({})` により `taxonomies.tags` は常に truthy

```ts
// src/utils/frontmatter.ts:44
taxonomies: z.record(z.array(z.string())).optional().default({}),
```

`base_snapshots.frontmatter_yaml` に間引き後ターム集合を正しく保存しても、
`parsed.frontmatter.taxonomies.tags` は **常に配列オブジェクト**であり `[]` になりません。

さらに重要なのは、**plan の heal パスでは disk frontmatter が一度も再 parse されない**こと：

```ts
// fast_path.ts:166 — 間引き前の disk から parse（旧ターム入り）
const parsedCurrent = parseMarkdown(currentDiskContent);
// plan §3.2 — healedFrontmatter はローカル変数。disk へ push 後、次 pull まで再 parse されない
```

`push/index.ts:101` の `canonicalizeFrontmatterTaxonomies(parsed, taxonomyMaps)` も
**旧タームを canonical slug に解決できないため in-place で素通し**します（`taxonomy_plan.ts:66`）。
結果として `prevTerms` は **間引き前のターム配列**のまま。

→ **「ベースラインが空配列に更新される」という前提が成立しません。**
G19（`taxonomy_plan.ts:148-167`）は plan の Rev.1 状態でも、Rev.2 状態でも発火します。

### 誤り 2 — `updateTaxonomy` は空配列でも HTTP POST を発行する

```ts
// taxonomy_plan.ts:192-197 — truthy なら呼ばれる（[] でも呼ばれる）
if (parsed.frontmatter.taxonomies.tags) {
  await updateTaxonomy('tag', parsed.frontmatter.taxonomies.tags);
}
// taxonomy_plan.ts:169-178 — resolvedTermIds が空でも POST は走る
const termRes = await fetchFn(termsUrl, { method: 'POST', body: JSON.stringify({ termIds: [] }) });
```

**`[]` を保つことは機能します**: `termIds: []` の POST が remote の stale assignment を清理し、
ユーザーのデッドロックが実際に解消します。

### したがって「キー自体を除去する（案 A）」は危険

`taxonomies.tags` キーを落すと `updateTaxonomy` 自体が呼ばれず、**remote の `post_terms` レコードが
孤児として残存し続けます**。つまり:

- disk/cache はクリーンに見える → `emit status`/`diff` は clean。
- **remote の記事は削除済みタームを引き続き参照**（Web 表示・検索に残る）。
- Emit はその状態を二度と検知しない（ローカル定義に無いタームとして間引き済み、push もしない）。

これは「同期の嘘」であり、Emit の loss-free sync 目的に反します。**案 A は採用しないこと。**

### 正しい対策（推奨）

1. **`[]` を disk に保持する**（`formatFrontmatterYaml:455-456` は `    []` を出力 — 既に正しい）。
2. **G19 の判定を remote 実状態または taxonomy 削除事実と整合させる**。既存の仕組みが使える：
   - `tax_audit.ts:62-98` は `fetchAssignedTaxonomies` で **remote の実際ターム**を取得済み（
     `remoteTaxAudit.categories / tags`）。ここが「remote に本当にタームが残っているか」の唯一の真実。
   - G19 発火条件に **「remote audit が『該当 taxonomy の現行 assignment が 0 件』と確認した場合」** を追加し、
     その場合は warning として通過させる（`pullTaxonomies()` が `deletedXxxCount > 0` を返した事実も補助根拠になる）。
   - 判定根拠を baseline 配列長だけに依存する現状設計自体が、このケースで誤作動することを plan に明記。
3. **T3 の検証内容を拡張**: 「G4・G19 非発火」だけでなく
   `POST /terms/tag` が `termIds: []` で発行され remote 参照が清理されること、
   その後の pull で再間引きが発生しない（冪等）ことを assert。

---

## R2-3. Rev.2 に追加すべき細部（実装前に埋める必要あり）

1. **canonical slug 正規化は `id` を保持する必要がある**（共有 canonical slug の loser ターム保護）。
   `taxonomy_plan.ts:57-65` は `slugToId` 経由でタームを winner に解決するため、
   pull heal 用に `canonicalizeTaxonomies()` を素直に流用すると **loser ULID が winner に置換**され得ます。
   → 新 helper は「ULID 入力は ULID のまま保持 / slug 入力は canonical slug へ」を明示実装すること。

2. **`pull/index.ts:466-470`（full pull）も Layer A に decoded タームを保存している可能性**。
   `commitArticleSnapshot(..., frontmatter, ...)` に渡る `frontmatter` の表記を確認し、
   push 側が canonical slug で書き直すなら実害なし、そうでなければ今回の変更と併せて整合させること。

3. **`taxonomyApplyPending` の引き継ぎ方針を plan に明記**。既存 pull 経路は 3 か所すべてで `0` にしています
   （`fast_path.ts:391`、`pull/index.ts:470`、`conflicts.ts:531` は保持）。G17 の意味論（taxonomy POST 失敗が
   未解決のまま残っている）を pull が消してよいのかを決定し、テストで固定すること。

4. **T6（間引き直後の phantom diff 非検出）は必須テストとして Rev.2 に残置**。
   `reconstructBaseline()` の `matchesDisk` 条件（`baseline-reconstruction.ts:68-73`）には
   `syncState.localHash === currentHash` の escape hatch があり、`emit status` では症状が隠れ得ます。
   **`inspectArticleDiff`（`diff.ts:176`）経由で検証すること**（こちらが実際に diff を描画する）。

5. **軽微な指摘の反映状況が回答に記載なし**: winner/loser slug 衝突を T1 に含める、自定义 taxonomy キーの
   扱い（G4 は `Object.entries` で全キー検査 — `preflight.ts:413`）、テストファイル分離、AGENTS.md 更新。
   これらは Rev.2 の作業手順表に明記してください。

---

## R2-4. 最終判定

**承認（条件付き → 1 条件）。** Rev.2 の照合作業は正確で、致命的欠陥 4 件の回避方針はすべて妥当です。

残る唯一の阻塞点は **R2-2**: 指摘 5 の対策として「キー自体を除去する」案が提案されており、
これは remote に孤児 `post_terms` を残すため **採用不可**。`[]` を保持し、G19 判定を remote audit
（`tax_audit.ts`）と整合させる方向に修正すれば、実装着手可と判断します。

---

# Rev.2 計画書レビュー（第 3 ラウンド）— 設計承認と残存する 6 個の実装ブロッカー

**対象**: `docs/v0131-plan/README.md` Rev.2（239 行）
**結論**: **中核設計は承認。R2-2 の是正（`tags: []` 保持 + G19 remote audit 整合）は正しく反映済み。**
ただし実装前に **6 個の技術的ブロッカー**を解消する必要がある。うち 2 件は Rev.2 が新規に持ち込んだもの。

---

## R3-1. 正しく反映された点（検証済み・承認）

| Rev.2 の項目                                                           | 照合結果                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3.1 `isKnownTaxonomyTerm` を Layer 0 に新設、ULID + slug/alias 両対応 | ✅ 妥当。`maps.idToSlug` → `maps.slugToId` の 2 段判定は `taxonomy_plan.ts:51-65` と同型                                                                                              |
| §3.2 `canonicalizeTaxonomiesForBaseline` が ULID を verbatim 保持      | ✅ **loser ターム保護として正しい**。`taxonomy_plan.ts:57-65`（slug 入力は winner に解決）との差異を意図的に区別できている                                                            |
| §3.3 `bumpBaselineHashOnly: false` + Layer A canonical slug 保存       | ✅ phantom diff 障害を解消する正しい修正                                                                                                                                              |
| §3.3 flags で conflict/pending を全引き継ぎ                            | ✅ 既存 `fast_path.ts:386-398` のパターンと一致                                                                                                                                       |
| §3.4 `tags: []` 保持 + G19 remote audit 整合                           | ✅ **R2-2 の是正が正しく反映済み**。孤児 `post_terms` を残さない方針                                                                                                                  |
| §3.3 Epistemic Rule（sync 失敗時・postsOnly で間引き不发火）           | ✅ 妥当（ただし実装経路の指定が不足 → R3-4）                                                                                                                                          |
| §3.5 Layer 3 専用文言を `src/presentation/` に                         | ✅ 軸 3 制約（MCP は `src/cli/commands/` を import 不可）を満たす正しい配置。`article_report.ts` は既に `formatOrphanMediaWarning` / `formatMediaCoverageLine` を持つ拡張先として適切 |
| §5 T1〜T7・テストファイル分離                                          | ✅ T6（`inspectArticleDiff` 経由）・T7（Epistemic）が追加され、前回指摘を網羅                                                                                                         |
| §6 Step 6 で AGENTS.md 更新                                            | ✅ 前回の欠落が解消済み                                                                                                                                                               |

---

## R3-2. 【ブロッカー A】`TaxonomyLookupMaps` の index signature が `loadLocalTaxonomyMaps()` と非互換

```ts
// Rev.2 §3.1
export interface TaxonomyLookupMaps {
  slugToId: { category: ...; tag: ...; [k: string]: Record<string, string> };   // index signature 追加
  idToSlug: { ...同上... },
}
```

`loadLocalTaxonomyMaps()` の戻り値（`taxonomies.ts:363-366`）は **index signature を持たない**ため、
「`category` / `tag` 以外のキーを持ち得る」型へは **構造的に代入できません**。

```ts
const maps = loadLocalTaxonomyMaps(root); // { slugToId: { category, tag }, idToSlug: { category, tag } }
isKnownTaxonomyTerm(term, 'tag', maps); // ✗ 型エラー（index signature 欠落）
```

**対策**: interface を新設せず、既存関数の ReturnType を単一ソースとして使うこと。

```ts
export type TaxonomyLookupMaps = ReturnType<typeof loadLocalTaxonomyMaps>;
```

自定义 taxonomy キーを本当に扱いたい場合は、`loadLocalTaxonomyMaps()` 側を先に拡張してから
型を揃えること（両者をずれたまま実装すると typecheck で落ち、後から整合コストが上がる）。

---

## R3-3. 【ブロッカー B】G19 バイパスの判定根拠が unknown を 0 と区別しない — 安全不変条件の破り

```ts
// Rev.2 §3.4
const remoteAssignedCount = params.remoteActualAssignedCount?.[taxonomyName] ?? prevTerms?.length ?? 0;
if (prevTerms && prevTerms.length > 0 && remoteAssignedCount > 0) { throw ... }
```

`auditRemoteTaxonomies()` の返す `remoteTaxAudit` は **`null` = 取得不能（unknown）** を意味します
（`tax_audit.ts:49,71-79`）。`?? prevTerms?.length ?? 0` は unknown を「0」または「prevTerms 数」に
潰すため、**remote 状態が不明なまま wipe が通過**します。これは Emit の epistemic rule
（「検証不能なら断定しない」）に反し、Rev.2 自身が §3.3 で採用した原則と矛盾します。

さらに `auditRemoteTaxonomies` は次を返すだけで、件数も taxonomy 別内訳も持ちません（`tax_audit.ts:101`）：
`{ remoteTaxAudit, taxonomyDivergenceDetected }` — `taxonomy_plan.ts` には届きません。

**対策（3 条件すべてを明示）**

```ts
const auditKnown = params.remoteTaxAudit?.[taxonomyKey] !== undefined
                && params.remoteTaxAudit?.[taxonomyKey] !== null;   // unknown は除外
const remoteCount = auditKnown ? params.remoteTaxAudit[taxonomyKey].length : null;

if (prevTerms?.length && remoteCount === null) {
  warnings.push('⚠️ Remote taxonomy state unknown — preserving wipe guard.');   // G19 は発火させる
} else if (prevTerms?.length && remoteCount > 0) {
  throw ...DESTRUCTIVE_TAXONOMY_WIPE...;      // remote に本当に残っている
}
// remoteCount === 0 のときだけ clean bypass → POST { termIds: [] }
```

**必須の wiring（plan に追記要）**

1. `push/index.ts` は `auditRemoteTaxonomies` を **update/create の PUT 直前**で呼ぶ（`push/index.ts:338`）。
2. `syncArticleTaxonomies` は **create 分岐では audit より前**（`push/index.ts:265-275`）、
   **update 分岐では audit より後**で呼ばれる。→ create 経路に remote 件数を渡すには audit の早期化が必要。
3. `syncArticleTaxonomies` params に `remoteTaxAudit` を追加し、`taxonomyKey`（`categories`/`tags`）と
   `taxonomyName`（`category`/`tag`）の対応を明示する。
4. **`options.noTaxonomyAudit`（`--no-taxonomy-audit` / MCP `noTaxonomyAudit: true`、
   `push/types.ts:50`、`tax_audit.ts:62`）指定時は audit が走らず remote 状態が unknown** になる。
   このケースで G19 を bypass してはいけない — plan に明記すること。

---

## R3-4. 【ブロッカー C】Epistemic フラグが pull 側に存在しない・`taxonomyApplyPending: 0` は採用不可

### (a) `options.postsOnly` / `options.taxonomiesSyncFailed` は `PullOptions` に存在しない

```ts
// Rev.2 §3.3 — fast_path.ts 内の記述
const canPruneTaxonomies = !options.postsOnly && !options.taxonomiesSyncFailed;
```

`postsOnly` は orchestrator のオプションであり（`orchestrator.ts:116,144`）、`PullOptions`
（`pull/types.ts`）には存在しません。`taxonomiesSyncFailed` は未定義の新設です。
→ **CLI → orchestrator → `pullArticle` → `FastPathContext` までフラグを貫通させる**作業手順を
plan に明記すること（`orchestrator.ts:164-175` の `pullArticle` 呼び出し、
`pull/index.ts:186-194` の `fastPathCtx` 構築の両方に追加が必要）。

### (b) `taxonomyApplyPending: 0` は G17 を誤って消す — Rev.1 指摘 4 に逆行する選択

Rev.2 §3.3（`README.md:232`）は flags で conflict 系をすべて `existingSync` から引き継ぎながら、
**`taxonomyApplyPending` だけ 0 に固定**しています。前回レビュー R2-3-3 の「保持すべき」が反映されていません。

**具体的な失敗シナリオ**

```
記事 B: taxonomy POST 失敗 → taxonomyApplyPending = 1（G17 が bare push を block 中）
ユーザー: emit pull（バッチ、taxonomy sync 成功）
  → 記事 B の frontmatter に削除済みタグがあり間引き発火
  → taxonomyApplyPending: 0 にリセット   ← G17 が消える
ユーザー: emit push posts/draft/...B.md → 素通し
  → body PUT 成功、taxonomy POST 失敗（前回の原因が未解決のまま再発）
```

`existingSync.remoteTaxonomyHash` を失わない限り divergence audit（G16）は残りますが、
**G17 という明示的な block レールが消える**のは保護の後退です。

**対策**: 間引きが発火しなかった場合（`hasPrunedTax === false` で syntax heal だけのケース）は
`taxonomyApplyPending` を **必ず `existingSync.taxonomyApplyPending` から引き継ぐ**。
間引きが発火した場合のみ 0 にしてよい（その push は taxonomy payload を再送するため）。
この分岐を plan に明記し、テストで固定すること。

参考 — 既存の pull 経路は 3 か所すべてで `taxonomyApplyPending: 0` にしています
（`fast_path.ts:391`、`pull/index.ts:470`、`conflicts.ts:531` は保持）。これは「remote 正典を再取得した」
ケースに限定して正当なので、**disk-only の間引き heal を同列に扱わないこと**。

---

## R3-5. 【確認事項】`meaningChanged: hasPrunedTax` は現状安全だが、意味を plan に明記すべき

`meaningChanged` は `src/` 内で **どこからも消費されていません**（宣言は `pull/types.ts:103`、
設定は `fast_path.ts:142,195,239,302,408` の 5 か所すべて `false`）。したがって Rev.2 の変更は
既存挙動を変えません。ただし:

- これは「将来の consumer が信頼する公開フィールド」です。`quarantined`（`pull/types.ts:105`）とは無関係で、
  quarantine / divergence 判定に副作用がないことを確認済み。
- `prunedTaxonomies` の型（`{ categories: string[]; tags: string[] }` か除去ターム名配列か）と、
  `diffPrunedTerms()` が disk 表記（decoded）で返すのか canonical slug で返すのかを明記すること。
  §3.5 の表示例は decoded（`tags: ["カメラレビュー"]`）なので、**表示は decoded / cache・Layer A は canonical**
  の二層対応を通すこと（AGENTS.md Two-Layer invariant と整合）。

---

## R3-6. 【軽微】残置 2 点と T1 の配置

1. **full pull 経路（`pull/index.ts:457-473`）の Layer A は remote 由来 canonical slug を保存している** —
   `apiResponseToLocal` 経由の `frontmatter` が canonical slug を保つことを Step 3 で確認・コメント化すること。
   実害は無い見込みですが、Rev.2 の `canonicalizeTaxonomiesForBaseline()` は fast-path 専用であり
   full pull 経路と正規化手段が 2 本立つため、**どちらが正典かを plan に明記**してください。

2. **T1 の配置が §5 の宣言と矛盾**: 「テストは `tests/pull_taxonomy_pruning.test.ts` に集約」と書きながら
   T1 だけ `taxonomies.test.ts` を指しています。`isKnownTaxonomyTerm` は Layer 0 なので
   `tests/taxonomy_key.test.ts`（新規）に置くのが層対応として自然です。

3. **T7 の実装には注入経路が必要**: `tagsFailed: true` を fast-path に届ける手段（R3-4(a) のフラグ）が
   無ければ T7 は書けません。テストマトリクスに「注入経路」列を追加することを推奨。

---

## R3-7. 最終判定

**Rev.2 の設計方針は承認。** R2-2 で却下した「キー除去」案が正しく撤回され、
`tags: []` 保持 + `POST { termIds: [] }` による remote 清理という Emit らしい解決に是正されています。
T1〜T7 と Step 0〜6 の作業手順も前回指摘を網羅しており、実装可能な水準です。

**実装着手の前に以下 3 点を Rev.3 で確定させること:**

| #     | 内容                                                                                                                                                               | 影響度                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| **A** | `TaxonomyLookupMaps` を `ReturnType<typeof loadLocalTaxonomyMaps>` に統一（index signature 廃止）                                                                  | typecheck 失敗                           |
| **B** | G19 バイパスを「audit known かつ 0 件」の 3 条件に修正し、unknown / `noTaxonomyAudit` では発火を維持。`remoteTaxAudit` の wiring（create 経路の audit 順序）を明記 | **保護の後退**（誤 wipe を許す）         |
| **C** | Epistemic フラグの注入経路（CLI→orchestrator→pullArticle→FastPathContext）を明記し、`taxonomyApplyPending` は間引き不发火時に保持                                  | **G17 の喪失**（R3-4(b) の失敗シナリオ） |

A・B・C を反映すれば Rev.3 は実装着手可と判断します。

---

# Rev.3 計画書レビュー（第 4 ラウンド）— ブロッカー A・B・C の解消確認と残存 4 点

**対象**: `docs/v0131-plan/README.md` Rev.3（415 行）
**結論**: **A・B・C はすべて解消。設計は実装着手可能。**
ただし T7 のテスト注入経路に命名不整合が 1 件、Layering Gate に関する事前確認が 1 件残る（both 軽微）。

---

## R4-1. ブロッカー A — 解消 ✅

```ts
// Rev.3 §3.1（README.md:72-75）
export interface TaxonomyLookupMaps {
  slugToId: { category: Record<string, string>; tag: Record<string, string> };
  idToSlug: { category: Record<string, string>; tag: Record<string, string> };
}
```

`loadLocalTaxonomyMaps()` の宣言戻り値（`src/sync/taxonomies.ts:363-366`）と **語句単位で完全一致**ことを確認。
index signature が消えたことで代入可能性の問題は解消済みです。

**推奨（任意）**: 2 箇手で同じ構造を書くと将来 `loadLocalTaxonomyMaps()` に taxonomy 種別が増えたとき片方だけ更新されます。
`export type TaxonomyLookupMaps = ReturnType<typeof loadLocalTaxonomyMaps>;` にすると単一ソース化できますが、
Layer 0 → Layer 1 方向の import になるため **現行の interface 重複のままでも layering gate は通る**ため優先度は低いです。

なお `isKnownTaxonomyTerm` の `maps.idToSlug[taxName]?.[term]` という optional chaining は、
index signature を外したこの型では **TS が常に truthy と判定して警告を出すことはありません**（安全）が、
`?.` は実質無効です。挙動は正しく、T1 で ULID 入力・slug 入力の両方を通せば十分です。

---

## R4-2. ブロッカー B — 解消 ✅（ただし「create 経路は G19 不发火」の根拠を補強）

### (a) 3 条件の厳密化は正しい

```ts
const auditKnown =
  params.remoteTaxAudit !== null &&
  params.remoteTaxAudit !== undefined &&
  Array.isArray(params.remoteTaxAudit[taxKey]);
const remoteCount = auditKnown ? params.remoteTaxAudit![taxKey]!.length : null;
if (remoteCount === 0) {
  /* clean bypass */
} else {
  /* G19 発火 */
}
```

- `unknown`（`null`）は `else` 側 → **G19 が発火** ✅ epistemic rule と整合
- `--no-taxonomy-audit` は `remoteTaxAudit` が初期値 `null` のまま（`tax_audit.ts:49,62`）→ `auditKnown === false` → G19 発火 ✅
- taxonomy 別内訳も正しい: `tax_audit.ts:74-79` は片側だけ取得失敗あり得るため per-key 判定が必要 — Rev.3 の `taxKey` 単位判定はそれを満たす ✅
- `remoteCount === 0` のとき `POST { termIds: [] }` が走る ✅ 孤児 `post_terms` を残さない

### (b) create 経路の記述は**結論として正しいが根拠が違う**

> ※ create 経路（新規作成記事）は `baseSnapshot` が存在せず `prevTerms` がないため G19 は原理的に発火しません。

create 分岐にも `baseSnapshot` は渡されます（`push/index.ts:271`、取得自体は `push/index.ts:95` で id に対して無条件）。
本当に発火しない理由は次です:

```ts
// push/index.ts:163
const isNewArticle = !syncState;   // create 分岐の判定は syncState の有無
if (isNewArticle) { ... }          // → auditRemoteTaxonomies を呼ばない（update のみ :338）
```

つまり **create では `remoteTaxAudit` が生成されない**ので、`syncArticleTaxonomies` に `null` 以外を渡せるのは
update 経路のみ — Rev.3 の「update 経路で audit 結果を渡す」という wiring 指定は正しく、十分です。
plan の根拠文だけ「create 分岐では `auditRemoteTaxonomies` が走らないため」に書き換えることを推奨（実装影響なし）。

### (c) 副作用の警告: bypass は divergence を止めない

`auditRemoteTaxonomies` は `remoteTaxAudit` とは**別に** `taxonomyDivergenceDetected` を返します
（`tax_audit.ts:96-98`）。削除済みタームが remote にまだ割り当て済みだと hash が baseline と食い違い
`taxonomyDivergenceDetected === true` になるため、G19 bypass で clean に `POST { termIds: [] }` まで到達しても、
**PUT 前に 409 相当の merge 経路（`push/index.ts:368-375`）へ入る可能性があります**。

→ T3 は「G19 も発火せず `termIds: []` 発行」だけでなく、**merge 経路で消えないこと**（または
`--resolve-taxonomy` 無しで通ること）まで assert してください。テスト名に含めれば十分です。

---

## R4-3. ブロッカー C — 解消 ✅（ただし T7 の注入名が plan 内で不整合）

### (a) フラグ貫通は正しい

`PullOptions.canPruneTaxonomies?: boolean` → orchestrator で
`!options.postsOnly && !taxonomiesFailed` を計算 → `pullArticle` → `FastPathContext` は、
既存の呼び出し経路（`orchestrator.ts:144-159` の taxonomy sync、`:164-175` の `pullArticle` 呼び出し）に
そのまま追加できる形で整合しています。

### (b) `taxonomyApplyPending` 保持分岐は正しい

```ts
const effectiveTaxonomyApplyPending = hasPrunedTax ? 0 : existingSync.taxonomyApplyPending;
```

R3-4(b) の失敗シナリオ（syntax-only heal で G17 が消える）を塞いでいます ✅。
`remoteTaxonomyHash` は間引き後値で再計算されるため、次回 push の divergence audit は
「remote に残る削除済みターム」を検出し G16 側でも保護されます — 二重のレールとして妥当です。

### (c) 【軽微・要修正】T7 の注入経路に旧名が残っている

```
| T7 | ... | `taxonomiesSyncFailed: true` / `postsOnly: true` 注入 |   ← README.md:389
```

Rev.3 が採用したフィールド名は **`canPruneTaxonomies`**（`:197,204,212,404`）で、
`taxonomiesSyncFailed` は Rev.2 の名前です。テスト表だけ旧名のまま残っており、
実装者が存在しないオプションを探します。→ `canPruneTaxonomies: false`（および orchestrar 経由の経路）に書き換えること。

---

## R4-4. 【要事前確認】Layering Gate — Layer 1 ヘルパーが Layer 0 の型を import できるか

Rev.3 の配置は `isKnownTaxonomyTerm` + `TaxonomyLookupMaps` を **Layer 0**（`src/utils/taxonomy-key.ts`）、
`carriesPrunedTaxonomies` / `pruneNonexistentTaxonomies` / `canonicalizeTaxonomiesForBaseline` を **Layer 1**
（`src/sync/taxonomies.ts`）です。Layer 1 → Layer 0 は軸 1 で許可されていますが、
**新規の import 边（`src/sync/taxonomies.ts` → `src/utils/taxonomy-key.ts`）が増える**ため、
`tests/layering.test.ts` の allowlist / snapshot がこれを許容するか Step 1 開始前に確認してください。

- 同ファイルは既に `canonicalSlugOf` / `aliasesOf`（`taxonomy-key.ts:39-54`）を Layer 0 に持っており、
  **`src/sync/taxonomies.ts:32` が既に `import { aliasesOf, canonicalSlugOf } from '../utils/taxonomy-key.js';` を持有** —
  边は既存なので **新規 import edge は不要**（確認済み ✅）。
- `tests/layering.test.ts` の snapshot（`ALLOWED_LAYER_2_SIBLING_IMPORTS`、`:255`）と
  `ALLOWED_LAYER_2_SYMBOLS`（`:65`）は Layer 3→Layer 2 と Layer 2 sibling を名前列挙で管理しており、
  **Layer 1→Layer 0 は対象外**のため Rev.3 の配置は gate を通過します。
- `pull/types.ts` は既に Layer 0 型を import しています（`:25` `import type { TaxonomyCandidates } from '../../utils/frontmatter.js'`）。
  → **`PrunedTaxonomiesDetail` は Layer 1 ではなく Layer 0 に置く**（例: `src/utils/taxonomy-key.ts`）のが
  既存パターンと揃い、pull types の import 先も増えません。Layer 1 の `pruneNonexistentTaxonomies()` が
  Layer 0 型を re-export する形を推奨。

---

## R4-5. 残る軽微点と最終判定

| #   | 内容                                                                              | 影響度               |
| --- | --------------------------------------------------------------------------------- | -------------------- |
| 1   | T7 の注入名 `taxonomiesSyncFailed` → `canPruneTaxonomies` に統一（README.md:389） | 実装者が迷う（軽微） |
| 2   | create 経路の「G19 不发火」根拠を「audit が走らないため」に修正（README.md:298）  | 文档のみ（軽微）     |
| 3   | T3 に「divergence merge 経路で消えないこと」を追加 assert（R4-2(c)）              | テスト網羅性         |
| 4   | Step 1 / Step 3 前に `tests/layering.test.ts` の allowlist を grep 確認           | Gate 失敗の予防      |

**判定: Rev.3 は実装着手可。** A・B・C はコード照合の上で完全に解消を確認しました。
上記 4 点は実装開始と同時に直せる軽微な文档・テスト上の調整であり、設計判断のやり直しは不要です。

---

# 実装レビュー（v0.1.31 / commit cfc6176）— Rev.3 準拠の検証と残存 2 点

**対象**: `cfc6176`（HEAD、作業ツリー clean）
**検証方法**: 各層の実装を diff 照合 + 単体/結合テスト実行 + 全品質ゲート再実行
**結論**: **Rev.3 の承認設計どおりに実装されている。4 ラウンドの指摘はすべて反映済み。**
軽微な残存 2 点（テスト網羅性 1・文档 1）があり、いずれも挙動の欠陥ではありません。

---

## 5-1. Rev.3 承認項目の適合性（全項目 ✅）

| Rev.3 指定                                                                 | 実装                                                                                                        | 照合箇所                                                                                                 |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| ブロッカー A: `TaxonomyLookupMaps` を `loadLocalTaxonomyMaps()` と一致     | ✅ index signature 無し、語句一致                                                                           | `taxonomy-key.ts:56-59` / `taxonomies.ts:363-366`                                                        |
| R4-4 推奨: `PrunedTaxonomiesDetail` を Layer 0 配置 + Layer 1 が re-export | ✅ 承認済み推奨どおり                                                                                       | `taxonomy-key.ts:61-64`、`taxonomies.ts` の `export type { PrunedTaxonomiesDetail, TaxonomyLookupMaps }` |
| ブロッカー B: 3 条件厳密化（audit known / 0 件 / unknown は発火）          | ✅ `remoteCount === 0` のときのみ bypass、`null`/undefined は `else` で G19 発火。per-key 判定も正しい      | `taxonomy_plan.ts:155-186`                                                                               |
| ブロッカー B: wiring（update 経路で audit 結果を渡す）                     | ✅ update 分岐のみ `remoteTaxAudit` を注入                                                                  | `push/index.ts:478`（create 分岐 `:265-275` は変更なし = Rev.3 の意図どおり）                            |
| ブロッカー C: `canPruneTaxonomies` の貫通                                  | ✅ CLI batch / MCP batch / orchestrator single の 3 経路で計算・注入                                        | `cli/commands/pull.ts:272`、`mcp/tools/sync-pull.ts:252`、`orchestrator.ts:169-183,354`                  |
| ブロッカー C: `taxonomyApplyPending` 保持分岐                              | ✅ `hasPrunedTax ? 0 : existingSync.taxonomyApplyPending`                                                   | `fast_path.ts:262-264`                                                                                   |
| Layer A 完全再構成（`bumpBaselineHashOnly: false`）                        | ✅ 間引き発火時のみ full rewrite、syntax-only heal は従来どおり hash-only bump を維持するよう最適化         | `fast_path.ts:276`                                                                                       |
| 0-GET 維持                                                                 | ✅ T2 が `GET /posts/{id}` 0 回を assert、テスト Green                                                      | `pull_taxonomy_pruning.test.ts:141`                                                                      |
| 未編集保護（hash match のみ発火）                                          | ✅ Branch 1 は hash-match パス内のみで評価、T4 で保護を確認                                                 | `fast_path.ts:206-310`、test `:307`                                                                      |
| phantom diff 根絶                                                          | ✅ T6 が `inspectArticleDiff` の additions/deletions 0 を assert                                            | test `:428-469`                                                                                          |
| Layer 3 表示（軸 3 準拠）                                                  | ✅ `src/presentation/article_report.ts` に新設、CLI/MCP 双方が import（`src/cli/commands/` 経由の共有なし） | `article_report.ts:107-124`                                                                              |
| AGENTS.md / CHANGELOG / version 更新                                       | ✅ §3 frontmatter invariant・§10 G19 Remote Audit Parity・0.1.31 エントリすべて記載                         | commit diff                                                                                              |

**追加で確認した安全性（実装者が明示していないが正しく動作する点）**

- **`delete_pending` は失われない**: 新 flags は `deletePending` を含みませんが、
  `cache.saveSyncState()` の SQL が `delete_pending = excluded.delete_pending` で
  `state.deletePending ?? 0` を渡すため、pull fast-path を通ると G15 のフラグは意図どおりクリアされます
  （remote が生存確認された記事なので正しい挙動）。`cache.ts:321,348`。
- **`remote_taxonomy_hash` は間引き後値で更新**: `baselineFrontmatter`（canonical slug / ULID verbatim）から
  `computeTaxonomyHash()` を再計算しており、T5 の整合 assert と一致。SQL 側も
  `CASE WHEN excluded... IS NOT NULL` で上書きされる（`cache.ts:331`）。
- **`bumpBaselineHashOnly: !hasPrunedTax` は Rev.3 より安全**: syntax-only heal では Layer A を
  再構成しない既存挙動（`fast_path.ts:355` の `true`）を保ち、間引き時のみ full rewrite。
  既存の percent-encoded / draft-annotation heal テストを壊さずに phantom diff を防いでいます。

---

## 5-2. 【残存 1・要追記】G19 bypass の unknown / 非 0 側（negative test）が未網羅

`taxonomy_plan.ts:155-186` の分岐は **2 とケースを扱う**のに、T3 は
「audit が 0 件を返す」成功側しか検証していません。

| ケース                                                       | 期待挙動                                             | テスト                                               |
| ------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------- |
| `remoteCount === 0`                                          | bypass + `POST { termIds: [] }`                      | ✅ T3（`:257-262` で `{ termIds: [] }` を返す mock） |
| `remoteCount > 0`                                            | G19 発火（`--allow-wipe-taxonomies` 無しでは throw） | ❌ 未網羅                                            |
| `remoteTaxAudit === null`（unknown / `--no-taxonomy-audit`） | G19 発火                                             | ❌ 未網羅                                            |

これは第 3 ラウンド R3-3 で「最重要」として是正した安全不変条件そのものです。
**ロジックは正しいが、将来の退行を検知するテストが存在しません。**

**推奨テスト（T8 / T9）**

```ts
it('T8: G19 still fires when remote audit reports non-zero assignments', async () => {
  // GET /terms/tag -> { termIds: [TAG_X] }、local tags: [] で push
  await expect(pushArticle(relPath, opts)).rejects.toMatchObject({
    code: 'DESTRUCTIVE_TAXONOMY_WIPE',
  });
});

it('T9: G19 still fires when remote audit is unavailable (--no-taxonomy-audit)', async () => {
  // noTaxonomyAudit: true（remoteTaxAudit は null のまま）+ local tags: []
  await expect(pushArticle(relPath, { ...opts, noTaxonomyAudit: true })).rejects.toMatchObject({
    code: 'DESTRUCTIVE_TAXONOMY_WIPE',
  });
});
```

---

## 5-3. 【残存 2・文档】merge 経路（409 / divergence）の G19 は audit parity の対象外

`merge_stage.ts:181-195` にも **別の G19 発火箇所**（`mergeTaxonomies()` の `wipeWarnings` 由来、
`merge.ts:71-75`）があり、ここは `remoteTaxAudit` を参照しません。

```ts
// merge_stage.ts:181 — remote 実状態を見ずに wipeWarnings だけで throw
if (!options.resolveTaxonomy && mergeResult.wipeWarnings?.length > 0) {
  if (!options.allowWipeTaxonomies && !options.force) throw ...DESTRUCTIVE_TAXONOMY_WIPE...;
}
```

第 3 ラウンド R4-2(c) で指摘したとおり、remote タームがまだ割り当て済みで hash が baseline と食い違うと
`taxonomyDivergenceDetected === true`（`tax_audit.ts:96-98`）→ **PUT 前に merge 経路**へ入り、
こちらの G19 で止まります。T3 の fixture は audit が clean に通る設定のためこの経路を通っておらず、
**実運用の「ターム削除直後」で `--allow-wipe-taxonomies` が必要になるケースが残る**可能性があります。

- **これは欠陥ではなく意図的な安全側**と評価します（merge 経路は union 判定を持ち、remote の非 0 割当を
  実際に観測しているため audit parity より厳密）。
- ただし AGENTS.md の Remote Audit Parity 記述は `taxonomy_plan.ts` の G19 しか説明しておらず、
  **merge 経路の G19 が audit parity の適用外であることが読み取れません**。
  → §10 に「merge 経路（3-way merge）側の `DESTRUCTIVE_TAXONOMY_WIPE` は remote 実割当を観測して
  発火するため audit parity のバイパス対象外」と 1 行追記することを推奨。

---

## 5-4. 品質ゲート再検証（本レビューで再実行）

```
npx vitest run tests/pull_taxonomy_pruning.test.ts tests/taxonomy_key.test.ts tests/layering.test.ts
  → 3 files / 24 tests passed（T1: 12、T2-T7: 6、layering: 6）

npm run check
  Test Files  61 passed (61)
       Tests  661 passed (661)
```

報告どおり Green を確認。新規 sibling 結合例外は増加なし（`tests/layering.test.ts` の
`LAYER_1_FILES` に `sync/taxonomies.ts` が登録済みで、Layer 1 → Layer 0 import は軸 1 で許可）。
`src/utils|db|client|sync` から `src/presentation/` への import は 0 件（軸 4 クリーン）。

---

## 5-5. 最終判定

**v0.1.31 の実装は妥当で、レビュー 4 ラウンドの全指摘が正しく反映されています。**
特に (1) `bumpBaselineHashOnly: !hasPrunedTax` による既存 heal 挙動の非退行維持、
(2) per-key な audit 判定、(3) flags 全面引き継ぎ（`delete_pending` のクリアを含む）は、
plan を超える正確さで実装されています。

**次アクション（任意・軽微）**

1. **T8 / T9 を追加**（5-2）— G19 unknown / 非 0 側の negative test。安全不変条件の退行検知に必須。
2. **AGENTS.md §10 に merge 経路 G19 の適用外を 1 行追記**（5-3）。
3. `guards.ts` の G19 `source:` が `'src/sync/push.ts:803,1232'` を指したままです（実体は
   `push/taxonomy_plan.ts:155-186` と `push/merge_stage.ts:181-195`）。guard registry の行番号は
   既存から stale ですが、新規変更でさらにずれたため次バージョンで更新するとよいです（挙動影響なし）。
