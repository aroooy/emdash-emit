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
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContextResolver } from '../context.js';
import { computeContextDiff } from '../../sync/diff.js';
import { extractUlidFromFilename } from '../../utils/naming.js';

export function registerSyncDiffTool(server: McpServer, resolveContext: ContextResolver): void {
  server.tool(
    'sync_diff',
    {
      filePath: z
        .string()
        .optional()
        .describe(
          'Relative path to the markdown file to inspect (e.g. "posts/draft/20261103_01...-my-article.md")',
        ),
      id: z.string().optional().describe('Article ID (ULID) to inspect'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) => {
      const ctx = resolveContext(args.profile);

      let targetId = args.id;
      let targetFile = args.filePath;

      if (!targetId && targetFile) {
        const full = path.join(ctx.root, targetFile);
        if (fs.existsSync(full)) {
          const ulid = extractUlidFromFilename(full);
          if (ulid) targetId = ulid;
        }
      }

      if (targetId && !targetFile) {
        const syncState = ctx.cache.getSyncState(targetId);
        if (syncState) targetFile = syncState.localFilePath;
      }

      if (!targetId || !targetFile) {
        return {
          content: [
            {
              type: 'text',
              text: '❌ Please specify a valid "filePath" or "id" to compute diff.',
            },
          ],
        };
      }

      const fullLocalPath = path.join(ctx.root, targetFile);
      if (!fs.existsSync(fullLocalPath)) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Local file not found: ${targetFile}`,
            },
          ],
        };
      }

      const localContent = fs.readFileSync(fullLocalPath, 'utf8');
      const baseSnapshot = ctx.cache.getBaseSnapshot(targetId);

      if (!baseSnapshot) {
        return {
          content: [
            {
              type: 'text',
              text: `ℹ️ No base snapshot found for ID "${targetId}". Article is untracked or newly created.`,
            },
          ],
        };
      }

      const syncState = ctx.cache.getSyncState(targetId);
      const currentHash = crypto.createHash('sha256').update(localContent, 'utf8').digest('hex');
      const isModified = syncState ? syncState.localHash !== currentHash : true;
      const baseFullMarkdown = `---\n${baseSnapshot.frontmatterYaml}---\n${baseSnapshot.bodyMarkdown}`;
      const diffResult = computeContextDiff(baseFullMarkdown, localContent, {
        baseLabel: `base [rev: ${baseSnapshot.rev}]`,
        localLabel: `local [${targetFile}]`,
      });

      return {
        content: [
          {
            type: 'text',
            text: [
              `--- Diff for ${targetFile} (${targetId}) ---`,
              `Status: ${isModified ? '🟡 Modified' : '🟢 In Sync with base snapshot'}`,
              `Base Rev: ${baseSnapshot.rev}`,
              `Base Saved At: ${new Date(baseSnapshot.savedAt).toISOString()}`,
              `Changes: +${diffResult.additions} / -${diffResult.deletions} lines`,
              '',
              'Unified Diff:',
              '----------------------------------------',
              diffResult.unifiedDiff,
              '----------------------------------------',
            ].join('\n'),
          },
        ],
      };
    },
  );
}
