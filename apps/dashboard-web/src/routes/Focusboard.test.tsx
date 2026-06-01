import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Focusboard } from './Focusboard';

const project = { id: 'p1', name: 'P1', goal: 'g', repoPath: '/r' };

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/projects')) {
      return new Response(JSON.stringify([project]), { status: 200 });
    }
    if (/\/api\/projects\/p1$/.test(url)) {
      return new Response(JSON.stringify(project), { status: 200 });
    }
    if (/\/api\/projects\/p1\/runs$/.test(url)) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    // /api/agents (chat panel) + anything else
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderFocus() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/focus/p1']}>
        <Routes>
          <Route path="/focus/:projectId" element={<Focusboard />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The four KPI labels were raw literals (incl. the German "Aufgaben" leaking into
// the EN UI); they now use the focus.kpi.* namespace.
describe('Focusboard KPI i18n', () => {
  it('renders localized KPI labels (no raw "focus.kpi." keys)', async () => {
    renderFocus();
    await waitFor(() => expect(screen.getByText('Tokens In')).toBeInTheDocument());
    expect(screen.getByText('Tokens Out')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.queryByText(/focus\.kpi\./)).toBeNull();
  });
});
