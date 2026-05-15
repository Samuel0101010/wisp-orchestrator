import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PendingChangesPanel } from './PendingChangesPanel';

const originalFetch = globalThis.fetch;

interface FakeRow {
  id: string;
  projectId: string;
  runId: string | null;
  status: 'pending' | 'in-run' | 'done' | 'dismissed';
  source: 'visual' | 'text';
  selector: string | null;
  rectJson: { x: number; y: number; width: number; height: number } | null;
  screenshotPath: string | null;
  userPrompt: string;
  createdAt: number;
  resolvedAt: number | null;
}

let rows: FakeRow[] = [];
const calls: Array<{ url: string; method: string; body?: unknown }> = [];

function makeRow(over: Partial<FakeRow> = {}): FakeRow {
  return {
    id: over.id ?? `cr-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'p1',
    runId: null,
    status: 'pending',
    source: 'text',
    selector: null,
    rectJson: null,
    screenshotPath: null,
    userPrompt: 'change me',
    createdAt: Date.now(),
    resolvedAt: null,
    ...over,
  };
}

beforeEach(() => {
  rows = [];
  calls.length = 0;
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });
    if (url.includes('/change-requests') && method === 'GET') {
      return new Response(JSON.stringify(rows.filter((r) => r.status === 'pending')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.match(/\/change-requests\/[^/]+$/) && method === 'DELETE') {
      const id = url.split('/').pop()!;
      rows = rows.filter((r) => r.id !== id);
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/change-requests') && method === 'POST') {
      const created = makeRow({ ...(body as Partial<FakeRow>), id: `cr-new-${rows.length}` });
      rows.push(created);
      return new Response(JSON.stringify(created), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/plan') && method === 'POST') {
      return new Response(
        JSON.stringify({ id: 'plan-1', projectId: 'p1', status: 'draft', dagJson: {} }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/lock') && method === 'POST') {
      return new Response(JSON.stringify({ id: 'plan-1', status: 'locked' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/api/runs') && method === 'POST') {
      return new Response(JSON.stringify({ runId: 'run-99' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-pathname">{loc.pathname}</div>;
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/projects/p1']}>
        <Routes>
          <Route
            path="/projects/p1"
            element={
              <>
                <PendingChangesPanel projectId="p1" />
                <LocationProbe />
              </>
            }
          />
          <Route
            path="/projects/:projectId/run/:runId"
            element={
              <>
                <div data-testid="run-view">run view</div>
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PendingChangesPanel', () => {
  it('renders pending rows fetched from the change-requests endpoint', async () => {
    rows = [
      makeRow({ id: 'a', source: 'visual', selector: 'div.card', userPrompt: 'make it blue' }),
      makeRow({ id: 'b', source: 'text', userPrompt: 'add dark mode' }),
    ];
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('pending-row-a')).toBeInTheDocument();
      expect(screen.getByTestId('pending-row-b')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pending-changes-count').textContent).toBe('2');
    expect(screen.getByText('make it blue')).toBeInTheDocument();
    expect(screen.getByText('add dark mode')).toBeInTheDocument();
  });

  it('clicking delete removes the row from the queue', async () => {
    rows = [makeRow({ id: 'a', userPrompt: 'kill me' })];
    renderPanel();
    await waitFor(() => screen.getByTestId('pending-row-a'));
    fireEvent.click(screen.getByTestId('pending-delete-a'));
    await waitFor(() => {
      expect(screen.queryByTestId('pending-row-a')).toBeNull();
    });
    const deleteCall = calls.find(
      (c) => c.method === 'DELETE' && c.url.includes('/change-requests/a'),
    );
    expect(deleteCall).toBeTruthy();
  });

  it('Run Iteration chains plan + lock + run and navigates to the new run view', async () => {
    rows = [makeRow({ id: 'a', userPrompt: 'one' }), makeRow({ id: 'b', userPrompt: 'two' })];
    renderPanel();
    await waitFor(() => screen.getByTestId('pending-row-a'));
    await waitFor(() => screen.getByTestId('pending-row-b'));
    fireEvent.click(screen.getByTestId('run-iteration-button'));
    await waitFor(
      () => {
        expect(screen.getByTestId('run-view')).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    const planCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/plan'));
    const lockCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/lock'));
    const runCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/runs'));
    expect(planCall).toBeTruthy();
    expect(lockCall).toBeTruthy();
    expect(runCall).toBeTruthy();
    expect((planCall!.body as { changeRequestIds: string[] }).changeRequestIds).toEqual(['a', 'b']);
    expect((runCall!.body as { planId: string; changeRequestIds: string[] }).planId).toBe('plan-1');
    expect(screen.getByTestId('location-pathname').textContent).toBe('/projects/p1/run/run-99');
  });

  it('Run Iteration button is disabled when the queue is empty', async () => {
    rows = [];
    renderPanel();
    await waitFor(() => screen.getByTestId('run-iteration-button'));
    const btn = screen.getByTestId('run-iteration-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('text-mode form POSTs a new text-source change-request', async () => {
    rows = [];
    renderPanel();
    await waitFor(() => screen.getByTestId('text-mode-textarea'));
    fireEvent.change(screen.getByTestId('text-mode-textarea'), {
      target: { value: 'do the thing' },
    });
    fireEvent.click(screen.getByTestId('text-mode-submit'));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/change-requests'));
      expect(post).toBeTruthy();
      expect((post!.body as { source: string; userPrompt: string }).source).toBe('text');
      expect((post!.body as { userPrompt: string }).userPrompt).toBe('do the thing');
    });
  });
});
