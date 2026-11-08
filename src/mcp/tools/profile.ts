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
import { loadProfilesFile, setActiveProfile } from '../../utils/profile.js';
import { formatToolError } from '../tool-errors.js';

export interface ProfileToolOptions {
  getActiveOverride: () => string | undefined;
  setActiveOverride: (name: string | undefined) => void;
  /**
   * Custom profiles.yaml path forwarded from createMcpServer. When set, profile tools read and
   * write exactly the same file the sync tools resolve against, so an embedded server never
   * reports profiles it cannot actually use.
   */
  profilesPath?: string;
}

export function registerProfileTools(server: McpServer, options: ProfileToolOptions): void {
  // profile_list: List available profiles and indicate active one
  server.tool(
    'profile_list',
    'List configured site profiles from the Emit profiles file (~/.config/emit/profiles.yaml by default), showing their origin URLs, workspace roots, and active selection.',
    {},
    async () => {
      try {
        const data = loadProfilesFile(options.profilesPath);
        const currentActive = options.getActiveOverride() || data.active;
        const profiles = Object.entries(data.profiles).map(([name, p]) => ({
          name,
          origin: p.origin,
          workspace: p.workspace,
          active: name === currentActive,
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  activeProfile: currentActive,
                  profiles,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  // profile_switch: Switch active profile for this session or globally
  server.tool(
    'profile_switch',
    'Switch the active site profile for the current MCP session (or globally with persist: true) when managing multiple EmDash instances.',
    {
      name: z.string().describe('Profile name to switch to'),
      persist: z
        .boolean()
        .optional()
        .describe('If true, updates active profile in profiles.yaml permanently'),
    },
    async (args) => {
      try {
        const data = loadProfilesFile(options.profilesPath);
        if (!data.profiles[args.name]) {
          // Marked as a tool error so clients/agents can branch on isError instead of scraping text.
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `❌ Profile "${args.name}" not found. Available profiles: ${Object.keys(data.profiles).join(', ') || 'none'}.`,
              },
            ],
          };
        }

        if (args.persist) {
          setActiveProfile(args.name, options.profilesPath);
        }
        options.setActiveOverride(args.name);

        const p = data.profiles[args.name];
        return {
          content: [
            {
              type: 'text',
              text: `✅ Switched active profile to "${args.name}" (origin: ${p.origin}, workspace: ${p.workspace}${args.persist ? ', persisted to profiles.yaml' : ''}).`,
            },
          ],
        };
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
