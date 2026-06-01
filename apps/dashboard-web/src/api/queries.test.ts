import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useThreadMessages } from './queries';

const originalFetch = globalThis.fetch;
let httpStatus = 500;

beforeEach(() => {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: 'x' }), {
        status: httpStatus,
        headers: { 'content-type': 'application/json' },
      }),
  ) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

// ES-7 regression: the thread sub-resource queries used to `catch { return []; }`,
// swallowing a 500 identically to a 404 (an empty "pick a prompt" thread with no
// error). The catch is now narrowed to 404-only, matching useRun.
describe('useThreadMessages error narrowing', () => {
  it('surfaces a 500 as query.error instead of swallowing it to []', async () => {
    httpStatus = 500;
    const { result } = renderHook(() => useThreadMessages('t1'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('still treats a 404 as an empty thread ([])', async () => {
    httpStatus = 404;
    const { result } = renderHook(() => useThreadMessages('t2'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });
});
