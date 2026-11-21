# emdash-emit v0.1.12 — Black-box Evaluation (third-party view)

## 評価憲章（this pass の制約）
- 観測対象は **公開インターフェースのみ**:
  - `emit` CLI の stdout/stderr と exit code
  - `https://aroooy.net/_emdash/api/*` のリクエスト/レスポンス（観測用に直接呼出し）
  - `~/.config/emit/mcp_state.json`, `.emit/cache.db`（sqlite 読取）, ワークスペースのファイルツリー
  - MCP `tools/list` / `tools/call` の JSON
- **ソース（TS リポジトリ）は参照しない**。ビルド済み npm dist を過去通読した経緯があるため、
  本レポートの結論は CLI/API/FS から再導出できる証跡で裏取りする方針（下記 "Evidence class" 参照）。
- 変更操作は検証用記事 1 本（ULID 01M6ZV6KMF2HXHCYCGMJV1D24X、検証後に削除済み）と
  `conflict-test-sandbox`（ULID 01M6FBAJ2JKNX8VAYXXASYSFGA）に限定。既存 168 記事は digest で不変を確認済み。

## 環境
- emdash-emit 0.1.12（npm global, 2026-11-09 18:40:18 JST install）/ Node v26.3.1 / linux (Raspberry Pi 5)
- ワークスペース `/home/hiroaki/src/aroooy.net`（169 記事: published 100 / draft 69）
- origin https://aroooy.net（Cloudflare Workers + D1 / EmDash）
- 2台目 Device: `/tmp/ws_b`（同一 origin の別ワークスペース）/ 旧版 fixture: `/tmp/ws_old`

## Evidence class（各 issue に付記）
| クラス | 意味 |
|---|---|
| `[OBS]` | CLI/API/FS からの直接観測（ログファイル・コマンドで再現可能） |
| `[INF]` | 観測パターンからの推論（追加の実験で確定が必要） |
| `[INT]` | 過去通読したビルド済み dist の知識（第三者評価では証跡として使わない） |

## Severity
| S | 基準 |
|---|---|
| S1 | 利用者データが警告なしに失われる／台帳（baseline）が remote の事実と食い違う |
| S2 | 回復に手作業（DB 直編集等）が必要／運用が続けづらくなる |
| S3 | 表示・一貫性・利便性の欠落（文書化済みの機能が未実装など） |

## 証跡インデックス
| ファイル | 内容 |
|---|---|
| `/tmp/all.log` | Phase 4 wipe guard（159–182 行）, Phase 3 delete-pending guard（187–200 行）, Phase 2 delete E2E |
| `/tmp/flags.log` | `TAXONOMY_CONFLICT_PENDING`（19 行）, `Skipped 1 article(s) with pending flags`（10 行）, `--revive` |
| `/tmp/wsBpush.txt` | taxonomy 割当 POST 失敗（6–7 行 `Term ID ... not found`） |
| `/tmp/final.log`, `/tmp/restore.log`, `/tmp/cleanup.log` | 169 記事の行レベル SHA256 digest（移行前後・テスト前後で同一） |
| `/tmp/pull1.log`, `/tmp/media.log`, `/tmp/mcp_run.log` | 169 記事一括 pull の冪等性, doctor の media 2段階判定, MCP tools/list |
| `/tmp/api_get.mjs`, `/tmp/api_probe.mjs`, `/tmp/tax_audit.mjs`, `/tmp/tax_compare.mjs`, `/tmp/remote_check.sh` | out-of-band API 観測（entry `_rev` と terms の比較） |
| `/tmp/digest.js` | `.emit/cache.db` のテーブル別 digest 算出（データ保持証明） |
| `/tmp/t_a.sh`, `/tmp/t_all.sh`, `/tmp/t_bc.sh`, `/tmp/t_final.sh`, `/tmp/t_flags.sh`, `/tmp/t_cleanup*.sh`, `/tmp/t_restore2.sh` | 再現手順スクリプト |

## 成果物
- `issues.md` — 起票用 issue pack（S1×2 / S2×4 / S3×1）
- `fix-spec-taxonomy.md` — ソース非参照の「修正仕様書」（観測可能な contract と受け入れテスト）
- `test-matrix-taxonomy.md` — Phase 4 union マトリクス（2026-11-09 に本番 arooy.net で実施済み・結果追記）
- `logs/` — 実行ログ（`00_setup_push2.log`, `01_state_after_setup.log`, `T1_T4.log`, `T5_T9.log`, `T12.log`, `T12_3.log`, `T10_cleanup.log`, `baseline_compare.txt`）

## 使用した公開契約（ソース非参照の裏取り）
- `GET /_emdash/api/openapi.json`（EmDash 自身の OpenAPI 3.1, 338KB）で以下を確認:
  - `ContentTermsBody = { termIds: string[] }` → terms 差し替えに **並行制御トークン（If-Match 等）が存在しない**
  - `TaxonomyDef` に `exclusive` 相当フィールドなし（文中の `exclusive` 9 回は全て `exclusiveMinimum`）
  - taxonomy 定義の **作成用 POST は無い**（`/taxonomies` は get、`/taxonomies/{name}` は get/put/delete）
  - 用語作成は `POST /_emdash/api/taxonomies/{name}/terms`（`CreateTermBody {slug,label,parentId}`）
- entry の並行制御は `version` + `updatedAt`（emit の `remote_rev` は `base64("<version>:<updatedAt>")`）

