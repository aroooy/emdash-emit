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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasRequiredScope,
  refreshAccessToken,
  resolveAuth,
  type EmDashAuthData,
} from '../src/client/auth.js';

describe('Auth Resolution & OAuth Token Management', () => {
  let tempDir: string;
  let mockAuthPath: string;
  let emptyProfilesPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-auth-test-'));
    mockAuthPath = path.join(tempDir, 'auth.json');
    emptyProfilesPath = path.join(tempDir, 'profiles.yaml');
    fs.writeFileSync(emptyProfilesPath, 'profiles: {}\n');
    delete process.env.EMDASH_TOKEN;
    delete process.env.EMDASH_API_TOKEN;
    delete process.env.EMDASH_ORIGIN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('resolves auth from environment variables as top priority', () => {
    process.env.EMDASH_TOKEN = 'token-from-env-123';
    process.env.EMDASH_ORIGIN = 'https://custom.emdash.io';

    const auth = resolveAuth({
      emdashAuthPath: mockAuthPath,
      customProfilesPath: emptyProfilesPath,
    });
    expect(auth).not.toBeNull();
    expect(auth?.source).toBe('env');
    expect(auth?.token).toBe('token-from-env-123');
    expect(auth?.origin).toBe('https://custom.emdash.io');
  });

  it('resolves auth from ~/.config/emdash/auth.json when env is not set', () => {
    const authData: EmDashAuthData = {
      origin: 'https://aroooy.net',
      access_token: 'cli-access-token-456',
      refresh_token: 'cli-refresh-token-789',
      tokenScopes: ['content:read', 'content:write', 'content:publish'],
    };
    fs.writeFileSync(mockAuthPath, JSON.stringify(authData));

    const auth = resolveAuth({
      emdashAuthPath: mockAuthPath,
      customProfilesPath: emptyProfilesPath,
    });
    expect(auth).not.toBeNull();
    expect(auth?.source).toBe('emdash-cli');
    expect(auth?.token).toBe('cli-access-token-456');
    expect(auth?.origin).toBe('https://aroooy.net');
    expect(auth?.refreshToken).toBe('cli-refresh-token-789');
    expect(auth?.scopes).toEqual(['content:read', 'content:write', 'content:publish']);
  });

  it('validates required scopes properly', () => {
    expect(hasRequiredScope(['content:read', 'content:write'], 'content:read')).toBe(true);
    expect(hasRequiredScope(['content:read', 'content:write'], 'content:publish')).toBe(false);
    expect(hasRequiredScope(['*'], 'content:publish')).toBe(true);
    expect(hasRequiredScope(['admin'], 'content:publish')).toBe(true);
    expect(hasRequiredScope(undefined, 'content:publish')).toBe(true);
  });

  it('refreshes expired token and persists new token to auth file', async () => {
    const authData: EmDashAuthData = {
      origin: 'https://aroooy.net',
      access_token: 'old-access-token',
      refresh_token: 'valid-refresh-token',
      tokenScopes: ['content:read', 'content:write'],
    };
    fs.writeFileSync(mockAuthPath, JSON.stringify(authData));

    const auth = resolveAuth({
      emdashAuthPath: mockAuthPath,
      customProfilesPath: emptyProfilesPath,
    })!;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-refreshed-token',
        refresh_token: 'new-refreshed-refresh-token',
        tokenScopes: ['content:read', 'content:write', 'content:publish'],
      }),
    });

    const refreshed = await refreshAccessToken(
      auth,
      mockAuthPath,
      mockFetch as unknown as typeof fetch,
    );

    expect(refreshed.token).toBe('new-refreshed-token');
    expect(refreshed.refreshToken).toBe('new-refreshed-refresh-token');

    // Verify persisted file content
    const updatedFileContent = JSON.parse(fs.readFileSync(mockAuthPath, 'utf8')) as EmDashAuthData;
    expect(updatedFileContent.access_token).toBe('new-refreshed-token');
    expect(updatedFileContent.refresh_token).toBe('new-refreshed-refresh-token');
  });

  it('throws helpful error when token refresh fails', async () => {
    const authData: EmDashAuthData = {
      origin: 'https://aroooy.net',
      access_token: 'old-access-token',
      refresh_token: 'revoked-refresh-token',
    };
    fs.writeFileSync(mockAuthPath, JSON.stringify(authData));

    const auth = resolveAuth({
      emdashAuthPath: mockAuthPath,
      customProfilesPath: emptyProfilesPath,
    })!;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });

    await expect(
      refreshAccessToken(auth, mockAuthPath, mockFetch as unknown as typeof fetch),
    ).rejects.toThrowError(/Token refresh failed with status 401/i);
  });
});
