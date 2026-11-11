import { describe, it, expect } from 'vitest';
import {
  FENCE_POLICY,
  isCodeFenceDelimiter,
  scanRawMediaReferences,
  VALID_MEDIA_FILE_KEY,
  MEDIA_FILE_ROUTE_PREFIX,
} from '../src/utils/media-refs.js';

describe('Media Reference Parser & Fence Policies (R5)', () => {
  describe('FENCE_POLICY constants and delimiter detection', () => {
    it('defines distinct policies for guards and diagnostics', () => {
      expect(FENCE_POLICY.guard).toBe('backtick-only');
      expect(FENCE_POLICY.diagnostic).toBe('backtick-or-tilde');
    });

    it('recognizes code fence delimiters according to policy', () => {
      // Guard policy: only backticks
      expect(isCodeFenceDelimiter('```', FENCE_POLICY.guard)).toBe('```');
      expect(isCodeFenceDelimiter('````markdown', FENCE_POLICY.guard)).toBe('```');
      expect(isCodeFenceDelimiter('~~~', FENCE_POLICY.guard)).toBeNull();
      expect(isCodeFenceDelimiter('~~~~ts', FENCE_POLICY.guard)).toBeNull();
      expect(isCodeFenceDelimiter('regular text', FENCE_POLICY.guard)).toBeNull();

      // Diagnostic policy: both backticks and tildes
      expect(isCodeFenceDelimiter('```', FENCE_POLICY.diagnostic)).toBe('```');
      expect(isCodeFenceDelimiter('````markdown', FENCE_POLICY.diagnostic)).toBe('```');
      expect(isCodeFenceDelimiter('~~~', FENCE_POLICY.diagnostic)).toBe('~~~');
      expect(isCodeFenceDelimiter('~~~~ts', FENCE_POLICY.diagnostic)).toBe('~~~');
      expect(isCodeFenceDelimiter('regular text', FENCE_POLICY.diagnostic)).toBeNull();
    });
  });

  describe('scanRawMediaReferences with fence policy', () => {
    const fixtureMarkdown = `
# Title

Paragraph before image.
![Image 1](../../media/drafts/hero.png)
<img src="../../media/drafts/subhero.jpg" alt="Subhero">

\`\`\`markdown
![Fenced Backtick](../../media/drafts/backtick-example.png)
<img src="../../media/drafts/backtick-html.png">
\`\`\`

~~~markdown
![Fenced Tilde](../../media/drafts/tilde-example.png)
~~~

<!--ec:block {"_type":"gallery","images":["../../media/drafts/single-opaque-gallery.png"]} -->
<!--ec:block multi-line-start
![Opaque Block Image](../../media/drafts/multi-opaque-gallery.png)
-->

Trailing paragraph.
![Image 2](../../media/drafts/footer.webp)
`;

    it('extracts un-fenced markdown and html images', () => {
      const refs = scanRawMediaReferences(fixtureMarkdown, FENCE_POLICY.guard);
      expect(refs).toContain('../../media/drafts/hero.png');
      expect(refs).toContain('../../media/drafts/subhero.jpg');
      expect(refs).toContain('../../media/drafts/footer.webp');

      // Backtick fences are always stripped
      expect(refs).not.toContain('../../media/drafts/backtick-example.png');
      expect(refs).not.toContain('../../media/drafts/backtick-html.png');

      // Opaque fences are always ignored
      expect(refs).not.toContain('../../media/drafts/single-opaque-gallery.png');
      expect(refs).not.toContain('../../media/drafts/multi-opaque-gallery.png');

      // Guard policy strictly DOES NOT exempt tilde fences (AGENTS.md rule)
      expect(refs).toContain('../../media/drafts/tilde-example.png');
    });

    it('exempts tilde fences when using diagnostic policy', () => {
      const refs = scanRawMediaReferences(fixtureMarkdown, FENCE_POLICY.diagnostic);
      expect(refs).toContain('../../media/drafts/hero.png');
      expect(refs).toContain('../../media/drafts/subhero.jpg');
      expect(refs).toContain('../../media/drafts/footer.webp');

      // Diagnostic policy ignores both backtick and tilde fences
      expect(refs).not.toContain('../../media/drafts/backtick-example.png');
      expect(refs).not.toContain('../../media/drafts/tilde-example.png');
    });
  });

  describe('VALID_MEDIA_FILE_KEY pattern', () => {
    it('validates single and dotted ULID keys with valid image extensions', () => {
      expect(VALID_MEDIA_FILE_KEY.test('01M6ABCDEF1234567890123456.png')).toBe(true);
      expect(
        VALID_MEDIA_FILE_KEY.test('01M6ABCDEF1234567890123456.01M6ABCDEF1234567890123457.webp'),
      ).toBe(true);
      expect(
        VALID_MEDIA_FILE_KEY.test(
          '01M6ABCDEF1234567890123456.01M6ABCDEF1234567890123457.01M6ABCDEF1234567890123458.jpeg',
        ),
      ).toBe(true);
    });

    it('rejects invalid storageKeys', () => {
      expect(VALID_MEDIA_FILE_KEY.test('invalid-name.png')).toBe(false);
      expect(VALID_MEDIA_FILE_KEY.test('01M6ABCDEF1234567890123456.exe')).toBe(false);
      expect(VALID_MEDIA_FILE_KEY.test('01M6ABCDEF1234567890123456.pdf')).toBe(false);
      expect(VALID_MEDIA_FILE_KEY.test('')).toBe(false);
    });
  });

  describe('MEDIA_FILE_ROUTE_PREFIX constant', () => {
    it('has canonical format', () => {
      expect(MEDIA_FILE_ROUTE_PREFIX).toBe('/_emdash/api/media/file/');
    });
  });
});
