import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HarnessEvent, Run, Task } from '@agent-harness/schemas';
import { RunView } from './RunView';
import { useRunStore } from '@/store/run';
import { TooltipProvider } from '@/components/ui/tooltip';

// ---------- mock the WS hook so the test owns the event stream ----------
let pushEvent: ((ev: HarnessEvent) => void) | null = null;
vi.mock('@/api/ws', () => {
  return {
    useRunEvents: () => {
      const [events, setEvents] = useState<HarnessEvent[]>([]);
      pushEvent = (ev: HarnessEvent) => setEvents((prev) => [...prev, ev]);
      return { events, status: 'open' as const };
    },
  };
});

const originalFetch = globalThis.fetch;

interface FetchHandler {
  (url: string, init?: RequestInit): Response | Promise<Response>;
}

let fetchHandler: FetchHandler;
let postCalls: { url: string; method?: string }[] = [];

beforeEach(() => {
  postCalls = [];
  fetchHandler = () => new Response('{}', { status: 404 });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method && init.method !== 'GET') postCalls.push({ url, method: init.method });
    // Badge chain query: return single-entry chain so badge renders nothing.
    if (url.endsWith('/chain')) {
      return new Response(
        JSON.stringify({
          chain: [{ id: 'plan-1', parentPlanId: null, status: 'running', createdAt: null }],
        }),
        { status: 200 },
      );
    }
    return fetchHandler(url, init);
  }) as typeof fetch;
  useRunStore.getState().reset(null);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  pushEvent = null;
});

function buildRun(over: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    planId: 'plan-1',
    status: 'running',
    startedAt: new Date(Date.now() - 30_000),
    endedAt: null,
    outcome: null,
    budgetMinutes: 60,
    budgetTurns: 100,
    maxParallel: 3,
    tokensInTotal: 0,
    tokensOutTotal: 0,
    turnsTotal: 0,
    pausedReason: null,
    resumeAt: null,
    ...over,
  } as unknown as Run;
}

function buildTasks(): Task[] {
  return [
    {
      id: 't-pending',
      planId: 'plan-1',
      role: 'architect',
      title: 'design',
      deps: [],
      status: 'pending',
      worktreeBranch: null,
      sessionId: null,
      tokensIn: 0,
      tokensOut: 0,
      turnsUsed: 0,
      durationMs: 0,
    },
    {
      id: 't-done',
      planId: 'plan-1',
      role: 'developer',
      title: 'impl',
      deps: ['t-pending'],
      status: 'done',
      worktreeBranch: null,
      sessionId: null,
      tokensIn: 1000,
      tokensOut: 200,
      turnsUsed: 5,
      durationMs: 12_345,
    },
    {
      id: 't-failed',
      planId: 'plan-1',
      role: 'qa',
      title: 'verify',
      deps: ['t-done'],
      status: 'failed',
      worktreeBranch: null,
      sessionId: null,
      tokensIn: 0,
      tokensOut: 0,
      turnsUsed: 0,
      durationMs: 0,
    },
  ];
}

function snapshot(run: Run = buildRun(), tasks: Task[] = buildTasks()) {
  return { run, tasks, lastCheckpoint: null };
}

function renderRunView(path = '/projects/p1/run/run-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/projects/:projectId/run/:runId" element={<RunView />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('RunView', () => {
  it('places tasks into the right kanban columns based on snapshot status', async () => {
    fetchHandler = (url) => {
      if (/\/api\/runs\/run-1$/.test(url)) {
        return new Response(JSON.stringify(snapshot()), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };
    renderRunView();

    expect(await screen.findByTestId('task-card-t-pending')).toBeInTheDocument();
    const pendingCol = screen.getByTestId('kanban-column-pending');
    const doneCol = screen.getByTestId('kanban-column-done');
    const failedCol = screen.getByTestId('kanban-column-failed');
    expect(pendingCol).toContainElement(screen.getByTestId('task-card-t-pending'));
    expect(doneCol).toContainElement(screen.getByTestId('task-card-t-done'));
    expect(failedCol).toContainElement(screen.getByTestId('task-card-t-failed'));
  });

  it('updates token and turns counters when WS pushes events', async () => {
    fetchHandler = (url) => {
      if (/\/api\/runs\/run-1$/.test(url)) {
        return new Response(JSON.stringify(snapshot()), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };
    renderRunView();
    await screen.findByTestId('task-card-t-pending');

    // Push a task.usage event for an existing task.
    act(() => {
      pushEvent?.({
        type: 'task.usage',
        payload: { taskId: 't-pending', tokensIn: 500, tokensOut: 200, turns: 3 },
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId('task-tokens-t-pending')).toHaveTextContent('500 / 200'),
    );
    expect(screen.getByTestId('task-turns-t-pending')).toHaveTextContent('3');
    // Resource bar reflects total turns.
    expect(screen.getByTestId('resource-turns')).toHaveTextContent(/8 \/ 100/); // 5 + 3
  });

  it('Pause button calls /pause and Cancel opens the confirm dialog', async () => {
    fetchHandler = (url, init) => {
      if (/\/api\/runs\/run-1$/.test(url) && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify(snapshot()), { status: 200 });
      }
      if (/\/api\/runs\/run-1\/pause$/.test(url)) {
        return new Response(JSON.stringify(buildRun({ status: 'paused' })), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };
    renderRunView();
    const pauseBtn = await screen.findByTestId('run-pause-button');
    fireEvent.click(pauseBtn);
    await waitFor(() => expect(postCalls.some((c) => c.url.endsWith('/pause'))).toBe(true));

    const cancelBtn = screen.getByTestId('run-cancel-button');
    fireEvent.click(cancelBtn);
    expect(await screen.findByTestId('run-cancel-dialog')).toBeInTheDocument();
  });

  it('shows a rate-limit countdown when run.paused with rate-limit and future resumeAt', async () => {
    fetchHandler = (url) => {
      if (/\/api\/runs\/run-1$/.test(url)) {
        return new Response(JSON.stringify(snapshot()), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };
    renderRunView();
    await screen.findByTestId('task-card-t-pending');

    const future = Date.now() + 75 * 60_000; // 1h 15min in the future
    act(() => {
      pushEvent?.({
        type: 'run.paused',
        payload: { runId: 'run-1', pausedReason: 'rate-limit', resumeAt: future },
      });
    });

    expect(await screen.findByTestId('rate-limit-banner')).toBeInTheDocument();
    expect(screen.getByTestId('countdown')).toHaveTextContent(/01:1[45]:\d{2}/);
    expect(screen.getByTestId('rate-limit-resume-now')).toBeEnabled();
  });

  it('shows "Run not found" when GET /api/runs/:id returns 404', async () => {
    fetchHandler = () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    renderRunView();
    expect(await screen.findByTestId('run-not-found')).toBeInTheDocument();
  });
});
