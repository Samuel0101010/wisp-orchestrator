import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { AutopilotToggle } from './AutopilotToggle';

const originalFetch = globalThis.fetch;
let postCalls: { url: string; body: unknown }[] = [];

beforeEach(() => {
  postCalls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method && init.method !== 'GET') {
      postCalls.push({ url, body: init.body ? JSON.parse(init.body as string) : null });
    }
    return new Response(
      JSON.stringify({
        id: 'r1',
        autopilotMode: true,
        autopilotBudgetMinutes: 300,
        autopilotBudgetTokens: 2_000_000,
      }),
      { status: 200 },
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function Wrapper({
  initialEnabled,
  initialMin,
  initialTok,
}: {
  initialEnabled: boolean;
  initialMin: number | null;
  initialTok: number | null;
}) {
  // The host normally feeds these from the React Query snapshot. The test
  // sometimes wants to simulate a refetch that shifts the server values — it
  // does so via the buttons below.
  const [enabled, setEnabled] = useState(initialEnabled);
  const [min, setMin] = useState<number | null>(initialMin);
  const [tok, setTok] = useState<number | null>(initialTok);

  return (
    <>
      <AutopilotToggle
        runId="r1"
        initialEnabled={enabled}
        initialBudgetMinutes={min}
        initialBudgetTokens={tok}
      />
      <button
        data-testid="simulate-refetch-true"
        onClick={() => {
          setEnabled(true);
          setMin(120);
          setTok(500_000);
        }}
      >
        refetch-true
      </button>
      <button
        data-testid="simulate-refetch-false"
        onClick={() => {
          setEnabled(false);
          setMin(null);
          setTok(null);
        }}
      >
        refetch-false
      </button>
    </>
  );
}

function renderToggle(props: {
  initialEnabled: boolean;
  initialMin?: number | null;
  initialTok?: number | null;
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Wrapper
        initialEnabled={props.initialEnabled}
        initialMin={props.initialMin ?? null}
        initialTok={props.initialTok ?? null}
      />
    </QueryClientProvider>,
  );
}

describe('AutopilotToggle', () => {
  it('does not clobber unsaved edits when a background refetch arrives', async () => {
    renderToggle({ initialEnabled: false });
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).not.toBeChecked();

    // User ticks the checkbox — local edit, no save yet.
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(screen.getByTestId('autopilot-save')).toHaveAttribute('data-dirty', 'true');

    // Now a stale server refetch comes back with enabled=false (the value
    // the user has just locally flipped to true). Without the guard the
    // checkbox would re-uncheck. With the guard the local edit stays.
    act(() => {
      fireEvent.click(screen.getByTestId('simulate-refetch-false'));
    });

    expect(checkbox).toBeChecked();
    expect(screen.getByTestId('autopilot-save')).toHaveAttribute('data-dirty', 'true');
  });

  it('adopts the new server snapshot when the user has no unsaved edits', async () => {
    renderToggle({ initialEnabled: false });
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).not.toBeChecked();

    // No local edits — simulate the server flipping autopilot on in another
    // tab. The form should pick that up.
    act(() => {
      fireEvent.click(screen.getByTestId('simulate-refetch-true'));
    });

    expect(checkbox).toBeChecked();
    expect(screen.getByTestId('autopilot-save')).toHaveAttribute('data-dirty', 'false');
  });

  it('POSTs enabled + budgets on save and shows Gespeichert afterwards', async () => {
    renderToggle({ initialEnabled: false });
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);
    const minInput = screen.getByPlaceholderText(/Budget Min/i) as HTMLInputElement;
    fireEvent.change(minInput, { target: { value: '300' } });
    fireEvent.click(screen.getByTestId('autopilot-save'));

    await waitFor(() => expect(postCalls.length).toBe(1));
    expect(postCalls[0].url).toMatch(/\/api\/runs\/r1\/autopilot$/);
    expect(postCalls[0].body).toEqual({
      enabled: true,
      budgetMinutes: 300,
      budgetTokens: undefined,
    });

    await waitFor(() =>
      expect(screen.getByTestId('autopilot-save')).toHaveAttribute('data-dirty', 'false'),
    );
  });
});
