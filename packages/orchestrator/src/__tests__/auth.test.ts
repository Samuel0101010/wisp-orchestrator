import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { probeSubscriptionAuth } from '../auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_BIN = resolve(__dirname, '../../tests/fixtures/mock-claude.mjs');

describe('probeSubscriptionAuth (mock)', () => {
  it('returns ok=true when the mock exits 0', async () => {
    const result = await probeSubscriptionAuth({
      __mockBin: MOCK_BIN,
      __mockEnv: { MOCK_MODE: 'auth-ok' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns ok=false with credentials hint when the mock prints auth errors', async () => {
    const result = await probeSubscriptionAuth({
      __mockBin: MOCK_BIN,
      __mockEnv: { MOCK_MODE: 'auth-fail' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.hint).toMatch(/claude login/);
      expect(result.error).toMatch(/credentials/i);
    }
  });

  it('returns ok=false with rate-limit hint when the mock prints rate-limit', async () => {
    const result = await probeSubscriptionAuth({
      __mockBin: MOCK_BIN,
      __mockEnv: { MOCK_MODE: 'rate-limit' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.hint).toMatch(/quota/i);
    }
  });
});
