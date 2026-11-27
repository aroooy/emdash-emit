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

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContextResolver } from '../context.js';
import { discardDraftArticle } from '../../sync/orchestrator.js';
import { formatToolTextWithMeta, withResolvedContext } from '../tool-errors.js';

export function registerSyncDiscardDraftTool(
  server: McpServer,
  resolveContext: ContextResolver,
): void {
  server.tool(
    'sync_discard_draft',
    'Discard an unpublished staged draft revision on a published article and re-pull the live version. Refuses draft-only articles without a published live version (Guard G21: DRAFT_ONLY_DISCARD_FORBIDDEN) and protects unpushed local edits unless force=true (which quarantines local edits to posts/conflicts/).',
    {
      target: z
        .string()
        .describe('Target article file path (relative to workspace) or 26-char ULID'),
      force: z
        .boolean()
        .optional()
        .describe(
          'Quarantine unpushed local edits to posts/conflicts/ and discard the remote draft',
        ),
      localMediaRefs: z
        .boolean()
        .optional()
        .describe(
          'Keep mirrored body images as article-relative "../../../media/<storageKey>" references on disk. Defaults to .emit/config.json.',
        ),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) =>
      withResolvedContext(resolveContext, args, async (ctx) => {
        const res = await discardDraftArticle(args.target, {
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          origin: ctx.origin,
          token: ctx.auth.token,
          refreshToken: ctx.auth.refreshToken,
          collection: ctx.config.defaultCollection,
          force: args.force,
          localMediaRefs:
            args.localMediaRefs === undefined ? ctx.config.localMediaRefs : args.localMediaRefs,
        });

        const lines = res.noDraftPending
          ? [`ℹ️ Article '${res.id}' (${res.filePath}) has no pending remote draft.`]
          : [
              `✅ Discarded remote draft for '${res.id}' and synced live version -> ${res.filePath} (rev: ${res.rev}).`,
              ...(res.rescueFilePath
                ? [`🛟 Local edits quarantined to: ${res.rescueFilePath}`]
                : []),
            ];

        lines.push(`🛠️ Admin: ${res.adminUrl}`);
        if (ctx.originWarning) lines.push('', `⚠️ ${ctx.originWarning}`);

        return formatToolTextWithMeta(lines.join('\n'), ctx.meta);
      }),
  );
}
