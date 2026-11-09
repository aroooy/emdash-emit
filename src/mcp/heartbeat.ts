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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface McpHeartbeatState {
  pid: number;
  version: string;
  startedAt: string;
  origin?: string;
  profile?: string;
  workspaceRoot?: string;
}

export interface McpProcessCheckResult {
  status: 'alive' | 'stale' | 'unknown' | 'none';
  state?: McpHeartbeatState;
  isOutdated?: boolean;
  message?: string;
}

export function getMcpStateFilePath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.config', 'emit', 'mcp_state.json');
}

export function getPackageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const content = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(content) as { version?: string };
    return parsed.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Records heartbeat metadata to ~/.config/emit/mcp_state.json with restricted 0600 permissions.
 */
export function recordMcpHeartbeat(
  metadata?:
    | string
    | {
        origin?: string;
        profile?: string;
        workspaceRoot?: string;
      },
): void {
  try {
    const filePath = getMcpStateFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const metaObj = typeof metadata === 'string' ? { origin: metadata } : metadata || {};
    const payload: McpHeartbeatState = {
      pid: process.pid,
      version: getPackageVersion(),
      startedAt: new Date().toISOString(),
      ...(metaObj.origin ? { origin: metaObj.origin } : {}),
      ...(metaObj.profile ? { profile: metaObj.profile } : {}),
      ...(metaObj.workspaceRoot ? { workspaceRoot: metaObj.workspaceRoot } : {}),
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  } catch {
    // Non-fatal if filesystem is restricted or read-only
  }
}

/**
 * Checks the status of the recorded MCP process in ~/.config/emit/mcp_state.json.
 * Handles process vitality via process.kill(pid, 0):
 * - ESRCH: Process has terminated -> cleanly remove stale state file.
 * - EPERM: Process belongs to another user on shared host -> mark unknown.
 * - Alive: Compares start time against package.json mtime to detect outdated processes.
 *
 * Note: mtime-based comparison can yield false negatives if package is downgraded.
 */
export function checkMcpProcess(customPackageJsonPath?: string): McpProcessCheckResult {
  const filePath = getMcpStateFilePath();
  if (!fs.existsSync(filePath)) {
    return { status: 'none' };
  }

  let state: McpHeartbeatState;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    state = JSON.parse(content) as McpHeartbeatState;
  } catch {
    return { status: 'none' };
  }

  try {
    // Probe process vitality
    process.kill(state.pid, 0);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ESRCH') {
      // Process is dead: clean up stale heartbeat file
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore unlink error
      }
      return { status: 'stale', state };
    }
    if (code === 'EPERM') {
      // Process belongs to another user
      return { status: 'unknown', state };
    }
    return { status: 'unknown', state };
  }

  // Process is alive: check if outdated
  let isOutdated = false;
  let message: string | undefined;

  try {
    const pkgPath =
      customPackageJsonPath || fileURLToPath(new URL('../../package.json', import.meta.url));
    if (fs.existsSync(pkgPath)) {
      const pkgStat = fs.statSync(pkgPath);
      const pkgContent = fs.readFileSync(pkgPath, 'utf8');
      const pkgJson = JSON.parse(pkgContent) as { version?: string };
      const currentPkgVersion = pkgJson.version || '';

      const startedMs = new Date(state.startedAt).getTime();
      const mtimeMs = pkgStat.mtimeMs;

      if (state.version !== currentPkgVersion || startedMs < mtimeMs) {
        isOutdated = true;
        message = `An MCP server process (PID ${state.pid}, version ${state.version}) is currently running from a previous installation. Restart your IDE or MCP client to activate version ${currentPkgVersion}.`;
      }
    }
  } catch {
    // Ignore version check errors
  }

  return {
    status: 'alive',
    state,
    isOutdated,
    message,
  };
}
