import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { App } from './App';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Mock fetch: empty list for collections; 404 for plan/team lookups so routes
  // land in their empty states without trying to render real data.
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (
      url.includes('/plan') ||
      url.includes('/team') ||
      /\/api\/projects\/[^/]+$/.test(url) ||
      /\/api\/runs\/[^/]+$/.test(url)
    ) {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('App', () => {
  it('renders the sidebar and Mission Control at root', () => {
    renderAt('/');
    expect(screen.getByText('Agent Harness')).toBeInTheDocument();
    // The new Home page shows the Mission Control heading.
    expect(screen.getByTestId('mission-control')).toBeInTheDocument();
  });

  it(
    'renders TeamBuilder at /projects/:id/teams',
    async () => {
      renderAt('/projects/abc/teams');
      // "Team Builder" appears in both breadcrumbs and page heading; assert
      // at least one is present rather than requiring uniqueness.
      // Per-test timeout bumped to 15s: lazy route + chunk import + Suspense
      // resolution takes ~3s on its own; the default 5s test budget exhausts
      // before findBy gets to retry under parallel-suite load.
      await screen.findByText('Team Builder', {}, { timeout: 10000 });
      expect(screen.getAllByText('Team Builder').length).toBeGreaterThan(0);
    },
    15000,
  );

  it(
    'renders PlanEditor at /projects/:id/plan',
    async () => {
      renderAt('/projects/abc/plan');
      // Mocked fetch returns 200 + "[]" for plan GET, so PlanEditor lands
      // in its empty state showing "No plan yet".
      expect(await screen.findByText('No plan yet', {}, { timeout: 10000 })).toBeInTheDocument();
    },
    15000,
  );

  it(
    'renders RunView at /projects/:id/run/:runId',
    async () => {
      renderAt('/projects/abc/run/run-1');
      // Mocked fetch returns 200 + "[]" for the run GET; the route treats
      // a falsy snapshot as → "Run not found".
      expect(
        await screen.findByTestId('run-not-found', {}, { timeout: 10000 }),
      ).toBeInTheDocument();
    },
    15000,
  );
});
