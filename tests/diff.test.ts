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
import { computeContextDiff } from '../src/sync/diff.js';

describe('computeContextDiff', () => {
  it('returns no changes when strings are identical', () => {
    const text = 'line 1\nline 2\nline 3';
    const res = computeContextDiff(text, text);
    expect(res.hasChanges).toBe(false);
    expect(res.additions).toBe(0);
    expect(res.deletions).toBe(0);
    expect(res.unifiedDiff).toBe('No changes detected.');
  });

  it('outputs unified diff hunk for modified lines', () => {
    const base = 'line 1\nline 2\nline 3';
    const local = 'line 1\nline 2 (modified)\nline 3';
    const res = computeContextDiff(base, local);
    expect(res.hasChanges).toBe(true);
    expect(res.additions).toBe(1);
    expect(res.deletions).toBe(1);
    expect(res.unifiedDiff).toContain('-line 2');
    expect(res.unifiedDiff).toContain('+line 2 (modified)');
  });

  it('outputs additions when new lines are appended', () => {
    const base = 'line 1\nline 2';
    const local = 'line 1\nline 2\nline 3\nline 4';
    const res = computeContextDiff(base, local);
    expect(res.hasChanges).toBe(true);
    expect(res.additions).toBe(2);
    expect(res.deletions).toBe(0);
    expect(res.unifiedDiff).toContain('+line 3');
    expect(res.unifiedDiff).toContain('+line 4');
  });
});
