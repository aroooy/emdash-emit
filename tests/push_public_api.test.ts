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
import * as pushModule from '../src/sync/push.js';
import type {
  PushOptions,
  PushResult,
  TaxonomyResolutionStrategy,
  ResolvedTaxonomyItem,
} from '../src/sync/push.js';

describe('src/sync/push Public API Contracts', () => {
  it('exports exact public API runtime symbols', () => {
    const exportedKeys = Object.keys(pushModule).sort();

    // Runtime values exported by push
    expect(exportedKeys).toEqual(['PushValidationError', 'pushArticle']);

    expect(typeof pushModule.pushArticle).toBe('function');
    expect(typeof pushModule.PushValidationError).toBe('function');
  });

  it('preserves public TypeScript types contract', () => {
    // Compile-time type check assertions: ensure types can be referenced and assigned
    const _strategy: TaxonomyResolutionStrategy = 'union';
    expect(_strategy).toBe('union');

    const _resolvedItem: ResolvedTaxonomyItem = {
      input: 'tag-1',
      resolved: 'tag-1',
    };
    expect(_resolvedItem.input).toBe('tag-1');

    type TestOptionsCheck = PushOptions['workspaceRoot'];
    const _wsRoot: TestOptionsCheck = '/tmp';
    expect(_wsRoot).toBe('/tmp');

    type TestResultCheck = PushResult['success'];
    const _success: TestResultCheck = true;
    expect(_success).toBe(true);
  });
});
