import { describe, it, expect } from 'vitest';
import { detectRateLimit } from '../rate-limit.js';

describe('detectRateLimit', () => {
  it('returns null for empty input', () => {
    expect(detectRateLimit('')).toBeNull();
  });

  it('returns null for unrelated text', () => {
    expect(detectRateLimit('hello world, nothing to see here')).toBeNull();
  });

  it('detects a plain "rate limit" marker without resetAt', () => {
    const hit = detectRateLimit('Error: rate limit exceeded for this account');
    expect(hit).not.toBeNull();
    expect(hit?.resetAt).toBeNull();
    expect(hit?.source).toBe('stdout-marker');
  });

  it('detects "Too Many Requests" (case insensitive)', () => {
    const hit = detectRateLimit('HTTP 429 Too Many Requests');
    expect(hit).not.toBeNull();
    expect(hit?.source).toBe('stdout-marker');
  });

  it('detects "usage_policy_violation"', () => {
    const hit = detectRateLimit('{"error":"usage_policy_violation"}');
    expect(hit).not.toBeNull();
  });

  it('detects "usage limit reached"', () => {
    const hit = detectRateLimit('Subscription usage limit reached for this period');
    expect(hit).not.toBeNull();
  });

  it('extracts retry_after seconds and converts to absolute unix-ms', () => {
    const before = Date.now();
    const hit = detectRateLimit('{"error":"rate_limit","retry_after": 60}');
    const after = Date.now();
    expect(hit).not.toBeNull();
    expect(hit?.source).toBe('json-retry-after');
    expect(hit?.resetAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(hit?.resetAt).toBeLessThanOrEqual(after + 60_000);
  });

  it('extracts reset_seconds and converts to absolute unix-ms', () => {
    const before = Date.now();
    const hit = detectRateLimit('rate-limit hit, "reset_seconds": 30');
    const after = Date.now();
    expect(hit).not.toBeNull();
    expect(hit?.source).toBe('json-reset-seconds');
    expect(hit?.resetAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(hit?.resetAt).toBeLessThanOrEqual(after + 30_000);
  });

  it('extracts reset ISO timestamp', () => {
    const iso = '2026-12-31T23:59:59Z';
    const hit = detectRateLimit(`rate limit, "reset": "${iso}"`);
    expect(hit).not.toBeNull();
    expect(hit?.source).toBe('json-reset-iso');
    expect(hit?.resetAt).toBe(Date.parse(iso));
  });

  it('preserves raw input', () => {
    const text = 'rate limit exceeded';
    const hit = detectRateLimit(text);
    expect(hit?.raw).toBe(text);
  });
});
