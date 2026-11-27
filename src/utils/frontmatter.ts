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

import matter from 'gray-matter';
import { z } from 'zod';
import { CANONICAL_ULID_REGEX } from './ulid.js';

export const FrontmatterSeoSchema = z.object({
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  canonical: z.string().url().nullable().optional(),
  noIndex: z.boolean().optional(),
  image: z.string().nullable().optional(),
});

export const CustomFieldScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);

export type CustomFieldScalar = z.infer<typeof CustomFieldScalarSchema>;

export const FrontmatterSchema = z.object({
  id: z.string().length(26, 'ID must be a 26-character ULID'),
  slug: z.string().min(1, 'Slug cannot be empty'),
  title: z.string().min(1, 'Title cannot be empty'),
  collection: z.string().default('posts'),
  status: z.enum(['draft', 'published']).default('draft'),
  publishedAt: z.string().nullable().optional(),
  locale: z.string().default('ja'),
  translationOf: z.string().length(26).optional(),
  translationGroup: z.string().length(26).optional(),
  featuredImage: z.string().nullable().optional(),
  taxonomies: z.record(z.array(z.string())).optional().default({}),
  seo: FrontmatterSeoSchema.optional(),
  bylines: z.array(z.string()).optional().default([]),
  fields: z.record(CustomFieldScalarSchema).optional(),
});

export type Frontmatter = z.infer<typeof FrontmatterSchema>;

export interface TaxonomyCandidates {
  categories?: string[];
  tags?: string[];
  bylines?: string[];
  slugToName?: {
    category?: Record<string, string>;
    tag?: Record<string, string>;
    [key: string]: Record<string, string> | undefined;
  };
  byLocale?: Record<
    string,
    {
      slugToName?: {
        category?: Record<string, string>;
        tag?: Record<string, string>;
        [key: string]: Record<string, string> | undefined;
      };
    }
  >;
  [key: string]:
    | string[]
    | { [k: string]: Record<string, string> | undefined }
    | Record<string, { slugToName?: Record<string, Record<string, string> | undefined> }>
    | undefined;
}

export interface ParsedMarkdown {
  frontmatter: Frontmatter;
  body: string;
  rawYaml: string;
}

/**
 * Error thrown when frontmatter parsing or schema validation fails.
 * Captures the file path, error line if available, and actionable hints for repair.
 */
export class FrontmatterParseError extends Error {
  readonly code = 'FRONTMATTER_PARSE_ERROR';
  readonly filePath?: string;
  readonly reason: string;
  readonly suggestion: string;
  readonly line?: number;

  constructor(options: {
    message: string;
    filePath?: string;
    reason: string;
    suggestion?: string;
    line?: number;
  }) {
    super(options.message);
    this.name = 'FrontmatterParseError';
    this.filePath = options.filePath;
    this.reason = options.reason;
    this.line = options.line;
    this.suggestion =
      options.suggestion ||
      'Quote strings starting with "%" or containing special YAML characters (e.g. - "%e6%9c%aa%e5%88%86%e9%a1%9e"), or run "emit pull" to repair.';
  }
}

/**
 * Parses markdown text into validated frontmatter and body.
 */
export function parseMarkdown(content: string, filePath?: string): ParsedMarkdown {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (err: unknown) {
    const reason = formatFrontmatterParseError(err);
    let line: number | undefined;
    if (err && typeof err === 'object' && 'mark' in err) {
      const mark = (err as { mark?: { line?: number } }).mark;
      if (typeof mark?.line === 'number') {
        line = mark.line + 1;
      }
    }
    const locStr = filePath ? ` in ${filePath}` : '';
    const lineStr = line ? ` at line ${line}` : '';
    throw new FrontmatterParseError({
      message: `Invalid frontmatter YAML${locStr}${lineStr}: ${reason}`,
      filePath,
      reason,
      line,
    });
  }

  let validated: Frontmatter;
  try {
    validated = FrontmatterSchema.parse(parsed.data);
  } catch (err: unknown) {
    const reason = formatFrontmatterParseError(err);
    const locStr = filePath ? ` in ${filePath}` : '';
    throw new FrontmatterParseError({
      message: `Invalid frontmatter schema${locStr}: ${reason}`,
      filePath,
      reason,
      suggestion:
        'Verify required frontmatter fields (id: 26-char ULID, slug, title, status: draft|published).',
    });
  }

  // Normalize featuredImage casing to the canonical uppercase ULID form so that
  // merge comparisons, cache matching, and push payloads all agree with what
  // EmDash returns. Values that are not a ULID (e.g. a media URL or a local path)
  // are left untouched here and handled by Preflight Guard G10 on push.
  if (typeof validated.featuredImage === 'string') {
    const trimmed = validated.featuredImage.trim();
    if (CANONICAL_ULID_REGEX.test(trimmed)) {
      validated.featuredImage = trimmed.toUpperCase();
    }
  }

  return {
    frontmatter: validated,
    body: parsed.content,
    rawYaml: matter.stringify('', parsed.data).trim(),
  };
}

/**
 * Parses content with the canonical two-stage route: strict schema parse, then lenient
 * frontmatter repair, then strict re-parse. Returns null only when nothing can be salvaged.
 * This is the single entry point every read-only inspector (status / doctor / conflicts /
 * delete / search / media scan) must use so an invalid file is classified identically by
 * every diagnostic — AGENTS.md §5 diagnostic alignment invariant.
 */
export function parseMarkdownLenient(content: string, filePath?: string): ParsedMarkdown | null {
  try {
    return parseMarkdown(content, filePath);
  } catch {
    const healed = lenientRepairMarkdownFrontmatter(content);
    if (!healed) return null;
    try {
      return parseMarkdown(healed, filePath);
    } catch {
      return null;
    }
  }
}

/**
 * Formats a parseMarkdown error (js-yaml YAMLException or ZodError) into a concise 1-line summary.
 * Prevents ZodError's multi-line JSON array `.message` from truncating to `"["`.
 */
export function formatFrontmatterParseError(err: unknown): string {
  if (
    err &&
    typeof err === 'object' &&
    'issues' in err &&
    Array.isArray((err as z.ZodError).issues)
  ) {
    const issues = (err as z.ZodError).issues;
    return issues
      .map((i) => `${i.path.length > 0 ? i.path.join('.') : 'frontmatter'}: ${i.message}`)
      .join('; ');
  }
  if (err instanceof Error && err.message) {
    return err.message.split('\n')[0];
  }
  return 'Invalid frontmatter YAML';
}

// YAML 1.1/1.2 reserved boolean/null/float literals that js-yaml coerces when unquoted.
const YAML_RESERVED_RE = /^(true|false|null|nil|yes|no|on|off|y|n|~|\.inf|-\.inf|\.nan)$/i;

// Safe unquoted scalar: starts with Unicode letter, digit, or underscore, followed by letters, digits, ., _, /, -
// Excludes %-prefixed strings (YAML directives), leading hyphens/colons, whitespace, and punctuation.
const SAFE_PLAIN_SCALAR_RE = /^[\p{L}\p{N}_][\p{L}\p{N}._/-]*$/u;

// Digit-leading strings that js-yaml coerces into Number or Date when unquoted (e.g. "123", "1.5", "0123...", "2026-11-07").
// Normal ULIDs ("01M6GV...") and alphanumeric slugs ("2026-11-07-post", "3d-printer") contain non-numeric letters and stay unquoted.
const YAML_NUMERIC_OR_DATE_RE =
  /^(\d[\d_]*(\.[\d_]*)?([eE][+-]?\d+)?|0[xXoObB][0-9a-fA-F_]+|\d{4}-\d{1,2}-\d{1,2}([T\s].*)?)$/;

/**
 * Formats a scalar string for YAML frontmatter.
 * Keeps safe plain scalars (ASCII/CJK slugs, standard ULIDs) unquoted to preserve
 * baseline hash compatibility, while quoting %-prefixed strings, numbers, dates,
 * reserved literals, and strings containing special YAML characters via JSON.stringify.
 */
export function formatYamlScalar(value: string): string {
  if (
    value.length === 0 ||
    !SAFE_PLAIN_SCALAR_RE.test(value) ||
    YAML_RESERVED_RE.test(value) ||
    YAML_NUMERIC_OR_DATE_RE.test(value)
  ) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Attempts lenient regex-based syntax repair on raw Markdown whose frontmatter fails js-yaml parsing.
 * Restricted strictly to:
 * 1. Quoting unquoted scalars starting with "%" or containing special characters on array elements (`- %...`) or slug lines (`slug: %...`).
 *    Preserves any trailing comments (e.g. `slug: %... # comment` or `- %... # comment`) so values are not polluted.
 * 2. Fixing minor indentation on taxonomy/byline sequence element lines (`- <item>`) strictly within taxonomy/byline blocks.
 *
 * Guaranteed NEVER to alter the Markdown body, change keys/values, or mutate newline formats (CRLF/LF).
 * Returns the repaired Markdown string, or null if lenient repair could not produce valid frontmatter
 * or if values/meaning were altered.
 */
export function lenientRepairMarkdownFrontmatter(content: string): string | null {
  // If content is already valid, do not touch it (prevents phantom diffs)
  try {
    parseMarkdown(content);
    return null;
  } catch {
    // proceed to repair
  }

  // Detect original frontmatter EOL from the opening delimiter
  const frontmatterOpening = content.match(/^---\r?\n/);
  const isCrlf = frontmatterOpening
    ? frontmatterOpening[0] === '---\r\n'
    : content.includes('\r\n');
  const eol = isCrlf ? '\r\n' : '\n';

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n[\s\S]*)$/);
  if (!match) return null;

  const rawYaml = match[1];
  const bodyWithLeadingNewline = match[2];

  const lines = rawYaml.split(/\r?\n/);
  const repairedLines: string[] = [];
  let inTaxonomiesBlock = false;
  let inSequenceBlock = false;
  // Indentation level (leading spaces) of the taxonomy key line that opened the current
  // sequence block, so nested sequences can be re-indented relative to their own parent key.
  let sequenceParentIndent = 2;

  for (const line of lines) {
    let repairedLine = line;

    if (/^taxonomies:\s*$/.test(line)) {
      inTaxonomiesBlock = true;
      inSequenceBlock = false;
      repairedLines.push(line);
      continue;
    } else if (/^bylines:\s*$/.test(line)) {
      inTaxonomiesBlock = false;
      inSequenceBlock = true;
      sequenceParentIndent = 0;
      repairedLines.push(line);
      continue;
    } else if (/^\S/.test(line)) {
      // Any other top-level key leaves both taxonomies and bylines blocks
      inTaxonomiesBlock = false;
      inSequenceBlock = false;
    } else if (inTaxonomiesBlock && /^\s+(categories|tags|[a-zA-Z0-9_-]+):\s*$/.test(line)) {
      inSequenceBlock = true;
      sequenceParentIndent = (line.match(/^\s*/) as RegExpMatchArray)[0].length;
      repairedLines.push(line);
      continue;
    }

    // 1. Array element lines (`- <value>`): strictly inside taxonomy or bylines blocks
    if (inSequenceBlock) {
      const seqMatch = line.match(/^(\s*)-\s*(.*)$/);
      if (seqMatch) {
        const leadingSpace = seqMatch[1];
        const rest = seqMatch[2].trim();

        // Separate value from any trailing comment: e.g. `"%e6%9c%aa" # comment` or `%e6%9c%aa # comment`
        const commentMatch = rest.match(/^(\S+)(\s+#.*)?$/);
        let value = commentMatch ? commentMatch[1] : rest;
        const trailingComment = commentMatch && commentMatch[2] ? commentMatch[2] : '';

        // If value starts with % and is unquoted, quote it
        if (value.startsWith('%') && !value.startsWith('"') && !value.startsWith("'")) {
          value = JSON.stringify(value);
        }

        // Re-indent only when the item sits shallower than its parent key's indentation, which
        // js-yaml rejects (legacy serialization emitted 2-space items under a 2-space taxonomy key).
        const needsReindent = leadingSpace.length < sequenceParentIndent + 2;
        const indent = needsReindent ? ' '.repeat(sequenceParentIndent + 2) : leadingSpace;
        repairedLine = `${indent}- ${value}${trailingComment}`;
        repairedLines.push(repairedLine);
        continue;
      }
    }

    // 2. Slug key line strictly top-level (`^slug:\s*`): quote unquoted % while preserving trailing comment
    const slugMatch = line.match(/^slug:\s*(.*)$/);
    if (slugMatch) {
      const rest = slugMatch[1].trim();
      const commentMatch = rest.match(/^(\S+)(\s+#.*)?$/);
      let slugVal = commentMatch ? commentMatch[1] : rest;
      const trailingComment = commentMatch && commentMatch[2] ? commentMatch[2] : '';

      if (slugVal.startsWith('%') && !slugVal.startsWith('"') && !slugVal.startsWith("'")) {
        slugVal = JSON.stringify(slugVal);
      }
      repairedLine = `slug: ${slugVal}${trailingComment}`;
      repairedLines.push(repairedLine);
      continue;
    }

    repairedLines.push(repairedLine);
  }

  const candidateYaml = repairedLines.join(eol);
  const candidateFull = `---${eol}${candidateYaml}${eol}---${bodyWithLeadingNewline}`;

  try {
    const candidateData = matter(`---${eol}${candidateYaml}${eol}---`).data as unknown;
    if (!candidateData || typeof candidateData !== 'object' || Array.isArray(candidateData)) {
      return null;
    }
    const reparsed = parseMarkdown(candidateFull);
    // Extra validation: verify that slug, IDs, taxonomies, and bylines were not corrupted by comments
    if (reparsed.frontmatter.slug.includes('#') || reparsed.frontmatter.id.includes('#')) {
      return null;
    }
    if (reparsed.frontmatter.taxonomies) {
      for (const list of Object.values(reparsed.frontmatter.taxonomies)) {
        if (
          Array.isArray(list) &&
          list.some((item) => typeof item !== 'string' || item.includes('#'))
        ) {
          return null;
        }
      }
    }
    if (
      reparsed.frontmatter.bylines &&
      reparsed.frontmatter.bylines.some((item) => typeof item !== 'string' || item.includes('#'))
    ) {
      return null;
    }
    return candidateFull;
  } catch {
    return null;
  }
}

export interface SerializeMarkdownOptions {
  preferEncodedTaxonomy?: boolean;
  /**
   * Whether the article is published but currently reflects an uncommitted remote draft revision.
   * When true and status is 'published', emits: `status: published # draft revision`.
   */
  hasDraftRevision?: boolean;
}

/**
 * Attempts to decode a taxonomy term if it contains percent-encoding.
 * Returns the original term if decoding fails or if no % is present.
 */
export function tryDecodeTaxonomyTerm(term: string): string {
  if (!term.includes('%')) return term;
  try {
    return decodeURIComponent(term).normalize('NFC');
  } catch {
    return term;
  }
}

/**
 * Checks if the markdown frontmatter taxonomies section contains any percent-encoded terms.
 * Strictly scopes inspection to the frontmatter's `taxonomies:` section list items,
 * ignoring article slugs, bylines, and markdown body. Only returns true if decoding alters the string.
 */
export function carriesPercentEncodedTaxonomy(markdown: string): boolean {
  if (!markdown.startsWith('---')) return false;
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return false;
  const fmLines = match[1].split(/\r?\n/);
  let inTaxonomies = false;
  for (const line of fmLines) {
    if (/^[a-zA-Z0-9_-]+:/.test(line)) {
      inTaxonomies = line.startsWith('taxonomies:');
      continue;
    }
    if (inTaxonomies) {
      const itemMatch = line.match(/^\s+-\s+(.+)$/);
      if (itemMatch) {
        let rawScalar = itemMatch[1].trim();
        // Strip trailing comment if present
        const hashIdx = rawScalar.indexOf('#');
        if (hashIdx !== -1) {
          rawScalar = rawScalar.slice(0, hashIdx).trim();
        }
        // Strip enclosing quotes
        if (
          (rawScalar.startsWith('"') && rawScalar.endsWith('"')) ||
          (rawScalar.startsWith("'") && rawScalar.endsWith("'"))
        ) {
          rawScalar = rawScalar.slice(1, -1);
        }
        if (rawScalar.includes('%') && tryDecodeTaxonomyTerm(rawScalar) !== rawScalar) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Formats a frontmatter object into clean YAML with helpful candidate comments.
 */
export function formatFrontmatterYaml(
  data: Frontmatter,
  candidates?: TaxonomyCandidates,
  options?: SerializeMarkdownOptions,
): string {
  const lines: string[] = ['---'];

  lines.push(`id: ${formatYamlScalar(data.id)}`);
  lines.push(`slug: ${formatYamlScalar(data.slug)}`);
  lines.push(`title: ${JSON.stringify(data.title)}`);
  lines.push(`collection: ${formatYamlScalar(data.collection)}`);
  if (data.status === 'published' && options?.hasDraftRevision) {
    lines.push('status: published # draft revision');
  } else {
    lines.push(`status: ${data.status}`);
  }
  lines.push(`publishedAt: ${data.publishedAt ? JSON.stringify(data.publishedAt) : 'null'}`);
  lines.push(`locale: ${formatYamlScalar(data.locale)}`);
  if (data.translationOf) {
    lines.push(`translationOf: ${formatYamlScalar(data.translationOf)}`);
  }
  if (data.translationGroup) {
    lines.push(`translationGroup: ${formatYamlScalar(data.translationGroup)}`);
  }
  if (data.featuredImage !== undefined) {
    lines.push(
      `featuredImage: ${data.featuredImage ? JSON.stringify(data.featuredImage) : 'null'}`,
    );
  }

  // Taxonomies
  lines.push('taxonomies:');
  const taxonomies = data.taxonomies || {};
  const allTaxKeys = Array.from(new Set([...Object.keys(taxonomies), 'categories', 'tags']));

  for (const taxKey of allTaxKeys) {
    lines.push(`  ${taxKey}:`);

    const terms = taxonomies[taxKey] || [];
    if (terms.length === 0) {
      lines.push('    []');
    } else {
      const singularKey = taxKey === 'categories' ? 'category' : taxKey === 'tags' ? 'tag' : taxKey;
      const articleLocale = data.locale?.trim().toLowerCase();
      const localeSlugMap = articleLocale
        ? candidates?.byLocale?.[articleLocale]?.slugToName?.[singularKey] ||
          candidates?.byLocale?.[articleLocale]?.slugToName?.[taxKey]
        : undefined;
      const globalSlugMap =
        candidates?.slugToName?.[singularKey] || candidates?.slugToName?.[taxKey];

      for (const term of terms) {
        const displayTerm = options?.preferEncodedTaxonomy ? term : tryDecodeTaxonomyTerm(term);
        const decoded = tryDecodeTaxonomyTerm(term);
        const humanName =
          localeSlugMap?.[displayTerm] ||
          localeSlugMap?.[term] ||
          localeSlugMap?.[decoded] ||
          globalSlugMap?.[displayTerm] ||
          globalSlugMap?.[term] ||
          globalSlugMap?.[decoded];
        const comment =
          humanName &&
          humanName.trim() &&
          humanName.trim().toLowerCase() !== displayTerm.toLowerCase()
            ? ` # ${humanName.trim()}`
            : '';
        lines.push(`    - ${formatYamlScalar(displayTerm)}${comment}`);
      }
    }
  }

  // SEO
  if (data.seo) {
    lines.push('seo:');
    if (data.seo.title !== undefined) lines.push(`  title: ${JSON.stringify(data.seo.title)}`);
    if (data.seo.description !== undefined)
      lines.push(`  description: ${JSON.stringify(data.seo.description)}`);
    if (data.seo.canonical !== undefined)
      lines.push(`  canonical: ${JSON.stringify(data.seo.canonical)}`);
    if (data.seo.noIndex !== undefined) lines.push(`  noIndex: ${data.seo.noIndex}`);
    if (data.seo.image !== undefined) lines.push(`  image: ${JSON.stringify(data.seo.image)}`);
  }

  // Bylines
  lines.push('bylines:');
  const bylines = data.bylines || [];
  if (bylines.length === 0) {
    lines.push('  []');
  } else {
    for (const byline of bylines) {
      lines.push(`  - ${formatYamlScalar(byline)}`);
    }
  }

  // Custom simple fields (omitted entirely when undefined or empty to preserve byte identity)
  if (data.fields && Object.keys(data.fields).length > 0) {
    lines.push('fields:');
    for (const key of Object.keys(data.fields).sort((a, b) => a.localeCompare(b))) {
      const val = data.fields[key];
      const safeKey = /^[A-Za-z0-9_-]+$/.test(key) ? key : formatYamlScalar(key);
      if (Array.isArray(val)) {
        if (val.length === 0) {
          lines.push(`  ${safeKey}: []`);
        } else {
          lines.push(`  ${safeKey}:`);
          for (const item of val) {
            lines.push(`    - ${formatYamlScalar(item)}`);
          }
        }
      } else if (val === null) {
        lines.push(`  ${safeKey}: null`);
      } else if (typeof val === 'number' || typeof val === 'boolean') {
        lines.push(`  ${safeKey}: ${String(val)}`);
      } else {
        lines.push(`  ${safeKey}: ${formatYamlScalar(val)}`);
      }
    }
  }

  lines.push('---');
  return lines.join('\n');
}

/**
 * Serializes frontmatter and markdown body into a full document.
 */
export function serializeMarkdown(
  frontmatter: Frontmatter,
  body: string,
  candidates?: TaxonomyCandidates,
  options?: SerializeMarkdownOptions,
): string {
  const yaml = formatFrontmatterYaml(frontmatter, candidates, options);
  const cleanBody = body.startsWith('\n') ? body : `\n${body}`;
  return `${yaml}${cleanBody.endsWith('\n') ? cleanBody : cleanBody + '\n'}`;
}

export {
  formatDatePrefix,
  extractDatePrefixFromPath,
  computeArticleRelativePath,
  sanitizeTitleForFilename,
  storageKeyToMarkdownRef,
  collisionSuffixedMarkdownRef,
  DEFAULT_MAX_TITLE_BYTES,
  DEFAULT_MAX_MEDIA_REF_BYTES,
  truncateUtf8Bytes,
} from './naming.js';
