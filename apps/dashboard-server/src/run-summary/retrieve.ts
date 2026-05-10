import { eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { runSummaries, type RunSummary } from '@agent-harness/schemas';

export function getLatestSummaryForProject(projectId: string): RunSummary | undefined {
  return db
    .select()
    .from(runSummaries)
    .where(eq(runSummaries.projectId, projectId))
    .orderBy(desc(runSummaries.createdAt))
    .limit(1)
    .get();
}

export function listSummariesForProject(projectId: string, limit = 20): RunSummary[] {
  return db
    .select()
    .from(runSummaries)
    .where(eq(runSummaries.projectId, projectId))
    .orderBy(desc(runSummaries.createdAt))
    .limit(limit)
    .all();
}
