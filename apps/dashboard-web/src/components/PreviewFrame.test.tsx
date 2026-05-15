import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

let currentStatus: FakeStatus = { running: false };
let startCalls = 0;

beforeEach(() => {
  currentStatus = { running: false };
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
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderFrame() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PreviewFrame projectId="p1" />
    </QueryClientProvider>,
  );
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
});
