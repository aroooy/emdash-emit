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

import { ApiError } from '../client/error.js';
import { CanonicalHasUnpushedEditsError, QuarantinedPathRequiredError } from '../sync/conflicts.js';

/**
 * Single CLI failure presentation: ensures a leading `❌` line, optional `💡 Suggestion`, and exit code 1,
 * without duplicating `❌` on errors whose message already starts with `❌`.
 */
export function reportActionFailure(error: unknown): never {
  if (error instanceof ApiError) {
    console.error(error.toActionableString());
  } else if (error instanceof CanonicalHasUnpushedEditsError) {
    console.error(`❌ ${error.message}`);
    console.error(`💡 Suggestion: ${error.suggestion}`);
  } else if (error instanceof QuarantinedPathRequiredError) {
    console.error(`❌ Error: [${error.code}] ${error.message}`);
    console.error(`💡 Suggestion: ${error.suggestion}`);
  } else if (error instanceof Error) {
    const msg = error.message;
    console.error(msg.trimStart().startsWith('❌') ? msg : `❌ Error: ${msg}`);
  } else {
    const raw = String(error);
    console.error(raw.trimStart().startsWith('❌') ? raw : `❌ Error: ${raw}`);
  }
  process.exit(1);
}
