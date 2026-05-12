import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusPill } from './status-pill';

describe('StatusPill', () => {
  it('renders children with base classes', () => {
    render(
      <StatusPill tone="info" variant="soft">
        Running
      </StatusPill>,
    );
    const el = screen.getByText('Running');
    expect(el).toBeInTheDocument();
    expect(el.className).toMatch(/uppercase/);
    expect(el.className).toMatch(/tracking-wider/);
    expect(el.className).toMatch(/rounded-full/);
    expect(el.className).toMatch(/text-xs2/);
  });

  it('applies solid variant classes', () => {
    render(
      <StatusPill tone="destructive" variant="solid">
        Failed
      </StatusPill>,
    );
    const el = screen.getByText('Failed');
    expect(el.className).toMatch(/bg-destructive/);
    expect(el.className).toMatch(/text-destructive-foreground/);
  });

  it('applies solid variant classes for neutral tone', () => {
    render(
      <StatusPill tone="neutral" variant="solid">
        Locked
      </StatusPill>,
    );
    const el = screen.getByText('Locked');
    expect(el.className).toMatch(/bg-muted/);
    expect(el.className).toMatch(/text-foreground/);
  });

  it('applies soft variant classes', () => {
    render(
      <StatusPill tone="success" variant="soft">
        Done
      </StatusPill>,
    );
    const el = screen.getByText('Done');
    expect(el.className).toMatch(/bg-success\/12/);
    expect(el.className).toMatch(/text-success/);
  });

  it('applies soft variant classes for neutral tone', () => {
    render(
      <StatusPill tone="neutral" variant="soft">
        Idle
      </StatusPill>,
    );
    const el = screen.getByText('Idle');
    expect(el.className).toMatch(/bg-muted-foreground\/12/);
    expect(el.className).toMatch(/text-muted-foreground/);
  });

  it('applies outline variant classes', () => {
    render(
      <StatusPill tone="warning" variant="outline">
        Seed
      </StatusPill>,
    );
    const el = screen.getByText('Seed');
    expect(el.className).toMatch(/border-warning\/40/);
    expect(el.className).toMatch(/text-warning/);
  });

  it('renders the live pulsing dot when live=true', () => {
    render(
      <StatusPill tone="info" variant="soft" live>
        Running
      </StatusPill>,
    );
    const dot = screen.getByTestId('status-pill-live-dot');
    expect(dot).toBeInTheDocument();
    expect(dot.className).toMatch(/animate-pulse/);
    expect(dot.className).toMatch(/bg-current/);
  });

  it('does not render the live dot by default', () => {
    render(
      <StatusPill tone="info" variant="soft">
        Done
      </StatusPill>,
    );
    expect(screen.queryByTestId('status-pill-live-dot')).not.toBeInTheDocument();
  });

  it('renders an optional icon', () => {
    render(
      <StatusPill tone="success" variant="solid" icon={<svg data-testid="icon" />}>
        Done
      </StatusPill>,
    );
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });
});
