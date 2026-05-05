import { describe, it, expect } from 'vitest';
import { parsePlan, safeParsePlan, validateDag, type Plan, type AgentSpec } from './plan.js';

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
