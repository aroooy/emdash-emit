# Emit Documentation Index

Emit ワークスペースのドキュメント索引です。現在の実装仕様の真理（Truth）は「1. 正典仕様書」に定義されています。

## 1. 正典仕様書（Authoritative Specifications）

AGENTS.md 等から直接参照され、現在のシステム挙動、データモデル、外部連携仕様を定義する最新の正典です。

- [media-id-spaces.md](./media-id-spaces.md) — D1 record `id` と R2 `storageKey` の二重識別子空間仕様（AGENTS.md:20-22 で指定）
- [npm-publish-guide.md](./npm-publish-guide.md) — パッケージ公開およびリリース手順

## 2. 過去の設計仕様書（Historical Specifications & Backlogs）

過去の大型改修時の設計仕様書およびバックログです。

- [local-first-media-pipeline-plan.md](./local-first-media-pipeline-plan.md) — ローカルファーストメディア同期設計（v0.1.29）
- [v0114-backlog.md](./v0114-backlog.md) / [v0125-backlog.md](./v0125-backlog.md) — バックログアーカイブ

## 3. バージョン実装計画書（Historical Implementation Plans）

各リリースごとの設計、レビュー、検証記録のアーカイブです（計 21 ディレクトリ）。

- [v0.1.33 計画書](./v0133-plan/README.md) — 静的品質ゲート拡充・循環依存根絶・運用ガバナンス
- [v0.1.32 計画書](./v0132-plan/README.md) — バッチ PULL の Orchestrator 集約・ドラフト初回取得是正
- [v0.1.31 計画書](./v0131-plan/README.md) — メディア参照優先度解決・Layer 0 純関数化
- [v0.1.30 計画書](./v0130-plan/README.md) — 単一記事 PULL の Orchestrator 集約
- [v0.1.29 計画書](./v0129-plan/README.md) — ローカルファーストメディアパイプライン
- [v0.1.28 計画書](./v0128-plan/README.md) — PUSH パイプライン責務分離
- [v0.1.27 計画書](./v0127-plan/README.md) — PULL パイプライン責務分離
- [v0.1.26 計画書](./v0126-plan/README.md) — 2 階層タクソノミ表現
- [v0.1.25 計画書](./v0125-plan/README.md) — ガード不変条件・テスト整備
- [v0.1.24 計画書](./v0124-plan/README.md) — 3-way マージ競合ハンドリング
- [v0.1.23 計画書](./v0123-plan/README.md) — 2 トラックリビジョン管理
- [v0.1.22 計画書](./v0122-plan/README.md) — SQLite キャッシュ最適化
- [v0.1.21 計画書](./v0121-plan/README.md) — MCP ツール拡充
- [v0.1.20 計画書](./v0120-plan/README.md) — CLI コマンド体系統一
- [v0.1.19 計画書](./v0119-plan/README.md) — レイヤリング検証（軸 0〜4）
- [v0.1.18 計画書](./v0118-refactor-plan/README.md) — アーキテクチャリファクタリング
- [v0.1.16 計画書](./v0116-plan/README.md) — パフォーマンステューニング
- [v0.1.15 計画書](./v0115-refactor-plan/README.md) — AST 変換エンジン
- [v0.1.14 計画書](./v0114-plan/README.md) — リモート同期エンジン
- [v0.1.13 計画書](./v0113-plan/README.md) — 初期同期基盤
- [v0.1.12 評価書](./v0112-eval/README.md) — プロトタイプ評価
