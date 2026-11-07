# NPM 公開および配布・利用ガイドライン

本書は、`emdash-emit`（CLI / MCP コマンド名: `emit`）を npm レジストリへ公開（Publish）する手順、CI/CD やローカルでのバージョン管理、およびエンドユーザー（人間・AI・MCPクライアント）による利用方法をまとめた技術仕様書です。

---

## 1. パッケージ概要

| 項目 | 設定値 / 説明 |
|---|---|
| **npm パッケージ名** | `emdash-emit` |
| **CLI 実行コマンド** | `emit` |
| **MCP サーバー名** | `emit`（起動引数: `emit mcp` または `npx -y emdash-emit mcp`） |
| **レジストリ** | npm Public Registry (`https://registry.npmjs.org/`) |
| **アクセス設定** | Public (`--access public`) |
| **モジュール形式** | Node.js ESM (`"type": "module"`) |
| **対応 Node.js バージョン** | `>=22.0.0` |

---

## 2. 配布物の構成仕様（ホワイトリスト方式）

`package.json` の `"files"` フィールドにより、パッケージサイズ最小化および機密・テストファイルの漏洩防止を行っています。

```json
"files": [
  "dist",
  "README.md"
]
```

### 同梱されるもの
- `dist/`: TypeScript のコンパイル成果物（JS、型定義 `.d.ts`、ソースマップ `.map`）
  - `dist/bin/emit.js`: CLI エントリポイント（シバン `#!/usr/bin/env node` 付き）
  - `dist/mcp/server.js`: MCP サーバー本体
  - `dist/index.js`: ライブラリとしてのプログラマブル API エントリポイント
- `README.md`: npm パッケージページに表示される説明書
- `package.json`: 依存関係およびメタデータ定義

### 自動除外されるもの
- `src/`（TypeScript 原本ソース）
- `tests/`（Vitest テストコード・フィクスチャ）
- `.git/`, `.gitignore`, `tsconfig.json`, `vitest.config.ts`, `.prettierrc.json`
- 開発用ドキュメント（`AGENTS.md`, `docs/` など）

---

## 3. リリース・公開手順（Publish Workflow）

### 3.1. 事前準備（初回のみ）

npm アカウントのログイン状態を確認します。

```bash
# ログイン確認
npm whoami

# 未ログインの場合はログインを実行
npm login
```

### 3.2. 事前検証（Dry Run）

公開直前に、型検査・全テストの実行とパッケージ内容のシミュレーションを行います。

```bash
# 1. 型検査
npm run typecheck

# 2. 単体・結合テスト（全 73 件以上 PASS すること）
npm test

# 3. パッケージング内容のシミュレーション（ファイル一覧とサイズ確認）
npm pack --dry-run
```

> [!NOTE]
> `package.json` に `"prepack": "npm run build"` が設定されているため、`npm pack` や `npm publish` を実行すると**自動的に最新のビルドが実行されます**。手動ビルドのし忘れによる古い成果物の公開リスクはありません。

### 3.3. バージョニング

セマンティックバージョニング（SemVer: `MAJOR.MINOR.PATCH`）に従ってバージョンを更新します。

```bash
# パッチ修正（バグ修正・軽微な改善）: 0.1.0 -> 0.1.1
npm version patch

# マイナーバージョン（新機能追加・後方互換あり）: 0.1.0 -> 0.2.0
npm version minor

# メジャーバージョン（破壊的変更あり）: 0.1.0 -> 1.0.0
npm version major
```
※ `npm version` コマンドにより、`package.json` のバージョン書き換えと Git コミット・タグ作成が自動で行われます。

### 3.4. 公開実行（Publish）

```bash
# パブリックパッケージとして公開
npm publish --access public
```

二要素認証（2FA / TOTP）が有効な場合は、プロンプトに従って認証コードを入力します。

### 3.5. Git タグのプッシュ

```bash
git push origin main --tags
```

---

## 4. エンドユーザーの利用手順

公開されたパッケージは、用途（ターミナル利用、ワンタイム利用、MCP連携）に応じて以下の方法で利用できます。

### 4.1. グローバルインストール（推奨・定常利用）

日常的にターミナルから操作するユーザー向けの方法です。

```bash
# グローバルインストール
npm install -g emdash-emit

# インストール確認
emit --version
emit --help
```

- **実行コマンド**: `emit`（パッケージ名は `emdash-emit` ですが、コマンド名は `emit` で登録されます）。
- **アップデート**: `npm update -g emdash-emit`

### 4.2. npx による即時実行（インストール不要）

事前のインストールを行わず、常に最新版を一時実行したい場合です。

```bash
# ワンライナー実行
npx emdash-emit status
npx emdash-emit pull
```

---

## 5. MCP サーバーとしての設定手順

Claude Desktop や Antigravity 等の MCP クライアントから `emit` を呼び出す設定方法です。

### パターン A: グローバルインストール済みの場合（高速起動）
設定ファイル（例: `~/.gemini/config/mcp_config.json` や Claude Desktop の設定）に以下を記述します。

```json
{
  "mcpServers": {
    "emit": {
      "command": "emit",
      "args": ["mcp"]
    }
  }
}
```

### パターン B: npx 経由で起動する場合（インストール不要・ポータブル）
マシンへの事前インストールなしで、設定ファイルのみで動作させたい場合です。

```json
{
  "mcpServers": {
    "emit": {
      "command": "npx",
      "args": ["-y", "emdash-emit", "mcp"]
    }
  }
}
```

---

## 6. プロファイルと認証の初期セットアップ

ユーザーが初めて `emit` を利用する際の手順です。

```bash
# 1. サイトプロファイルの追加（複数サイト対応）
emit profile add <profile-name> \
  --origin https://your-site.com \
  --workspace /path/to/local/workspace

# 2. 認証トークンの設定（4段階の優先順位で解決されます）
#   (1) 環境変数 EMDASH_TOKEN / EMDASH_API_TOKEN（最優先）
#   (2) ~/.config/emit/profiles.yaml（上記 profile add 時に --token を指定した場合）
#   (3) ~/.config/emdash/auth.json（プロファイルにトークン未登録で EmDash CLI ログイン済みの場合、refreshToken による自動更新対応）
#   (4) ~/.config/emit/credentials.json

# 3. ワークスペースの初期同期（バッチモードの emit pull は記事＋カテゴリ・タグを同時同期）
cd /path/to/local/workspace
emit pull
emit pull-media
```

---

## 7. トラブルシューティング（公開・運用時）

### Q1: `npm publish` 時に `E403 Forbidden` または `404 Not Found` が発生する
- `npm whoami` で正しいアカウントにログインしているか確認してください。
- 初回公開時はスコープなしパッケージの場合 `--access public` の付与が必須です。

### Q2: 誤って公開したバージョンを取り消したい
- 公開後 **72時間以内** かつ依存関係が少ない場合に限り `npm unpublish emdash-emit@x.y.z` が可能です。
- 通常はアンパブリッシュせず、バグ修正後にバージョンをインクリメント（`npm version patch`）して再公開することが推奨されます。

