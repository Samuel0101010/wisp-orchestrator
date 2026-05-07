import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { TopBar } from './TopBar';
import { useRunStore } from '@/store/run';
import type { Run, Task } from '@agent-harness/schemas';

vi.mock('@/api/client', () => ({
  apiFetch: vi.fn(async () => ({ totalLast24h: 0, byProject: {} })),
  ApiError: class ApiError extends Error {},
}));

function withProviders(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
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

beforeEach(() => {
  useRunStore.getState().reset(null);
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
    expect(screen.getByTestId('topbar-home')).toHaveTextContent(/mission control/i);
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
    expect(screen.getByTestId('topbar-run-status')).toHaveTextContent('running');
    expect(screen.getByTestId('topbar-time-bar')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-turns-bar')).toBeInTheDocument();
    // 200 + 50 = 250 tokens.
    expect(screen.getByTestId('topbar-tokens')).toHaveTextContent('250');
  });
});
