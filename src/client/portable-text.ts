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

/**
 * EmDash Portable Text <-> Markdown conversion layer.
 * Ported from EmDash (packages/core/src/client/portable-text.ts)
 * Licensed under the MIT License. Copyright (c) EmDash authors.
 *
 * Three tiers of block handling:
 *   Tier 1: Standard PT blocks <-> standard Markdown (headings, paragraphs, lists, etc.)
 *   Tier 2: EmDash custom blocks <-> Markdown directives (future)
 *   Tier 3: Unknown blocks <-> opaque HTML comment fences (preserved, not editable)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal Portable Text block shape */
export interface PortableTextBlock {
  _type: string;
  _key?: string;
  style?: string;
  level?: number;
  listItem?: string;
  markDefs?: MarkDef[];
  children?: PortableTextSpan[];
  [key: string]: unknown;
}

interface PortableTextSpan {
  _type: string;
  _key?: string;
  text?: string;
  marks?: string[];
  [key: string]: unknown;
}

interface MarkDef {
  _key: string;
  _type: string;
  href?: string;
  [key: string]: unknown;
}

interface ParsedInline {
  spans: PortableTextSpan[];
  markDefs: MarkDef[];
}

// ---------------------------------------------------------------------------
// PT -> Markdown
// ---------------------------------------------------------------------------

/** Known property keys for plain Portable Text image blocks expressible in standard Markdown (Tier 1). */
const KNOWN_PLAIN_IMAGE_KEYS = new Set(['_type', '_key', 'alt', 'asset']);

/**
 * Reports whether an image block carries only plain properties expressible in standard Markdown (![alt](url)).
 * Returns false if the block carries layout, styling, or custom metadata (e.g. alignment, displayWidth,
 * displayHeight, caption, title, crop, hotspot, etc.).
 */
export function isPlainImageBlock(block: Record<string, unknown>): boolean {
  if (block._type !== 'image') return false;

  // Check for extended top-level properties beyond Tier 1 plain image keys
  for (const [key, value] of Object.entries(block)) {
    if (!KNOWN_PLAIN_IMAGE_KEYS.has(key) && value !== undefined && value !== null && value !== '') {
      return false;
    }
  }

  return true;
}

/**
 * Reports whether a table block carries only plain properties expressible in standard GFM Markdown.
 * Returns false if the table uses extended features such as colspan/rowspan > 1, custom column widths,
 * multiple paragraphs inside a cell, header rows in body positions, or lacks a header row.
 */
export function isPlainTableBlock(block: Record<string, unknown>): boolean {
  if (block._type !== 'table') return false;
  if (!Array.isArray(block.rows) || block.rows.length === 0) return false;

  // GFM requires a header row. If hasHeaderRow is explicitly false, it cannot be GFM.
  if (block.hasHeaderRow === false) return false;

  const firstRow = block.rows[0] as Record<string, unknown> | undefined;
  if (
    !firstRow ||
    firstRow._type !== 'tableRow' ||
    !Array.isArray(firstRow.cells) ||
    firstRow.cells.length === 0
  ) {
    return false;
  }

  const colCount = firstRow.cells.length;

  for (let rIndex = 0; rIndex < block.rows.length; rIndex++) {
    const row = block.rows[rIndex] as Record<string, unknown>;
    if (!row || row._type !== 'tableRow' || !Array.isArray(row.cells)) return false;
    if (row.cells.length !== colCount) return false;

    for (const cell of row.cells as Array<Record<string, unknown>>) {
      if (!cell || cell._type !== 'tableCell') return false;

      // Colspan / Rowspan > 1 cannot be represented in GFM
      if (typeof cell.colspan === 'number' && cell.colspan > 1) return false;
      if (typeof cell.rowspan === 'number' && cell.rowspan > 1) return false;
      if (typeof cell.colSpan === 'number' && cell.colSpan > 1) return false;
      if (typeof cell.rowSpan === 'number' && cell.rowSpan > 1) return false;
      if (cell.colwidth !== undefined || cell.colWidth !== undefined) return false;

      // In GFM, only row 0 is header. A subsequent row having isHeader: true cannot be GFM.
      if (rIndex > 0 && cell.isHeader === true) return false;

      // Cell content inspection: must be inline spans or single normal block without newlines
      if (Array.isArray(cell.content)) {
        if (cell.content.length > 1) {
          const isAllSpans = cell.content.every(
            (c) => c && typeof c === 'object' && (c as Record<string, unknown>)._type === 'span',
          );
          if (!isAllSpans) return false;
        }
        for (const item of cell.content as Array<Record<string, unknown>>) {
          if (!item || typeof item !== 'object') return false;
          if (item._type === 'span') {
            if (typeof item.text === 'string' && item.text.includes('\n')) return false;
          } else if (item._type === 'block') {
            if (item.style && item.style !== 'normal') return false;
            if (Array.isArray(item.children)) {
              for (const child of item.children as Array<Record<string, unknown>>) {
                if (child && typeof child.text === 'string' && child.text.includes('\n')) {
                  return false;
                }
              }
            }
          } else {
            return false;
          }
        }
      }
    }
  }

  return true;
}

const TASK_LIST_ITEM_PATTERN = /^\[([ xX])\]\s+(.*)$/;

/**
 * Checks if a string starts with a task list item checkbox (`[ ] ` or `[x] `).
 * Returns the checkbox state and remaining text if matched, or null otherwise.
 *
 * NOTE: Currently uninvoked in active parse pipeline (which preserves `- [ ]` as plain
 * list text); reserved as a Layer 0 contract helper for future EmDash task-list schema integration (P4).
 */
export function isTaskListItem(text: string): { checked: boolean; text: string } | null {
  const match = text.match(TASK_LIST_ITEM_PATTERN);
  if (!match) return null;
  return {
    checked: match[1]!.toLowerCase() === 'x',
    text: match[2]!,
  };
}

const KNOWN_PLAIN_BREAK_KEYS = new Set(['_type', '_key']);

/**
 * Reports whether a break block carries only plain properties expressible in standard Markdown (`---`).
 * Returns false if the block carries custom metadata, layout, or extended styling properties,
 * safely preserving it as an opaque comment fence (Tier 3) to prevent data loss.
 */
export function isPlainBreakBlock(block: Record<string, unknown>): boolean {
  if (block._type !== 'break' && block._type !== 'divider' && block._type !== 'hr') {
    return false;
  }

  // Check for extended properties beyond Tier 1 plain break keys
  for (const [key, value] of Object.entries(block)) {
    if (!KNOWN_PLAIN_BREAK_KEYS.has(key) && value !== undefined && value !== null && value !== '') {
      return false;
    }
  }

  return true;
}

function renderTableCell(cell: Record<string, unknown>): string {
  let cellText = '';
  if (Array.isArray(cell.content)) {
    const markDefs = (cell.markDefs as MarkDef[]) ?? [];
    for (const item of cell.content as Array<Record<string, unknown>>) {
      if (item && typeof item === 'object') {
        if (item._type === 'span') {
          cellText += renderSpans([item as PortableTextSpan], markDefs);
        } else if (item._type === 'block') {
          const block = item as PortableTextBlock;
          cellText += renderSpans(block.children ?? [], block.markDefs ?? markDefs);
        }
      }
    }
  }
  return cellText.replace(/\\\|/g, '|').replace(/\|/g, '\\|').trim();
}

function renderTableBlock(block: Record<string, unknown>): string {
  const rows = block.rows as Array<Record<string, unknown>>;
  if (!rows || rows.length === 0) return '';

  const firstRow = rows[0];
  const firstCells = (firstRow.cells as Array<Record<string, unknown>>) ?? [];

  const alignments = firstCells.map((c) => (c.textAlign as string | undefined) ?? undefined);

  const lines: string[] = [];

  // Header row
  const headerTexts = firstCells.map(renderTableCell);
  lines.push(`| ${headerTexts.join(' | ')} |`);

  // Delimiter row
  const delimTexts = alignments.map((align) => {
    if (align === 'center') return ':---:';
    if (align === 'right') return '---:';
    if (align === 'left') return ':---';
    return '---';
  });
  lines.push(`| ${delimTexts.join(' | ')} |`);

  // Body rows
  for (let i = 1; i < rows.length; i++) {
    const cells = (rows[i].cells as Array<Record<string, unknown>>) ?? [];
    const cellTexts = cells.map(renderTableCell);
    lines.push(`| ${cellTexts.join(' | ')} |`);
  }

  return lines.join('\n');
}

/**
 * Convert Portable Text blocks to Markdown.
 * Unknown block types are serialized as opaque fences.
 */
export function portableTextToMarkdown(blocks: PortableTextBlock[]): string {
  const lines: string[] = [];
  let prevWasList = false;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    if (block._type === 'block') {
      const isList = !!block.listItem;

      // Blank line between non-contiguous block types
      if (i > 0 && (!isList || !prevWasList)) {
        lines.push('');
      }

      lines.push(renderStandardBlock(block));
      prevWasList = isList;
    } else if (block._type === 'code') {
      if (i > 0) lines.push('');
      const lang = (block.language as string) || '';
      const code = (block.code as string) || '';
      lines.push('```' + lang);
      lines.push(code);
      lines.push('```');
      prevWasList = false;
    } else if (block._type === 'image' && isPlainImageBlock(block)) {
      if (i > 0) lines.push('');
      const alt = (block.alt as string) || '';
      const url = (block.asset as { url?: string })?.url || '';
      lines.push(`![${alt}](${url})`);
      prevWasList = false;
    } else if (block._type === 'table' && isPlainTableBlock(block)) {
      if (i > 0) lines.push('');
      lines.push(renderTableBlock(block));
      prevWasList = false;
    } else if (isPlainBreakBlock(block)) {
      if (i > 0) lines.push('');
      lines.push('---');
      prevWasList = false;
    } else {
      // Tier 3: Unknown or extended block -> opaque fence
      if (i > 0) lines.push('');
      lines.push(`<!--ec:block ${JSON.stringify(block)} -->`);
      prevWasList = false;
    }
  }

  return lines.join('\n') + '\n';
}

function renderStandardBlock(block: PortableTextBlock): string {
  const text = renderSpans(block.children ?? [], block.markDefs ?? []);

  // List items
  if (block.listItem) {
    const indent = '  '.repeat(Math.max(0, (block.level ?? 1) - 1));
    const marker = block.listItem === 'number' ? '1.' : '-';
    return `${indent}${marker} ${text}`;
  }

  // Headings
  if (block.style && block.style.startsWith('h')) {
    const level = parseInt(block.style.substring(1), 10);
    if (level >= 1 && level <= 6) {
      return `${'#'.repeat(level)} ${text}`;
    }
  }

  // Blockquote
  if (block.style === 'blockquote') {
    return `> ${text}`;
  }

  return text;
}

function renderSpans(spans: PortableTextSpan[], markDefs: MarkDef[]): string {
  let result = '';

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (span._type !== 'span') continue;

    let text = span.text ?? '';
    const marks = span.marks ?? [];

    for (const mark of marks) {
      const def = markDefs.find((d) => d._key === mark);
      if (def) {
        if (def._type === 'link') {
          if (text === def.href && /^(?:https?|mailto):/i.test(text)) {
            text = `<${text}>`;
          } else {
            text = `[${text}](${def.href ?? ''})`;
          }
        }
      } else {
        switch (mark) {
          case 'strong':
            text = `**${text}**`;
            break;
          case 'em': {
            // CommonMark flanking delimiter symmetry: `_` is intraword-disabled (flanked by [a-zA-Z0-9]),
            // whereas `*` is intraword-enabled. If preceding character (from prior rendered output)
            // or succeeding character (from subsequent spans) is alphanumeric, emit `*` to guarantee
            // Loss-Free AST round-trip and prevent diff3 phantom conflicts during 3-way merge.
            const prevChar = result.slice(-1);
            let nextChar = '';
            // Note: subsequent spans with markDefs (e.g. link/code/strike) prepend non-alphanumeric
            // syntax characters ([ ` ~ <), so inspecting nextSpanText[0] is structurally safe.
            for (let j = i + 1; j < spans.length; j++) {
              const nextSpanText = spans[j]?.text ?? '';
              if (nextSpanText.length > 0) {
                nextChar = nextSpanText[0]!;
                break;
              }
            }
            const isIntraword = /[a-zA-Z0-9]/.test(prevChar) || /[a-zA-Z0-9]/.test(nextChar);
            text = isIntraword ? `*${text}*` : `_${text}_`;
            break;
          }
          case 'code':
            text = `\`${text}\``;
            break;
          case 'strike-through':
          case 'strikethrough':
            text = `~~${text}~~`;
            break;
        }
      }
    }

    result += text;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Markdown -> PT
// ---------------------------------------------------------------------------

// Regex patterns for markdown parsing
const OPAQUE_FENCE_PATTERN = /^<!--ec:block (.+) -->$/;
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;
const UNORDERED_LIST_PATTERN = /^(\s*)[-*+]\s+(.+)$/;
const ORDERED_LIST_PATTERN = /^(\s*)\d+\.\s+(.+)$/;
const IMAGE_PATTERN = /^!\[([^\]]*)\]\(([^)]+)\)$/;
const THEMATIC_BREAK_PATTERN = /^ {0,3}(?:---|\*\*\*|___)\s*$/;
const INLINE_MARKDOWN_PATTERN =
  /(\*\*(?!\s|\*)(.+?)(?<!\s|\*)\*\*)|((?<![a-zA-Z0-9])__(?!\s|_)(.+?)(?<!\s|_)__(?![a-zA-Z0-9]))|(\*(?!\s|\*)(.+?)(?<!\s|\*)\*)|((?<![a-zA-Z0-9])_(?!\s|_)(.+?)(?<!\s|_)_(?![a-zA-Z0-9]))|(`(.+?)`)|(\[(.+?)\]\((.+?)\))|(<((?:https?|mailto):[^\s>]+)>)|(~~(.+?)~~)/g;

function isProseParagraphLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  if (OPAQUE_FENCE_PATTERN.test(trimmed)) return false;
  if (trimmed.startsWith('```')) return false;
  if (HEADING_PATTERN.test(trimmed)) return false;
  if (trimmed.startsWith('> ')) return false;
  if (UNORDERED_LIST_PATTERN.test(trimmed)) return false;
  if (ORDERED_LIST_PATTERN.test(trimmed)) return false;
  if (IMAGE_PATTERN.test(trimmed)) return false;
  if (trimmed.includes('|')) return false;
  if (THEMATIC_BREAK_PATTERN.test(trimmed)) return false;
  return true;
}

function isThematicBreak(lines: string[], i: number): boolean {
  const line = lines[i];
  if (!line || !THEMATIC_BREAK_PATTERN.test(line)) return false;
  if (i > 0 && isProseParagraphLine(lines[i - 1])) return false;
  return true;
}

/**
 * Convert Markdown to Portable Text blocks.
 * Opaque fences (<!--ec:block ... -->) are deserialized and spliced back in.
 */
export function markdownToPortableText(markdown: string): PortableTextBlock[] {
  const blocks: PortableTextBlock[] = [];
  const lines = markdown.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Opaque fence
    const opaqueMatch = line.match(OPAQUE_FENCE_PATTERN);
    if (opaqueMatch) {
      try {
        blocks.push(JSON.parse(opaqueMatch[1]) as PortableTextBlock);
      } catch {
        blocks.push(makeBlock(line));
      }
      i++;
      continue;
    }

    // Code fence
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({
        _type: 'code',
        _key: generateKey(),
        language: lang || undefined,
        code: codeLines.join('\n'),
      });
      i++; // skip closing ```
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(HEADING_PATTERN);
    if (headingMatch) {
      blocks.push(makeBlock(headingMatch[2], `h${headingMatch[1].length}`));
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      blocks.push(makeBlock(line.slice(2), 'blockquote'));
      i++;
      continue;
    }

    // Unordered list
    const ulMatch = line.match(UNORDERED_LIST_PATTERN);
    if (ulMatch) {
      const level = Math.floor(ulMatch[1].length / 2) + 1;
      blocks.push(makeListBlock(ulMatch[2], 'bullet', level));
      i++;
      continue;
    }

    // Ordered list
    const olMatch = line.match(ORDERED_LIST_PATTERN);
    if (olMatch) {
      const level = Math.floor(olMatch[1].length / 2) + 1;
      blocks.push(makeListBlock(olMatch[2], 'number', level));
      i++;
      continue;
    }

    // Image
    const imgMatch = line.match(IMAGE_PATTERN);
    if (imgMatch) {
      blocks.push({
        _type: 'image',
        _key: generateKey(),
        alt: imgMatch[1],
        asset: { url: imgMatch[2] },
      });
      i++;
      continue;
    }

    // Thematic break (--- / *** / ___)
    // D2: Placed after image (:522), before table (:543), and before paragraph (:551).
    // C2: Only standalone breaks (preceded by blank line, start of document, or block boundary)
    // are converted to break blocks. Lines immediately preceded by text are considered Setext headings.
    if (isThematicBreak(lines, i)) {
      blocks.push({
        _type: 'break',
        _key: generateKey(),
      });
      i++;
      continue;
    }

    // Table (GFM pipe table)
    if (isTableStart(lines, i)) {
      const { tableBlock, nextIndex } = parseTableBlock(lines, i);
      blocks.push(tableBlock);
      i = nextIndex;
      continue;
    }

    // Paragraph
    blocks.push(makeBlock(line));
    i++;
  }

  return blocks;
}

function splitTableRow(rowStr: string): string[] {
  let trimmed = rowStr.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) {
      current += ch;
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
      current += ch;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isDelimiterRow(rowStr: string): boolean {
  const trimmed = rowStr.trim();
  if (!trimmed.includes('-')) return false;
  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

function parseDelimiterAlignments(rowStr: string): Array<'left' | 'center' | 'right' | undefined> {
  const cells = splitTableRow(rowStr);
  return cells.map((cell) => {
    const trimmed = cell.trim();
    const left = trimmed.startsWith(':');
    const right = trimmed.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return undefined;
  });
}

function isTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  const currentLine = lines[index].trim();
  const nextLine = lines[index + 1].trim();

  if (
    !currentLine.includes('|') ||
    currentLine.startsWith('```') ||
    OPAQUE_FENCE_PATTERN.test(currentLine)
  ) {
    return false;
  }

  if (!isDelimiterRow(nextLine)) return false;

  const headerCols = splitTableRow(currentLine).length;
  const delimCols = splitTableRow(nextLine).length;
  return headerCols === delimCols && headerCols > 0;
}

function parseTableBlock(
  lines: string[],
  startIndex: number,
): { tableBlock: PortableTextBlock; nextIndex: number } {
  const headerLine = lines[startIndex].trim();
  const delimLine = lines[startIndex + 1].trim();
  const alignments = parseDelimiterAlignments(delimLine);
  const headerColTexts = splitTableRow(headerLine);

  const headerCells = headerColTexts.map((text, colIdx) => {
    const { spans, markDefs } = parseInline(text);
    const align = alignments[colIdx];
    return {
      _type: 'tableCell',
      _key: generateKey(),
      content: spans,
      markDefs,
      isHeader: true,
      ...(align ? { textAlign: align } : {}),
    };
  });

  const headerRow = {
    _type: 'tableRow',
    _key: generateKey(),
    cells: headerCells,
  };

  const rows = [headerRow];
  let curr = startIndex + 2;

  while (
    curr < lines.length &&
    lines[curr].trim() !== '' &&
    lines[curr].includes('|') &&
    !lines[curr].trim().startsWith('```') &&
    !OPAQUE_FENCE_PATTERN.test(lines[curr].trim())
  ) {
    const rowLine = lines[curr].trim();
    const cellTexts = splitTableRow(rowLine);
    const cells = alignments.map((align, colIdx) => {
      const text = cellTexts[colIdx] ?? '';
      const { spans, markDefs } = parseInline(text);
      return {
        _type: 'tableCell',
        _key: generateKey(),
        content: spans,
        markDefs,
        isHeader: false,
        ...(align ? { textAlign: align } : {}),
      };
    });

    rows.push({
      _type: 'tableRow',
      _key: generateKey(),
      cells,
    });
    curr++;
  }

  const tableBlock: PortableTextBlock = {
    _type: 'table',
    _key: generateKey(),
    hasHeaderRow: true,
    rows,
  };

  return { tableBlock, nextIndex: curr };
}

// ---------------------------------------------------------------------------
// Block builders
// ---------------------------------------------------------------------------

function makeBlock(text: string, style: string = 'normal'): PortableTextBlock {
  const { spans, markDefs } = parseInline(text);
  return { _type: 'block', _key: generateKey(), style, markDefs, children: spans };
}

function makeListBlock(text: string, listItem: string, level: number): PortableTextBlock {
  const { spans, markDefs } = parseInline(text);
  return {
    _type: 'block',
    _key: generateKey(),
    style: 'normal',
    listItem,
    level,
    markDefs,
    children: spans,
  };
}

/**
 * Parse inline markdown (bold, italic, code, links, strikethrough) into PT spans + markDefs.
 */
function parseInline(text: string): ParsedInline {
  const spans: PortableTextSpan[] = [];
  const markDefs: MarkDef[] = [];
  const regex = INLINE_MARKDOWN_PATTERN;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      spans.push({
        _type: 'span',
        _key: generateKey(),
        text: text.slice(lastIndex, match.index),
        marks: [],
      });
    }

    if (match[2] != null) {
      spans.push({ _type: 'span', _key: generateKey(), text: match[2], marks: ['strong'] });
    } else if (match[4] != null) {
      spans.push({ _type: 'span', _key: generateKey(), text: match[4], marks: ['strong'] });
    } else if (match[6] != null) {
      spans.push({ _type: 'span', _key: generateKey(), text: match[6], marks: ['em'] });
    } else if (match[8] != null) {
      spans.push({ _type: 'span', _key: generateKey(), text: match[8], marks: ['em'] });
    } else if (match[10] != null) {
      spans.push({ _type: 'span', _key: generateKey(), text: match[10], marks: ['code'] });
    } else if (match[12] != null && match[13] != null) {
      const key = generateKey();
      markDefs.push({ _key: key, _type: 'link', href: match[13] });
      spans.push({ _type: 'span', _key: generateKey(), text: match[12], marks: [key] });
    } else if (match[15] != null) {
      const url = match[15];
      const key = generateKey();
      markDefs.push({ _key: key, _type: 'link', href: url });
      spans.push({ _type: 'span', _key: generateKey(), text: url, marks: [key] });
    } else if (match[17] != null) {
      spans.push({
        _type: 'span',
        _key: generateKey(),
        text: match[17],
        marks: ['strike-through'],
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    spans.push({ _type: 'span', _key: generateKey(), text: text.slice(lastIndex), marks: [] });
  }

  if (spans.length === 0) {
    spans.push({ _type: 'span', _key: generateKey(), text, marks: [] });
  }

  return { spans, markDefs };
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

let keyCounter = 0;

function generateKey(): string {
  return `k${(keyCounter++).toString(36)}`;
}

/** Reset key counter (useful for testing) */
export function resetKeyCounter(): void {
  keyCounter = 0;
}

// ---------------------------------------------------------------------------
// Schema-aware conversion helpers
// ---------------------------------------------------------------------------

export interface FieldSchema {
  slug: string;
  type: string;
  validation?: unknown;
  blockTypes?: Array<{
    slug: string;
    currentVersion: number;
    versions: Array<{
      version: number;
      fields: Array<{ slug: string; type: string }>;
    }>;
  }>;
}

function convertNestedBlockPortableText(
  value: unknown,
  field: FieldSchema,
  direction: 'read' | 'write',
): unknown {
  if (!Array.isArray(value)) return value;
  const validation = field.validation;
  const allowedTypes =
    validation && typeof validation === 'object' && 'allowedTypes' in validation
      ? validation.allowedTypes
      : undefined;
  return value.map((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
    const record = { ...block };
    const type =
      record._type === undefined &&
      direction === 'write' &&
      Array.isArray(allowedTypes) &&
      allowedTypes.length === 1
        ? allowedTypes[0]
        : record._type;
    const version = typeof record._version === 'number' ? record._version : undefined;
    const blockType = field.blockTypes?.find((candidate) => candidate.slug === type);
    const definition = blockType?.versions.find(
      (candidate) => candidate.version === (version ?? blockType.currentVersion),
    );
    if (!definition) return block;
    for (const nestedField of definition.fields) {
      if (nestedField.type !== 'portableText') continue;
      const nestedValue = record[nestedField.slug];
      if (direction === 'read' && Array.isArray(nestedValue)) {
        record[nestedField.slug] = portableTextToMarkdown(nestedValue as PortableTextBlock[]);
      } else if (direction === 'write' && typeof nestedValue === 'string') {
        record[nestedField.slug] = markdownToPortableText(nestedValue);
      }
    }
    return record;
  });
}

/**
 * Convert content data for reading: Portable Text arrays -> Markdown strings.
 * Converts top-level `portableText` arrays and nested `portableText` arrays
 * inside `blocks` arrays.
 */
export function convertDataForRead(
  data: Record<string, unknown>,
  fields: FieldSchema[],
  raw: boolean = false,
): Record<string, unknown> {
  if (raw) return data;

  const result = { ...data };
  for (const field of fields) {
    if (field.type === 'portableText' && Array.isArray(result[field.slug])) {
      result[field.slug] = portableTextToMarkdown(result[field.slug] as PortableTextBlock[]);
    } else if (field.type === 'blocks' && Array.isArray(result[field.slug])) {
      result[field.slug] = convertNestedBlockPortableText(result[field.slug], field, 'read');
    }
  }
  return result;
}

/**
 * Convert content data for writing: Markdown strings -> Portable Text arrays.
 * Converts top-level `portableText` strings and nested Markdown strings
 * in `portableText` fields inside `blocks` arrays.
 */
export function convertDataForWrite(
  data: Record<string, unknown>,
  fields: FieldSchema[],
): Record<string, unknown> {
  const result = { ...data };
  for (const field of fields) {
    if (field.type === 'portableText' && typeof result[field.slug] === 'string') {
      result[field.slug] = markdownToPortableText(result[field.slug] as string);
    } else if (field.type === 'blocks' && Array.isArray(result[field.slug])) {
      result[field.slug] = convertNestedBlockPortableText(result[field.slug], field, 'write');
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Syntax Validation & Opaque Block Safety Guards (Emit additions)
// ---------------------------------------------------------------------------

/**
 * Fence marker parsed from a Markdown line: at most 3 leading spaces of indentation
 * followed by a run of 3 or more backticks.
 *
 * Tilde fences are deliberately NOT recognized. EmDash's Portable Text mapper
 * (`markdownToPortableText`) only treats backtick fences as code blocks, and the guard
 * exemption scope must stay a subset of what the mapper actually treats as code: if a
 * `~~~` block were exempted here, an `![alt](media/drafts/x.png)` line inside it would
 * skip validation and still be converted into a real image block, pushing a broken
 * local path to the remote AST. A tilde-fenced body is therefore reported by G5 / G11
 * exactly like any other paragraph.
 */
interface FenceMarker {
  char: string;
  length: number;
}

/**
 * Sentinel substituted for fenced code block content when a body is prepared for
 * regex-based inspection (G5 / G8 / G11). Chosen so that it can never match an image
 * or Markdown syntax pattern, and so that a fenced block collapses to a single line.
 */
const CODE_BLOCK_SCAN_PLACEHOLDER = '\u0000__EMIT_CODE_BLOCK__\u0000';

function parseFenceMarker(line: string): FenceMarker | null {
  const match = line.match(/^(`{3,})/);
  if (!match) return null;
  return { char: '`', length: match[1].length };
}

/**
 * A closing fence must use backticks, be at least as long as the opening fence, and
 * carry no info string. Fences written with a longer run therefore cannot be closed by
 * a shorter one, and a longer opening fence that is never closed keeps the remainder of
 * the body fenced instead of leaking a violation from inside it.
 */
function closingFenceMatches(line: string, fence: FenceMarker): boolean {
  const fenceRun = (line.match(/^`+/) ?? [''])[0]!;
  if (fenceRun.length < fence.length) return false;
  return line.slice(fenceRun.length).trim() === '';
}

export interface CodeFenceState {
  /** The line is a code fence delimiter (opening or closing) line. */
  isFenceDelimiter: boolean;
  /** The line is body content located inside an open code fence. */
  insideCodeFence: boolean;
}

/**
 * Classifies every line of a Markdown body with respect to backtick code fences.
 *
 * Fences of any length are recognized and matched against a closing fence of equal or
 * greater length, so a body that documents Markdown syntax itself (a ```` ```md ````
 * block quoting `![alt](path)` examples) is never inspected as real markup. Lines that
 * merely *contain* three backticks are not delimiters, and an unterminated fence keeps
 * the rest of the body fenced.
 */
export function classifyCodeFenceLines(body: string): CodeFenceState[] {
  const lines = body.split('\n');
  const states: CodeFenceState[] = [];
  let openFence: FenceMarker | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.replace(/\r$/, '').trim();

    if (openFence) {
      if (closingFenceMatches(trimmed, openFence)) {
        states.push({ isFenceDelimiter: true, insideCodeFence: false });
        openFence = null;
      } else {
        states.push({ isFenceDelimiter: false, insideCodeFence: true });
      }
      continue;
    }

    const marker = parseFenceMarker(trimmed);
    if (marker) {
      states.push({ isFenceDelimiter: true, insideCodeFence: false });
      openFence = marker;
      continue;
    }

    states.push({ isFenceDelimiter: false, insideCodeFence: false });
  }

  return states;
}

/**
 * Removes fenced code block content from a Markdown body so that regex-based guards
 * (image paths, unsupported syntax, draft images) never inspect quoted Markdown or HTML.
 * Fence delimiters and their content collapse into a single sentinel line.
 *
 * Note: this function is for *inspection* only. It is never used to produce stored or
 * pushed Markdown, which keeps fenced content intact.
 */
export function stripCodeBlocks(markdown: string): string {
  const lines = markdown.split('\n');
  const states = classifyCodeFenceLines(markdown);
  const output: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const state = states[i]!;
    if (state.isFenceDelimiter || state.insideCodeFence) {
      if (output[output.length - 1] !== CODE_BLOCK_SCAN_PLACEHOLDER) {
        output.push(CODE_BLOCK_SCAN_PLACEHOLDER);
      }
      continue;
    }
    output.push(lines[i]!);
  }

  return output.join('\n');
}

/**
 * Detects syntax that is unsupported by the line-based EmDash parser,
 * such as markdown tables, raw block HTML, or mixed inline images.
 */
export function detectUnsupportedMarkdownSyntax(markdown: string): string[] {
  const cleaned = stripCodeBlocks(markdown);
  const warnings: string[] = [];

  // Raw block HTML tags
  if (/<(?:div|section|article|table|form|iframe|script)[\s>]/i.test(cleaned)) {
    warnings.push(
      'Raw HTML block tags are not supported and will be treated as plain text paragraphs.',
    );
  }

  // Tilde code fences: the line-based mapper only recognizes backtick fences as code blocks,
  // so a ~~~ block degrades to plain paragraphs and any image line inside it becomes a real
  // image block. Warn instead of letting that happen silently.
  if (/^ {0,3}~~~/m.test(cleaned)) {
    warnings.push(
      'Tilde code fences (~~~) are not recognized as code blocks by the line-based parser and will degrade to plain text paragraphs; any image line inside them is converted into a real image block. Use backtick fences (```) for code examples.',
    );
  }

  // Setext headings (Non-empty text line immediately followed by === or ---)
  if (/(?:^[^\r\n#|\-][^\r\n]*)\r?\n {0,3}(?:={3,}|-{3,})\s*(?:\r?\n|$)/m.test(cleaned)) {
    warnings.push(
      'Setext headings (underlined with === or ---) are not supported by the line-based parser. Use ATX headings (# Heading) instead.',
    );
  }

  return warnings;
}

/**
 * Extracts all opaque fence lines (`<!--ec:block ... -->`) from markdown.
 */
export function extractOpaqueBlockLines(markdown: string): string[] {
  const lines = markdown.split('\n');
  return lines.filter((line) => OPAQUE_FENCE_PATTERN.test(line.trim()));
}

/**
 * Counts valid opaque block fences (`<!--ec:block ... -->`) in Markdown body,
 * strictly excluding code fences (``` ... ```).
 */
export function countPreservedOpaqueBlocks(markdown: string): number {
  const cleaned = stripCodeBlocks(markdown);
  return extractOpaqueBlockLines(cleaned).length;
}

/**
 * Verifies that all opaque block fences present in baseMarkdown are intact in localMarkdown (G9 guard).
 * Returns true if untampered, false if any base opaque block fence was modified or removed.
 */
export function verifyOpaqueBlocksUntampered(baseMarkdown: string, localMarkdown: string): boolean {
  const baseFences = extractOpaqueBlockLines(baseMarkdown);
  if (baseFences.length === 0) return true;

  const localFences = extractOpaqueBlockLines(localMarkdown);
  if (baseFences.length !== localFences.length) return false;

  return baseFences.every((fence, idx) => fence === localFences[idx]);
}
