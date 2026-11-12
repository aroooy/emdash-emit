/**
 * Canonical registry of preflight guards, authoring safety checks, and known error codes.
 *
 * This file is the single source of truth for:
 * 1. Numbered safety guards (G1 through G19).
 * 2. Operational ApiErrors emitted by network/push/media transport layers.
 * 3. Standing protection errors raised by dedicated error classes.
 *
 * Verified against src/ via tests/guards.test.ts to guarantee zero drift.
 */

export type GuardStage = 'cli-mcp' | 'preflight' | 'push' | 'conflicts' | 'new';
export type GuardSeverity = 'error' | 'warning' | 'info';

export interface GuardMeta {
  /** Canonical numeric identifier (G1..G19). */
  id: number;
  /** Primary canonical name / label of the guard. */
  name: string;
  /**
   * Concrete error codes emitted by this guard.
   * Empty for invocation-layer guards (G1), mutations (G7), or syntax warnings (G8).
   */
  codes: readonly string[];
  /** Execution stage where the guard is enforced. */
  stage: GuardStage;
  /** Severity level when triggered. */
  severity: GuardSeverity;
  /** Primary source location for implementation reference. */
  source: string;
  /** Human-readable explanation of authoring misbehavior prevented. */
  description: string;
}

/**
 * Operational ApiErrors (network, lock, HTTP transport, server reject).
 * They report a failed system operation rather than a rejected authoring intent.
 * Exhaustively enumerated against src/ to ensure the rogue-code check in tests/guards.test.ts is total.
 */
export const OPERATIONAL_ERROR_CODES = [
  // push / publish transport
  'PUSH_CREATE_FAILED',
  'PUSH_FAILED',
  'PUSH_RETRY_FAILED',
  'PUBLISH_FAILED',
  'UNPUBLISH_FAILED',
  'REMOTE_ARTICLE_DELETED',
  'CONFLICT_REMOTE_FETCH_FAILED',
  // taxonomy transport (push.ts / taxonomies.ts)
  'TAXONOMY_UPDATE_FAILED',
  'TAXONOMY_DIVERGENCE',
  'TAXONOMY_UNION_REJECTED',
  'TAXONOMY_FETCH_FAILED',
  // lock lease (client/lock.ts, thrown as EntryLockError('ENTRY_LOCKED'))
  'ENTRY_LOCKED',
  // media upload transport (client/media.ts)
  'MEDIA_UPLOAD_URL_FAILED',
  'MEDIA_BINARY_UPLOAD_FAILED',
  'MEDIA_CONFIRM_FAILED',
  'MEDIA_NOT_READY',
  // list / fetch failures
  'ARTICLE_LIST_FAILED',
  'ARTICLE_PULL_FAILED',
  'ARTICLE_NOT_FOUND',
  'MEDIA_LIST_FAILED',
  'MEDIA_SEARCH_QUERY_REQUIRED',
  'NETWORK_ERROR',
  // delete transport (sync/delete.ts)
  'REMOTE_DELETE_FAILED',
  'REMOTE_DELETE_UNCONFIRMED',
] as const;

/**
 * Standing protection errors raised by dedicated error classes rather than ApiError.
 * They guard destructive operations (e.g. deleting published or modified articles)
 * or fundamental parsing, living outside GUARD_REGISTRY.
 */
export const PROTECTION_ERROR_CODES = [
  'UNPUSHED_CHANGES_PROTECTION', // sync/delete.ts (UnpushedModificationsError)
  'PUBLISHED_ARTICLE_PROTECTION', // sync/delete.ts (PublishedArticleDeletionForbiddenError)
  'FRONTMATTER_PARSE_ERROR', // utils/frontmatter.ts (FrontmatterParseError)
] as const;

export const GUARD_REGISTRY: readonly GuardMeta[] = [
  {
    id: 1,
    name: 'SINGLE_TARGET_GUARD',
    codes: [],
    stage: 'cli-mcp',
    severity: 'error',
    source: 'src/sync/preflight.ts:358',
    description: 'CLI / MCP 呼び出し層での単一ファイル指定強制（一括 Push の抑止）',
  },
  {
    id: 2,
    name: 'ID_MISMATCH_ERROR',
    codes: ['ID_MISMATCH_ERROR'],
    stage: 'preflight',
    severity: 'error',
    source: 'src/sync/preflight.ts:377',
    description: 'ファイルパスと Frontmatter 内 ULID の整合性検証',
  },
  {
    id: 3,
    name: 'UNINTENDED_PUBLISH_GUARD',
    codes: ['UNINTENDED_PUBLISH_GUARD'],
    stage: 'preflight',
    severity: 'error',
    source: 'src/sync/preflight.ts:389',
    description: '明示的な allowPublish 指定なしの公開昇格を防止',
  },
  {
    id: 4,
    name: 'INVALID_TAXONOMY_ERROR',
    codes: ['INVALID_TAXONOMY_ERROR'],
    stage: 'preflight',
    severity: 'error',
    source: 'src/sync/preflight.ts:440',
    description: '未定義カテゴリ・タグの指定検知',
  },
  {
    id: 5,
    name: 'LOCAL_IMAGE_DETECTED',
    codes: ['LOCAL_IMAGE_DETECTED', 'INLINE_LOCAL_IMAGE_NOT_SUPPORTED'],
    stage: 'preflight',
    severity: 'error',
    source: 'src/sync/preflight.ts:515,608',
    description: '本文内の未解決ローカル画像パスおよびインラインローカル画像検知',
  },
  {
    id: 6,
    name: 'UNRESOLVED_CONFLICT_MARKERS',
    codes: ['UNRESOLVED_CONFLICT_MARKERS'],
    stage: 'preflight',
    severity: 'error',
    source: 'src/sync/preflight.ts:642',
    description: '3-Way Merge コンフリクトマーカー（<<<<<<<, =======, >>>>>>>）の残存検知',
  },
  {
    id: 7,
    name: 'TITLE_DUPLICATION_AUTOTRIM',
    codes: [],
    stage: 'preflight',
    severity: 'info',
    source: 'src/sync/preflight.ts:651-663',
    description: '本文冒頭の重複 # Title 自動除去（cleanedBody の mutation）',
  },
  {
    id: 8,
    name: 'UNSUPPORTED_SYNTAX_WARNING',
    codes: [],
    stage: 'preflight',
    severity: 'warning',
    source: 'src/client/portable-text.ts:618',
    description: 'Portable Text 非互換構文の警告（detectUnsupportedMarkdownSyntax）',
  },
  {
    id: 9,
    name: 'MODIFIED_OPAQUE_BLOCK',
    codes: ['MODIFIED_OPAQUE_BLOCK'],
    stage: 'preflight',
    severity: 'error',
    source: 'src/sync/preflight.ts:672',
    description: '<!--ec:block--> 保護ブロック改ざん検知',
  },
  {
    id: 10,
    name: 'INVALID_FEATURED_IMAGE',
    codes: ['INVALID_FEATURED_IMAGE'],
    stage: 'preflight',
    severity: 'error',
    source: 'src/sync/preflight.ts:630',
    description: 'アイキャッチ画像 ID の形式検証（26 文字 ULID または null）',
  },
  {
    id: 11,
    name: 'LOCAL_IMAGE_AUTO_UPLOAD',
    codes: [
      'MISSING_LOCAL_IMAGE_FILE',
      'INVALID_LOCAL_IMAGE_TYPE',
      'LOCAL_IMAGE_SIZE_EXCEEDED',
      'PROMOTED_MEDIA_NOT_FOUND_REMOTE',
    ],
    stage: 'preflight',
    severity: 'error',
    source: 'src/sync/preflight.ts:545,564',
    description:
      'media/drafts/ からのオフライン画像自動アップロード・置換処理（[MEDIA_EXISTENCE_UNVERIFIED] 警告を含む）',
  },
  {
    id: 12,
    name: 'QUARANTINED_COPY_NOT_PUSHABLE',
    codes: ['QUARANTINED_COPY_NOT_PUSHABLE'],
    stage: 'push',
    severity: 'error',
    source: 'src/sync/push.ts:581',
    description: 'conflicts/ 配下の退避ファイル直接 Push 禁止',
  },
  {
    id: 13,
    name: 'CANONICAL_HAS_UNPUSHED_EDITS',
    codes: ['CANONICAL_HAS_UNPUSHED_EDITS'],
    stage: 'conflicts',
    severity: 'error',
    source: 'src/sync/conflicts.ts:67',
    description: 'コンフリクト解消時の未 Push ローカル編集上書き防止',
  },
  {
    id: 14,
    name: 'QUARANTINED_PATH_REQUIRED',
    codes: ['QUARANTINED_PATH_REQUIRED'],
    stage: 'conflicts',
    severity: 'error',
    source: 'src/sync/conflicts.ts:86',
    description: 'コンフリクト対象パスの検証',
  },
  {
    id: 15,
    name: 'DELETE_PENDING_ARTICLE',
    codes: ['DELETE_PENDING_ARTICLE'],
    stage: 'push',
    severity: 'error',
    source: 'src/sync/push.ts:674',
    description: '削除保留中記事の Push 抑止',
  },
  {
    id: 16,
    name: 'TAXONOMY_CONFLICT_PENDING',
    codes: ['TAXONOMY_CONFLICT_PENDING'],
    stage: 'push',
    severity: 'error',
    source: 'src/sync/push.ts:711',
    description: 'タクソノミー未反映状態での Push 抑止',
  },
  {
    id: 17,
    name: 'TAXONOMY_APPLY_PENDING',
    codes: ['TAXONOMY_APPLY_PENDING'],
    stage: 'push',
    severity: 'error',
    source: 'src/sync/push.ts:726',
    description: 'タクソノミー同期保留中の Push 抑止',
  },
  {
    id: 18,
    name: 'DUPLICATE_SLUG_CONFLICT',
    codes: ['DUPLICATE_SLUG_CONFLICT'],
    stage: 'new',
    severity: 'error',
    source: 'src/sync/new.ts:45',
    description: '記事作成時の重複スラッグ検証',
  },
  {
    id: 19,
    name: 'DESTRUCTIVE_TAXONOMY_WIPE',
    codes: ['DESTRUCTIVE_TAXONOMY_WIPE'],
    stage: 'push',
    severity: 'error',
    source: 'src/sync/push.ts:803,1232',
    description: 'タクソノミー全削除等の破壊的操作抑止',
  },
] as const;
