import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AuthBanner } from './AuthBanner';
import { useHealth } from '@/api/queries';

vi.mock('@/api/queries', () => ({
  useHealth: vi.fn(),
}));

const mockUseHealth = vi.mocked(useHealth);

function setHealth(data: unknown): void {
  mockUseHealth.mockReturnValue({ data } as unknown as ReturnType<typeof useHealth>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AuthBanner', () => {
  it('renders the server hint when the auth probe failed', () => {
    setHealth({
      ok: true,
      authProbe: { ok: false, hint: 'Run `claude login` to refresh credentials.' },
    });
    render(<AuthBanner />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Run `claude login` to refresh credentials.')).toBeInTheDocument();
  });

  it('falls back to the i18n message when the probe failed without a hint', () => {
    setHealth({ ok: true, authProbe: { ok: false } });
    render(<AuthBanner />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/not authenticated/i)).toBeInTheDocument();
  });

  it('renders nothing when auth is healthy', () => {
    setHealth({ ok: true, authProbe: { ok: true } });
    const { container } = render(<AuthBanner />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders nothing while the probe is still pending (null)', () => {
    setHealth({ ok: true, authProbe: null });
    const { container } = render(<AuthBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before health has loaded (undefined)', () => {
    setHealth(undefined);
    const { container } = render(<AuthBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('can be dismissed by the user', () => {
    setHealth({ ok: true, authProbe: { ok: false, hint: 'No auth.' } });
    render(<AuthBanner />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
