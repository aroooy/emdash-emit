#!/usr/bin/env node

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

import { Command } from 'commander';
import { runMcpServer } from '../mcp/server.js';
import { createCliContextResolver } from '../cli/context.js';
import { registerProfileCommands } from '../cli/commands/profile.js';
import { registerNewCommand } from '../cli/commands/new.js';
import { registerPullCommands } from '../cli/commands/pull.js';
import { registerPushCommand } from '../cli/commands/push.js';
import { registerStatusInitCommands } from '../cli/commands/status.js';
import { getPackageVersion } from '../utils/version.js';

export const program = new Command();

program
  .name('emit')
  .description('AI-First Local Workspace & Sync Tool for EmDash (Cloudflare Workers + D1)')
  .version(getPackageVersion());

const resolveContext = createCliContextResolver();

// Register modular commands
registerProfileCommands(program);
registerNewCommand(program, resolveContext);
registerPullCommands(program, resolveContext);
registerPushCommand(program, resolveContext);
registerStatusInitCommands(program, resolveContext);

// emit mcp
program
  .command('mcp')
  .description('Run Emit as an MCP stdio server for AI agents (Antigravity, Claude Code)')
  .option('-w, --workspace <path>', 'Path to workspace directory')
  .action(async (options: { workspace?: string }) => {
    await runMcpServer({ workspaceRoot: options.workspace });
  });

export function runCli(argv = process.argv): void {
  program.parse(argv);
}

// Auto-run if executed directly as a script
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('emit.js') ||
    process.argv[1].endsWith('emit.ts') ||
    process.argv[1].endsWith('emit'));

if (isDirectExecution) {
  runCli();
}
