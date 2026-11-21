# Emit v0.1.26 実装計画書: カテゴリ・タグ定義 YAML の Two-Layer デコード表示化 (案 B) [Rev.6]

- **対象バージョン**: `v0.1.26`
- **改訂履歴**:
  - Rev.1 (2026-11-15): 初版ドラフト作成
  - Rev.2 (2026-11-15): 外部レビュー反映。2 フェーズ衝突解決アルゴリズム、YAML 安全性クォート（`formatYamlScalar`）、パース時ガード強化、ハッシュ不変性検証の明確化、および AGENTS.md 規約更新を反映
  - Rev.3 (2026-11-15): レビュー検証反映。js-yaml の継続利用（`readTaxonomyDir` での `yaml.load`）確認、`canonicalSlug` 省略時の round-trip 担保根拠（`formatYamlScalar` による予約語・数値クォート）、malformed スラッグ表記の厳密化（`%E0%A4%A`）、型契約（optional ポリシー）の因果関係、および canonical 同士衝突時の決定論と ULID 解決仕様を明文化
  - Rev.4 (2026-11-15): 外部検証反映。`%25` エンコード未検証推定への注記、canonical 衝突時における「敗者 slug 指定は勝者に解決される」因果の明記、decoded slug クォート表記テスト、`parentId: null` / `count` の型安定性 assert をテスト計画に追加
  - Rev.5 (2026-11-15): 外部実測反映。canonical 衝突時における Layer B 表示層（summary / hint / candidates）での敗者非表示仕様の明記、長いスラッグの 1 行出力（folded block `>-` 解消）テスト、および特殊エンコード検証の remote API レスポンス基準の明文化
  - Rev.6 (2026-11-15): 外部検証（assert 型整合性・エイリアス衝突実証）反映。§5 canonical 衝突テストにおける `canonicalizeFrontmatterTaxonomies` の戻り値型整合性（`resolvedTaxonomies[taxKey]` 内の `{ input, resolved, id }` 検証）、§2.2 / §5 における敗者 term の name エイリアス解決可能性と shared slug 指定時のサイレント勝者解決（silent assignment）の注意喚起、および canonical slug vs name alias 衝突（Term A の canonical slug と Term B の name alias が同一キー）の実証フィクスチャを明文化
- **ステータス**: 計画確定 (Approved & Ready for Implementation)
- **対象領域**: `categories/*.yaml`, `tags/*.yaml`, `src/sync/taxonomies.ts`, `AGENTS.md`

---

## 1. 概要と背景

### 1.1 現状の課題
Emit では v0.1.18〜v0.1.25 において、記事本文フロントマター（`taxonomies:`）に対して **Two-Layer Representation（2層表現）** を導入しました。これにより、ディスク上では `ローカルガイド` や `未分類` のような自然な日本語デコード表記を用いながら、内部通信・ベースライン snapshot・ハッシュ計算ではリモート正規値（`%e3%83%ad...`）を厳格に維持することで、ファントム diff ゼロと快適な執筆体験を両立させました。

しかし、現在 `categories/<id>-<label>.yaml` および `tags/<id>-<label>.yaml` に保存されている定義ファイルでは、依然としてリモート API から取得した生の値がそのまま出力されています：

```yaml
# 現状の categories/01M67MY25QW77PWZEDNH13JS4R-ローカルガイド.yaml
id: 01M67MY25QW77PWZEDNH13JS4R
name: ローカルガイド
slug: '%e3%83%ad%e3%83%bc%e3%82%ab%e3%83%ab%e3%82%ac%e3%82%a4%e3%83%89'
taxonomy: category
parentId: null
count: 1
```

ファイル名や `name:` フィールドが `ローカルガイド` であるにもかかわらず、`slug:` フィールドのみパーセントエンコード文字列が残存しており、人間や AI エージェントが定義ファイルを直接閲覧・編集する際に視認性と一貫性を損ねています。また、長いパーセントエンコード文字列によって YAML が複数行の folded block（`slug: >-`）に化ける現象も発生しています。

### 1.2 目的 (案 B: 完全デコード方式)
本文フロントマターと同じ設計思想に基づき、タクソノミー定義 YAML ファイルの `slug:` をディスク上では自然なデコード表記（`slug: ローカルガイド`）へ移行し、リモート正規スラッグを `canonicalSlug` として安全に分離保持する Two-Layer 化を実施します。

---

## 2. アーキテクチャ設計と不変条件

### 2.1 YAML 表記仕様 (Layer B: ディスク表現)

パーセントエンコードを含むスラッグを持つカテゴリ・タグは、以下の新フォーマットで出力します：

#### 日本語等のパーセントエンコードを含むスラッグ:
```yaml
id: 01M67MY25QW77PWZEDNH13JS4R
name: ローカルガイド
slug: ローカルガイド
canonicalSlug: '%e3%83%ad%e3%83%bc%e3%82%ab%e3%83%ab%e3%82%ac%e3%82%a4%e3%83%89'
taxonomy: category
parentId: null
count: 1
```

#### ASCII の通常スラッグ（`camera`, `gadget` 等）:
`slug` と `canonicalSlug` が一致する場合は、冗長なフィールドを排除してこれまで通り出力します：
```yaml
id: 01M67MY23GDT9X8QMY0G5SEQ6M
name: カメラ
slug: camera
taxonomy: category
parentId: null
count: 12
```

- **`canonicalSlug` 省略時の round-trip 保証根拠**:
  `canonicalSlug` を出力しない term は、`slug:` に保持された値が YAML round-trip（`yaml.load`）でリモート生スラッグと byte 単位で完全一致することを `formatYamlScalar`（`SAFE_PLAIN_SCALAR_RE`, `YAML_RESERVED_RE`, `YAML_NUMERIC_OR_DATE_RE`）によって保証します（例: `on`, `true`, `2026-review` などの予約語や数値風文字列は `JSON.stringify` 経由で確実にクォートされ、型変換事故を防ぐ）。
- **パーセント記号を含むスラッグの扱い**:
  - デコード可能なパーセント列（日本語や記号エンコードなど、`tryDecodeTaxonomyTerm(raw) !== raw` となるもの）: デコード結果を `slug:` に出力し、生値を `canonicalSlug:` に出力します。
  - デコード不能な malformed スラッグ（`%E0%A4%A` のように UTF-8 バイト列として不正で `decodeURIComponent` が `URIError` をスローするもの）: `tryDecodeTaxonomyTerm` の仕様に従いデコードを行わず、`canonicalSlug` は出力せずに原文のまま `slug` に保持します。
  - ※なお、「リモート EmDash/WordPress が `%` を常に `%25` と正規化して返すか」は現行コーパスでは未検証の推定であるため、テスト計画ではデコード可能パターン（`%350%25off` 型）とデコード不能パターン（`50%off` / `%E0%A4%A` 型）の双方をリモート API レスポンス基準で網羅して動作を検証します。

### 2.2 4 つのコア不変条件 (Invariants)

1. **不変条件 1 (Layer A 整合性 - Canonical Slug Invariant)**:
   - `loadLocalTaxonomyMaps().idToSlug[termId]` は、**常に `canonicalSlug`（リモート D1 の生のスラッグ）を返さなければならない**。
   - これにより、`push/taxonomy_plan.ts:canonicalizeTerms` がフロントマター内の日本語表記を確実に正規スラッグへ解決し、`pushArticle` のリモート送信 payload や `base_snapshots.frontmatter_yaml`、`computeTaxonomyHash` の入力が 100% 安定してファントム diff や意図しないタクソノミー張り替え（silent substitution）を防止する。

2. **不変条件 2 (2 フェーズ衝突解決と一意性保護 - Two-Phase Collision Resolution Invariant)**:
   - `loadLocalTaxonomyMaps()` は既存の 2 フェーズ登録手順を厳格に順守する：
     - **Phase 1 (Canonical 優先登録)**: すべての term の `canonicalSlug` を最優先で `slugToId` に登録する。
       - *Canonical 同士の衝突*: 同一スラッグを持つ term 同士（例: 同一スラッグの親子カテゴリ）が衝突した場合は、既存の決定論（`sortDeterministically`: count 降順 → ULID 降順）で勝者が `slugToId` を獲得する。
       - *敗者 term の解決*: **敗者となった term の slug 指定は勝者の ID に解決される（敗者には届かない：勝者 term が暗黙に割り当てられる）**。ただし、敗者 term が一意な表示名（`name`）を持つ場合は、フロントマターでその `name` エイリアスを指定すれば Phase 2 解決経由で敗者 term に解決できる。スラッグ指定で敗者を区別したい場合や表示名も衝突している場合は、フロントマターで **ULID を直接指定**（`categories: ['01M6...']`）する必要がある（`idToSlug` には両 term の ULID が保持される）。
       - *Layer B 表示層での挙動*: `getLocalTaxonomiesSummary()` の `dedupeBySlug` はスラッグをキーに重複排除するため、**ヒント・候補一覧（`formatTaxonomiesHint`, `loadLocalTaxonomyCandidates`）には勝者のみが表示され、敗者 term は表示されない**。
       - *Canonical vs Alias の保護*: 「デコード済みスラッグまたは表示名を正規スラッグとして持つ Term A」と「パーセントエンコード正規スラッグを持つ Term B（エイリアス候補が Term A のスラッグと一致）」が存在した場合でも、Phase 1 で Term A の canonical キーが最優先登録されるため、Phase 2 で Term B のエイリアスによって奪われる（衝突・乗っ取り）事故を構造的に防ぐ。
     - **Phase 2 (Alias 条件付き登録)**: デコード済みスラッグ（`item.slug`）および表示名（`item.name`）はエイリアス候補として収集し、**「どの canonical slug とも衝突せず、かつ単一の term ID に一意に解決できる（`ids.size === 1`）場合のみ」** `slugToId` に登録する。複数 term で重複する曖昧なエイリアスはあえて登録しない（`tests/taxonomies.test.ts:217-257` の仕様を維持）。

3. **不変条件 3 (完全後方互換性 - Backward Compatibility Invariant)**:
   - 既存ワークスペースの未移行 YAML（`canonicalSlug` を持たず `slug: '%e3%83...'` となっているファイル）を読み込んだ場合でも、`readTaxonomyDir()` は自動的に `canonicalSlug = rawSlug` かつ `slug = tryDecodeTaxonomyTerm(rawSlug)` としてメモリ展開する。
   - 既存ファイルを一切壊さず動作し、次回 `emit pull` や `emit pull-taxonomies` 実行時に透過的に新フォーマットへ自動更新される。

4. **不変条件 4 (決定論的ソートとヒント出力 - Deterministic Presentation Invariant)**:
   - `getLocalTaxonomiesSummary()` および `formatTaxonomiesHint()` は、デコード済みスラッグを優先して表示・ソートする。
   - AI プロンプトや CLI 出力で `Available Categories: - ローカルガイド` のように、パーセントエンコードが完全に排除されたクリーンなヒントを提供する。

---

## 3. 変更対象モジュール (Strict Layering 遵守)

すべての改修は Layer 1（`src/sync/taxonomies.ts`）およびそのテストに閉じ、Layer 0〜3 の依存規則を厳格に維持します。

| モジュール | 層 | 変更内容 |
|---|---|---|
| `src/sync/taxonomies.ts` | Layer 1 | 1. `LocalTaxonomyItem` に `canonicalSlug?: string` を追加<br>2. `readTaxonomyDir()` にガード強化済み新旧互換パース処理を実装（`yaml.load` は継続利用）<br>3. `pullTaxonomies()` に `formatYamlScalar` を用いた安全な直列化関数 `serializeTaxonomyYaml` を導入し、1行出力で folded block を解消しつつ `slug: decodedSlug` と `canonicalSlug: rawSlug` を出力<br>4. `loadLocalTaxonomyMaps()` を 2 フェーズ衝突解決アルゴリズムに改修<br>5. `loadLocalTaxonomyCandidates()` での候補マップ生成を最適化 |
| `tests/taxonomies.test.ts` | Tests | 既存の衝突保護テスト（`共通名` 非登録等）が新形式でも正常にパスすることを確認・更新 |
| `tests/taxonomies_two_layer.test.ts`（新規） | Tests | 案 B の 4 つの不変条件（Two-Layer 往復、ハッシュ不変、後方互換性、canonical 優先解決、予約語クォート安全、型復元安定性、folded block 解消）を独立検証する専用テストスイート |
| `AGENTS.md` | Docs | §2 Workspace Structure および §3 Frontmatter 仕様に、タクソノミー定義 YAML の Two-Layer 仕様（`slug` と `canonicalSlug`）、および canonical 衝突時の ULID 解決規則を明文化 |

---

## 4. 詳細実装設計

### 4.1 型定義の拡張と契約ポリシー (`LocalTaxonomyItem`)
```ts
export interface LocalTaxonomyItem {
  id: string;
  /** Human-readable decoded slug for disk and prompts (e.g. 'ローカルガイド' or 'camera') */
  slug: string;
  /**
   * Raw server canonical slug for Layer A transport/hashes (e.g. '%e3%83...' or 'camera').
   * Optional in interface to preserve compatibility with hand-authored fixtures,
   * but guaranteed to be populated by readTaxonomyDir() (defaults to slug when omitted).
   */
  canonicalSlug?: string;
  name: string;
  parentId?: string | null;
  count?: number;
}
```
※`canonicalSlug` は手動作成ファイルや旧 fixture との型安全性を保つため optional としますが、`readTaxonomyDir()` は常に値を詰めて返します。§4.4 の `item.canonicalSlug || item.slug` は `readTaxonomyDir` を経由せずに直接 item を構築する外部モジュールへの多重防御（defensive coding）です。

### 4.2 `readTaxonomyDir` の後方互換読み込みとガード強化
空文字や不正な値を防ぐため、厳格なガードを設けます：

```ts
if (data && typeof data.id === 'string' && typeof data.slug === 'string') {
  const rawSlug = String(data.slug).trim();
  if (!rawSlug) continue; // 空 slug を排除

  const rawCanonical =
    typeof data.canonicalSlug === 'string' && data.canonicalSlug.trim()
      ? data.canonicalSlug.trim()
      : undefined;

  let slug: string;
  let canonicalSlug: string;

  if (rawCanonical && rawSlug) {
    // 新形式 (v0.1.26): canonicalSlug が明示されている
    slug = rawSlug;
    canonicalSlug = rawCanonical;
  } else if (rawSlug.includes('%')) {
    // 旧形式 (v0.1.25): slug がパーセントエンコードされている
    const decoded = tryDecodeTaxonomyTerm(rawSlug);
    slug = decoded;
    canonicalSlug = rawSlug;
  } else {
    // 通常の ASCII スラッグ
    slug = rawSlug;
    canonicalSlug = rawSlug;
  }

  items.push({
    id: data.id,
    slug,
    canonicalSlug,
    name: typeof data.name === 'string' ? data.name : slug,
    parentId: typeof data.parentId === 'string' ? data.parentId : null,
    count: typeof data.count === 'number' ? data.count : undefined,
  });
}
```

### 4.3 `pullTaxonomies` での YAML 出力と安全なスカラー生成
`formatYamlScalar`（`src/utils/frontmatter.ts`）を活用し、先頭 `%` や YAML 予約文字、コロン等を含むスカラーの安全なクォートを保証します。同時に、js-yaml のデフォルト挙動で発生していた長いパーセント文字列の folded block（`slug: >-`）を 1 行出力により解消します。なお、`pullTaxonomies` では `yaml.dump` の代わりに本関数を使用しますが、`readTaxonomyDir` で `yaml.load` を使用するため、`import yaml from 'js-yaml'` は `src/sync/taxonomies.ts` で引き続き必要です。

```ts
function serializeTaxonomyYaml(doc: {
  id: string;
  name: string;
  slug: string;
  canonicalSlug?: string;
  taxonomy: 'category' | 'tag';
  parentId: string | null;
  count: number;
}): string {
  const lines: string[] = [
    `id: ${formatYamlScalar(doc.id)}`,
    `name: ${formatYamlScalar(doc.name)}`,
    `slug: ${formatYamlScalar(doc.slug)}`,
  ];
  if (doc.canonicalSlug && doc.canonicalSlug !== doc.slug) {
    lines.push(`canonicalSlug: ${formatYamlScalar(doc.canonicalSlug)}`);
  }
  lines.push(`taxonomy: ${formatYamlScalar(doc.taxonomy)}`);
  lines.push(`parentId: ${doc.parentId ? formatYamlScalar(doc.parentId) : 'null'}`);
  lines.push(`count: ${doc.count}`);
  return lines.join('\n') + '\n';
}
```

### 4.4 `loadLocalTaxonomyMaps` の 2 フェーズ衝突解決アルゴリズム
Phase 1 で全 term の canonical slug を先に登録し、Phase 2 で decoded slug と name を厳格な一意性条件のもとでエイリアス登録します：

```ts
const toMaps = (items: LocalTaxonomyItem[]) => {
  const slugToId: Record<string, string> = {};
  const idToSlug: Record<string, string> = {};
  const sorted = sortDeterministically(items);

  // Phase 1: Register canonical slugs first (Track 1 / Layer A truth)
  for (const item of sorted) {
    const canonical = item.canonicalSlug || item.slug;
    idToSlug[item.id] = canonical;
    if (!slugToId[canonical]) {
      slugToId[canonical] = item.id;
    }
  }

  // Phase 2: Collect candidate aliases (decoded slug and human-readable name)
  // Only register an alias if it does not collide with ANY canonical slug and maps uniquely to 1 term ID.
  const aliasToIds = new Map<string, Set<string>>();
  const recordAliasCandidate = (alias: string | undefined, id: string) => {
    if (!alias || !alias.trim()) return;
    const normalized = alias.trim().normalize('NFC');
    let set = aliasToIds.get(normalized);
    if (!set) {
      set = new Set<string>();
      aliasToIds.set(normalized, set);
    }
    set.add(id);
  };

  for (const item of sorted) {
    recordAliasCandidate(item.name, item.id);
    const canonical = item.canonicalSlug || item.slug;
    const isCanonicalOwner = slugToId[canonical] === item.id;
    if (isCanonicalOwner && item.slug && item.slug !== canonical) {
      recordAliasCandidate(item.slug, item.id);
    }
  }

  for (const [alias, ids] of aliasToIds.entries()) {
    if (!slugToId[alias] && ids.size === 1) {
      const [uniqueId] = ids;
      slugToId[alias] = uniqueId;
    }
  }

  return { slugToId, idToSlug };
};
```

---

## 5. テスト計画

1. **`tests/taxonomies_two_layer.test.ts` (新規)**:
   - `pullTaxonomies()` が日本語カテゴリを `slug: ローカルガイド` + `canonicalSlug: '%e3%83...'` で保存すること。
   - `pullTaxonomies()` が英語カテゴリを `canonicalSlug` なしの `slug: camera` で保存すること。
   - **長いスラッグの 1 行出力（folded block `>-` 解消）**:
     - 日本語バイト数の大きいスラッグ（例: `%e3%83%88%e3%83%a9%e3%83%96%e3%83%ab%e3%82%b7%e3%83%a5%e3%83%bc%e3%83%86%e3%82%a3%e3%83%b3%e3%82%b0`）が `>-` にならず 1 行で出力され、`readTaxonomyDir` で完全に同一文字列に復元されること。
   - **予約語・数値・記号クォート往復**:
     - `on`, `true`, `2026-review` などの slug を持つ term が、`canonicalSlug` なしで `pullTaxonomies` → `readTaxonomyDir` 往復で文字列型・バイト一致すること。
     - decoded slug に記号（カッコやコロン等）が含まれる場合（例: `買い物(レビュー)`）、`formatYamlScalar` が適切にクォート（`slug: "買い物(レビュー)"`）してディスクに出力し、`readTaxonomyDir` で正確に復元されること。
   - **型復元の完全性**:
     - `parentId: null` が JS の `null` として、`count` が `number` 型として正確に復元されること。
   - `readTaxonomyDir()` が `canonicalSlug` を持つ新形式ファイルを正しくパースすること。
   - `readTaxonomyDir()` が旧形式（`slug: '%e3%83...'` のみ）のファイルを透過的にデコードして読み込めること。
   - `loadLocalTaxonomyMaps()` の `idToSlug` が確実に `canonicalSlug` を返し、`slugToId` が `ローカルガイド` と `%e3%83...` の双方から同一 ULID を引けること。
   - **ハッシュ・正規化不変性**: 同一 remote fixture に対する `loadLocalTaxonomyMaps().idToSlug` と `canonicalizeTerms()` の出力が、新旧 YAML フォーマット間で完全に byte 一致すること。
   - **衝突保護回帰テスト**:
     - *Alias 衝突*: 複数 term で共通の名前（`共通名`）や重複する decoded slug が存在する場合、エイリアス登録が安全にスキップされること。
     - *Canonical vs Alias 衝突*: Term A の canonical slug（例: `local-guide`）と Term B の表示名 `name: 'local-guide'` が重複する場合、Phase 1 の Term A が優先登録され、Term B の `name` エイリアスは `slugToId` に登録されない（Term A の正規登録が保護される）こと。
     - *Canonical 同士衝突*: 同一の canonical slug を持つ 2 つの term が存在する場合、
       1. 決定論（count 降順 → ULID 降順）で勝者が `slugToId` に登録されること。
       2. 敗者のスラッグ指定は勝者に解決されること（明示的 assert）。
       3. 敗者 term の ULID 指定が `canonicalizeFrontmatterTaxonomies()` 経由で `resolvedTaxonomies[taxKey]` に `{ input: loserUlid, resolved: canonicalSlug, id: loserUlid }` として記録され、敗者の term ID が正しく解決・保持されること。
       4. 敗者 term が一意な `name` を持つ場合、その `name` エイリアス指定が Phase 2 経由で正しく敗者 ID に解決されること。
       5. `getLocalTaxonomiesSummary()` が勝者のみを返し、敗者 term が表示層で重複排除（非表示）されること。
   - **Malformed スラッグ & 特殊エンコード (remote API レスポンス基準)**:
     - 不正なパーセント列（`%E0%A4%A`）を remote API の slug として注入した際、エラーなく原文のまま保持されること。
     - `%` 記号を含む正常エンコード（`%350%25off` 型）とデコード不能（`50%off` 型）を remote API レスポンスとして与え、前者は `canonicalSlug` 付きでデコードされ、後者は `canonicalSlug` なしで保持されること。
2. **既存テストスイートの確認**:
   - `npm run check`（Prettier, TypeScript 型チェック, 全 Vitest テスト, レイヤリング検証）がオールグリーンであること。
3. **実ワークスペースでの結合検証**:
   - `/Volumes/ext/github/emdash.aroooy.net` にて `emit pull` を実行。
   - `categories/01M67MY25QW77PWZEDNH13JS4R-ローカルガイド.yaml` が新フォーマットに更新され、`slug: ローカルガイド` になることを確認。
   - `emit status` および `emit diff` を実行し、記事にファントム diff が発生しないこと（`60 synced, 0 modified`）を確認。

---

## 6. 実装ステップと作業順序

1. **Step 1: 計画書の確定**（本ドキュメント: `docs/v0126-plan/README.md`）
2. **Step 2: `src/sync/taxonomies.ts` の型とパース・保存・衝突解決ロジック改修**
3. **Step 3: 新規ユニットテスト `tests/taxonomies_two_layer.test.ts` の実装**
4. **Step 4: 既存テストの整合性確認と実行**
5. **Step 5: `package.json` のバージョンアップ（`0.1.26`）、CHANGELOG、AGENTS.md 更新**
6. **Step 6: 本番ワークスペースでの実機 pull 検証と diff 確認**
