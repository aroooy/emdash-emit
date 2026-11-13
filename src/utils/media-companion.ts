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

/**
 * Recovers a storageKey from a media record's metadata map or companion YAML document.
 *
 * EmDash media records have two identifier spaces: the D1 primary key (`id`) and the R2 object key
 * (`storageKey`). Modern companions record both fields explicitly, but older mirrors — or records
 * written before Emit persisted the field — carry no `storageKey:` key at all, yet their `url:` is the
 * canonical `/_emdash/api/media/file/<storageKey>` route, which is confirmed metadata written from the
 * server response and not an inference from a body reference. Absolute and root-relative forms are both
 * accepted because either can appear depending on how the record was mirrored. `legacy_*` residue is
 * never read here: it backs no real record, so it must not serve as verification evidence.
 */
export function storageKeyFromMediaMeta(doc: Record<string, unknown>): string | undefined {
  if (typeof doc.storageKey === 'string' && doc.storageKey.trim()) {
    return doc.storageKey.trim();
  }
  if (typeof doc.url !== 'string' || !doc.url.trim()) return undefined;
  const match = doc.url.match(/(?:^|\/)media\/file\/([^?#]+)/);
  return match ? match[1] : undefined;
}
