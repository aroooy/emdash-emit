# v0.1.35 計画書 (Rev.2): 装飾・拡張属性付き画像ブロックの不可逆消失防止および不透明フェンス（Tier 3）フォールバック

## 1. 概要・目的

EmDash の Web 管理画面で画像に対して設定された体裁・レイアウト情報（`alignment: left/center/right`、`displayWidth/Height`、`caption`、`title` 等）が、`emit pull` によるマークダウン変換時に削ぎ落とされ、その後の `emit push` でサーバー側の属性が意図せず初期化（破壊的消去）される重大なデータ先祖返り事故を防止する。

標準マークダウンで表現しきれない拡張属性を持つ画像ブロックについて、既存の Tier 3 不透明ブロック保護機構（`<!--ec:block ... -->`）へ自動フォールバックさせることで、完全な双方向同期の可逆性（Round-trip Fidelity）を保証する。

---

## 2. 発生している問題（Issue）と実証データ

### 2.1 発生事象
1. EmDash Web 管理画面で画像ブロックに「左寄せ / 右寄せ / 表示幅」などの指定を行う。
2. ローカルで `emit pull` を実行すると、`_type: "image"` の全ブロックが一律で標準マークダウン記法 `![alt](url)` に変換され、`alignment` などの属性が静かに脱落する。
3. ローカルで本文のテキスト等を微修正して `emit push` すると、装飾属性が抜け落ちた `{ _type: 'image', alt, asset }` がサーバーに送信され、**Web 側で設定した画像配置やサイズ指定が全滅（リセット）**する。

### 2.2 原因コード
`src/client/portable-text.ts:103-114`（`portableTextToMarkdown` 内）：

```ts
    } else if (block._type === 'image') {
      if (i > 0) lines.push('');
      const alt = (block.alt as string) || '';
      const url = (block.asset as { url?: string })?.url || '';
      lines.push(`![${alt}](${url})`); // ← alignment や displayWidth を無視して出力
      prevWasList = false;
    } else {
      // Tier 3: Unknown block -> opaque fence
      if (i > 0) lines.push('');
      lines.push(`<!--ec:block ${JSON.stringify(block)} -->`);
      prevWasList = false;
    }
```
`_type === 'image'` であるブロックは、どれだけリッチな拡張属性を持っていても Tier 1（標準画像）として扱われ、末尾の Tier 3 不透明フェンス（`<!--ec:block ... -->`）にフォールバックしない。

### 2.3 実証データ
- **対象記事 ID**: `01M7EYR88T87H4Q6DMQV8XD9BD`
- **対象ファイル**: `posts/draft/20261115_01M7EYR88T87H4Q6DMQV8XD9BD-メディアPULLしたときの体裁確認.md`

#### サーバー側の生データ（`content_get` レスポンス抜粋）
```json
{
  "_type": "image",
  "_key": "k0",
  "alt": "IMG_9977.jpg",
  "alignment": "left",
  "asset": {
    "url": "/_emdash/api/media/file/01M7EYKSMGZE29ZYY4J4EW1JMT.01M7EYKSTBGA0FTKF8PEMZJZYX.jpg"
  }
},
{
  "_type": "image",
  "_key": "k3",
  "alt": "DSC06837.jpg",
  "displayWidth": 400,
  "asset": {
    "url": "/_emdash/api/media/file/01M7BPN4J3YVG7NP4K5TASN21Z.01M7BPN4PFT8C7EQG8WC4DSMAW.jpg"
  }
}
```

#### 現状の Pull 結果（情報脱落）
```markdown
![IMG_9977.jpg](../../media/01M7EYKSMGZE29ZYY4J4EW1JMT.01M7EYKSTBGA0FTKF8PEMZJZYX.jpg)

![DSC06837.jpg](../../media/01M7BPN4J3YVG7NP4K5TASN21Z.01M7BPN4PFT8C7EQG8WC4DSMAW.jpg)
```
`alignment: "left"` や `displayWidth: 400` が完全に消滅している。

---

## 3. 詳細設計と改修仕様

### 3.1 変更方針
素の画像（標準属性のみ）は従来通り `![alt](url)` として人間が読みやすいマークダウンを維持しつつ、「標準マークダウンでは表現できない属性」を1つでも保持している画像ブロックは、Tier 3（`<!--ec:block ... -->`）として出力する。

### 3.2 判定ヘルパー関数の設計（ホワイトリスト方式の採用）

ブラックリスト方式（`customProps = ['alignment', ...]`）では、将来 EmDash 側に新しい属性（`aspectRatio`, `crop`, `hotspot`, `lightbox` 等）が追加された際に属性漏れ・先祖返り事故が再発するリスクがある。
そのため、**Tier 1（標準マークダウン）で表現可能な既知プロパティ集合（将来の Tier 2 変換テーブルの中核）以外の存在を検出するホワイトリスト方式（差集合判定）**を採用する。

`src/client/portable-text.ts` に追加：

```ts
/** Known property keys for plain Portable Text image blocks expressible in standard Markdown (Tier 1). */
const KNOWN_PLAIN_IMAGE_KEYS = new Set(['_type', '_key', 'alt', 'asset']);

/**
 * Reports whether an image block carries only plain properties expressible in standard Markdown (![alt](url)).
 * Returns false if the block carries layout, styling, or custom metadata (e.g. alignment, displayWidth,
 * caption, title, crop, hotspot) or if the asset object contains extended metadata beyond url.
 */
export function isPlainImageBlock(block: Record<string, unknown>): boolean {
  if (block._type !== 'image') return false;

  // 1. Check for extended top-level properties beyond Tier 1 plain image keys
  for (const [key, value] of Object.entries(block)) {
    if (!KNOWN_PLAIN_IMAGE_KEYS.has(key) && value !== undefined && value !== null && value !== '') {
      return false;
    }
  }

  // 2. Check for extended properties within the asset object beyond { url }
  if (block.asset && typeof block.asset === 'object') {
    const assetObj = block.asset as Record<string, unknown>;
    for (const [key, value] of Object.entries(assetObj)) {
      if (key !== 'url' && value !== undefined && value !== null && value !== '') {
        return false;
      }
    }
  }

  return true;
}
```

- **空値の取り扱い**: `caption: null`, `title: ''`, `undefined` など意味を持たない値は除外判定し、過度に Tier 3 へ落とさず Tier 1（人間が編集可能）のまま維持する。
- **2 層検査（asset 内部検査）**: `asset` が `{ url }` 以外（例: `storageKey`, `_type: 'asset'`, `metadata` 等）を持つ場合も、実データで起こりうる属性消失を防ぐため確実に Tier 3 へ落とす。

### 3.3 シリアライズ分岐の修正 (`portableTextToMarkdown`)

`src/client/portable-text.ts:103-114`:

```ts
    } else if (block._type === 'image' && isPlainImageBlock(block)) {
      // Plain images only -> standard markdown syntax (Tier 1)
      if (i > 0) lines.push('');
      const alt = (block.alt as string) || '';
      const url = (block.asset as { url?: string })?.url || '';
      lines.push(`![${alt}](${url})`);
      prevWasList = false;
    } else {
      // Extended images and unknown blocks (gallery, etc.) -> Tier 3 opaque fence
      if (i > 0) lines.push('');
      lines.push(`<!--ec:block ${JSON.stringify(block)} -->`);
      prevWasList = false;
    }
```

### 3.4 パース側（`markdownToPortableText`）との整合性

- 既存の `markdownToPortableText` は、すでに `OPAQUE_FENCE_PATTERN`（`/^<!--ec:block (.+) -->$/`）によって `JSON.parse` して元のブロックオブジェクトとして復元する仕様になっている。
- **エッジケース安全性**: `alt` に `-->` が含まれるケース（例: `{"alt":"a-->b"}`）でも、正規表現の末尾一致（`-->$`）とバックトラックにより正しく JSON 全体が抽出・復元される。
- したがって、パース側（マークダウン → Portable Text）には**一切の改修を要さず**、完全可逆なラウンドトリップが成立する。
- また、既存の Guard G9（不透明ブロック保護 / `verifyOpaqueBlocksUntampered`）の保護対象に自動的に含まれるため、誤った破損や意図しない編集からも防御される。

---

## 4. メディアパイプライン・ガード機構との整合性検証

### 4.1 画像ダウンロード（Pull 時のミラーリング）の成立性
- **検証結果**: 成立する（問題なし）。
- **根拠**:
  `src/sync/pull/media_stage.ts:228` は `collectArticleStorageKeys(canonicalMarkdown)` を呼び出す。
  `src/sync/media/body_scan.ts:83` では、`scannedRefs` だけでなく生テキスト `content` に対しても直接正規表現 `keyPattern`（`/(?:^|\/)media\/file\/([0-9A-HJ-NP-Z]{26}...)/gi`）を実行している。
  したがって、`<!--ec:block {"_type":"image",...,"asset":{"url":"/_emdash/api/media/file/<key>"}} -->` の中に含まれる URL も正しく検出され、`media/` への自動ダウンロードが実行される。

### 4.2 ディスク上のパス表記と Guard G9 の整合性
- **仕様**:
  `src/utils/media-body-refs.ts:147`（`canonicalToLocalMediaRefs`）は `<!--ec:block\s` で始まる行をスキップする。
  `isLocalizedIn()`（同 236 行）もフェンスを除外するため、フェンスが canonical のままでも `localizeArticleMediaRefs` は毎 pull で安定（byte-identical、churn なし）。
- **整合性**:
  Tier 3 フェンス内の JSON は、ローカルディスク上でも canonical URL（`/_emdash/api/media/file/<key>`）のまま維持される。
  これは **意図された仕様** であり、以下の 2 つの不変条件を満たすために不可欠である：
  1. Push 時に `JSON.parse` されてサーバーへ送られる `asset.url` がローカル相対パス（`../../media/...`）で汚染されるのを防ぐ。
  2. Guard G9（`verifyOpaqueBlocksUntampered`）が `baseMarkdown` と `localMarkdown` のフェンス文字列の完全一致を要求するため、ローカライズによって G9 が誤検知するのを防ぐ。

---

## 5. トレードオフ・挙動変化と運用上の制約

本改修は「Web 側で設定した装飾属性の破壊的消失を防ぐ」という安全性を最優先とするため、以下の運用上のトレードオフと初回挙動変化が生じる。

| 項目 | 影響 | 理由・位置づけ |
|---|---|---|
| **既存ワークスペース初回再 pull** | 初回 pull で対象記事が `healed: true`（1 回のファイル書き換え）となる | 旧ディスクの `![alt](url)` と新 baseline（フェンス）の差異を解消するため。正当かつ安全な収束動作 |
| **Markdown プレビュー** | 装飾付き画像はプレビュー上で**非表示（HTML コメント扱い）**となる | 標準マークダウンでは属性を表現できないため、データの完全性を優先 |
| **ローカル編集性** | 装飾付き画像はローカルでの編集・削除・並べ替えが**不可** | Guard G9 により改ざんが防止されるため。編集したい場合は Web 管理画面で行う |
| **将来の展望** | 将来の Tier 2（Markdown 拡張ディレクティブ）への過渡期安全策 | 将来 `::image{src="..." align="left"}` などの編集可能な可逆記法が導入されるまでのセーフティネット |

---

## 6. 実装手順（Phase 計画）

| Phase | 作業内容 | 対象ファイル | 検証方法 |
|---|---|---|---|
| **Phase 0** | **テスト環境の日付計算統一 (TZ 不整合修正)**<br>・`tests/local_media_refs.test.ts:44` の UTC `toISOString()` を `formatDatePrefix(new Date())` に是正<br>・深夜・早朝 (JST 0:00–9:00) 実行時の ENOENT 失敗を恒久根絶 | `tests/local_media_refs.test.ts` | `npx vitest run tests/local_media_refs.test.ts` PASS |
| **Phase 1** | **判定関数実装とシリアライズ分岐修正**<br>・`isPlainImageBlock`（ホワイトリスト方式・2層検査）を実装・export<br>・`portableTextToMarkdown` のシリアライズ分岐を修正 | `src/client/portable-text.ts` | `npm run typecheck` |
| **Phase 2** | **単体テスト・ラウンドトリップテスト追加**<br>・素の画像の標準記法変換テスト<br>・装飾付き画像（alignment, displayWidth 等）の Tier 3 フェンス変換テスト<br>・`asset` が `url` 以外を持つケースの Tier 3 フォールバックテスト<br>・`caption: null` / `title: ''` の Tier 1 維持境界テスト<br>・`alt` に `-->` を含む画像のラウンドトリップ（Greedy regex 回帰防止）<br>・未知の拡張プロパティを含む画像のフォールバックテスト<br>・ラウンドトリップ（PT → MD → PT）の完全可逆性テスト | `tests/portable-text.test.ts` | `npx vitest run tests/portable-text.test.ts` |
| **Phase 3** | **ドキュメント更新・バージョンバンプ・統合検証**<br>・`AGENTS.md` に image ブロックの Tier 3 フォールバック仕様を追記<br>・`CHANGELOG.md` に v0.1.35 セクションを追記<br>・`package.json` / `package-lock.json` を `0.1.35` に更新<br>・`npm run check`（フォーマット、型、循環依存、全テスト 676+ tests）PASS | `AGENTS.md`<br>`CHANGELOG.md`<br>`package.json`<br>`package-lock.json` | `npm run check` |

---

## 7. 受入基準（DoD: Definition of Done）

1. [ ] `tests/local_media_refs.test.ts` の日付プレフィックス計算が `formatDatePrefix(new Date())` に統一され、JST 深夜早朝でもテストが 100% Green であること。
2. [ ] `src/client/portable-text.ts` に `isPlainImageBlock` がホワイトリスト方式（2層検査）で実装され、単体エクスポートされていること。
3. [ ] 素の画像（`_type: 'image'`, `alt`, `asset: { url }`）、および空値（`caption: null`, `title: ''`）を持つ画像が従来通り `![alt](url)` として出力されること。
4. [ ] `alignment`, `displayWidth`, `caption` などの拡張属性を持つ画像、および `asset` に拡張キーを持つ画像が `<!--ec:block ... -->` として出力されること。
5. [ ] `<!--ec:block ... -->` として出力された装飾付き画像（`alt` に `-->` を含むケースを含む）を `markdownToPortableText` で戻した際、プロパティが一切欠落せず元のブロックオブジェクトとして復元されること（ラウンドトリップの完全可逆性）。
6. [ ] `tests/portable-text.test.ts` に上記検証を含む網羅的なテストケースが追加され、PASS すること。
7. [ ] `AGENTS.md` に image ブロックの Tier 3 フォールバック仕様が追記されていること。
8. [ ] `CHANGELOG.md`、`package.json`、`package-lock.json` が `0.1.35` に更新されていること。
9. [ ] `npm run check`（Prettier, TypeScript, Cycles, Vitest 全 63 ファイル / 676+ tests）がすべて PASS すること。
