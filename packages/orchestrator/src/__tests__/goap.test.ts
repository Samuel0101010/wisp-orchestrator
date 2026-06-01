import { describe, expect, it } from 'vitest';
import { planGoap, GoapBudgetExceededError, type Action } from '../goap.js';

const actions: Action[] = [
  { name: 'gather-info', cost: 1, preconditions: {}, effects: { hasInfo: true } },
  { name: 'analyze', cost: 2, preconditions: { hasInfo: true }, effects: { hasAnalysis: true } },
  {
    name: 'write-report',
    cost: 3,
    preconditions: { hasAnalysis: true },
    effects: { hasReport: true },
  },
];

describe('GOAP planner', () => {
  it('finds the cheapest plan from initial to goal', () => {
    const plan = planGoap({ initial: {}, goal: { hasReport: true }, actions });
    expect(plan).not.toBeNull();
    expect(plan!.map((a) => a.name)).toEqual(['gather-info', 'analyze', 'write-report']);
    expect(plan!.reduce((s, a) => s + a.cost, 0)).toBe(6);
  });

  it('returns null when no plan exists', () => {
    expect(planGoap({ initial: {}, goal: { unreachable: true }, actions })).toBeNull();
  });

  it('returns empty plan when goal already met', () => {
    const plan = planGoap({ initial: { hasReport: true }, goal: { hasReport: true }, actions });
    expect(plan).toEqual([]);
  });

  it('prefers cheaper alternative when two paths exist', () => {
    const fork: Action[] = [
      ...actions,
      { name: 'shortcut', cost: 100, preconditions: {}, effects: { hasReport: true } },
    ];
    const plan = planGoap({ initial: {}, goal: { hasReport: true }, actions: fork });
    expect(plan!.map((a) => a.name)).toEqual(['gather-info', 'analyze', 'write-report']);
  });

  // Regression — the old count-unsatisfied-predicates heuristic was inadmissible
  // whenever an action had cost 0, so the goal-at-pop test could return a
  // non-cheapest plan. Uniform-cost search must pick [p1, p2] (cost 1) over
  // [direct] (cost 2).
  it('returns the cheapest plan when a cost-0 action exists (inadmissible-heuristic regression)', () => {
    const fork: Action[] = [
      { name: 'direct', cost: 2, preconditions: {}, effects: { a: true, b: true } },
      { name: 'p1', cost: 1, preconditions: {}, effects: { a: true } },
      { name: 'p2', cost: 0, preconditions: { a: true }, effects: { b: true } },
    ];
    const plan = planGoap({ initial: {}, goal: { a: true, b: true }, actions: fork });
    expect(plan!.map((a) => a.name)).toEqual(['p1', 'p2']);
    expect(plan!.reduce((s, a) => s + a.cost, 0)).toBe(1);
  });

  // Regression — a single multi-effect action also breaks heuristic
  // admissibility even with strictly positive costs. The cheapest path here is
  // prep(1) + combo(1) = 2, not the single multi-effect bigstep(3).
  it('returns the cheapest plan with multi-effect actions and positive costs', () => {
    const fork: Action[] = [
      { name: 'bigstep', cost: 3, preconditions: {}, effects: { a: true, b: true } },
      { name: 'prep', cost: 1, preconditions: {}, effects: { ready: true } },
      { name: 'combo', cost: 1, preconditions: { ready: true }, effects: { a: true, b: true } },
    ];
    const plan = planGoap({ initial: {}, goal: { a: true, b: true }, actions: fork });
    expect(plan!.map((a) => a.name)).toEqual(['prep', 'combo']);
    expect(plan!.reduce((s, a) => s + a.cost, 0)).toBe(2);
  });

  // Regression — an unreachable goal over many independent boolean actions used
  // to enumerate the full 2^n state space synchronously (n=13 ~ 47s, pinning the
  // server event loop). The expansion cap now aborts deterministically and fast.
  it('throws GoapBudgetExceededError instead of hanging on an exponential search', () => {
    const many: Action[] = Array.from({ length: 16 }, (_, i) => ({
      name: `set-${i}`,
      cost: 1,
      preconditions: {},
      effects: { [`f${i}`]: true },
    }));
    const start = Date.now();
    expect(() =>
      planGoap(
        { initial: {}, goal: { unreachable: true }, actions: many },
        { maxExpansions: 20_000 },
      ),
    ).toThrow(GoapBudgetExceededError);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  // A genuinely reachable goal over the same action shape must still solve well
  // within budget and return the optimal (all-flags) plan.
  it('solves a reachable many-flag goal within budget', () => {
    const n = 12;
    const many: Action[] = Array.from({ length: n }, (_, i) => ({
      name: `set-${i}`,
      cost: 1,
      preconditions: {},
      effects: { [`f${i}`]: true },
    }));
    const goal: Record<string, boolean> = {};
    for (let i = 0; i < n; i++) goal[`f${i}`] = true;
    const plan = planGoap({ initial: {}, goal, actions: many });
    expect(plan).not.toBeNull();
    expect(plan!).toHaveLength(n);
    expect(plan!.reduce((s, a) => s + a.cost, 0)).toBe(n);
  });
});
