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
import path from 'node:path';

export interface WorkspacePaths {
  root: string;
  emitDir: string;
  configPath: string;
  dbPath: string;
  postsDir: string;
}

/**
 * Searches upwards from `startDir` (defaults to process.cwd()) for the `.emit` workspace directory.
 * Returns the absolute directory path if found, or null otherwise.
 */
export function findWorkspaceRoot(startDir: string = process.cwd()): string | null {
  let currentDir = path.resolve(startDir);

  while (true) {
    const emitPath = path.join(currentDir, '.emit');

    try {
      if (fs.existsSync(emitPath) && fs.statSync(emitPath).isDirectory()) {
        return currentDir;
      }
    } catch {
      // Permission errors or similar; ignore and continue upwards
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached filesystem root
      break;
    }
    currentDir = parentDir;
  }

  return null;
}

/**
 * Ensures the command is executed inside an Emit workspace.
 * Throws an error with actionable guidance if no `.emit` directory is found.
 */
export function requireWorkspaceRoot(startDir: string = process.cwd()): string {
  const root = findWorkspaceRoot(startDir);
  if (!root) {
    throw new Error(
      'Not inside an Emit workspace (no .emit directory found). Run "emit init" or navigate inside a valid workspace.',
    );
  }
  return root;
}

/**
 * Resolves standard paths for an Emit workspace.
 */
export function getWorkspacePaths(workspaceRoot: string): WorkspacePaths {
  const root = path.resolve(workspaceRoot);
  const emitDir = path.join(root, '.emit');

  return {
    root,
    emitDir,
    configPath: path.join(emitDir, 'config.json'),
    dbPath: path.join(emitDir, 'cache.db'),
    postsDir: path.join(root, 'posts'),
  };
}
