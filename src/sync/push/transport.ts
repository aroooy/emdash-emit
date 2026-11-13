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

import { ApiError } from '../../client/error.js';
import { extractRev } from '../../client/api.js';
import { articleStatusTransitionEndpoint } from '../../client/endpoints.js';
import type { PushOptions } from './types.js';

/**
 * Transitions article publish/draft status via dedicated EmDash endpoints.
 */
export async function transitionContentStatus(
  collection: string,
  id: string,
  targetStatus: 'draft' | 'published',
  currentRev: string,
  publishedAt: string | null | undefined,
  options: PushOptions,
  fetchFn: typeof fetch,
): Promise<string> {
  const isPublishing = targetStatus === 'published';
  const endpoint = articleStatusTransitionEndpoint(
    options.origin,
    collection,
    id,
    isPublishing ? 'publish' : 'unpublish',
  );

  const body: Record<string, unknown> = { _rev: currentRev };
  if (isPublishing && publishedAt) {
    body.publishedAt = publishedAt;
  }

  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new ApiError({
      message: `Failed to ${isPublishing ? 'publish' : 'unpublish'} content: ${res.statusText}${errText ? ` - ${errText}` : ''}`,
      code: isPublishing ? 'PUBLISH_FAILED' : 'UNPUBLISH_FAILED',
      status: res.status,
      endpoint,
      suggestion: isPublishing
        ? 'Verify publish permissions and revision state.'
        : 'Verify unpublish permissions and revision state.',
    });
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return extractRev(json, currentRev);
}

/**
 * Standardized error thrower when a remote article 404s or 410s on update.
 */
export function throwRemoteArticleDeleted(
  collection: string,
  id: string,
  targetFilePath: string,
  endpoint: string,
): never {
  throw new ApiError({
    endpoint,
    code: 'REMOTE_ARTICLE_DELETED',
    status: 404,
    message: `Article ${id} (${targetFilePath}) was deleted on the remote server.`,
    suggestion: [
      '1. Keep your edits and re-create as a new article: remove the `id:` field from frontmatter, then "emit push <file>".',
      `2. Discard local edits and untrack: "emit pull ${id} --force"   (local copy is preserved under posts/conflicts/)`,
      `3. Delete with rescue backup: "emit delete ${targetFilePath} --discard-local-edits"`,
    ].join('\n  '),
  });
}
