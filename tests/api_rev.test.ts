import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  extractRev,
  extractComparisonRev,
  isSameRev,
  formatRevForDisplay,
} from '../src/client/api.js';
import { tryDecodeTaxonomyTerm } from '../src/utils/frontmatter.js';
import { CacheDatabase } from '../src/db/cache.js';

describe('Revision comparison & formatting (v0.1.22 Layer 0)', () => {
  describe('extractRev', () => {
    it('prioritizes envelope data._rev over item.version when root envelope is passed', () => {
      const response = {
        success: true,
        data: {
          item: {
            id: '01M7BZH06K515A5NQWZ36QK7NQ',
            version: 14,
            status: 'published',
          },
          _rev: 'MTQ6MjAyNi0xMS0yNlQwODowMDowMFo=',
        },
      };

      expect(extractRev(response)).toBe('MTQ6MjAyNi0xMS0yNlQwODowMDowMFo=');
    });
  });

  describe('extractComparisonRev', () => {
    it('prioritizes draftRevisionId for draft articles', () => {
      const response = {
        data: {
          item: {
            id: '01M7BZH06K515A5NQWZ36QK7NQ',
            version: 3,
            draftRevisionId: '01M7C7GRKQK8N2KTAJNXXMVPG3',
            liveRevisionId: null,
            status: 'draft',
          },
          _rev: 'MzoyMDI2LTExLTE0VDAyOjUyOjI5Ljc3OVo=',
        },
      };

      const comparisonRev = extractComparisonRev(response);
      expect(comparisonRev).toBe('3@draft:01M7C7GRKQK8N2KTAJNXXMVPG3');
    });

    it('uses liveRevisionId when draftRevisionId is absent', () => {
      const response = {
        item: {
          id: '01M7BZH06K515A5NQWZ36QK7NQ',
          version: 2,
          liveRevisionId: '01M6LIVE000000000000000000',
          status: 'published',
        },
      };

      const comparisonRev = extractComparisonRev(response);
      expect(comparisonRev).toBe('2@live:01M6LIVE000000000000000000');
    });

    it('falls back to extractRev raw token when revision IDs are missing', () => {
      const response = {
        data: {
          item: { id: '123', version: 5 },
          _rev: 'custom-b64-rev',
        },
      };

      const comparisonRev = extractComparisonRev(response);
      expect(comparisonRev).toBe('custom-b64-rev');
    });

    it('works directly on flat list API items', () => {
      const listItem = {
        id: '01M7BZH06K515A5NQWZ36QK7NQ',
        version: 3,
        draftRevisionId: '01M7C7GRKQK8N2KTAJNXXMVPG3',
      };

      expect(extractComparisonRev(listItem)).toBe('3@draft:01M7C7GRKQK8N2KTAJNXXMVPG3');
    });

    it('recovers version from _rev colon-delimited or Base64 token when item.version is absent', () => {
      // 1. colon-delimited token
      const itemWithColonRev = {
        id: '01M7BZH06K515A5NQWZ36QK7NQ',
        _rev: '4:2026-11-20T10:00:00.000Z',
        liveRevisionId: '01M6LIVE000000000000000000',
      };
      expect(extractComparisonRev(itemWithColonRev)).toBe('4@live:01M6LIVE000000000000000000');

      // 2. Base64 encoded token
      const b64Rev = Buffer.from('5:2026-11-20T11:00:00.000Z').toString('base64');
      const itemWithB64Rev = {
        id: '01M7BZH06K515A5NQWZ36QK7NQ',
        _rev: b64Rev,
        draftRevisionId: '01M7C7GRKQK8N2KTAJNXXMVPG3',
      };
      expect(extractComparisonRev(itemWithB64Rev)).toBe('5@draft:01M7C7GRKQK8N2KTAJNXXMVPG3');
    });

    it('does not misidentify non-version tokens, ULIDs, or random strings as version numbers', () => {
      const ulidItem = {
        id: '01M7BZH06K515A5NQWZ36QK7NQ',
        _rev: '01M7BZH06K515A5NQWZ36QK7NQ',
        liveRevisionId: '01M6LIVE000000000000000000',
      };
      expect(extractComparisonRev(ulidItem)).toBe('1@live:01M6LIVE000000000000000000');

      const randomStrItem = {
        id: '01M7BZH06K515A5NQWZ36QK7NQ',
        _rev: 'abc',
        liveRevisionId: '01M6LIVE000000000000000000',
      };
      expect(extractComparisonRev(randomStrItem)).toBe('1@live:01M6LIVE000000000000000000');
    });
  });

  describe('isSameRev', () => {
    it('returns true on exact string match', () => {
      expect(
        isSameRev('3@draft:01M7C7GRKQK8N2KTAJNXXMVPG3', '3@draft:01M7C7GRKQK8N2KTAJNXXMVPG3'),
      ).toBe(true);
      expect(isSameRev('1', '1')).toBe(true);
    });

    it('returns false when composite draft revision ULIDs differ (draft edited on server)', () => {
      const oldRev = '3@draft:01M7C7GRKQK8N2KTAJNXXMVPG3';
      const newRev = '3@draft:01M7NEWREV0000000000000000';
      expect(isSameRev(oldRev, newRev)).toBe(false);
    });

    it('returns false when comparing legacy pure numeric rev with composite rev (triggers migration)', () => {
      expect(isSameRev('3', '3@draft:01M7C7GRKQK8N2KTAJNXXMVPG3')).toBe(false);
      expect(isSameRev('3@draft:01M7C7GRKQK8N2KTAJNXXMVPG3', '3')).toBe(false);
    });

    it('strictly compares Base64 tokens with decoded timestamp verification', () => {
      const b64A = Buffer.from('3:2026-11-14T02:52:29.779Z').toString('base64');
      const b64B = Buffer.from('3:2026-11-14T02:52:29.779Z').toString('base64');
      const b64DifferentTimestamp = Buffer.from('3:2026-11-14T14:12:00.000Z').toString('base64');

      expect(isSameRev(b64A, b64B)).toBe(true);
      expect(isSameRev(b64A, b64DifferentTimestamp)).toBe(false);
    });

    it('handles legacy numeric normalization when both are non-composite scalars', () => {
      expect(isSameRev('1', '1')).toBe(true);
      expect(isSameRev('1', '2')).toBe(false);
      expect(isSameRev(null, '1')).toBe(false);
    });
  });

  describe('formatRevForDisplay', () => {
    it('truncates composite revs to version number for clean UX', () => {
      expect(formatRevForDisplay('3@draft:01M7C7GRKQK8N2KTAJNXXMVPG3')).toBe('3');
      expect(formatRevForDisplay('12@live:01M6LIVE000000000000000000')).toBe('12');
    });

    it('formats pure numeric and Base64 tokens using normalizeRev', () => {
      expect(formatRevForDisplay('5')).toBe('5');
      const b64 = Buffer.from('4:2026-11-14T00:00:00.000Z').toString('base64');
      expect(formatRevForDisplay(b64)).toBe('4');
      expect(formatRevForDisplay(null)).toBe('');
    });
  });

  describe('tryDecodeTaxonomyTerm with NFC normalization (S1)', () => {
    it('normalizes NFD combined characters to NFC upon decoding', () => {
      // "が" in NFD is 'か' (U+304B) + combining dakuten '゛' (U+3099)
      const nfdGa = '\u304B\u3099';
      const encodedNfd = encodeURIComponent(nfdGa);

      const decoded = tryDecodeTaxonomyTerm(encodedNfd);
      // Expect NFC "が" (U+304C)
      expect(decoded).toBe('\u304C');
      expect(decoded.length).toBe(1);
    });
  });

  describe('CacheDatabase.runTransaction (W2)', () => {
    let tmpDir: string;
    let cache: CacheDatabase;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-tx-test-'));
      cache = new CacheDatabase(path.join(tmpDir, 'cache.db'));
    });

    afterEach(() => {
      cache.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('commits changes when callback succeeds', () => {
      cache.runTransaction(() => {
        cache.saveSyncState({
          id: '01M7TXTEST0000000000000001',
          localFilePath: 'posts/draft/test.md',
          localHash: 'hash1',
          remoteRev: '1',
          status: 'draft',
          slug: 'test',
          lastSyncedAt: 1000,
        });
      });

      const saved = cache.getSyncState('01M7TXTEST0000000000000001');
      expect(saved).not.toBeNull();
      expect(saved?.slug).toBe('test');
    });

    it('rolls back changes when callback throws', () => {
      expect(() => {
        cache.runTransaction(() => {
          cache.saveSyncState({
            id: '01M7TXTEST0000000000000002',
            localFilePath: 'posts/draft/test2.md',
            localHash: 'hash2',
            remoteRev: '1',
            status: 'draft',
            slug: 'test2',
            lastSyncedAt: 1000,
          });
          throw new Error('Transaction failure simulation');
        });
      }).toThrow('Transaction failure simulation');

      const saved = cache.getSyncState('01M7TXTEST0000000000000002');
      expect(saved).toBeNull();
    });
  });
});
