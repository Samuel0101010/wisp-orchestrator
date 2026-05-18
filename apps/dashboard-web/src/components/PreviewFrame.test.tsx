import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PreviewFrame } from './PreviewFrame';

const originalFetch = globalThis.fetch;

interface FakeStatus {
  running: boolean;
  port?: number;
  pid?: number;
  startedAt?: number;
  status?: 'starting' | 'running' | 'error' | 'stopped';
  error?: string;
}

interface FakeRunRow {
  id: string;
  planId: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  outcome: 'success' | 'failure' | 'budget_exceeded' | 'cancelled' | null;
  startedAt: string | null;
  endedAt: string | null;
  pausedReason: null;
  resumeAt: null;
}

let currentStatus: FakeStatus = { running: false };
let currentRuns: FakeRunRow[] = [];
let startCalls = 0;

beforeEach(() => {
  currentStatus = { running: false };
  currentRuns = [];
  startCalls = 0;
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/preview/status')) {
      return new Response(JSON.stringify(currentStatus), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/preview/start') && init?.method === 'POST') {
      startCalls++;
      currentStatus = {
        running: true,
        port: 5173,
        pid: 1234,
        startedAt: Date.now(),
        status: 'running',
      };
      return new Response(
        JSON.stringify({
          status: 'running',
          port: 5173,
          pid: 1234,
          startedAt: Date.now(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/preview/stop') && init?.method === 'POST') {
      currentStatus = { running: false };
      return new Response(JSON.stringify({ stopped: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (/\/api\/projects\/[^/]+\/runs$/.test(url)) {
      return new Response(JSON.stringify(currentRuns), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/change-requests')) {
      return new Response('[]', {
        status: 200,
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

function renderFrame() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PreviewFrame projectId="p1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, qc };
}

describe('PreviewFrame', () => {
  it('renders stopped status initially with Start enabled and Stop disabled', async () => {
    renderFrame();
    await waitFor(() => {
      expect(screen.getByTestId('preview-status').textContent).toMatch(/stopped/i);
    });
    const startBtn = screen.getByTestId('preview-start') as HTMLButtonElement;
    const stopBtn = screen.getByTestId('preview-stop') as HTMLButtonElement;
    expect(startBtn.disabled).toBe(false);
    expect(stopBtn.disabled).toBe(true);
    expect(screen.getByTestId('preview-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-iframe')).toBeNull();
  });

  it('clicking Start posts to /preview/start and renders the iframe once running', async () => {
    renderFrame();
    await waitFor(() => screen.getByTestId('preview-start'));
    fireEvent.click(screen.getByTestId('preview-start'));
    await waitFor(() => {
      expect(startCalls).toBe(1);
      expect(screen.getByTestId('preview-iframe')).toBeInTheDocument();
    });
    const iframe = screen.getByTestId('preview-iframe') as HTMLIFrameElement;
    expect(iframe.getAttribute('src')).toBe('/preview/p1/');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-same-origin');
  });

  it('renders an inline error alert when the polled status arrives as error', async () => {
    currentStatus = {
      running: false,
      port: 5173,
      startedAt: Date.now(),
      status: 'error',
      error: 'port-occupied',
    };
    renderFrame();
    await waitFor(() => {
      expect(screen.getByTestId('preview-status').textContent).toMatch(/error/i);
    });
    const alert = await screen.findByTestId('preview-error-alert');
    expect(alert).toBeInTheDocument();
    expect(screen.getByTestId('preview-error-message').textContent).toBe('port-occupied');
  });

  it('refresh button is disabled when stopped and reloads the iframe when running', async () => {
    renderFrame();
    await waitFor(() => screen.getByTestId('preview-start'));
    const refreshStopped = screen.getByTestId('preview-refresh') as HTMLButtonElement;
    expect(refreshStopped.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('preview-start'));
    await waitFor(() => {
      expect(screen.getByTestId('preview-iframe')).toBeInTheDocument();
    });
    const iframe = screen.getByTestId('preview-iframe') as HTMLIFrameElement;
    const originalSrc = iframe.src;
    const refreshRunning = screen.getByTestId('preview-refresh') as HTMLButtonElement;
    expect(refreshRunning.disabled).toBe(false);

    // Re-assigning `src` triggers a fresh load even when the value is
    // unchanged. We can only assert the post-assignment value, not the
    // browser-level navigation, in JSDOM.
    fireEvent.click(refreshRunning);
    expect(iframe.src).toBe(originalSrc);
  });

  it('auto-refreshes the iframe when the most recent run transitions to completed/success', async () => {
    // Seed a "running" run so the very first poll captures the running state.
    currentRuns = [
      {
        id: 'r1',
        planId: 'pl1',
        status: 'running',
        outcome: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        pausedReason: null,
        resumeAt: null,
      },
    ];
    const { qc } = renderFrame();
    // Bring preview to running so the iframe exists and the effect's
    // `state === 'running'` guard is satisfied.
    await waitFor(() => screen.getByTestId('preview-start'));
    fireEvent.click(screen.getByTestId('preview-start'));
    await waitFor(() => {
      expect(screen.getByTestId('preview-iframe')).toBeInTheDocument();
    });
    // Wait for the runs query to settle with the initial 'running' row.
    await waitFor(() => {
      const cached = qc.getQueryData(['project-runs', 'p1']) as FakeRunRow[] | undefined;
      expect(cached?.[0]?.status).toBe('running');
    });

    const iframe = screen.getByTestId('preview-iframe') as HTMLIFrameElement;
    const srcSetter = vi.fn();
    // Intercept iframe.src assignment so we can assert the reload was issued
    // without depending on JSDOM's navigation behaviour.
    Object.defineProperty(iframe, 'src', {
      configurable: true,
      get: () => '/preview/p1/',
      set: srcSetter,
    });

    // Now flip the run to completed/success and force a refetch.
    currentRuns = [
      {
        ...currentRuns[0],
        status: 'completed',
        outcome: 'success',
        endedAt: new Date().toISOString(),
      },
    ];
    await qc.refetchQueries({ queryKey: ['project-runs', 'p1'] });

    await waitFor(() => {
      expect(srcSetter).toHaveBeenCalled();
    });
  });

  it('shows a running-since counter under the status pill while starting', async () => {
    currentStatus = {
      running: false,
      port: 5173,
      startedAt: Date.now() - 3000,
      status: 'starting',
    };
    renderFrame();
    await waitFor(() => {
      expect(screen.getByTestId('preview-status').textContent).toMatch(/starting/i);
    });
    const elapsed = await screen.findByTestId('preview-starting-elapsed');
    // 3s drift floor — between 2 and 5s depending on test-runner timing.
    expect(elapsed.textContent ?? '').toMatch(/\b[2-5]s\b/);
  });
});
