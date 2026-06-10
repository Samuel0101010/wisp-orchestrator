import { describe, it, expect } from 'vitest';
import {
  deriveTaskTitle,
  parsePlan,
  safeParsePlan,
  validateDag,
  validatePlanRoles,
  type Plan,
  type AgentSpec,
  type Team,
} from './plan.js';

const baseAgent: AgentSpec = {
  role: 'architect',
  model: 'opus',
  allowedTools: [],
  systemPrompt: 'a'.repeat(60),
};

const validPlan: Plan = {
  goal: 'Build a thing',
  team: {
    roles: [
      { ...baseAgent, role: 'architect' },
      { ...baseAgent, role: 'developer' },
      { ...baseAgent, role: 'qa' },
    ],
  },
  nodes: [
    {
      id: 'a',
      role: 'architect',
      prompt: 'design',
      deps: [],
      successCriteria: { build: 'pnpm build' },
      maxTurns: 10,
    },
    {
      id: 'b',
      role: 'developer',
      prompt: 'implement',
      deps: ['a'],
      successCriteria: {},
      maxTurns: 20,
    },
  ],
  edges: [{ from: 'a', to: 'b' }],
};

describe('parsePlan', () => {
  it('parses a valid Plan', () => {
    const result = parsePlan(validPlan);
    expect(result.goal).toBe('Build a thing');
    expect(result.nodes).toHaveLength(2);
  });

  it('fails parse when team.roles is empty', () => {
    const broken = {
      ...validPlan,
      team: { roles: [] },
    };
    const res = safeParsePlan(broken);
    expect(res.success).toBe(false);
  });

  it('parses old plan JSON without title/origin (backward compat)', () => {
    // validPlan deliberately has no title/origin anywhere — must keep parsing.
    const result = parsePlan(JSON.parse(JSON.stringify(validPlan)));
    expect(result.nodes[0]!.title).toBeUndefined();
    expect(result.nodes[0]!.origin).toBeUndefined();
    expect(result.team.roles[0]!.origin).toBeUndefined();
  });

  it('round-trips node title/origin and agent origin (not stripped by planSchema)', () => {
    const withIdentity = {
      ...validPlan,
      team: {
        roles: [{ ...baseAgent, origin: 'system' as const }, validPlan.team.roles[1]!],
      },
      nodes: [
        { ...validPlan.nodes[0]!, title: 'Design the schema', origin: 'planner' as const },
        validPlan.nodes[1]!,
      ],
    };
    const result = parsePlan(withIdentity);
    expect(result.nodes[0]!.title).toBe('Design the schema');
    expect(result.nodes[0]!.origin).toBe('planner');
    expect(result.team.roles[0]!.origin).toBe('system');
  });

  it('rejects invalid origin and empty/overlong title', () => {
    expect(
      safeParsePlan({
        ...validPlan,
        nodes: [{ ...validPlan.nodes[0]!, origin: 'user' }, validPlan.nodes[1]!],
      }).success,
    ).toBe(false);
    expect(
      safeParsePlan({
        ...validPlan,
        nodes: [{ ...validPlan.nodes[0]!, title: '' }, validPlan.nodes[1]!],
      }).success,
    ).toBe(false);
    expect(
      safeParsePlan({
        ...validPlan,
        nodes: [{ ...validPlan.nodes[0]!, title: 'x'.repeat(121) }, validPlan.nodes[1]!],
      }).success,
    ).toBe(false);
  });
});

describe('validatePlanRoles', () => {
  const storedTeam: Team = {
    roles: [
      { ...baseAgent, role: 'architect' },
      { ...baseAgent, role: 'developer' },
      { ...baseAgent, role: 'qa' },
      { ...baseAgent, role: 'reviewer' },
    ],
  };

  it('passes when plan roles are a subset of the stored team', () => {
    expect(validatePlanRoles(validPlan, storedTeam)).toEqual({ ok: true });
  });

  it('fails when the planner invents a team role', () => {
    const plan: Plan = {
      ...validPlan,
      team: { roles: [...validPlan.team.roles, { ...baseAgent, role: 'growth-hacker' }] },
    };
    const res = validatePlanRoles(plan, storedTeam);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.invalidTeamRoles).toEqual(['growth-hacker']);
      expect(res.invalidNodeRoles).toEqual([]);
    }
  });

  it('fails when the planner invents a node role', () => {
    const plan: Plan = {
      ...validPlan,
      nodes: [validPlan.nodes[0]!, { ...validPlan.nodes[1]!, role: 'devops-wizard' }],
    };
    const res = validatePlanRoles(plan, storedTeam);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.invalidTeamRoles).toEqual([]);
      expect(res.invalidNodeRoles).toEqual(['devops-wizard']);
    }
  });
});

describe('deriveTaskTitle', () => {
  it('prefers an explicit title (trimmed)', () => {
    expect(deriveTaskTitle({ id: 'n1', prompt: 'do something', title: '  Build the API  ' })).toBe(
      'Build the API',
    );
  });

  it('falls back to the first non-empty prompt line, truncated to 60 chars with …', () => {
    const longLine = 'a'.repeat(75);
    expect(deriveTaskTitle({ id: 'n1', prompt: `\n\n${longLine}\nrest` })).toBe(
      `${'a'.repeat(60)}…`,
    );
    expect(deriveTaskTitle({ id: 'n1', prompt: 'short first line\nsecond' })).toBe(
      'short first line',
    );
  });

  it('falls back to the node id when prompt is empty/whitespace', () => {
    expect(deriveTaskTitle({ id: 'n1', prompt: '' })).toBe('n1');
    expect(deriveTaskTitle({ id: 'n1', prompt: '   \n  \n' })).toBe('n1');
    expect(deriveTaskTitle({ id: 'n1', prompt: '', title: '   ' })).toBe('n1');
  });
});

describe('validateDag', () => {
  it('detects cycle (A->B, B->A)', () => {
    const cyclic: Plan = {
      ...validPlan,
      nodes: [
        { ...validPlan.nodes[0]!, id: 'a', deps: ['b'] },
        { ...validPlan.nodes[1]!, id: 'b', deps: ['a'] },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    };
    const res = validateDag(cyclic);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => /cycle/i.test(e))).toBe(true);
    }
  });

  it('detects unknown dep on a node', () => {
    const bad: Plan = {
      ...validPlan,
      nodes: [{ ...validPlan.nodes[0]! }, { ...validPlan.nodes[1]!, deps: ['ghost'] }],
      edges: [],
    };
    const res = validateDag(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes('ghost'))).toBe(true);
    }
  });

  it('detects edge referencing nonexistent node', () => {
    const bad: Plan = {
      ...validPlan,
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'nope' },
      ],
    };
    const res = validateDag(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes('nope'))).toBe(true);
    }
  });

  it('passes for valid acyclic plan', () => {
    expect(validateDag(validPlan)).toEqual({ ok: true });
  });

  it('treats empty plan as a vacuous DAG (parse passes, validateDag ok)', () => {
    const empty: Plan = {
      ...validPlan,
      nodes: [],
      edges: [],
    };
    const parsed = parsePlan(empty);
    expect(parsed.nodes).toEqual([]);
    expect(validateDag(empty)).toEqual({ ok: true });
  });
});
