import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ToolMultiSelect } from './ToolMultiSelect';

function Harness({ initial = [] }: { initial?: string[] }) {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <div>
      <ToolMultiSelect value={value} onChange={setValue} initialOpen />
      <span data-testid="harness-count">{value.length}</span>
      <span data-testid="harness-list">{value.join(',')}</span>
    </div>
  );
}

describe('ToolMultiSelect', () => {
  it('renders empty-state hint when no tools selected', () => {
    render(<Harness />);
    expect(screen.getByText(/no tools selected/i)).toBeInTheDocument();
  });

  it('shows count when tools are selected', () => {
    render(<Harness initial={['Read', 'Edit']} />);
    expect(screen.getByText(/2 tools selected/)).toBeInTheDocument();
  });

  it('toggles a catalog tool via its checkbox', () => {
    render(<Harness />);
    const cb = screen.getByTestId('tool-cb-Read') as HTMLInputElement;
    expect(cb.checked).toBe(false);
    fireEvent.click(cb);
    expect(screen.getByTestId('harness-count')).toHaveTextContent('1');
    expect(screen.getByTestId('harness-list')).toHaveTextContent('Read');
    fireEvent.click(cb);
    expect(screen.getByTestId('harness-count')).toHaveTextContent('0');
  });

  it('adds and removes a custom pattern', () => {
    render(<Harness />);
    const input = screen.getByTestId('tool-multiselect-custom-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Bash(make:*)' } });
    fireEvent.click(screen.getByTestId('tool-multiselect-custom-add'));
    expect(screen.getByTestId('harness-list')).toHaveTextContent('Bash(make:*)');
    // Custom chip is rendered with the trailing × — clicking removes.
    fireEvent.click(screen.getByTestId('tool-chip-Bash(make:*)'));
    expect(screen.getByTestId('harness-count')).toHaveTextContent('0');
  });

  it('does not add a duplicate custom pattern', () => {
    render(<Harness initial={['Bash(make:*)']} />);
    const input = screen.getByTestId('tool-multiselect-custom-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Bash(make:*)' } });
    fireEvent.click(screen.getByTestId('tool-multiselect-custom-add'));
    expect(screen.getByTestId('harness-count')).toHaveTextContent('1');
  });

  it('removes a catalog tool via its chip', () => {
    render(<Harness initial={['Read']} />);
    fireEvent.click(screen.getByTestId('tool-chip-Read'));
    expect(screen.getByTestId('harness-count')).toHaveTextContent('0');
  });
});
