import { describe, expect, it } from 'vitest';
import {
  taxonomyTermFilterAliases,
  taxonomyTermMatchesFilter,
  type TaxonomyTermAliases,
} from '../src/utils/taxonomy-term-match.js';

const CAMERA_DECODED = 'カメラレビュー';
const CAMERA_ENCODED = '%e3%82%ab%e3%83%a1%e3%83%a9%e3%83%ac%e3%83%93%e3%83%a5%e3%83%bc';

const cameraDefinition: TaxonomyTermAliases = {
  slug: CAMERA_DECODED,
  canonicalSlug: CAMERA_ENCODED,
  name: CAMERA_DECODED,
};

describe('taxonomy-term-match Layer 0 utility', () => {
  it('expands a decoded filter to its canonical spelling through local definitions', () => {
    const aliases = taxonomyTermFilterAliases(CAMERA_DECODED, [cameraDefinition]);
    expect(aliases).toContain(CAMERA_DECODED);
    expect(aliases).toContain(CAMERA_ENCODED);
  });

  it('expands a percent-encoded filter to its decoded spelling through local definitions', () => {
    const aliases = taxonomyTermFilterAliases(CAMERA_ENCODED, [cameraDefinition]);
    expect(aliases).toContain(CAMERA_DECODED);
    expect(aliases).toContain(CAMERA_ENCODED);
  });

  it('resolves a definition by its human-readable name', () => {
    const named: TaxonomyTermAliases = {
      slug: 'local-guide',
      canonicalSlug: '%e3%83%ad%e3%83%bc%e3%82%ab%e3%83%ab%e3%82%ac%e3%82%a4%e3%83%89',
      name: 'ローカルガイド',
    };
    const aliases = taxonomyTermFilterAliases('ローカルガイド', [named]);
    expect(aliases).toContain('local-guide');
    expect(aliases).toContain('%e3%83%ad%e3%83%bc%e3%82%ab%e3%83%ab%e3%82%ac%e3%82%a4%e3%83%89');
  });

  it('ignores definitions the filter does not refer to', () => {
    const aliases = taxonomyTermFilterAliases('tech', [cameraDefinition]);
    expect(aliases).toEqual(['tech']);
  });

  it('falls back to raw and decoded spellings without any definitions', () => {
    expect(taxonomyTermFilterAliases(CAMERA_ENCODED)).toEqual([CAMERA_ENCODED, CAMERA_DECODED]);
    expect(taxonomyTermFilterAliases('tech')).toEqual(['tech']);
  });

  it('drops blank terms and trims surrounding whitespace', () => {
    expect(taxonomyTermFilterAliases('  tech  ')).toEqual(['tech']);
    expect(taxonomyTermFilterAliases('tech', [{ slug: '', name: '   ' }])).toEqual(['tech']);
  });

  it('matches an article term carrying the other spelling of the same term', () => {
    const aliases = taxonomyTermFilterAliases(CAMERA_DECODED, [cameraDefinition]).map((alias) =>
      alias.toLowerCase(),
    );
    // Remote payloads carry the canonical slug; a filter typed decoded must still match it.
    expect(taxonomyTermMatchesFilter(CAMERA_ENCODED, aliases)).toBe(true);
    expect(taxonomyTermMatchesFilter(CAMERA_DECODED, aliases)).toBe(true);
  });

  it('preserves substring matching for partial filters', () => {
    expect(taxonomyTermMatchesFilter('camera-review-2026', ['camera'])).toBe(true);
    expect(taxonomyTermMatchesFilter('nature', ['camera'])).toBe(false);
  });

  it('rejects an empty term and an empty alias list', () => {
    expect(taxonomyTermMatchesFilter('', [CAMERA_DECODED])).toBe(false);
    expect(taxonomyTermMatchesFilter(CAMERA_DECODED, [])).toBe(false);
  });
});
