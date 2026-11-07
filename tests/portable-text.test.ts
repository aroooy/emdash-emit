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
  detectUnsupportedMarkdownSyntax,
  extractOpaqueBlockLines,
  markdownToPortableText,
  portableTextToMarkdown,
  verifyOpaqueBlocksUntampered,
  type PortableTextBlock,
} from '../src/client/portable-text.js';

describe('Portable Text <-> Markdown Conversion', () => {
  it('converts standard Markdown elements to PT and back to Markdown', () => {
    const inputMd = [
      '# Heading 1',
      '',
      '## Heading 2',
      '',
      'This is a paragraph with **bold** text, _italic_ text, and `inline code`.',
      '',
      '> A wise blockquote.',
      '',
      '- Unordered item 1',
      '- Unordered item 2',
      '',
      '1. Ordered item 1',
      '1. Ordered item 2',
      '',
      '```typescript',
      'const answer = 42;',
      '```',
      '',
      '![Example Image](https://example.com/pic.png)',
    ].join('\n');

    const blocks = markdownToPortableText(inputMd);
    expect(blocks.length).toBeGreaterThan(0);

    const outputMd = portableTextToMarkdown(blocks).trim();
    expect(outputMd).toContain('# Heading 1');
    expect(outputMd).toContain('## Heading 2');
    expect(outputMd).toContain('**bold**');
    expect(outputMd).toContain('_italic_');
    expect(outputMd).toContain('`inline code`');
    expect(outputMd).toContain('> A wise blockquote.');
    expect(outputMd).toContain('```typescript');
    expect(outputMd).toContain('const answer = 42;');
    expect(outputMd).toContain('![Example Image](https://example.com/pic.png)');
  });

  it('preserves unknown blocks as opaque comment fences (round-trip lossless)', () => {
    const customBlock: PortableTextBlock = {
      _type: 'core:gallery',
      _key: 'custom_key_123',
      columns: 3,
      images: [{ id: 'img1' }, { id: 'img2' }],
    };

    // Serialize PT with custom block to Markdown
    const md = portableTextToMarkdown([customBlock]);
    expect(md.trim()).toBe(`<!--ec:block ${JSON.stringify(customBlock)} -->`);

    // Parse Markdown back to PT
    const parsedBlocks = markdownToPortableText(md);
    expect(parsedBlocks.length).toBe(1);
    expect(parsedBlocks[0]).toEqual(customBlock);
  });

  describe('Opaque Block Safety Guard (G9)', () => {
    const baseMd = [
      '# My Article',
      '',
      'Intro paragraph.',
      '',
      '<!--ec:block {"_type":"core:gallery","_key":"1","items":["a"]} -->',
      '',
      'Footer text.',
    ].join('\n');

    it('extracts opaque fence lines correctly', () => {
      const fences = extractOpaqueBlockLines(baseMd);
      expect(fences).toHaveLength(1);
      expect(fences[0]).toBe('<!--ec:block {"_type":"core:gallery","_key":"1","items":["a"]} -->');
    });

    it('returns true when opaque fences are intact', () => {
      const localMd = [
        '# My Article (Edited)',
        '',
        'Intro paragraph with more details.',
        '',
        '<!--ec:block {"_type":"core:gallery","_key":"1","items":["a"]} -->',
        '',
        'Footer text.',
      ].join('\n');

      expect(verifyOpaqueBlocksUntampered(baseMd, localMd)).toBe(true);
    });

    it('returns false when an opaque fence is modified or removed', () => {
      const modifiedMd = [
        '# My Article',
        '',
        '<!--ec:block {"_type":"core:gallery","_key":"1","items":["modified"]} -->',
      ].join('\n');

      const deletedMd = '# My Article\n\nIntro paragraph.';

      expect(verifyOpaqueBlocksUntampered(baseMd, modifiedMd)).toBe(false);
      expect(verifyOpaqueBlocksUntampered(baseMd, deletedMd)).toBe(false);
    });
  });

  describe('Unsupported Syntax Detection', () => {
    it('detects markdown tables and raw HTML outside code blocks', () => {
      const invalidMd = [
        '# Title',
        '',
        '| Name | Age |',
        '| --- | --- |',
        '| Alice | 30 |',
        '',
        '<div class="callout">Warning</div>',
      ].join('\n');

      const warnings = detectUnsupportedMarkdownSyntax(invalidMd);
      expect(warnings.length).toBe(2);
      expect(warnings[0]).toMatch(/Markdown tables are not supported/i);
      expect(warnings[1]).toMatch(/Raw HTML block tags are not supported/i);
    });

    it('ignores tables or HTML tags inside code fences', () => {
      const validCodeSample = [
        '# Documentation',
        '',
        '```markdown',
        '| Name | Age |',
        '| --- | --- |',
        '| Alice | 30 |',
        '<div class="test">example</div>',
        '```',
      ].join('\n');

      const warnings = detectUnsupportedMarkdownSyntax(validCodeSample);
      expect(warnings).toHaveLength(0);
    });

    it('warns that tilde code fences degrade to plain paragraphs', () => {
      const tildeMd = [
        '# Guide',
        '',
        'Some prose.',
        '',
        '~~~json',
        '{ "enabled": true }',
        '~~~',
      ].join('\n');

      const warnings = detectUnsupportedMarkdownSyntax(tildeMd);
      expect(warnings.some((w) => /Tilde code fences/i.test(w))).toBe(true);

      // An indented tilde fence is detected too, and a tilde fence quoted inside a
      // backtick code fence is documentation, not markup, so it must stay silent.
      const indented = detectUnsupportedMarkdownSyntax('prose\n\n   ~~~json\n   {}\n   ~~~');
      expect(indented.some((w) => /Tilde code fences/i.test(w))).toBe(true);

      const quotedTilde = detectUnsupportedMarkdownSyntax(
        ['Real docs:', '', '````md', '~~~json', '{ "enabled": true }', '~~~', '````'].join('\n'),
      );
      expect(quotedTilde).toHaveLength(0);

      // Backtick code fences must never trigger the tilde warning
      expect(detectUnsupportedMarkdownSyntax('```json\n{ "a": 1 }\n```')).toHaveLength(0);
    });
  });
});
