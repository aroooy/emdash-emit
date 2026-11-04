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

import { refreshAccessToken, type ResolvedAuth } from './auth.js';

export interface AuthenticatedFetchOptions extends RequestInit {
  auth?: ResolvedAuth;
  token?: string;
  refreshToken?: string;
  origin?: string;
  timeoutMs?: number;
  onTokenRefreshed?: (newAuth: ResolvedAuth) => void;
  fetchFn?: typeof fetch;
}

export interface AuthedFetchFactoryOptions {
  token?: string;
  refreshToken?: string;
  origin?: string;
  auth?: ResolvedAuth;
  timeoutMs?: number;
  onTokenRefreshed?: (newAuth: ResolvedAuth) => void;
  fetchFn?: typeof fetch;
}

/**
 * Creates a fetch-compatible closure pre-bound with authentication, automatic 401 refresh,
 * and a default 30-second timeout per attempt.
 */
export function createAuthedFetch(options: AuthedFetchFactoryOptions): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit) =>
    authenticatedFetch(input, {
      ...init,
      auth: options.auth,
      token: options.token,
      refreshToken: options.refreshToken,
      origin: options.origin,
      timeoutMs: options.timeoutMs,
      onTokenRefreshed: options.onTokenRefreshed,
      fetchFn: options.fetchFn,
    });
}

/**
 * Executes a fetch request with automatic OAuth token refresh on 401 Unauthorized.
 * If token/auth has a refreshToken and the server responds with 401, attempts to refresh
 * the token and retries the request once with the new token.
 */
export async function authenticatedFetch(
  input: string | URL | Request,
  options: AuthenticatedFetchOptions = {},
): Promise<Response> {
  const fetchFn = options.fetchFn || fetch;
  const { auth, token, refreshToken, origin, onTokenRefreshed, ...requestInit } = options;

  const effectiveToken = auth?.token || token;
  const effectiveRefreshToken = auth?.refreshToken || refreshToken;
  const effectiveOrigin = auth?.origin || origin;
  const timeoutMs = options.timeoutMs ?? 30_000;

  let headers = new Headers(requestInit.headers);
  if (effectiveToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${effectiveToken}`);
  }

  // Create per-request abort signal with timeout if caller did not supply one
  const getSignal = () => {
    if (requestInit.signal) return requestInit.signal;
    if (timeoutMs > 0 && typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
      return AbortSignal.timeout(timeoutMs);
    }
    return undefined;
  };

  let response = await fetchFn(input, {
    ...requestInit,
    headers,
    signal: getSignal(),
  });

  // If 401 and we have a refresh token, attempt automatic token recovery
  if (response.status === 401 && effectiveRefreshToken && effectiveOrigin) {
    try {
      const authToRefresh: ResolvedAuth = auth || {
        source: 'emdash-cli',
        token: effectiveToken || '',
        refreshToken: effectiveRefreshToken,
        origin: effectiveOrigin,
      };

      const refreshed = await refreshAccessToken(authToRefresh, undefined, fetchFn);
      if (onTokenRefreshed) {
        onTokenRefreshed(refreshed);
      }

      // Retry original request once with new token and a fresh timeout signal
      const retryHeaders = new Headers(requestInit.headers);
      retryHeaders.set('Authorization', `Bearer ${refreshed.token}`);

      response = await fetchFn(input, {
        ...requestInit,
        headers: retryHeaders,
        signal: getSignal(),
      });
    } catch {
      // If refresh fails, return original 401 response so caller can handle
    }
  }

  return response;
}
