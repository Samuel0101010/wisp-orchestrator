import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('renders page variant by default with title, description, action, and icon', () => {
    render(
      <EmptyState
        icon={<svg data-testid="lucide" />}
        title="No projects yet"
        description="Create your first project to get started."
        action={<button>Create</button>}
      />,
    );
    expect(screen.getByText('No projects yet')).toBeInTheDocument();
    expect(screen.getByText('Create your first project to get started.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    expect(screen.getByTestId('lucide')).toBeInTheDocument();
  });

  it('page variant uses 64px icon wrapper and base title size', () => {
    render(<EmptyState size="page" icon={<svg data-testid="lucide" />} title="Nothing here" />);
    const wrapper = screen.getByTestId('empty-state-icon');
    expect(wrapper.className).toMatch(/size-16/);
    const title = screen.getByText('Nothing here');
    expect(title.tagName.toLowerCase()).toBe('h3');
    expect(title.className).toMatch(/text-base/);
  });

  it('column variant uses 32px icon wrapper and renders compact title', () => {
    render(<EmptyState size="column" icon={<svg data-testid="lucide" />} title="No tasks" />);
    const wrapper = screen.getByTestId('empty-state-icon');
    expect(wrapper.className).toMatch(/size-8/);
    const title = screen.getByText('No tasks');
    expect(title.tagName.toLowerCase()).toBe('p');
    expect(title.className).toMatch(/text-xs/);
    expect(title.className).toMatch(/text-muted-foreground/);
  });

  it('column variant omits description and action even when supplied', () => {
    render(
      <EmptyState
        size="column"
        icon={<svg data-testid="lucide" />}
        title="No tasks"
        description="Should not appear"
        action={<button>Ignored</button>}
      />,
    );
    expect(screen.queryByText('Should not appear')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ignored' })).not.toBeInTheDocument();
  });

  it('icon is visible (wrapped) in both sizes', () => {
    const { rerender } = render(
      <EmptyState size="page" icon={<svg data-testid="lucide" />} title="x" />,
    );
    expect(screen.getByTestId('lucide')).toBeInTheDocument();
    rerender(<EmptyState size="column" icon={<svg data-testid="lucide" />} title="x" />);
    expect(screen.getByTestId('lucide')).toBeInTheDocument();
  });
});
