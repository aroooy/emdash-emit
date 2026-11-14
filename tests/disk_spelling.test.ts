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
import { resolveDiskSpelling, renderForDisk } from '../src/utils/disk-spelling.js';

describe('disk-spelling (Phase 0 Layer 0 Helpers)', () => {
  it('resolves all 3 spelling axes correctly from diskContent and syncState', () => {
    const encodedDisk = `---
taxonomies:
  categories:
    - "%e6%9c%aa%e5%88%86%e9%a1%9e"
---
![Photo](media/01M6TEST.jpg)`;

    const spelling = resolveDiskSpelling(encodedDisk, {
      status: 'published',
      remoteRev: '24@draft:01M7CD9YGWNPAEP1Z7NC8600ZD',
    });

    expect(spelling.preferEncodedTaxonomy).toBe(true);
    expect(spelling.preferLegacyMediaRef).toBe(true);
    expect(spelling.hasDraftRevision).toBe(true);
  });

  it('resolves clean decoded disk spelling with live revision', () => {
    const cleanDisk = `---
taxonomies:
  categories:
    - 未分類
---
![Photo](../../media/01M6TEST.jpg)`;

    const spelling = resolveDiskSpelling(cleanDisk, {
      status: 'published',
      remoteRev: '24@live:01M7CCGC748FQWMC3FDBP4WDY7',
    });

    expect(spelling.preferEncodedTaxonomy).toBe(false);
    expect(spelling.preferLegacyMediaRef).toBe(false);
    expect(spelling.hasDraftRevision).toBe(false);
  });

  it('renders canonical content into disk spelling via renderForDisk', () => {
    const canonical = `---
title: Test
---
![Photo](/_emdash/api/media/file/01M6TEST.jpg)`;

    const rendered = renderForDisk(
      canonical,
      {
        preferEncodedTaxonomy: false,
        preferLegacyMediaRef: false,
        hasDraftRevision: false,
      },
      {
        workspaceRoot: '/test',
        articleRelPath: 'posts/published/test.md',
        fs: { existsSync: () => true } as unknown as typeof import('node:fs'),
      },
    );

    expect(rendered).toContain('../../media/01M6TEST.jpg');
  });
});
