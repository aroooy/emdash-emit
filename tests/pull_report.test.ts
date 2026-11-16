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

import { describe, expect, it } from 'vitest';
import {
  formatPreservedBlocksHint,
  formatPullStatusBreakdown,
  formatPullWindowLabel,
  formatTaxonomySyncFailure,
  formatTaxonomySyncSuccess,
} from '../src/presentation/pull_report.js';

describe('Pull Report Formatters', () => {
  describe('formatPreservedBlocksHint', () => {
    it('returns empty string when count is undefined, 0, or negative', () => {
      expect(formatPreservedBlocksHint(undefined)).toBe('');
      expect(formatPreservedBlocksHint(0)).toBe('');
      expect(formatPreservedBlocksHint(-1)).toBe('');
      // Explicitly verifies that PullResult holding 0 (plain article) produces empty string without clutter
      const sampleResult = { preservedBlocks: 0 };
      expect(formatPreservedBlocksHint(sampleResult.preservedBlocks)).toBe('');
    });

    it('formats single preserved block correctly without indent', () => {
      expect(formatPreservedBlocksHint(1)).toBe(
        '💡 Preserved 1 styled/custom block(s) (<!--ec:block ... -->) retaining alignment/layout.',
      );
    });

    it('formats multiple preserved blocks correctly with custom indent', () => {
      expect(formatPreservedBlocksHint(3, '  ')).toBe(
        '  💡 Preserved 3 styled/custom block(s) (<!--ec:block ... -->) retaining alignment/layout.',
      );
    });
  });

  describe('existing formatters consistency', () => {
    it('formatPullStatusBreakdown returns empty string for non-all status', () => {
      expect(formatPullStatusBreakdown('published', [])).toBe('');
      expect(
        formatPullStatusBreakdown('all', [
          { status: 'published' },
          { status: 'draft' },
          { deleted: true, status: 'published' },
        ]),
      ).toBe(' [1 published, 1 draft]');
    });

    it('formatPullWindowLabel formats limit correctly', () => {
      expect(formatPullWindowLabel('all', 30)).toBe('30/status');
      expect(formatPullWindowLabel('published', 30)).toBe('30');
    });

    it('formatTaxonomySyncFailure formats expected message', () => {
      expect(formatTaxonomySyncFailure({ error: 'timeout' })).toBe(
        '⚠️ Taxonomies: Failed to sync remote taxonomies (timeout, preserved existing local definitions).',
      );
    });

    it('formatTaxonomySyncSuccess formats counts correctly', () => {
      expect(formatTaxonomySyncSuccess({ categoriesCount: 2, tagsCount: 5 })).toBe(
        '✅ Taxonomies: 2 categories, 5 tags',
      );
    });
  });
});
