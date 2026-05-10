import { db } from '../db/index.js';
import { runs } from '@agent-harness/schemas';
import { eq, and } from 'drizzle-orm';
import { checkAutopilotBudget } from './budget.js';

export interface AutopilotTickResult {
  resumed: string[];
  halted: string[];
}

export async function tickAutopilot(): Promise<AutopilotTickResult> {
  const candidates = db.select().from(runs)
    .where(and(eq(runs.autopilotMode, true), eq(runs.status, 'paused')))
    .all();
  const resumed: string[] = [];
  const halted: string[] = [];
  for (const run of candidates) {
    const tokens = run.tokensInTotal + run.tokensOutTotal;
    const v = checkAutopilotBudget(run, tokens);
    if (v.exceeded) {
      await db.update(runs).set({
        status: 'cancelled',
        endedAt: new Date(),
        outcome: 'budget_exceeded',
      }).where(eq(runs.id, run.id)).run();
      halted.push(run.id);
      continue;
    }
    try {
      // Defer-import to avoid circular import: routes/runs.ts already imports many things
      const { getDefaultRuntime } = await import('../routes/runs.js');
      const runtime = getDefaultRuntime();
      const result = await runtime.resumeRun(run.id);
      if (result.ok) {
        resumed.push(run.id);
      } else {
        halted.push(run.id);
      }
    } catch (err) {
      console.error('[autopilot-tick] failed to resume', run.id, err);
      halted.push(run.id);
    }
  }
  return { resumed, halted };
}
