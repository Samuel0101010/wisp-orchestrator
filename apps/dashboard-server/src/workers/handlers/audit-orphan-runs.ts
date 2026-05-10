import { db } from '../../db/index.js';
import { runs, events } from '@agent-harness/schemas';
import { eq, sql } from 'drizzle-orm';

export async function auditOrphanRuns(): Promise<{ orphans: string[] }> {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  const rows = db
    .select({ id: runs.id, last: sql<number>`MAX(${events.ts})`.as('last') })
    .from(runs)
    .leftJoin(events, eq(events.runId, runs.id))
    .where(eq(runs.status, 'running'))
    .groupBy(runs.id)
    .all();
  const orphans = rows.filter((r) => r.last == null || r.last < cutoff).map((r) => r.id);
  return { orphans };
}
