/**
 * Prune `worker_runs` rows older than the retention window. The cron
 * spec runs this weekly; default retention is 30 days, which keeps the
 * UI's "recent runs" view useful while preventing unbounded growth.
 */
import { lt } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { workerRuns } from '@agent-harness/schemas';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function workerRunsPrune(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
  const rows = db.delete(workerRuns).where(lt(workerRuns.startedAt, cutoff)).run();
  return { deleted: rows.changes ?? 0 };
}
