import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from './client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('apiFetch', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  it('parses JSON on 200', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const out = await apiFetch<{ ok: boolean }>('/api/x');
    expect(out).toEqual({ ok: true });
  });

  it('throws ApiError on 500', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    );
    await expect(apiFetch('/api/x')).rejects.toBeInstanceOf(ApiError);
  });

  it('returns undefined on 204', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );
    const out = await apiFetch('/api/x');
    expect(out).toBeUndefined();
  });
});
