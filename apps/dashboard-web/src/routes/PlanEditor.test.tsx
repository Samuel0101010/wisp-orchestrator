import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Plan } from '@wisp/schemas';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ToastViewportRoot } from '@/components/ui/use-toast';
import { PlanEditor } from './PlanEditor';

// Replace the heavy React Flow canvas with a thin div-based stub. Tests only
// care about node selection plumbing, not React Flow's rendering.
vi.mock('@/components/plan/PlanCanvas', () => ({
  PlanCanvas: ({
    plan,
    onSelectNode,
  }: {
    plan: Plan;
    selectedNodeId: string | null;
    onSelectNode: (id: string | null) => void;
  }) => (
    <div data-testid="plan-canvas">
      {plan.nodes.map((n) => (
        <button
          key={n.id}
          type="button"
          data-testid={`plan-node-${n.id}`}
          onClick={() => onSelectNode(n.id)}
        >
          {n.id} — {n.role}
        </button>
      ))}
    </div>
  ),
}));

const FILLER = 'x'.repeat(80);

function buildPlan(): Plan {
  return {
    goal: 'g',
    team: {
      architect: {
        role: 'architect',
        model: 'opus',
        allowedTools: ['Read'],
        systemPrompt: `arch ${FILLER}`,
      },
      developer: {
        role: 'developer',
        model: 'sonnet',
        allowedTools: ['Edit'],
        systemPrompt: `dev ${FILLER}`,
      },
      qa: {
        role: 'qa',
        model: 'sonnet',
        allowedTools: ['Read'],
        systemPrompt: `qa ${FILLER}`,
      },
    },
    nodes: [
      {
        id: 'a',
        role: 'architect',
        prompt: 'design',
        deps: [],
        successCriteria: { build: 'pnpm build' },
        maxTurns: 10,
      },
      {
        id: 'b',
        role: 'developer',
        prompt: 'implement',
        deps: ['a'],
        successCriteria: { test: 'pnpm test' },
        maxTurns: 30,
      },
      {
        id: 'c',
        role: 'qa',
        prompt: 'validate',
        deps: ['b'],
        successCriteria: { lint: 'pnpm lint' },
        maxTurns: 10,
      },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ],
  };
}

const originalFetch = globalThis.fetch;

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let fetchCalls: FetchCall[] = [];
let fetchHandler: (url: string, init?: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
  fetchCalls = [];
  fetchHandler = () => new Response('{}', { status: 404 });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url, init });
    // Badge chain query: return single-entry chain so badge renders nothing.
    if (url.endsWith('/chain')) {
      return new Response(
        JSON.stringify({
          chain: [{ id: 'plan-1', parentPlanId: null, status: 'draft', createdAt: null }],
        }),
        { status: 200 },
      );
    }
    return fetchHandler(url, init);
  }) as typeof fetch;
  // Pre-acknowledge first-run modal so existing tests bypass the new gate.
  localStorage.setItem('agent-harness:first-run-ack-v1', '1');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  localStorage.clear();
});

function renderEditor(projectId = 'p1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/projects/${projectId}/plan`]}>
          <Routes>
            <Route path="/projects/:projectId/plan" element={<PlanEditor />} />
          </Routes>
          <ToastViewportRoot />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function planRowResponse(
  plan: Plan,
  status: 'draft' | 'locked' | 'running' | 'done' | 'failed' = 'draft',
): Record<string, unknown> {
  return {
    id: 'plan-1',
    projectId: 'p1',
    status,
    dagJson: plan,
  };
}

describe('PlanEditor', () => {
  it('renders nodes from a fake plan response', async () => {
    const plan = buildPlan();
    fetchHandler = (url) => {
      if (url.endsWith('/plan')) {
        return new Response(JSON.stringify(planRowResponse(plan)), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'p1', name: 'Proj', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderEditor();
    expect(await screen.findByTestId('plan-node-a')).toBeInTheDocument();
    expect(screen.getByTestId('plan-node-b')).toBeInTheDocument();
    expect(screen.getByTestId('plan-node-c')).toBeInTheDocument();
    expect(screen.getByTestId('plan-status')).toHaveTextContent('Draft');
  });

  it('selecting a node opens the side panel', async () => {
    const plan = buildPlan();
    fetchHandler = (url) => {
      if (url.endsWith('/plan')) {
        return new Response(JSON.stringify(planRowResponse(plan)), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'p1', name: 'Proj', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderEditor();
    fireEvent.click(await screen.findByTestId('plan-node-a'));
    expect(await screen.findByText(/Edit node: a/)).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt')).toHaveValue('design');
  });

  it("editing a node's prompt enables Save and Save calls PATCH", async () => {
    const user = userEvent.setup();
    const plan = buildPlan();
    let patchBody: unknown = null;
    fetchHandler = (url, init) => {
      if (url.endsWith('/plan')) {
        return new Response(JSON.stringify(planRowResponse(plan)), { status: 200 });
      }
      if (init?.method === 'PATCH' && url.includes('/api/plans/plan-1')) {
        patchBody = init.body ? JSON.parse(String(init.body)) : null;
        return new Response(
          JSON.stringify({
            ...planRowResponse(plan),
            dagJson: (patchBody as { dagJson: unknown }).dagJson,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: 'p1', name: 'Proj', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderEditor();
    fireEvent.click(await screen.findByTestId('plan-node-a'));

    const saveBtn = screen.getByRole('button', { name: /save/i });
    expect(saveBtn).toBeDisabled();

    const promptField = screen.getByLabelText('Prompt') as HTMLTextAreaElement;
    await user.clear(promptField);
    await user.type(promptField, 'design v2');

    expect(saveBtn).toBeEnabled();
    expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument();

    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(patchBody).not.toBeNull();
    });
    const body = patchBody as { dagJson: Plan };
    const editedNode = body.dagJson.nodes.find((n) => n.id === 'a');
    expect(editedNode?.prompt).toBe('design v2');
  });

  it('locked plan disables editing, save, and re-generate', async () => {
    const plan = buildPlan();
    fetchHandler = (url) => {
      if (url.endsWith('/plan')) {
        return new Response(JSON.stringify(planRowResponse(plan, 'locked')), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'p1', name: 'Proj', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderEditor();
    expect(await screen.findByTestId('plan-status')).toHaveTextContent('Locked');
    fireEvent.click(screen.getByTestId('plan-node-a'));
    const promptField = await screen.findByLabelText('Prompt');
    expect(promptField).toBeDisabled();
    expect(screen.getByRole('button', { name: /re-generate/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('an invalid local edit (cycle) shows the error banner and disables Save', async () => {
    const user = userEvent.setup();
    const plan = buildPlan();
    fetchHandler = (url) => {
      if (url.endsWith('/plan')) {
        return new Response(JSON.stringify(planRowResponse(plan)), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'p1', name: 'Proj', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderEditor();
    fireEvent.click(await screen.findByTestId('plan-node-a'));
    // Add a dep on c → a cycle (a -> b -> c -> a).
    const cBox = await screen.findByLabelText('c');
    await user.click(cBox);

    expect(await screen.findByTestId('validation-banner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /lock & run/i })).toBeDisabled();
  });

  it('empty state (404) shows Generate Plan button', async () => {
    fetchHandler = (url) => {
      if (url.endsWith('/plan')) {
        return new Response(JSON.stringify({ error: 'plan not found' }), { status: 404 });
      }
      return new Response(JSON.stringify({ id: 'p1', name: 'Proj', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderEditor();
    expect(await screen.findByText('No plan yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate plan/i })).toBeInTheDocument();
  });

  it('surfaces a plan_invalid_roles 422 from generate-plan as a toast naming the roles', async () => {
    const plan = buildPlan();
    fetchHandler = (url, init) => {
      if (url.endsWith('/plan') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify(planRowResponse(plan)), { status: 200 });
      }
      if (init?.method === 'POST' && url.endsWith('/api/projects/p1/plan')) {
        return new Response(
          JSON.stringify({
            error: 'plan_invalid_roles',
            invalidRoles: ['frontend-dev', 'sec-auditor'],
            allowedRoles: ['architect', 'developer', 'qa'],
            message: 'planner emitted roles outside the team',
          }),
          { status: 422 },
        );
      }
      return new Response(JSON.stringify({ id: 'p1', name: 'Proj', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: /re-generate/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /re-generate/i }));

    // The toast must name the offending roles, not the raw error token.
    expect(await screen.findByText(/frontend-dev, sec-auditor/)).toBeInTheDocument();
    expect(screen.queryByText('plan_invalid_roles')).not.toBeInTheDocument();
  });

  it('Lock & Run on a clean draft calls the lock endpoint and toasts', async () => {
    const plan = buildPlan();
    let lockCalled = false;
    fetchHandler = (url, init) => {
      if (url.endsWith('/plan') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify(planRowResponse(plan)), { status: 200 });
      }
      if (init?.method === 'POST' && url.endsWith('/api/plans/plan-1/lock')) {
        lockCalled = true;
        return new Response(JSON.stringify(planRowResponse(plan, 'locked')), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'p1', name: 'Proj', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderEditor();
    const trigger = await screen.findByRole('button', { name: /lock & run/i });
    await waitFor(() => expect(trigger).toBeEnabled());
    fireEvent.click(trigger);
    // Confirm dialog opens; click the confirm button inside it.
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: /lock & run/i });
    fireEvent.click(confirm);
    await waitFor(() => expect(lockCalled).toBe(true));
  });
});
