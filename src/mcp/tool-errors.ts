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

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ApiError } from '../client/error.js';
import { SyncPruneConflictError } from '../sync/orchestrator.js';
import { PushValidationError } from '../sync/push.js';
import { AmbiguousProfileError } from '../utils/profile.js';
import { FrontmatterParseError } from '../utils/frontmatter.js';
import { DuplicateSlugError } from '../sync/new.js';
import {
  UnpushedModificationsError,
  PublishedArticleDeletionForbiddenError,
} from '../sync/delete.js';

function toolError(text: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

/**
 * Formats a known Emit error into a structured MCP tool result.
 *
 * Without this, the MCP SDK converts a thrown error into `createToolError(String(error))`,
 * which keeps only `error.message` and silently drops the structured diagnostics
 * (`[CODE]`, HTTP status, endpoint, suggestion) that CLI users receive through
 * `ApiError.toActionableString()`. AI agents need the same actionable detail.
 */
export function formatToolError(error: unknown): CallToolResult {
  if (error instanceof ApiError) {
    return toolError(error.toActionableString());
  }

  if (error instanceof PushValidationError) {
    return toolError(
      JSON.stringify(
        {
          error: 'PREFLIGHT_VALIDATION_FAILED',
          message: error.message,
          errors: error.errors,
        },
        null,
        2,
      ),
    );
  }

  if (error instanceof FrontmatterParseError) {
    return toolError(
      JSON.stringify({
        error: error.code,
        message: error.message,
        filePath: error.filePath,
        line: error.line,
        reason: error.reason,
        suggestion: error.suggestion,
      }),
    );
  }

  if (error instanceof DuplicateSlugError) {
    return toolError(
      JSON.stringify(
        {
          error: error.code,
          message: error.message,
          slug: error.slug,
          existingId: error.existingId,
          existingFilePath: error.existingFilePath,
          existingStatus: error.existingStatus,
          suggestion: error.suggestion,
        },
        null,
        2,
      ),
    );
  }

  if (
    error instanceof UnpushedModificationsError ||
    error instanceof PublishedArticleDeletionForbiddenError
  ) {
    return toolError(
      JSON.stringify(
        {
          error: error.code,
          message: error.message,
          filePath: error.filePath,
          id: error.id,
          suggestion: error.suggestion,
        },
        null,
        2,
      ),
    );
  }

  if (error instanceof SyncPruneConflictError || error instanceof AmbiguousProfileError) {
    return toolError(`❌ ${error.message}`);
  }

  const message = error instanceof Error ? error.message : String(error);
  return toolError(`❌ ${message}`);
}
