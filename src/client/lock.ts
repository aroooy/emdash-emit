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

export interface LockHolder {
  userId: string;
  userName: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface LockResponse {
  enabled: boolean;
  holder: LockHolder | null;
  heldByCaller: boolean;
}

import { authenticatedFetch, createAuthedFetch } from './http.js';

export interface LockClientOptions {
  origin: string;
  token: string;
  refreshToken?: string;
  fetchFn?: typeof fetch;
}

export class EntryLockError extends Error {
  public code: string;
  public holder?: LockHolder | null;

  constructor(message: string, code: string, holder?: LockHolder | null) {
    super(message);
    this.name = 'EntryLockError';
    this.code = code;
    this.holder = holder;
  }
}

function createLockFetch(options: LockClientOptions) {
  return createAuthedFetch(options);
}

/**
 * Checks lock status using GET /_emdash/api/content/{collection}/{id}/lock.
 */
export async function getLockStatus(
  collection: string,
  id: string,
  options: LockClientOptions,
): Promise<LockResponse> {
  const fetchFn = createLockFetch(options);
  const url = new URL(`/_emdash/api/content/${collection}/${id}/lock`, options.origin).toString();

  const res = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new EntryLockError(
      `Failed to get lock status for ${collection}/${id}: ${res.statusText}`,
      'LOCK_STATUS_ERROR',
    );
  }

  return (await res.json()) as LockResponse;
}

/**
 * Acquires a 7-minute lease lock using POST /_emdash/api/content/{collection}/{id}/lock.
 * Throws EntryLockError if another user holds the lock.
 */
export async function acquireLock(
  collection: string,
  id: string,
  options: LockClientOptions,
): Promise<LockResponse> {
  const fetchFn = createLockFetch(options);
  const url = new URL(`/_emdash/api/content/${collection}/${id}/lock`, options.origin).toString();

  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: 'application/json',
    },
  });

  const json = (await res.json()) as LockResponse;

  if (json.holder && !json.heldByCaller) {
    throw new EntryLockError(
      `Entry '${id}' is currently locked by ${json.holder.userName} (expires at ${json.holder.expiresAt}).`,
      'ENTRY_LOCKED',
      json.holder,
    );
  }

  return json;
}

/**
 * Releases the lease lock using DELETE /_emdash/api/content/{collection}/{id}/lock.
 */
export async function releaseLock(
  collection: string,
  id: string,
  options: LockClientOptions,
): Promise<void> {
  const fetchFn = createLockFetch(options);
  const url = new URL(`/_emdash/api/content/${collection}/${id}/lock`, options.origin).toString();

  try {
    await fetchFn(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${options.token}`,
      },
    });
  } catch {
    // Best-effort release; do not crash caller if network fails on release
  }
}

/**
 * Executes a callback within a lock lease context, ensuring lock release via try/finally.
 */
export async function withEntryLock<T>(
  collection: string,
  id: string,
  options: LockClientOptions,
  action: () => Promise<T>,
): Promise<T> {
  await acquireLock(collection, id, options);
  try {
    return await action();
  } finally {
    await releaseLock(collection, id, options);
  }
}
