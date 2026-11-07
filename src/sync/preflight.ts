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

import path from 'node:path';
import { extractUlidFromFilename } from '../utils/naming.js';
import {
  stripCodeBlocks,
  verifyOpaqueBlocksUntampered,
  detectUnsupportedMarkdownSyntax,
} from '../client/portable-text.js';
import type { Frontmatter, ParsedMarkdown } from '../utils/frontmatter.js';

export interface PreflightOptions {
  allowPublish?: boolean;
  knownTaxonomies?: Record<string, string[]>;
  baseMarkdown?: string;
  previousStatus?: 'draft' | 'published';
}

export interface PreflightResult {
  valid: boolean;
  cleanedBody: string;
  frontmatter: Frontmatter;
  errors: PreflightError[];
  warnings: string[];
}

export interface PreflightError {
  code: string;
  message: string;
  suggestion?: string;
}

const CONFLICT_MARKER_REGEX = /^<{7}\s|^={7}$|^>{7}\s/m;
const LOCAL_IMAGE_REGEX = /!\[.*?\]\((?!https?:\/\/|data:|\/_emdash\/api\/media\/file\/).*?\)/;

/**
 * Runs Preflight Guards G2 through G9 against the article to prevent AI misbehavior.
 * (G1 is enforced at the MCP / CLI invocation layer).
 */
export function runPreflightChecks(
  filePath: string,
  parsed: ParsedMarkdown,
  options?: PreflightOptions,
): PreflightResult {
  const errors: PreflightError[] = [];
  const warnings: string[] = [];
  let cleanedBody = parsed.body;
  const { frontmatter } = parsed;

  // G2: ID (ULID) immutability check
  const filename = path.basename(filePath);
  const filenameId = extractUlidFromFilename(filename);
  if (filenameId) {
    if (filenameId !== frontmatter.id) {
      errors.push({
        code: 'ID_MISMATCH_ERROR',
        message: `ID in frontmatter ('${frontmatter.id}') does not match ULID in filename ('${filenameId}').`,
        suggestion:
          'Do not rename files manually with "mv". Update the slug or title in frontmatter, and Emit will rename the file automatically on push.',
      });
    }
  }

  // G3: Unintended publish check
  const prevStatus = options?.previousStatus ?? 'draft';
  if (prevStatus === 'draft' && frontmatter.status === 'published' && !options?.allowPublish) {
    errors.push({
      code: 'UNINTENDED_PUBLISH_GUARD',
      message:
        'Article status was changed from draft to published, but allowPublish: true was not provided.',
      suggestion:
        'To publish the article live, re-run with allowPublish: true. Otherwise, keep status as draft.',
    });
  }

  // G4: Taxonomy hallucination check
  if (options?.knownTaxonomies && frontmatter.taxonomies) {
    for (const [taxName, terms] of Object.entries(frontmatter.taxonomies)) {
      const allowed = options.knownTaxonomies[taxName];
      if (allowed && Array.isArray(terms)) {
        for (const term of terms) {
          if (!allowed.includes(term)) {
            const allowedPreview = allowed.slice(0, 20).join(', ');
            const moreSuffix = allowed.length > 20 ? ' ...' : '';
            // Term IDs are canonical 26-char ULIDs: uppercase Crockford base32 (excludes I, L, O, U).
            // Restricting to that alphabet prevents 26-character slugs from being mislabeled as IDs.
            const isTermId = /^[0-9A-HJ-NP-Z]{26}$/.test(term);
            const staleNote = isTermId
              ? ' (term ID was not found in local definitions and may be stale or deleted)'
              : '';
            errors.push({
              code: 'INVALID_TAXONOMY_ERROR',
              message: `Unknown ${taxName} term: '${term}'${staleNote}.`,
              suggestion: `Use one of the allowed ${taxName}: [${allowedPreview}${moreSuffix}], run sync_pull_taxonomies to refresh, or create it via official MCP first.`,
            });
          }
        }
      }
    }
  }

  // G5: Local image path detection (stripping code blocks first)
  const bodyWithoutCode = stripCodeBlocks(cleanedBody);
  const localImageMatch = bodyWithoutCode.match(LOCAL_IMAGE_REGEX);
  if (localImageMatch) {
    errors.push({
      code: 'LOCAL_IMAGE_DETECTED',
      message: `Local image path detected in markdown body: '${localImageMatch[0]}'.`,
      suggestion:
        'Upload the image first using emdash official MCP "media_upload", and replace the local path with the returned remote URL (e.g. /_emdash/api/media/file/<id>.<ext>).',
    });
  }

  // G6: Unresolved conflict markers check
  if (CONFLICT_MARKER_REGEX.test(cleanedBody)) {
    errors.push({
      code: 'UNRESOLVED_CONFLICT_MARKERS',
      message:
        'Unresolved 3-Way Merge conflict markers (<<<<<<<, =======, >>>>>>>) found in markdown body.',
      suggestion:
        'Resolve all conflicting regions in the body and remove the conflict markers before pushing.',
    });
  }

  // G7: Title duplication check (auto-trim)
  // If the body starts with an H1/H2 that duplicates frontmatter.title, trim it safely.
  const trimmedBody = cleanedBody.trimStart();
  const titleHeadingRegex = /^(?:#|##)\s+(.+)$/m;
  const headingMatch = trimmedBody.match(titleHeadingRegex);
  if (headingMatch && trimmedBody.startsWith(headingMatch[0])) {
    const headingText = headingMatch[1].trim().toLowerCase();
    const titleText = frontmatter.title.trim().toLowerCase();
    if (headingText === titleText) {
      warnings.push(
        `Duplicate top-level heading matching title ('${headingMatch[0]}') was automatically trimmed from body.`,
      );
      // Remove the top heading line and following empty line
      cleanedBody = trimmedBody.slice(headingMatch[0].length).replace(/^\r?\n/, '');
    }
  }

  // G9: Opaque fence tampered check
  if (options?.baseMarkdown) {
    const isUntampered = verifyOpaqueBlocksUntampered(options.baseMarkdown, cleanedBody);
    if (!isUntampered) {
      errors.push({
        code: 'MODIFIED_OPAQUE_BLOCK',
        message:
          'One or more <!--ec:block ... --> opaque custom block fences were modified or deleted.',
        suggestion:
          'Restore the exact <!--ec:block ... --> comment fence from the base version. Custom blocks cannot be edited directly in Markdown.',
      });
    }
  }

  // Unsupported Markdown syntax warning (tables, raw block HTML tags)
  const syntaxWarnings = detectUnsupportedMarkdownSyntax(cleanedBody);
  warnings.push(...syntaxWarnings);

  return {
    valid: errors.length === 0,
    cleanedBody,
    frontmatter,
    errors,
    warnings,
  };
}
