/*
 * Copyright (C) 2026 SPORT-SERVICE RS★R
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * v0.1.38 P1 — one shared description of WHY a profile was chosen.
 *
 * The MCP server already reports its resolution path on every response (`_meta.resolvedBy`), but the CLI
 * never said anything: `emit profile current` printed only the winner, and `profile list` marked the
 * `active` entry with a bare `(active)` even though a current-directory match silently outranks it. In a
 * multi-site workspace that reads as "I must switch profiles", which is both wrong and dangerous — the
 * user switches to the profile they are already using, or pushes to the site they did not mean to.
 *
 * This module is Layer 0 on purpose: `src/cli/commands/profile.ts` and `src/mcp/tools/profile.ts` are
 * siblings in Layer 3 that must not import each other (AGENTS.md Axis 3), so the wording lives here and
 * both consumers call the same function. A string literal defined twice would break the symmetry that
 * `tests/presentation_symmetry.test.ts` protects.
 *
 * Deliberately pure: no disk access, no environment reads. The caller already resolved everything, and
 * resolution must never disagree with what the command actually used.
 */

import type { ResolveProfileResult, WorkspaceLinkDrift } from './profile.js';

/**
 * Discriminated presentation source. Broader than `ResolveProfileResult.source`, which collapses the two
 * directory-driven matches into a single `'workspace'` value; the caller supplies `cwdMatched` so this
 * layer can tell them apart without widening Layer 0's public signature (v0.1.38 plan §6 X-7).
 */
export type ProfileResolutionSource =
  'explicit' | 'workspace-dir' | 'workspace-origin' | 'single' | 'active';

/**
 * The marker `emit profile list` puts on the `active` entry. It lives here because CLI and MCP both name
 * that profile, and "the active one" alone reads as "commands will use it" — which a registered directory
 * match silently overrides. One constant keeps the two surfaces from drifting apart.
 */
export const ACTIVE_DEFAULT_MARKER = '(active default — used only outside registered workspaces)';

/** The marker for the profile whose registered workspace contains the current directory. */
export const CWD_MATCH_MARKER = '(matches current directory)';

/**
 * The remediation both CLI and MCP name when a profile's registered workspace no longer matches the
 * workspace in use (v0.1.38 P2). `emit init --profile` is the only supported way to re-link, so one shared
 * string keeps a warning from pointing at a command that cannot do the job.
 */
export function formatRelinkSuggestion(profileName: string): string {
  return `emit init --profile ${profileName}`;
}

/**
 * The drift warning shared by the CLI context resolver and `emit doctor` (v0.1.38 P2), returned as separate
 * lines so each surface renders it its own way — the CLI prints prose, doctor emits a structured check. Both
 * paths are stated verbatim because guessing which one the user meant is exactly what the drift made
 * impossible, and no reason for the mismatch is invented: Emit observes two paths, not why they diverged.
 */
export function workspaceLinkDriftLines(drift: WorkspaceLinkDrift): {
  headline: string;
  detail: string;
  relinkCommand: string;
} {
  return {
    headline: `Profile "${drift.profileName}" is registered to ${drift.registeredWorkspace}, but this command runs in a different directory.`,
    detail: `Emit is using the registered path (${drift.registeredWorkspace}) for the connection, while the workspace being operated on is ${drift.actualWorkspace}.`,
    relinkCommand: formatRelinkSuggestion(drift.profileName),
  };
}

/** The CLI rendering of {@link workspaceLinkDriftLines}: one wrapped warning block on stderr. */
export function formatWorkspaceLinkDriftWarning(drift: WorkspaceLinkDrift): string {
  const lines = workspaceLinkDriftLines(drift);
  return [
    `⚠️ ${lines.headline}`,
    `   ${lines.detail}`,
    `   Re-link it with: ${lines.relinkCommand}`,
  ].join('\n');
}

/**
 * Normalizes the raw resolver result into a display source.
 *
 * `resolveTargetProfile()` reports `'workspace'` for both a current-directory match and an origin match,
 * so `cwdMatched` — whether `findProfileByDirectory()` matched — is what discriminates them. An origin
 * match can never be reported as a directory match: claiming the folder decided it when the folder was
 * not registered would be exactly the kind of unfounded assertion Emit refuses to make.
 */
export function toResolutionSource(
  result: ResolveProfileResult,
  cwdMatched: boolean,
): ProfileResolutionSource {
  switch (result.source) {
    case 'explicit':
      return 'explicit';
    case 'workspace':
      return cwdMatched ? 'workspace-dir' : 'workspace-origin';
    case 'single':
      return 'single';
    case 'active':
      return 'active';
  }
}

export interface ResolutionRationaleOptions {
  profileName: string;
  /** The workspace path registered on the profile, when there is one. */
  workspacePath?: string;
  /** The directory resolution ran from. Never printed verbatim unless a match is being named. */
  cwd: string;
}

/**
 * One-line explanation shared verbatim by CLI and MCP. Carries no token material — a rationale line that
 * leaked a PAT into terminal scrollback or an agent transcript would undo the credential handling Emit
 * already has.
 */
export function formatResolutionRationale(
  source: ProfileResolutionSource,
  opts: ResolutionRationaleOptions,
): string {
  switch (source) {
    case 'workspace-dir':
      return `current directory match (${opts.workspacePath ?? opts.cwd})`;
    case 'workspace-origin':
      return `origin match (.emit/config.json -> profile "${opts.profileName}")`;
    case 'explicit':
      return `explicit --profile "${opts.profileName}"`;
    case 'single':
      return 'only configured profile';
    case 'active':
      return 'active default (no directory match — a registered workspace directory always outranks this)';
  }
}

/**
 * The label `emit profile list` and MCP `profile_list` give the profile that a command run in the current
 * directory would actually select. Kept as one helper so the two surfaces cannot drift into naming
 * different profiles "the one in use".
 */
export function cwdMatchedProfileName(
  names: string[],
  matchesDirectory: (name: string) => boolean,
): string | null {
  for (const name of names) {
    if (matchesDirectory(name)) return name;
  }
  return null;
}
