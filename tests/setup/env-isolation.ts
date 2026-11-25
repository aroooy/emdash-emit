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
import { vi } from 'vitest';

/**
 * Test hermeticity: Emit reads `EMDASH_ORIGIN`, `EMDASH_WORKSPACE`, `EMDASH_TOKEN` and
 * `EMDASH_API_TOKEN` from the environment, and those values participate in origin/workspace
 * resolution (see `resolveOriginPriority` and `resolveAuth`). A developer who happens to export
 * one of them would otherwise change how profiles resolve inside the suite, producing failures
 * that cannot be reproduced on another machine.
 *
 * Every test file therefore starts from a scrubbed environment; tests that need an env value set
 * it explicitly and restore it themselves.
 */
export const SCRUBBED_ENV_KEYS = [
  'EMDASH_ORIGIN',
  'EMDASH_WORKSPACE',
  'EMDASH_TOKEN',
  'EMDASH_API_TOKEN',
] as const;

for (const key of SCRUBBED_ENV_KEYS) {
  delete process.env[key];
}

/**
 * Home-directory isolation: profile/auth/heartbeat resolution (`loadProfilesFile`, `resolveAuth`,
 * `getMcpStateFilePath`) falls back to `~/.config/emit/profiles.yaml` / `credentials.json` /
 * `mcp_state.json` under the machine home. On a developer workstation that ambient file silently
 * decides outcomes which CI (a clean environment) can never reproduce — exactly the class of
 * failure v0.1.62 fixes. Pinning `process.env.HOME` plus `os.homedir()` to a throwaway directory
 * for every worker structurally blocks that fallback, mirroring what individual tests such as
 * `cli.test.ts` already do locally.
 *
 * Two subtleties (v0.1.38 lesson):
 * - `os.homedir()` does NOT reliably follow `process.env.HOME`, so both are pinned.
 * - Tests that deliberately exercise HOME/profiles paths create their own throwaway home in
 *   `beforeEach` and restore it afterwards, which outranks this baseline (later assignment wins).
 */
const HERMETIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-test-hermetic-home-'));
process.env.HOME = HERMETIC_HOME;
// Windows resolution reads USERPROFILE as its first tier — scrub it so the real profile cannot leak.
delete process.env.USERPROFILE;
vi.spyOn(os, 'homedir').mockReturnValue(HERMETIC_HOME);
