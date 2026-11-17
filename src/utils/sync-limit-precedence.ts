/**
 * @license
 * Emit — EmDash content sync CLI.
 * Copyright (c) 2026 Emit Contributors.
 * Released under the MIT license.
 */
import { DEFAULT_CONFIG } from './config.js';

/**
 * Centralized precedence resolver for synchronization window sizes and pool widths
 * (v0.1.37 R-2).
 *
 * Every consumer — CLI (`src/cli/commands/pull.ts`), MCP (`src/mcp/tools/sync-pull.ts`),
 * and the Layer 2 orchestrator (`src/sync/orchestrator.ts`) — must obtain `postsSyncLimit`,
 * `mediaSyncLimit`, and `concurrency` through these functions. Inlining a fallback chain at
 * each call site previously left 12 divergent spellings (including two hardcoded magic
 * numbers for `concurrency`) that silently drifted from `DEFAULT_CONFIG`.
 *
 * Precedence (strict, no disk or network access):
 *   explicit argument > `config.postsSyncLimit` > legacy `config.syncLimit` > default.
 *
 * Falsy semantics are preserved verbatim from the pre-refactor call sites: a configured
 * value of `0`, `null`, or `undefined` falls through to the next source (`||`, not `??`).
 * A non-numeric explicit argument (e.g. an unparsed CLI flag yielding `NaN`) is treated as
 * absent and falls through, which the old `parseInt()`-then-`||` chains did implicitly.
 */

/** Optional sources shared by all three resolvers below. */
export interface SyncLimitConfigSources {
  postsSyncLimit?: number | null;
  /** Legacy spelling kept for pre-v0.1.x workspaces (posts window only). */
  syncLimit?: number | null;
  mediaSyncLimit?: number | null;
  concurrency?: number | null;
}

/** Explicit argument passed by a consumer (CLI flag, MCP tool argument, orchestrator option). */
export interface SyncLimitOverrides {
  postsSyncLimit?: number | null;
  mediaSyncLimit?: number | null;
  concurrency?: number | null;
}

function firstUsable(...values: Array<number | null | undefined>): number | undefined {
  for (const value of values) {
    // Preserve the pre-refactor `||` semantics exactly: falsy values (0, NaN) fall through.
    if (!value) {
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

/**
 * Resolve the batch article window: explicit argument > `postsSyncLimit` > legacy `syncLimit`
 * > `DEFAULT_CONFIG.postsSyncLimit`.
 */
export function resolvePostsSyncLimit(
  config: SyncLimitConfigSources,
  overrides: SyncLimitOverrides = {},
): number {
  return (
    firstUsable(overrides.postsSyncLimit, config.postsSyncLimit, config.syncLimit) ??
    DEFAULT_CONFIG.postsSyncLimit
  );
}

/**
 * Resolve the media library walk bound: explicit argument > `mediaSyncLimit` >
 * `DEFAULT_CONFIG.mediaSyncLimit`.
 */
export function resolveMediaSyncLimit(
  config: SyncLimitConfigSources,
  overrides: SyncLimitOverrides = {},
): number {
  return (
    firstUsable(overrides.mediaSyncLimit, config.mediaSyncLimit) ?? DEFAULT_CONFIG.mediaSyncLimit
  );
}

/**
 * Resolve the batch pull concurrency pool width: explicit argument > `config.concurrency` >
 * `DEFAULT_CONFIG.concurrency`. The canonical default is read from `DEFAULT_CONFIG`, never
 * re-spelled at call sites.
 */
export function resolveConcurrency(
  config: SyncLimitConfigSources,
  overrides: SyncLimitOverrides = {},
): number {
  return firstUsable(overrides.concurrency, config.concurrency) ?? DEFAULT_CONFIG.concurrency;
}
