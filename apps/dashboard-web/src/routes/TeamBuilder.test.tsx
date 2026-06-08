import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  TeamBuilder,
  specToDraft,
  draftToSpec,
  buildRoleFromAgent,
  MAX_ROLES,
} from './TeamBuilder';
import type { Agent, AgentSpec } from '@wisp/schemas';

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
    return fetchHandler(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderAt(path: string, routePath = '/projects/:projectId/teams') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={routePath} element={<TeamBuilder />} />
            <Route path="/" element={<TeamBuilder />} />
            <Route path="/projects/:projectId/plan" element={<div>Plan Page</div>} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('TeamBuilder', () => {
  it('renders empty state when no projectId', () => {
    renderAt('/', '/projects/:projectId/teams');
    expect(screen.getByText('Select a project to configure its team.')).toBeInTheDocument();
  });

  it('shows defaults when no team exists', async () => {
    fetchHandler = (url) => {
      if (url.endsWith('/team')) {
        return new Response(JSON.stringify({ error: 'team not found' }), { status: 404 });
      }
      // project lookup
      return new Response(
        JSON.stringify({ id: 'p1', name: 'My Project', goal: 'g', repoPath: '/r' }),
        { status: 200 },
      );
    };
    renderAt('/projects/p1/teams');
    await waitFor(() => {
      expect(screen.getByTestId('badge-architect')).toHaveTextContent('opus');
      expect(screen.getByTestId('badge-developer')).toHaveTextContent('sonnet');
      expect(screen.getByTestId('badge-qa')).toHaveTextContent('sonnet');
    });
  });

  it('populates fields from existing team', async () => {
    const FILLER = 'x'.repeat(80);
    fetchHandler = (url) => {
      if (url.endsWith('/team')) {
        return new Response(
          JSON.stringify({
            roles: [
              {
                role: 'architect',
                model: 'haiku',
                allowedTools: ['Read'],
                systemPrompt: `arch ${FILLER}`,
              },
              {
                role: 'developer',
                model: 'sonnet',
                allowedTools: ['Edit'],
                systemPrompt: `dev ${FILLER}`,
              },
              {
                role: 'qa',
                model: 'sonnet',
                allowedTools: ['Read'],
                systemPrompt: `qa ${FILLER}`,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: 'p1', name: 'P1', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderAt('/projects/p1/teams');
    await waitFor(() => {
      expect(screen.getByTestId('badge-architect')).toHaveTextContent('haiku');
    });
    expect((screen.getByTestId('model-architect') as HTMLSelectElement).value).toBe('haiku');
  });

  it('disables save when systemPrompt < 50 chars and shows red counter', async () => {
    fetchHandler = (url) => {
      if (url.endsWith('/team')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ id: 'p1', name: 'P1', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderAt('/projects/p1/teams');
    await waitFor(() => {
      expect(screen.getByTestId('badge-architect')).toBeInTheDocument();
    });

    // Index 0 = architect (first card), use getAllByLabelText for 'System prompt'
    const archPrompt = screen.getAllByLabelText('System prompt')[0] as HTMLTextAreaElement;
    fireEvent.change(archPrompt, { target: { value: 'too short' } });

    const saveBtn = screen.getByRole('button', { name: /save team/i });
    expect(saveBtn).toBeDisabled();

    const counter = screen.getByTestId('prompt-count-architect');
    expect(counter.className).toMatch(/destructive/);
  });

  it('saves with the correct payload when valid', async () => {
    let putBody: unknown = null;
    fetchHandler = (url, init) => {
      if (url.endsWith('/team') && init?.method === 'PUT') {
        putBody = init.body ? JSON.parse(String(init.body)) : null;
        return new Response(String(init.body), { status: 200 });
      }
      if (url.endsWith('/team')) {
        return new Response('{}', { status: 404 });
      }
      return new Response(JSON.stringify({ id: 'p1', name: 'P1', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderAt('/projects/p1/teams');
    await waitFor(() => {
      expect(screen.getByTestId('badge-architect')).toBeInTheDocument();
    });
    const saveBtn = screen.getByRole('button', { name: /save team/i });
    expect(saveBtn).toBeEnabled();
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(putBody).not.toBeNull();
    });
    const body = putBody as { roles: { role: string; model: string }[] };
    const byRole = (r: string) => body.roles.find((a) => a.role === r)!;
    expect(byRole('architect').role).toBe('architect');
    expect(byRole('architect').model).toBe('opus');
    expect(byRole('developer').model).toBe('sonnet');
    expect(byRole('qa').role).toBe('qa');
  });

  it('add role appends a new card up to the cap', async () => {
    fetchHandler = (url) => {
      if (url.endsWith('/team')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ id: 'p1', name: 'P1', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderAt('/projects/p1/teams');
    await waitFor(() => expect(screen.getByTestId('badge-architect')).toBeInTheDocument());
    const addBtn = screen.getByTestId('add-role');
    // Default team has 3; click until the user-pickable cap is reached.
    for (let i = 0; i < MAX_ROLES - 3; i++) fireEvent.click(addBtn);
    expect(addBtn).toBeDisabled();
    expect(addBtn.textContent).toContain(`(${MAX_ROLES}/${MAX_ROLES})`);
  });

  it('remove button removes the card and is disabled when only one role remains', async () => {
    fetchHandler = (url) => {
      if (url.endsWith('/team')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ id: 'p1', name: 'P1', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderAt('/projects/p1/teams');
    await waitFor(() => expect(screen.getByTestId('badge-architect')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('remove-architect'));
    await waitFor(() => expect(screen.queryByTestId('badge-architect')).toBeNull());
    // Remove until one left.
    fireEvent.click(screen.getByTestId('remove-developer'));
    // Now only qa remains; its remove button should be disabled.
    expect(screen.getByTestId('remove-qa')).toBeDisabled();
  });

  it('flags duplicate role names and blocks save', async () => {
    fetchHandler = (url) => {
      if (url.endsWith('/team')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ id: 'p1', name: 'P1', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderAt('/projects/p1/teams');
    await waitFor(() => expect(screen.getByTestId('badge-architect')).toBeInTheDocument());
    const devRoleInput = screen.getByTestId('role-name-1') as HTMLInputElement;
    fireEvent.change(devRoleInput, { target: { value: 'architect' } });
    const saveBtn = screen.getByRole('button', { name: /save team/i });
    expect(saveBtn).toBeDisabled();
  });

  it('renders a drag handle per role for dnd-kit reordering', async () => {
    fetchHandler = (url) => {
      if (url.endsWith('/team')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ id: 'p1', name: 'P1', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderAt('/projects/p1/teams');
    await waitFor(() => expect(screen.getByTestId('badge-architect')).toBeInTheDocument());
    expect(screen.getByTestId('drag-handle-0')).toBeInTheDocument();
    expect(screen.getByTestId('drag-handle-1')).toBeInTheDocument();
    expect(screen.getByTestId('drag-handle-2')).toBeInTheDocument();
    // Default team is 3 roles, so no handle-3 yet.
    expect(screen.queryByTestId('drag-handle-3')).toBeNull();
  });

  it('reorders roles via the move-up / move-down arrows', async () => {
    fetchHandler = (url) => {
      if (url.endsWith('/team')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ id: 'p1', name: 'P1', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderAt('/projects/p1/teams');
    await waitFor(() => expect(screen.getByTestId('badge-architect')).toBeInTheDocument());
    // Default order: architect (0), developer (1), qa (2). Move developer up.
    fireEvent.click(screen.getByTestId('move-up-1'));
    // Now first role-name input should hold 'developer'.
    const first = screen.getByTestId('role-name-0') as HTMLInputElement;
    expect(first.value).toBe('developer');
    // Move first (developer) back down.
    fireEvent.click(screen.getByTestId('move-down-0'));
    expect((screen.getByTestId('role-name-0') as HTMLInputElement).value).toBe('architect');
  });

  it('disables Generate Plan when team is unsaved (dirty/missing)', async () => {
    fetchHandler = (url) => {
      if (url.endsWith('/team')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ id: 'p1', name: 'P1', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderAt('/projects/p1/teams');
    await waitFor(() => expect(screen.getByTestId('badge-architect')).toBeInTheDocument());
    const generate = screen.getByTestId('generate-plan');
    expect(generate).toBeDisabled();
    expect(generate.getAttribute('title') ?? '').toMatch(/save the team first/i);
  });

  // The brief gate: even with a SAVED, valid team, Generate Plan stays blocked
  // until the interview brief is finalised. A saved team returns roles from /team
  // (teamExists && !dirty), and /interview drives the briefBlocks flag.
  const savedTeamRoles = (() => {
    const FILLER = 'x'.repeat(80);
    return [
      { role: 'architect', model: 'opus', allowedTools: ['Read'], systemPrompt: `arch ${FILLER}` },
      { role: 'developer', model: 'sonnet', allowedTools: ['Edit'], systemPrompt: `dev ${FILLER}` },
      { role: 'qa', model: 'sonnet', allowedTools: ['Read'], systemPrompt: `qa ${FILLER}` },
    ];
  })();

  const savedTeamWithBrief =
    (briefReady: boolean) =>
    (url: string): Response => {
      if (url.endsWith('/interview')) {
        return new Response(JSON.stringify({ brief: { briefReady }, transcript: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/team')) {
        return new Response(JSON.stringify({ roles: savedTeamRoles }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'p1', name: 'P1', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };

  it('disables Generate Plan when the team is saved but the brief is NOT ready', async () => {
    fetchHandler = savedTeamWithBrief(false);
    renderAt('/projects/p1/teams');
    await waitFor(() => expect(screen.getByTestId('badge-architect')).toBeInTheDocument());
    const generate = screen.getByTestId('generate-plan');
    // Team is saved (not dirty) and valid, so the only thing blocking is the brief gate.
    await waitFor(() => expect(generate).toBeDisabled());
    expect(generate.getAttribute('title') ?? '').toMatch(/brief/i);
  });

  it('enables Generate Plan when the team is saved AND the brief is ready', async () => {
    fetchHandler = savedTeamWithBrief(true);
    renderAt('/projects/p1/teams');
    await waitFor(() => expect(screen.getByTestId('badge-architect')).toBeInTheDocument());
    const generate = screen.getByTestId('generate-plan');
    await waitFor(() => expect(generate).toBeEnabled());
  });

  it('saves a 4-role team with custom role names', async () => {
    let putBody: unknown = null;
    fetchHandler = (url, init) => {
      if (url.endsWith('/team') && init?.method === 'PUT') {
        putBody = init.body ? JSON.parse(String(init.body)) : null;
        return new Response(String(init.body), { status: 200 });
      }
      if (url.endsWith('/team')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ id: 'p1', name: 'P1', goal: 'g', repoPath: '/r' }), {
        status: 200,
      });
    };
    renderAt('/projects/p1/teams');
    await waitFor(() => expect(screen.getByTestId('badge-architect')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('add-role'));
    // Fourth card should now be present at index 3 (role name empty).
    const newRole = screen.getByTestId('role-name-3') as HTMLInputElement;
    fireEvent.change(newRole, { target: { value: 'reviewer' } });
    const newPrompt = screen.getAllByLabelText('System prompt')[3] as HTMLTextAreaElement;
    fireEvent.change(newPrompt, {
      target: {
        value: 'reviewer system prompt long enough to satisfy the 50 char minimum easily.',
      },
    });
    const saveBtn = screen.getByRole('button', { name: /save team/i });
    await waitFor(() => expect(saveBtn).toBeEnabled());
    fireEvent.click(saveBtn);
    await waitFor(() => expect(putBody).not.toBeNull());
    const body = putBody as { roles: { role: string }[] };
    expect(body.roles).toHaveLength(4);
    expect(body.roles[3]!.role).toBe('reviewer');
  });

  // Regression for the silent agentId data-loss bug: a team created from chat
  // carries an agentId soft-link per role; the draft round-trip used to drop it,
  // severing the link on every re-save.
  it('round-trips a role agentId through specToDraft → draftToSpec', () => {
    const spec: AgentSpec = {
      role: 'architect',
      model: 'opus',
      allowedTools: ['Read'],
      systemPrompt: 'x'.repeat(60),
      agentId: 'agent-architect-1',
    };
    expect(specToDraft(spec).agentId).toBe('agent-architect-1');
    expect(draftToSpec(specToDraft(spec)).agentId).toBe('agent-architect-1');
  });

  it('does not invent an agentId for a role that has none', () => {
    const spec: AgentSpec = {
      role: 'developer',
      model: 'sonnet',
      allowedTools: [],
      systemPrompt: 'y'.repeat(60),
    };
    const round = draftToSpec(specToDraft(spec));
    expect(round.agentId).toBeUndefined();
    expect('agentId' in round).toBe(false);
  });

  // The built-in-agent picker (finding #6): a registry agent becomes a team
  // role, copying model/tools/prompt by value and keeping the agentId link.
  it('buildRoleFromAgent copies the agent and keeps the agentId soft-link', () => {
    const agent: Agent = {
      id: 'agent-maya-1',
      name: 'Maya',
      model: 'opus',
      systemPrompt: 'You are Maya, product designer.'.padEnd(60, ' '),
      allowedTools: ['Read', 'Grep'],
      seedKey: 'designer',
      createdAt: 0,
      updatedAt: 0,
    };
    const role = buildRoleFromAgent(agent, []);
    expect(role.role).toBe('designer');
    expect(role.model).toBe('opus');
    expect(role.allowedTools).toEqual(['Read', 'Grep']);
    expect(role.agentId).toBe('agent-maya-1');
  });

  it('buildRoleFromAgent de-duplicates the role name and slugifies a name without a seedKey', () => {
    const agent: Agent = {
      id: 'agent-x',
      name: 'Custom Helper!',
      model: 'sonnet',
      systemPrompt: 'z'.repeat(60),
      allowedTools: [],
      createdAt: 0,
      updatedAt: 0,
    };
    const role = buildRoleFromAgent(agent, ['custom-helper', 'custom-helper-2']);
    // slugified from the name (no seedKey) and bumped past the existing two.
    expect(role.role).toBe('custom-helper-3');
    // empty tool list falls back to a safe default.
    expect(role.allowedTools).toEqual(['Read']);
  });
});
