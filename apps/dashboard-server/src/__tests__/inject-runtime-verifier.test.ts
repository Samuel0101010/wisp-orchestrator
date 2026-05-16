import './setup.js';
import { describe, expect, it } from 'vitest';
import { injectRuntimeVerifier } from '../orchestrator/inject-runtime-verifier.js';
import { RUNTIME_VERIFIER_ROLE } from '../orchestrator/runtime-verifier.js';
import { planSchema, validateDag } from '@wisp/schemas';
import type { AgentSpec, DodCriterion, Plan } from '@wisp/schemas';

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

function dod(): DodCriterion[] {
  return [
    {
      id: 'dod-1',
      projectId: 'p',
      title: 'User logs in',
      kind: 'e2e',
      specJson: { testFile: 'tests/runtime/login.spec.ts' },
      position: 0,
      createdAt: new Date(),
    },
  ];
}

describe('injectRuntimeVerifier', () => {
  it('returns "already-present" when the plan already has the verifier role', () => {
    const plan = basePlan({ team: { roles: [RUNTIME_VERIFIER_ROLE] } });
    const r = injectRuntimeVerifier({ plan, dodCriteria: dod() });
    expect(r.reason).toBe('already-present');
    expect(r.plan).toBe(plan);
  });

  it('appends the verifier role + node and wires deps from every terminal', () => {
    const plan = basePlan();
    const r = injectRuntimeVerifier({ plan, dodCriteria: dod() });
    expect(r.reason).toBe('injected');
    expect(r.plan.team.roles.map((x) => x.role)).toContain('runtime-verifier');
    const verify = r.plan.nodes.find((n) => n.role === 'runtime-verifier');
    expect(verify).toBeDefined();
    // n2 is the sole terminal — it should be the verifier's only dep.
    expect(verify?.deps).toEqual(['n2']);
    const edge = r.plan.edges.find((e) => e.to === verify?.id);
    expect(edge?.from).toBe('n2');
  });

  it('wires the verifier behind every terminal when the DAG has multiple sinks', () => {
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
    const r = injectRuntimeVerifier({ plan, dodCriteria: dod() });
    expect(r.reason).toBe('injected');
    const verify = r.plan.nodes.find((n) => n.role === 'runtime-verifier');
    expect(verify?.deps.sort()).toEqual(['n2', 'n3']);
  });

  it('produces a plan that still validates against the planner schema and is acyclic', () => {
    const plan = basePlan();
    const r = injectRuntimeVerifier({ plan, dodCriteria: dod() });
    expect(planSchema.safeParse(r.plan).success).toBe(true);
    expect(validateDag(r.plan).ok).toBe(true);
  });

  it('refuses to inject when the team is already at the 8-role cap', () => {
    const roles: AgentSpec[] = Array.from({ length: 8 }).map((_, i) => ({
      role: `dev-${i + 1}`,
      model: 'sonnet',
      allowedTools: ['Read'],
      systemPrompt: 'x'.repeat(50),
    }));
    const plan = basePlan({ team: { roles } });
    const r = injectRuntimeVerifier({ plan, dodCriteria: dod() });
    expect(r.reason).toBe('team-cap-reached');
    expect(r.plan).toBe(plan);
  });

  it('returns plan-empty when the plan has no nodes', () => {
    const plan = basePlan({ nodes: [], edges: [] });
    const r = injectRuntimeVerifier({ plan, dodCriteria: dod() });
    expect(r.reason).toBe('plan-empty');
  });

  it('is idempotent — injecting twice yields the same plan as injecting once', () => {
    const plan = basePlan();
    const first = injectRuntimeVerifier({ plan, dodCriteria: dod() });
    const second = injectRuntimeVerifier({ plan: first.plan, dodCriteria: dod() });
    expect(second.reason).toBe('already-present');
    expect(second.plan).toBe(first.plan);
  });
});
