import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PendingChangesPanel } from './PendingChangesPanel';
import { ToastViewportRoot } from '@/components/ui/use-toast';

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
    if (url.endsWith('/iterations') && method === 'POST') {
      return new Response(
        JSON.stringify({
          planId: 'plan-1',
          runId: 'run-99',
          linkedChangeRequestCount: rows.length,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
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
        <ToastViewportRoot />
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

  it('Run Iteration POSTs once to /iterations and navigates to the new run view', async () => {
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
    const iterationCalls = calls.filter(
      (c) => c.method === 'POST' && c.url.endsWith('/projects/p1/iterations'),
    );
    expect(iterationCalls).toHaveLength(1);
    expect((iterationCalls[0].body as { changeRequestIds: string[] }).changeRequestIds).toEqual([
      'a',
      'b',
    ]);
    // The old 3-step client sequence must be gone.
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/plan'))).toBeUndefined();
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/lock'))).toBeUndefined();
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/runs'))).toBeUndefined();
    expect(screen.getByTestId('location-pathname').textContent).toBe('/projects/p1/run/run-99');
  });

  it('Run Iteration button is disabled when the queue is empty', async () => {
    rows = [];
    renderPanel();
    await waitFor(() => screen.getByTestId('run-iteration-button'));
    const btn = screen.getByTestId('run-iteration-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('fires the "preparing iteration" toast immediately on click, before the iterations mutation resolves', async () => {
    rows = [makeRow({ id: 'a', userPrompt: 'one' })];
    // Hold the /iterations call open until we release it so we can assert the
    // toast is visible while the mutation is still pending.
    let releaseIteration!: () => void;
    const iterationGate = new Promise<void>((resolve) => {
      releaseIteration = resolve;
    });
    const baseFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.endsWith('/iterations') && method === 'POST') {
        await iterationGate;
      }
      return (baseFetch as typeof fetch)(input, init);
    }) as typeof fetch;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
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
          <ToastViewportRoot />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => screen.getByTestId('pending-row-a'));
    fireEvent.click(screen.getByTestId('run-iteration-button'));

    // The preparing toast must appear immediately, while /iterations is still pending.
    await waitFor(() => {
      expect(screen.getByText('Preparing iteration …')).toBeInTheDocument();
    });
    // The iterations call has not reached the server yet — we're still gated.
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/iterations'))).toBeUndefined();
    // Release the iterations mutation and confirm the run is created + navigation occurs.
    releaseIteration();
    await waitFor(
      () => {
        expect(screen.getByTestId('run-view')).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
  });

  it('shows the queued-preserved description when the server responds 502 run_start_failed', async () => {
    rows = [makeRow({ id: 'a', userPrompt: 'one' })];
    const baseFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.endsWith('/iterations') && method === 'POST') {
        return new Response(
          JSON.stringify({
            error: 'run_start_failed',
            planId: 'plan-1',
            runStartError: 'spawn failed',
          }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        );
      }
      return (baseFetch as typeof fetch)(input, init);
    }) as typeof fetch;

    renderPanel();
    await waitFor(() => screen.getByTestId('pending-row-a'));
    fireEvent.click(screen.getByTestId('run-iteration-button'));
    await waitFor(() => {
      expect(
        screen.getByText(
          'The plan was created but the run could not start — your change requests are still queued.',
        ),
      ).toBeInTheDocument();
    });
    // No navigation — we stay on the project page; the queued row is preserved.
    expect(screen.queryByTestId('run-view')).toBeNull();
    expect(screen.getByTestId('pending-row-a')).toBeInTheDocument();
  });

  it('shows the wait-for-active-run description when the server responds 409 run_already_active', async () => {
    rows = [makeRow({ id: 'a', userPrompt: 'one' })];
    const baseFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.endsWith('/iterations') && method === 'POST') {
        return new Response(
          JSON.stringify({
            error: 'run_already_active',
            planId: 'plan-1',
            details: { activeRunId: 'run-9' },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      }
      return (baseFetch as typeof fetch)(input, init);
    }) as typeof fetch;

    renderPanel();
    await waitFor(() => screen.getByTestId('pending-row-a'));
    fireEvent.click(screen.getByTestId('run-iteration-button'));
    await waitFor(() => {
      expect(
        screen.getByText(
          'A run is already in progress for this project. Wait for it to finish, then start the iteration.',
        ),
      ).toBeInTheDocument();
    });
    // No navigation — we stay on the project page; the queued row is preserved.
    expect(screen.queryByTestId('run-view')).toBeNull();
    expect(screen.getByTestId('pending-row-a')).toBeInTheDocument();
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
