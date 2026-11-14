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

import { describe, it, expect } from 'vitest';
import { hasUncommittedDraftRevision } from '../src/utils/draft-revision.js';

describe('hasUncommittedDraftRevision', () => {
  it('returns true when status is published and remoteRev contains @draft:', () => {
    expect(
      hasUncommittedDraftRevision({
        status: 'published',
        remoteRev: '24@draft:01M7CD9YGWNPAEP1Z7NC8600ZD',
      }),
    ).toBe(true);
  });

  it('returns false when status is draft even if remoteRev contains @draft:', () => {
    expect(
      hasUncommittedDraftRevision({
        status: 'draft',
        remoteRev: '2@draft:01M7CD9YGWNPAEP1Z7NC8600ZD',
      }),
    ).toBe(false);
  });

  it('returns false when remoteRev is clean @live:', () => {
    expect(
      hasUncommittedDraftRevision({
        status: 'published',
        remoteRev: '24@live:01M7CCGC748FQWMC3FDBP4WDY7',
      }),
    ).toBe(false);
  });

  it('returns false for legacy plain version tokens without @draft:', () => {
    expect(
      hasUncommittedDraftRevision({
        status: 'published',
        remoteRev: '24',
      }),
    ).toBe(false);

    expect(
      hasUncommittedDraftRevision({
        status: 'published',
        remoteRev: 'MTk6MTczMTU0NTYwMA==',
      }),
    ).toBe(false);
  });

  it('returns false for null or undefined syncState', () => {
    expect(hasUncommittedDraftRevision(null)).toBe(false);
    expect(hasUncommittedDraftRevision(undefined)).toBe(false);
    expect(hasUncommittedDraftRevision({})).toBe(false);
  });
});
