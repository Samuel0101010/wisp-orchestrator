import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SnippetMenu } from './SnippetMenu';
import { PROMPT_SNIPPETS } from '@/data/promptSnippets';

describe('SnippetMenu', () => {
  it('toggles open / closed on the trigger button', () => {
    render(<SnippetMenu onInsert={() => {}} />);
    expect(screen.queryByTestId('snippet-menu-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('snippet-menu-toggle'));
    expect(screen.getByTestId('snippet-menu-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('snippet-menu-toggle'));
    expect(screen.queryByTestId('snippet-menu-panel')).toBeNull();
  });

  it('calls onInsert with the picked snippet and closes', () => {
    const onInsert = vi.fn();
    render(<SnippetMenu onInsert={onInsert} />);
    fireEvent.click(screen.getByTestId('snippet-menu-toggle'));
    const first = PROMPT_SNIPPETS[0]!;
    fireEvent.click(screen.getByTestId(`snippet-${first.id}`));
    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert.mock.calls[0]![0]).toMatchObject({ id: first.id });
    expect(screen.queryByTestId('snippet-menu-panel')).toBeNull();
  });
});
