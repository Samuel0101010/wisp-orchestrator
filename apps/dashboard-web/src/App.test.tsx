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

  it('renders TeamBuilder at /projects/:id/teams', () => {
    renderAt('/projects/abc/teams');
    // "Team Builder" now appears in both breadcrumbs and page heading; assert
    // at least one Team Builder is present rather than requiring uniqueness.
    expect(screen.getAllByText('Team Builder').length).toBeGreaterThan(0);
  });

  it('renders PlanEditor at /projects/:id/plan', async () => {
    renderAt('/projects/abc/plan');
    // The mocked fetch returns 200 + "[]" for every request, including the plan
    // GET, so the PlanEditor lands in its empty state showing "No plan yet".
    expect(await screen.findByText('No plan yet')).toBeInTheDocument();
  });

  it('renders RunView at /projects/:id/run/:runId', async () => {
    renderAt('/projects/abc/run/run-1');
    // The mocked fetch returns 200 + "[]" for everything, including the run GET,
    // which the route treats as a falsy (null) snapshot → "Run not found".
    expect(await screen.findByTestId('run-not-found')).toBeInTheDocument();
  });
});
