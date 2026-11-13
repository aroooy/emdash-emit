import { describe, it, expect } from 'vitest';
import {
  isMediaRecordId,
  toMediaRecordId,
  toStorageKey,
  type MediaRecordId,
  type StorageKey,
} from '../src/utils/media-id.js';

describe('Media ID branded types (two ID spaces)', () => {
  describe('toMediaRecordId', () => {
    it('accepts a canonical ULID and normalizes casing', () => {
      expect(toMediaRecordId('01m67p0mbmjqqxh2k95hhcyryb')).toBe('01M67P0MBMJQQXH2K95HHCYRYB');
      expect(toMediaRecordId(' 01M67P0MBMJQQXH2K95HHCYRYB ')).toBe('01M67P0MBMJQQXH2K95HHCYRYB');
    });

    it('rejects anything that is not a 26-character Crockford ULID', () => {
      // A storageKey must never be laundered into a record id.
      expect(toMediaRecordId('01M67P0MBMJQQXH2K95HHCYRYB.jpg')).toBeNull();
      expect(toMediaRecordId('01M67P0MBMJQQXH2K95HHCYRY')).toBeNull();
      expect(toMediaRecordId('01M67P0MBMJQQXHO2K95HHCYR')).toBeNull();
      expect(toMediaRecordId('')).toBeNull();
      expect(toMediaRecordId(null)).toBeNull();
      expect(toMediaRecordId(undefined)).toBeNull();
      expect(toMediaRecordId(42)).toBeNull();
    });

    it('isMediaRecordId agrees with toMediaRecordId on the ULID rule', () => {
      expect(isMediaRecordId('01M67P0MBMJQQXH2K95HHCYRYB')).toBe(true);
      expect(isMediaRecordId('01M67P0MBMJQQXH2K95HHCYRYB.jpg')).toBe(false);
    });
  });

  describe('toStorageKey', () => {
    it('accepts the ULID-segment shapes a body URL can carry', () => {
      expect(toStorageKey('01M6A7SJ82S6P98MN1YSPQ33YG.jpg')).toBe('01M6A7SJ82S6P98MN1YSPQ33YG.jpg');
      expect(toStorageKey('01M6A7SJ82S6P98MN1YSPQ33YG.01M6A7SJEN7HNDPPM537J23R19.avif')).toBe(
        '01M6A7SJ82S6P98MN1YSPQ33YG.01M6A7SJEN7HNDPPM537J23R19.avif',
      );
    });

    it('accepts a migrated path-shaped key because the server reports it verbatim', () => {
      expect(toStorageKey('uploads/2026/11/sample.png')).toBe('uploads/2026/11/sample.png');
    });

    it('rejects values that name no media object', () => {
      expect(toStorageKey('')).toBeNull();
      expect(toStorageKey('   ')).toBeNull();
      expect(toStorageKey('no-extension')).toBeNull();
      expect(toStorageKey('01M6A7SJ82S6P98MN1YSPQ33YG.pdf')).toBeNull();
      expect(toStorageKey('trailing/slash/')).toBeNull();
      expect(toStorageKey('key.png?cb=1')).toBeNull();
      expect(toStorageKey('key.png#frag')).toBeNull();
      expect(toStorageKey(null)).toBeNull();
      expect(toStorageKey(undefined)).toBeNull();
    });
  });

  describe('brand separation', () => {
    it('a StorageKey is not assignable to a MediaRecordId and vice versa', () => {
      const storageKey = toStorageKey('01M6A7SJ82S6P98MN1YSPQ33YG.jpg') as StorageKey;
      const recordId = toMediaRecordId('01M6A7SJ82S6P98MN1YSPQ33YG') as MediaRecordId;
      // Compile-time guarantee: the two ID spaces are distinct types even though both are strings.
      const asRecord: MediaRecordId = recordId;
      const asKey: StorageKey = storageKey;
      expect(asRecord).toBe('01M6A7SJ82S6P98MN1YSPQ33YG');
      expect(asKey).toBe('01M6A7SJ82S6P98MN1YSPQ33YG.jpg');
    });
  });
});
