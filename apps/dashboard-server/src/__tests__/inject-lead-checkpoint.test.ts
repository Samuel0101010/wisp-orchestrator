import './setup.js';
import { describe, expect, it } from 'vitest';
import { injectLeadCheckpoint, LEAD_ROLE } from '../orchestrator/inject-lead-checkpoint.js';
import { planSchema, validateDag } from '@agent-harness/schemas';
import type { AgentSpec, Plan } from '@agent-harness/schemas';

function basePlan(over: Partial<Plan> = {}): Plan {
  const developer: AgentSpec = {
    role: 'developer',
    model: 'sonnet',
    allowedTools: ['Read', 'Write'],
    systemPrompt: 'x'.repeat(50),
  };
  const qa: AgentSpec = {
    role: 'qa-engineer',
    model: 'sonnet',
    allowedTools: ['Read'],
    systemPrompt: 'x'.repeat(50),
  };
  return {
    goal: 'g',
    team: { roles: [developer, qa] },
    nodes: [
      {
        id: 'n1',
        role: 'developer',
        prompt: 'build',
        deps: [],
        successCriteria: { build: 'pnpm build' },
        maxTurns: 50,
      },
      {
        id: 'n2',
        role: 'qa-engineer',
        prompt: 'verify',
        deps: ['n1'],
        successCriteria: { test: 'pnpm test' },
        maxTurns: 30,
      },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
    ...over,
  };
}

describe('injectLeadCheckpoint', () => {
  it('appends the lead role + node when leadEnabled=true (caller-gated)', () => {
    const plan = basePlan();
    const r = injectLeadCheckpoint({ plan });
    expect(r.reason).toBe('injected');
    expect(r.plan.team.roles.map((x) => x.role)).toContain('lead');
    const leadNode = r.plan.nodes.find((n) => n.role === 'lead');
    expect(leadNode).toBeDefined();
    expect(leadNode?.deps).toEqual(['n2']);
    expect(planSchema.safeParse(r.plan).success).toBe(true);
    expect(validateDag(r.plan).ok).toBe(true);
  });

  it('is idempotent — running twice yields one lead node', () => {
    const plan = basePlan();
    const first = injectLeadCheckpoint({ plan });
    const second = injectLeadCheckpoint({ plan: first.plan });
    expect(second.reason).toBe('already-present');
    expect(second.plan.nodes.filter((n) => n.role === 'lead')).toHaveLength(1);
  });

  it('refuses when the team is at the 8-role cap', () => {
    const roles: AgentSpec[] = Array.from({ length: 8 }).map((_, i) => ({
      role: `dev-${i + 1}`,
      model: 'sonnet',
      allowedTools: ['Read'],
      systemPrompt: 'x'.repeat(50),
    }));
    const plan = basePlan({ team: { roles } });
    const r = injectLeadCheckpoint({ plan });
    expect(r.reason).toBe('team-cap-reached');
    expect(r.plan).toBe(plan);
  });

  it('returns plan-empty for an empty plan', () => {
    const plan = basePlan({ nodes: [], edges: [] });
    const r = injectLeadCheckpoint({ plan });
    expect(r.reason).toBe('plan-empty');
  });

  it('wires the lead behind every terminal when the DAG has multiple sinks', () => {
    const plan = basePlan({
      nodes: [
        ...basePlan().nodes,
        {
          id: 'n3',
          role: 'qa-engineer',
          prompt: 'docs',
          deps: ['n1'],
          successCriteria: { lint: 'pnpm lint' },
          maxTurns: 20,
        },
      ],
      edges: [
        { from: 'n1', to: 'n2' },
        { from: 'n1', to: 'n3' },
      ],
    });
    const r = injectLeadCheckpoint({ plan });
    expect(r.reason).toBe('injected');
    const lead = r.plan.nodes.find((n) => n.role === 'lead');
    expect(lead?.deps.sort()).toEqual(['n2', 'n3']);
    expect(LEAD_ROLE.role).toBe('lead');
  });
});
