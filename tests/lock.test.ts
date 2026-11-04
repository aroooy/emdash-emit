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

import { describe, expect, it, vi } from 'vitest';
import {
  acquireLock,
  EntryLockError,
  getLockStatus,
  releaseLock,
  withEntryLock,
  type LockResponse,
} from '../src/client/lock.js';

describe('Lock Protocol (POST /lock -> action -> DELETE /lock)', () => {
  const options = {
    origin: 'https://aroooy.net',
    token: 'test-token',
  };

  it('gets lock status using GET', async () => {
    const mockResponse: LockResponse = {
      enabled: true,
      holder: null,
      heldByCaller: false,
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const status = await getLockStatus('posts', '01M67MP2W0VKCK2DFWM166CR24', {
      ...options,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(status.enabled).toBe(true);
    expect(status.holder).toBeNull();
    expect(mockFetch).toHaveBeenCalledWith(
      'https://aroooy.net/_emdash/api/content/posts/01M67MP2W0VKCK2DFWM166CR24/lock',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('acquires lock when free or held by caller', async () => {
    const mockResponse: LockResponse = {
      enabled: true,
      holder: {
        userId: 'u1',
        userName: 'hiroaki',
        acquiredAt: '2026-11-02T10:00:00Z',
        expiresAt: '2026-11-02T10:07:00Z',
      },
      heldByCaller: true,
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const res = await acquireLock('posts', '01M67MP2W0VKCK2DFWM166CR24', {
      ...options,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(res.heldByCaller).toBe(true);
  });

  it('throws EntryLockError when held by someone else', async () => {
    const mockResponse: LockResponse = {
      enabled: true,
      holder: {
        userId: 'u2',
        userName: 'other-editor',
        acquiredAt: '2026-11-02T10:00:00Z',
        expiresAt: '2026-11-02T10:07:00Z',
      },
      heldByCaller: false,
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    await expect(
      acquireLock('posts', '01M67MP2W0VKCK2DFWM166CR24', {
        ...options,
        fetchFn: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrowError(EntryLockError);
  });

  it('withEntryLock executes action and always releases lock in finally block', async () => {
    const lockAcquired: LockResponse = {
      enabled: true,
      holder: {
        userId: 'u1',
        userName: 'hiroaki',
        acquiredAt: '2026-11-02T10:00:00Z',
        expiresAt: '2026-11-02T10:07:00Z',
      },
      heldByCaller: true,
    };

    const mockFetch = vi.fn().mockImplementation((url, init) => {
      if (init.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => lockAcquired });
      }
      if (init.method === 'DELETE') {
        return Promise.resolve({ ok: true });
      }
      return Promise.reject(new Error('Unexpected method'));
    });

    // 1. Successful action
    let executed = false;
    await withEntryLock(
      'posts',
      '01M67MP2W0VKCK2DFWM166CR24',
      { ...options, fetchFn: mockFetch as unknown as typeof fetch },
      async () => {
        executed = true;
      },
    );
    expect(executed).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/lock'),
      expect.objectContaining({ method: 'DELETE' }),
    );

    // 2. Failed action (throws)
    mockFetch.mockClear();
    await expect(
      withEntryLock(
        'posts',
        '01M67MP2W0VKCK2DFWM166CR24',
        { ...options, fetchFn: mockFetch as unknown as typeof fetch },
        async () => {
          throw new Error('Action failed!');
        },
      ),
    ).rejects.toThrowError('Action failed!');

    // DELETE must still be called in finally block
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/lock'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
