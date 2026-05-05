import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TeamBuilder } from './TeamBuilder';

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
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={<TeamBuilder />} />
          <Route path="/" element={<TeamBuilder />} />
          <Route path="/projects/:projectId/plan" element={<div>Plan Page</div>} />
        </Routes>
      </MemoryRouter>
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
            architect: {
              role: 'architect',
              model: 'haiku',
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
    expect(
      (screen.getByLabelText('Model', { selector: '#architect-model' }) as HTMLInputElement).value,
    ).toBe('haiku');
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

    const archPrompt = screen.getByLabelText('System prompt', {
      selector: '#architect-prompt',
    }) as HTMLTextAreaElement;
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
    const body = putBody as {
      architect: { role: string; model: string };
      developer: { role: string; model: string };
      qa: { role: string; model: string };
    };
    expect(body.architect.role).toBe('architect');
    expect(body.architect.model).toBe('opus');
    expect(body.developer.model).toBe('sonnet');
    expect(body.qa.role).toBe('qa');
  });
});
