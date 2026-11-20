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
  countPreservedOpaqueBlocks,
  detectUnsupportedMarkdownSyntax,
  extractOpaqueBlockLines,
  isPlainBreakBlock,
  isPlainImageBlock,
  isPlainTableBlock,
  isTaskListItem,
  markdownToPortableText,
  portableTextToMarkdown,
  resetKeyCounter,
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

  describe('Styled Image Block Fallback to Tier 3 (Fidelity Protection)', () => {
    it('isPlainImageBlock correctly identifies plain vs extended image blocks', () => {
      // 1. Plain image block
      expect(
        isPlainImageBlock({
          _type: 'image',
          _key: 'k1',
          alt: 'Plain',
          asset: { url: 'https://example.com/a.jpg' },
        }),
      ).toBe(true);

      // 2. Empty values (null, '', undefined) should still be considered plain (no over-fencing)
      expect(
        isPlainImageBlock({
          _type: 'image',
          _key: 'k2',
          alt: 'Empty props',
          caption: null,
          title: '',
          alignment: undefined,
          asset: { url: 'https://example.com/b.jpg' },
        }),
      ).toBe(true);

      // 3. Extended top-level properties (alignment, displayWidth, etc.)
      expect(
        isPlainImageBlock({
          _type: 'image',
          _key: 'k3',
          alt: 'Aligned',
          alignment: 'left',
          asset: { url: 'https://example.com/c.jpg' },
        }),
      ).toBe(false);

      expect(
        isPlainImageBlock({
          _type: 'image',
          _key: 'k4',
          displayWidth: 400,
          asset: { url: 'https://example.com/d.jpg' },
        }),
      ).toBe(false);

      expect(
        isPlainImageBlock({
          _type: 'image',
          _key: 'k5',
          caption: 'A caption',
          asset: { url: 'https://example.com/e.jpg' },
        }),
      ).toBe(false);

      // 4. Standard asset object carrying storageKey remains plain
      expect(
        isPlainImageBlock({
          _type: 'image',
          _key: 'k6',
          alt: 'Asset with storageKey',
          asset: { url: 'https://example.com/f.jpg', storageKey: '01M6ABC.jpg' },
        }),
      ).toBe(true);

      // 5. Unknown future properties (fail-safe whitelist)
      expect(
        isPlainImageBlock({
          _type: 'image',
          _key: 'k8',
          aspectRatio: '16:9',
          asset: { url: 'https://example.com/h.jpg' },
        }),
      ).toBe(false);

      // 6. Non-image block
      expect(isPlainImageBlock({ _type: 'block' })).toBe(false);
    });

    it('serializes plain image to standard markdown and styled image to opaque comment fence', () => {
      const plainBlock: PortableTextBlock = {
        _type: 'image',
        _key: 'plain1',
        alt: 'Plain Image',
        asset: { url: '/_emdash/api/media/file/plain.jpg' },
      };

      const styledBlock: PortableTextBlock = {
        _type: 'image',
        _key: 'styled1',
        alt: 'Styled Image',
        alignment: 'right',
        displayWidth: 350,
        asset: { url: '/_emdash/api/media/file/styled.jpg' },
      };

      const md = portableTextToMarkdown([plainBlock, styledBlock]);
      expect(md).toContain('![Plain Image](/_emdash/api/media/file/plain.jpg)');
      expect(md).toContain(`<!--ec:block ${JSON.stringify(styledBlock)} -->`);
    });

    it('guarantees round-trip fidelity for styled images without property loss', () => {
      const originalStyledBlock: PortableTextBlock = {
        _type: 'image',
        _key: 'k_styled_roundtrip',
        alt: 'Hero',
        alignment: 'center',
        displayWidth: 600,
        displayHeight: 400,
        caption: 'Hero Caption',
        asset: {
          url: '/_emdash/api/media/file/01M7EYKSMGZE29ZYY4J4EW1JMT.jpg',
        },
      };

      // 1. PT -> Markdown
      const md = portableTextToMarkdown([originalStyledBlock]);
      expect(md.trim()).toBe(`<!--ec:block ${JSON.stringify(originalStyledBlock)} -->`);

      // 2. Markdown -> PT
      const parsedBlocks = markdownToPortableText(md);
      expect(parsedBlocks.length).toBe(1);
      expect(parsedBlocks[0]).toEqual(originalStyledBlock);
      expect(parsedBlocks[0].alignment).toBe('center');
      expect(parsedBlocks[0].displayWidth).toBe(600);
      expect(parsedBlocks[0].caption).toBe('Hero Caption');
    });

    it('safely handles edge cases like alt text containing "-->" without regex corruption', () => {
      const edgeCaseBlock: PortableTextBlock = {
        _type: 'image',
        _key: 'k_edge',
        alt: 'pointing --> this way',
        alignment: 'left',
        asset: { url: '/_emdash/api/media/file/edge.jpg' },
      };

      const md = portableTextToMarkdown([edgeCaseBlock]);
      expect(md.trim()).toBe(`<!--ec:block ${JSON.stringify(edgeCaseBlock)} -->`);

      const parsed = markdownToPortableText(md);
      expect(parsed.length).toBe(1);
      expect(parsed[0]).toEqual(edgeCaseBlock);
      expect(parsed[0].alt).toBe('pointing --> this way');
      expect(parsed[0].alignment).toBe('left');
    });
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
    it('detects raw HTML outside code blocks (GFM tables are now supported: T5-6)', () => {
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
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toMatch(/Raw HTML block tags are not supported/i);
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

  describe('countPreservedOpaqueBlocks', () => {
    it('counts opaque block fences while strictly excluding code blocks', () => {
      const markdown = [
        '# Article with styled images and code blocks',
        '',
        '<!--ec:block {"_type":"image","_key":"k0","alt":"img.png","alignment":"left"} -->',
        '',
        'Here is a code example explaining opaque blocks:',
        '',
        '```markdown',
        '<!--ec:block {"_type":"image","sample":true} -->',
        '<!--ec:block {"_type":"callout"} -->',
        '```',
        '',
        '<!--ec:block {"_type":"image","_key":"k1","alt":"img2.png","displayWidth":400} -->',
        '',
        'End of article.',
      ].join('\n');

      expect(countPreservedOpaqueBlocks(markdown)).toBe(2);
    });

    it('returns 0 when markdown has no opaque blocks or only code-fenced samples', () => {
      const codeOnly = [
        '# Tutorial',
        '',
        '```html',
        '<!--ec:block {"_type":"test"} -->',
        '```',
      ].join('\n');
      expect(countPreservedOpaqueBlocks(codeOnly)).toBe(0);
      expect(countPreservedOpaqueBlocks('Plain markdown without any blocks.')).toBe(0);
      expect(countPreservedOpaqueBlocks('')).toBe(0);
    });
  });

  describe('GFM Table <-> EmDash Table Block (v0.1.39 P5)', () => {
    it('T5-1: converts GFM pipe table to canonical table block with headers and alignments', () => {
      const markdown = [
        '| Header Left | Header Center | Header Right | Default |',
        '| :--- | :---: | ---: | --- |',
        '| A1 | B1 | C1 | D1 |',
        '| A2 | B2 | C2 | D2 |',
      ].join('\n');

      const blocks = markdownToPortableText(markdown);
      expect(blocks).toHaveLength(1);

      const table = blocks[0] as Record<string, unknown>;
      expect(table._type).toBe('table');
      expect(table.hasHeaderRow).toBe(true);

      const rows = table.rows as Array<{
        _type: string;
        cells: Array<{
          _type: string;
          isHeader: boolean;
          textAlign?: string;
          content: Array<{ _type: string; text: string }>;
        }>;
      }>;
      expect(rows).toHaveLength(3);

      // Header row
      expect(rows[0]._type).toBe('tableRow');
      expect(rows[0].cells).toHaveLength(4);
      expect(rows[0].cells[0].isHeader).toBe(true);
      expect(rows[0].cells[0].textAlign).toBe('left');
      expect(rows[0].cells[0].content[0].text).toBe('Header Left');

      expect(rows[0].cells[1].isHeader).toBe(true);
      expect(rows[0].cells[1].textAlign).toBe('center');
      expect(rows[0].cells[1].content[0].text).toBe('Header Center');

      expect(rows[0].cells[2].isHeader).toBe(true);
      expect(rows[0].cells[2].textAlign).toBe('right');
      expect(rows[0].cells[2].content[0].text).toBe('Header Right');

      expect(rows[0].cells[3].isHeader).toBe(true);
      expect(rows[0].cells[3].textAlign).toBeUndefined();

      // Body row
      expect(rows[1]._type).toBe('tableRow');
      expect(rows[1].cells[0].isHeader).toBe(false);
      expect(rows[1].cells[0].textAlign).toBe('left');
      expect(rows[1].cells[0].content[0].text).toBe('A1');

      expect(rows[1].cells[1].isHeader).toBe(false);
      expect(rows[1].cells[1].textAlign).toBe('center');
      expect(rows[1].cells[1].content[0].text).toBe('B1');
    });

    it('T5-2: parses inline marks in cells and ensures empty cells have fallback spans', () => {
      const markdown = [
        '| Syntax | Description | Extra |',
        '| --- | --- | --- |',
        '| **bold** | _italic_ and `code` | [link](https://example.com) |',
        '| ~~strike~~ | | |',
      ].join('\n');

      const blocks = markdownToPortableText(markdown);
      const table = blocks[0] as Record<string, unknown>;
      const rows = table.rows as Array<{
        cells: Array<{
          content: Array<{ _type: string; text: string; marks: string[] }>;
          markDefs: Array<{ _key: string; _type: string; href?: string }>;
        }>;
      }>;

      // Row 1 with inline marks
      const row1 = rows[1];
      expect(row1.cells[0].content[0].text).toBe('bold');
      expect(row1.cells[0].content[0].marks).toContain('strong');

      expect(row1.cells[1].content.some((s) => s.text === 'italic' && s.marks.includes('em'))).toBe(
        true,
      );
      expect(row1.cells[1].content.some((s) => s.text === 'code' && s.marks.includes('code'))).toBe(
        true,
      );

      expect(row1.cells[2].content[0].text).toBe('link');
      expect(row1.cells[2].markDefs).toHaveLength(1);
      expect(row1.cells[2].markDefs[0].href).toBe('https://example.com');

      // Row 2 with empty cells
      const row2 = rows[2];
      expect(row2.cells[0].content[0].marks).toContain('strike-through');
      expect(row2.cells[1].content).toHaveLength(1);
      expect(row2.cells[1].content[0].text).toBe('');
      expect(row2.cells[2].content).toHaveLength(1);
      expect(row2.cells[2].content[0].text).toBe('');
    });

    it('T5-3: lossless round-trip between canonical table block and GFM pipe table', () => {
      const originalMd = [
        '| Feature | Supported | Alignment |',
        '| :--- | :---: | ---: |',
        '| Bold text | **Yes** | Left |',
        '| Empty cell |  | Right |',
      ].join('\n');

      resetKeyCounter();
      const blocks = markdownToPortableText(originalMd);
      const renderedMd = portableTextToMarkdown(blocks).trim();

      expect(renderedMd).toBe(originalMd);

      resetKeyCounter();
      const reParsedBlocks = markdownToPortableText(renderedMd);
      expect(reParsedBlocks).toEqual(blocks);
    });

    it('T5-4: falls back to Tier-3 opaque comment fence for non-GFM table features', () => {
      // 1. Table with colspan > 1
      const colspanTable: PortableTextBlock = {
        _type: 'table',
        _key: 'tbl_colspan',
        hasHeaderRow: true,
        rows: [
          {
            _type: 'tableRow',
            _key: 'r1',
            cells: [
              {
                _type: 'tableCell',
                _key: 'c1',
                colspan: 2,
                content: [{ _type: 'span', _key: 's1', text: 'Merged', marks: [] }],
              },
            ],
          },
        ],
      };
      expect(isPlainTableBlock(colspanTable)).toBe(false);
      const mdColspan = portableTextToMarkdown([colspanTable]).trim();
      expect(mdColspan).toBe(`<!--ec:block ${JSON.stringify(colspanTable)} -->`);

      // 2. Table with hasHeaderRow = false
      const noHeaderTable: PortableTextBlock = {
        _type: 'table',
        _key: 'tbl_nohead',
        hasHeaderRow: false,
        rows: [
          {
            _type: 'tableRow',
            _key: 'r1',
            cells: [
              {
                _type: 'tableCell',
                _key: 'c1',
                content: [{ _type: 'span', _key: 's1', text: 'Data', marks: [] }],
              },
            ],
          },
        ],
      };
      expect(isPlainTableBlock(noHeaderTable)).toBe(false);
      const mdNoHead = portableTextToMarkdown([noHeaderTable]).trim();
      expect(mdNoHead).toBe(`<!--ec:block ${JSON.stringify(noHeaderTable)} -->`);

      // Round-trip preservation via opaque fence
      const parsedColspan = markdownToPortableText(mdColspan);
      expect(parsedColspan[0]).toEqual(colspanTable);
    });

    it('T5-5: table cell containing image markdown is treated as cell content, not block image', () => {
      const markdown = [
        '| Icon | Description |',
        '| --- | --- |',
        '| ![Logo](https://example.com/logo.png) | Company Logo |',
      ].join('\n');

      const blocks = markdownToPortableText(markdown);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]._type).toBe('table');
      // No block-level image was generated
      expect(blocks.some((b) => b._type === 'image')).toBe(false);
    });
  });

  describe('Inline Formatting & Flanking Delimiters (v0.1.40 P1)', () => {
    it('T1-1: *single asterisk italic* is parsed to span with em mark', () => {
      const blocks = markdownToPortableText('*single asterisk italic*');
      expect(blocks).toHaveLength(1);
      const span = blocks[0].children?.[0];
      expect(span?.text).toBe('single asterisk italic');
      expect(span?.marks).toEqual(['em']);
    });

    it('T1-2: __double underscore bold__ is parsed to span with strong mark', () => {
      const blocks = markdownToPortableText('__double underscore bold__');
      expect(blocks).toHaveLength(1);
      const span = blocks[0].children?.[0];
      expect(span?.text).toBe('double underscore bold');
      expect(span?.marks).toEqual(['strong']);
    });

    it('T1-3: intraword underscore (foo_bar_baz) is not italicized (CommonMark flanking delimiter)', () => {
      const blocks = markdownToPortableText('foo_bar_baz qux');
      expect(blocks).toHaveLength(1);
      const children = blocks[0].children ?? [];
      expect(children).toHaveLength(1);
      expect(children[0].text).toBe('foo_bar_baz qux');
      expect(children[0].marks).toEqual([]);
    });

    it('T1-4: intraword asterisk (foo*bar*baz) produces em for bar (CommonMark intraword asterisk)', () => {
      const blocks = markdownToPortableText('foo*bar*baz');
      expect(blocks).toHaveLength(1);
      const children = blocks[0].children ?? [];
      expect(children).toHaveLength(3);
      expect(children[0].text).toBe('foo');
      expect(children[0].marks).toEqual([]);
      expect(children[1].text).toBe('bar');
      expect(children[1].marks).toEqual(['em']);
      expect(children[2].text).toBe('baz');
      expect(children[2].marks).toEqual([]);
    });

    it('T1-5: nested emphasis demonstrates flat scanning boundary (_see `code` now_ degrades linearly)', () => {
      // Flat regex scan parses linearly without an AST tree (documented limitation in §3.1 and §6)
      const blocks = markdownToPortableText('_see `code` now_');
      expect(blocks).toHaveLength(1);
      const span = blocks[0].children?.[0];
      // Code is swallowed into em text rather than creating a nested mark
      expect(span?.text).toBe('see `code` now');
      expect(span?.marks).toEqual(['em']);
    });

    it('T1-6: round-trip normalization (*italic* -> PT -> _italic_ -> PT produces identical AST)', () => {
      const blocksFromAsterisk = markdownToPortableText('*italic text*');
      const markdown = portableTextToMarkdown(blocksFromAsterisk).trim();
      expect(markdown).toBe('_italic text_');
      const blocksFromUnderscore = markdownToPortableText(markdown);
      expect(blocksFromUnderscore[0].children?.[0].marks).toEqual(['em']);
      expect(blocksFromUnderscore[0].children?.[0].text).toBe('italic text');
    });

    it('T1-7: intraword emphasis (foo*bar*baz) preserves AST symmetrically upon reverse conversion (Loss-Free)', () => {
      const input = 'foo*bar*baz';
      const pt1 = markdownToPortableText(input);
      const outputMd = portableTextToMarkdown(pt1).trim();
      expect(outputMd).toBe('foo*bar*baz');
      const pt2 = markdownToPortableText(outputMd);
      expect(pt2[0].children?.[1].text).toBe('bar');
      expect(pt2[0].children?.[1].marks).toEqual(['em']);
    });
  });

  describe('Autolinks (v0.1.40 P2)', () => {
    it('T2-1: converts <https://example.com> to link markDef + span', () => {
      const blocks = markdownToPortableText('Visit <https://example.com/docs> today');
      expect(blocks).toHaveLength(1);
      const markDefs = blocks[0].markDefs ?? [];
      expect(markDefs).toHaveLength(1);
      expect(markDefs[0]._type).toBe('link');
      expect(markDefs[0].href).toBe('https://example.com/docs');

      const linkSpan = blocks[0].children?.find((c) => c.marks?.includes(markDefs[0]._key));
      expect(linkSpan).toBeDefined();
      expect(linkSpan?.text).toBe('https://example.com/docs');
    });

    it('T2-2: converts <mailto:user@example.com> to link markDef + span', () => {
      const blocks = markdownToPortableText('Contact <mailto:support@example.com> for help');
      expect(blocks).toHaveLength(1);
      const markDefs = blocks[0].markDefs ?? [];
      expect(markDefs).toHaveLength(1);
      expect(markDefs[0]._type).toBe('link');
      expect(markDefs[0].href).toBe('mailto:support@example.com');
    });

    it('T2-3: PT -> Markdown reverse conversion serializes autolinks to <url> single form', () => {
      const blocks = markdownToPortableText('Link to <https://example.com/api>');
      const md = portableTextToMarkdown(blocks).trim();
      expect(md).toBe('Link to <https://example.com/api>');
    });

    it('T2-4: normal Markdown link with matching text/href also normalizes to <url>', () => {
      const blocks = markdownToPortableText('Link to [https://example.com](https://example.com)');
      const md = portableTextToMarkdown(blocks).trim();
      expect(md).toBe('Link to <https://example.com>');
    });

    it('T2-5: normal Markdown link with distinct text preserves [text](url) format', () => {
      const blocks = markdownToPortableText('Link to [Homepage](https://example.com)');
      const md = portableTextToMarkdown(blocks).trim();
      expect(md).toBe('Link to [Homepage](https://example.com)');
    });
  });

  describe('Task List Safe Mapping (v0.1.40 P4)', () => {
    it('T4-1: maintains - [ ] and - [x] as unordered list items without corruption', () => {
      const input = [
        '- [ ] Uncompleted task',
        '- [x] Completed task',
        '- [X] Uppercase completed task',
      ].join('\n');

      const blocks = markdownToPortableText(input);
      expect(blocks).toHaveLength(3);
      for (const block of blocks) {
        expect(block.listItem).toBe('bullet');
      }
      expect(blocks[0].children?.[0].text).toBe('[ ] Uncompleted task');
      expect(blocks[1].children?.[0].text).toBe('[x] Completed task');
      expect(blocks[2].children?.[0].text).toBe('[X] Uppercase completed task');

      const output = portableTextToMarkdown(blocks).trim();
      expect(output).toBe(input);
    });

    it('T4-2: isTaskListItem correctly identifies checkboxes and extracts state and text', () => {
      expect(isTaskListItem('[ ] todo item')).toEqual({ checked: false, text: 'todo item' });
      expect(isTaskListItem('[x] done item')).toEqual({ checked: true, text: 'done item' });
      expect(isTaskListItem('[X] done item')).toEqual({ checked: true, text: 'done item' });
      expect(isTaskListItem('regular item')).toBeNull();
      expect(isTaskListItem('[link](url)')).toBeNull();
    });
  });

  describe('Unsupported Syntax Detection (v0.1.40 P5)', () => {
    it('T5-1: detects Setext heading syntax (Title\\n------\\nBody)', () => {
      const warnings = detectUnsupportedMarkdownSyntax('Title\n------\nBody');
      expect(warnings.some((w) => w.includes('Setext headings'))).toBe(true);
    });

    it('T5-2: detects Setext heading without preceding blank line (Some text\\n---\\nmore)', () => {
      const warnings = detectUnsupportedMarkdownSyntax('Some text\n---\nmore');
      expect(warnings.some((w) => w.includes('Setext headings'))).toBe(true);
    });

    it('T5-3: does not warn on ATX headings, standalone hr, tables, or documented intentional limitations', () => {
      expect(detectUnsupportedMarkdownSyntax('# Heading 1\n## Heading 2')).toEqual([]);
      expect(detectUnsupportedMarkdownSyntax('Some text\n\n---\n\nMore text')).toEqual([]);
      expect(detectUnsupportedMarkdownSyntax('| a | b |\n| --- | --- |\n| 1 | 2 |')).toEqual([]);
      // Documented intentional limitations:
      expect(detectUnsupportedMarkdownSyntax('| a |\n---\nx')).toEqual([]);
      expect(detectUnsupportedMarkdownSyntax('- item\n---\nx')).toEqual([]);
    });

    it('T5-4: does not warn when the parser already resolves the underline into a thematic break', () => {
      // These lines are preceded by a non-paragraph block, so CommonMark treats the
      // '---' as a thematic break (which markdownToPortableText converts correctly).
      // Warning here would be a false positive: it tells users to "fix" valid content.
      for (const input of ['> quote\n---\nx', '# H\n---\nbody']) {
        expect(detectUnsupportedMarkdownSyntax(input)).toEqual([]);
      }

      // Cross-check that the parser really does produce a break block for them.
      resetKeyCounter();
      const blocks = markdownToPortableText('> quote\n---\nx');
      expect(blocks.some((b) => b._type === 'break')).toBe(true);
    });

    it('T5-5: warns on Setext h1 underline (===) as well as h2 (---)', () => {
      const warnings = detectUnsupportedMarkdownSyntax('Title\n===\nBody');
      expect(warnings.some((w) => w.includes('Setext headings'))).toBe(true);
    });

    it('T5-6: documents the accepted limitation for *, + and ordered list markers', () => {
      // G8 inspects only the first character of a line, so it cannot classify block
      // types the way isProseParagraphLine() does. These inputs therefore warn even
      // though the parser resolves '---' into a correct thematic break. The warning is
      // cosmetic (push still proceeds); the AST is verified correct below.
      for (const input of ['* item\n---\nx', '+ item\n---\nx', '1. item\n---\nx']) {
        expect(
          detectUnsupportedMarkdownSyntax(input).some((w) => w.includes('Setext headings')),
        ).toBe(true);
        resetKeyCounter();
        const blocks = markdownToPortableText(input);
        expect(blocks.some((b) => b._type === 'break')).toBe(true);
      }

      // Guard rail: these legitimate Setext headings MUST keep being detected. Widening
      // the negated class with '*', '+' or digits to silence the warnings above would
      // silently break them, which is why that "fix" is prohibited (see plan §3.5).
      for (const input of ['*emphasized text*\n---', '2026 was great\n---']) {
        expect(
          detectUnsupportedMarkdownSyntax(input).some((w) => w.includes('Setext headings')),
        ).toBe(true);
      }
    });
  });

  describe('Thematic Break <-> EmDash Break Block (v0.1.40 P3)', () => {
    it('T3-1: converts standalone ---, ***, ___ to break blocks (and ___ is not misidentified as em)', () => {
      const input = [
        'Paragraph 1',
        '',
        '---',
        '',
        'Paragraph 2',
        '',
        '***',
        '',
        'Paragraph 3',
        '',
        '___',
        '',
        'Paragraph 4',
      ].join('\n');

      const blocks = markdownToPortableText(input);
      expect(blocks).toHaveLength(7);
      expect(blocks[1]._type).toBe('break');
      expect(blocks[3]._type).toBe('break');
      expect(blocks[5]._type).toBe('break');
      // Verify ___ is not misidentified as em mark
      expect(
        blocks.some((b) => b._type === 'block' && b.children?.[0]?.marks?.includes('em')),
      ).toBe(false);
    });

    it('T3-2: --- inside code fence is preserved as code and not converted to break', () => {
      const input = ['```markdown', '---', 'title: test', '---', '```'].join('\n');

      const blocks = markdownToPortableText(input);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]._type).toBe('code');
      expect(blocks[0].code).toContain('---');
    });

    it('T3-3: table delimiter row (| --- |) does not collide with thematic breaks', () => {
      const input = ['| Name | Age |', '| --- | --- |', '| Alice | 30 |'].join('\n');

      const blocks = markdownToPortableText(input);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]._type).toBe('table');
      expect(blocks.some((b) => b._type === 'break')).toBe(false);
    });

    it('T3-4: lossless round-trip between canonical break block and markdown (---)', () => {
      const input = 'First section\n\n---\n\nSecond section';
      const blocks = markdownToPortableText(input);
      expect(blocks).toHaveLength(3);
      expect(blocks[1]._type).toBe('break');

      const output = portableTextToMarkdown(blocks).trim();
      expect(output).toBe(input);

      // Tolerance: legacy 'divider' and 'hr' also serialize cleanly to '---'
      const legacyDivider: PortableTextBlock = { _type: 'divider', _key: 'd1' };
      const legacyHr: PortableTextBlock = { _type: 'hr', _key: 'h1' };
      expect(portableTextToMarkdown([legacyDivider]).trim()).toBe('---');
      expect(portableTextToMarkdown([legacyHr]).trim()).toBe('---');
    });

    it('T3-5: extended break block with custom attributes falls back to Tier-3 opaque comment fence', () => {
      const plainBreak: PortableTextBlock = { _type: 'break', _key: 'b1' };
      expect(isPlainBreakBlock(plainBreak)).toBe(true);

      const extendedBreak: PortableTextBlock = {
        _type: 'break',
        _key: 'b2',
        style: 'dashed',
        color: '#ff0000',
      };
      expect(isPlainBreakBlock(extendedBreak)).toBe(false);

      const mdExtended = portableTextToMarkdown([extendedBreak]).trim();
      expect(mdExtended).toBe(`<!--ec:block ${JSON.stringify(extendedBreak)} -->`);

      // Round-trip preservation via opaque fence
      const parsed = markdownToPortableText(mdExtended);
      expect(parsed[0]).toEqual(extendedBreak);
    });

    it('T3-6: text immediately followed by --- without empty line is treated as Setext heading, not break', () => {
      const input = 'Section Title\n---\nBody text';
      const blocks = markdownToPortableText(input);
      // The line '---' is not converted to break block; it remains a paragraph text line
      expect(blocks.some((b) => b._type === 'break')).toBe(false);
    });
  });
});
