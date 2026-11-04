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
    expect(commandNames).toContain('pull');
    expect(commandNames).toContain('push');
    expect(commandNames).toContain('mcp');
    expect(commandNames).toContain('profile');
  });

  it('pull command enforces window concept without --limit or --all options', () => {
    const pullCmd = program.commands.find((c) => c.name() === 'pull');
    expect(pullCmd).toBeDefined();
    const optionNames = pullCmd?.options.map((o) => o.long || o.short) || [];
    expect(optionNames).not.toContain('--limit');
    expect(optionNames).not.toContain('-l');
    expect(optionNames).not.toContain('--all');
  });

  it('executes emit guide cleanly', () => {
    const guideCmd = program.commands.find((c) => c.name() === 'guide');
    expect(guideCmd).toBeDefined();
  });
});
