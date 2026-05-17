import './setup.js';
import { describe, expect, it } from 'vitest';
import { injectWireUp } from '../orchestrator/inject-wire-up.js';
import { WIRE_UP_ROLE } from '../orchestrator/wire-up.js';
import { planSchema, validateDag } from '@wisp/schemas';
import type { AgentSpec, Plan } from '@wisp/schemas';

function makeRole(role: string): AgentSpec {
  return {
    role,
    model: 'sonnet',
    allowedTools: ['Read', 'Write'],
    systemPrompt: 'x'.repeat(50),
  };
}

/**
 * Realistic shape we'd see from the WISP orchestrator: an architect, two
 * parallel core-dev nodes, and a downstream qa-engineer. The parallel
 * core-devs are exactly what wire-up exists to reconcile.
 */
function basePlan(over: Partial<Plan> = {}): Plan {
  const architect = makeRole('architect');
  const frontend = makeRole('frontend-ui');
  const backend = makeRole('rust-backend');
  const qa = makeRole('qa-engineer');
  return {
    goal: 'g',
    team: { roles: [architect, frontend, backend, qa] },
    nodes: [
      {
        id: 'n-arch',
        role: 'architect',
        prompt: 'design',
        deps: [],
        successCriteria: {},
        maxTurns: 30,
      },
      {
        id: 'n-fe',
        role: 'frontend-ui',
        prompt: 'fe',
        deps: ['n-arch'],
        successCriteria: { build: 'pnpm build' },
        maxTurns: 50,
      },
      {
        id: 'n-be',
        role: 'rust-backend',
        prompt: 'be',
        deps: ['n-arch'],
        successCriteria: { build: 'cargo build' },
        maxTurns: 50,
      },
      {
        id: 'n-qa',
        role: 'qa-engineer',
        prompt: 'verify',
        deps: ['n-fe', 'n-be'],
        successCriteria: { test: 'pnpm test' },
        maxTurns: 30,
      },
    ],
    edges: [
      { from: 'n-arch', to: 'n-fe' },
      { from: 'n-arch', to: 'n-be' },
      { from: 'n-fe', to: 'n-qa' },
      { from: 'n-be', to: 'n-qa' },
    ],
    ...over,
  };
}

describe('injectWireUp', () => {
  it('inserts wire-up between parallel core-dev leaves and the qa node', () => {
    const plan = basePlan();
    const r = injectWireUp({ plan });
    expect(r.reason).toBe('injected');

    const wireUp = r.plan.nodes.find((n) => n.role === 'wire-up');
    expect(wireUp).toBeDefined();
    // wire-up's deps = the two parallel core-dev leaves.
    expect(wireUp!.deps.sort()).toEqual(['n-be', 'n-fe']);

    // qa-engineer was depending on the leaves directly; after wire-up
    // injection it should depend on wire-up only.
    const qa = r.plan.nodes.find((n) => n.id === 'n-qa');
    expect(qa!.deps).toEqual([wireUp!.id]);
  });

  it('adds the wire-up role to the team roster', () => {
    const plan = basePlan();
    const r = injectWireUp({ plan });
    expect(r.plan.team.roles.map((x) => x.role)).toContain('wire-up');
    const wireUpRole = r.plan.team.roles.find((x) => x.role === 'wire-up');
    expect(wireUpRole?.allowedTools).toEqual(WIRE_UP_ROLE.allowedTools);
    // Spec sanity: the role MUST carry Edit + a pnpm/npm/cargo Bash grant
    // so downstream callers don't accidentally narrow the surface.
    expect(wireUpRole!.allowedTools.some((t) => t === 'Edit')).toBe(true);
    expect(wireUpRole!.allowedTools.some((t) => /Bash\([^)]*pnpm/.test(t))).toBe(true);
  });

  it('produces a plan that still validates against the planner schema and is acyclic', () => {
    const plan = basePlan();
    const r = injectWireUp({ plan });
    expect(planSchema.safeParse(r.plan).success).toBe(true);
    expect(validateDag(r.plan).ok).toBe(true);
  });

  it('is idempotent — injecting twice yields the same plan as injecting once', () => {
    const plan = basePlan();
    const first = injectWireUp({ plan });
    const second = injectWireUp({ plan: first.plan });
    expect(second.reason).toBe('already-present');
    expect(second.plan).toBe(first.plan);
  });

  it('returns "no-core-dev-nodes" when the plan has no dev-family roles', () => {
    // ts-library-style legacy plan: architect → test-dev → qa. No "*-dev"-
    // suffix core role. Skip injection so backward-compat is preserved.
    const plan: Plan = {
      goal: 'g',
      team: {
        roles: [makeRole('architect'), makeRole('docs-writer'), makeRole('qa-engineer')],
      },
      nodes: [
        {
          id: 'a',
          role: 'architect',
          prompt: 'design',
          deps: [],
          successCriteria: {},
          maxTurns: 20,
        },
        {
          id: 'b',
          role: 'docs-writer',
          prompt: 'docs',
          deps: ['a'],
          successCriteria: {},
          maxTurns: 20,
        },
        {
          id: 'c',
          role: 'qa-engineer',
          prompt: 'verify',
          deps: ['b'],
          successCriteria: {},
          maxTurns: 20,
        },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    };
    const r = injectWireUp({ plan });
    expect(r.reason).toBe('no-core-dev-nodes');
    expect(r.plan).toBe(plan);
  });

  it('returns "plan-empty" when there are no nodes', () => {
    const plan: Plan = {
      goal: 'g',
      team: { roles: [makeRole('core-dev')] },
      nodes: [],
      edges: [],
    };
    const r = injectWireUp({ plan });
    expect(r.reason).toBe('plan-empty');
  });

  it('refuses to inject when the team is already at the 8-role cap', () => {
    const roles: AgentSpec[] = Array.from({ length: 8 }).map((_, i) => makeRole(`role-${i}`));
    // need at least one core-dev role inside the cap to ensure we'd
    // otherwise have injected — otherwise the no-core-dev-nodes branch
    // fires first.
    roles[0] = makeRole('core-dev');
    const plan: Plan = {
      goal: 'g',
      team: { roles },
      nodes: [
        {
          id: 'x',
          role: 'core-dev',
          prompt: 'p',
          deps: [],
          successCriteria: {},
          maxTurns: 10,
        },
      ],
      edges: [],
    };
    const r = injectWireUp({ plan });
    expect(r.reason).toBe('team-cap-reached');
    expect(r.plan).toBe(plan);
  });

  it('skips injection for a single linear core-dev (no parallel reconciliation needed)', () => {
    // Solo core-dev plan: architect → core-dev. No parallel work to reconcile,
    // so injection is skipped to keep legacy 3-task plans (architect →
    // developer → qa) shape-compatible with existing e2e tests.
    const plan: Plan = {
      goal: 'g',
      team: { roles: [makeRole('architect'), makeRole('core-dev')] },
      nodes: [
        {
          id: 'a',
          role: 'architect',
          prompt: 'design',
          deps: [],
          successCriteria: {},
          maxTurns: 20,
        },
        {
          id: 'd',
          role: 'core-dev',
          prompt: 'build',
          deps: ['a'],
          successCriteria: { build: 'pnpm build' },
          maxTurns: 40,
        },
      ],
      edges: [{ from: 'a', to: 'd' }],
    };
    const r = injectWireUp({ plan });
    expect(r.reason).toBe('single-core-dev-skip');
    expect(r.plan).toBe(plan);
    expect(r.plan.nodes.find((n) => n.role === 'wire-up')).toBeUndefined();
  });
});
