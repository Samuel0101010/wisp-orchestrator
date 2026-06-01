import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AgentChat } from './AgentChat';

const agent = {
  id: 'a1',
  name: 'Manager',
  model: 'opus',
  description: null,
  systemPrompt: 'You are the manager.',
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/agents')) {
      return new Response(JSON.stringify([agent]), { status: 200 });
    }
    if (url.includes('/threads')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderChat() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AgentChat />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The new-thread tooltip ("New thread"), the visible "new" label and the send
// button's aria-label ("Send") were hardcoded English; now localized.
describe('AgentChat i18n', () => {
  it('localizes the new-thread and send controls', async () => {
    renderChat();
    expect(await screen.findByTitle('New thread')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/threads ·/i)).toBeInTheDocument());
  });
});
