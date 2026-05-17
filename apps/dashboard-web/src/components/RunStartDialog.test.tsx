import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RunStartDialog } from './RunStartDialog';

interface HarnessProps {
  open?: boolean;
  goal?: string;
  starting?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
  onGotoPreview?: () => void;
  onOpenChange?: (open: boolean) => void;
}

function renderDialog(props: HarnessProps = {}) {
  return render(
    <RunStartDialog
      open={props.open ?? true}
      goal={props.goal ?? 'Build a Kanban board with drag-and-drop and per-user persistence.'}
      starting={props.starting ?? false}
      onOpenChange={props.onOpenChange ?? (() => undefined)}
      onConfirm={props.onConfirm ?? (() => undefined)}
      onCancel={props.onCancel ?? (() => undefined)}
      onGotoPreview={props.onGotoPreview ?? (() => undefined)}
    />,
  );
}

describe('RunStartDialog', () => {
  it('does not render the dialog when open=false', () => {
    renderDialog({ open: false });
    expect(screen.queryByTestId('run-start-dialog')).toBeNull();
  });

  it('renders the dialog, goal, hint banner, and footer actions when open=true', () => {
    renderDialog({ goal: 'My fancy goal.' });
    expect(screen.getByTestId('run-start-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('run-start-goal')).toHaveTextContent('My fancy goal.');
    expect(screen.getByTestId('run-start-iteration-hint')).toBeInTheDocument();
    expect(screen.getByTestId('run-start-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('run-start-cancel')).toBeInTheDocument();
    expect(screen.getByTestId('run-start-goto-preview')).toBeInTheDocument();
  });

  it('truncates goals longer than 300 chars and toggles full view on click', () => {
    const longGoal = 'A'.repeat(450);
    renderDialog({ goal: longGoal });
    const goalEl = screen.getByTestId('run-start-goal');
    expect(goalEl.textContent?.endsWith('…')).toBe(true);
    expect(goalEl.textContent?.length).toBeLessThan(longGoal.length);

    const toggle = screen.getByTestId('run-start-goal-toggle');
    fireEvent.click(toggle);
    expect(screen.getByTestId('run-start-goal').textContent).toBe(longGoal);
  });

  it('does not render the toggle for short goals', () => {
    renderDialog({ goal: 'Short.' });
    expect(screen.queryByTestId('run-start-goal-toggle')).toBeNull();
  });

  it('calls onConfirm when the confirm button is clicked', () => {
    const onConfirm = vi.fn();
    renderDialog({ onConfirm });
    fireEvent.click(screen.getByTestId('run-start-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when the cancel button is clicked', () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    fireEvent.click(screen.getByTestId('run-start-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onGotoPreview when "Zur Vorschau" is clicked', () => {
    const onGotoPreview = vi.fn();
    renderDialog({ onGotoPreview });
    fireEvent.click(screen.getByTestId('run-start-goto-preview'));
    expect(onGotoPreview).toHaveBeenCalledTimes(1);
  });

  it('disables confirm and cancel while a run is starting', () => {
    renderDialog({ starting: true });
    expect(screen.getByTestId('run-start-confirm')).toBeDisabled();
    expect(screen.getByTestId('run-start-cancel')).toBeDisabled();
  });
});
