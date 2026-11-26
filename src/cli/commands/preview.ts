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

import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { previewArticle } from '../../sync/orchestrator.js';
import { getWorkspaceStatus } from '../../sync/status.js';
import type { CliContextResolver } from '../context.js';
import { reportActionFailure } from '../report-failure.js';

export type OpenBrowserFn = (url: string) => void;

function defaultOpenBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

export function registerPreviewCommand(
  program: Command,
  resolveContext: CliContextResolver,
  openBrowser: OpenBrowserFn = defaultOpenBrowser,
): void {
  program
    .command('preview [target]')
    .description('Display (and optionally open) the EmDash preview/admin URL for an article')
    .option('--no-open', 'Print the URL without launching a web browser')
    .option('-p, --profile <name>', 'Explicitly use a specific connection profile')
    .action(async (target: string | undefined, options: { open?: boolean; profile?: string }) => {
      try {
        const ctx = resolveContext(options.profile);
        let resolvedTarget = target;
        if (!resolvedTarget) {
          const status = getWorkspaceStatus(ctx.root, ctx.cache, ctx.config.defaultCollection);
          const candidates = status.items.filter(
            (item) => item.hasUnpublishedDraft || item.status === 'draft',
          );
          if (candidates.length === 1) {
            resolvedTarget = candidates[0]!.filePath;
          } else {
            throw new Error(
              candidates.length === 0
                ? 'No draft or unpublished-draft articles found. Specify a file path or ULID: emit preview <target>'
                : `Found ${candidates.length} draft/staged articles. Specify a target: emit preview <file|ULID>`,
            );
          }
        }

        const res = await previewArticle(resolvedTarget, {
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          origin: ctx.origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
          collection: ctx.config.defaultCollection,
        });

        console.log(`📄 Article: ${res.id} (${res.filePath})`);
        if (res.previewUrl) {
          console.log(`   🔗 Preview: ${res.previewUrl}`);
        }
        console.log(`   🛠️ Admin: ${res.adminUrl}`);

        if (options.open !== false) {
          openBrowser(res.url);
        }
      } catch (err: unknown) {
        reportActionFailure(err);
      }
    });
}
