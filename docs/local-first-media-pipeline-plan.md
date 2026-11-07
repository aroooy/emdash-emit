# Local-First 執筆環境の再定義 ＆ オフライン画像自動同期パイプライン（改定版 v2）

**策定日**: 2026-11-07
**対象リポジトリ**: `emdash-emit`（HEAD: `df033b0` / `package.json` version `0.1.7`）
**検証対象ワークスペース**: `/Volumes/ext/github/emdash.aroooy.net`
**検証対象実環境**: EmDash 本番インスタンス（`https://aroooy.net`, Cloudflare Workers + D1 + R2）

本書は初版実行計画書のレビューで判明した事実誤認（P0 4 件 / P1 3 件 / P2 6 件）を、
**稼働中インスタンスの OpenAPI 3.1.0 仕様・実 HTTP 応答・実ワークスペースデータ**による
実測結果で置き換えた改訂版である。

> [!IMPORTANT]
> 本書の全数値・全エンドポイント・全フィールド名は、モックや推測ではなく
> §2「確定済み契約」に列挙した実測エビデンスに由来する。
> 実測で確定できていない事項は §7「未確定事項（Phase 0 で確定）」に分離した。

---

## 1. 目的と狙い（Why & Objective）

### 1.1 背景と課題

1. **同期先行のメンタルモデル**
   「まずリモートに存在するものを取り込み、同期を維持する」前提が強く、
   Obsidian / VS Code で手元の Markdown と画像を使ってオフラインで執筆する
   ワークフローと乖離していた。
2. **画像の断絶（最大のボトルネック）**
   Guard G5 がローカル画像パスを拒否するため、
   「先にブラウザまたは MCP でリモートへアップロードし、リモート URL を取得する」
   工程が必須であり、完全オフライン執筆が不可能だった。
3. **先行検証で確定した成果（本改定の前提）**

| コミット | 成果 |
|---|---|
| `2d90b8b` | G5 を改定し正規リモートパスの誤検知を解消（誤検出率 69.3% → 0%） |
| `cea009b` | `featured_image` オブジェクトからの正規 ULID 抽出、3-Way Merge への統合 |
| `f729074` | Guard G10（`featuredImage` ULID 検証）導入 |
| `2ed59f2` | メタデータ偽装の廃止（`provider` / `src` / `storageKey` / 寸法を捏造しない） |
| `df033b0` | `featuredImage` 相互チェック警告を確定契約へ整合 |

### 1.2 狙い

- **Local-First への昇華**: 手元の Markdown と画像アセットがマスターであり、
  サーバーへの Push はビルド / デプロイ行為である、という Git ライクな位置づけへ移す。
- **オフライン画像自動同期**: `media/drafts/` に画像を置き
  Markdown に行頭 standalone 画像として参照しておくだけで、
  `emit push` 1 発で「自動アップロード → 本文 URL 置換 → ローカル昇格 → 記事送信」を完結させる。

### 1.3 Non-Goals との整合（README §1 を変更しない）

本機能は README §1 の Non-Goals を拡張しない。

| 観点 | 位置づけ |
|---|---|
| 対象画像 | **その記事で参照された画像のみ**（メディアライブラリの全量クローンではない） |
| 対象記事 | スライディングウィンドウ内 ＋ `emit pull <id>` で明示取得した記事 |
| bulk 移行 | 数千画像の一括移行は対象外（`emit pull media` の limit 思想を維持） |

---

## 2. 確定済み契約（実測エビデンス）

設計判断はすべてこの節に紐づく。実装時に本書の契約と異なる挙動を観測した場合は、
**実装ではなく本書を修正する**。

### 2.1 ID 空間は 2 系統ある（最重要）

同一メディアレコードの実測値：

```text
media record id : 01M67P08DXFTYDPFRTJCC4XMP8
storageKey      : 01M67P07X2VPW0MYRRRGMA6T5A.jpg
public file URL : /_emdash/api/media/file/01M67P07X2VPW0MYRRRGMA6T5A.jpg
contentHash     : sha1:03ddae9833573f2437bfdc66d919a8baa55ed0e2
status          : ready
```

さらに Phase 0 spike（`POST upload-url` → `PUT upload` → `POST confirm`）の実測で、**`confirm` 実行時に `storageKey` が 2 連 ULID 形式へ書き換わる**ことが確定した：

```text
media record id         : 01M6TF1XXBS2KC9EVYG6RBT0J0
storageKey (upload-url) : 01M6TF1XXBSC06QQG9M648B4K3.png                               (pending 時: 単一 ULID)
storageKey (confirm 後) : 01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png   (ready 時: 2 連 ULID)
public file URL         : /_emdash/api/media/file/01M6TF1XXBSC06QQG9M648B4K3.01M6TF1Y5YVG9YYQAY6H25270M.png
```

実 HTTP 応答（curl 実測）：

```text
GET /_emdash/api/media/file/01M67P07X2VPW0MYRRRGMA6T5A.jpg  -> 200  image/jpeg  805824  (storageKey 由来)
GET /_emdash/api/media/file/01M67P08DXFTYDPFRTJCC4XMP8.jpg  -> 404  application/json     (record id)
```

**結論：file ルートの鍵は `confirm`（または `existing: true`）が返す確定後の `storageKey` であって、media record id でも `upload-url` 直後の仮 `storageKey` でもない。**

| 用途 | 使用する値 | 実測根拠 |
|---|---|---|
| frontmatter `featuredImage` | **media record id** | `{ featured_image: { id: "<recordId>" } }` → HTTP 200、サーバーが `provider:"local"` へ正規化 |
| 本文 `![alt](...)` | **確定後 storageKey（拡張子込み）** | record id 版・仮 storageKey 版は 404 |

### 2.2 メディア関連エンドポイント（OpenAPI 3.1.0 より抽出）

`GET https://aroooy.net/_emdash/api/openapi.json` → HTTP 200（title `EmDash CMS API`）

| 操作 | 契約 |
|---|---|
| `POST /_emdash/api/media/upload-url` | body `{ filename*, contentType*, size*, contentHash?, fieldId?, deduplicate?: boolean, ensureUniqueFilename?: boolean, folderId? }` <br> 説明原文: *"Returns either a signed direct-to-storage URL **or a same-origin streaming target**. **Creates a pending media record.**"* |
| ↳ 応答 A `MediaUploadUrlResponse` | `{ uploadUrl, method: "PUT", headers: object, mediaId, storageKey, expiresAt }` （**すべて required**） |
| ↳ 応答 B `MediaExistingResponse` | `{ existing: true, mediaId, storageKey, url }` （**重複ヒット**） |
| `PUT /_emdash/api/media/{id}/upload` | content-type `*/*` <br> *"Streams a file to storage **when the configured adapter cannot provide a signed upload URL.** The Content-Type and byte count must match the pending media item."* → `{ uploaded: boolean, size: integer }` |
| `POST /_emdash/api/media/{id}/confirm` | body `{ size, width?, height? }` <br> *"Marks a pending media record as **ready** after the file has been uploaded."* → `{ item }`（`item.url` を含む） |
| `POST /_emdash/api/media` | **multipart**: `file: string(format: binary)`, `alt`, `caption`, `width`, `height`, `thumbnail`, `fieldId`, `deduplicate: "true"\|"false"`（**文字列 enum**）, `ensureUniqueFilename`, `folderId` → `{ item, deduplicated: boolean }` |
| `GET /_emdash/api/media` | query `cursor, limit, page, mimeType, folderId, q, includeUsage` → `{ items, nextCursor, totalCount }` |
| `GET /_emdash/api/media/{id}` | → `item`（**`url` を含まない**・実測 200） |
| `GET /_emdash/api/media/{id}/usage` | 使用箇所の照会（計画で `?includeUsage=true` を使用していたが、単一 item では **HTTP 400**） |
| `POST /_emdash/api/media/{id}/replace`, `PUT`, `DELETE`, `folders/*`, `admin/media-usage/*` | 維持・管理系（本書のスコープ外） |

### 2.3 `url` フィールドの不在マップ（構築規則の根拠）

| 応答スキーマ | `url` を含むか |
|---|---|
| `MediaUploadUrlResponse` | ❌（`storageKey` のみ） |
| `MediaExistingResponse` | ✅ |
| `MediaConfirmResponse.item` | ✅ |
| `MediaUploadResponse.item`（`MediaItemOutput`） | ❌ |
| `MediaItem`（`GET /media/{id}`） | ❌（実測でも不在） |
| `MediaListReadItem`（`GET /media`） | ✅（現行 `pullMedia` はこれに依存） |

**→ 本文 URL は `/_emdash/api/media/file/${storageKey}` で構築する**（§2.1 で 200 を実証）。
応答に `url` が存在する場合はそれを正とし、origin を除去してルート相対化する。

### 2.4 status ライフサイクルと不可逆性

- `MediaItemOutput.status` の enum は **`pending | ready | failed`**。
- `POST /_emdash/api/media/upload-url` は説明原文のとおり **pending レコードを作成する**。
- したがって失敗経路には必ず孤発 pending が残る。
- EmDash 公式（Media Library ガイド）: *Media deletion has no Trash and cannot be undone.*

→ 補償処理なしの実装は、本番メディアライブラリにゴミを残す。§4 と §5 で扱う。

### 2.5 signed upload は利用できない可能性がある（Phase 0 で同一原点 streaming と確定）

EmDash 公式（Storage Options）:

- *Adapters that support signed uploads: S3 (including R2 via S3 API)*
- *Adapters that **do not** support signed uploads: **R2 binding**（R2 認証情報を使った S3 adapter を使え）*

対象インスタンスは Cloudflare Workers + R2 binding（AGENTS.md の前提）。
Phase 0 spike 実測でも `uploadUrl: "/_emdash/api/media/{id}/upload"` + `headers: { "Content-Type": "image/png", "X-EmDash-Request": "1" }` が返ることが確認された。
よって **同一原点 streaming 経路（`PUT /_emdash/api/media/{id}/upload`）を主、
signed URL を従** とし、応答フィールドだけで分岐する。

### 2.6 contentHash の規約（Phase 0 で `sha1:<hex>` 必須と確定）

実レコードの `contentHash` は `sha1:<hex>`（SHA-1 に `sha1:` プレフィックス）。
初版計画の SHA-256 前提はこの規約と一致しない。

- サーバー側 dedup に渡す値: サーバー規約（`sha1:<hex>`）— Phase 0 spike で `sha1:<hex>` 送信時に `{ existing: true, mediaId, storageKey, url }` が返り、`sha1:` なしの生 hex では重複ヒットしないことを実証済み
- Emit ローカル専用の重複キー: SHA-256（API には送らない、`media_state` テーブル専用）

### 2.7 本文 URL の正規形はルート相対で確定

実ワークスペース `posts/` 内の実測:

```text
/_emdash/api/media/file/<26ULID>.<ext>      : 475 件
https://aroooy.net/_emdash/api/media/file/  : 0 件
```

EmDash 公式（Storage Options）: *the admin, the REST API, and URLs stored in content keep
the `/_emdash/api/media/file/` route.*

伴侶 YAML（`media/*.yaml`）の `url` フィールドおよび `media_state.url` も、プロファイル切り替えや独自ドメイン移行で失効しないよう、本文と同じ **ルート相対 `/_emdash/api/media/file/<storageKey>`** に統一する（`pullMedia` ダウンロード時のみ `new URL(canonicalDownloadPath, origin)` で解決）。

---

## 3. オフライン画像自動同期パイプライン（確定仕様）

### 3.1 ワークフロー（ユーザー視点）

```text
1. 画像を media/drafts/<name>.jpg に置く          （emit は関与しない・ただの置き場所）
2. Markdown に行頭 standalone 画像行を書く
     ![alt text](../../media/drafts/photo.jpg)
3. emit push posts/draft/<file>.md
     → Emit が検出し、アップロード → 本文 URL 置換 → 画像昇格 → 記事送信 を自動完結
```

### 3.2 内部パイプライン（原子性と順序）

```text
[P0] preflight: G1..G10 既存ガード → G11（LOCAL_IMAGE_AUTO_UPLOAD）発火判定
[P1] scan   : 行頭 standalone 画像行を抽出（§3.4 参照）/ 解決できない参照は拒否
[P2] upload : §3.3 の 4 段フロー（media_state に mediaId を即座に記録）
[P3] confirm: status == "ready" を確認 → 確定後 storageKey 由来 URL を確定
[P4] rewrite: Markdown 本文を置換 → ローカル .md 保存（この時点でローカルが正）
[P5] article: 記事 PUT/POST（content_hash 再計算）
[P6] promote: 記事 PUT/POST 成功後、media/drafts/<name> → media/<yyyyMMdd>_<mediaId>-<name>（§3.5）へ昇格し cache.db / media_state を commit
[X ] failure: §4 の補償トランザクション
```

**順序の原則**

- 本文書き換え（P4）は **confirm 成功後**に限定する。これにより「画像はあるのに本文が指していない」状態を生まない。
- 記事送信（P5）成功後に昇格（P6）と cache.db / media_state commit を行う。P5（記事送信）失敗時は P4 の置換済み Markdown と `media/drafts/` の原位置画像がそのまま残り、次 push で再送される（再アップロードは §3.6 の冪等性で防止）。

### 3.3 アップロード 4 段フロー（OpenAPI 実契約）

```text
[Phase A] POST /_emdash/api/media/upload-url   (application/json)
    body: { filename, contentType, size, deduplicate: true, contentHash?: "sha1:<hex>" }
    resp A MediaUploadUrlResponse { uploadUrl, method:"PUT", headers, mediaId, storageKey, expiresAt }
        └ expiresAt 超過 → 再取得（mediaId は新規になる → 旧 mediaId を §4 で掃除）
    resp B MediaExistingResponse { existing: true, mediaId, storageKey, url }
        └ 重複ヒット: Phase B/C を一切実行しない。local_hash → mediaId を記録して終了

[Phase B] 送信（応答フィールドだけで分岐）
    resp A 且つ uploadUrl が外部署名  → PUT <uploadUrl> ＋ 返却 headers を付与（Authorization ヘッダは付与しない）
                                          Content-Type と byte count を pending と厳密一致
    resp A 且つ uploadUrl が同一原点  → PUT /_emdash/api/media/{mediaId}/upload  (*/*)

[Phase C] POST /_emdash/api/media/{mediaId}/confirm  { size, width?, height? }
    resp { item }  → item.status == "ready" であることを検証
    ※ confirm 実行時に item.storageKey が 2 連 ULID 形式へ更新されるため、
      必ず confirm 応答の item.storageKey / item.url を採用し、origin を除去してルート相対化する（§2.1 / §2.3）

[Phase D] 本文置換（P4）→ 記事 PUT/POST（P5）→ 昇格 & cache.db / media_state commit（P6）
```

> [!WARNING]
> 初版計画が採用していた `POST /_emdash/api/media`（multipart direct upload）は **別経路**である。
> 3 段フローの後に呼ぶとメディアが二重登録されるため使用しない。
> ただし Phase 0 の spike で「multipart 単発」が同一原点 streaming より単純に動く場合は、
> 代替経路として §7 の判断結果に従う。

### 3.4 画像行の解析範囲（G5 / G11 の境界）

| 記述形 | 挙動 |
|---|---|
| 行頭 standalone 画像行 `![alt](../../media/drafts/a.jpg)` | **自動同期の対象** |
| 段落内 inline 画像 `テキスト ![alt](../../media/a.jpg) テキスト` | **明示拒否** `INLINE_LOCAL_IMAGE_NOT_SUPPORTED`、行头へ移動するガイダンスを出す |
| 正規リモート参照 `![](/_emdash/api/media/file/<ULID>.<ext>)` | 変換不要（既存 verbatim 往復を維持） |
| `![](https://origin/...)` | 既存 G5 準拠で許容（警告のみ） |
| opaque fence 内 `<!--ec:block ... -->` の画像 | **対象外**（Guard G9 と衝突するため手動管理のまま） |

根拠（コード）:

```ts
// src/client/portable-text.ts  — 行全体が画像のときだけ image block を生成
const IMAGE_PATTERN = /^!\[([^\]]*)\]\(([^)]+)\)$/;
```

`IMAGE_PATTERN` は行頭/行末アンカーを持つため、段落内画像は image block 化されず、
置換パイプラインが届かない。G5 側の検出は行内も拾うため、**検出できるが置換できない**
という不整合を §3.4 の明示拒否で閉じる。

### 3.5 昇格後のファイル命名（現行 `pullMedia` と完全一致）

```ts
// src/sync/media.ts 既存実装（変更不要）
const baseName = `${datePrefix}${item.id}-${sanitizedBase}`;   // datePrefix は "YYYYMMDD_" を含む
```

- `media/drafts/` は prune 対象外（`pullMedia` の `readdirSync(mediaDir)` は非再帰）→ 昇格前の下書き安全
- 昇格後は prune 正規表現 `^\d{8}_` + `[0-9A-Z]{26}` に適合

### 3.6 冪等性と重複検知の 2 層分離

| 層 | キー | 送信先 |
|---|---|---|
| サーバー dedup | `contentHash`（サーバー規約 `sha1:<hex>`）+ `deduplicate: true` | API |
| Emit ローカル dedup | SHA-256（Emit 専用） | `media_state.local_hash`（API には送らない） |

**冪等性の主軸は本文書き換えそのもの**である。push 成功後、Markdown はもはや draft path を
含まないため、再 push で再アップロードは起きない。`media_state` が必要になるのは
「アップロード成功 → 記事 PUT 失敗」の窓に限られる。

### 3.7 新設テーブル `media_state`（`src/db/cache.ts`）

現行テーブルは `entries` / `base_snapshots` / `sync_state` / `bylines` の 4 つであり、
**メディア用テーブルは存在しない**。本機能には以下が必要：

```sql
CREATE TABLE IF NOT EXISTS media_state (
  local_hash     TEXT PRIMARY KEY,   -- SHA-256（Emit 専用ローカルキー）
  media_id       TEXT NOT NULL,      -- featuredImage 用
  storage_key    TEXT NOT NULL,      -- 本文 URL 用
  url            TEXT NOT NULL,      -- ルート相対正規形
  workspace_path TEXT,               -- media/<yyyyMMdd>_<id>-<name>.<ext>
  status         TEXT NOT NULL,      -- pending | ready | failed | uploaded
  uploaded_at    INTEGER
);
```

併せて `pullMedia` が書き出す YAML に **`storageKey` / `contentHash` / `status` を保存**する
変更が必須（現行 YAML は `id, filename, mimeType, size, width, height, alt, caption, url, createdAt`
のみで、これらを破棄している）。これが無いと「同一画像の再アップロード防止」が成立しない。

`saveMediaState()` の upsert は `ON CONFLICT(local_hash) DO UPDATE` を使い、`workspace_path` は
`COALESCE(excluded.workspace_path, media_state.workspace_path)` で更新する（R-5）。
すなわち **昇格済みパスは upsert では決して消えない**（dedup 検知時の再 upsert がパスを持たない場合でも保持）。
パスやレコードの除去は `deleteMediaState(local_hash)` でのみ行う（リモート 404 検知時の stale purge もこれを用いる）。

---

## 4. 補償トランザクション（サーバー側の不可逆操作に対する安全原則）

初版計画 §5 の安全原則は「ユーザーのローカル Markdown / 画像が絶対に消失しない」ことを論じたが、
**危険側はサーバーである**（§2.4）。本番メディアライブラリに孤発 pending を残さない。

### 4.1 失敗経路と処理

```text
記事排他ロック（withEntryLock）取得失敗 → 画像アップロード（P2/P3）より前にロックを取得するため、メディア資源は一切作成されず安全に中断（B-3）
Phase A 失敗                             → 作成済み資源なし。記事 PUT しない。ローカル無変更。
Phase A 成功（mediaId 確保）以降の全失敗経路:
  1. GET /_emdash/api/media/{mediaId} で status を読む
  2. status が pending / failed          → DELETE /_emdash/api/media/{mediaId}
  3. DELETE 失敗                         → media_state に status='failed' + mediaId を保持し、
                                           CLI 出力で手動対応（admin 削除）を提示
  4. status が ready（アップロード成功後、記事 PUT 失敗または 3-Way Merge 競合中断）→ §4.2 の窓処理
  5. 記事 PUT 成功後のローカル昇格（P6）失敗 → try/catch で捕捉し warnings に降格（C-2）。
                                           記事の saveBaseSnapshot / saveSyncState は必ず完遂し、
                                           media_state は status='uploaded' を維持
```

### 4.2 「アップロード成功 → 記事 PUT 失敗 / 3-Way Merge 競合中断」の窓

```text
状態: media は ready、本文は P4 でリモート URL へ置換済み（P4 済み / P5 失敗または競合中断）
処理: media_state に status='uploaded' + local_hash → mediaId / storage_key / url を保持
      3-Way Merge 競合中断時は競合マーカー付き Markdown 内に置換済み URL が保存され、
      次 push 時は GET /_emdash/api/media/{mediaId} でリモート存在性（status=='ready'）を 1 回検証した上で（B-4）、
      再アップロードせず記事 PUT のみ実行する。
      また、1 記事目で昇格済みの draft 画像を 2 記事目が同じ media/drafts/<name> パスで参照した場合は、
      media_state / media/*.yaml から昇格済みレコードを解決して再利用する（P1）。
```

### 4.3 ロールバック順序

```text
失敗検知 → アップロード取り消し → confirm 取り消し → 本文無変更維持 → 記事 PUT 中止
```

- **本文書き換えは confirm 成功後にのみ行う**ため、confirm 前失敗では Markdown は無変更。
- 昇格（P6）は記事 PUT/POST（P5）成功後に行う。P5 失敗時は `media/drafts/` に画像が残る。
  → 「画像が無いのに本文が指す」状態も「本文が指さないのに画像が消える」状態も発生しない。
- **ローカル画像を絶対に削除しない**。昇格は move であり、失敗時は原位置に残す。

### 4.4 昇格済み資産の再利用とリモート存在性検証（R-1 / R-2）

```text
再利用経路（P1 の記事横断再利用、および media_state 短絡 B-4）は必ず GET /_emdash/api/media/{mediaId} を 1 回通す
  exists: true    → 検証済み。remote が返す storageKey / url があればそれを優先して本文に焼き付ける
  exists: false   → PROMOTED_MEDIA_NOT_FOUND_REMOTE で push を中止し、stale な media_state を purge
                    （無断で再アップロードしない。admin 側で復元 → emit pull-media、
                     もしくは media/drafts/ へ再配置して再 push するのが復旧手順）
  exists: unknown → 再利用は継続するが [MEDIA_EXISTENCE_UNVERIFIED] を warnings に出力
                    （GET 非実装 / 5xx のサーバーでは存在性検証が働かないことをユーザーに明示）
```

**昇格ファイル名の暫定性（R-4）**: 通常アップロードの confirm 応答に `createdAt` が含まれない場合、Emit はローカル日時で `media/<yyyyMMdd>_<mediaId>-<name>` に昇格する。以降の push で dedup 検知時に GET が実 `createdAt` を取得すれば canonical 名へ寄せられ、`emit pull-media` が remote の `createdAt` を権威として最終 canonical 化し、`cleanupDuplicateMediaFilesForId` が同一 mediaId の日付違い重複を掃除する。これは自己修復的な rename でありデータ消失ではなく、掃除対象は `mediaId` 厳密一致のファイルのみで `media/drafts/` には一切触れない。



---

## 5. 実装フェーズ

| Phase | 内容 | 完了条件 |
|---|---|---|
| **0（追加必須）** | 実測 spike（§7） | §7 の 4 問すべてに実測回答（✅ 完了・テスト用レコード削除済み） |
| **1** | `media_state` テーブル移行 + `pullMedia` YAML 拡張（`storageKey` / `contentHash` / `status`） | `tests/media.test.ts` に新規 fixture 緑。既存 prune 不変（✅ 完了） |
| **2** | `src/client/media.ts` 新設（§3.3 の 4 段フロー + §4 の補償） | 単体テストで応答 A / 応答 B / 同一原点分岐 / 期限切れ再取得 / 孤発掃除を検証（✅ 完了） |
| **3** | Guard G11（`LOCAL_IMAGE_AUTO_UPLOAD`）+ §3.4 の解析範囲 | 行頭 standalone / 段落内拒否 / opaque fence 対象外 / 正規リモート無変換 の 4 ケース（✅ 完了） |
| **4** | パイプライン統合（push.ts の P1..P6）+ 昇格 | e2e テスト（モックサーバーで §3.2 全順序と失敗注入）（✅ 完了） |
| **5** | ドキュメント整合（§6） | README / AGENTS.md / MCP instructions 一致（✅ 完了） |

**Phase 0 を飛ばして Phase 2 に進んではいけない。** 前回 `featured_image` の `[object Object]` 事故は
「モックが実契約と違う形状だったため全テスト緑のまま本番で壊れた」事故であり、
同一類型の失敗を §3.3 の契約差し替えで回避する設計になっている。テスト fixture は
**実応答の写し**から作成すること（§9）。

---

## 6. ドキュメント・ガードへの影響

| 対象 | 変更 |
|---|---|
| `AGENTS.md` §6（Never invent media IDs） | **ID 空間 2 系統**を明記：`featuredImage` = media record id / 本文 URL = storageKey 由来。ここが本文書と AGENTS.md の最重要整合点 |
| `AGENTS.md` §4（Guardrails） | G5 の位置づけ変更（拒否 → 自動同期の発火点）と G11 追加、G9 との境界を記述 |
| `README.md` §Preflight Guardrails 表 | G5 記述更新 + G11 行追加（G1–G9 → G1–G11） |
| `README.md` §Media Management | 「アップロードは EmDash Admin / EmDash MCP のみ」記述を、Emit 自動アップロードありへ改訂 |
| `README.md` §Non-Goals | §1.3 の整合表を反映（archiver ではない旨は変更しない） |
| `README.md` 推奨 `.gitignore` | **メディアがマスターになる**ため、`media/` を git 追跡するか明示する節を追加。現状の「任意で除外」推奨は Local-First と緊張する |
| MCP `EMIT_MCP_INSTRUCTIONS` | 画像参照の書き方（行頭 standalone / draft path）を追記 |
| `emit status` / `sync_status` | メディアは追跡対象外（`status.ts` は `['draft','published']` の `.md` のみ）。メディア未同期状態を出すなら `media_state` を読む専用表示設計が別途必要 |

---

## 7. 未確定事項（Phase 0 で確定済み）

| # | 問い | 確定方法 | 実測結果（2026-11-07 Phase 0 Spike） |
|---|---|---|---|
| 1 | `upload-url` の応答は signed か same-origin か | 実環境で tiny ファイル（70-byte 1×1 PNG）を 4 段フローで流し、完了後に DELETE して確認 | **同一原点 streaming**: `uploadUrl: "/_emdash/api/media/{id}/upload"`, `method: "PUT"`, `headers: { "Content-Type": "image/png", "X-EmDash-Request": "1" }`。さらに **`confirm` 実行時に `storageKey` が単一 ULID から 2 連 ULID（`<ulid1>.<ulid2>.<ext>`）へ更新される**ことが判明 |
| 2 | `contentHash` はクライアント送信値で dedup が成立するか、サーバー算出のみか | 同一 bytes で 2 回 `deduplicate: true` を送り `existing: true` が返るか | **`sha1:<hex>` プレフィックス付き送信でサーバー側 dedup 成立**: `{ existing: true, mediaId, storageKey, url }`（HTTP 200）。プレフィックス無し生 hex ではヒットせず新規 pending が作成された |
| 3 | `maxUploadSize` の実測値 | 応答 or admin 設定から取得。G11 の事前サイズガードに使用 | `GET /_emdash/api/settings` の `media.maxUploadSize` = **`52428800`（50 MiB）** |
| 4 | 段落内画像を拒否するか opaque block 内置換にするか | §3.4 の方針（拒否）で Phase 3 を実装し、実運用で不便が出れば再判断 | §3.4 のとおり段落内ローカル画像は `INLINE_LOCAL_IMAGE_NOT_SUPPORTED` で明示拒否し、行頭 standalone 化を案内 |

> [!NOTE]
> Phase 0 spike で作成されたテスト用レコード 2 件（`01M6TF1XXBS2KC9EVYG6RBT0J0` および `01M6TF1Z3XYSYECNK0KJ0W9H0V`）は、検証直後に `DELETE /_emdash/api/media/{id}`（HTTP 200）で完全削除し、`GET` が HTTP 404 を返すことを確認済みである。

---

## 8. 初版計画書との差分サマリー

| # | 初版の記述 | 実測 | 判定 | 本書での反映 |
|---|---|---|---|---|
| P0-1 | 本文 URL に新規取得 media id を使用 | record id は **404**。file ルートの鍵は `storageKey` 由来 | 🚨 致命 | §2.1 / §3.3 Phase C |
| P0-2 | 応答 `{ uploadUrl, storageKey, id, deduplicated? }` | `MediaUploadUrlResponse{ uploadUrl, method, headers, mediaId, storageKey, expiresAt }` / 重複は `MediaExistingResponse{ existing: true, ... }` | 🚨 致命 | §2.2 |
| P0-3 | 完了を `POST /_emdash/api/media` で行う | 3 段フロー（upload-url → upload → **confirm**）。multipart 経路は別物 | 🚨 致命（二重登録） | §3.3 + WARNING |
| P0-4 | サーバー側ロールバック未定義 | `pending / failed` 孤発 + 削除不可 | 🚨 致命 | §2.4 / §4 |
| P1-5 | SHA-256 で dedup | サーバー保存値は `sha1:<hex>` | ⚠️ | §2.6 / §3.6 の 2 層分離 |
| P1-6 | 画像参照なら均一に置換可能 | `IMAGE_PATTERN` は行全体アンカー。段落内は image block 化されない | ⚠️ | §3.4 |
| P1-7 | 「cache.db を更新」 | メディア用テーブル 4 つの中に存在しない | ⚠️ | §3.7 |
| P2-8 | signed URL を主経路 | R2 binding は signed 非対応の可能性 | 🔧 | §2.5 |
| P2-9 | HEAD `2ed59f2` / v0.1.7 | HEAD `df033b0` / v0.1.7（24 files・142 tests 緑） | 🔧 | 冒頭ヘッダ |
| P2-10 | Local-First と言いつつ git 方針なし | README 推奨 `.gitignore` は `media/*.jpg` 除外を任意推奨 | 🔧 | §6 |
| P2-11 | status 系で未同期を検知 | `status.ts` は `.md` のみ走査 | 🔧 | §6 最終行 |
| P2-12 | `GET /media/{id}?includeUsage=true` | 単一 item では **400**。`/media/{id}/usage` が正しい | 🔧 | §2.2 |
| P2-13 | URL 表現は単一 | `pullMedia` は YAML へ絶対 URL、本文はルート相対 | 🔧 | §2.7 |

**変更なしと確認した初版の設計**（そのまま維持）:

- 本文 URL の正規形 = ルート相対 `/_emdash/api/media/file/...`（実測 475 件 / 0 件、公式 docs 一致）
- 昇格後命名 `<yyyyMMdd>_<ULID>-<name>.<ext>`（現行 `pullMedia` と完全一致）
- 原子性の方向（アップロード → 本文置換 → 記事送信）と「ローカル Markdown を絶対に壊さない」原則

---

## 9. エビデンス付き録（再現手順）

すべて読み取り専用リクエストのみ実行。書き込み系（`POST upload-url` 等）は §7 の承認取得まで実行していない。

```bash
# OpenAPI 仕様の取得（title: "EmDash CMS API", openapi 3.1.0）
curl -s -o /tmp/openapi.json -w 'http:%{http_code} size:%{size_download}\n' \
  https://aroooy.net/_emdash/api/openapi.json

# ID 空間の実証（同一レコードで storageKey 由来は 200、record id は 404）
curl -sI https://aroooy.net/_emdash/api/media/file/01M67P07X2VPW0MYRRRGMA6T5A.jpg | head -3
curl -sI https://aroooy.net/_emdash/api/media/file/01M67P08DXFTYDPFRTJCC4XMP8.jpg | head -3

# 単一 item 詳細（url フィールド不在・contentHash=sha1:…, status=ready を確認）
curl -s https://aroooy.net/_emdash/api/media/01M67P08DXFTYDPFRTJCC4XMP8

# 使用箇所照会（?includeUsage=true は 400、/usage が正しい）
curl -s -o /dev/null -w 'includeUsage:%{http_code}\n' \
  'https://aroooy.net/_emdash/api/media/01M67P08DXFTYDPFRTJCC4XMP8?includeUsage=true'
curl -s -o /dev/null -w 'usage:%{http_code}\n' \
  https://aroooy.net/_emdash/api/media/01M67P08DXFTYDPFRTJCC4XMP8/usage
```

実ワークスペース（`/Volumes/ext/github/emdash.aroooy.net`）:

```bash
ls media/ | wc -l                                       # 60 ファイル（YAML + バイナリ）
grep -ro '_emdash/api/media/file/[0-9A-Z]\{26\}\.[a-z0-9]*' posts/ | wc -l   # 475
grep -rn 'https://aroooy.net/_emdash/api/media/' posts/ | wc -l              # 0
```

現行 Emit コード上の根拠:

| 主張 | 位置 |
|---|---|
| 行全体が画像のときだけ image block | `src/client/portable-text.ts` `IMAGE_PATTERN = /^!\[([^\]]*)\]\(([^)]+)\)$/` |
| G5 は行内画像も検出 | `src/sync/preflight.ts` `LOCAL_IMAGE_REGEX`（`(?!https?:\/\/\|data:\|\/_emdash\/api\/media\/file\/)`） |
| 昇格後命名規則 | `src/sync/media.ts` `const baseName = \`${datePrefix}${item.id}-${sanitizedBase}\`` |
| YAML は絶対 URL 化 | `src/sync/media.ts` `new URL(item.url, options.origin)` |
| メディア用テーブル無し | `src/db/cache.ts`（`entries` / `base_snapshots` / `sync_state` / `bylines` の 4 つ） |
| YAML に storageKey 等が無い | `push.ts` コメント「Local media/*.yaml is never a payload source: it lacks meta.storageKey」 |
| status は記事のみ | `src/sync/status.ts`（`['draft','published']` の `.md` のみ） |

公式ドキュメント:

- `/deployment/storage/` — signed upload 対応/非対応 adapter、`/_emdash/api/media/file/` ルート維持
- `/guides/media-library/` — *Media deletion has no Trash and cannot be undone.*
- `/reference/rest-api/` — メディア操作一覧

---

## 10. 実装開始の前提条件（チェックリスト）

- [x] §7 の 4 問に対する実測回答が得られている（Phase 0 spike 承認・実施・クリーンアップ済み）
- [x] `media_state` スキーマ移行が `src/db/cache.ts` にはいっている（Phase 1）
- [x] `pullMedia` の YAML に `storageKey` / `contentHash` / `status` が保存されている（Phase 1）
- [x] テスト fixture が実応答の写しから作成されている（モック手写設計をやめる）
- [x] `AGENTS.md` §6 に ID 空間 2 系統が記述されている（Phase 5）

**最優先整合点**: §2.1 の ID 空間分離。ここが未確定のまま Phase 2 に進むと、
全テスト緑のまま本番で画像が全滅する（前回 `featured_image` 事故と同一類型）。

