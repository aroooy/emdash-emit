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
import { hybrid3WayMerge, mergeBody, mergeFrontmatter } from '../src/sync/merge.js';
import type { Frontmatter, ParsedMarkdown } from '../src/utils/frontmatter.js';

describe('Hybrid 3-Way Merge Engine', () => {
  const validUlid = '01M67MP2W0VKCK2DFWM166CR24';

  describe('mergeBody', () => {
    it('cleanly auto-merges non-overlapping edits without conflict', () => {
      const base = ['Line 1', 'Line 2', 'Line 3', 'Line 4'].join('\n');
      const local = ['Line 1 (Local edit)', 'Line 2', 'Line 3', 'Line 4'].join('\n');
      const remote = ['Line 1', 'Line 2', 'Line 3', 'Line 4 (Remote edit)'].join('\n');

      const res = mergeBody(local, base, remote);
      expect(res.hasConflict).toBe(false);
      expect(res.mergedBody).toContain('Line 1 (Local edit)');
      expect(res.mergedBody).toContain('Line 4 (Remote edit)');
    });

    it('inserts Git-style conflict markers when both modified the same lines', () => {
      const base = ['Heading', 'Original paragraph text.', 'Footer'].join('\n');
      const local = ['Heading', 'Local modified paragraph text.', 'Footer'].join('\n');
      const remote = ['Heading', 'Remote modified paragraph text.', 'Footer'].join('\n');

      const res = mergeBody(local, base, remote);
      expect(res.hasConflict).toBe(true);
      expect(res.mergedBody).toContain('<<<<<<< LOCAL');
      expect(res.mergedBody).toContain('Local modified paragraph text.');
      expect(res.mergedBody).toContain('=======');
      expect(res.mergedBody).toContain('Remote modified paragraph text.');
      expect(res.mergedBody).toContain('>>>>>>> REMOTE');
    });

    it('handles CRLF and LF mixed line endings safely', () => {
      const base = 'Heading 1\r\n\r\nParagraph 1\r\n\r\nParagraph 2\r\n\r\nFooter';
      const local = 'Heading 1\n\nParagraph 1 (Local edit)\n\nParagraph 2\n\nFooter';
      const remote = 'Heading 1\r\n\r\nParagraph 1\r\n\r\nParagraph 2 (Remote edit)\r\n\r\nFooter';

      const res = mergeBody(local, base, remote);
      expect(res.hasConflict).toBe(false);
      expect(res.mergedBody).toContain('Paragraph 1 (Local edit)');
      expect(res.mergedBody).toContain('Paragraph 2 (Remote edit)');
    });
  });

  describe('mergeFrontmatter', () => {
    const baseFm: Frontmatter = {
      id: validUlid,
      slug: 'base-slug',
      title: 'Base Title',
      collection: 'posts',
      status: 'draft',
      locale: 'ja',
      taxonomies: { categories: ['tech'] },
      bylines: ['author1'],
    };

    it('merges non-conflicting field updates from both sides', () => {
      const localFm: Frontmatter = {
        ...baseFm,
        title: 'Local Title Changed',
        featuredImage: '01M67MP2W0VKCK2DFWM166CR24',
      };
      const remoteFm: Frontmatter = {
        ...baseFm,
        status: 'published',
        bylines: ['author1', 'author2'],
      };

      const res = mergeFrontmatter(localFm, baseFm, remoteFm);
      expect(res.merged.title).toBe('Local Title Changed');
      expect(res.merged.status).toBe('published');
      expect(res.merged.featuredImage).toBe('01M67MP2W0VKCK2DFWM166CR24');
      expect(res.merged.bylines).toEqual(['author1', 'author2']);
      expect(res.warnings).toHaveLength(0);
    });

    it('correctly detects conflict on featuredImage field and warns', () => {
      const localFm: Frontmatter = {
        ...baseFm,
        featuredImage: '01M6LOCAL11111111111111111',
      };
      const remoteFm: Frontmatter = {
        ...baseFm,
        featuredImage: '01M6REMOTE2222222222222222',
      };

      const res = mergeFrontmatter(localFm, baseFm, remoteFm);
      expect(res.merged.featuredImage).toBe('01M6REMOTE2222222222222222');
      expect(res.warnings.length).toBe(1);
      expect(res.warnings[0]).toContain('featuredImage');
    });

    it('resolves conflicting frontmatter field by favoring remote and logging warning', () => {
      const localFm: Frontmatter = {
        ...baseFm,
        title: 'Local Changed Title',
      };
      const remoteFm: Frontmatter = {
        ...baseFm,
        title: 'Remote Changed Title',
      };

      const res = mergeFrontmatter(localFm, baseFm, remoteFm);
      // Remote is preferred
      expect(res.merged.title).toBe('Remote Changed Title');
      expect(res.warnings.length).toBeGreaterThan(0);
      expect(res.warnings[0]).toContain("field 'title'");
    });
  });

  describe('hybrid3WayMerge', () => {
    it('executes separated frontmatter and markdown merge', () => {
      const base = {
        frontmatter: {
          id: validUlid,
          slug: 'article',
          title: 'Article',
          collection: 'posts',
          status: 'draft' as const,
          locale: 'ja',
          taxonomies: {},
          bylines: [],
        },
        body: '# Intro\n\nBase Section 1\n\nMiddle Section\n\nBase Section 2\n\nFooter',
      };

      const local: ParsedMarkdown = {
        frontmatter: {
          ...base.frontmatter,
          slug: 'article-local',
        },
        body: '# Intro\n\nLocal Section 1\n\nMiddle Section\n\nBase Section 2\n\nFooter',
        rawYaml: '',
      };

      const remote = {
        frontmatter: {
          ...base.frontmatter,
          status: 'published' as const,
        },
        body: '# Intro\n\nBase Section 1\n\nMiddle Section\n\nRemote Section 2\n\nFooter',
      };

      const res = hybrid3WayMerge(local, base, remote);
      expect(res.hasConflict).toBe(false);
      expect(res.frontmatter.slug).toBe('article-local');
      expect(res.frontmatter.status).toBe('published');
      expect(res.body).toContain('Local Section 1');
      expect(res.body).toContain('Remote Section 2');
    });
  });
});
