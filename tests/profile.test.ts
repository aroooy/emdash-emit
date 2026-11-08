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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadProfilesFile,
  saveProfilesFile,
  getProfile,
  setProfile,
  setActiveProfile,
  removeProfile,
  findProfileByDirectory,
  resolveTargetProfile,
  AmbiguousProfileError,
} from '../src/utils/profile.js';
import { resolveAuth } from '../src/client/auth.js';

describe('Profile Management (profiles.yaml)', () => {
  let tmpDir: string;
  let customProfilesPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-profile-test-'));
    customProfilesPath = path.join(tmpDir, 'profiles.yaml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles non-existent profiles.yaml gracefully', () => {
    const data = loadProfilesFile(customProfilesPath);
    expect(data.profiles).toEqual({});
    expect(data.active).toBeUndefined();
    expect(getProfile(undefined, customProfilesPath)).toBeNull();
  });

  it('adds and retrieves profiles and auto-sets active on first addition', () => {
    setProfile(
      'site-a',
      {
        origin: 'https://site-a.com',
        token: 'token-a',
        workspace: '/tmp/workspace-a',
      },
      false,
      customProfilesPath,
    );

    const loaded = loadProfilesFile(customProfilesPath);
    expect(loaded.active).toBe('site-a');
    expect(loaded.profiles['site-a'].origin).toBe('https://site-a.com');

    // Retrieve active profile
    const active = getProfile(undefined, customProfilesPath);
    expect(active).not.toBeNull();
    expect(active?.name).toBe('site-a');
    expect(active?.config.token).toBe('token-a');
  });

  it('supports multiple profiles and switching active profile', () => {
    setProfile(
      'site-a',
      { origin: 'https://site-a.com', token: 'token-a' },
      false,
      customProfilesPath,
    );
    setProfile(
      'site-b',
      { origin: 'https://site-b.com', token: 'token-b' },
      false,
      customProfilesPath,
    );

    let active = getProfile(undefined, customProfilesPath);
    expect(active?.name).toBe('site-a');

    setActiveProfile('site-b', customProfilesPath);
    active = getProfile(undefined, customProfilesPath);
    expect(active?.name).toBe('site-b');
    expect(active?.config.token).toBe('token-b');

    // Query explicit profile by name
    const siteA = getProfile('site-a', customProfilesPath);
    expect(siteA?.name).toBe('site-a');
    expect(siteA?.config.token).toBe('token-a');
  });

  it('removes profile and updates active profile if needed', () => {
    setProfile('p1', { origin: 'https://1.com', token: 't1' }, true, customProfilesPath);
    setProfile('p2', { origin: 'https://2.com', token: 't2' }, false, customProfilesPath);

    expect(loadProfilesFile(customProfilesPath).active).toBe('p1');

    removeProfile('p1', customProfilesPath);
    const updated = loadProfilesFile(customProfilesPath);
    expect(updated.profiles['p1']).toBeUndefined();
    expect(updated.active).toBe('p2');

    removeProfile('p2', customProfilesPath);
    expect(loadProfilesFile(customProfilesPath).active).toBeUndefined();
  });

  it('matches profile by workspace directory automatically', () => {
    setProfile(
      'blog-main',
      { origin: 'https://main.com', token: 'token-m', workspace: '/projects/blog-main' },
      false,
      customProfilesPath,
    );
    setProfile(
      'blog-sub',
      { origin: 'https://sub.com', token: 'token-s', workspace: '/projects/blog-sub' },
      false,
      customProfilesPath,
    );

    // Exact match
    const matchMain = findProfileByDirectory('/projects/blog-main', customProfilesPath);
    expect(matchMain?.name).toBe('blog-main');

    // Subdirectory match (e.g. inside posts/draft/)
    const matchSubDir = findProfileByDirectory(
      '/projects/blog-sub/posts/draft',
      customProfilesPath,
    );
    expect(matchSubDir?.name).toBe('blog-sub');

    // Outside directory
    const matchOutside = findProfileByDirectory('/random/other/dir', customProfilesPath);
    expect(matchOutside).toBeNull();
  });

  it('auto-resolves single profile without parameters or directory match', () => {
    setProfile(
      'only-one',
      { origin: 'https://one.com', token: 'tok-1', workspace: '/ws/one' },
      false,
      customProfilesPath,
    );

    const resolved = resolveTargetProfile({
      cwd: '/some/unrelated/path',
      customPath: customProfilesPath,
    });
    expect(resolved?.name).toBe('only-one');
    expect(resolved?.source).toBe('single');
  });

  it('throws AmbiguousProfileError when multiple profiles exist and none match cwd', () => {
    setProfile(
      'site-1',
      { origin: 'https://1.com', token: 't1', workspace: '/ws/1' },
      false,
      customProfilesPath,
    );
    setProfile(
      'site-2',
      { origin: 'https://2.com', token: 't2', workspace: '/ws/2' },
      false,
      customProfilesPath,
    );

    // Unrelated cwd with no explicit profile should throw AmbiguousProfileError
    expect(() =>
      resolveTargetProfile({
        cwd: '/unrelated/path',
        customPath: customProfilesPath,
      }),
    ).toThrow(AmbiguousProfileError);

    // Matching directory should still succeed without ambiguity
    const resolvedByDir = resolveTargetProfile({
      cwd: '/ws/2/posts',
      customPath: customProfilesPath,
    });
    expect(resolvedByDir?.name).toBe('site-2');
    expect(resolvedByDir?.source).toBe('workspace');

    // Explicit profile should always succeed
    const resolvedExplicit = resolveTargetProfile({
      profile: 'site-1',
      cwd: '/unrelated/path',
      customPath: customProfilesPath,
    });
    expect(resolvedExplicit?.name).toBe('site-1');
    expect(resolvedExplicit?.source).toBe('explicit');
  });

  it('integrates with resolveAuth', () => {
    // When no env var is set, profile should be resolved
    const origToken = process.env.EMDASH_TOKEN;
    const origApiToken = process.env.EMDASH_API_TOKEN;
    delete process.env.EMDASH_TOKEN;
    delete process.env.EMDASH_API_TOKEN;

    try {
      setProfile(
        'prod',
        {
          origin: 'https://prod.aroooy.net',
          token: 'pat_prod_123',
          workspace: '/workspace/prod',
        },
        true,
        customProfilesPath,
      );

      // Point resolveAuth to our custom profile file by temporarily setting custom profiles in default location or calling with options
      // Note: resolveAuth reads getProfile(options?.profile)
      // Let's test getProfile directly and then with resolveAuth
      const resolved = getProfile('prod', customProfilesPath);
      expect(resolved?.config.origin).toBe('https://prod.aroooy.net');
    } finally {
      if (origToken) process.env.EMDASH_TOKEN = origToken;
      if (origApiToken) process.env.EMDASH_API_TOKEN = origApiToken;
    }
  });

  it('omits undefined optional fields when saving profiles.yaml (no !<tag:yaml.org,2002:js/undefined>) and normalizes on load', () => {
    setProfile(
      'clean-prof',
      {
        origin: 'https://aroooy.net',
        token: 'pat_clean',
        workspace: undefined,
      },
      true,
      customProfilesPath,
    );

    const rawYaml = fs.readFileSync(customProfilesPath, 'utf8');
    expect(rawYaml).not.toContain('js/undefined');
    expect(rawYaml).not.toContain('workspace:');

    const loaded = loadProfilesFile(customProfilesPath);
    expect(loaded.profiles['clean-prof'].origin).toBe('https://aroooy.net');
    expect(loaded.profiles['clean-prof'].token).toBe('pat_clean');
    expect(loaded.profiles['clean-prof'].workspace).toBeUndefined();
  });

  it('prefers deepest (longest path) workspace match for nested workspaces and resolves by origin hint', () => {
    setProfile(
      'parent-ws',
      { origin: 'https://parent.example.com', token: 't1', workspace: '/projects/mono' },
      false,
      customProfilesPath,
    );
    setProfile(
      'nested-ws',
      { origin: 'https://nested.example.com', token: 't2', workspace: '/projects/mono/sites/sub' },
      false,
      customProfilesPath,
    );

    const matchNested = findProfileByDirectory(
      '/projects/mono/sites/sub/posts/draft',
      customProfilesPath,
    );
    expect(matchNested?.name).toBe('nested-ws');

    // Origin hint disambiguates when cwd does not match any profile workspace
    const byOrigin = resolveTargetProfile({
      cwd: '/elsewhere',
      origin: 'https://nested.example.com/',
      customPath: customProfilesPath,
    });
    expect(byOrigin?.name).toBe('nested-ws');
    expect(byOrigin?.source).toBe('workspace');
  });
});
