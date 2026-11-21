# Emit Documentation Index

Emit (`emdash-emit`) の公式ドキュメント・詳細設計書・過去計画書アーカイブの総合索引です。現在の実装仕様の正典（Single Source of Truth）は「1. 境界別 正典仕様書・リファレンス」に定義されています。

---

## 1. 境界別 正典仕様書・リファレンス（Authoritative Specifications）

`AGENTS.md` および `README.md` から参照され、現在のシステムアーキテクチャ、ドメイン境界、データモデル、安全ガード、コマンド仕様を定義する正典ドキュメント群です。

| # | ドキュメント | 対象ドメイン・プログラム境界 | 主な収録内容 |
| --- | --- | --- | --- |
| 1 | **[architecture-and-layers.md](./architecture-and-layers.md)** | **全体アーキテクチャ・4層境界・基盤**<br>(`src/utils/`, `src/db/`, `src/client/`, `src/sync/workspace/`, `src/cli/`, `src/mcp/`, `src/presentation/`) | 4層レイヤリングと静的検証（Axis 0〜5）、Workspace Contracts、Profile / Auth (4段階 + OAuth refresh) / Origin 解決優先順位、SQLite `cache.db` 全5テーブル定義、CLI/MCP 表示・エラー整形対称性、Testing & QA |
| 2 | **[sync-engine-and-revisions.md](./sync-engine-and-revisions.md)** | **同期エンジン・Revision・競合解決**<br>(`src/sync/orchestrator.ts`, `src/sync/pull/*`, `src/sync/push/*`, `src/sync/merge.ts`, `src/sync/conflicts.ts`, `src/sync/delete.ts`) | Orchestrator Facades (`pullBatch`, `pullSingleArticle`)、Pull 6ステージ＆Fast-path自己修復、Push 10モジュール、Two-Track Revision (Transport vs Comparison)、未公開ドラフト (`published*`)、分散ロック、3-Way Merge、`posts/conflicts/` 隔離と脱出ルート |
| 3 | **[markdown-and-ast.md](./markdown-and-ast.md)** | **Markdown・Frontmatter・AST変換**<br>(`src/utils/frontmatter.ts`, `src/utils/disk-spelling.ts`, `src/client/portable-text.ts`, `src/sync/baseline-reconstruction.ts`) | Frontmatter Zodスキーマ、`parseMarkdownLenient` 2段階パース、YAMLクォート規約 (`formatYamlScalar`)、ベースライン再構築 (`reconstructBaseline`)、Portable Text ⇔ Markdown 変換、Dual-Track Image Model（Tier 1 vs Tier 3 `<!--ec:block ... -->` 保護） |
| 4 | **[media-pipeline.md](./media-pipeline.md)** | **Local-First メディアパイプライン**<br>(`src/sync/media/*`, `src/sync/preflight/image_probe.ts`, `src/utils/media-*.ts`) | `media/drafts/` 自動アップロードと昇格・再利用、`localMediaRefs` 相対パス変換とベースライン正規URL保持、`storageKeyToMarkdownRef` ミラー命名と衝突回避、コンパニオンYAML所有権とリモート権威ベースのPruning |
| 5 | **[media-id-spaces.md](./media-id-spaces.md)** | **二重メディア識別子空間仕様**<br>*(AGENTS.md 指定の最重要仕様書)* | D1 media record `id` と R2 `storageKey` の分離仕様、エンドポイント別受付マトリクス、移行データセットの挙動、`verifiedStorageKeys` / `orphanStorageKeys` の解決順序 |
| 6 | **[taxonomies-and-bylines.md](./taxonomies-and-bylines.md)** | **タクソノミー二層表現・著者管理**<br>(`src/sync/taxonomies.ts`, `src/sync/terms.ts`, `src/sync/bylines.ts`, `src/utils/taxonomy-*.ts`) | Two-Layer Representation（Layer A パーセントエンコード ⇔ Layer B デコード表示）、スラッグ衝突解決、0-GET 削除ターム自動自己修復、Pre-PUT Remote Audit と G19 Wipe Guard、Bylines 同期 |
| 7 | **[safety-guards-and-diagnostics.md](./safety-guards-and-diagnostics.md)** | **安全ガード G1〜G19・診断・検索・FAQ**<br>(`src/sync/guards.ts`, `src/sync/preflight.ts`, `src/sync/doctor.ts`, `src/sync/article_search/*`) | Guard Registry (G1〜G19) 完全一覧と静的検証 Rules 1〜5、`emit doctor` 6検査ベクトルとオフライン原則、`article-search` / `media-search` の認識論的ルール (`[WALK_INCOMPLETE]`)、Troubleshooting & FAQ |
| 8 | **[cli-and-mcp-reference.md](./cli-and-mcp-reference.md)** | **CLI コマンド & MCP ツール完全リファレンス**<br>(`src/bin/emit.ts`, `src/cli/commands/*`, `src/mcp/tools/*`) | 全 16 Top-level CLI コマンド（＋10 サブコマンド）および全 14 MCP ツールの全オプション、パラメータスキーマ、出力例 |
| 9 | **[npm-publish-guide.md](./npm-publish-guide.md)** | **パッケージ公開・リリース運用手順** | npm パッケージビルド、品質ゲート検証、公開・バージョニング手順 |

---

## 2. バージョン別 実装計画書・評価アーカイブ（`docs/plans/`）

各リリースごとの設計、レビュー、検証記録のアーカイブです（SemVer ゼロ埋め `v0.1.xxx-<topic>` 形式で時系列ソート可能）。

- [v0.1.046](./plans/v0.1.046-documentation-architecture-reorg.md) — ドキュメント体系再編・境界別詳細設計書整備・README/AGENTS.md 再構成計画書
- [v0.1.045](./plans/v0.1.045-search-scanner-and-layer-convergence.md) — 検索系スキャナの収束・重複ロジックの正本化・層境界の是正
- [v0.1.044](./plans/v0.1.044-search-early-exit-and-taxonomy-fast-path.md) — 検索走査の早期終了と taxonomy フィルタ N+1 解消（ローカル・ベースライン fast-path）
- [v0.1.043](./plans/v0.1.043-article-multidimensional-search.md) — 過去記事（Posts）の多次元検索基盤（メタ属性・日付範囲・オフライン）とピンポイント取得連携
- [v0.1.042](./plans/v0.1.042-media-search-date-offline-and-prune.md) — メディア検索の拡張（日付・オフライン）・同期リミット適正化と参照保護プルーニング
- [v0.1.041](./plans/v0.1.041-draft-workflow-and-fence-diagnostics.md) — 下書き運用の明確化・コードフェンス診断・未参照メディア検知の強化
- [v0.1.040](./plans/v0.1.040-markdown-syntax-and-thematic-break.md) — Markdown 構文ギャップ解消・インライン装飾拡張・水平線（Thematic Break）ブロック変換
- [v0.1.039](./plans/v0.1.039-guide-symmetry-and-gfm-tables.md) — ガイド文案の CLI/MCP 対称化・conflicts デフォルト一覧化・GFM テーブル対応
- [v0.1.038](./plans/v0.1.038-multi-site-ux-and-set-token.md) — マルチサイト導入 UX の摩擦除去（Git 衛生・解決根拠の可視化・`set-token` 資格情報導線）
- [v0.1.037](./plans/v0.1.037-large-function-split-and-barrels.md) — 巨大関数の分割とコンシューマ境界（barrel）の収束
- [v0.1.036](./plans/v0.1.036-dual-track-image-model-and-guidance.md) — Local-First メディア解決と Tier 3 不透明ブロック保護の共存モデル（Dual-Track Image Model）確立
- [v0.1.035](./plans/v0.1.035-styled-image-opaque-fence-tier3.md) — 装飾・拡張属性付き画像ブロックの不可逆消失防止および不透明フェンス（Tier 3）フォールバック
- [v0.1.034](./plans/v0.1.034-presentation-layer-unification.md) — CLI/MCP 表示整形の集約とスタイル統一（`src/presentation/`）
- [v0.1.033](./plans/v0.1.033-static-quality-gates-and-cycles.md) — 静的品質ゲート拡充・循環依存根絶・運用ガバナンス強化
- [v0.1.032](./plans/v0.1.032-batch-pull-orchestrator-symmetry.md) — バッチ PULL の Orchestrator 集約・ドラフト初回取得是正
- [v0.1.031](./plans/v0.1.031-pruned-taxonomy-auto-healing/README.md)（および [REVIEW.md](./plans/v0.1.031-pruned-taxonomy-auto-healing/REVIEW.md)） — リモート削除タクソノミーの 0-GET 自動自己修復と G19 整合性
- [v0.1.030](./plans/v0.1.030-single-pull-orchestrator-parity.md) — 単一記事 PULL の Orchestrator 集約と対称性完成
- [v0.1.029](./plans/v0.1.029-single-pull-media-mirroring.md)（および [基本設計書](./plans/v0.1.029-local-first-media-pipeline-design.md)） — 単一記事 PULL メディア自動同時ミラーリングとローカルファーストメディアパイプライン
- [v0.1.028](./plans/v0.1.028-layer2-unmodified-and-pull-split.md) — Layer 2 未変更判定の統一・4層レイヤリング Gate 完全化・`pull.ts` モジュール分割
- [v0.1.027](./plans/v0.1.027-diagnostic-cli-output-invariants.md) — 残存重複の集約と診断・CLI 出力の不変条件構造保証
- [v0.1.026](./plans/v0.1.026-taxonomy-yaml-two-layer.md) — カテゴリ・タグ定義 YAML の Two-Layer デコード表示化
- [v0.1.025](./plans/v0.1.025-frontmatter-draft-annotation.md)（および [Backlog](./plans/v0.1.025-backlog.md)） — フロントマターにおけるドラフトリビジョンの明示（`# draft revision`）
- [v0.1.024](./plans/v0.1.024-published-draft-revision-sync.md) — 公開記事上の未公開ドラフト同期とステータス可視化（`published*`）
- [v0.1.023](./plans/v0.1.023-draft-selective-single-get.md) — 下書き更新時の選択的単体 GET フォールスルー
- [v0.1.022](./plans/v0.1.022-draft-revision-tracking.md) — ドラフトリビジョン追従と 2 トラックリビジョン判定の完全化
- [v0.1.021](./plans/v0.1.021-taxonomy-decoded-display.md) — タクソノミー日本語デコード表示＆安全マッピング
- [v0.1.020](./plans/v0.1.020-sync-new-metadata-args.md) — `emit new` / `sync_new` ワンショットメタデータ引数拡張
- [v0.1.019](./plans/v0.1.019-layering-gate-enforcement.md) — レイヤリング検証ゲート（Axis 0〜4）と `push` パイプライン分割
- [v0.1.018](./plans/v0.1.018-structured-architecture-refactor.md) — 構造化アーキテクチャリファクタリング
- [v0.1.016](./plans/v0.1.016-media-search-index/README.md) — メディア検索インデックス（`emit media-search` / `sync_media_search`）
- [v0.1.015](./plans/v0.1.015-error-codes-and-db-migration.md) — 全エラーコード網羅（Guard Registry）と DB マイグレーション語義確定
- [v0.1.014](./plans/v0.1.014-remote-sync-engine/README.md)（および [Backlog](./plans/v0.1.014-backlog.md)） — リモート同期エンジン改善計画
- [v0.1.013](./plans/v0.1.013-initial-sync-fix/README.md) — 初期同期基盤修正計画
- [v0.1.012](./plans/v0.1.012-taxonomy-blackbox-eval/README.md) — プロトタイプ第三者ブラックボックス評価記録
