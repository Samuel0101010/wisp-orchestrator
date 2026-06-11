import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthProbeResult } from '@wisp/orchestrator';
import {
  _setAuthProbeImplForTests,
  getLastAuthProbe,
  refreshAuthProbeIfFailed,
  setLastAuthProbe,
} from '../auth-status.js';

const OK: AuthProbeResult = { ok: true, durationMs: 5 };
const FAILED: AuthProbeResult = {
  ok: false,
  hint: 'See `claude --help` for diagnostics.',
  error: 'auth probe timed out after 30000ms',
};

afterEach(() => {
  _setAuthProbeImplForTests();
  setLastAuthProbe(null);
});

describe('refreshAuthProbeIfFailed', () => {
  it('returns the cached result without re-probing when ok or never probed', async () => {
    const impl = vi.fn(async () => OK);
    _setAuthProbeImplForTests(impl);
    setLastAuthProbe(null);
    expect(await refreshAuthProbeIfFailed()).toBeNull();
    setLastAuthProbe(OK);
    expect(await refreshAuthProbeIfFailed()).toBe(OK);
    expect(impl).not.toHaveBeenCalled();
  });

  it('re-probes on a cached failure and self-heals the stored result', async () => {
    const impl = vi.fn(async () => OK);
    _setAuthProbeImplForTests(impl);
    setLastAuthProbe(FAILED);
    const result = await refreshAuthProbeIfFailed();
    expect(result?.ok).toBe(true);
    expect(impl).toHaveBeenCalledTimes(1);
    // The shared store heals too — /api/health reads it for the banner.
    expect(getLastAuthProbe()?.ok).toBe(true);
  });

  it('throttles re-probes: a second failure inside the interval serves the cache', async () => {
    const impl = vi.fn(async () => FAILED);
    _setAuthProbeImplForTests(impl);
    setLastAuthProbe(FAILED);
    expect((await refreshAuthProbeIfFailed())?.ok).toBe(false);
    expect((await refreshAuthProbeIfFailed())?.ok).toBe(false);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached failure when the re-probe itself throws', async () => {
    const impl = vi.fn(async () => {
      throw new Error('spawn refused');
    });
    _setAuthProbeImplForTests(impl);
    setLastAuthProbe(FAILED);
    const result = await refreshAuthProbeIfFailed();
    expect(result?.ok).toBe(false);
    expect(getLastAuthProbe()).toBe(FAILED);
  });

  it('shares one in-flight probe across concurrent callers', async () => {
    let resolveProbe: (r: AuthProbeResult) => void = () => {};
    const impl = vi.fn(
      () =>
        new Promise<AuthProbeResult>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    _setAuthProbeImplForTests(impl);
    setLastAuthProbe(FAILED);
    const p1 = refreshAuthProbeIfFailed();
    const p2 = refreshAuthProbeIfFailed();
    resolveProbe(OK);
    expect((await p1)?.ok).toBe(true);
    expect((await p2)?.ok).toBe(true);
    expect(impl).toHaveBeenCalledTimes(1);
  });
});
