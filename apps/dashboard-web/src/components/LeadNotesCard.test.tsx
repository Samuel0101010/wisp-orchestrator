import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LeadNotesCard } from './LeadNotesCard';

const originalFetch = globalThis.fetch;

interface FakeProject {
  id: string;
  name: string;
  goal: string;
  repoPath: string;
  leadEnabled: boolean;
  packageTarget: string;
  artifactPath: string | null;
}

interface FakeNote {
  id: string;
  projectId: string;
  runId: string | null;
  summaryMd: string;
  decisionsJson: {
    nextRole?: string | null;
    blockers?: string[];
    recommendedAction?: 'continue' | 'replan' | 'wait-for-user';
  } | null;
  triggeredRunId: null;
  createdAt: number;
}

let project: FakeProject;
let notes: FakeNote[];
let lastTickBody = '';

beforeEach(() => {
  project = {
    id: 'p1',
    name: 'lead',
    goal: 'g',
    repoPath: '/tmp/x',
    leadEnabled: false,
    packageTarget: 'web',
    artifactPath: null,
  };
  notes = [];
  lastTickBody = '';
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url === '/api/projects/p1' && method === 'GET') {
      return new Response(JSON.stringify(project), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/projects/p1' && method === 'PATCH') {
      const body = JSON.parse(init!.body as string) as Partial<FakeProject>;
      project = { ...project, ...body };
      return new Response(JSON.stringify(project), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('/api/projects/p1/lead/notes') && method === 'GET') {
      return new Response(JSON.stringify(notes), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/projects/p1/lead/tick' && method === 'POST') {
      lastTickBody = (init?.body as string) ?? '';
      const newNote: FakeNote = {
        id: `n-${notes.length + 1}`,
        projectId: 'p1',
        runId: null,
        summaryMd: 'Synthesised note text',
        decisionsJson: {
          nextRole: 'frontend-dev',
          recommendedAction: 'continue',
          blockers: [],
        },
        triggeredRunId: null,
        createdAt: Date.now(),
      };
      notes = [newNote, ...notes];
      return new Response(
        JSON.stringify({
          noteId: newNote.id,
          summary: newNote.summaryMd,
          decision: newNote.decisionsJson,
          parseError: null,
          tokensIn: 100,
          tokensOut: 50,
          durationMs: 100,
          failed: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LeadNotesCard projectId="p1" />
    </QueryClientProvider>,
  );
}

describe('LeadNotesCard', () => {
  it('renders the Activate button when leadEnabled=false', async () => {
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId('lead-activate')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('lead-tick-button')).toBeNull();
    expect(screen.getByTestId('lead-notes-empty')).toBeInTheDocument();
  });

  it('renders existing notes with the recommendedAction badge', async () => {
    project.leadEnabled = true;
    notes = [
      {
        id: 'pre-existing',
        projectId: 'p1',
        runId: null,
        summaryMd: 'Older note',
        decisionsJson: { recommendedAction: 'replan', blockers: ['flaky tests'] },
        triggeredRunId: null,
        createdAt: Date.now() - 1000,
      },
    ];
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId('lead-tick-button')).toBeInTheDocument();
    });
    expect(screen.getByTestId('lead-note-pre-existing')).toBeInTheDocument();
    expect(screen.getByTestId('lead-decision-replan')).toBeInTheDocument();
  });

  it('clicking Tick triggers POST and renders the new note', async () => {
    project.leadEnabled = true;
    renderCard();
    await waitFor(() => screen.getByTestId('lead-tick-button'));
    fireEvent.click(screen.getByTestId('lead-tick-button'));
    await waitFor(() => {
      expect(notes).toHaveLength(1);
    });
    // The tick request body is an empty object (no runId supplied).
    expect(lastTickBody).toBe('{}');
    await waitFor(() => {
      expect(screen.getByTestId('lead-decision-continue')).toBeInTheDocument();
    });
  });
});
