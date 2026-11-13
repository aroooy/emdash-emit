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
  formatOrphanMediaWarning as formatOrphanCli,
  formatMediaCoverageLine as formatCoverageCli,
} from '../src/cli/commands/pull.js';
import {
  formatOrphanMediaWarning,
  formatMediaCoverageLine,
  formatArticleDiffReport,
} from '../src/presentation/article_report.js';
import { remediationFor, GUARD_REGISTRY } from '../src/sync/guards.js';

describe('Presentation Layer & CLI/MCP Symmetry (C2)', () => {
  it('formatOrphanMediaWarning produces byte-identical output between CLI re-export and presentation module', () => {
    const keys = ['01M6ABCDEF1234567890123456.png', '01M6GHIJKL1234567890123456.webp'];

    const fromPresentation = formatOrphanMediaWarning(keys);
    const fromCli = formatOrphanCli(keys);

    expect(fromPresentation).toBe(fromCli);
    expect(fromPresentation).toContain('⚠️ [UNRESOLVED_MEDIA_ASSET] 2 storageKey(s)');
    expect(fromPresentation).toContain(keys[0]);
    expect(fromPresentation).toContain(keys[1]);
    expect(fromPresentation).toContain('emit doctor --check-media-library');

    expect(formatOrphanMediaWarning([])).toBe('');
    expect(formatOrphanMediaWarning(undefined)).toBe('');
  });

  it('formatMediaCoverageLine produces byte-identical output between CLI re-export and presentation module', () => {
    const testCases = [
      { total: 10, remoteTotalCount: 100, referencedUnmirroredStorageKeys: ['unmirrored1.jpg'] },
      { total: 5, remoteTotalCount: 5, referencedUnmirroredStorageKeys: [] },
      { total: 0, remoteTotalCount: null, referencedUnmirroredStorageKeys: [] },
      { total: 20, remoteTotalCount: 50 },
    ];

    for (const tc of testCases) {
      const fromPresentation = formatMediaCoverageLine(tc);
      const fromCli = formatCoverageCli(tc);

      expect(fromPresentation).toBe(fromCli);
      if (tc.remoteTotalCount && tc.remoteTotalCount > 0) {
        expect(fromPresentation).toContain(
          `remote library holds ${tc.remoteTotalCount} record(s), of which this run walked ${tc.total}`,
        );
      }
      if (tc.referencedUnmirroredStorageKeys && tc.referencedUnmirroredStorageKeys.length > 0) {
        expect(fromPresentation).toContain('⚠️ [UNREFERENCED_REMOTE_MEDIA]');
        expect(fromPresentation).toContain(tc.referencedUnmirroredStorageKeys[0]);
      }
    }
  });

  it('formatArticleDiffReport formats standardized diff inspection output', () => {
    const report = formatArticleDiffReport({
      targetFile: 'posts/draft/20261103_01ABC-test.md',
      targetId: '01ABCDEF123456789012345678',
      isModified: true,
      baseRev: 'rev-1234',
      baseSavedAt: 1730000000,
      additions: 3,
      deletions: 1,
      unifiedDiff: '@@ -1,3 +1,5 @@\n-old line\n+new line',
    });

    expect(report).toContain('--- Diff for posts/draft/20261103_01ABC-test.md');
    expect(report).toContain('Status: 🟡 Modified');
    expect(report).toContain('Base Rev: rev-1234');
    expect(report).toContain('Changes: +3 / -1 lines');
    expect(report).toContain('Unified Diff:');
    expect(report).toContain('-old line\n+new line');
  });

  it('remediationFor provides actionable guidance for all actionable guards without adding new error codes', () => {
    for (const guard of GUARD_REGISTRY) {
      for (const code of guard.codes) {
        const remediation = remediationFor(code);
        expect(
          remediation,
          `Guard code ${code} (from G${guard.id} ${guard.name}) must have a non-null remediation`,
        ).not.toBeNull();
        expect(typeof remediation).toBe('string');
        expect(remediation!.length).toBeGreaterThan(10);
      }
    }

    // Returns null for unrecognized code
    expect(remediationFor('NONEXISTENT_CODE')).toBeNull();
    expect(remediationFor('')).toBeNull();
  });
});
