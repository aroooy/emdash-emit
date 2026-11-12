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
import { ApiError } from '../../client/error.js';
import { collectLocalMirrorIndex, searchRemoteMedia } from '../../sync/media.js';
import { getLocalTaxonomiesSummary } from '../../sync/taxonomies.js';
import type { CliContextResolver } from '../context.js';

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '';
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function registerMediaSearchCommand(
  program: Command,
  resolveContext: CliContextResolver,
): void {
  const reportActionFailure = (error: unknown): never => {
    if (error instanceof ApiError) {
      console.error(error.toActionableString());
    } else if (error instanceof Error) {
      console.error(`❌ Error: ${error.message}`);
    } else {
      console.error(`❌ Error: ${String(error)}`);
    }
    process.exit(1);
  };

  program
    .command('media-search <query>')
    .description(
      'Search the remote EmDash media library by keyword (filename, alt, caption, storageKey)',
    )
    .option('-l, --limit <number>', 'Max hits (default 20, max 50)')
    .option(
      '--max-scan <number>',
      'Records to read before stopping (default 500; 0 = whole library)',
    )
    .option('--mirrored-only', 'Only assets Emit already mirrors')
    .option('--suggest-keywords', 'Append the top local tag slugs as search hints')
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (query: string, options) => {
      try {
        const ctx = resolveContext(options.profile);

        const limit = options.limit ? parseInt(options.limit, 10) : undefined;
        const maxScan = options.maxScan !== undefined ? parseInt(options.maxScan, 10) : undefined;

        const mirrorIndex = collectLocalMirrorIndex(ctx.root, ctx.cache);

        const result = await searchRemoteMedia({
          workspaceRoot: ctx.root,
          origin: ctx.origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
          query,
          limit,
          maxScan,
          mirroredOnly: Boolean(options.mirroredOnly),
          mirrorIndex,
        });

        const totalLabel =
          result.totalCount !== null ? `${result.totalCount} records` : 'an unknown-size library';
        console.log(
          `Media search: "${query}" (scanned ${result.scannedCount} of ${totalLabel})${result.truncated ? ' [truncated at limit]' : ''}`,
        );

        if (result.hits.length === 0) {
          if (result.walkComplete) {
            console.log(
              `\nNo match found in the remote media library (${result.scannedCount} records scanned).`,
            );
          } else {
            console.log(`\nNo match in the first ${result.scannedCount} record(s).`);
          }
        } else {
          result.hits.forEach((hit, i) => {
            const num = `${i + 1}.`.padEnd(4, ' ');
            const statusBadge = hit.mirrored ? '[mirrored]' : '[not mirrored]';
            console.log(
              `  ${num}${hit.mediaId}  storageKey ${hit.storageKey || '(none)'}  ${statusBadge}`,
            );

            const parts: string[] = [];
            if (hit.localPath) parts.push(hit.localPath);
            if (hit.alt) parts.push(`alt: ${hit.alt}`);
            if (hit.caption) parts.push(`caption: ${hit.caption}`);
            if (hit.mimeType) parts.push(hit.mimeType);
            const sizeStr = formatSize(hit.size);
            if (sizeStr) parts.push(sizeStr);

            console.log(`     ${parts.join('   ')}`);
          });
        }

        if (!result.walkComplete) {
          console.log(
            `\n⚠️ [WALK_INCOMPLETE] read ${result.scannedCount} record(s) and stopped at --max-scan; absence is not proven.`,
          );
          console.log(`   Narrow the query or raise --max-scan (0 walks the whole library).`);
        }

        if (result.hits.length > 0) {
          console.log(
            `\n💡 To use a hit: write /_emdash/api/media/file/<storageKey> into the article body — pull/push mirrors it`,
          );
          console.log(
            `   automatically. For an offline copy first: emit pull-media --storage-key <storageKey>.`,
          );
          console.log(`   Fleet-scale listing stays on the official EmDash MCP / Admin Dashboard.`);
        }

        if (options.suggestKeywords) {
          try {
            const tax = getLocalTaxonomiesSummary(ctx.root);
            if (tax.tags.length > 0) {
              const topTags = tax.tags.slice(0, 10).map((t) => `#${t.slug}`);
              console.log(`\nTag search hints: ${topTags.join(', ')}`);
            }
          } catch {
            // Taxonomy reading failure is non-fatal for search
          }
        }
      } catch (err) {
        reportActionFailure(err);
      }
    });
}
