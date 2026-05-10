import type { Run } from '@agent-harness/schemas';

export interface BudgetVerdict {
  exceeded: boolean;
  reason: string | null;
}

export function checkAutopilotBudget(run: Run, totalTokens: number): BudgetVerdict {
  if (!run.autopilotMode) return { exceeded: false, reason: null };

  if (run.autopilotBudgetMinutes != null && run.autopilotStartedAt) {
    const startedAtMs = run.autopilotStartedAt instanceof Date
      ? run.autopilotStartedAt.getTime()
      : new Date(run.autopilotStartedAt as unknown as string).getTime();
    const elapsedMin = (Date.now() - startedAtMs) / 60_000;
    if (elapsedMin > run.autopilotBudgetMinutes) {
      return { exceeded: true, reason: `wallclock ${elapsedMin.toFixed(0)}m > ${run.autopilotBudgetMinutes}m` };
    }
  }
  if (run.autopilotBudgetTokens != null && totalTokens > run.autopilotBudgetTokens) {
    return { exceeded: true, reason: `tokens ${totalTokens} > ${run.autopilotBudgetTokens}` };
  }
  return { exceeded: false, reason: null };
}
