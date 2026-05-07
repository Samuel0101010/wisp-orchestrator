import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TemplatePicker } from './TemplatePicker';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/team-templates')) {
      return new Response(
        JSON.stringify({
          templates: [
            {
              id: 'ts-library',
              name: 'TypeScript library',
              description: 'A short description that is at least 20 chars long.',
              team: {
                roles: [
                  {
                    role: 'architect',
                    model: 'opus',
                    allowedTools: ['Read'],
                    systemPrompt: 'x'.repeat(60),
                  },
                ],
              },
              suggestedGoals: ['Add a hello function plus a vitest test'],
            },
            {
              id: 'python-backend',
              name: 'Python backend',
              description: 'Another description that is at least 20 chars long.',
              team: {
                roles: [
                  {
                    role: 'architect',
                    model: 'opus',
                    allowedTools: ['Read'],
                    systemPrompt: 'x'.repeat(60),
                  },
                ],
              },
              suggestedGoals: ['Add a /health endpoint plus a pytest test'],
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function renderPicker(initial: string | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let value = initial;
  const onSelect = vi.fn((id: string | null) => {
    value = id;
  });
  const utils = render(
    <QueryClientProvider client={qc}>
      <TemplatePicker selectedId={value} onSelect={onSelect} />
    </QueryClientProvider>,
  );
  return { ...utils, onSelect, getValue: () => value };
}

describe('TemplatePicker', () => {
  it('renders a No-template option plus one card per template', async () => {
    renderPicker();
    await waitFor(() => {
      expect(screen.getByTestId('template-pick-none')).toBeInTheDocument();
      expect(screen.getByTestId('template-pick-ts-library')).toBeInTheDocument();
      expect(screen.getByTestId('template-pick-python-backend')).toBeInTheDocument();
    });
  });

  it('clicking a card calls onSelect with that id', async () => {
    const { onSelect } = renderPicker();
    await waitFor(() => screen.getByTestId('template-pick-ts-library'));
    fireEvent.click(screen.getByTestId('template-pick-ts-library'));
    expect(onSelect).toHaveBeenCalledWith('ts-library');
  });

  it('clicking No-template calls onSelect with null', async () => {
    const { onSelect } = renderPicker('ts-library');
    await waitFor(() => screen.getByTestId('template-pick-none'));
    fireEvent.click(screen.getByTestId('template-pick-none'));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('shows the role count badge for each template (i18n pluralised)', async () => {
    renderPicker();
    await waitFor(() => screen.getByTestId('template-pick-ts-library'));
    // count=1 hits the `_one` plural (singular form) under react-i18next.
    expect(screen.getByTestId('template-pick-ts-library').textContent).toContain('1 role');
  });
});
