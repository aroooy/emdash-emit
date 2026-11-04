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

import { resolveTargetProfile } from '../utils/profile.js';

export interface EmDashAuthData {
  origin?: string;
  access_token: string;
  refresh_token?: string;
  tokenScopes?: string[];
  expires_at?: number;
}

export interface ResolvedAuth {
  source: 'env' | 'profile' | 'emdash-cli' | 'emit-config';
  token: string;
  origin?: string;
  refreshToken?: string;
  scopes?: string[];
  profileName?: string;
  workspace?: string;
}

export interface AuthOptions {
  profile?: string;
  cwd?: string;
  customProfilesPath?: string;
  customConfigPath?: string;
  emdashAuthPath?: string;
}

/**
 * Resolves default path for EmDash CLI auth storage (~/.config/emdash/auth.json).
 */
export function getDefaultEmDashAuthPath(): string {
  return path.join(os.homedir(), '.config', 'emdash', 'auth.json');
}

/**
 * Resolves default path for Emit custom credentials (~/.config/emit/credentials.json).
 */
export function getDefaultEmitCredentialsPath(): string {
  return path.join(os.homedir(), '.config', 'emit', 'credentials.json');
}

/**
 * Resolves authentication credentials with prioritized fallback:
 * 1. Environment variables (EMDASH_TOKEN or EMDASH_API_TOKEN) -> Top priority for CI / one-off overrides
 * 2. Profile from ~/.config/emit/profiles.yaml (explicit profile, or workspace directory match, or single site)
 * 3. EmDash CLI credentials (~/.config/emdash/auth.json)
 * 4. Emit custom credentials (~/.config/emit/credentials.json)
 */
export function resolveAuth(options?: AuthOptions): ResolvedAuth | null {
  // 1. Environment variables (highest priority for overrides/CI)
  const envToken = process.env.EMDASH_TOKEN || process.env.EMDASH_API_TOKEN;
  if (envToken) {
    return {
      source: 'env',
      token: envToken,
      origin: process.env.EMDASH_ORIGIN,
    };
  }

  // 2. Profile from ~/.config/emit/profiles.yaml (may throw AmbiguousProfileError if multiple sites)
  const profileRes = resolveTargetProfile({
    profile: options?.profile,
    cwd: options?.cwd,
    customPath: options?.customProfilesPath,
  });

  if (profileRes && profileRes.config.token) {
    return {
      source: 'profile',
      token: profileRes.config.token,
      origin: profileRes.config.origin,
      profileName: profileRes.name,
      workspace: profileRes.config.workspace,
    };
  }

  // 3. EmDash CLI auth.json
  const emdashPath = options?.emdashAuthPath || getDefaultEmDashAuthPath();
  if (fs.existsSync(emdashPath)) {
    try {
      const raw = fs.readFileSync(emdashPath, 'utf8');
      const data = JSON.parse(raw) as EmDashAuthData;
      if (data.access_token) {
        return {
          source: 'emdash-cli',
          token: data.access_token,
          origin: data.origin,
          refreshToken: data.refresh_token,
          scopes: data.tokenScopes,
        };
      }
    } catch {
      // Ignore parse/read failure, try next tier
    }
  }

  // 4. Emit credentials.json
  const emitPath = options?.customConfigPath || getDefaultEmitCredentialsPath();
  if (fs.existsSync(emitPath)) {
    try {
      const raw = fs.readFileSync(emitPath, 'utf8');
      const data = JSON.parse(raw) as EmDashAuthData;
      if (data.access_token) {
        return {
          source: 'emit-config',
          token: data.access_token,
          origin: data.origin,
          refreshToken: data.refresh_token,
          scopes: data.tokenScopes,
        };
      }
    } catch {
      // Ignore parse/read failure
    }
  }

  return null;
}

/**
 * Validates whether the token has the required scope.
 */
export function hasRequiredScope(scopes: string[] | undefined, requiredScope: string): boolean {
  if (!scopes || scopes.length === 0) {
    // If scopes are not declared, assume allowed until API returns 403
    return true;
  }
  return scopes.includes(requiredScope) || scopes.includes('*') || scopes.includes('admin');
}

/**
 * Refreshes an expired OAuth access token using its refresh_token.
 */
export async function refreshAccessToken(
  auth: ResolvedAuth,
  authFilePath: string = getDefaultEmDashAuthPath(),
  fetchFn: typeof fetch = fetch,
): Promise<ResolvedAuth> {
  if (!auth.refreshToken || !auth.origin) {
    throw new Error(
      'Cannot refresh token: missing refresh_token or origin. Please run "emdash login" again.',
    );
  }

  const tokenUrl = new URL('/_emdash/api/auth/token', auth.origin).toString();
  const res = await fetchFn(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Token refresh failed with status ${res.status}. Please run "emdash login" to re-authenticate.`,
    );
  }

  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    tokenScopes?: string[];
  };

  const updatedAuth: ResolvedAuth = {
    ...auth,
    token: json.access_token,
    refreshToken: json.refresh_token || auth.refreshToken,
    scopes: json.tokenScopes || auth.scopes,
  };

  // Persist updated token to auth file if it originated from emdash-cli
  if (auth.source === 'emdash-cli' && fs.existsSync(authFilePath)) {
    try {
      const current = JSON.parse(fs.readFileSync(authFilePath, 'utf8')) as EmDashAuthData;
      current.access_token = updatedAuth.token;
      if (json.refresh_token) current.refresh_token = json.refresh_token;
      if (json.tokenScopes) current.tokenScopes = json.tokenScopes;
      fs.writeFileSync(authFilePath, JSON.stringify(current, null, 2), 'utf8');
    } catch {
      // Failed to persist, continue with in-memory token
    }
  }

  return updatedAuth;
}
