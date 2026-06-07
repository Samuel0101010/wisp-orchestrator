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
