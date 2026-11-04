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

import { diffPatch } from 'node-diff3';

export interface DiffResult {
  hasChanges: boolean;
  unifiedDiff: string;
  additions: number;
  deletions: number;
}

/**
 * Computes a unified-like diff between base text and local text without dumping full contents.
 * Conserves LLM context tokens by outputting only changed regions with line context.
 */
export function computeContextDiff(
  baseText: string,
  localText: string,
  options?: { contextLines?: number; baseLabel?: string; localLabel?: string },
): DiffResult {
  if (baseText === localText) {
    return {
      hasChanges: false,
      unifiedDiff: 'No changes detected.',
      additions: 0,
      deletions: 0,
    };
  }

  const baseLines = baseText.split('\n');
  const localLines = localText.split('\n');
  const patches = diffPatch(baseLines, localLines);

  const contextLines = options?.contextLines ?? 3;
  const baseLabel = options?.baseLabel ?? 'base';
  const localLabel = options?.localLabel ?? 'local';

  let additions = 0;
  let deletions = 0;
  const output: string[] = [`--- ${baseLabel}`, `+++ ${localLabel}`];

  for (const patch of patches) {
    const b1 = patch.buffer1;
    const b2 = patch.buffer2;

    deletions += b1.length;
    additions += b2.length;

    // Output hunk header
    output.push(`@@ -${b1.offset + 1},${b1.length} +${b2.offset + 1},${b2.length} @@`);

    // Removed lines
    for (const line of b1.chunk) {
      output.push(`-${line}`);
    }

    // Added lines
    for (const line of b2.chunk) {
      output.push(`+${line}`);
    }
  }

  return {
    hasChanges: true,
    unifiedDiff: output.join('\n'),
    additions,
    deletions,
  };
}
