import { describe, expect, it } from 'vitest';
import { checkAutopilotBudget } from '../autopilot/budget.js';

const baseRun = {
  // satisfy the Run shape minimally — only the fields budget cares about matter
  id: 'r', planId: 'p', startedAt: null, endedAt: null,
  outcome: null, status: 'paused' as const,
  budgetMinutes: 1, budgetTurns: 1, maxParallel: 1,
  tokensInTotal: 0, tokensOutTotal: 0, turnsTotal: 0,
  pausedReason: null, resumeAt: null,
  autopilotMode: false,
  autopilotBudgetMinutes: null,
  autopilotBudgetTokens: null,
  autopilotStartedAt: null,
};

describe('autopilot budget', () => {
  it('passes when not in autopilot mode', () => {
    expect(checkAutopilotBudget({ ...baseRun, autopilotMode: false } as any, 1e9).exceeded).toBe(false);
  });
  it('passes when autopilot on and no budget set', () => {
    expect(checkAutopilotBudget({ ...baseRun, autopilotMode: true } as any, 1_000_000).exceeded).toBe(false);
  });
  it('halts on token excess', () => {
    expect(checkAutopilotBudget(
      { ...baseRun, autopilotMode: true, autopilotBudgetTokens: 100 } as any,
      200,
    ).exceeded).toBe(true);
  });
  it('halts on wallclock excess', () => {
    expect(checkAutopilotBudget(
      { ...baseRun, autopilotMode: true, autopilotBudgetMinutes: 1, autopilotStartedAt: new Date(Date.now() - 120_000) } as any,
      0,
    ).exceeded).toBe(true);
  });
});
