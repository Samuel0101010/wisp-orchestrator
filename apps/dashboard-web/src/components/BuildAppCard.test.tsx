import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BuildAppCard } from './BuildAppCard';
import type { PackagerResult } from '@/api/queries';
import { toast } from '@/components/ui/use-toast';
import i18n from '@/i18n';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const originalFetch = globalThis.fetch;

interface FakeRun {
  id: string;
  outcome: 'success' | 'failure' | null;
}

interface State {
  runs: FakeRun[];
  pending: Array<{ id: string }>;
  artifactPath: string | null;
  recentBuild: PackagerResult | null;
  buildResponse: PackagerResult;
  buildResponseStatus: number;
  buildCalls: number;
}

let state: State;

function freshState(overrides: Partial<State> = {}): State {
  return {
    runs: [{ id: 'r1', outcome: 'success' }],
    pending: [],
    artifactPath: null,
    recentBuild: null,
    buildResponse: {
      ok: true,
      artifactPath: '/data/artifacts/p1/r1/demo.msi',
      relativeBuildPath: 'src-tauri/target/release/bundle/msi/demo.msi',
      sizeBytes: 12_345_678,
      sha256: 'a'.repeat(64),
      buildLog: 'ok',
      durationMs: 1234,
    },
    buildResponseStatus: 200,
    buildCalls: 0,
    ...overrides,
  };
}

beforeEach(() => {
  state = freshState();
  vi.mocked(toast).mockClear();
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/runs') && (!init || init.method === undefined || init.method === 'GET')) {
      return new Response(JSON.stringify(state.runs), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (
      url.includes('/change-requests') &&
      (!init || init.method === 'GET' || init.method === undefined)
    ) {
      return new Response(JSON.stringify(state.pending), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/build/status')) {
      return new Response(
        JSON.stringify({
          artifactPath: state.artifactPath,
          packageTarget: 'tauri-exe',
          recentBuild: state.recentBuild,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/build') && init?.method === 'POST') {
      state.buildCalls += 1;
      if (state.buildResponse.ok) {
        state.artifactPath = state.buildResponse.artifactPath;
      }
      state.recentBuild = state.buildResponse;
      return new Response(JSON.stringify(state.buildResponse), {
        status: state.buildResponseStatus,
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

function renderCard(packageTarget: 'web' | 'tauri-exe' = 'tauri-exe') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BuildAppCard projectId="p1" packageTarget={packageTarget} />
    </QueryClientProvider>,
  );
}

describe('BuildAppCard', () => {
  it("renders 'Native packaging disabled' copy when packageTarget is 'web'", async () => {
    renderCard('web');
    await waitFor(() => {
      expect(screen.getByTestId('build-app-card')).toBeInTheDocument();
    });
    expect(screen.getByTestId('build-status').textContent).toMatch(/Native packaging disabled/i);
    expect(screen.queryByTestId('build-app-button')).toBeNull();
  });

  it('disables Build button when pending change-requests are present', async () => {
    state = freshState({ pending: [{ id: 'cr1' }, { id: 'cr2' }] });
    renderCard('tauri-exe');
    const btn = await screen.findByTestId('build-app-button');
    await waitFor(() => {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    });
    expect(screen.getByTestId('build-error').textContent).toMatch(/2/);
  });

  it('disables Build button when no successful run exists', async () => {
    state = freshState({ runs: [{ id: 'r1', outcome: 'failure' }] });
    renderCard('tauri-exe');
    const btn = await screen.findByTestId('build-app-button');
    await waitFor(() => {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('clicking Build triggers POST /build and reveals the download button', async () => {
    renderCard('tauri-exe');
    const btn = await screen.findByTestId('build-app-button');
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => {
      expect(state.buildCalls).toBe(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId('build-app-download')).toBeInTheDocument();
    });
    // The basename of the returned artifact should render somewhere visible.
    expect(screen.getByText(/demo\.msi/)).toBeInTheDocument();
  });

  it('maps a 422 packager error from the response BODY to its localized hint (not the generic)', async () => {
    // Regression: the catch used to regex-match err.message (always the generic
    // "Request failed: …"), so every failure showed "Tauri build failed". The typed
    // code lives in ApiError.body.error.
    state = freshState({
      buildResponse: { ok: false, error: 'tauri_cli_missing' },
      buildResponseStatus: 422,
    });
    renderCard('tauri-exe');
    const btn = await screen.findByTestId('build-app-button');
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const lastArg = vi.mocked(toast).mock.calls.at(-1)?.[0] as { description?: string } | undefined;
    expect(lastArg?.description).toBe(i18n.t('buildApp.errors.tauri_cli_missing'));
    expect(lastArg?.description).not.toBe(i18n.t('buildApp.errors.tauri_build_failed'));
  });
});
