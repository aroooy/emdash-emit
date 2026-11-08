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
import type { ContextResolver, ServerContext } from '../context.js';
import { runWorkspaceDoctor } from '../../sync/doctor.js';
import { formatToolError, formatToolSuccess } from '../tool-errors.js';

export function registerSyncDoctorTool(server: McpServer, resolveContext: ContextResolver): void {
  server.tool(
    'sync_doctor',
    'Run comprehensive workspace diagnostics: verifies version compatibility, profile/config origin consistency, frontmatter syntax integrity across all articles, quarantined conflict copies, unpushed modifications, and referenced media existence.',
    {
      collection: z
        .string()
        .optional()
        .describe('Collection to diagnose (defaults to defaultCollection or "posts")'),
      profile: z.string().optional().describe('Target profile name for multi-site setups'),
    },
    async (args) => {
      let ctx: ServerContext;
      try {
        ctx = resolveContext(args.profile);
      } catch (error) {
        return formatToolError(error);
      }

      try {
        const collection = args.collection || ctx.config.defaultCollection || 'posts';
        const report = await runWorkspaceDoctor({
          workspaceRoot: ctx.root,
          cache: ctx.cache,
          config: ctx.config,
          profileName: ctx.auth.profileName,
          profileOrigin: ctx.auth.origin,
          collection,
        });

        return formatToolSuccess(report as unknown as Record<string, unknown>, ctx.meta);
      } catch (err) {
        return formatToolError(err, ctx.meta);
      }
    },
  );
}
