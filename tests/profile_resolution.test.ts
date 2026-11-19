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

/**
 * v0.1.38 P1 — T1-1 / T1-2: the shared resolution rationale must be pure, discriminated, and free of any
 * credential material, because both `emit profile current` and MCP `profile_list` print it.
 */

import { describe, expect, it } from 'vitest';
import type { ResolveProfileResult } from '../src/utils/profile.js';
import {
  cwdMatchedProfileName,
  formatResolutionRationale,
  toResolutionSource,
} from '../src/utils/profile-resolution.js';

function result(source: ResolveProfileResult['source'], name = 'site-a'): ResolveProfileResult {
  return {
    name,
    config: { origin: 'https://site-a.example.com', token: 'pat_super_secret' },
    source,
  };
}

describe('toResolutionSource (T1-1)', () => {
  it('splits the collapsed "workspace" source by whether the directory matched', () => {
    expect(toResolutionSource(result('workspace'), true)).toBe('workspace-dir');
    // Negative: an origin-only match must never be reported as a directory match — claiming the folder
    // decided it when the folder is unregistered would be an unfounded assertion.
    expect(toResolutionSource(result('workspace'), false)).toBe('workspace-origin');
  });

  it('passes through the other sources unchanged', () => {
    expect(toResolutionSource(result('explicit'), true)).toBe('explicit');
    // An explicit --profile still names a directory match, but the flag is what chose it.
    expect(toResolutionSource(result('single'), false)).toBe('single');
    expect(toResolutionSource(result('active'), false)).toBe('active');
  });
});

describe('formatResolutionRationale (T1-2)', () => {
  const opts = {
    profileName: 'aroooy.net',
    workspacePath: '/Users/me/src/workspaces/aroooy.net',
    cwd: '/Users/me/src/workspaces/aroooy.net/posts/draft',
  };

  it('names the winning path for each source', () => {
    expect(formatResolutionRationale('workspace-dir', opts)).toBe(
      'current directory match (/Users/me/src/workspaces/aroooy.net)',
    );
    expect(formatResolutionRationale('workspace-origin', opts)).toBe(
      'origin match (.emit/config.json -> profile "aroooy.net")',
    );
    expect(formatResolutionRationale('explicit', opts)).toBe('explicit --profile "aroooy.net"');
    expect(formatResolutionRationale('single', opts)).toBe('only configured profile');
    expect(formatResolutionRationale('active', opts)).toContain(
      'a registered workspace directory always outranks this',
    );
  });

  it('falls back to the cwd when a matched profile carries no registered workspace', () => {
    expect(
      formatResolutionRationale('workspace-dir', {
        profileName: 'site-a',
        cwd: '/Users/me/src/site-a',
      }),
    ).toBe('current directory match (/Users/me/src/site-a)');
  });

  it('never leaks token material (T1-2 negative)', () => {
    const withToken = { ...opts, token: 'pat_super_secret' } as typeof opts & { token: string };
    for (const source of [
      'explicit',
      'workspace-dir',
      'workspace-origin',
      'single',
      'active',
    ] as const) {
      expect(formatResolutionRationale(source, withToken)).not.toContain('pat_super_secret');
    }
  });
});

describe('cwdMatchedProfileName', () => {
  it('returns the profile whose workspace owns the cwd', () => {
    expect(cwdMatchedProfileName(['alpha', 'beta'], (name) => name === 'beta')).toBe('beta');
  });

  it('returns null when no profile matches (T1-3 negative: no marker at all)', () => {
    expect(cwdMatchedProfileName(['alpha', 'beta'], () => false)).toBeNull();
  });
});
