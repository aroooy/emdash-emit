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

import { describe, it, expect, vi } from 'vitest';
import { authenticatedFetch } from '../src/client/http.js';
import { ApiError } from '../src/client/error.js';
import type { ResolvedAuth } from '../src/client/auth.js';

describe('authenticatedFetch (401 Auto-Recovery)', () => {
  it('passes through successful responses normally', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const auth: ResolvedAuth = {
      source: 'env',
      token: 'valid-token',
    };

    const res = await authenticatedFetch('https://example.com/api', {
      auth,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('automatically refreshes token on 401 and retries request once', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      callCount++;
      if (url.includes('/_emdash/api/auth/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'new-refreshed-token-999',
            refresh_token: 'new-refresh-token',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // First API call returns 401
      if (callCount === 1) {
        return new Response('Unauthorized', { status: 401 });
      }

      // Second API call succeeds with refreshed token
      const authHeader = (init?.headers as Headers).get('Authorization');
      if (authHeader === 'Bearer new-refreshed-token-999') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }

      return new Response('Forbidden', { status: 403 });
    });

    const auth: ResolvedAuth = {
      source: 'emdash-cli',
      token: 'expired-token',
      refreshToken: 'valid-refresh-token',
      origin: 'https://example.com',
    };

    let updatedToken = '';
    const res = await authenticatedFetch('https://example.com/api/content', {
      auth,
      onTokenRefreshed: (newAuth) => {
        updatedToken = newAuth.token;
      },
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.status).toBe(200);
    expect(updatedToken).toBe('new-refreshed-token-999');
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1. Initial 401 -> 2. Refresh token -> 3. Retry with new token
  });

  it('normalizes low-level fetch network failures (DNS/connection errors) into actionable ApiError (NETWORK_ERROR)', async () => {
    const netErr = new TypeError('fetch failed', {
      cause: new Error('getaddrinfo ENOTFOUND solo.example.com'),
    });
    const mockFetch = vi.fn().mockRejectedValue(netErr);

    let caught: unknown;
    try {
      await authenticatedFetch('https://solo.example.com/_emdash/api/content/posts', {
        token: 'tok-123',
        fetchFn: mockFetch as unknown as typeof fetch,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const apiErr = caught as ApiError;
    expect(apiErr.code).toBe('NETWORK_ERROR');
    expect(apiErr.endpoint).toBe('https://solo.example.com/_emdash/api/content/posts');
    expect(apiErr.message).toContain('fetch failed');
    expect(apiErr.message).toContain('getaddrinfo ENOTFOUND solo.example.com');
    expect(apiErr.toActionableString()).toContain('💡 Suggestion:');
  });
});
