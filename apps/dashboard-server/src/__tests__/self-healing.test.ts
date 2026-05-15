import { describe, expect, it } from 'vitest';
import { buildHardeningPlan, shouldChainHardeningRun } from '../orchestrator/self-healing.js';
import type { Finding } from '../orchestrator/findings.js';

const F_CRIT: Finding = {
  source: 'docs/security-review.md',
  severity: 'CRITICAL',
  title: 'updater + signing',
};
const F_HIGH: Finding = {
  source: 'docs/security-review.md',
  severity: 'HIGH',
  title: 'ipc validation',
};

describe('shouldChainHardeningRun', () => {
  const base = {
    selfHealingEnabled: true,
    chainIteration: 0,
    maxChainIterations: 3,
    actionableFindingsCount: 2,
  };

  it('chains when enabled, under cap, and findings remain', () => {
    expect(shouldChainHardeningRun(base)).toBe(true);
  });

  it('does not chain when disabled', () => {
    expect(shouldChainHardeningRun({ ...base, selfHealingEnabled: false })).toBe(false);
  });

  it('does not chain at the cap', () => {
    expect(shouldChainHardeningRun({ ...base, chainIteration: 3 })).toBe(false);
  });

  it('does not chain when no actionable findings remain', () => {
    expect(shouldChainHardeningRun({ ...base, actionableFindingsCount: 0 })).toBe(false);
  });

  it('chains at the iteration boundary (cap - 1)', () => {
    expect(shouldChainHardeningRun({ ...base, chainIteration: 2 })).toBe(true);
  });
});

describe('buildHardeningPlan', () => {
  it('builds a 2-node security → qa-engineer DAG with valid edges', () => {
    const plan = buildHardeningPlan({
      parentGoal: 'Make a great app.',
      iteration: 1,
      findings: [F_CRIT, F_HIGH],
    });
    expect(plan.nodes).toHaveLength(2);
    expect(plan.nodes[0].id).toBe('n1-harden');
    expect(plan.nodes[0].role).toBe('security');
    expect(plan.nodes[1].id).toBe('n2-qa-verify');
    expect(plan.nodes[1].role).toBe('qa-engineer');
    expect(plan.nodes[1].deps).toEqual(['n1-harden']);
    expect(plan.edges).toEqual([{ from: 'n1-harden', to: 'n2-qa-verify' }]);
  });

  it('embeds the findings text and the parent goal into the security prompt', () => {
    const plan = buildHardeningPlan({
      parentGoal: 'PARENT-GOAL-MARKER',
      iteration: 2,
      findings: [F_CRIT, F_HIGH],
    });
    expect(plan.goal).toContain('PARENT-GOAL-MARKER');
    expect(plan.goal).toContain('Self-healing pass #2');
    expect(plan.nodes[0].prompt).toContain('updater + signing');
    expect(plan.nodes[0].prompt).toContain('ipc validation');
  });

  it('declares the team with security + qa-engineer roles', () => {
    const plan = buildHardeningPlan({
      parentGoal: 'g',
      iteration: 1,
      findings: [F_HIGH],
    });
    const roles = plan.team.roles.map((r) => r.role);
    expect(roles).toEqual(['security', 'qa-engineer']);
  });

  it('produces a Plan that passes the planSchema parse round-trip', async () => {
    const { parsePlan } = await import('@agent-harness/schemas');
    const plan = buildHardeningPlan({
      parentGoal: 'g',
      iteration: 1,
      findings: [F_CRIT],
    });
    expect(() => parsePlan(plan)).not.toThrow();
  });
});
