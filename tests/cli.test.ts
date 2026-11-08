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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { program } from '../src/bin/emit.js';
import { formatPullStatusBreakdown, formatPullWindowLabel } from '../src/cli/commands/pull.js';
import { resolveInitPlan } from '../src/cli/commands/status.js';
import { initWorkspace } from '../src/utils/config.js';

describe('Emit CLI (Commander)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-cli-test-'));
    initWorkspace(tempDir, { origin: 'https://aroooy.net' });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('defines all required commands', () => {
    const commandNames = program.commands.map((c) => c.name());
    expect(commandNames).toContain('init');
    expect(commandNames).toContain('guide');
    expect(commandNames).toContain('new');
    expect(commandNames).toContain('status');
    expect(commandNames).toContain('diff');
    expect(commandNames).toContain('pull');
    expect(commandNames).toContain('push');
    expect(commandNames).toContain('mcp');
    expect(commandNames).toContain('profile');
  });

  it('diff command exposes --id and --profile options', () => {
    const diffCmd = program.commands.find((c) => c.name() === 'diff');
    expect(diffCmd).toBeDefined();
    const optionNames = diffCmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain('--id');
    expect(optionNames).toContain('--profile');
  });

  it('new command exposes --byline option', () => {
    const newCmd = program.commands.find((c) => c.name() === 'new');
    expect(newCmd).toBeDefined();
    const optionNames = newCmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain('--byline');
  });

  it('push command description mentions auto-uploading media/drafts/* images', () => {
    const pushCmd = program.commands.find((c) => c.name() === 'push');
    expect(pushCmd).toBeDefined();
    expect(pushCmd?.description()).toContain('media/drafts/*');
  });

  it('pull command enforces window concept without --limit or --all options', () => {
    const pullCmd = program.commands.find((c) => c.name() === 'pull');
    expect(pullCmd).toBeDefined();
    const optionNames = pullCmd?.options.map((o) => o.long || o.short) || [];
    expect(optionNames).not.toContain('--limit');
    expect(optionNames).not.toContain('-l');
    expect(optionNames).not.toContain('--all');
  });

  it('pull command exposes unified sync options (--posts-only, --media, --metadata-only)', () => {
    const pullCmd = program.commands.find((c) => c.name() === 'pull');
    expect(pullCmd).toBeDefined();
    const optionNames = pullCmd?.options.map((o) => o.long) || [];
    expect(optionNames).toContain('--posts-only');
    expect(optionNames).toContain('--media');
    expect(optionNames).toContain('--metadata-only');
  });

  it('executes emit guide cleanly', () => {
    const guideCmd = program.commands.find((c) => c.name() === 'guide');
    expect(guideCmd).toBeDefined();
  });

  it('resolveInitPlan inherits profile origin and enforces 3-guard auto-link rules', () => {
    const baseProfile = {
      name: 'aroooy.net',
      source: 'single' as const,
      config: {
        origin: 'https://aroooy.net',
        token: 'pat_123',
      },
    };

    // Default: inherits origin from profile and links workspace when unset
    expect(resolveInitPlan({}, baseProfile)).toEqual({
      effectiveOrigin: 'https://aroooy.net',
      shouldLinkProfile: true,
    });

    // Guard 1: --no-link (options.link === false) prevents linking
    expect(resolveInitPlan({ link: false }, baseProfile)).toEqual({
      effectiveOrigin: 'https://aroooy.net',
      shouldLinkProfile: false,
    });

    // Guard 2: profile already has a workspace configured -> do not overwrite
    expect(
      resolveInitPlan(
        {},
        {
          ...baseProfile,
          config: { ...baseProfile.config, workspace: '/existing/ws' },
        },
      ),
    ).toEqual({
      effectiveOrigin: 'https://aroooy.net',
      shouldLinkProfile: false,
    });

    // Guard 3: explicit --origin differs from resolved profile origin -> do not link to wrong profile
    expect(resolveInitPlan({ origin: 'https://other.example.com' }, baseProfile)).toEqual({
      effectiveOrigin: 'https://other.example.com',
      shouldLinkProfile: false,
    });

    // No profile resolved -> falls back to envOrigin and does not link
    expect(resolveInitPlan({}, null, 'https://env.example.com')).toEqual({
      effectiveOrigin: 'https://env.example.com',
      shouldLinkProfile: false,
    });
  });

  it('formats pull window label (N/status for all) and status breakdown accurately', () => {
    expect(formatPullWindowLabel('all', 100)).toBe('100/status');
    expect(formatPullWindowLabel('published', 100)).toBe('100');
    expect(formatPullWindowLabel('draft', 50)).toBe('50');

    const sampleItems = [
      { status: 'published' },
      { status: 'published' },
      { status: 'draft' },
      { status: 'published', deleted: true },
    ];
    expect(formatPullStatusBreakdown('all', sampleItems)).toBe(' [2 published, 1 draft]');
    expect(formatPullStatusBreakdown('published', sampleItems)).toBe('');
  });
});
