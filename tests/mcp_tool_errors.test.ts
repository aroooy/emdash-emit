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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CacheDatabase } from '../src/db/cache.js';
import { ApiError } from '../src/client/error.js';
import { SyncPruneConflictError } from '../src/sync/orchestrator.js';
import { PushValidationError } from '../src/sync/push.js';
import { AmbiguousProfileError, setProfile } from '../src/utils/profile.js';
import { createMcpServer } from '../src/mcp/server.js';
import { formatToolError } from '../src/mcp/tool-errors.js';

/**
 * MCP tools must hand AI agents the same structured diagnostics the CLI prints. Without
 * `formatToolError`, the MCP SDK collapses a thrown error into `String(error)` and silently drops
 * the `[CODE]`, HTTP status, endpoint, and suggestion lines carried by `ApiError.toActionableString()`
 * and `PushValidationError.errors`.
 */
describe('MCP Tool Error Formatting', () => {
  let tempDir: string;
  let cache: CacheDatabase;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-tool-error-test-'));
    cache = new CacheDatabase(path.join(tempDir, '.emit', 'cache.db'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const textOf = (result: CallToolResult): string =>
    result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');

  it('renders ApiError with code, status, endpoint, and suggestion', () => {
    const result = formatToolError(
      new ApiError({
        message: 'Article not found',
        code: 'NOT_FOUND',
        status: 404,
        endpoint: 'https://example.com/_emdash/api/content/posts/01M6ABCDEF1234567890123456',
        suggestion: 'Pull it first: emit pull <ULID>',
      }),
    );

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('❌ [NOT_FOUND] Article not found');
    expect(text).toContain('Status: HTTP 404');
    expect(text).toContain('Endpoint: https://example.com/_emdash/api/content/posts/');
    expect(text).toContain('💡 Suggestion: Pull it first: emit pull <ULID>');
  });

  it('renders PushValidationError as structured JSON including preflight codes', () => {
    const result = formatToolError(
      new PushValidationError('Refusing to push a preserved rescue copy.', [
        {
          code: 'QUARANTINED_COPY_NOT_PUSHABLE',
          message: 'posts/conflicts/x.conflict.md is a preserved rescue copy.',
          suggestion: 'Merge the valuable lines into the canonical article file.',
        },
      ]),
    );

    expect(result.isError).toBe(true);
    const payload = JSON.parse(textOf(result));
    expect(payload.error).toBe('PREFLIGHT_VALIDATION_FAILED');
    expect(payload.errors[0].code).toBe('QUARANTINED_COPY_NOT_PUSHABLE');
    expect(payload.errors[0].suggestion).toContain('canonical article');
  });

  it('renders SyncPruneConflictError and AmbiguousProfileError with their human messages', () => {
    const prune = formatToolError(
      new SyncPruneConflictError(
        'Pull aborted: 1 article has unpushed local modifications.',
        [{ id: '01M6ABCDEF1234567890123456', slug: 'post', filePath: 'posts/draft/x.md' }],
        100,
      ),
    );
    expect(prune.isError).toBe(true);
    expect(textOf(prune)).toContain('❌ Pull aborted: 1 article has unpushed local modifications.');

    const ambiguous = formatToolError(new AmbiguousProfileError(['aroooy', 'staging']));
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toContain('Multiple profiles are configured (aroooy, staging)');
  });

  it('falls back to a readable message for plain errors and non-Error throws', () => {
    expect(textOf(formatToolError(new Error('boom')))).toBe('❌ boom');
    expect(textOf(formatToolError('raw string failure'))).toBe('❌ raw string failure');
    expect(textOf(formatToolError(undefined))).toBe('❌ undefined');
  });

  it('surfaces a structured preflight error through the real sync_push tool handler', async () => {
    // A rescue copy placed exactly where quarantine writes it: the push must be refused before a
    // single network request, so no fetch stub is needed for this assertion.
    const conflictRel = 'posts/conflicts/20190405_01M67N0TNFS6F3PJX4T96NKPKT-Old.conflict.md';
    const conflictFull = path.join(tempDir, conflictRel);
    fs.mkdirSync(path.dirname(conflictFull), { recursive: true });
    fs.writeFileSync(
      conflictFull,
      [
        '---',
        'id: 01M67N0TNFS6F3PJX4T96NKPKT',
        'title: "Old"',
        'status: published',
        '---',
        '',
        'STALE RESCUE CONTENT.',
      ].join('\n'),
      'utf8',
    );

    // Deterministic credentials: env wins over the developer's own profiles.yaml.
    const origToken = process.env.EMDASH_TOKEN;
    const origOrigin = process.env.EMDASH_ORIGIN;
    process.env.EMDASH_TOKEN = 'tool-error-test-token';
    process.env.EMDASH_ORIGIN = 'https://example.com';
    try {
      const server = createMcpServer({ workspaceRoot: tempDir, cache });
      const registered = handlersOf(server);

      const result = await registered['sync_push'].handler({ filePath: conflictRel });

      expect(result.isError).toBe(true);
      const payload = JSON.parse(textOf(result));
      expect(payload.error).toBe('PREFLIGHT_VALIDATION_FAILED');
      expect(payload.errors[0].code).toBe('QUARANTINED_COPY_NOT_PUSHABLE');
      // The rescue copy itself is untouched.
      expect(fs.readFileSync(conflictFull, 'utf8')).toContain('STALE RESCUE CONTENT.');
    } finally {
      if (origToken) process.env.EMDASH_TOKEN = origToken;
      else delete process.env.EMDASH_TOKEN;
      if (origOrigin) process.env.EMDASH_ORIGIN = origOrigin;
      else delete process.env.EMDASH_ORIGIN;
    }
  });

  /**
   * `McpServer._registeredTools` holds `RegisteredTool` objects (callable, with a `.handler`
   * property). The helper keeps the private-field cast in one place so each test can invoke a tool
   * exactly as the SDK does, without duplicating the unsafe cast.
   */
  const handlersOf = (
    server: unknown,
  ): Record<
    string,
    {
      handler: (args: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>;
      description?: string;
    }
  > =>
    (
      server as {
        _registeredTools: Record<
          string,
          {
            handler: (args: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>;
            description?: string;
          }
        >;
      }
    )._registeredTools;

  /**
   * Workspace/profile resolution runs before any I/O in every sync tool. When it fails, agents must
   * still receive a formatted `isError` result instead of a raw throw that the MCP SDK collapses
   * into an opaque one-liner. A stray EMDASH_TOKEN would short-circuit profile resolution, so the
   * env tiers are cleared to keep this deterministic on any machine.
   */
  it('routes ambiguous profile resolution through formatToolError in every context tool', async () => {
    const profilesPath = path.join(tempDir, 'profiles.yaml');
    setProfile(
      'alpha-site',
      { origin: 'https://alpha.example.com', token: 'tok-alpha' },
      false,
      profilesPath,
    );
    setProfile(
      'beta-site',
      { origin: 'https://beta.example.com', token: 'tok-beta' },
      false,
      profilesPath,
    );

    const savedEnv: Record<string, string | undefined> = {
      EMDASH_TOKEN: process.env.EMDASH_TOKEN,
      EMDASH_API_TOKEN: process.env.EMDASH_API_TOKEN,
    };
    delete process.env.EMDASH_TOKEN;
    delete process.env.EMDASH_API_TOKEN;

    try {
      const registered = handlersOf(
        createMcpServer({ workspaceRoot: tempDir, cache, profilesPath }),
      );

      const cases: Array<[string, Record<string, unknown>]> = [
        ['sync_status', {}],
        ['sync_pull', {}],
        ['sync_push', { filePath: 'posts/draft/20261108_01M6ABCDEF1234567890123456-post.md' }],
        ['sync_diff', { id: '01M6ABCDEF1234567890123456' }],
        ['sync_new', { slug: 'ambiguity-probe' }],
      ];

      for (const [toolName, args] of cases) {
        let result: CallToolResult;
        try {
          result = await registered[toolName].handler(args);
        } catch (err) {
          throw new Error(
            `${toolName} must return a formatted error result instead of throwing (${String(err)})`,
          );
        }
        expect(result.isError, toolName).toBe(true);
        expect(textOf(result), toolName).toContain('Multiple site profiles exist');
        expect(textOf(result), toolName).toContain('alpha-site');
        expect(textOf(result), toolName).toContain('beta-site');
      }

      // Failed calls must not leave partial artifacts behind.
      expect(fs.existsSync(path.join(tempDir, 'posts'))).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value) process.env[key] = value;
        else delete process.env[key];
      }
    }
  });

  it('honors profilesPath in profile tools and marks profile failures as tool errors', async () => {
    const profilesPath = path.join(tempDir, 'profiles-solo.yaml');
    setProfile(
      'solo-site',
      { origin: 'https://solo.example.com', token: 'tok-solo' },
      true,
      profilesPath,
    );

    const registered = handlersOf(createMcpServer({ workspaceRoot: tempDir, cache, profilesPath }));

    // profile_list must report exactly the profiles the sync tools can actually resolve, never the
    // machine-level ~/.config/emit/profiles.yaml.
    const listed = await registered['profile_list'].handler({});
    expect(listed.isError).toBeUndefined();
    const payload = JSON.parse(textOf(listed));
    expect(payload.activeProfile).toBe('solo-site');
    expect(payload.profiles.map((p: { name: string }) => p.name)).toEqual(['solo-site']);

    const missing = await registered['profile_switch'].handler({ name: 'typo-site' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('Profile "typo-site" not found');
    expect(textOf(missing)).toContain('solo-site');

    const switched = await registered['profile_switch'].handler({ name: 'solo-site' });
    expect(switched.isError).toBeUndefined();
    expect(textOf(switched)).toContain('Switched active profile to "solo-site"');

    // Without persist, nothing is rewritten on disk.
    expect(fs.readFileSync(profilesPath, 'utf8')).toContain('solo-site');
  });

  it('surfaces FrontmatterParseError as a structured MCP tool error on sync_push with invalid frontmatter', async () => {
    const invalidRel = 'posts/draft/20261108_01M6TESTPARSEERR000000000-Invalid.md';
    const invalidFull = path.join(tempDir, invalidRel);
    fs.mkdirSync(path.dirname(invalidFull), { recursive: true });
    fs.writeFileSync(
      invalidFull,
      [
        '---',
        'id: 01M6TESTPARSEERR000000000',
        'slug: invalid-test',
        'title: "Invalid Test"',
        'status: draft',
        'taxonomies:',
        '  categories:',
        '    - %e6%9c%aa%e5%88%86%e9%a1%9e', // unquoted % scalar causes YAMLException
        '---',
        '',
        'Body content with unquoted % in frontmatter.',
      ].join('\n'),
      'utf8',
    );

    const origToken = process.env.EMDASH_TOKEN;
    const origOrigin = process.env.EMDASH_ORIGIN;
    try {
      process.env.EMDASH_TOKEN = 'mock-pat';
      process.env.EMDASH_ORIGIN = 'https://mock.example.com';

      const registered = handlersOf(createMcpServer({ workspaceRoot: tempDir, cache }));
      const result = await registered['sync_push'].handler({ filePath: invalidRel });

      expect(result.isError).toBe(true);
      const payload = JSON.parse(textOf(result));
      expect(payload.error).toBe('FRONTMATTER_PARSE_ERROR');
      expect(payload.filePath).toBe(invalidRel);
      expect(payload.reason).toContain('bad indentation');
      expect(payload.suggestion).toContain('Quote strings starting with "%"');
    } finally {
      if (origToken) process.env.EMDASH_TOKEN = origToken;
      else delete process.env.EMDASH_TOKEN;
      if (origOrigin) process.env.EMDASH_ORIGIN = origOrigin;
      else delete process.env.EMDASH_ORIGIN;
    }
  });
});
