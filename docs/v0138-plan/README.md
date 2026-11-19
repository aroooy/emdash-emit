# v0.1.38 計画書: マルチサイト導入 UX の摩擦除去（Git 衛生・解決根拠の可視化・資格情報導線）

- **対象バージョン**: `v0.1.38`
- **作成日**: 2026-11-19
- **ステータス**: 起案（Pending Review — Ask First カテゴリ 3 に該当する P4 の MCP ツール追加を含む。カテゴリ 1・2 は本計画で**いずれも不使用**）
- **起点**: 外部テスター要望書「Emit 機能改善・UX向上 要望書」（2026-11-19, 対象 v0.1.37）。マルチサイト並行運用・Astro サイト本体とのディレクトリ分離・新規サイト初期セットアップの実運用シナリオで発生したつまずき報告
- **目的**:
  1. **P1: 解決根拠（resolution rationale）の CLI 露出** — MCP は既に全応答へ `_meta.resolvedBy` を載せているのに、CLI `emit profile current` / `profile list` は「どの経路で解決されたか」を一切表示しない。マルチサイト運用の中心機能である「カレントディレクトリ自動解決」が CLI 側で見えないため、ユーザーが不要な `profile use` / `profile_switch` を探し、誤ったサイトを操作するリスクを残している。
  2. **P2: ワークスペース移動時の profile link ズレ検出** — プロファイルの `workspace` は絶対パス登録で、フォルダ再編後は**旧パスを優先して黙って別ディレクトリを操作する／止まる**という二択になる（§2.2 実測）。警告と自己修復手順を提示する。
  3. **P3: Git 衛生のデフォルト化** — `emit init` は `.gitignore` を生成しないため、初見ユーザーは SQLite バイナリ（`cache.db` / `-wal` / `-shm` / `.bak-*`）を素でコミットし、リポジトリ肥大とマルチ PC での DB 競合を起こす。
  4. **P4: 資格情報登録・妥当性確認導線の整備** — `profile set-token`（トークン単体更新）と `doctor --check-auth`（オプトインの認証妥当性診断）を追加し、新規サイト初期セットアップ（デプロイ → トークン発行 → 登録）の空白区間を埋める。

---

## 1. 要望書評価の要約と本計画での扱い

要望書の 5 項目を検証した結果、**前提事実が実装と食い違う箇所が 2 件**あったため、そのままではなく再定義して採用する。

| 要望 | 実測で確認できた事実 | 判定 | 本版での扱い |
| --- | --- | --- | --- |
| 1 `.gitignore` 自動生成 | README §6「Recommended `.gitignore`」は**既に存在**（308–340 行）。一方 `emit init`（`src/cli/commands/status.ts:266-312`）は `.gitignore` を一切生成しない | 前提は半分正しい／指摘自体は妥当 | **P3 として採用**。ただし生成先は `.emit/.gitignore` に限定し、ユーザーのルート `.gitignore` への自動追記は行わない |
| 2 自動解決の表示明確化 | `profile current` は解決結果を表示済み（`profile.ts:150-170`）。`resolveTargetProfile()` は `source: 'explicit' \| 'workspace' \| 'single' \| 'active'` を返す（`src/utils/profile.ts:207`）。MCP は `_meta.resolvedBy` を全応答へ載せる（`src/mcp/server.ts:176-195`） | 「何も見えない」は誤り。**CLI 側だけが遅れている**が本質 | **P1 として採用**。`emit status` への追加は行わない（§3.1 の除外理由） |
| 3 `set-token` と対話フォールバック | `emit profile add <name>` は**既に更新兼用**で、`--token` 省略時は既存 token / workspace link を保持し `Kept the existing token and workspace link` と報告する（`profile.ts:87-122`）。対話 UI 依存は src・tests 通じて**0 件** | サブコマンド追加のみ妥当。pull/status 本体への対話割り込みは方針衝突 | **P4-A `set-token` を採用**。pull/status 本体の対話フォールバックは**不採用**（§6） |
| 4 ワークスペース移動への追従 | `src/cli/context.ts:227-235` は `resolvedProf?.workspace` を **cwd より優先**して使う。よって移動後は旧パスの `.emit/` を無警告で使用する | 妥当。**深刻度は要望書の「低〜中」ではなく「高」**（黙って別ディレクトリを操作する） | **P2 として採用**。ただし対話 `[Y/n]` は使わず、警告＋`emit init` 再実行の提示に留める |
| 5 doctor 拡充（トークン妥当性／Git 除外） | doctor のリモート接触は `--check-media-urls` / `--check-media-library` のオプトインのみ。認証妥当性の専用 check は無い | トークン check は低コストで妥当。Git 除外 check は P3 で原因側を潰すため冗長 | **P4-B `--check-auth` を採用**。Git 除外 check は**不採用**（§6） |

---

## 2. 現状の実測スナップショット（2026-11-19 / v0.1.37・tag `1076393`）

すべての数値は実際のツールで計測した結果であり、推定を含まない。

| 項目 | 実測値 | 検査コマンド |
| --- | --- | --- |
| `src/` 総行数 | **25,486 行**（106 モジュール） | `find src -name '*.ts' -exec wc -l {} +` |
| 静的品質ゲート | `typecheck`（src+tests）green、循環依存 **0 件** | `npm run typecheck` / `npx --yes madge@8.0.0 --circular --extensions ts src/` |
| 非 CLI 層の `console.log` / `console.debug` | **0 件**（Axis 5 PASS） | `grep -rn 'console\.\(log\|debug\)' src \| grep -v 'src/cli/'` |
| doctor の check 登録箇所 | `checks.push()` **21 箇所** / 一意 check id **12 個**（`version_compatibility`, `origin_consistency`, `mcp_process`, `frontmatter_integrity`, `conflicts_quarantine`, `conflict_pending_autoclear`, `body_conflict_pending_manual`, `conflict_pending_manual`, `taxonomy_apply_pending`, `delete_pending`, `sync_status`, `media_references`） | `grep -n "checks.push" src/sync/doctor.ts` / `grep -o "id: '[a-z_]*'" src/sync/doctor.ts \| sort -u` |
| 対話 UI 依存（`inquirer` / `readline` / `prompts`） | src・tests 通じて **0 件** | `grep -rn 'inquirer\|readline\|prompts(' src tests` |

### 2.1 本計画が触るファイルの実測規模

| ファイル | 行数 | 本版での役割 |
| --- | --- | --- |
| `src/utils/profile.ts` | 351 | 解決根拠の Layer 0 正本（`resolveTargetProfile` の `source`） |
| `src/cli/commands/profile.ts` | 171 | P1・P4-A の実装地点（`list` / `current` / `add`） |
| `src/sync/doctor.ts` | 949 | P4-B の check 追加地点（`runEnvironmentChecks` は 269–327 行） |
| `src/cli/context.ts` | 309 | P2 の検出地点（workspace root 解決は 227–235 行） |
| `src/utils/config.ts` | 184 | P3 の `.gitignore` 生成地点（`initWorkspace` は 83–104 行） |

### 2.2 ギャップの実測根拠

#### G-1: MCP には解決根拠があるが、CLI には無い（P1）

`src/mcp/server.ts:176-189` は解決経路を 6 分類して `_meta.resolvedBy` に載せている:

```text
env → explicit-profile-argument → workspace-directory-match
    → workspace-origin-match → single-profile-fallback → auth.source
```

同じ情報を返せる Layer 0 関数（`resolveTargetProfile()` の `source`）が既に存在するのに、CLI 側はそれを捨てている。実測の CLI 出力:

- `profile current`（`profile.ts:167-169`）: `Active Profile:` / `Origin:` / `Workspace:` の 3 行のみ。**解決根拠なし**
- `profile list`（`profile.ts:63-73`）: `* <name> (active)` — ここで言う `active` は `profiles.yaml` の `active` キーにすぎず、**実際の運用では cwd 一致が常に優先される**。ラベルの語義と実挙動が食い違っており、これが「明示的に切り替えないと動かない」という誤認の直接原因である（要望書 要望2 の中核）

#### G-2: ワークスペース移動後、Emit は旧パスを黙って使う（P2）

`src/cli/context.ts:229-230`:

```ts
workspaceRoot =
  preResolvedWorkspace || resolvedProf?.workspace || auth.workspace || requireWorkspaceRoot();
```

profile の `workspace` が cwd より優先されるため、`~/src/my-blog → ~/src/workspaces/my-blog` の再編後に新側で `emit status` を実行すると:

- 旧パスが存在する → **旧 workspace の `.emit/cache.db` と `posts/` に対して動作**（無警告）
- 旧パスが存在しない → `requireWorkspaceRoot()` が throw し「not inside an Emit workspace」で停止（`context.ts:232-234`）。**移動を示唆する情報はない**

いずれの経路にも診断がなく、`emit doctor` の Check 2（`origin_consistency`, `doctor.ts:289-307`）は origin の一致しか見ておらず、**workspace パスの乖離は一切検査しない**。要望書が懸念した「設定不整合」より実害が大きい。

#### G-3: `.gitignore` 未生成によるバイナリ混入（P3）

`initWorkspace()`（`src/utils/config.ts:83-104`）は `.emit/`・`config.json`・`posts/{draft,published}` を作るだけで、`.gitignore` は作らない。生成される Git 非推奨ファイルは実在する:

| ファイル | 生成元 |
| --- | --- |
| `.emit/cache.db` | `getWorkspacePaths()`（`tests/workspace.test.ts:79` で固定） |
| `.emit/cache.db-wal` / `-shm` | SQLite WAL モード |
| `.emit/cache.db.bak-<version>-<timestamp>` | `src/db/migrations.ts:187` の `VACUUM INTO`（3 世代保持、0 バイトは掃引） |

要望書が指摘する「リポジトリ肥大」「複数 PC pull 時の DB 競合」は技術的に成立する。ただし**推奨設定の文言自体は README §6 に存在**するため、欠けているのは配布（テンプレート）であって定義ではない。

#### G-4: トークン登録・妥当性確認の導線（P4）

- 未設定時のエラーは具体的で、既に `emit profile add <name> --origin <url> --token <token>` と `EMDASH_TOKEN` を案内している（`src/cli/context.ts:202-204`）。
- トークン単体の更新手段は `profile add` に包含済みだが、**コマンド名から発見できない**。要望書の不満の実体は機能欠落ではなく命名・発見性である。
- 登録済みトークンの妥当性（失効・権限不足）を診断する項目は doctor に存在しない。`RunWorkspaceDoctorOptions` は既に `token` / `refreshToken` を受け取り（`doctor.ts:80-82`）、CLI も渡している（`src/cli/commands/doctor.ts:63-64`）。**配線は既に通っており、check 本体の追加で足りる**。

---

## 3. 施策詳細

### 3.1 P1: 解決根拠の可視化（Layer 0 ヘルパー新設 + CLI 表示）

#### 方針

表示文言を各コマンドに書かず、**Layer 0 に純粋ヘルパーを 1 つ**置く。CLI と MCP が同じ文字列生成を共有し、`emit status` は触らない。

#### 新設: `src/utils/profile-resolution.ts`（Layer 0）

```ts
export type ProfileResolutionSource =
  | 'explicit'
  | 'workspace-dir'
  | 'workspace-origin'
  | 'single'
  | 'active';

/** Layer 0 resolveTargetProfile().source を、discriminate 済みの表示用 source へ正規化する。 */
export function toResolutionSource(
  result: ResolveProfileResult,
  cwdMatched: boolean,
): ProfileResolutionSource;

/** CLI・MCP 共有の一行説明。トークンは一切含まない。 */
export function formatResolutionRationale(
  source: ProfileResolutionSource,
  opts: { profileName: string; workspacePath?: string; cwd: string },
): string;
```

- `resolveTargetProfile()` の `source` は `'workspace'` に統合されているため、**dir 一致か origin 一致かの区別は呼び出し側の `findProfileByDirectory()` 成否で決める**（`toResolutionSource()` が受け取る `cwdMatched`）。Layer 0 の公開シグネチャは変更しない。
- source 毎の文言（CLI・MCP で一字一句同一）:

| source | 表示文言 |
| --- | --- |
| `workspace-dir` | `Resolved by: current directory match (<registered workspace path>)` |
| `workspace-origin` | `Resolved by: origin match (.emit/config.json → profile "<name>")` |
| `explicit` | `Resolved by: explicit --profile "<name>"` |
| `single` | `Resolved by: only configured profile` |
| `active` | `Resolved by: active default (no directory match — cwd auto-resolution outranks this)` |

#### 適用地点

1. **`emit profile current`**（`src/cli/commands/profile.ts:150-170`）: 既存 3 行の下に rationale 行を追加。

   ```text
   Active Profile: aroooy.net
     Origin:       https://aroooy.net
     Workspace:    /Users/me/src/workspaces/aroooy.net
     Resolved by:  current directory match (/Users/me/src/workspaces/aroooy.net)
   ```

2. **`emit profile list`**（同 `50-74`）: `(active)` ラベルの語義を修正し、cwd 解決との優先順位を明記する。

   ```text
   Configured profiles (the current directory always wins; "active" is only the fallback):
     * aroooy.net (matches current directory)
         origin:    https://aroooy.net
         workspace: /Users/me/src/workspaces/aroooy.net
         token:     [configured]
     - holodeck (active default — used only outside registered workspaces)
   ```

   - `data.active` の意味を変えない（`setActiveProfile()` の永続化キーは現状維持）。**ラベル文言のみ**を修正する。
3. **MCP `_meta.resolvedBy`**（`src/mcp/server.ts:176-189`）: 既存 6 分類の文字列は**変更しない**（`tests/mcp.test.ts:681` は `toBeDefined()` のみで文言非依存）。追加として、`profile_list` の payload に `resolvedBy` と `matchesCwd: boolean` を加え、agent が「この cwd で実際に使われる profile」を判定できるようにする。

#### 明示的除外

- **`emit status` / `sync_status` には解決根拠を出さない**。status は記事状態の報告であり、接続文脈は既に MCP `_meta` と `profile current` が担う。status 出力へ足すと `tests/cli_pull_snapshot.test.ts` / `presentation_symmetry` で守られている表示契約と Layer 3 formatter の責務がぶれ、費用対効果が合わない。

### 3.2 P2: workspace link ズレの検出と診断（非対話）

#### 検出関数（Layer 0）

`src/utils/profile.ts` に追加（既存 `resolveDirectoryForComparison()` を再利用し、symlink 比較規則を同一にする）:

```ts
export interface WorkspaceLinkDrift {
  profileName: string;
  registeredWorkspace: string; // profiles.yaml の値
  actualWorkspace: string; // 現在解決された workspace root
}

/** profile に workspace が登録済みで、それが実際に解決された root と物理パス一致しない場合のみ返す。 */
export function detectWorkspaceLinkDrift(
  profileName: string | undefined,
  registeredWorkspace: string | undefined,
  actualWorkspaceRoot: string,
): WorkspaceLinkDrift | null;
```

- 判定は `resolveDirectoryForComparison()` による realpath 比較。末尾スラッシュ差・symlink 経由は drift と見なさない（`resolveInitPlan()` の trailing-slash 規則と揃える）。
- profile に `workspace` が未登録の場合は drift なし（そもそも link が無い）。

#### 適用地点と文言

1. **CLI**（`src/cli/context.ts`）: `resolveContext()` は**ファイル書き込みを行わない**契約を維持するため、here は検出と警告のみ。

   ```text
   ⚠️ Profile "aroooy.net" is registered to /Users/me/src/my-blog, but this command runs in
      /Users/me/src/workspaces/aroooy.net. Emit is using the registered path.
      Re-link it with: emit init --profile aroooy.net
   ```

2. **`emit doctor` Check 2b**: `runEnvironmentChecks()`（同期グループ、`src/sync/doctor.ts:269-327`）に新規 check を追加する。
   - id: `workspace_link_consistency`、Check 2（`origin_consistency`）の直後に push（origin の一致を確認した後にパスを見る順序）。
   - `warning` + `suggestion: 'Re-link with "emit init --profile <name>" so the registered workspace path matches this directory.'`
3. **`emit init` の再実行可能性**: 現状 `initWorkspace()` は既存 `.emit/`・config を無条件上書きする（`config.ts:86-103`）。drift 修正を `emit init` で行えるようにするため、**`--profile <name>` オプションを追加**し、①解決を明示 profile に固定（cwd 一致に負けない）、②既存 config の非接続キー（`defaultCollection` / `defaultLocale` / `postsSyncLimit` / `mediaSyncLimit` / `concurrency` / `localMediaRefs`）と `createdWithVersion` を保持したまま `origin` を更新、③`setProfile(name, { ...existing, workspace: root })` で link を張り替える。
   - 既存の `resolveInitPlan()` 3-guard（`--no-link` / 既存 workspace あり / origin 不一致）は**変更しない**。guard 2 に引っかかった場合は「link は既存のまま」ではなく、drift 検出時に限り再リンクする旨を helper の doc comment とテストで固定する。

#### 明示的除外

- **対話 `[Y/n]` プロンプトは採用しない**。読み取り系コマンド（`status` / `diff`）で毎回尋ねる UX は受け入れがたく、MCP(stdio JSON-RPC) では対話が不可能で CLI/MCP 挙動差が生じる。AGENTS.md が守る失敗表示契約（`src/cli/report-failure.ts` 経由の 1 行 + `exit 1`）にも割り込みは入らない。

### 3.3 P3: Git 衛生のデフォルト化（`.emit/.gitignore`）

#### 方針

**ユーザーのルート `.gitignore` は Emit が編集しない**（Git 管理方針はユーザーの所有物であり、README §6 も `media/` の追跡可否をユーザー判断に委ねている）。Emit が生成するのは自ディレクトリ内の `.emit/.gitignore` のみ。

#### 実装

`src/utils/config.ts` に追加:

```ts
export const EMIT_GITIGNORE_TEMPLATE = [
  '# Emit local cache database (machine-local SQLite — never commit)',
  'cache.db',
  'cache.db-wal',
  'cache.db-shm',
  'cache.db.bak-*',
  'mcp_state.json',
  '',
].join('\n');

/** .emit/.gitignore を作成する。既存ファイルは絶対に上書きしない。 */
export function ensureEmitGitignore(emitDir: string): { created: boolean; path: string };
```

- `initWorkspace()` の末尾から呼び出し、`emit init` の出力に 1 行追加:

  ```text
  ✅ Initialized Emit workspace at: /Users/me/src/workspaces/new-site
     Config: .../.emit/config.json
     Database: .../.emit/cache.db
     Git:      .emit/.gitignore created (excludes the local SQLite cache)
               If this workspace is a Git repo, see README §6 "Recommended .gitignore".
  ```

- **既存ファイルがある場合は作成しない**（`created: false`）。`mcp_state.json` は実体が `~/.config/emit/mcp_state.json` であり `.emit/` には現れないが、将来のローカル永続化を先読みして除外対象に含める。
- 生成しないスイッチは**用意しない**（`.emit/` 内のみであり、要望書の `--no-gitignore` は不要と判断）。

#### README §6 の更新

「Recommended `.gitignore`」節に以下を追記する:

- `emit init` が `.emit/.gitignore` を作成すること、およびそれは**新規ワークスペースにのみ**効くこと（既存ワークスペースは README のスニペットをルート `.gitignore` に貼る）。
- `.emit/config.json` はコミットして良い（トークンは `~/.config/emit/profiles.yaml` に分離済み）、という既存 TIP を維持。

#### Ask First 判定

`.gitignore` は新規ファイル生成のみで、`.emit/config.json` のキー追加でも DB スキーム変更でもない。**カテゴリ 2 に該当しない**。

### 3.4 P4-A: `emit profile set-token <name>`

`src/cli/commands/profile.ts` に追加（既存 `setProfile()` を呼ぶだけで、Layer 0 の公開 API は変更不要）:

```bash
emit profile set-token <name> [--token <token>] [--stdin]
```

- 解決順序: `--token` > `--stdin` > **TTY 対話入力**。
- TTY 対話は **Node 標準の `node:readline/promises`** を使う（新規 npm パッケージ不使用＝Ask First カテゴリ 1 に触れない）。プロンプトは `API token for "<name>" (input hidden): `。
  - **秘密入力の秘匿**: `process.stdin` の `echo` を一時的に無効化して復元する最小ヘルパーを `src/cli/commands/profile.ts` 内に置く（TTY でない場合は秘匿不要）。例外時に必ず echo を戻す。
- 既存 token は保持しない（このコマンドの目的は明示的な設定）。上書き前に `Replaces the existing token for "<name>".` を 1 行出力する。
- 存在しない profile 名は検証で `❌ Profile "<name>" not found. Available profiles: ...` を `reportProfileFailure()` 経由で出し、`exit 1`（スタックトレースを出さない契約を維持）。
- **対話フォールバックは本コマンドと `profile add` の省略時のみ**。`pull` / `status` などの同期コマンドへは入れない（§6）。

### 3.5 P4-B: `emit doctor --check-auth`（オプトイン認証妥当性）

- CLI オプション `--check-auth`、MCP 引数 `checkAuth: boolean`。既定 false で、**通常運用の doctor はオフラインのまま**（`--check-media-urls` / `--check-media-library` と同じ原則）。
- `RunWorkspaceDoctorOptions.checkAuth?: boolean` を追加し、**リモートプローブ専用の async ヘルパーとして新設する**:

  ```ts
  /** Check 2c — opt-in credential validity probe. The only check group that touches the network
   *  besides the media remote probes, so it stays out of the synchronous environment group. */
  async function runRemoteAuthCheck(ctx: DoctorCheckContext): Promise<void>;
  ```

  - **配置の根拠**: `runEnvironmentChecks()` は `(ctx, currentVersion): void` の**純同期関数**（`doctor.ts:268`）で、v0.1.37 Part B が分けた「環境チェック（同期）/ 整合性チェック（同期）/ リモート検査（`await runMediaIntegrityChecks`）」の責務分割を守るため、HTTP を伴う check は**同期グループへねじ込まない**。`runWorkspaceDoctor()` 内で `runEnvironmentChecks()` の直後（`doctor.ts:918` と `:920` の間）に `await runRemoteAuthCheck(ctx)` を置く。
  - **順序 invariant**: `DoctorCheckContext` の docblock が述べる「`checks` は strict id 順に append され、レポートの並びはグループ呼び出し順が固定する」（`doctor.ts:241-242`）に従い、id は `auth_validity`（Check **2c**、`workspace_link_consistency` の直後・Check 3 の直前）とし、`await` を挿入する位置そのものが順序を決める。
- 送信先: **新規エンドポイントを発明しない**。既に Layer 0 にある `articleContentEndpoint(origin, collection)`（`src/client/endpoints.ts:14`）を `limit=1` で叩き、ステータスのみで判定する（`GET /_emdash/api/content/posts?limit=1`）。
  - **選定根拠**: Emit のコア責務は記事同期であり、認証妥当性の問いは「**Emit が同期を行える正当な権限があるか**」である。カテゴリ一覧エンドポイントでは、記事権限を持つが taxonomy 管理権限を持たないトークンやカテゴリ機能を持たない環境で**偽陰性（403/404 を error と報告）**になり得るため不適切。`posts` は Emit が実際に PUT する対象と同じであり、権限モデルの代表点として堅牢。
  - `collection` は `DoctorCheckContext.collection`（`doctor.ts:906` で解決済み）を使い、MCP `sync_doctor` の `collection` 引数と同一性を保つ。body は解析せず HTTP ステータスのみ参照するため OpenAPI batch limit 探索（v0.1.30 §2.3）には依存しない。

| HTTP | check status | message |
| --- | --- | --- |
| 2xx | `ok` | `Configured credentials are accepted by <origin> (auth source: <source>).` |
| 401 / 403 | `error` | `Configured credentials were rejected by <origin> (HTTP <n>). The token may be revoked or lack the required scope.` + suggestion: `Issue a new Personal Access Token in the EmDash admin, then run "emit profile set-token <name>".` |
| 404 / 5xx | `warning` | `Could not verify credentials against <origin> (HTTP <n>). This does not prove the token is invalid.` |
| 通信不能 | `warning` | `Credential verification skipped: <origin> unreachable.` |

- **Epistemic 規則**: 401/403 以外では決して「トークンが無効」と断定しない（`--check-media-urls` の「served key は R2 object の存在を証明するだけ」と同じ書き方）。通信不能は skip 扱いで `overallStatus` を悪化させない。
- **既存の 401 自動リフレッシュ機構**（`src/client/http.ts`、`refresh_token` 保有時）とは別に、doctor は既存の `fetchFn` オプション（`doctor.ts:92`）へ参加させ、テストは fetch スタブで決定的に検証する。
- **エラーコード境界**: doctor check の status / message / suggestion は `DoctorCheckResult` 経由で返すため**新規 error code を生まない**。`GUARD_REGISTRY` / `OPERATIONAL_ERROR_CODES`（`guards.ts:62-94`）/ `PROTECTION_ERROR_CODES`（`guards.ts:101`）のいずれにも追加せず、Rule 2（rogue code exclusion）と Rule 3（ID 1..19 連続性）を**無変更で**通過させる。fetch 失敗は `ApiError('NETWORK_ERROR')` を投げず check の warning として吸収する。
- **導線（discoverability）**: コマンドを増やさない代わりに案内文言を入れる。`emit profile set-token` 成功時と `emit init` の PAT 誘導ブロック末尾へ `Tip: verify credentials with "emit doctor --check-auth".` を追加し、README §5 troubleshooting と MCP instructions にも同じ表記で記載する（`emit profile verify` のような新動詞は増やさない）。

---

## 4. フェーズ分割とコミット計画

| Phase | 内容 | コミット | 挙動変更 |
| --- | --- | --- | --- |
| **P0** | characterization snapshot 追加（`emit profile list` / `profile current` 出力、`initWorkspace` が生成するファイル一覧）を**先行コミット** | `test(cli): add profile output and init workspace snapshots (v0.1.38 P0)` | なし |
| **P1** | `src/utils/profile-resolution.ts` 新設 + `profile list` / `current` 表示 + MCP `profile_list` の `resolvedBy` / `matchesCwd` | `feat(cli,mcp): expose profile resolution rationale in CLI and profile_list (v0.1.38 P1)` | 表示追加のみ |
| **P2** | `detectWorkspaceLinkDrift()` + CLI 警告 + doctor Check 2b + `emit init --profile` の link 再張り替え | `feat(cli,doctor): detect workspace link drift after folder moves (v0.1.38 P2)` | 警告追加 + `init` の非破壊更新 |
| **P3** | `.emit/.gitignore` 生成 + README §6 更新 | `feat(utils): ship .emit/.gitignore on init for Git hygiene (v0.1.38 P3)` | 新規ファイル生成 |
| **P4** | `profile set-token`（A）と `doctor --check-auth` / `sync_doctor checkAuth`（B） | `feat(cli,doctor): add profile set-token and opt-in auth validity check (v0.1.38 P4)` | 新コマンド・新オプショングループ |
| **P5** | README / AGENTS.md / CHANGELOG 更新 + version bump | `docs(release): document v0.1.38 UX fixes and bump to 0.1.38` | なし |

- P0 の snapshot を先に置くことで、P1・P2 の表示変更が「意図した差分だけ」であることを `.snap` 差分で機械的に検証する（v0.1.37 §5.4 と同じ手順）。
- **Ask First 承認ゲート**: P4-B はカテゴリ 3（MCP パブリック façade の拡張）につき、**着手前にオーナー承認**を取得する。P1・P2・P3・P4-A はゲート不要。

---

## 5. テスト計画

| ID | ファイル | 検証内容 |
| --- | --- | --- |
| T1-1 | `tests/profile_resolution.test.ts`（新規） | `toResolutionSource()` が cwd 一致有無・explicit・single・origin 一致で正しい source を返す（各 positive + negative） |
| T1-2 | 同上 | `formatResolutionRationale()` の出力にトークン文字列が含まれないこと、cwd と registered path の両方が `workspace-dir` 文言に出ること |
| T1-3 | `tests/cli.test.ts`（拡張） | `profile current` が `Resolved by:` 行を出す。`profile list` に `(matches current directory)` と `(active default — used only outside registered workspaces)` が出、`(active)` 単独ラベルが消えていること |
| T1-4 | `tests/mcp_tool_errors.test.ts`（拡張） | `profile_list` が `resolvedBy` と `matchesCwd` を返し、machine-level `~/.config/emit/profiles.yaml` ではなく転送された `profilesPath` のみを報告する既存契約を維持 |
| T2-1 | `tests/profile.test.ts`（拡張） | `detectWorkspaceLinkDrift()` が①旧パス登録＋新 root で drift を返す、②realpath 一致（symlink 経由・末尾スラッシュ差）では null、③`workspace` 未登録で null を返す |
| T2-2 | `tests/doctor.test.ts` + `tests/doctor_snapshot.test.ts` | Check 2b が drift 時に `warning`、正常時に check を push しない（snapshot の check 順序が保たれる）こと |
| T2-3 | `tests/cli.test.ts` | `emit init --profile <name>` が既存 config の非接続キーと `createdWithVersion` を保持したまま link を張り替える。`--no-link` は従来どおり link しない（`resolveInitPlan()` guard 不変の再確認） |
| T3-1 | `tests/config_gitignore.test.ts`（新規） | `initWorkspace()` が `.emit/.gitignore` を作成し、`cache.db` / `-wal` / `-shm` / `.bak-*` の各パターンが一致すること。既存ファイルがある場合は内容が**バイト単位で不変**であること |
| T4-1 | `tests/cli.test.ts` | `profile set-token --token` が token を更新し origin / workspace / defaultCollection を保持する。存在しない名前は `❌ Profile ... not found` + `exit 1`（スタックトレース混入なし） |
| T4-2 | 同上 | `--stdin` パスと非 TTY 時の挙動（対話試行をしない）を固定 |
| T4-3 | `tests/doctor.test.ts` | fetch スタブで 200→`ok`、401→`error`（suggestion に `emit profile set-token` を含む）、404→`warning`（「無効と断定しない」文言）、通信不能→`warning`。`checkAuth` 未指定時は check が push されない＝オフライン維持 |
| T4-4 | `tests/cli.test.ts` | `doctor --check-auth` オプションが存在し、description に opt-in である旨が含まれること（`--check-media-library` と同様の検査形式） |
| T4-5 | `tests/doctor.test.ts` | 認証 probe が叩く URL が `articleContentEndpoint(origin, collection)` + `limit=1` であり、MCP `sync_doctor` に渡した `collection` と同一の path になること（taxonomy endpoint へはリクエストしない negative ケース）。`runRemoteAuthCheck()` が同期グループ外であることを固定するため、fetch スタブが `runContentIntegrityChecks` 完了**後**に呼ばれる順序を検証 |
| T4-6 | 同上 | 記事権限のみ・taxonomy 権限なしを模した stub（posts 200 / taxonomies 403）で check が `ok` になること（偽陰性回帰の防止） |
| T5-1 | `tests/presentation_symmetry.test.ts`（拡張） | profile 解決文言が CLI・MCP で共有 1 ソースから来ること（文字列リテラルの二重定義検出） |
| — | `tests/layering.test.ts` / `tests/guards.test.ts` | **無変更**で green。新規 check id は guard code を生まないため registry 不変 |

---

## 6. 明示的に採用しない項目と理由

| ID | 要望書の提案 | 不採用理由 |
| --- | --- | --- |
| **X-1** | ルート `.gitignore` の自動生成・自動追記 | Emit は Git 管理方針を所有しない。README §6 が `media/` 追跡可否をユーザー判断に委ねているのと整合させ、`.emit/.gitignore` に限定する。既存ファイルを Emit が編集すると「Localized Diff」チェックリスト（AGENTS.md）にも抵触しうる |
| **X-2** | `.DS_Store` / `Thumbs.db` の注入 | OS 固有の話で Emit の責務範囲外。リポジトリ自身の `.gitignore` には既に定義済みだが、配布対象にはしない |
| **X-3** | `emit status` への解決プロファイル表示 | 接続文脈は MCP `_meta` と `profile current` が既に担う。status 出力へ足すと snapshot・presentation symmetry で守られた表示契約と Layer 3 formatter の責務がぶれる |
| **X-4** | `pull` / `status` 実行時の対話トークン入力フォールバック | ①MCP(stdio JSON-RPC) では対話不能で CLI/MCP 挙動差が生じる、②`reportActionFailure()` + `exit 1` に統一された失敗表示契約への例外追加になる、③CI・エージェント実行でハングする。対話は `profile set-token` / `profile add` の省略時に限定 |
| **X-5** | workspace link 更新の対話 `[Y/n]` | 読み取り系コマンドでの毎回尋ねは UX として成立せず、MCP で実装不能。警告＋`emit init --profile` 提示に置換（§3.2） |
| **X-6** | doctor の Git 除外設定 check | P3 で原因側（テンプレート配布）を潰すため冗長。Emit が Git の状態を診断項目にすると「Git 方針はユーザー所有」という既存設計判断と衝突する |
| **X-7** | `resolveTargetProfile()` の戻り値拡張（`source` を `'workspace-dir'` / `'workspace-origin'` に分割） | Layer 0 の公開シグネチャ変更になり呼び出し側（`src/client/auth.ts:90`, `src/cli/context.ts`, `src/mcp/server.ts`）へ波及する。`cwdMatched` を引数に取る別ヘルパーで吸収する方が小さい |
| **X-8** | PAT 一覧エンドポイントの照会 | EmDash の公式 REST 境界（OpenAPI）に PAT 一覧は無く、`src/client/endpoints.ts` に該当ビルダーもない。発明しない（P4-B は既存 GET のステータス確認に留める） |

---

## 7. リスクと対策

| リスク | 内容 | 対策 |
| --- | --- | --- |
| P2 の警告が誤検知で噪音になる | symlink 経由・末尾スラッシュ差・まだ存在しないパスの登録で drift を報告する | `resolveDirectoryForComparison()`（`profile.ts:153-172`）を同一に使い、非存在パスは「drift でない」側に分ける。T2-1 に 3 ケース（symlink / trailing slash / 未登録）を positive + negative で固定 |
| P2 で既存の workspace 優先順序が変わる誤解 | `resolveContext()` の解決順序（profile workspace > cwd）は**変更しない**。本版は検出と警告のみ | 実装時に順序不変をコメントで明記し、`tests/cli.test.ts` に「drift 時も registered path が使われる」ケースを追加して意図を固定する |
| `emit init` の再実行で設定が飛ぶ | 現状 `initWorkspace()` は config を無条件上書き（`config.ts:103`） | `--profile` 経由の再実行時は既存 JSON を read → マージして書く。T2-3 で非接続キーと `createdWithVersion` の保持を検証 |
| `.emit/.gitignore` が既存ワークスペースで効かない誤解 | 生成は新規 `init` のときだけ | README §6 に既存ワークスペース向けスニペットを残し、`emit init` 出力でも README §6 を参照させる。doctor で警告しない（X-6）ことと整合 |
| 秘密入力の秘匿漏れ | `readline/promises` は既定で echo を返す | TTY のときだけ `process.stdin` の echo を無効化し、`finally` で復元。テストは非 TTY 経路を固定し、シークレットの書き出しは行わない |
| `--check-auth` が doctor をオンライン化する誤用 | 既定 false を見落とすと全 doctor が通信する | オプション説明に opt-in 明記（T4-4）、`checkMediaUrls` / `checkMediaLibrary` と同じ「未指定時は check を push しない」snapshot 検査で機械的に担保 |
| MCP payload 追加が公開契約変更になる | `profile_list` の payload キー追加は npm 公開 API の拡張 | Ask First カテゴリ 3 に準じて扱う。既存キー（`activeProfile`, `profiles`, `_meta`）は不変で追加のみ。§4 の承認ゲートで確認を取る |
| doctor check 追加で順序が崩れる | `runEnvironmentChecks()` は同期関数として Check 1, 2, 7 を順に push している（`doctor.ts:269-327`）。`await runMediaIntegrityChecks(ctx)` が末尾（`doctor.ts:934`）に来るため、**環境 check の後に置く id は実行順では末尾へ回る** | 新規 `workspace_link_consistency` は同期グループ内 Check 2 の直後。認証 probe は async の `runRemoteAuthCheck()` を `runEnvironmentChecks()` の直後で `await` し（§3.5）、id は `auth_validity`（Check 2c）として「論理 id 順」と「実行順」の差を doctor docblock に明記する。いずれも `tests/doctor_snapshot.test.ts` の check 順序 snapshot で担保し、Check 7（`mcp_process`）が環境グループ内での位置を保つことを確認 |
| 認証 probe が権限モデルの違いで偽陰性を出す | taxonomy 系エンドポイントを選ぶと、記事同期はできるが taxonomy 管理権限のないトークンで `error` を報告する | 送信先を `articleContentEndpoint(origin, collection)`（Emit が実際に PUT する対象と同じ）に固定し、T4-6 で posts-only トークンの positive ケースを回帰テストとして残す |

---

## 8. 完了条件（DoD: Definition of Done）

1. [x] `src/utils/profile-resolution.ts` が新設され、`profile list` / `profile current` / MCP `profile_list` が**同じ 1 ソース**の解決根拠文言を使っていること（T5-1）。
2. [x] `emit profile list` の `(active)` ラベルが「cwd 自動解決が優先される」意味を明示した文言に変わっており、`(matches current directory)` が cwd 一致時に出ること。
3. [x] `detectWorkspaceLinkDrift()` が新設され、CLI 警告と doctor Check `workspace_link_consistency`（Check 2 の直後）が同じ判定関数を使っていること。
4. [x] `emit init --profile <name>` が再実行可能で、既存 config の非接続キーと `createdWithVersion` を保持したまま workspace link を張り替えること。`resolveInitPlan()` の 3-guard は無変更。
5. [x] `emit init` が `.emit/.gitignore`（`cache.db`, `cache.db-wal`, `cache.db-shm`, `cache.db.bak-*`）を作成し、**既存ファイルは絶対に上書きしない**こと。ルート `.gitignore` への書き込みがコード中に存在しないこと。
6. [x] `emit profile set-token <name>` が追加され、`--token` / `--stdin` / TTY 入力の順で解決し、TTY では入力が秘匿されること。**新規 npm パッケージは追加されていない**こと（`git diff package.json` に dependencies 変更なし）。
7. [x] `emit doctor --check-auth` と MCP `sync_doctor checkAuth: true` が追加され、2xx / 401・403 / 404・5xx / 通信不能の 4 判定が §3.5 の表どおりであること。未指定時は doctor がオフラインを維持すること。認証 probe の送信先が `articleContentEndpoint(origin, collection)` であり、`runEnvironmentChecks()` は同期関数のまま（fetch を含まない）であること。
8. [x] P0 の snapshot コミットが先行しており、P1・P2 の変更で `.snap` 差分が**意図した行のみ**であること。
9. [x] `tests/layering.test.ts`（Axis 0–5）と `tests/guards.test.ts`（Rule 1–5）が**無変更**で green。`ALLOWED_LAYER_2_SYMBOLS` および layering スナップショット例外リストに追加がないこと。
10. [x] 非 CLI 層（`src/utils/`, `src/sync/`, `src/db/`, `src/client/`, `src/mcp/`, `src/presentation/`）に `console.log` / `console.debug` が **0 件**であること（Axis 5）。新規の警告・診断文言はすべて Layer 3（CLI/MCP）または doctor の `DoctorCheckResult` 経由で出す。
11. [x] README（§3 Multi-Site / §6 `.gitignore` / CLI Command Reference の `emit init`・`emit profile`・`emit doctor`）、`AGENTS.md`、MCP instructions の記述が実装と一致していること。
12. [x] `CHANGELOG.md` に v0.1.38 セクションが `[Unreleased]` 直下へ追記され、`package.json` / `package-lock.json` が `0.1.38` になっていること。
13. [x] `npm run check`（format:check, typecheck, check:cycles, test）が 100% green。

**DoD 検証の実測値（2026-11-19 / P5 完了時点）**

| 項目 | 実測 | 検査 |
| --- | --- | --- |
| 非 CLI 層の `console.log` / `console.debug` | **0 件**（Axis 5 PASS） | `grep -rn 'console\.\(log\|debug\)' src \| grep -v 'src/cli/' \| wc -l` |
| 新規 npm 依存 | **0 件**（`readline` は `node:` 標準） | `git diff origin/main..HEAD -- package.json` に dependencies 変更なし |
| `.gitignore` 書き込み箇所 | `ensureEmitGitignore()` の `path.join(emitDir, '.gitignore')` **1 箇所のみ**（`.emit/` 内） | `grep -rn "\.gitignore" src/utils/config.ts` |
| 解決根拠文言の共有元 | `src/utils/profile-resolution.ts` を CLI 2 ファイル・MCP 1 ファイル・doctor が import | `grep -rln 'profile-resolution' src` |
| layering / guards | 無変更で **12 tests green** | `npx vitest run tests/layering.test.ts tests/guards.test.ts` |
| 静的品質ゲート | `npm run check` green（70 files / 765 tests、循環依存 0） | `npm run check` |

---

## 9. Ask First Policy との対応表

| 施策 | 該当カテゴリ判定 | 結論 |
| --- | --- | --- |
| **P1** profile 解決根拠の可視化（Layer 0 ヘルパー新設 + CLI/MCP 表示） | カテゴリ 1（新パッケージ）＝不使用。カテゴリ 2（SQLite / `.emit/config.json` キー）＝該当なし。カテゴリ 3（`pullBatch` / `pullSingleArticle` / `pushArticle` / `pushAll` のシグネチャ）＝該当なし。MCP `profile_list` は公開 façade だが**同期系 orchestrator API の范畴外**で、既存 payload への追加のみ | **承認不要**。実装可 |
| **P2** workspace link drift 検出（警告 + doctor check + `emit init --profile`） | カテゴリ 1＝不使用。カテゴリ 2＝`.emit/config.json` に**キーを追加しない**（既存キーの値を再設定するのみ）。`cache.db` スキーム不変。カテゴリ 3＝該当なし。カテゴリ 4（`docs/` の権威仕様・AGENTS.md 核心原則）＝AGENTS.md は**新 invariant の追記**であり削除・根本改変ではない | **承認不要**。ただし AGENTS.md へ書く invariant 文言はレビューで確認を受ける |
| **P3** `.emit/.gitignore` 生成 | カテゴリ 2 の「config keys in `.emit/config.json`」には該当しない（**別ファイルの新規作成**）。カテゴリ 1・3・4＝不使用 | **承認不要**。実装可 |
| **P4-A** `emit profile set-token` | カテゴリ 1＝**不使用**（`node:readline/promises` は Node 標準。`@types/node` は既存 `"types": ["node"]` で充足済み、AGENTS.md の追加禁止も遵守）。カテゴリ 3＝該当なし（profile API は public façade の 4 関数に含まれない） | **承認不要**。実装可 |
| **P4-B** `doctor --check-auth` / `sync_doctor checkAuth` | MCP パブリック façade（`sync_doctor`）への引数追加＝**カテゴリ 3 に準じる**（戻り値 shape は不変だが、公開契約の拡張であることは正直に扱う） | **オーナー承認を要する**（§4 P4 ゲート）。承認までは P1–P3 と P4-A のみ実行する |
| **X-4 / X-5** 対話プロンプトの同期コマンド導入 | 新規 npm パッケージを使わず `node:readline/promises` で実装可能なためカテゴリ 1 は回避できるが、CLI/MCP 対称性と失敗表示契約を壊す | **不採用**（§6）。仮に将来導入する場合はカテゴリ 3 相当の協議事項として起案し直す |
| **X-8** PAT 一覧 API の照会 | EmDash 公開 REST 境界に該当エンドポイントが存在しない（`src/client/endpoints.ts` にビルダーなし） | **不採用**。エンドポイントを発明しない方針を維持 |

---

## 10. 本計画書が扱わない残存課題（将来版への引き継ぎ）

| ID | 課題 | 除外理由 |
| --- | --- | --- |
| **X-9** | `profiles.yaml` の資格情報保存形式（平文 token → OS keychain 等の分離） | セキュリティ設計変更で Ask First カテゴリ 2 に準じる。本版は現状（mode `0600`, `saveProfilesFile()` `profile.ts:136`）を前提に、露出を増やさない方向のみ扱う |
| **X-10** | ワークスペース移動の**自動**追従（link 自動書き換え） | 暗黙の永続化変更は診断可能性を損なう。AGENTS.md の「Single Source of Truth / 推測で語らない」方針に合わせ、本版は検出 + 明示コマンド提示まで |
| **X-11** | `emit init` が `posts/{draft,published}` を既存ワークスペースで再作成する挙動の整理（`config.ts:92-93` の無条件 `mkdirSync`） | 本版の P2 と同じ関数に触るが、挙動変更は link 修正のスコープを膨らませる。snapshot を取ったうえで次版で扱う |
| **X-12** | MCP `profile_add` / `profile_set_token` の追加（agent 経由の資格情報登録） | agent が秘密情報をツール引数へ載せる設計はログ露出の検討が必要。P4-A の CLI 実装が固まってから協議する（カテゴリ 3） |
| **X-13** | `emit guide` / MCP instructions への「マルチサイト初期セットアップ手順」追記 | P1–P4 の文言が確定してから書く方が差分が小さい。本版では README のみ更新し、guide 更新は次版に回す |

---

## 11. 実装進捗（2026-11-19 時点）

| フェーズ | 状態 | 成果物 |
| --- | --- | --- |
| **P0** characterization snapshot | ✅ 完了 | `tests/v0138_characterization.test.ts`（新規）。`profile list` / `profile current` の出力、`initWorkspace` の生成ファイルと config キー集合、doctor の check 順序、`profile` サブコマンド・`doctor` オプション一覧を inline snapshot で固定。実測で判明した事実を 2 件反映: doctor の無条件 spine は `version_compatibility → origin_consistency → frontmatter_integrity → conflicts_quarantine → sync_status → media_references`（`mcp_process` は MCP プロセスが古い場合のみ push）、`.emit/config.json` の既定キーは 9 個（`concurrency` / `defaultLocale` を含む） |
| **P1** 解決根拠の可視化 | ✅ 完了 | `src/utils/profile-resolution.ts`（Layer 0 新規: `toResolutionSource()` / `formatResolutionRationale()` / `cwdMatchedProfileName()` / マーカー定数 2 個）。CLI `profile current` に `Resolved by:` 行、`profile list` のラベルを `(matches current directory)` と `(active default — used only outside registered workspaces)` へ分離。MCP `profile_list` へ `resolvedByDirectory` と per-profile `matchesCwd` を追加（既存キーは不変）。テスト: `tests/profile_resolution.test.ts`（新規 7 件）、`tests/mcp_tool_errors.test.ts` に T1-4、`tests/presentation_symmetry.test.ts` に T5-1（文言の二重定義検出）。README §3・§`emit profile` を更新 |
| **P2** workspace link drift 検出 | ✅ 完了 | `src/utils/profile.ts` に `detectWorkspaceLinkDrift()`（Layer 0、`resolveDirectoryForComparison()` 使用で symlink / 末尾スラッシュ誤検知なし、ネスト実行は drift 扱いしない）。CLI は `src/cli/context.ts` で stderr 警告（`formatWorkspaceLinkDriftWarning`）、doctor は Check 2b `workspace_link_consistency`（`origin_consistency` の直後、drift 時のみ push）で同じ判定関数を共有。文言は `src/utils/profile-resolution.ts` の `workspaceLinkDriftLines()` / `formatRelinkSuggestion()` の 1 ソース。修復は `emit init --profile <name>`（新規ヘルパー `resolveInitRelink()`、`--no-link` は常に優先、`resolveInitPlan()` の 3-guard は無変更）。`initWorkspace()` は既存 config をマージする非破壊化（`createdWithVersion` と非接続キーを保持）。テスト: `tests/profile.test.ts` T2-1、`tests/doctor.test.ts` T2-2、`tests/cli.test.ts` T2-3（unit + end-to-end + `--no-link` 拒否 + nested 無警告）。characterization の re-init スナップショットは P2 で意図的に反転（破棄 → 保持） |
| **P3** `.emit/.gitignore` | ✅ 完了 | `src/utils/config.ts` に `EMIT_GITIGNORE_TEMPLATE` / `ensureEmitGitignore(emitDir)`（Layer 0）。`initWorkspace()` が末尾で呼び、`{ gitignoreCreated }` を返す（CLI が filesystem を再検査せずに報告できる）。パターンは `cache.db` / `-wal` / `-shm` / `.bak-*` / `mcp_state.json`。既存ファイルは byte-for-byte で一切触らない。ルート `.gitignore` への書き込みはコード中に存在しない（X-1）。テスト: `tests/config_gitignore.test.ts`（T3-1、使い捨て repository で `git check-ignore` を実行し実 Git 意味論で照合。`config.json` が無視されないことも確認）。characterization の `.emit/` 生成ファイル一覧は P3 で意図的に反転（`config.json` のみ → `.gitignore` を追加）。README §6 と `emit init` 例示出力を更新 |
| **P4-A** `profile set-token` | ✅ 完了 | `src/cli/commands/profile.ts` に `set-token <name>`（`--token` > `--stdin` > TTY 秘匿プロンプト）。Layer 3 ローカルの `readSecretLine()` / `readTokenFromStdin()`（新規 npm パッケージなし、`node:readline/promises`）。既存 profile の token だけ差し替え、`origin` / `workspace` / `defaultCollection` / `defaultLocale` はそのまま引き継ぐ。書き込み前に `Replaces the existing token ...` を 1 行出し、新旧どちらの値も一切 print しない。未知 name は `reportProfileFailure()` 経由で 1 行 + exit 1。raw mode 復元は `finally` と stdin `close` の両方（Ctrl-C では await が完了しないため）。テスト: `tests/cli.test.ts` T4-1 / T4-2（置換範囲、出力への秘密漏れ否定、空 `--token` の明示的 clear、`--token` が `--stdin` に勝つ順序、fake TTY で raw mode の on/off 対）。characterization の profile サブコマンド一覧に `set-token` が 1 件増えた |
| **P4-B** `doctor --check-auth` | ✅ 完了（オーナー承認済） | `src/sync/doctor.ts` に async `runRemoteAuthCheck()`（Check 2c `auth_validity`）。`runWorkspaceDoctor()` 内で `runEnvironmentChecks()` の直後に `await` するため同期グループは純粋なまま。送信先は `articleContentEndpoint(origin, collection)` + `limit=1` を `createAuthedFetch` で 1 回だけ叩き、HTTP ステータスのみ判定（2xx ok / 401・403 error + `emit profile set-token` 案内 / その他・通信不能 warning）。新規 error code は生まないため `guards.test.ts` は無変更。MCP `sync_doctor` へ `checkAuth` 引数、CLI へ `--check-auth`（description に opt-in 明記）。案内は `emit profile set-token` 成功時と `emit init` 末尾の `Tip: verify credentials with "emit doctor --check-auth".` のみで新動詞は作らない。テスト: `tests/doctor.test.ts` T4-3 / T4-5 / T4-6（fetch スタブ 4 判定、叩く URL が collection 解決と一致、taxonomies へ送らない、posts-only token が ok、未指定時は 0 リクエスト・check 非 push）、`tests/cli.test.ts` T4-4。characterization の doctor オプション一覧に `--check-auth` が 1 件増えた |
| **P5** リリース準備 | ✅ 完了 | `CHANGELOG.md` へ v0.1.38 セクション（Added / Changed / Fixed）を `[Unreleased]` 直下へ追記、`package.json` / `package-lock.json` を `0.1.38` へ。README（§6 `.gitignore`、`emit init` / `emit profile` / `emit doctor` の Command Reference、Troubleshooting の認証 Q、MCP instructions）と AGENTS.md（オプトイン remote probe、秘密入力処理、init 生成 Git hygiene の 3 invariant）を実装と一致させた |

**P1 で生きた設計判断**

- `(active)` ラベルの意味は変えず、**ラベル文言のみ**修正した。`setActiveProfile()` の永続化キーと解決順序は無変更で、`profile list` が「実際に使われる profile」と「fallback」を別々に示すようになった。
- MCP は `src/cli/` を import できない（Axis 3）ため、文言は Layer 0 に置く以外に選択肢がなかった。`tests/presentation_symmetry.test.ts` の T5-1 が定数の再定義を機械的に検出する。
- 対称性テストはコメントを除去してから字句を検査する。変更説明の散文（`(active)` の旧意味を解説するコメント）を再定義と誤認しないため。

**P2 で生きた設計判断**

- drift の判定関数は Layer 0（`src/utils/profile.ts`）に 1 個だけ置き、CLI 警告と doctor Check 2b が同じ関数を呼ぶ。警告文言も `workspaceLinkDriftLines()` の 1 ソースで、CLI は prose、doctor は structured check に各自レンダリングする。
- **解決順序は無変更**（profile workspace > cwd）。本版は検出と警告のみで、drift 時も registered path が接続に使えることを `tests/cli.test.ts` で固定した。順序を変えると「移動直後に別サイトへ push する」事故を招く。
- nested 実行（登録 workspace 配下の `posts/draft` など）は drift にしない。`findProfileByDirectory()` が正確に一致させている以上、接続はすでに正しい。
- 再張り替えは**明示的に名前を挙げた profile だけ**が対象（`resolveInitRelink()` の `source === 'explicit' && drift`）。auto-resolved で workspace を持つ profile は「登録パスがここを含む」意味なので guard 2 を維持。`--no-link` は常に優先。
- `initWorkspace()` の非破壊化は P2 の前提: 修復コマンドが limits / locale / `localMediaRefs` / `createdWithVersion` を戻してはいけない。characterization スナップショットの反転（`customMarker` 破棄 → 保持、`postsSyncLimit` 30 → 250）はこの 1 点だけの意図的な変更で、P0 の snapshot がそれを機械的に示す。
- テスト hermeticity: `os.homedir()` は `process.env.HOME` に追随しないため `vi.spyOn` で固定し、throwaway HOME の `profiles.yaml` は削除前に読み出す。macOS の `/var` → `/private/var` 解決は比較側にも realpath を適用（登録パスは存在しないので verbatim 比較）。

**P3 / P4-A / P4-B で生きた設計判断**

- **P3**: `.gitignore` の生成先は `.emit/` に限定した。ルート側を作ると「`media/` を追跡するか」という README §6 のユーザー判断を Emit が奪うことになり、X-1 の不採用理由と衝突する。既存ファイルは append ですらなくさない（ユーザーが編集した可能性があり、`Localized Diff` チェックリストとも相性が悪い）。テンプレートの正しさは文字列一致ではなく**使い捨て repository での `git check-ignore`** で検証した – パターン名を打ち間違えると「守っているつもりで DB がコミットされる」事故になるため、実 Git 意味論が唯一の証明である。`config.json` が無視されないことも negative case で固定した（過広なルールは workspace 設定を黙って落とす）。
- **P3 の戻り値**: `initWorkspace()` は `{ gitignoreCreated }` を返す。CLI が filesystem を再検査すると「作らなかった」ケース（既存ファイル）と「作成失敗」を区別できないため、事実は生成側が申告する。
- **P4-A**: 新規依存は追加しない（Ask First カテゴリ 1 を回避）。`node:readline/promises` + TTY のときだけ `setRawMode` で足りる。秘匿は**対話パスのみ**で、pipe には terminal state がない（`setRawMode` は throw する）。解決順序を `--token` > `--stdin` > プロンプト と固定した: 明示フラグはラッパースクリプトが残す pipe より意図が強い。
- **P4-A の復元経路**: raw mode の戻しは `finally` だけでは不十分だった。対話を中断（Ctrl-C）すると既定 SIGINT でプロセスが死に、await が完了しないので `finally` が走らない。stdin の `close` でも復元する（`once` ガードで二重復元はしない）。この事実はテストが先に暴露した – fake TTY で「stream close 時点で cooked に戻っている」ことを assert している。
- **P4-A の秘密非露出**: 新旧どちらの token も print しない。既存 token を置換する事実だけを `Replaces the existing token for profile "<name>".` で伝え、誤 profile 実行に気付ける情報だけを残す（傍目には読めない）。空 `--token` は唯一の「clear」意思表示として尊重し、空 pipe はエラー（認証情報を黙って消さない）。
- **P4-B**: probe は `runEnvironmentChecks()` に入れず、`runWorkspaceDoctor()` の `await` 位置で順序を決めた。v0.1.37 Part B の同期/非同期責務分割を壊さないためで、docblock に「論理 id 順と実行順は異なる」ことを明記した（`mcp_process` は条件付き push なので、順序不変は position 固定ではなく関係で assert する）。
- **P4-B の送信先**: `articleContentEndpoint(origin, collection)` に固定。taxonomy 系だと「記事は同期できるが taxonomy 管理権限がない」token を error にする偽陰性が出る（T4-6 が posts 200 / その他 403 の stub で回帰レール）。body は解析せず status のみ。
- **P4-B の epistemic 規則**: 401/403 以外で「token が無効」と断定しない。5xx や通信不能は skip 扱い（`--check-media-urls` の「served key は object の存在を証明するだけ」と同じ型）。新規 error code を作らないので guard registry と layering テストは無変更で通る。
- **P4-B の発見性**: `emit profile verify` のような新動詞は増やさず、`set-token` 成功時と `init` 末尾の `Tip: verify credentials with "emit doctor --check-auth".` に案内を寄せる。README / MCP instructions も同じ表記で統一した。
- **P5**: characterization スナップショットの反転は P3（`.gitignore`）・P4-A（`set-token`）・P4-B（`--check-auth`）の 3 箇所だけで、いずれも「1 エントリ増えた」形に限定した。config キー集合と doctor の spine は無変更で、これが「Localized Diff」チェックリストの実証になっている。






