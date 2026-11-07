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
  truncateUtf8Bytes,
  DEFAULT_MAX_TITLE_BYTES,
  compareArticleFilenameDesc,
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

  describe('truncateUtf8Bytes', () => {
    it('returns original string when within maxBytes', () => {
      expect(truncateUtf8Bytes('Hello', 10)).toBe('Hello');
      expect(truncateUtf8Bytes('日本語', 9)).toBe('日本語');
    });

    it('truncates ASCII string at exact maxBytes', () => {
      expect(truncateUtf8Bytes('abcdefghij', 5)).toBe('abcde');
    });

    it('does not split multi-byte UTF-8 Japanese characters', () => {
      // 'あ' is 3 bytes, 'い' is 3 bytes (total 6 bytes)
      // When truncated to 5 bytes, it should include only 'あ' (3 bytes), not split 'い'
      const truncated = truncateUtf8Bytes('あい', 5);
      expect(truncated).toBe('あ');
      expect(Buffer.byteLength(truncated, 'utf8')).toBe(3);
    });

    it('safely handles emojis without splitting surrogate pairs', () => {
      // '🚀' is 4 bytes
      const text = 'Launch🚀Now';
      const truncated = truncateUtf8Bytes(text, 8); // 'Launch' is 6B, + '🚀' is 10B (>8)
      expect(truncated).toBe('Launch');
    });
  });

  describe('sanitizeTitleForFilename with Linux NAME_MAX protection', () => {
    it('returns "untitled" for empty or whitespace titles', () => {
      expect(sanitizeTitleForFilename('')).toBe('untitled');
      expect(sanitizeTitleForFilename('   ')).toBe('untitled');
    });

    it('decodes HTML entities properly', () => {
      expect(sanitizeTitleForFilename('Tom &amp; Jerry')).toBe('Tom-&-Jerry');
      expect(sanitizeTitleForFilename('Part 1 &#8211; Intro')).toBe('Part-1-Intro');
    });

    it('collapses multiple hyphens and trims edges', () => {
      expect(sanitizeTitleForFilename('---A----B---')).toBe('A-B');
    });

    it('truncates very long Japanese titles to DEFAULT_MAX_TITLE_BYTES (120 bytes)', () => {
      const veryLongJapaneseTitle =
        '【AI執筆】Web畑じゃない（けど素人でもない）オーナーと、13年分のWordPress（755記事・画像4,005枚）をEmDash＋Cloudflare-Workersへ移行した全記録-——-毒舌AIと人間の珍道中、ときどき神指摘';
      const sanitized = sanitizeTitleForFilename(veryLongJapaneseTitle);

      expect(Buffer.byteLength(sanitized, 'utf8')).toBeLessThanOrEqual(DEFAULT_MAX_TITLE_BYTES);
      expect(sanitized.endsWith('-')).toBe(false);
      // Valid UTF-8 string that does not end in corrupted character
      expect(() => Buffer.from(sanitized, 'utf8').toString('utf8')).not.toThrow();
    });

    it('guarantees computeArticleRelativePath basename is safely within Linux 255 bytes limit', () => {
      const longTitle = 'あ'.repeat(150); // 150 chars * 3 = 450 bytes
      const rel = computeArticleRelativePath(
        'posts',
        'published',
        '01M6A7AZYPW56CKSVNTXER9ASN',
        longTitle,
        '2026-11-01',
      );
      const filename = rel.split('/').pop()!;
      const byteLength = Buffer.byteLength(filename, 'utf8');

      // 9 (prefix) + 26 (ulid) + 1 (-) + <=120 (title) + 3 (.md) = <= 159 bytes
      expect(byteLength).toBeLessThanOrEqual(160);
      expect(byteLength).toBeLessThan(255);
    });
  });

  describe('compareArticleFilenameDesc', () => {
    it('sorts canonical filenames descending by date prefix (newest first)', () => {
      const files = [
        'posts/draft/20240120_01M67N19JPWNGFZ0M6KBQ8FS01-Old.md',
        'posts/published/20261105_01M67N19JPWNGFZ0M6KBQ8FS03-Newest.md',
        'posts/published/20250615_01M67N19JPWNGFZ0M6KBQ8FS02-Mid.md',
      ];
      files.sort(compareArticleFilenameDesc);
      expect(files).toEqual([
        'posts/published/20261105_01M67N19JPWNGFZ0M6KBQ8FS03-Newest.md',
        'posts/published/20250615_01M67N19JPWNGFZ0M6KBQ8FS02-Mid.md',
        'posts/draft/20240120_01M67N19JPWNGFZ0M6KBQ8FS01-Old.md',
      ]);
    });

    it('breaks ties on the same date using ULID descending (time order guarantee)', () => {
      const files = [
        'posts/draft/20261105_01M6AAA0000000000000000001-First.md',
        'posts/draft/20261105_01M6ZZZ0000000000000000001-Later.md',
      ];
      files.sort(compareArticleFilenameDesc);
      expect(files).toEqual([
        'posts/draft/20261105_01M6ZZZ0000000000000000001-Later.md',
        'posts/draft/20261105_01M6AAA0000000000000000001-First.md',
      ]);
    });

    it('places unprefixed legacy filenames last', () => {
      const files = [
        'posts/draft/01M67MP2000000000000000001-Legacy.md',
        'posts/published/20261105_01M67N19JPWNGFZ0M6KBQ8FS03-Modern.md',
      ];
      files.sort(compareArticleFilenameDesc);
      expect(files).toEqual([
        'posts/published/20261105_01M67N19JPWNGFZ0M6KBQ8FS03-Modern.md',
        'posts/draft/01M67MP2000000000000000001-Legacy.md',
      ]);
    });
  });
});
