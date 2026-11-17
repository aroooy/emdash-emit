import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/utils/config.js';
import {
  resolveConcurrency,
  resolveMediaSyncLimit,
  resolvePostsSyncLimit,
} from '../src/utils/sync-limit-precedence.js';

describe('Sync limit / concurrency precedence resolver (v0.1.37 R-2)', () => {
  describe('resolvePostsSyncLimit', () => {
    it('falls back to DEFAULT_CONFIG.postsSyncLimit when no source is set', () => {
      expect(resolvePostsSyncLimit({})).toBe(DEFAULT_CONFIG.postsSyncLimit);
    });

    it('prefers postsSyncLimit over legacy syncLimit', () => {
      expect(resolvePostsSyncLimit({ postsSyncLimit: 50, syncLimit: 12 })).toBe(50);
    });

    it('honors the legacy syncLimit when postsSyncLimit is absent', () => {
      expect(resolvePostsSyncLimit({ syncLimit: 12 })).toBe(12);
    });

    it('explicit override wins over all config sources', () => {
      expect(
        resolvePostsSyncLimit({ postsSyncLimit: 50, syncLimit: 12 }, { postsSyncLimit: 7 }),
      ).toBe(7);
    });

    it('treats falsy and non-finite values as absent (preserves pre-refactor || semantics)', () => {
      expect(resolvePostsSyncLimit({ postsSyncLimit: 0, syncLimit: 4 })).toBe(4);
      expect(resolvePostsSyncLimit({}, { postsSyncLimit: Number.NaN })).toBe(
        DEFAULT_CONFIG.postsSyncLimit,
      );
    });
  });

  describe('resolveMediaSyncLimit', () => {
    it('falls back to DEFAULT_CONFIG.mediaSyncLimit when no source is set', () => {
      expect(resolveMediaSyncLimit({})).toBe(DEFAULT_CONFIG.mediaSyncLimit);
    });

    it('prefers explicit override over config', () => {
      expect(resolveMediaSyncLimit({ mediaSyncLimit: 100 }, { mediaSyncLimit: 25 })).toBe(25);
    });

    it('treats a configured zero as absent and falls through to the default', () => {
      expect(resolveMediaSyncLimit({ mediaSyncLimit: 0 })).toBe(DEFAULT_CONFIG.mediaSyncLimit);
    });
  });

  describe('resolveConcurrency', () => {
    it('canonical default comes from DEFAULT_CONFIG, never a re-spelled magic number', () => {
      expect(resolveConcurrency({})).toBe(DEFAULT_CONFIG.concurrency);
      expect(resolveConcurrency({}, { concurrency: undefined })).toBe(DEFAULT_CONFIG.concurrency);
    });

    it('prefers explicit override over config', () => {
      expect(resolveConcurrency({ concurrency: 4 }, { concurrency: 2 })).toBe(2);
    });

    it('treats a configured zero as absent (preserves pre-refactor || semantics)', () => {
      expect(resolveConcurrency({ concurrency: 0 })).toBe(DEFAULT_CONFIG.concurrency);
    });
  });

  describe('symmetry rail: consumers share the resolver (static source scan)', () => {
    const SRC_ROOT = path.resolve(__dirname, '../src');

    const consumers = ['cli/commands/pull.ts', 'mcp/tools/sync-pull.ts', 'sync/orchestrator.ts'];

    it('CLI and MCP both import from utils/sync-limit-precedence.js', () => {
      for (const rel of consumers) {
        const content = fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
        expect(
          content,
          `${rel} must resolve limits through the shared Layer 0 precedence helper`,
        ).toMatch(/from\s+'[^']*utils\/sync-limit-precedence\.js'/);
      }
    });

    it('no inline fallback chains remain in consumers (no regression of scattered defaults)', () => {
      const forbidden = [
        /postsSyncLimit\s*\|\|/,
        /mediaSyncLimit\s*\|\|/,
        /syncLimit\s*\|\|/,
        /concurrency\s*\|\|\s*8\b/,
      ];
      for (const rel of consumers) {
        const content = fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
        for (const pattern of forbidden) {
          expect(
            content,
            `${rel} must not inline a limit/concurrency fallback chain (${pattern})`,
          ).not.toMatch(pattern);
        }
      }
    });
  });
});
