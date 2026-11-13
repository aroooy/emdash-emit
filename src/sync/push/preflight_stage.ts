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

import { runPreflightChecks, type PreflightResult } from '../preflight.js';
import type { ParsedMarkdown } from '../../utils/frontmatter.js';
import type { BaseSnapshot, SyncState } from '../../db/cache.js';
import { PushValidationError } from './guards.js';
import type { PushOptions } from './types.js';

export function executePreflightStage(
  targetFilePath: string,
  parsed: ParsedMarkdown,
  options: PushOptions,
  syncState: SyncState | null | undefined,
  baseSnapshot: BaseSnapshot | null | undefined,
  knownTaxonomies?: Record<string, string[]>,
): PreflightResult {
  const preflight = runPreflightChecks(targetFilePath, parsed, {
    allowPublish: options.allowPublish,
    knownTaxonomies,
    baseMarkdown: baseSnapshot?.bodyMarkdown,
    previousStatus: (syncState?.status as 'draft' | 'published') || 'draft',
    workspaceRoot: options.workspaceRoot,
    cache: options.cache,
  });

  if (!preflight.valid) {
    throw new PushValidationError(
      `Push blocked by Preflight Guards (${preflight.errors.length} error(s)).`,
      preflight.errors,
    );
  }

  // Update parsed with cleaned body (e.g. trimmed duplicate heading)
  parsed.body = preflight.cleanedBody;

  return preflight;
}
