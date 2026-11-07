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
    } else if (block._type === 'image') {
      if (i > 0) lines.push('');
      const alt = (block.alt as string) || '';
      const url = (block.asset as { url?: string })?.url || '';
      lines.push(`![${alt}](${url})`);
      prevWasList = false;
    } else {
      // Tier 3: Unknown block -> opaque fence
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

  for (const span of spans) {
    if (span._type !== 'span') continue;

    let text = span.text ?? '';
    const marks = span.marks ?? [];

    for (const mark of marks) {
      const def = markDefs.find((d) => d._key === mark);
      if (def) {
        if (def._type === 'link') {
          text = `[${text}](${def.href ?? ''})`;
        }
      } else {
        switch (mark) {
          case 'strong':
            text = `**${text}**`;
            break;
          case 'em':
            text = `_${text}_`;
            break;
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
const INLINE_MARKDOWN_PATTERN =
  /(\*\*(.+?)\*\*)|(_(.+?)_)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))|(~~(.+?)~~)/g;

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

    // Paragraph
    blocks.push(makeBlock(line));
    i++;
  }

  return blocks;
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
      spans.push({ _type: 'span', _key: generateKey(), text: match[4], marks: ['em'] });
    } else if (match[6] != null) {
      spans.push({ _type: 'span', _key: generateKey(), text: match[6], marks: ['code'] });
    } else if (match[8] != null && match[9] != null) {
      const key = generateKey();
      markDefs.push({ _key: key, _type: 'link', href: match[9] });
      spans.push({ _type: 'span', _key: generateKey(), text: match[8], marks: [key] });
    } else if (match[11] != null) {
      spans.push({
        _type: 'span',
        _key: generateKey(),
        text: match[11],
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

  // Markdown tables (| col | col |)
  if (/^\|(?:[^\r\n|]+\|)+$/m.test(cleaned)) {
    warnings.push(
      'Markdown tables are not supported by the line-based parser and will degrade to plain text paragraphs.',
    );
  }

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
