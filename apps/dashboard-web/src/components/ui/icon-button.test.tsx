import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { IconButton } from './icon-button';

function withProvider(node: React.ReactNode) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

describe('IconButton', () => {
  it('forwards label to aria-label', () => {
    withProvider(<IconButton label="Save changes" icon={<span data-testid="i" />} />);
    expect(screen.getByLabelText('Save changes')).toBeInTheDocument();
  });

  it('renders the icon child', () => {
    withProvider(<IconButton label="X" icon={<span data-testid="i" />} />);
    expect(screen.getByTestId('i')).toBeInTheDocument();
  });
});
