import { describe, expect, it } from 'vitest';
import { planGoap, type Action } from '../goap.js';

const actions: Action[] = [
  { name: 'gather-info', cost: 1, preconditions: {}, effects: { hasInfo: true } },
  { name: 'analyze', cost: 2, preconditions: { hasInfo: true }, effects: { hasAnalysis: true } },
  { name: 'write-report', cost: 3, preconditions: { hasAnalysis: true }, effects: { hasReport: true } },
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
});
