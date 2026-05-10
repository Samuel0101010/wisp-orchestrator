import './setup.js';
import { describe, expect, it, beforeAll } from 'vitest';
import { sampleBeta } from '../router/sampler.js';
import { runMigrations } from '../db/migrate.js';

beforeAll(() => {
  runMigrations();
});

describe('Beta sampler', () => {
  it('returns values in [0,1]', () => {
    for (let i = 0; i < 1000; i++) {
      const v = sampleBeta(2, 5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('mean ≈ α/(α+β) over 5000 samples (within 5%)', () => {
    const a = 4, b = 6;
    let sum = 0;
    for (let i = 0; i < 5000; i++) sum += sampleBeta(a, b);
    const mean = sum / 5000;
    const expected = a / (a + b);
    expect(Math.abs(mean - expected)).toBeLessThan(0.05);
  });
});
