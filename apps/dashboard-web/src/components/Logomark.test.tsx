import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Logomark } from './Logomark';

describe('Logomark', () => {
  it('renders an inline SVG with the 24x24 viewBox', () => {
    const { container } = render(<Logomark />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('fill')).toBe('currentColor');
  });

  it('applies the className prop', () => {
    const { container } = render(<Logomark className="size-6 text-foreground" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('class')).toMatch(/size-6/);
    expect(svg?.getAttribute('class')).toMatch(/text-foreground/);
  });

  it('is decorative (aria-hidden) when no title is provided', () => {
    const { container } = render(<Logomark />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('role')).toBeNull();
  });

  it('exposes an accessible name when title is provided', () => {
    const { container, getByTitle } = render(<Logomark title="WISP" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe('WISP');
    expect(getByTitle('WISP')).toBeInTheDocument();
  });

  it('emits a single path element', () => {
    const { container } = render(<Logomark />);
    const paths = container.querySelectorAll('path');
    expect(paths.length).toBe(1);
  });
});
