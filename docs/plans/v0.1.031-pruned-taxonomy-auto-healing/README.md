# Emit v0.1.31 改善計画書（Rev.3）

**テーマ**: リモートで削除されたタクソノミー（カテゴリ・タグ）の未編集記事フロントマター自動自己修復と G19 整合性（0-GET Pruned Taxonomy Auto-Healing & Remote Audit Parity）

- **対象リビジョン**: `v0.1.30`（commit `e3948b3`）完了時点の `main` ブランチ
- **ステータス**: Rev.3 — **第 3 ラウンドレビュー（REVIEW.md R3-1〜R3-7）ブロッカー A・B・C を完全解消した確定設計**

---

## 0. エグゼクティブサマリー

### ユーザーからの課題報告
> 「タグやカテゴリを削除したあとに、その後、そのタグやカテゴリを参照している投稿を PULL しても、変更無し（skipped）と判定される。しかし実際はタグなどが削除されているので、YAML フロントマターは `[]` などになるべきではないか。」

### 根本原因と三重レビューによる技術的真実の確定

1. **EmDash（CMS 側）の Revision 不変性**:
   - EmDash CMS 側でタグやカテゴリが削除された際、データベース上は `terms` や `post_terms` レコードが削除されますが、**関連する投稿（`posts` テーブル）の `version` や `_rev`、`updatedAt` はインクリメントされません**（大量の記事レコードに対する無用なトランザクション負荷を避ける CMS 一般の設計）。
2. **Emit 側の PULL における先行同期**:
   - Emit は `emit pull`（CLI）および `sync_pull`（MCP）の**冒頭（Step 1）で常に `pullTaxonomies()` を実行**しています。
   - このため、リモートで削除されたタグ・カテゴリのローカル YAML 定義（`categories/*.yaml`, `tags/*.yaml`）は**即座にディスクから削除（prune）され、最新の有効な一覧（`taxonomyMaps`）がメモリにロード**されています。
3. **Fast-Path 最適化による盲点（デッドロックの発生）**:
   - 各記事の PULL 判定（`src/sync/pull/fast_path.ts:tryFastPathOrHeal`）は、リモートの `posts._rev` が前回の同期時と一致し、ローカルのファイルハッシュも一致していると、**手元の最新定義とフロントマター内のタグを突き合わせることなく、直ちに「変更なし（`skipped: true`）」で終了**してしまいます。
   - この結果、記事のフロントマターには既に削除されたタグが残り続け、ユーザーがその後その記事を編集して `emit push` しようとすると、**Guard G4（`INVALID_TAXONOMY_ERROR`）** で「未定義タグです。`emit pull` を実行してください」と弾かれます。しかし何度 `emit pull` してもリビジョン不変のため再度スキップされ、自力でフロントマターを手動編集しない限り永久にプッシュできないデッドロックに陥ります。
4. **G19（`DESTRUCTIVE_TAXONOMY_WIPE`）との整合性**:
   - フロントマターには `tags: []` を正しく保持し、push 時に `POST /terms/tag` に `termIds: []` を送ることで、**リモート側の `post_terms` 孤児レコードを正常に清理（wipe）** します（キー自体を除去する案は孤児レコードを残すため却下）。
   - push 側の Guard G19 判定において、**「remote audit で現行 assignment が 0 件と確認された場合」** は wipe ガードを正当にバイパスさせ、デッドロックを完全に解消します。

---

## 1. なぜ「自動 PULL FORCE（強制上書き）」ではダメなのか？

1. **ローカル未プッシュ編集の破壊リスク（最重要不変条件違反）**:
   - `--force` は「ローカル編集を破棄してリモートで強制上書きする」動作です。
   - ユーザーがローカルで記事本文を執筆中（未プッシュ編集あり）だった場合、裏でタグが削除されたからといって自動 FORCE すると、**せっかく書いた記事本文が消去（または強制隔離）されてしまいます**。
2. **「手動で新タグを書いた（追加意図）」との誤認（False Positive）**:
   - フロントマターに「ローカル定義にないタグ」がある理由は、以下の 2 通りあります：
     - パターン A: 以前存在していたが、リモートで削除された「古い残骸」。
     - パターン B: ユーザーが新しいタグを付けようとしてフロントマターに手動で書き足した「新規指定」。
   - 「ローカル定義にないから不一致 → 即 FORCE」とすると、ユーザーが手動追加したタグが pull のたびに勝手に消されてしまいます。
3. **パフォーマンスの維持（本文再取得 GET の抑止）**:
   - タグが 1 つ消えただけで何十件・何百件もの記事に個別 GET（`GET /posts/{id}`）を発行すると、バッチ Pull の高速性が損なわれます。

---

## 2. 本計画における解決アプローチと不変条件

すでに Emit は PULL の冒頭で `pullTaxonomies()` を完了しており、**最新の有効な一覧（`taxonomyMaps`）がメモリ上に存在**しています。

この事実を活用し、本文再取得 GET（`GET /posts/{id}`）を一切行わずに、**Fast-Path 内でフロントマターのタグのみを安全に間引き（Heal）し、push 側でリモートの孤児レコードを正常に清理（wipe）する設計**を採用します。

### 判定の安全性（確実な論理的証明）

- **`currentDiskHash !== existingSync.localHash`（ローカル編集あり）の場合**:
  - ユーザーが手動で編集した可能性があるため、**絶対に勝手に消さない**（Guard G4 で警告し、ユーザーに判断させる）。
- **`currentDiskHash === existingSync.localHash`（前回の pull 以降、完全未編集）の場合**:
  - ユーザーは前回の pull 以降 1 バイトも触っていないのに、フロントマターに現在のローカル定義に存在しないタグがあるということは、**「前回の pull 以降にタグがリモートで削除された」ことの確実な証明**となる。
  - この場合のみ、Fast-Path 内でフロントマターから該当タグを除去し、`tags: []` などの空配列を保持して再シリアライズ（In-place Heal）して保存する。
- **前提条件の保護（Epistemic Rule）**:
  - `pullTaxonomies()` が失敗した場合（`categoriesFailed || tagsFailed`）や、`--posts-only`（`postsOnly: true`）の実行時は、ローカル定義が最新である保証がないため、**間引き処理は絶対に発火させない**。

---

## 3. 詳細設計（ブロッカー A・B・C を完全解消）

### 1. 【Layer 0】共有ターム判定述語と詳細型の実装（`src/utils/taxonomy-key.ts`）

`TaxonomyCandidates` には ULID が入らないため、push（G4）と pull で共通に使える判定述語および除去詳細型を Layer 0 に新設。
型定義はブロッカー A を踏まえ、`loadLocalTaxonomyMaps()` の戻り値と完全一致させます：

```ts
export interface TaxonomyLookupMaps {
  slugToId: { category: Record<string, string>; tag: Record<string, string> };
  idToSlug: { category: Record<string, string>; tag: Record<string, string> };
}

export interface PrunedTaxonomiesDetail {
  categories?: string[];
  tags?: string[];
}

/**
 * Checks whether a taxonomy term resolves to a locally defined term.
 * Accurately supports ULID (idToSlug), canonical slug, decoded slug, and unique name aliases (slugToId).
 */
export function isKnownTaxonomyTerm(
  term: string,
  taxName: 'category' | 'tag',
  maps: TaxonomyLookupMaps,
): boolean {
  // 1. Exact ULID match (Layer A)
  if (maps.idToSlug[taxName]?.[term]) return true;
  // 2. Slug, decoded slug, or unique name alias match (Layer B)
  const id = maps.slugToId[taxName]?.[term];
  return Boolean(id && maps.idToSlug[taxName]?.[id]);
}
```

### 2. 【Layer 1】タクソノミー間引き & ベースライン正規化ヘルパー（`src/sync/taxonomies.ts`）

```ts
import type { PrunedTaxonomiesDetail, TaxonomyLookupMaps } from '../utils/taxonomy-key.js';
import { isKnownTaxonomyTerm } from '../utils/taxonomy-key.js';

/**
 * Checks whether frontmatter contains taxonomy terms that no longer exist in local definitions.
 */
export function carriesPrunedTaxonomies(
  taxonomies: Record<string, string[]> | undefined,
  maps: TaxonomyLookupMaps,
): boolean {
  if (!taxonomies) return false;

  for (const [taxName, terms] of Object.entries(taxonomies)) {
    if (taxName !== 'category' && taxName !== 'tag' && taxName !== 'categories' && taxName !== 'tags') continue;
    const kind = (taxName === 'categories' || taxName === 'category') ? 'category' : 'tag';
    if (!Array.isArray(terms)) continue;
    for (const term of terms) {
      if (!isKnownTaxonomyTerm(term, kind, maps)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Filters out pruned taxonomy terms, preserving valid terms.
 * If all terms in a taxonomy are pruned, keeps an explicit empty array [] so remote cleanup can execute.
 */
export function pruneNonexistentTaxonomies(
  taxonomies: Record<string, string[]> | undefined,
  maps: TaxonomyLookupMaps,
): {
  prunedTaxonomies: Record<string, string[]>;
  removedTerms: PrunedTaxonomiesDetail;
} {
  const prunedTaxonomies: Record<string, string[]> = {};
  const removedTerms: PrunedTaxonomiesDetail = {};
  if (!taxonomies) return { prunedTaxonomies, removedTerms };

  for (const [key, terms] of Object.entries(taxonomies)) {
    if (!Array.isArray(terms)) continue;
    const kind = (key === 'categories' || key === 'category') ? 'category' : (key === 'tags' || key === 'tag') ? 'tag' : null;
    if (!kind) {
      prunedTaxonomies[key] = [...terms]; // 自定义 taxonomy キーはそのまま温存
      continue;
    }
    const retained: string[] = [];
    const removed: string[] = [];
    for (const term of terms) {
      if (isKnownTaxonomyTerm(term, kind, maps)) {
        retained.push(term);
      } else {
        removed.push(term);
      }
    }
    prunedTaxonomies[key] = retained;
    if (removed.length > 0) {
      if (kind === 'category') removedTerms.categories = removed;
      else removedTerms.tags = removed;
    }
  }
  return { prunedTaxonomies, removedTerms };
}

/**
 * Normalizes taxonomies for Layer A (base_snapshots.frontmatter_yaml).
 * CRITICAL: Preserves ULID inputs verbatim (protecting loser terms in slug collisions),
 * and resolves slug/name inputs to canonical slugs.
 */
export function canonicalizeTaxonomiesForBaseline(
  taxonomies: Record<string, string[]>,
  maps: TaxonomyLookupMaps,
): Record<string, string[]> {
  const canon: Record<string, string[]> = {};
  for (const [key, terms] of Object.entries(taxonomies)) {
    const kind = (key === 'categories' || key === 'category') ? 'category' : (key === 'tags' || key === 'tag') ? 'tag' : null;
    if (!kind) {
      canon[key] = [...terms];
      continue;
    }
    canon[key] = terms.map((term) => {
      // If already a valid ULID, keep ULID verbatim (prevents silent replacement of loser term)
      if (maps.idToSlug[kind]?.[term]) return term;
      const id = maps.slugToId[kind]?.[term];
      if (id && maps.idToSlug[kind]?.[id]) {
        return maps.idToSlug[kind][id]; // return canonicalSlug
      }
      return term;
    });
  }
  return canon;
}
```

### 3. 【Layer 2 Pull】Fast-Path での自己修復統合（`src/sync/pull/fast_path.ts`）

#### ブロッカー C 解消: フラグの完全貫通
1. `PullOptions`（`src/sync/pull/types.ts`）に `canPruneTaxonomies?: boolean` を追加。
2. CLI / MCP → `orchestrator.ts`（`pullBatch` / `pullSingleArticle`）にて：
   ```ts
   // taxonomy 同期が成功し、かつ postsOnly でない場合のみ true
   const canPruneTaxonomies = !options.postsOnly && !taxonomiesFailed;
   ```
   を `pullArticle` に注入。
3. `pull/index.ts` の `FastPathContext` に `getTaxonomyMaps: () => TaxonomyLookupMaps` および `canPruneTaxonomies: boolean` を渡す。

#### Fast-Path での自己修復コード
```ts
const maps = options.getTaxonomyMaps();
const candidates = getTaxonomyCandidates();

// Epistemic rule: Only trigger pruning when taxonomy sync was performed and succeeded!
const hasPrunedTax = Boolean(options.canPruneTaxonomies) && carriesPrunedTaxonomies(parsedCurrent.frontmatter.taxonomies, maps);

if (
  carriesPercentEncodedTaxonomy(currentDiskContent) ||
  needsDraftRevisionHeal ||
  hasPrunedTax
) {
  const { prunedTaxonomies, removedTerms } = hasPrunedTax
    ? pruneNonexistentTaxonomies(parsedCurrent.frontmatter.taxonomies, maps)
    : { prunedTaxonomies: parsedCurrent.frontmatter.taxonomies, removedTerms: {} };

  const healedFrontmatter = {
    ...parsedCurrent.frontmatter,
    taxonomies: prunedTaxonomies,
  };

  const respelledCanon = serializeMarkdown(
    healedFrontmatter,
    parsedCurrent.body,
    candidates,
    { hasDraftRevision: hasDraft },
  );
  const respelled = localizeDiskMarkdown(respelledCanon, existingSync.localFilePath);

  if (respelled !== currentDiskContent) {
    parseMarkdown(respelled);

    // CRITICAL: Full baseline rewrite (bumpBaselineHashOnly: false)
    // Layer A must store canonicalized taxonomies (ULID preserved, slugs canonicalized).
    const baselineFrontmatter = {
      ...healedFrontmatter,
      taxonomies: canonicalizeTaxonomiesForBaseline(prunedTaxonomies || {}, maps),
    };

    // CRITICAL (Review Point C): taxonomyApplyPending preservation rule
    // If taxonomy pruning occurred, reset to 0 (we intend to push new empty array).
    // If only syntax heal occurred (hasPrunedTax === false), preserve existingSync.taxonomyApplyPending to keep G17 active!
    const effectiveTaxonomyApplyPending = hasPrunedTax ? 0 : existingSync.taxonomyApplyPending;

    commitArticleSnapshot(options.cache, options.workspaceRoot, {
      id,
      relPath: existingSync.localFilePath,
      diskContent: respelled,
      canonicalContent: respelledCanon,
      frontmatter: baselineFrontmatter,
      bodyMarkdown: parsedCurrent.body,
      revForTransport: existingSync.remoteRev,
      revForComparison: existingSync.remoteRev,
      bumpBaselineHashOnly: false, // <- FULL REWRITE so Layer A is clean!
      flags: {
        remoteTaxonomyHash: computeTaxonomyHash(
          baselineFrontmatter.taxonomies?.categories,
          baselineFrontmatter.taxonomies?.tags,
        ),
        taxonomyApplyPending: effectiveTaxonomyApplyPending,
        conflictPending: existingSync.conflictPending,
        bodyConflictPending: existingSync.bodyConflictPending,
        taxonomyConflictPending: existingSync.taxonomyConflictPending,
        conflictCopyPath: existingSync.conflictCopyPath,
        conflictCopyHash: existingSync.conflictCopyHash,
        conflictAt: existingSync.conflictAt,
      },
    });

    return {
      id,
      slug: existingSync.slug,
      status: existingSync.status,
      filePath: existingSync.localFilePath,
      updated: true,
      healed: true,
      meaningChanged: hasPrunedTax, // pruned taxonomies alter meaning
      prunedTaxonomies: hasPrunedTax ? removedTerms : undefined,
      title: rawTitle,
      media: mediaSummary,
    };
  }
}
```

### 4. 【Layer 2 Push】G19 の remote audit 整合（ブロッカー B 解消）

`src/sync/push/index.ts` および `src/sync/push/taxonomy_plan.ts` を改修：

#### 1. Wiring の整合
`push/index.ts:338` の `auditRemoteTaxonomies` を呼び出す update 経路において、得られた `remoteTaxAudit`（`{ categories?: string[]; tags?: string[] } | null`）を `syncArticleTaxonomies` のパラメータに渡す。
※ create 経路（新規作成記事）は `auditRemoteTaxonomies` が呼ばれないため（`push/index.ts:163,338`）、update 経路の audit 結果渡しのみで完全整合します。

#### 2. G19 判定の厳密化（3 条件）
`src/sync/push/taxonomy_plan.ts:148-167`:

```ts
if (resolvedTermIds.length === 0) {
  const baseFm = readBaselineFrontmatter(baseSnapshot);
  const prevTerms =
    taxonomyName === 'category' ? baseFm?.taxonomies?.categories : baseFm?.taxonomies?.tags;
  
  if (prevTerms && prevTerms.length > 0) {
    // Review Point B: Check whether remote actually has 0 assignments via tax_audit
    const taxKey = taxonomyName === 'category' ? 'categories' : 'tags';
    const auditKnown = params.remoteTaxAudit !== null && params.remoteTaxAudit !== undefined && Array.isArray(params.remoteTaxAudit[taxKey]);
    const remoteCount = auditKnown ? params.remoteTaxAudit![taxKey]!.length : null;

    if (remoteCount === 0) {
      // Remote already has 0 assignments: Clean bypass!
      // Remote terms are already deleted on CMS, so sending empty termIds [] cleans up orphan relations safely.
      warnings.push(`🏷️ Remote ${taxonomyName} terms were already unassigned; synchronizing empty assignment.`);
    } else {
      // remoteCount > 0 or unknown (including --no-taxonomy-audit): Enforce G19 Guard!
      if (!options.allowWipeTaxonomies && !options.force && !options.resolveTaxonomy) {
        throw new ApiError({
          endpoint: `/_emdash/api/content/${collection}/${articleId}/terms/${taxonomyName}`,
          code: 'DESTRUCTIVE_TAXONOMY_WIPE',
          status: 400,
          message: `Local article specified empty array for ${taxonomyName}, which would remove ${prevTerms.length} existing remote assignment(s).`,
          suggestion: `Pass --allow-wipe-taxonomies (or --force) to confirm wiping all ${taxonomyName} assignments.`,
        });
      }
      warnings.push(
        `🏷️ Cleared all ${prevTerms.length} ${taxonomyName} assignment(s) from remote (local specified empty array).`,
      );
    }
  }
}
```

### 5. 【Layer 3】専用文言の表示（`src/presentation/article_report.ts`）

`src/presentation/article_report.ts` にフォーマッタを追加：

```ts
export function formatPrunedTaxonomiesNotice(pruned: PrunedTaxonomiesDetail | undefined): string | null {
  if (!pruned) return null;
  const parts: string[] = [];
  if (pruned.categories && pruned.categories.length > 0) {
    parts.push(`categories: ${JSON.stringify(pruned.categories)}`);
  }
  if (pruned.tags && pruned.tags.length > 0) {
    parts.push(`tags: ${JSON.stringify(pruned.tags)}`);
  }
  if (parts.length === 0) return null;
  return `🏷️ Pruned deleted taxonomy term(s) from frontmatter (${parts.join(', ')}). Push the file to apply changes on remote.`;
}
```

CLI（`pull.ts`）および MCP（`sync-pull.ts`）で、`res.prunedTaxonomies` がある場合は「Repaired frontmatter syntax」ではなく、上記の専用通知を表示。

---

## 4. レイヤリングおよびアーキテクチャ不変条件の保証

1. **Layer 0 / 1 / 2 / 3 の厳格分離**:
   - `isKnownTaxonomyTerm`: Layer 0（`src/utils/taxonomy-key.ts`）
   - `carriesPrunedTaxonomies` / `pruneNonexistentTaxonomies` / `canonicalizeTaxonomiesForBaseline`: Layer 1（`src/sync/taxonomies.ts`）
   - `tryFastPathOrHeal`: Layer 2（`src/sync/pull/fast_path.ts`）
   - G19 remote audit 整合: Layer 2（`src/sync/push/taxonomy_plan.ts`）
   - 表示文言フォーマッタ: Layer 3 Presentation（`src/presentation/article_report.ts`）
2. **Non-Degradation Invariant**:
   - 本文再取得 GET（`GET /posts/{id}`）ゼロを完全維持。
   - `currentDiskHash !== existingSync.localHash` の編集記事に対する 100% の破壊保護を維持。
   - `inspectArticleDiff` における phantom diff 発生ゼロを保証。
   - G17（`taxonomyApplyPending`）の意図せぬリセット防止を保証。

---

## 5. テストマトリクス（T1〜T7）

テストコードは新設する **`tests/taxonomy_key.test.ts`**（Layer 0）および **`tests/pull_taxonomy_pruning.test.ts`**（Layer 2 結合）に配置：

| テスト ID | 対象ファイル | 検証内容 | 注入経路 / 測定方法 |
|---|---|---|---|
| **T1** | `tests/taxonomy_key.test.ts` | `isKnownTaxonomyTerm` および `pruneNonexistentTaxonomies` が、ULID、canonical slug、decoded slug、一意 name alias を正確に識別し、同一スラッグの loser ULID を誤置換せず保持すること | maps 注入による単体テスト |
| **T2** | `tests/pull_taxonomy_pruning.test.ts` | リモートでタグが削除され `pullTaxonomies` で prune された後、未編集記事（hash match）の `pullArticle`（Fast-Path）が本文 GET（`GET /posts/{id}`）0 件でフロントマターから該当タグを除去し `healed: true` かつ `prunedTaxonomies` を返すこと | mockFetch URL 分類（`/posts/${id}` が 0 回） |
| **T3** | `tests/pull_taxonomy_pruning.test.ts` | 全タグが削除された記事について、フロントマターの `tags` が `[]` に自己修復され、次回 `pushArticle` 時に G4 も G19 も発火せず `POST /terms/tag` (`termIds: []`) が発行されてリモートが清理されること（divergence merge 経路に入らないこと） | push 時のモックとリクエスト body assert |
| **T4** | `tests/pull_taxonomy_pruning.test.ts` | ユーザーがローカルで記事を編集中の場合（`currentDiskHash !== existingSync.localHash`），フロントマターの未定義タグは勝手に消去されず、ローカル編集が 100% 保護されること | ローカル編集ファイルの pull 実行後のハッシュ・内容比較 |
| **T5** | `tests/pull_taxonomy_pruning.test.ts` | バッチ Pull（`pullBatch`）において、複数記事にまたがる削除済みタグが一斉に自己修復され、`sync_state.remote_taxonomy_hash` が整合すること | 複数記事 fixture での batch pull |
| **T6** | `tests/pull_taxonomy_pruning.test.ts` | 自己修復直後に `inspectArticleDiff`（`diff.ts:176`）を実行し、phantom diff が一切表示されないこと（Layer A 更新の検証） | `inspectArticleDiff` の差分行数 assert |
| **T7** | `tests/pull_taxonomy_pruning.test.ts` | `--posts-only` 実行時、および `pullTaxonomies` 失敗時（`tagsFailed: true`）は、間引き処理が発火せずローカルフロントマターが保護されること（Epistemic Rule 検証） | `canPruneTaxonomies: false` 注入 |

---

## 6. 実装ステップと作業手順

1. **Step 0: Layer 0 判定述語の実装**
   - `src/utils/taxonomy-key.ts` に `TaxonomyLookupMaps` 型および `isKnownTaxonomyTerm` を実装・export。
   - `tests/taxonomy_key.test.ts` を作成し T1 を検証。
2. **Step 1: Layer 1 タクソノミー検査・除去・正規化ヘルパーの実装**
   - `src/sync/taxonomies.ts` に `carriesPrunedTaxonomies`, `pruneNonexistentTaxonomies`, `canonicalizeTaxonomiesForBaseline` を実装・export。
3. **Step 2: Layer 2 Push 側の G19 remote audit 整合**
   - `src/sync/push/index.ts` で `auditRemoteTaxonomies` の結果を `syncArticleTaxonomies` に渡す。
   - `src/sync/push/taxonomy_plan.ts` にて、auditKnown かつ remoteCount === 0 の場合は G19 をバイパスし、`POST { termIds: [] }` による清理を実行。
4. **Step 3: Layer 2 Pull 側の Fast-Path 自己修復統合**
   - `src/sync/pull/types.ts` に `canPruneTaxonomies` を追加。
   - `src/sync/orchestrator.ts`（`pullBatch` / `pullSingleArticle`）で maps をロードし、`canPruneTaxonomies` フラグとともに `pullArticle` に注入。
   - `src/sync/pull/fast_path.ts` にて maps 照合、full baseline rewrite（`bumpBaselineHashOnly: false`）、`taxonomyApplyPending` 保持分岐、flags 引き継ぎを統合。
5. **Step 4: Layer 3 表示層の文言整備**
   - `src/presentation/article_report.ts` に `formatPrunedTaxonomiesNotice` を追加。
   - CLI（`pull.ts`）および MCP（`sync-pull.ts`）で専用通知を表示。
6. **Step 5: テストスイート（T2〜T7）の実装と検証**
   - `tests/pull_taxonomy_pruning.test.ts` を作成し、T2〜T7 を網羅して検証。
7. **Step 6: Quality Gate & ドキュメント更新**
   - `AGENTS.md`（§5 Baseline serialization invariant / §6 Taxonomy Validation）を更新。
   - `npm run check`（Prettier, TypeScript, 全テストスイート）完全 Green。
   - `package.json`（v0.1.31）および `CHANGELOG.md` を更新。
