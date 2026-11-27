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
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  formatOrphanMediaWarning as formatOrphanCli,
  formatMediaCoverageLine as formatCoverageCli,
  formatTaxonomySyncFailure as formatTaxonomySyncFailureCli,
  formatTaxonomySyncSuccess as formatTaxonomySyncSuccessCli,
  formatPreservedBlocksHint as formatPreservedBlocksHintCli,
} from '../src/cli/commands/pull.js';
import {
  formatOrphanMediaWarning,
  formatMediaCoverageLine,
  formatArticleDiffReport,
} from '../src/presentation/article_report.js';
import {
  formatPreservedBlocksHint,
  formatTaxonomySyncFailure,
  formatTaxonomySyncSuccess,
} from '../src/presentation/pull_report.js';
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
      targetFile: 'posts/ja/draft/20261103_01ABC-test.md',
      targetId: '01ABCDEF123456789012345678',
      isModified: true,
      baseRev: 'rev-1234',
      baseSavedAt: 1730000000,
      additions: 3,
      deletions: 1,
      unifiedDiff: '@@ -1,3 +1,5 @@\n-old line\n+new line',
    });

    expect(report).toContain('--- Diff for posts/ja/draft/20261103_01ABC-test.md');
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

  it('formatTaxonomySyncFailure and formatTaxonomySyncSuccess produce byte-identical output between CLI re-export and presentation module', () => {
    const failureTestCases = [
      { error: 'ECONNRESET' },
      { categoriesFailed: true, tagsFailed: true },
      { categoriesFailed: true },
      { tagsFailed: true },
      {},
    ];

    for (const tc of failureTestCases) {
      const fromPresentation = formatTaxonomySyncFailure(tc);
      const fromCli = formatTaxonomySyncFailureCli(tc);
      expect(fromPresentation).toBe(fromCli);
      expect(fromPresentation).toContain('⚠️ Taxonomies:');
      expect(fromPresentation).toContain('preserved existing local definitions');
    }

    const successTestCases = [
      { counts: { categoriesCount: 10, tagsCount: 20 }, options: undefined },
      {
        counts: {
          categoriesCount: 5,
          tagsCount: 15,
          deletedCategoriesCount: 2,
          deletedTagsCount: 3,
        },
        options: { label: 'Taxonomies' },
      },
      {
        counts: { categoriesCount: 0, tagsCount: 0, deletedCategoriesCount: 1 },
        options: { label: 'CustomTax' },
      },
    ];

    for (const tc of successTestCases) {
      const fromPresentation = formatTaxonomySyncSuccess(tc.counts, tc.options);
      const fromCli = formatTaxonomySyncSuccessCli(tc.counts, tc.options);
      expect(fromPresentation).toBe(fromCli);
      expect(fromPresentation).toContain('✅ ');
    }
  });

  it('formatPreservedBlocksHint produces byte-identical output between CLI re-export and presentation module', () => {
    const testCases = [
      { count: undefined, indent: '' },
      { count: 0, indent: '' },
      { count: -1, indent: '  ' },
      { count: 1, indent: '' },
      { count: 3, indent: '  ' },
      { count: 5, indent: '    ' },
    ];

    for (const tc of testCases) {
      const fromPresentation = formatPreservedBlocksHint(tc.count, tc.indent);
      const fromCli = formatPreservedBlocksHintCli(tc.count, tc.indent);
      expect(fromPresentation).toBe(fromCli);
    }
  });

  it('CLI and MCP pull modules import taxonomy formatters from presentation/pull_report.js (Static Parity)', () => {
    const cliSource = fs.readFileSync(
      path.resolve(__dirname, '../src/cli/commands/pull.ts'),
      'utf-8',
    );
    const mcpSource = fs.readFileSync(
      path.resolve(__dirname, '../src/mcp/tools/sync-pull.ts'),
      'utf-8',
    );

    // Both CLI and MCP must import formatTaxonomySyncFailure and formatTaxonomySyncSuccess from presentation/pull_report.js
    expect(cliSource).toMatch(/from\s+['"]\.\.\/\.\.\/presentation\/pull_report(?:\.js)?['"]/);
    expect(cliSource).toContain('formatTaxonomySyncFailure');
    expect(cliSource).toContain('formatTaxonomySyncSuccess');
    // Ensure actual call sites exist in CLI
    expect(cliSource).toMatch(/formatTaxonomySyncFailure\s*\(/);
    expect(cliSource).toMatch(/formatTaxonomySyncSuccess\s*\(/);

    expect(mcpSource).toMatch(/from\s+['"]\.\.\/\.\.\/presentation\/pull_report(?:\.js)?['"]/);
    expect(mcpSource).toContain('formatTaxonomySyncFailure');
    expect(mcpSource).toContain('formatTaxonomySyncSuccess');
    // Ensure actual call sites exist in MCP
    expect(mcpSource).toMatch(/formatTaxonomySyncFailure\s*\(/);
    expect(mcpSource).toMatch(/formatTaxonomySyncSuccess\s*\(/);
  });

  it('profile resolution wording comes from one Layer 0 helper, not two literals (T5-1)', () => {
    const cliSource = fs.readFileSync(
      path.resolve(__dirname, '../src/cli/commands/profile.ts'),
      'utf-8',
    );
    const mcpSource = fs.readFileSync(
      path.resolve(__dirname, '../src/mcp/tools/profile.ts'),
      'utf-8',
    );

    // Both surfaces must route through the shared Layer 0 helper. MCP may not import a CLI module
    // (AGENTS.md Axis 3), and a literal defined in both files would drift silently.
    expect(cliSource).toMatch(/from\s+['"]\.\.\/\.\.\/utils\/profile-resolution(?:\.js)?['"]/);
    expect(mcpSource).toMatch(/from\s+['"]\.\.\/\.\.\/utils\/profile-resolution(?:\.js)?['"]/);
    expect(cliSource).toMatch(/formatResolutionRationale\s*\(/);
    expect(cliSource).toMatch(/cwdMatchedProfileName\s*\(/);
    expect(mcpSource).toMatch(/cwdMatchedProfileName\s*\(/);

    // The rationale strings live in exactly one file. Comments that *describe* the old wording are
    // stripped first, so this catches a redefined literal rather than prose explaining the change.
    const helperSource = fs.readFileSync(
      path.resolve(__dirname, '../src/utils/profile-resolution.ts'),
      'utf-8',
    );
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const cliCode = stripComments(cliSource);
    const mcpCode = stripComments(mcpSource);
    for (const phrase of [
      'current directory match',
      'origin match (.emit/config.json',
      'only configured profile',
      // The full marker, not the bare "active default" — `profile use` legitimately describes itself as
      // setting the active default profile, and that is not a redefinition of the rationale wording.
      '(active default — used only outside registered workspaces)',
    ]) {
      expect(helperSource, `helper must own: ${phrase}`).toContain(phrase);
      expect(cliCode, `CLI must not redefine: ${phrase}`).not.toContain(phrase);
      expect(mcpCode, `MCP must not redefine: ${phrase}`).not.toContain(phrase);
    }

    // MCP must never import a CLI command module.
    expect(mcpSource).not.toMatch(/from\s+['"]\.\.\/\.\.\/cli\//);
  });

  it('S-1: buildSnapshotSearchFraming shares snapshotStatus, absenceGuaranteed, and truncatedHint across CLI and MCP', async () => {
    const { buildSnapshotSearchFraming } = await import('../src/presentation/article_report.js');

    const missingFramingCli = buildSnapshotSearchFraming({
      hitCount: 0,
      kind: 'media',
      isMcp: false,
    });
    const missingFramingMcp = buildSnapshotSearchFraming({
      hitCount: 0,
      kind: 'media',
      isMcp: true,
    });
    expect(missingFramingCli.snapshotStatus).toBe('missing');
    expect(missingFramingCli.absenceGuaranteed).toBe(false);
    expect(missingFramingCli).toEqual(missingFramingMcp);

    const truncatedCli = buildSnapshotSearchFraming({
      snapshot: { capturedAt: new Date().toISOString(), ageDays: 1, stale: false },
      hitCount: 20,
      totalCount: 45,
      truncated: true,
      kind: 'article',
      isMcp: false,
    });
    const truncatedMcp = buildSnapshotSearchFraming({
      snapshot: { capturedAt: new Date().toISOString(), ageDays: 1, stale: false },
      hitCount: 20,
      totalCount: 45,
      truncated: true,
      kind: 'article',
      isMcp: true,
    });
    expect(truncatedCli.snapshotStatus).toBe('fresh');
    expect(truncatedCli.absenceGuaranteed).toBe(true);
    expect(truncatedCli.truncatedHint).toContain('--limit');
    expect(truncatedMcp.truncatedHint).toContain('limit');
    expect(truncatedCli.truncatedHint!.replace('--limit', 'limit')).toBe(
      truncatedMcp.truncatedHint,
    );
  });

  it('S-2: CLI and MCP search modules import buildSnapshotSearchFraming from presentation/article_report.js', () => {
    const cliArticleSource = fs.readFileSync(
      path.resolve(__dirname, '../src/cli/commands/article-search.ts'),
      'utf-8',
    );
    const cliMediaSource = fs.readFileSync(
      path.resolve(__dirname, '../src/cli/commands/media.ts'),
      'utf-8',
    );
    const mcpArticleSource = fs.readFileSync(
      path.resolve(__dirname, '../src/mcp/tools/sync-article-search.ts'),
      'utf-8',
    );
    const mcpMediaSource = fs.readFileSync(
      path.resolve(__dirname, '../src/mcp/tools/sync-media-search.ts'),
      'utf-8',
    );

    for (const src of [cliArticleSource, cliMediaSource, mcpArticleSource, mcpMediaSource]) {
      expect(src).toMatch(/from\s+['"]\.\.\/\.\.\/presentation\/article_report(?:\.js)?['"]/);
      expect(src).toContain('buildSnapshotSearchFraming');
      expect(src).toMatch(/buildSnapshotSearchFraming\s*\(/);
    }
    expect(remediationFor('MEDIA_IN_USE_PROTECTION')).toContain('referencing local article');
    expect(remediationFor('LIVE_SEARCH_UNSUPPORTED_FILTER')).toContain('Omit --live');
  });

  it('S-3: CLI and MCP pull modules share formatPruneSkippedArticlesNotice from presentation/article_report.js', async () => {
    const { formatPruneSkippedArticlesNotice } =
      await import('../src/presentation/article_report.js');
    const cliPullSource = fs.readFileSync(
      path.resolve(__dirname, '../src/cli/commands/pull.ts'),
      'utf-8',
    );
    const mcpPullSource = fs.readFileSync(
      path.resolve(__dirname, '../src/mcp/tools/sync-pull.ts'),
      'utf-8',
    );

    for (const src of [cliPullSource, mcpPullSource]) {
      expect(src).toMatch(/from\s+['"]\.\.\/\.\.\/presentation\/article_report(?:\.js)?['"]/);
      expect(src).toContain('formatPruneSkippedArticlesNotice');
      expect(src).toMatch(/formatPruneSkippedArticlesNotice\s*\(/);
    }

    const rendered = formatPruneSkippedArticlesNotice(
      [
        {
          id: '01M67N0TNFS6F3PJX4T96NKPKT',
          slug: 'legacy-copy',
          filePath: 'posts/ja/published/20190405_01M67N0TNFS6F3PJX4T96NKPKT-legacy-copy.md',
        },
        {
          id: '01M67N0TNFS6F3PJX4T96NKPKT',
          slug: 'legacy-copy',
          filePath: 'posts/ja/published/20190405_01M67N0TNFS6F3PJX4T96NKPKT-legacy-copy-2.md',
        },
      ],
      30,
    );
    expect(rendered).toContain('2 file(s) belonging to 1 article(s) outside the sync window');
    expect(rendered).toContain('(currently: 30)');
  });
});
