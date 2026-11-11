import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectUnsupportedMarkdownSyntax } from '../src/client/portable-text.js';
import {
  GUARD_REGISTRY,
  OPERATIONAL_ERROR_CODES,
  PROTECTION_ERROR_CODES,
} from '../src/sync/guards.js';
import { runPreflightChecks } from '../src/sync/preflight.js';

/**
 * Recursively scans directory for all .ts files, excluding specified paths.
 */
function getAllTsFiles(dir: string, excludeFiles: string[] = []): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllTsFiles(fullPath, excludeFiles));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      if (!excludeFiles.some((ex) => fullPath.endsWith(ex))) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

/**
 * Extracts all error code strings from TypeScript source code using 3 patterns:
 * 1. Object literal / call argument: `code: '...'`
 * 2. Ternary operator: `code: <cond> ? '...' : '...'`
 * 3. Class property declaration: `public (readonly )?code = '...'`
 */
function extractCodesFromSource(source: string): string[] {
  const codes: string[] = [];

  // Pattern 2: Ternary `code:\s*[^?,\n]+\?\s*'([A-Z0-9_]+)'\s*:\s*'([A-Z0-9_]+)'`
  const ternaryRegex = /code:\s*[^?,\n]+\?\s*'([A-Z0-9_]+)'\s*:\s*'([A-Z0-9_]+)'/g;
  let match: RegExpExecArray | null;
  while ((match = ternaryRegex.exec(source)) !== null) {
    codes.push(match[1], match[2]);
  }

  // Pattern 1: Simple literal `code:\s*'([A-Z0-9_]+)'` (matches code: 'FOO')
  const literalRegex = /code:\s*'([A-Z0-9_]+)'/g;
  while ((match = literalRegex.exec(source)) !== null) {
    codes.push(match[1]);
  }

  // Pattern 3: Class property `public\s+(?:readonly\s+)?code\s*=\s*'([A-Z0-9_]+)'`
  const classPropRegex = /public\s+(?:readonly\s+)?code\s*=\s*'([A-Z0-9_]+)'/g;
  while ((match = classPropRegex.exec(source)) !== null) {
    codes.push(match[1]);
  }

  return codes;
}

describe('Guard Registry and Error Codes Invariants (L6)', () => {
  const srcDir = path.resolve(__dirname, '../src');
  // Exclude guards.ts itself so we don't match the registry definition
  const tsFiles = getAllTsFiles(srcDir, ['src/sync/guards.ts']);

  const extractedCodes = new Set<string>();
  for (const file of tsFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const codes = extractCodesFromSource(content);
    for (const c of codes) {
      extractedCodes.add(c);
    }
  }

  const registeredCodes = new Set<string>();
  for (const guard of GUARD_REGISTRY) {
    for (const code of guard.codes) {
      registeredCodes.add(code);
    }
  }

  const operationalCodes = new Set<string>(OPERATIONAL_ERROR_CODES);
  const protectionCodes = new Set<string>(PROTECTION_ERROR_CODES);

  it('Rule 1: Inclusion check - all guard codes in registry must appear in src/', () => {
    for (const code of registeredCodes) {
      expect(
        extractedCodes.has(code),
        `Registry code '${code}' was not found in any src/ file`,
      ).toBe(true);
    }
  });

  it('Rule 2: Rogue code exclusion check - every error code in src/ must be classified', () => {
    const unclassifiedCodes: string[] = [];

    // Note: Node.js system error checks (e.g. err.code === 'EXDEV') are comparison expressions,
    // not error code emissions, and are therefore naturally excluded by the regex extraction patterns.
    for (const code of extractedCodes) {
      const isGuard = registeredCodes.has(code);
      const isOperational = operationalCodes.has(code);
      const isProtection = protectionCodes.has(code);

      if (!isGuard && !isOperational && !isProtection) {
        unclassifiedCodes.push(code);
      }
    }

    expect(
      unclassifiedCodes,
      `Unclassified error codes found in src/: ${unclassifiedCodes.join(', ')}`,
    ).toEqual([]);
  });

  it('Rule 3: Mutually exclusive and unique check within registry', () => {
    const seenCodes = new Set<string>();
    for (const guard of GUARD_REGISTRY) {
      for (const code of guard.codes) {
        expect(
          seenCodes.has(code),
          `Code '${code}' is assigned to multiple guards in GUARD_REGISTRY`,
        ).toBe(false);
        seenCodes.add(code);
      }
    }

    // G1..G19 IDs must be strictly sequential 1..19 without gaps
    const ids = GUARD_REGISTRY.map((g) => g.id);
    expect(ids).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
  });

  it('Rule 4: Behavior validation for code-less guards (G1, G7, G8, G11-label)', () => {
    const validUlid = '01M6ABCDEF1234567890123456';
    const filePath = `posts/draft/20261112_${validUlid}-test.md`;

    const baseFrontmatter = {
      id: validUlid,
      slug: 'test',
      title: 'Test Title',
      collection: 'posts',
      status: 'draft' as const,
      locale: 'ja',
      taxonomies: {},
      bylines: [],
    };

    // G1: SINGLE_TARGET_GUARD is invocation layer only.
    // Verify runPreflightChecks runs G2 through G11 and doesn't throw SINGLE_TARGET_GUARD
    const preflightResult = runPreflightChecks(filePath, {
      frontmatter: baseFrontmatter,
      body: 'Body without errors.',
      rawYaml: '',
    });
    expect(preflightResult.errors).toEqual([]);

    // G7: TITLE_DUPLICATION_AUTOTRIM mutates cleanedBody safely
    const titleDupResult = runPreflightChecks(filePath, {
      frontmatter: {
        ...baseFrontmatter,
        title: 'Duplicate Title',
      },
      body: '# Duplicate Title\n\nBody content.',
      rawYaml: '',
    });
    expect(titleDupResult.cleanedBody).toBe('\nBody content.');
    expect(titleDupResult.warnings).toContain(
      "Duplicate top-level heading matching title ('# Duplicate Title') was automatically trimmed from body.",
    );

    // G8: UNSUPPORTED_SYNTAX_WARNING produces warnings array for tables / raw HTML / tilde fences
    const unsupportedWarnings = detectUnsupportedMarkdownSyntax(
      '| Col1 | Col2 |\n|---|---|\n| Val1 | Val2 |',
    );
    expect(unsupportedWarnings.length).toBeGreaterThan(0);

    // G11 label: [LOCAL_IMAGE_AUTO_UPLOAD] prefix exists in push.ts
    const pushSource = fs.readFileSync(path.resolve(srcDir, 'sync/push.ts'), 'utf-8');
    expect(pushSource.includes('[LOCAL_IMAGE_AUTO_UPLOAD]')).toBe(true);
  });
});
