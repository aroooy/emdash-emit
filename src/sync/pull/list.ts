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
import { createAuthedFetch } from '../../client/http.js';
import { unwrapEnvelope, unwrapItem, extractRev } from '../../client/api.js';
import { articleContentEndpoint, openApiEndpoint } from '../../client/endpoints.js';
import type { ListRemoteArticlesOptions, RemoteArticleItem } from './types.js';

/**
 * Resolves the canonical article title from remote data symmetrically across
 * fast-path and full-pull (EMIT-005 / v0.1.14 backlog §1).
 */
export function extractCanonicalRemoteTitle(
  rawObj: Record<string, unknown>,
  fallbackSlug?: string,
): string {
  const item = unwrapItem<Record<string, unknown>>(rawObj);
  const data = ((item.data || {}) as Record<string, unknown>) || {};
  const rawTitle = String(data.title || item.title || '').trim();
  if (rawTitle) return rawTitle;
  const rawSlug = String(item.slug || fallbackSlug || '').trim();
  if (rawSlug) return rawSlug;
  return 'Untitled';
}

/**
 * Discovers the server's maximum allowed limit for content list queries from /_emdash/api/openapi.json.
 * Defaults to 100 if openapi.json cannot be fetched or parsed.
 */
export async function getRemoteMaxBatchLimit(options: {
  origin: string;
  token?: string;
  fetchFn?: typeof fetch;
}): Promise<number> {
  const fetchFn = options.fetchFn || fetch;
  try {
    const url = openApiEndpoint(options.origin);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    const res = await fetchFn(url, { headers });
    if (!res.ok) return 100;

    const json = (await res.json()) as Record<string, unknown>;
    const paths = (json.paths || {}) as Record<string, Record<string, unknown>>;
    const getEndpoint =
      paths['/_emdash/api/content/{collection}']?.get || paths['/content/{collection}']?.get;

    if (getEndpoint && Array.isArray((getEndpoint as Record<string, unknown>).parameters)) {
      const params = (getEndpoint as Record<string, unknown>).parameters as Array<
        Record<string, unknown>
      >;
      const limitParam = params.find((p) => p.name === 'limit');
      const schema = (limitParam?.schema || {}) as Record<string, unknown>;
      if (typeof schema.maximum === 'number' && schema.maximum > 0) {
        return schema.maximum;
      }
    }
  } catch {
    // Ignore network or parse error, fallback to safe 100
  }
  return 100;
}

/**
 * Fetches articles for a specific status ('draft' or 'published') using cursor pagination.
 */
async function fetchStatusArticles(
  collection: string,
  status: 'draft' | 'published',
  options: ListRemoteArticlesOptions,
  serverMaxLimit: number,
): Promise<RemoteArticleItem[]> {
  const fetchFn = createAuthedFetch(options);
  const targetTotal = options.all ? Infinity : (options.limit ?? 100);

  const items: RemoteArticleItem[] = [];
  let cursor: string | undefined = undefined;
  let batchLimit = serverMaxLimit;

  while (items.length < targetTotal) {
    const remaining = targetTotal - items.length;
    const currentBatch = Math.min(remaining, batchLimit);

    const url = new URL(articleContentEndpoint(options.origin, collection));
    url.searchParams.set('status', status);
    url.searchParams.set('limit', String(currentBatch));
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    let res = await fetchFn(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/json',
      },
    });

    // Adaptive fallback if server responds with validation error on limit
    if (!res.ok && res.status === 400) {
      try {
        const errJson = (await res.clone().json()) as Record<string, unknown>;
        const errMsg = JSON.stringify(errJson);
        const match = errMsg.match(/expected number to be <=(\d+)/);
        if (match && Number(match[1]) < batchLimit) {
          batchLimit = Number(match[1]);
          url.searchParams.set('limit', String(Math.min(remaining, batchLimit)));
          res = await fetchFn(url.toString(), {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${options.token}`,
              Accept: 'application/json',
            },
          });
        }
      } catch {
        // Continue to normal error handling below
      }
    }

    if (!res.ok) {
      throw new ApiError({
        message: `Failed to list remote articles (${status}): ${res.statusText}`,
        code: 'ARTICLE_LIST_FAILED',
        status: res.status,
        endpoint: url.toString(),
        suggestion: 'Verify network connection, permissions, or try lowering the limit.',
      });
    }

    const json = await res.json();
    const data = unwrapEnvelope<Record<string, unknown>>(json);
    const rawItems = (
      Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : []
    ) as Array<Record<string, unknown>>;

    if (rawItems.length === 0) {
      break;
    }

    for (const raw of rawItems) {
      const rawData = (raw.data || {}) as Record<string, unknown>;
      const rev = extractRev(raw, '1');
      items.push({
        id: String(raw.id),
        slug: String(raw.slug || ''),
        status: String(raw.status || status),
        title: String(rawData.title || raw.title || 'Untitled'),
        _rev: rev,
        rawItem: raw,
      });

      if (items.length >= targetTotal) {
        break;
      }
    }

    if (!data.nextCursor || typeof data.nextCursor !== 'string') {
      break;
    }
    cursor = data.nextCursor;
  }

  return items;
}

/**
 * Lists articles from EmDash API with cursor pagination and dynamic batch size detection.
 * When status is not specified or 'all', fetches up to `limit` published articles AND
 * up to `limit` draft articles in parallel, ensuring drafts and published posts are both covered.
 */
export async function listRemoteArticles(
  collection: string,
  options: ListRemoteArticlesOptions,
): Promise<RemoteArticleItem[]> {
  const serverMaxLimit = options.batchSize || (await getRemoteMaxBatchLimit(options));

  // If a specific status is explicitly requested
  if (options.status === 'draft' || options.status === 'published') {
    return fetchStatusArticles(collection, options.status, options, serverMaxLimit);
  }

  // Default: Fetch both published (up to limit) and draft (up to limit) in parallel
  const [draftItems, publishedItems] = await Promise.all([
    fetchStatusArticles(collection, 'draft', options, serverMaxLimit),
    fetchStatusArticles(collection, 'published', options, serverMaxLimit),
  ]);

  return [...draftItems, ...publishedItems];
}
