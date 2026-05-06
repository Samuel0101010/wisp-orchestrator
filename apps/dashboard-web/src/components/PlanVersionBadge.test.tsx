import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlanVersionBadge } from './PlanVersionBadge';

const originalFetch = globalThis.fetch;

let chainResponse: {
  chain: Array<{
    id: string;
    parentPlanId: string | null;
    status: string;
    createdAt: number | null;
  }>;
} | null = null;
let httpStatus = 200;

beforeEach(() => {
  chainResponse = null;
  httpStatus = 200;
  globalThis.fetch = vi.fn(async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/chain')) {
      if (httpStatus === 404) return new Response('{"error":"not found"}', { status: 404 });
      return new Response(JSON.stringify(chainResponse ?? { chain: [] }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderBadge(planId: string | undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PlanVersionBadge planId={planId} />
    </QueryClientProvider>,
  );
}

describe('PlanVersionBadge', () => {
  it('renders nothing for a single-entry chain (root plan)', async () => {
    chainResponse = {
      chain: [{ id: 'p1', parentPlanId: null, status: 'locked', createdAt: null }],
    };
    renderBadge('p1');
    // Wait for the query to settle then confirm no badge.
    await waitFor(() => {
      expect(screen.queryByTestId('plan-version-badge')).toBeNull();
    });
  });

  it('renders v2 (replanned) for a 2-entry chain', async () => {
    chainResponse = {
      chain: [
        { id: 'child', parentPlanId: 'root', status: 'locked', createdAt: null },
        { id: 'root', parentPlanId: null, status: 'failed', createdAt: null },
      ],
    };
    renderBadge('child');
    await waitFor(() => {
      const badge = screen.getByTestId('plan-version-badge');
      expect(badge.textContent).toContain('v2 (replanned)');
    });
  });

  it('renders v3 (replanned) for a 3-entry chain', async () => {
    chainResponse = {
      chain: [
        { id: 'c2', parentPlanId: 'c1', status: 'locked', createdAt: null },
        { id: 'c1', parentPlanId: 'root', status: 'failed', createdAt: null },
        { id: 'root', parentPlanId: null, status: 'failed', createdAt: null },
      ],
    };
    renderBadge('c2');
    await waitFor(() => {
      expect(screen.getByTestId('plan-version-badge').textContent).toContain('v3 (replanned)');
    });
  });

  it('renders nothing when the chain endpoint 404s', async () => {
    httpStatus = 404;
    renderBadge('missing');
    await waitFor(() => {
      expect(screen.queryByTestId('plan-version-badge')).toBeNull();
    });
  });

  it('renders nothing when planId is undefined', async () => {
    renderBadge(undefined);
    expect(screen.queryByTestId('plan-version-badge')).toBeNull();
  });
});
