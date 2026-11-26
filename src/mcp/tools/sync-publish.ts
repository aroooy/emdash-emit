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
import { publishArticle } from '../../sync/orchestrator.js';
import { formatToolTextWithMeta, withResolvedContext } from '../tool-errors.js';

export function registerSyncPublishTool(server: McpServer, resolveContext: ContextResolver): void {
  server.tool(
    'sync_publish',
    'Promote a staged remote draft (published* [has unpublished draft]) or draft article to live published status without re-uploading content. Refuses if local unpushed modifications exist (UNPUSHED_CHANGES_PROTECTION) or if the remote draft changed since last sync (Guard G22: REMOTE_CHANGED_BEFORE_PUBLISH).',
    {
      target: z
        .string()
        .describe('Target article file path (relative to workspace) or 26-char ULID'),
      force: z
        .boolean()
        .optional()
        .describe('Proceed even if an active web co-editing room is detected (Guard G23)'),
      localMediaRefs: z
        .boolean()
        .optional()
        .describe(
          'Keep mirrored body images as article-relative "../../media/<storageKey>" references on disk. Defaults to .emit/config.json.',
        ),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) =>
      withResolvedContext(resolveContext, args, async (ctx) => {
        const res = await publishArticle(args.target, {
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

        const lines = res.alreadyPublished
          ? [`ℹ️ Article '${res.id}' (${res.filePath}) is already published with no pending draft.`]
          : [
              `✅ Successfully published '${res.id}' -> ${res.filePath} (rev: ${res.rev}).`,
              ...(res.previousFilePath
                ? [`📄 Local file moved: "${res.previousFilePath}" -> "${res.filePath}"`]
                : []),
            ];

        lines.push(`🛠️ Admin: ${res.adminUrl}`);
        if (ctx.originWarning) lines.push('', `⚠️ ${ctx.originWarning}`);

        return formatToolTextWithMeta(lines.join('\n'), ctx.meta);
      }),
  );
}
