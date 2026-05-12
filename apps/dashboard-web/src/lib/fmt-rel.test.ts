import { describe, expect, it } from 'vitest';
import { fmtRel } from './fmt-rel';

describe('fmtRel', () => {
  it('uses seconds under 60s in en', () => {
    const out = fmtRel(Date.now() - 30_000, 'en');
    expect(out).toMatch(/30 seconds ago/);
  });
  it('uses minutes under an hour', () => {
    const out = fmtRel(Date.now() - 5 * 60_000, 'en');
    expect(out).toMatch(/5 minutes ago/);
  });
  it('uses German formatting', () => {
    const out = fmtRel(Date.now() - 5 * 60_000, 'de');
    expect(out).toMatch(/vor 5 Minuten/);
  });
});
