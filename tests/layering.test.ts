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

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '../src');

/**
 * Layer 1 (Sync Upstream - inspection/computation):
 * MUST NOT import Layer 2 (downstream execution/orchestration) or Layer 3.
 */
const LAYER_1_FILES = [
  'sync/status.ts',
  'sync/diff.ts',
  'sync/merge.ts',
  'sync/preflight.ts',
  'sync/guards.ts',
  'sync/taxonomies.ts',
  'sync/terms.ts',
  'sync/bylines.ts',
];

/**
 * Layer 2 modules:
 * Downstream execution and orchestration.
 */
const LAYER_2_MODULE_NAMES = [
  'orchestrator',
  'push',
  'pull',
  'new',
  'delete',
  'conflicts',
  'doctor',
  'media',
];

/**
 * Snapshot of permitted Layer 2 imports from Layer 3 (cli / mcp / presentation).
 * Enforces that internal details of Layer 2 are not leaked to consumers.
 */
const ALLOWED_LAYER_2_SYMBOLS: Record<string, ReadonlySet<string>> = {
  orchestrator: new Set(['pullBatch', 'pushAll', 'SyncPruneConflictError']),
  push: new Set(['pushArticle', 'PushValidationError']),
  pull: new Set(['pullArticle', 'formatQuarantineNotice', 'PullResult']),
  new: new Set(['createArticleScaffold', 'DuplicateSlugError']),
  delete: new Set([
    'deleteArticle',
    'UnpushedModificationsError',
    'PublishedArticleDeletionForbiddenError',
  ]),
  conflicts: new Set([
    'listConflicts',
    'diffConflict',
    'resolveConflict',
    'pruneConflicts',
    'CanonicalHasUnpushedEditsError',
    'QuarantinedPathRequiredError',
  ]),
  doctor: new Set(['runWorkspaceDoctor']),
  media: new Set(['pullMedia', 'collectLocalMirrorIndex', 'searchRemoteMedia']),
};

interface ImportStatement {
  source: string;
  specifiers: string[];
  line: number;
}

function parseImports(fileContent: string): ImportStatement[] {
  const imports: ImportStatement[] = [];
  const lines = fileContent.split('\n');
  const importRegex = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;

  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(fileContent)) !== null) {
    const rawSpecifiers = match[1].trim();
    const source = match[2].trim();

    // Calculate line number
    const upToMatch = fileContent.slice(0, match.index);
    const line = upToMatch.split('\n').length;

    const specifiers: string[] = [];
    if (rawSpecifiers.startsWith('{') && rawSpecifiers.endsWith('}')) {
      const inner = rawSpecifiers.slice(1, -1);
      for (const part of inner.split(',')) {
        const clean = part
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '')
          .trim();
        if (!clean) continue;
        // Handle "type Foo", "Foo as Bar", "type Foo as Bar"
        const withoutType = clean.replace(/^type\s+/, '').trim();
        const baseName = withoutType.split(/\s+as\s+/)[0].trim();
        if (baseName) specifiers.push(baseName);
      }
    } else if (rawSpecifiers) {
      // Default or namespace import: e.g. "foo", "* as foo"
      specifiers.push(rawSpecifiers.replace(/^\*\s+as\s+/, '').trim());
    }

    imports.push({ source, specifiers, line });
  }

  return imports;
}

function collectSourceFiles(dir: string, ext = '.ts'): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(full, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext) && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

describe('Architectural Layering Invariants', () => {
  it('Axis 1: Layer 1 (Upstream) files NEVER import Layer 2 (Downstream) modules', () => {
    const violations: { file: string; line: number; source: string }[] = [];

    for (const relPath of LAYER_1_FILES) {
      const fullPath = path.join(SRC_ROOT, relPath);
      if (!fs.existsSync(fullPath)) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      const imports = parseImports(content);

      for (const imp of imports) {
        // Check if import source points to a Layer 2 module
        const resolvedTarget = path.normalize(
          path.join(path.dirname(fullPath), imp.source).replace(/\.js$/, ''),
        );
        for (const l2 of LAYER_2_MODULE_NAMES) {
          const l2Path = path.normalize(path.join(SRC_ROOT, 'sync', l2));
          if (resolvedTarget === l2Path || resolvedTarget.startsWith(l2Path + path.sep)) {
            violations.push({
              file: relPath,
              line: imp.line,
              source: imp.source,
            });
          }
        }
      }
    }

    expect(
      violations,
      `Layer 1 -> Layer 2 import violations found:\n` +
        violations.map((v) => `  ${v.file}:${v.line} -> ${v.source}`).join('\n'),
    ).toHaveLength(0);
  });

  it('Axis 2: Layer 3 (CLI / MCP / Presentation) imports only allowed Layer 2 symbols', () => {
    const layer3Dirs = [
      path.join(SRC_ROOT, 'cli'),
      path.join(SRC_ROOT, 'mcp'),
      path.join(SRC_ROOT, 'presentation'),
    ];

    const layer3Files = layer3Dirs.flatMap((d) => collectSourceFiles(d));
    const violations: { file: string; module: string; symbol: string }[] = [];

    for (const file of layer3Files) {
      const content = fs.readFileSync(file, 'utf8');
      const imports = parseImports(content);
      const relFile = path.relative(SRC_ROOT, file);

      for (const imp of imports) {
        const resolved = path.normalize(
          path.join(path.dirname(file), imp.source).replace(/\.js$/, ''),
        );
        for (const l2 of LAYER_2_MODULE_NAMES) {
          const l2Path = path.normalize(path.join(SRC_ROOT, 'sync', l2));
          if (resolved === l2Path || resolved.startsWith(l2Path + path.sep)) {
            const allowed = ALLOWED_LAYER_2_SYMBOLS[l2] || new Set();
            for (const sym of imp.specifiers) {
              if (!allowed.has(sym)) {
                violations.push({
                  file: relFile,
                  module: l2,
                  symbol: sym,
                });
              }
            }
          }
        }
      }
    }

    expect(
      violations,
      `Unpermitted Layer 2 imports in Layer 3:\n` +
        violations
          .map((v) => `  ${v.file} imports '${v.symbol}' from Layer 2 '${v.module}'`)
          .join('\n'),
    ).toHaveLength(0);
  });

  it('Axis 3: Layer 3 intra-layer isolation - MCP tools do not import from CLI commands', () => {
    const mcpFiles = collectSourceFiles(path.join(SRC_ROOT, 'mcp'));
    const violations: { file: string; line: number; source: string }[] = [];

    for (const file of mcpFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const imports = parseImports(content);
      const relFile = path.relative(SRC_ROOT, file);

      for (const imp of imports) {
        if (imp.source.includes('/cli/commands/') || imp.source.endsWith('/cli/commands')) {
          violations.push({
            file: relFile,
            line: imp.line,
            source: imp.source,
          });
        }
      }
    }

    expect(
      violations,
      `MCP tools importing from CLI commands (Layer 3 intra-layer violation):\n` +
        violations.map((v) => `  ${v.file}:${v.line} -> ${v.source}`).join('\n'),
    ).toHaveLength(0);
  });
});
