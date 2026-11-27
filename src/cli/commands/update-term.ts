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

import type { Command } from 'commander';
import { updateTaxonomyTerm } from '../../sync/taxonomies.js';
import type { CliContextResolver } from '../context.js';
import { reportActionFailure } from '../report-failure.js';

export function registerUpdateTermCommand(
  program: Command,
  resolveContext: CliContextResolver,
): void {
  program
    .command('update-term <taxonomy> <target>')
    .description(
      'Update an existing category or tag term on EmDash (or an offline staged draft under drafts/)',
    )
    .option('-n, --name <label>', 'New human-readable display name (label)')
    .option('--slug <slug>', 'New URL slug for the term')
    .option('--parent <slugOrId>', 'New parent category slug or 26-char ULID (categories only)')
    .option('--clear-parent', 'Detach from parent category (sets parentId to null)')
    .option('-d, --description <text>', 'New term description')
    .option(
      '-l, --locale <locale>',
      'Locale selector to disambiguate translations sharing the same slug',
    )
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (taxonomyInput: string, target: string, options) => {
      try {
        const normalizedTax = taxonomyInput.trim().toLowerCase();
        const taxonomy: 'category' | 'tag' =
          normalizedTax === 'category' || normalizedTax === 'categories'
            ? 'category'
            : normalizedTax === 'tag' || normalizedTax === 'tags'
              ? 'tag'
              : (() => {
                  throw new Error(`Invalid taxonomy "${taxonomyInput}". Use "category" or "tag".`);
                })();

        const ctx = resolveContext(options.profile);
        const res = await updateTaxonomyTerm({
          workspaceRoot: ctx.root,
          origin: ctx.origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
          defaultLocale: ctx.config.defaultLocale,
          taxonomy,
          target,
          locale: options.locale,
          name: options.name,
          slug: options.slug,
          parent: options.parent,
          clearParent: options.clearParent === true,
          description: options.description,
        });

        console.log(`✅ Updated ${res.isDraft ? 'staged draft ' : ''}${taxonomy} term (${res.id})`);
        if (res.filePath) {
          console.log(`   Path:   ${res.filePath}`);
        }
        console.log(`   Slug:   ${res.slug} (locale: ${res.locale})`);
        console.log(`   Name:   ${res.name}`);
        console.log(`   Parent: ${res.parentId ?? 'null'}`);
        if (typeof res.description === 'string') {
          console.log(`   Desc:   ${res.description}`);
        }
        for (const w of res.warnings) {
          console.warn(`⚠️  ${w}`);
        }
      } catch (err) {
        reportActionFailure(err);
      }
    });
}
