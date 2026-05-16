import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { runs, plans as plansTable, runSummaries } from '@wisp/schemas';
import { summarizeRun } from '../../run-summary/summarizer.js';

let injectedRegistry: import('../../skills/registry.js').SkillRegistry | null = null;

export function setRunSummaryFallbackRegistry(
  reg: import('../../skills/registry.js').SkillRegistry,
): void {
  injectedRegistry = reg;
}

/**
 * Find runs that completed in the last 24h but have no run_summaries row,
 * summarize each one. Bounded to 5 per tick to avoid token bursts.
 */
export async function runSummaryFallback(): Promise<{ summarized: string[]; skipped: number }> {
  if (!injectedRegistry) return { summarized: [], skipped: 0 };

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const candidates = db
    .select({ id: runs.id, planId: runs.planId, endedAt: runs.endedAt })
    .from(runs)
    .leftJoin(runSummaries, eq(runSummaries.runId, runs.id))
    .where(sql`${runs.outcome} IS NOT NULL AND ${runSummaries.runId} IS NULL`)
    .all()
    .filter((r) => {
      if (!r.endedAt) return false;
      const ts =
        r.endedAt instanceof Date
          ? r.endedAt.getTime()
          : new Date(r.endedAt as unknown as string).getTime();
      return ts > cutoff;
    })
    .slice(0, 5);

  const summarized: string[] = [];
  for (const c of candidates) {
    const plan = db.select().from(plansTable).where(eq(plansTable.id, c.planId)).get();
    if (!plan) continue;
    try {
      await summarizeRun({ runId: c.id, projectId: plan.projectId, registry: injectedRegistry });
      summarized.push(c.id);
    } catch (err) {
      console.error('[run-summary-fallback] failed', c.id, err);
    }
  }
  return { summarized, skipped: candidates.length - summarized.length };
}
