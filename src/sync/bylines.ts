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

import { type CacheDatabase, type BylineRecord } from '../db/cache.js';
import { createAuthedFetch } from '../client/http.js';

export interface BylineMaps {
  slugToId: Record<string, string>;
  idToSlug: Record<string, string>;
}

export interface SyncBylinesOptions {
  origin: string;
  token: string;
  refreshToken?: string;
  cache: CacheDatabase;
  fetchFn?: typeof fetch;
}

interface RawBylineItem {
  id?: string;
  slug?: string;
  displayName?: string;
  isGuest?: boolean;
  [key: string]: unknown;
}

/**
 * Parses raw JSON-RPC result from EmDash /_emdash/api/mcp endpoint.
 * Handles both Server-Sent Events (SSE) format ("data: {...}") and plain JSON responses.
 */
function parseMcpToolCallText(rawBody: string): string | null {
  const trimmed = rawBody.trim();
  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed) as {
        result?: { content?: Array<{ type?: string; text?: string }> };
      };
      return json.result?.content?.[0]?.text || null;
    } catch {
      return null;
    }
  }

  // Handle SSE data: lines
  const dataLine = rawBody.split('\n').find((l) => l.startsWith('data:'));
  if (dataLine) {
    try {
      const jsonStr = dataLine.replace(/^data:\s*/, '').trim();
      const json = JSON.parse(jsonStr) as {
        result?: { content?: Array<{ type?: string; text?: string }> };
      };
      return json.result?.content?.[0]?.text || null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Synchronizes remote bylines from EmDash into the local SQLite database cache.
 * Automatically called on pull commands to ensure local author metadata is always fresh.
 * Gracefully falls back to existing cache if remote is unreachable.
 */
export async function syncRemoteBylines(options: SyncBylinesOptions): Promise<BylineMaps> {
  const fetchFn = createAuthedFetch(options);

  try {
    const mcpUrl = new URL('/_emdash/api/mcp', options.origin).toString();
    const res = await fetchFn(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'byline_list',
          arguments: { limit: 100 },
        },
      }),
    });

    if (res.ok) {
      const responseText = await res.text();
      const toolText = parseMcpToolCallText(responseText);

      if (toolText) {
        const parsed = JSON.parse(toolText) as { items?: RawBylineItem[] };
        const rawItems = Array.isArray(parsed.items) ? parsed.items : [];

        const records: BylineRecord[] = [];
        const now = Math.floor(Date.now() / 1000);

        for (const item of rawItems) {
          if (item.id && item.slug) {
            records.push({
              id: item.id,
              slug: item.slug,
              displayName: item.displayName || item.slug,
              isGuest: Boolean(item.isGuest),
              rawJson: JSON.stringify(item),
              updatedAt: now,
            });
          }
        }

        options.cache.saveBylines(records, true);
      }
    }
  } catch {
    // Non-fatal: if remote byline sync fails (e.g. offline, permissions), proceed with existing cache
  }

  return options.cache.getBylineMaps();
}

/**
 * Returns cached slugToId and idToSlug maps directly from local DB.
 */
export function loadLocalBylineMaps(cache: CacheDatabase): BylineMaps {
  return cache.getBylineMaps();
}
