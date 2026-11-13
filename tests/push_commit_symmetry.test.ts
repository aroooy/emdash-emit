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
import { pendingFlagsFor } from '../src/sync/push/commit.js';

describe('pendingFlagsFor Commit Symmetry and NULL Rules (B2b)', () => {
  it('mode: create sets all conflict flags to 0 and conflictCopy fields to null', () => {
    const normal = pendingFlagsFor({
      mode: 'create',
      remoteTaxonomyHash: 'hash-abc',
    });

    expect(normal).toEqual({
      conflictPending: 0,
      bodyConflictPending: 0,
      taxonomyConflictPending: 0,
      conflictCopyHash: null,
      conflictCopyPath: null,
      conflictAt: null,
      taxonomyApplyPending: 0,
      remoteTaxonomyHash: 'hash-abc',
    });

    const withTaxFailures = pendingFlagsFor({
      mode: 'create',
      hasTaxFailures: true,
      remoteTaxonomyHash: 'hash-abc',
    });

    expect(withTaxFailures).toEqual({
      conflictPending: 0,
      bodyConflictPending: 0,
      taxonomyConflictPending: 0,
      conflictCopyHash: null,
      conflictCopyPath: null,
      conflictAt: null,
      taxonomyApplyPending: 1,
      remoteTaxonomyHash: null, // Tax failures on create clears remote tax hash
    });
  });

  it('mode: update clears conflict flags on success and preserves them on tax failures', () => {
    const normal = pendingFlagsFor({
      mode: 'update',
      syncState: {
        id: '01TEST',
        localFilePath: 'posts/draft/test.md',
        localHash: 'hash',
        remoteRev: '1',
        status: 'draft',
        slug: 'test',
        lastSyncedAt: 1000,
        conflictPending: 1,
        bodyConflictPending: 1,
        taxonomyConflictPending: 0,
        conflictCopyHash: 'copy-hash',
        conflictCopyPath: 'posts/conflicts/test.conflict.md',
        conflictAt: 1000,
        taxonomyApplyPending: 1,
        remoteTaxonomyHash: 'old-tax-hash',
      },
      hasTaxFailures: false,
      remoteTaxonomyHash: 'new-tax-hash',
    });

    expect(normal).toEqual({
      conflictPending: 0,
      bodyConflictPending: 0,
      taxonomyConflictPending: 0,
      conflictCopyHash: null,
      conflictCopyPath: null,
      conflictAt: null,
      taxonomyApplyPending: 0,
      remoteTaxonomyHash: 'new-tax-hash',
    });

    const withTaxFailures = pendingFlagsFor({
      mode: 'update',
      syncState: {
        id: '01TEST',
        localFilePath: 'posts/draft/test.md',
        localHash: 'hash',
        remoteRev: '1',
        status: 'draft',
        slug: 'test',
        lastSyncedAt: 1000,
        conflictPending: 1,
        bodyConflictPending: 1,
        taxonomyConflictPending: 0,
        conflictCopyHash: 'copy-hash',
        conflictCopyPath: 'posts/conflicts/test.conflict.md',
        conflictAt: 1000,
        taxonomyApplyPending: 0,
        remoteTaxonomyHash: 'old-tax-hash',
      },
      hasTaxFailures: true,
      remoteTaxonomyHash: 'old-tax-hash',
    });

    expect(withTaxFailures).toEqual({
      conflictPending: 1,
      bodyConflictPending: 1,
      taxonomyConflictPending: 0,
      conflictCopyHash: 'copy-hash',
      conflictCopyPath: 'posts/conflicts/test.conflict.md',
      conflictAt: 1000,
      taxonomyApplyPending: 1,
      remoteTaxonomyHash: 'old-tax-hash',
    });
  });

  it('mode: conflict enforces strict NULL rules and taxonomyApplyPending: 0 invariant', () => {
    // Body conflict: creates quarantine copy
    const bodyConflict = pendingFlagsFor({
      mode: 'conflict',
      hasBodyConflict: true,
      isTaxonomyConflict: false,
      conflictedHash: 'body-copy-hash',
      quarantineRelPath: 'posts/conflicts/test.conflict.md',
      remoteTaxonomyHash: 'tax-hash',
    });

    expect(bodyConflict.conflictPending).toBe(1);
    expect(bodyConflict.bodyConflictPending).toBe(1);
    expect(bodyConflict.taxonomyConflictPending).toBe(0);
    expect(bodyConflict.conflictCopyHash).toBe('body-copy-hash');
    expect(bodyConflict.conflictCopyPath).toBe('posts/conflicts/test.conflict.md');
    expect(typeof bodyConflict.conflictAt).toBe('number');
    expect(bodyConflict.taxonomyApplyPending).toBe(0); // Invariant line 1386
    expect(bodyConflict.remoteTaxonomyHash).toBe('tax-hash');

    // Taxonomy-only conflict: no quarantine copy created -> strict null
    const taxOnlyConflict = pendingFlagsFor({
      mode: 'conflict',
      hasBodyConflict: false,
      isTaxonomyConflict: true,
      conflictedHash: null,
      quarantineRelPath: null,
      remoteTaxonomyHash: 'tax-hash',
    });

    expect(taxOnlyConflict.conflictPending).toBe(1);
    expect(taxOnlyConflict.bodyConflictPending).toBe(0);
    expect(taxOnlyConflict.taxonomyConflictPending).toBe(1);
    expect(taxOnlyConflict.conflictCopyHash).toBeNull();
    expect(taxOnlyConflict.conflictCopyPath).toBeNull();
    expect(taxOnlyConflict.conflictAt).toBeNull();
    expect(taxOnlyConflict.taxonomyApplyPending).toBe(0);
    expect(taxOnlyConflict.remoteTaxonomyHash).toBe('tax-hash');
  });
});
