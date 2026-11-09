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
import { unwrapEnvelope, unwrapItem, extractRev, normalizeRev } from '../src/client/api.js';

describe('api unwrap utils', () => {
  it('unwraps data envelope when wrapped in { data: ... }', () => {
    const raw = { success: true, data: { id: '123', title: 'Hello' } };
    expect(unwrapEnvelope(raw)).toEqual({ id: '123', title: 'Hello' });
  });

  it('unwraps data envelope when raw is already unwrapped', () => {
    const raw = { id: '123', title: 'Hello' };
    expect(unwrapEnvelope(raw)).toEqual({ id: '123', title: 'Hello' });
  });

  it('unwraps nested item in { data: { item: ... } }', () => {
    const raw = { data: { item: { id: 'abc', title: 'Nested' } } };
    expect(unwrapItem(raw)).toEqual({ id: 'abc', title: 'Nested' });
  });

  it('unwraps nested item in { item: ... }', () => {
    const raw = { item: { id: 'abc', title: 'Direct Item' } };
    expect(unwrapItem(raw)).toEqual({ id: 'abc', title: 'Direct Item' });
  });

  it('extracts rev prioritizing data._rev over item._rev or version', () => {
    const responseWithBoth = {
      data: {
        _rev: 'rev-data-top',
        item: { _rev: 'rev-item-sub', version: 'v1' },
      },
    };
    expect(extractRev(responseWithBoth)).toBe('rev-item-sub'); // item._rev is checked on the item itself first

    const responseWithDataOnly = {
      data: {
        _rev: 'rev-data-top',
        item: { id: '123' },
      },
    };
    expect(extractRev(responseWithDataOnly)).toBe('rev-data-top');

    const responseWithFallback = {
      data: {
        item: { id: '123', version: '42' },
      },
    };
    expect(extractRev(responseWithFallback)).toBe('42');
  });

  it('normalizes rev tokens (pure number, base64 encoded, colon delimited)', () => {
    expect(normalizeRev('1')).toBe('1');
    expect(normalizeRev(5)).toBe('5');
    expect(normalizeRev('1:2026-10-31T00:16:28.950Z')).toBe('1');
    // "1:2026-10-31T00:16:28.950Z" in Base64 is "MToyMDI2LTEwLTMxVDAwOjE2OjI4Ljk1MFo="
    expect(normalizeRev('MToyMDI2LTEwLTMxVDAwOjE2OjI4Ljk1MFo=')).toBe('1');
    // "5:2026-11-09T08:00:00.000Z" in Base64
    const b64Rev5 = Buffer.from('5:2026-11-09T08:00:00.000Z').toString('base64');
    expect(normalizeRev(b64Rev5)).toBe('5');
    // Opaque fallback
    expect(normalizeRev('custom-opaque-rev')).toBe('custom-opaque-rev');
    expect(normalizeRev(null)).toBe('1');
    expect(normalizeRev('')).toBe('1');
  });
});
