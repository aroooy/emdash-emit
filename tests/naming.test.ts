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
import {
  extractUlidFromFilename,
  stripDatePrefix,
  formatDatePrefix,
  computeArticleRelativePath,
  sanitizeTitleForFilename,
} from '../src/utils/naming.js';

describe('naming utils', () => {
  it('extracts ULID from filename with date prefix', () => {
    const filename = '20261103_01M6FBAJ2JKNX8VAYXXASYSFGA-test-title.md';
    expect(extractUlidFromFilename(filename)).toBe('01M6FBAJ2JKNX8VAYXXASYSFGA');
  });

  it('extracts ULID from filename without date prefix', () => {
    const filename = '01M6FBAJ2JKNX8VAYXXASYSFGA-test-title.md';
    expect(extractUlidFromFilename(filename)).toBe('01M6FBAJ2JKNX8VAYXXASYSFGA');
  });

  it('extracts ULID from full path', () => {
    const fullPath = '/path/to/posts/draft/20261103_01M6FBAJ2JKNX8VAYXXASYSFGA-test-title.md';
    expect(extractUlidFromFilename(fullPath)).toBe('01M6FBAJ2JKNX8VAYXXASYSFGA');
  });

  it('returns null when no ULID is present', () => {
    expect(extractUlidFromFilename('20261103_invalid-name.md')).toBeNull();
    expect(extractUlidFromFilename('random-file.txt')).toBeNull();
  });

  it('strips date prefix correctly', () => {
    expect(stripDatePrefix('20261103_my-file.md')).toBe('my-file.md');
    expect(stripDatePrefix('posts/draft/20261103_my-file.md')).toBe('my-file.md');
    expect(stripDatePrefix('my-file.md')).toBe('my-file.md');
  });

  it('formats date prefix reliably', () => {
    expect(formatDatePrefix('2026-11-03T12:00:00Z')).toBe('20261103_');
    expect(formatDatePrefix('20261103')).toBe('20261103_');
    expect(formatDatePrefix('20261103_')).toBe('20261103_');
    expect(formatDatePrefix(null)).toMatch(/^\d{8}_$/);
  });

  it('computes article relative path with ULID and sanitized title', () => {
    const rel = computeArticleRelativePath(
      'posts',
      'draft',
      '01M6FBAJ2JKNX8VAYXXASYSFGA',
      'My Awesome Title: Special Edition?',
      '2026-11-03',
    );
    expect(rel).toBe(
      'posts/draft/20261103_01M6FBAJ2JKNX8VAYXXASYSFGA-My-Awesome-Title-Special-Edition.md',
    );
  });
});
