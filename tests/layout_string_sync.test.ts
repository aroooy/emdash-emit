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
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

function listTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

describe('v0.2.x Layout String Sync Gate (no stale 2-tier paths in CLI/MCP/guards)', () => {
  const targetFiles = [
    ...listTsFiles(path.join(ROOT, 'src/cli/commands')),
    ...listTsFiles(path.join(ROOT, 'src/mcp')),
    path.join(ROOT, 'src/sync/push/guards.ts'),
    path.join(ROOT, 'src/sync/preflight.ts'),
    path.join(ROOT, 'src/sync/new.ts'),
    path.join(ROOT, 'src/sync/taxonomies.ts'),
    path.join(ROOT, 'src/client/portable-text.ts'),
  ];

  // Matches legacy 2-tier paths, depth-2 media refs (excluding ../../../media/), or flat taxonomy YAML paths
  const stalePatterns: Array<{ name: string; regex: RegExp }> = [
    { name: 'legacy posts/draft/', regex: /\bposts\/draft\// },
    { name: 'legacy posts/published/', regex: /\bposts\/published\// },
    { name: 'legacy depth-2 ../../media/', regex: /(?<!\.\.\/)\.\.\/\.\.\/media\// },
    { name: 'legacy flat categories/*.yaml', regex: /\bcategories\/\*\.yaml/ },
    { name: 'legacy flat tags/*.yaml', regex: /\btags\/\*\.yaml/ },
    { name: 'legacy flat categories/<id>-', regex: /\bcategories\/<id>-/ },
    { name: 'legacy flat tags/<id>-', regex: /\btags\/<id>-/ },
  ];

  it('contains zero stale 2-tier layout strings in user-facing and AI-facing modules', () => {
    const violations: string[] = [];

    for (const filePath of targetFiles) {
      const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        const trimmed = line.trim();
        // Skip pure comment lines
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          continue;
        }
        for (const { name, regex } of stalePatterns) {
          if (regex.test(line)) {
            violations.push(`${rel}:${idx + 1} [${name}] -> ${trimmed}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('contains zero stale 2-tier layout strings or outdated guard counts in README.md and AGENTS.md', () => {
    const docTargets = [path.join(ROOT, 'README.md'), path.join(ROOT, 'AGENTS.md')];
    const docPatterns: Array<{ name: string; regex: RegExp }> = [
      ...stalePatterns,
      { name: 'outdated guard range G1–G20..G23', regex: /G1–G2[0-3]\b/ },
      {
        name: 'outdated guard count 20 preflight/Code-Level',
        regex: /\b20\s+(?:preflight|Code-Level)/,
      },
    ];
    const violations: string[] = [];

    for (const filePath of docTargets) {
      const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        for (const { name, regex } of docPatterns) {
          if (regex.test(line)) {
            violations.push(`${rel}:${idx + 1} [${name}] -> ${line.trim()}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
