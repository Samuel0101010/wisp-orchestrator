import './setup.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Unit-level coverage for the F1 env flags. We mirror the booleanLike used in
 * env.ts to assert parsing behavior without forcing a re-load of env.js
 * (which the test-env caches at import time).
 */
const booleanLike = z.union([z.string(), z.boolean(), z.undefined()]).transform((v) => {
  if (typeof v === 'boolean') return v;
  if (v === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
});

describe('env flag parsing (HARNESS_MOCK_CLI / HARNESS_SERVE_WEB)', () => {
  it('parses "1" as true', () => {
    expect(booleanLike.parse('1')).toBe(true);
  });
  it('parses "true" as true', () => {
    expect(booleanLike.parse('true')).toBe(true);
  });
  it('parses "yes" as true', () => {
    expect(booleanLike.parse('yes')).toBe(true);
  });
  it('parses "0" as false', () => {
    expect(booleanLike.parse('0')).toBe(false);
  });
  it('parses "false" as false', () => {
    expect(booleanLike.parse('false')).toBe(false);
  });
  it('defaults to false when undefined', () => {
    expect(booleanLike.parse(undefined)).toBe(false);
  });
});

/**
 * Smoke check: the env module exposes both flags with the expected types.
 */
describe('env module exports HARNESS_MOCK_CLI and HARNESS_SERVE_WEB', () => {
  it('exposes booleans (default false in the test setup)', async () => {
    const mod = await import('../env.js');
    expect(typeof mod.env.HARNESS_MOCK_CLI).toBe('boolean');
    expect(typeof mod.env.HARNESS_SERVE_WEB).toBe('boolean');
  });
});
