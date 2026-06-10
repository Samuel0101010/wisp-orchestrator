import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Plan } from '@wisp/schemas';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PlanCanvas } from './PlanCanvas';

const FILLER = 'x'.repeat(80);

function buildPlan(): Plan {
  return {
    goal: 'g',
    team: {
      roles: [
        {
          role: 'developer',
          model: 'sonnet',
          allowedTools: ['Edit'],
          systemPrompt: `dev ${FILLER}`,
        },
      ],
    },
    nodes: [
      // Planner-emitted node with explicit origin.
      {
        id: 'impl',
        role: 'developer',
        origin: 'planner',
        prompt: 'implement',
        deps: [],
        successCriteria: {},
        maxTurns: 10,
      },
      // Old plans carry no origin at all — must NOT get the badge.
      {
        id: 'legacy',
        role: 'developer',
        prompt: 'old node',
        deps: [],
        successCriteria: {},
        maxTurns: 10,
      },
      // Harness-injected node with a role-specific tooltip.
      {
        id: 'wireup-1',
        role: 'wire-up',
        origin: 'system',
        prompt: 'reconcile branches',
        deps: ['impl'],
        successCriteria: {},
        maxTurns: 10,
      },
      // System node whose role has no dedicated tooltip — falls back to default.
      {
        id: 'custom-1',
        role: 'release-bot',
        origin: 'system',
        prompt: 'ship it',
        deps: ['impl'],
        successCriteria: {},
        maxTurns: 10,
      },
    ],
    edges: [
      { from: 'impl', to: 'wireup-1' },
      { from: 'impl', to: 'custom-1' },
    ],
  };
}

function renderCanvas(plan: Plan = buildPlan()) {
  return render(
    <TooltipProvider>
      <PlanCanvas plan={plan} selectedNodeId={null} onSelectNode={() => {}} />
    </TooltipProvider>,
  );
}

describe('PlanCanvas', () => {
  it('renders the System badge only for nodes with origin "system"', async () => {
    renderCanvas();

    const badge = await screen.findByTestId('plan-node-system-wireup-1');
    expect(badge).toHaveTextContent('System');
    // No badge for planner-emitted nodes or old nodes without origin.
    expect(screen.getByTestId('plan-node-impl')).toBeInTheDocument();
    expect(screen.queryByTestId('plan-node-system-impl')).not.toBeInTheDocument();
    expect(screen.queryByTestId('plan-node-system-legacy')).not.toBeInTheDocument();
  });

  it('uses the role-specific tooltip when available and the default otherwise', async () => {
    renderCanvas();

    const wireUp = await screen.findByTestId('plan-node-system-wireup-1');
    expect(wireUp).toHaveAttribute(
      'title',
      'Auto-inserted: reconciles the parallel work branches so the project builds.',
    );
    const fallback = screen.getByTestId('plan-node-system-custom-1');
    expect(fallback).toHaveAttribute(
      'title',
      'Added by the system — not part of the team you picked.',
    );
  });
});
