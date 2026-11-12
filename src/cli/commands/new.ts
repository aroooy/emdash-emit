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
import { createArticleScaffold, DuplicateSlugError } from '../../sync/new.js';
import { ApiError } from '../../client/error.js';
import { getLocalTaxonomiesSummary, formatTaxonomiesHint } from '../../sync/taxonomies.js';
import type { CliContextResolver } from '../context.js';

export function registerNewCommand(program: Command, resolveContext: CliContextResolver): void {
  const reportActionFailure = (error: unknown): never => {
    if (error instanceof ApiError) {
      console.error(error.toActionableString());
    } else if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }
    process.exit(1);
  };

  program
    .command('new <slug>')
    .description(
      'Create a new draft article template with an auto-generated ULID and taxonomy hints',
    )
    .option('-t, --title <title>', 'Article title')
    .option('-c, --collection <collection>', 'Target collection (defaults to "posts")')
    .option('-l, --locale <locale>', 'Article locale (defaults to "ja")')
    .option(
      '-b, --byline <slug>',
      'Author byline slug (defaults to first cached non-guest author by slug)',
    )
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (slug, options) => {
      try {
        const ctx = resolveContext(options.profile);
        const collection = options.collection || ctx.config.defaultCollection;
        const locale = options.locale || ctx.config.defaultLocale;

        const res = createArticleScaffold({
          slug,
          title: options.title,
          collection,
          locale,
          byline: options.byline,
          workspaceRoot: ctx.root,
          cache: ctx.cache,
        });

        console.log(`✅ Created new article scaffold (ID: ${res.id})`);
        console.log(`   Path: ${res.filePath}`);

        const taxSummary = getLocalTaxonomiesSummary(ctx.root);
        const taxHint = formatTaxonomiesHint(taxSummary, { maxTags: 30 });
        if (taxHint) {
          console.log(`\n${taxHint}`);
        }

        console.log(`\nNext: Write your content in Markdown, then run:`);
        console.log(`   emit push ${res.filePath}`);
      } catch (error) {
        reportActionFailure(error);
      }
    });
}
