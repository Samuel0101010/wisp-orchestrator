import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BriefCard } from './BriefCard';

const originalFetch = globalThis.fetch;

interface FakeBrief {
  id: string;
  projectId: string;
  targetAudience: string | null;
  successCriteria: string | null;
  designPrefs: string | null;
  platform: string | null;
  constraints: string | null;
  deadline: number | null;
  completenessScore: number;
  prdPath: string | null;
  briefReady: boolean;
  createdAt: number;
  updatedAt: number;
}

let brief: FakeBrief = {
  id: 'b1',
  projectId: 'p1',
  targetAudience: null,
  successCriteria: null,
  designPrefs: null,
  platform: null,
  constraints: null,
  deadline: null,
  completenessScore: 0,
  prdPath: null,
  briefReady: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

let transcript: Array<{
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  authorAgentId: string | null;
}> = [];

let lastSentMessage = '';
let lastFinalize = 0;
let lastImportMarkdown: string | null = null;

function freshBrief(): FakeBrief {
  return {
    id: 'b1',
    projectId: 'p1',
    targetAudience: null,
    successCriteria: null,
    designPrefs: null,
    platform: null,
    constraints: null,
    deadline: null,
    completenessScore: 0,
    prdPath: null,
    briefReady: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

beforeEach(() => {
  brief = freshBrief();
  transcript = [];
  lastSentMessage = '';
  lastFinalize = 0;
  lastImportMarkdown = null;
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (
      url.endsWith('/interview') &&
      (!init || init.method === undefined || init.method === 'GET')
    ) {
      return new Response(JSON.stringify({ brief, transcript, threadId: 't1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/interview/message') && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as { message: string };
      lastSentMessage = body.message;
      const userMsg = {
        id: `u-${transcript.length}`,
        threadId: 't1',
        role: 'user' as const,
        content: body.message,
        createdAt: Date.now(),
        authorAgentId: null,
      };
      transcript.push(userMsg);
      brief = { ...brief, platform: 'web', completenessScore: 30 };
      const assistantMsg = {
        id: `a-${transcript.length}`,
        threadId: 't1',
        role: 'assistant' as const,
        content: 'Got it — platform is web. What is the audience?',
        createdAt: Date.now(),
        authorAgentId: 'sarah',
      };
      transcript.push(assistantMsg);
      return new Response(
        JSON.stringify({
          userMessage: userMsg,
          assistantMessage: assistantMsg,
          brief,
          shouldFinalize: false,
          parseError: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/interview/import') && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as { markdown: string };
      lastImportMarkdown = body.markdown;
      brief = { ...brief, briefReady: true, completenessScore: 100, prdPath: 'docs/PRD.md' };
      return new Response(JSON.stringify({ brief, prdPath: 'docs/PRD.md', prdWriteError: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/interview/finalize') && init?.method === 'POST') {
      lastFinalize++;
      brief = { ...brief, briefReady: true, prdPath: 'docs/PRD.md' };
      return new Response(JSON.stringify({ brief, prdPath: 'docs/PRD.md', prdWriteError: null }), {
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

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BriefCard projectId="p1" />
    </QueryClientProvider>,
  );
}

describe('BriefCard', () => {
  it('renders pending status + empty transcript on first load', async () => {
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId('brief-status-pending')).toBeInTheDocument();
    });
    expect(screen.getByTestId('brief-transcript-empty')).toBeInTheDocument();
    expect(screen.getByTestId('brief-score').textContent).toBe('0%');
  });

  it('welcoming empty state shows example chips that prefill the input', async () => {
    renderCard();
    await waitFor(() => screen.getByTestId('brief-transcript-empty'));
    const chips = screen.getAllByTestId('brief-example-chip');
    expect(chips.length).toBe(3);
    const input = screen.getByTestId('brief-message-input') as HTMLTextAreaElement;
    expect(input.value).toBe('');
    fireEvent.click(chips[0]!);
    // Chip click prefills the box but does NOT send (transcript stays empty).
    expect(input.value).toBe(chips[0]!.textContent);
    expect(lastSentMessage).toBe('');
  });

  it('shows 100% for a finalized brief even when the score was never raised (F4)', async () => {
    // Goal-as-brief finalization (and pre-fix rows) leave completenessScore=0
    // while briefReady=true — the bar must not show a contradictory "0%".
    brief = { ...freshBrief(), briefReady: true, completenessScore: 0 };
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId('brief-score').textContent).toBe('100%');
    });
  });

  it('sending a message advances the brief and renders the new bubbles', async () => {
    renderCard();
    await waitFor(() => screen.getByTestId('brief-message-input'));
    const input = screen.getByTestId('brief-message-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Eine Web-App.' } });
    fireEvent.click(screen.getByTestId('brief-send-button'));
    await waitFor(() => {
      expect(screen.getByTestId('brief-score').textContent).toBe('30%');
    });
    expect(lastSentMessage).toBe('Eine Web-App.');
    expect(screen.getByTestId('brief-bubble-user')).toBeInTheDocument();
    expect(screen.getByTestId('brief-bubble-assistant')).toBeInTheDocument();
  });

  it('finalize button is always enabled; label switches from skip to finalise', async () => {
    renderCard();
    await waitFor(() => screen.getByTestId('brief-finalize-button'));
    const finalizeBtn = screen.getByTestId('brief-finalize-button') as HTMLButtonElement;
    // At 0% the action is the "use goal as brief" skip — and it must be enabled
    // so a non-technical user is never blocked from starting.
    expect(finalizeBtn.disabled).toBe(false);
    expect(finalizeBtn.textContent).toContain('Use goal as brief');

    fireEvent.change(screen.getByTestId('brief-message-input') as HTMLTextAreaElement, {
      target: { value: 'web' },
    });
    fireEvent.click(screen.getByTestId('brief-send-button'));
    // Once there is content it becomes a normal finalise (still enabled).
    await waitFor(() => expect(finalizeBtn.textContent).toContain('Finalise brief'));
    expect(finalizeBtn.disabled).toBe(false);
  });

  it('clicking finalize flips to ready state + collapses chat', async () => {
    renderCard();
    await waitFor(() => screen.getByTestId('brief-message-input'));
    fireEvent.change(screen.getByTestId('brief-message-input') as HTMLTextAreaElement, {
      target: { value: 'web' },
    });
    fireEvent.click(screen.getByTestId('brief-send-button'));
    await waitFor(() => screen.getByTestId('brief-bubble-user'));

    fireEvent.click(screen.getByTestId('brief-finalize-button'));
    await waitFor(() => {
      expect(lastFinalize).toBe(1);
      // brief-status-pending disappears; the toggle-expand button appears.
      expect(screen.queryByTestId('brief-status-pending')).toBeNull();
      expect(screen.getByTestId('brief-toggle-expand')).toBeInTheDocument();
    });
    // After collapsing, the input is no longer rendered (briefReady + collapsed).
    expect(screen.queryByTestId('brief-message-input')).toBeNull();
  });

  it('renders a calm error card when the interview query fails', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/interview')) {
        return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId('brief-card-error')).toBeInTheDocument();
    });
    // The misleading full render (pending badge / required hint) must NOT appear.
    expect(screen.queryByTestId('brief-status-pending')).toBeNull();
    expect(screen.queryByTestId('brief-required-hint')).toBeNull();
  });

  it('import dialog opens, pasting text enables submit, submit calls the mutation', async () => {
    renderCard();
    await waitFor(() => screen.getByTestId('brief-import-trigger'));
    fireEvent.click(screen.getByTestId('brief-import-trigger'));

    await waitFor(() => screen.getByTestId('brief-import-dialog'));
    const submit = screen.getByTestId('brief-import-submit') as HTMLButtonElement;
    // Empty textarea → submit disabled.
    expect(submit.disabled).toBe(true);

    const textarea = screen.getByTestId('brief-import-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '# My Spec\n\nHello.' } });
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() => {
      expect(lastImportMarkdown).toBe('# My Spec\n\nHello.');
    });
    // On success the brief flips to ready (status-pending disappears).
    await waitFor(() => {
      expect(screen.queryByTestId('brief-status-pending')).toBeNull();
    });
  });

  it('toggle-expand re-renders the transcript when ready', async () => {
    brief = { ...freshBrief(), briefReady: true, completenessScore: 100 };
    transcript = [
      {
        id: 'u1',
        threadId: 't1',
        role: 'user',
        content: 'hello',
        createdAt: Date.now(),
        authorAgentId: null,
      },
    ];
    renderCard();
    await waitFor(() => screen.getByTestId('brief-toggle-expand'));
    expect(screen.queryByTestId('brief-transcript')).toBeNull();
    fireEvent.click(screen.getByTestId('brief-toggle-expand'));
    await waitFor(() => {
      expect(screen.getByTestId('brief-transcript')).toBeInTheDocument();
    });
  });
});
