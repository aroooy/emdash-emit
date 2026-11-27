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
import { createLocalDraftTerm } from '../../sync/taxonomies.js';
import type { CliContextResolver } from '../context.js';
import { reportActionFailure } from '../report-failure.js';

export function registerNewTermCommand(program: Command, resolveContext: CliContextResolver): void {
  program
    .command('new-term <taxonomy> <slug>')
    .description(
      'Stage a new category or tag term offline in categories/drafts/<locale>/ or tags/drafts/<locale>/ (auto-created on emit push)',
    )
    .option('-n, --name <label>', 'Human-readable display name (defaults to decoded slug)')
    .option('-l, --locale <locale>', 'Term locale (defaults to workspace defaultLocale)')
    .option('--parent <slugOrId>', 'Parent category slug or 26-char ULID (for categories)')
    .option(
      '--translation-of <termId>',
      'Source term ID (26-char ULID) to join as a localized translation',
    )
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action((taxonomyInput: string, slug: string, options) => {
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
        const locale = options.locale || ctx.config.defaultLocale;

        const res = createLocalDraftTerm({
          workspaceRoot: ctx.root,
          taxonomy,
          slug,
          name: options.name,
          locale,
          parent: options.parent,
          translationOf: options.translationOf,
        });

        console.log(`✅ Staged offline ${taxonomy} term (provisional ID: ${res.id})`);
        console.log(`   Path:   ${res.filePath}`);
        console.log(`   Slug:   ${res.slug} (locale: ${res.locale})`);
        console.log(`   Name:   ${res.name}`);
        if (res.parentId) {
          console.log(`   Parent: ${res.parentId}`);
        }
        if (res.translationOf) {
          console.log(`   TranslationOf: ${res.translationOf}`);
        }
        console.log(
          `\nNext: Reference "${res.slug}" in article frontmatter, then run "emit push" when online to create & promote it automatically.`,
        );
      } catch (err) {
        reportActionFailure(err);
      }
    });
}
