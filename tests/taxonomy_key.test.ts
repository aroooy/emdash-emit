import { describe, expect, it } from 'vitest';
import {
  canonicalizeTaxonomiesForBaseline,
  carriesPrunedTaxonomies,
  pruneNonexistentTaxonomies,
} from '../src/sync/taxonomies.js';
import {
  aliasesOf,
  canonicalSlugOf,
  isKnownTaxonomyTerm,
  isPercentEncodedTerm,
  normalizeTaxonomyKey,
  type TaxonomyLookupMaps,
} from '../src/utils/taxonomy-key.js';

describe('taxonomy-key Layer 0 utilities', () => {
  it('normalizes and detects percent-encoded terms', () => {
    expect(normalizeTaxonomyKey('%e6%9c%aa%e5%88%86%e9%a1%9e')).toBe('未分類');
    expect(isPercentEncodedTerm('%e6%9c%aa%e5%88%86%e9%a1%9e')).toBe(true);
    expect(isPercentEncodedTerm('tech')).toBe(false);
  });

  it('determines canonicalSlug and aliases', () => {
    expect(canonicalSlugOf({ slug: '未分類', canonicalSlug: '%e6%9c%aa%e5%88%86%e9%a1%9e' })).toBe(
      '%e6%9c%aa%e5%88%86%e9%a1%9e',
    );
    expect(canonicalSlugOf({ slug: 'tech' })).toBe('tech');

    expect(aliasesOf({ slug: '未分類', canonicalSlug: '%e6%9c%aa%e5%88%86%e9%a1%9e' })).toEqual([
      '未分類',
      '%e6%9c%aa%e5%88%86%e9%a1%9e',
    ]);
    expect(aliasesOf({ slug: 'tech' })).toEqual(['tech']);
  });

  describe('isKnownTaxonomyTerm (T1)', () => {
    const mockMaps: TaxonomyLookupMaps = {
      slugToId: {
        category: {
          news: '01CAT000000000000000000001',
          お知らせ: '01CAT000000000000000000001',
          '%e3%81%8a%e7%9f%a5%e3%82%89%e3%81%9b': '01CAT000000000000000000001',
          // Winner of collision
          shared: '01CAT000000000000000000002',
        },
        tag: {
          typescript: '01TAG000000000000000000001',
          レビュー: '01TAG000000000000000000002',
          '%e3%83%ac%e3%83%93%e3%83%a5%e3%83%bc': '01TAG000000000000000000002',
        },
      },
      idToSlug: {
        category: {
          '01CAT000000000000000000001': '%e3%81%8a%e7%9f%a5%e3%82%89%e3%81%9b',
          '01CAT000000000000000000002': 'shared',
          // Loser term of collision (shares slug "shared", but has its own ULID)
          '01CAT000000000000000000003': 'shared',
        },
        tag: {
          '01TAG000000000000000000001': 'typescript',
          '01TAG000000000000000000002': '%e3%83%ac%e3%83%93%e3%83%a5%e3%83%bc',
        },
      },
    };

    it('matches exact ULID in idToSlug (including loser terms)', () => {
      expect(isKnownTaxonomyTerm('01CAT000000000000000000001', 'category', mockMaps)).toBe(true);
      expect(isKnownTaxonomyTerm('01CAT000000000000000000003', 'category', mockMaps)).toBe(true);
      expect(isKnownTaxonomyTerm('01TAG000000000000000000001', 'tag', mockMaps)).toBe(true);
    });

    it('matches slug, decoded slug, or name alias in slugToId', () => {
      expect(isKnownTaxonomyTerm('news', 'category', mockMaps)).toBe(true);
      expect(isKnownTaxonomyTerm('お知らせ', 'category', mockMaps)).toBe(true);
      expect(
        isKnownTaxonomyTerm('%e3%81%8a%e7%9f%a5%e3%82%89%e3%81%9b', 'category', mockMaps),
      ).toBe(true);
      expect(isKnownTaxonomyTerm('typescript', 'tag', mockMaps)).toBe(true);
      expect(isKnownTaxonomyTerm('レビュー', 'tag', mockMaps)).toBe(true);
      expect(isKnownTaxonomyTerm('%e3%83%ac%e3%83%93%e3%83%a5%e3%83%bc', 'tag', mockMaps)).toBe(
        true,
      );
    });

    it('returns false for unknown terms or mismatched taxonomies', () => {
      expect(isKnownTaxonomyTerm('unknown-slug', 'category', mockMaps)).toBe(false);
      expect(isKnownTaxonomyTerm('01UNKNOWN00000000000000000', 'category', mockMaps)).toBe(false);
      // Category term queried under tag
      expect(isKnownTaxonomyTerm('news', 'tag', mockMaps)).toBe(false);
      expect(isKnownTaxonomyTerm('01CAT000000000000000000001', 'tag', mockMaps)).toBe(false);
    });
  });

  describe('carriesPrunedTaxonomies', () => {
    const mockMaps: TaxonomyLookupMaps = {
      slugToId: {
        category: { tech: '01CAT000000000000000000001' },
        tag: { vitest: '01TAG000000000000000000001' },
      },
      idToSlug: {
        category: { '01CAT000000000000000000001': 'tech' },
        tag: { '01TAG000000000000000000001': 'vitest' },
      },
    };

    it('returns true when an unlisted term exists', () => {
      expect(
        carriesPrunedTaxonomies(
          { categories: ['tech'], tags: ['vitest', 'deleted-tag'] },
          mockMaps,
        ),
      ).toBe(true);
    });

    it('returns false when all terms are valid or empty', () => {
      expect(carriesPrunedTaxonomies({ categories: ['tech'], tags: ['vitest'] }, mockMaps)).toBe(
        false,
      );
      expect(carriesPrunedTaxonomies({ categories: [], tags: [] }, mockMaps)).toBe(false);
      expect(carriesPrunedTaxonomies(undefined, mockMaps)).toBe(false);
    });

    it('ignores custom taxonomies', () => {
      expect(
        carriesPrunedTaxonomies({ categories: ['tech'], custom_tax: ['custom-val'] }, mockMaps),
      ).toBe(false);
    });
  });

  describe('pruneNonexistentTaxonomies', () => {
    const mockMaps: TaxonomyLookupMaps = {
      slugToId: {
        category: { tech: '01CAT000000000000000000001' },
        tag: { vitest: '01TAG000000000000000000001' },
      },
      idToSlug: {
        category: { '01CAT000000000000000000001': 'tech' },
        tag: { '01TAG000000000000000000001': 'vitest' },
      },
    };

    it('prunes nonexistent terms and records removedTerms, keeping empty array', () => {
      const res = pruneNonexistentTaxonomies(
        { categories: ['tech', 'old-cat'], tags: ['deleted-tag-1', 'deleted-tag-2'] },
        mockMaps,
      );
      expect(res.prunedTaxonomies).toEqual({
        categories: ['tech'],
        tags: [],
      });
      expect(res.removedTerms).toEqual({
        categories: ['old-cat'],
        tags: ['deleted-tag-1', 'deleted-tag-2'],
      });
    });

    it('preserves custom taxonomy keys', () => {
      const res = pruneNonexistentTaxonomies(
        { categories: ['tech'], series: ['my-series'] },
        mockMaps,
      );
      expect(res.prunedTaxonomies).toEqual({
        categories: ['tech'],
        series: ['my-series'],
      });
      expect(res.removedTerms).toEqual({});
    });
  });

  describe('canonicalizeTaxonomiesForBaseline', () => {
    const mockMaps: TaxonomyLookupMaps = {
      slugToId: {
        category: {
          お知らせ: '01CAT000000000000000000001',
          '%e3%81%8a%e7%9f%a5%e3%82%89%e3%81%9b': '01CAT000000000000000000001',
        },
        tag: {
          typescript: '01TAG000000000000000000001',
          shared: '01TAG000000000000000000002', // Winner
        },
      },
      idToSlug: {
        category: {
          '01CAT000000000000000000001': '%e3%81%8a%e7%9f%a5%e3%82%89%e3%81%9b',
        },
        tag: {
          '01TAG000000000000000000001': 'typescript',
          '01TAG000000000000000000002': 'shared',
          '01TAG000000000000000000003': 'shared', // Loser
        },
      },
    };

    it('resolves decoded slug to canonical slug', () => {
      const res = canonicalizeTaxonomiesForBaseline({ categories: ['お知らせ'] }, mockMaps);
      expect(res).toEqual({
        categories: ['%e3%81%8a%e7%9f%a5%e3%82%89%e3%81%9b'],
      });
    });

    it('preserves ULID verbatim (including loser term ULID)', () => {
      const res = canonicalizeTaxonomiesForBaseline(
        { tags: ['01TAG000000000000000000003', 'typescript'] },
        mockMaps,
      );
      expect(res).toEqual({
        tags: ['01TAG000000000000000000003', 'typescript'],
      });
    });
  });
});
