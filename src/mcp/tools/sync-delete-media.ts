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

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatMediaDeleteReport } from '../../presentation/media_report.js';
import { deleteMedia } from '../../sync/media/index.js';
import type { ContextResolver } from '../context.js';
import { formatToolSuccess, withResolvedContext } from '../tool-errors.js';

export function registerSyncDeleteMediaTool(
  server: McpServer,
  resolveContext: ContextResolver,
): void {
  server.tool(
    'sync_delete_media',
    'Safely delete one or more media assets from the remote EmDash server and local workspace media/ mirror. Enforces Guard G20 (MEDIA_IN_USE_PROTECTION): refuses deletion if any article in the local workspace references the asset (no bypass flag; remove the reference from the article first). Moves deleted local mirrors and companion YAMLs into media/_trash/<stem>.deleted.* as a rescue backup unless noBackup=true. Note: Reference checks scan only articles present in the local workspace ([LOCAL_REFERENCE_SCAN_ONLY]). Zero-token offline dryRun is CLI-only ("emit delete-media --dry-run"); MCP requires an authenticated profile.',
    {
      targets: z
        .array(z.string().min(1))
        .min(1)
        .describe(
          'One or more local mirror paths ("media/<stem>.<ext>" / "media/<stem>.yaml"), storageKeys, or 26-char mediaIds.',
        ),
      dryRun: z
        .boolean()
        .optional()
        .describe('Preview deletion and local reference checks without deleting anything'),
      noBackup: z
        .boolean()
        .optional()
        .describe('Skip moving local mirror files into media/_trash/ after remote deletion'),
      collection: z
        .string()
        .optional()
        .describe('Collection name to scan for local references (defaults to "posts")'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) =>
      withResolvedContext(resolveContext, args, async (ctx) => {
        const result = await deleteMedia({
          workspaceRoot: ctx.root,
          origin: ctx.origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
          targets: args.targets,
          collection: args.collection || ctx.config.defaultCollection,
          dryRun: args.dryRun,
          noBackup: args.noBackup,
          cache: ctx.cache,
        });

        return formatToolSuccess(
          {
            dryRun: result.dryRun,
            total: result.items.length,
            items: result.items,
            warnings: result.warnings,
            report: formatMediaDeleteReport(result),
          },
          ctx.meta,
        );
      }),
  );
}
