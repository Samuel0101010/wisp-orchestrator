import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ReactNode } from 'react';
import { TopBar } from './TopBar';
import { useRunStore } from '@/store/run';
import type { Run, Task } from '@wisp/schemas';

const globalRunsResponse = {
  runs: [
    {
      id: 'r-1',
      planId: 'p-1',
      status: 'running',
      outcome: null,
      startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      endedAt: null,
      budgetMinutes: 10,
      budgetTurns: 100,
      tokensInTotal: 0,
      tokensOutTotal: 0,
      turnsTotal: 0,
      pausedReason: null,
      resumeAt: null,
      projectId: 'proj-a',
      projectName: 'Alpha',
    },
    {
      id: 'r-2',
      planId: 'p-2',
      status: 'completed',
      outcome: 'success',
      startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      endedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      budgetMinutes: 10,
      budgetTurns: 100,
      tokensInTotal: 0,
      tokensOutTotal: 0,
      turnsTotal: 0,
      pausedReason: null,
      resumeAt: null,
      projectId: 'proj-b',
      projectName: 'Beta',
    },
  ],
};

vi.mock('@/api/client', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path.startsWith('/api/runs')) return globalRunsResponse;
    return { totalLast24h: 0, byProject: {} };
  }),
  ApiError: class ApiError extends Error {},
}));

function withProviders(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  );
}

function buildRun(): Run {
  return {
    id: 'run-1',
    planId: 'plan-1',
    status: 'running',
    startedAt: new Date(Date.now() - 60_000),
    endedAt: null,
    outcome: null,
    budgetMinutes: 10,
    budgetTurns: 100,
    maxParallel: 3,
    tokensInTotal: 0,
    tokensOutTotal: 0,
    turnsTotal: 0,
    pausedReason: null,
    resumeAt: null,
  } as unknown as Run;
}

function buildTask(): Task {
  return {
    id: 'a',
    planId: 'plan-1',
    role: 'developer',
    title: 'a',
    deps: [],
    status: 'running',
    worktreeBranch: null,
    sessionId: null,
    tokensIn: 200,
    tokensOut: 50,
    turnsUsed: 5,
    durationMs: 0,
  };
}

beforeEach(async () => {
  useRunStore.getState().reset(null);
  const { apiFetch } = await import('@/api/client');
  const mockedFetch = vi.mocked(apiFetch);
  mockedFetch.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/runs')) return globalRunsResponse;
    return { totalLast24h: 0, byProject: {} };
  });
});

afterEach(() => {
  useRunStore.getState().reset(null);
});

describe('TopBar', () => {
  it('renders the mission control crumb when no run view is mounted', () => {
    render(
      withProviders(
        <MemoryRouter initialEntries={['/']}>
          <TopBar />
        </MemoryRouter>,
      ),
    );
    expect(screen.getByTestId('breadcrumbs')).toHaveTextContent(/mission control/i);
  });

  it('mirrors resource bar info when on the RunView route with a hydrated run', () => {
    act(() => {
      useRunStore.getState().hydrate({ run: buildRun(), tasks: [buildTask()] });
    });
    render(
      withProviders(
        <MemoryRouter initialEntries={['/projects/p1/run/run-1']}>
          <TopBar />
        </MemoryRouter>,
      ),
    );
    expect(screen.getByTestId('topbar-run-active')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-run-status')).toHaveTextContent('Running');
    expect(screen.getByTestId('topbar-time-bar')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-turns-bar')).toBeInTheDocument();
    // 200 + 50 = 250 tokens.
    expect(screen.getByTestId('topbar-tokens')).toHaveTextContent('250');
  });

  it('opens the notifications popover and lists recent runs on bell click', async () => {
    render(
      withProviders(
        <MemoryRouter initialEntries={['/']}>
          <TopBar />
        </MemoryRouter>,
      ),
    );
    expect(screen.queryByTestId('notifications-popover')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('topbar-notifications-trigger'));
    expect(screen.getByTestId('notifications-popover')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('notification-row-r-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('notification-row-r-2')).toBeInTheDocument();
    expect(screen.getByTestId('notifications-popover-view-all')).toBeInTheDocument();
  });

  it('shows the empty state when there are no recent runs', async () => {
    const { apiFetch } = await import('@/api/client');
    const mockedFetch = vi.mocked(apiFetch);
    mockedFetch.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/runs')) return { runs: [] };
      return { totalLast24h: 0, byProject: {} };
    });
    render(
      withProviders(
        <MemoryRouter initialEntries={['/']}>
          <TopBar />
        </MemoryRouter>,
      ),
    );
    fireEvent.click(screen.getByTestId('topbar-notifications-trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('notifications-popover-empty')).toBeInTheDocument();
    });
  });
});
