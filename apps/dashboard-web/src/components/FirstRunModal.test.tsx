import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FirstRunModal, hasAckedFirstRun, FIRST_RUN_ACK_KEY } from './FirstRunModal';

describe('FirstRunModal', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('renders when open=true and hides the title when open=false', () => {
    const { rerender } = render(<FirstRunModal open={false} onAck={() => {}} />);
    expect(screen.queryByTestId('first-run-modal')).toBeNull();
    rerender(<FirstRunModal open={true} onAck={() => {}} />);
    expect(screen.getByTestId('first-run-modal')).toBeInTheDocument();
  });

  it('persists ack flag to localStorage and calls onAck when button clicked', () => {
    let acked = false;
    render(
      <FirstRunModal
        open={true}
        onAck={() => {
          acked = true;
        }}
      />,
    );
    expect(hasAckedFirstRun()).toBe(false);
    fireEvent.click(screen.getByTestId('first-run-ack'));
    expect(acked).toBe(true);
    expect(localStorage.getItem(FIRST_RUN_ACK_KEY)).toBe('1');
    expect(hasAckedFirstRun()).toBe(true);
  });

  it('hasAckedFirstRun returns true after a previous ack', () => {
    localStorage.setItem(FIRST_RUN_ACK_KEY, '1');
    expect(hasAckedFirstRun()).toBe(true);
  });
});
