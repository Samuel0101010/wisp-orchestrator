/**
 * Recovery (E2) — boot-time scan for runs that need attention after a server
 * restart.
 *
 * Two scenarios:
 *
 *   1. Graceful shutdown: server received SIGTERM/SIGINT, called
 *      `walker.pauseForShutdown()`, which marked the run
 *      `status='paused', pausedReason='shutdown'` and persisted a checkpoint.
 *      Recovery just surfaces the run to the UI for explicit resume.
 *
 *   2. Abrupt crash: server died without graceful pause, leaving the run with
 *      `status='running'` and possibly tasks with `status='running'`.
 *      `fixUpAbruptCrashes()` rewrites these orphan rows to `paused`/`paused`
 *      so subsequent UI loads see a coherent state.
 *
 * Recovery does NOT auto-rebuild walkers — explicit user resume is required.
 * `findResumableRuns()` returns enough metadata for the UI to render a
 * "Resumable Run" card, after which the user POSTs `/api/runs/:id/resume`.
 */

import { and, desc, eq, inArray, or } from 'drizzle-orm';
import {
  checkpoints,
  plans,
  projects,
  runs,
  tasks,
  type RunPausedReason,
  type RunStatus,
} from '@agent-harness/schemas';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export interface ResumableRunTaskCounts {
  pending: number;
  running: number;
  paused: number;
  done: number;
  failed: number;
}

export interface ResumableRun {
  runId: string;
  planId: string;
  projectId: string;
  projectName: string;
  status: RunStatus;
  pausedReason: RunPausedReason | null;
  lastCheckpointAt: number | null;
  taskCounts: ResumableRunTaskCounts;
  /** True when the server died without a graceful pause (status was 'running'). */
  hadAbruptCrash: boolean;
}

/**
 * Find runs that the user can resume after a server restart:
 *
 *   - `status='running'` (orphan from a crash — `hadAbruptCrash=true`)
 *   - `status='paused' AND pausedReason='shutdown'` (graceful)
 *
 * Note: rate-limit pauses with a future `resumeAt` are NOT resumable from the
 * UI here — they auto-resume when the timer fires.
 */
export async function findResumableRuns(db: BetterSQLite3Database): Promise<ResumableRun[]> {
  const runRows = await db
    .select()
    .from(runs)
    .where(
      or(
        eq(runs.status, 'running'),
        and(eq(runs.status, 'paused'), eq(runs.pausedReason, 'shutdown')),
      ),
    )
    .all();

  if (runRows.length === 0) return [];

  // Batch-load plans + projects to avoid N+1.
  const planIds = Array.from(new Set(runRows.map((r) => r.planId)));
  const planRows =
    planIds.length > 0 ? await db.select().from(plans).where(inArray(plans.id, planIds)).all() : [];
  const planById = new Map(planRows.map((p) => [p.id, p]));

  const projectIds = Array.from(new Set(planRows.map((p) => p.projectId)));
  const projectRows =
    projectIds.length > 0
      ? await db.select().from(projects).where(inArray(projects.id, projectIds)).all()
      : [];
  const projectById = new Map(projectRows.map((p) => [p.id, p]));

  const result: ResumableRun[] = [];
  for (const r of runRows) {
    const plan = planById.get(r.planId);
    if (!plan) continue; // Plan vanished — skip orphan run row.
    const project = projectById.get(plan.projectId);
    if (!project) continue;

    const taskRows = await db.select().from(tasks).where(eq(tasks.planId, plan.id)).all();
    const counts: ResumableRunTaskCounts = {
      pending: 0,
      running: 0,
      paused: 0,
      done: 0,
      failed: 0,
    };
    for (const t of taskRows) {
      // The DB has no 'paused' task status — `pending` is overloaded for paused.
      // We don't try to disambiguate here.
      switch (t.status) {
        case 'pending':
          counts.pending += 1;
          break;
        case 'ready':
          counts.pending += 1;
          break;
        case 'running':
          counts.running += 1;
          break;
        case 'done':
          counts.done += 1;
          break;
        case 'failed':
          counts.failed += 1;
          break;
        case 'skipped':
          counts.failed += 1;
          break;
      }
    }

    const lastCheckpoint = await db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.runId, r.id))
      .orderBy(desc(checkpoints.ts))
      .get();

    result.push({
      runId: r.id,
      planId: plan.id,
      projectId: project.id,
      projectName: project.name,
      status: r.status,
      pausedReason: r.pausedReason ?? null,
      lastCheckpointAt: lastCheckpoint ? lastCheckpoint.ts.getTime() : null,
      taskCounts: counts,
      hadAbruptCrash: r.status === 'running',
    });
  }
  return result;
}

/**
 * Rewrite orphaned rows so the UI sees a coherent state after restart:
 *
 *   1. `status='running'` (server died mid-run): rewrite to
 *      `paused/shutdown`, flip any `tasks.status='running'` to `pending`.
 *   2. `status='paused' AND pausedReason='rate-limit'`: rewrite the
 *      `pausedReason` to `'shutdown'` so the user explicitly resumes. The
 *      auto-resume timer was in-memory only and a stale `resumeAt` from
 *      before the restart is unreliable. We leave `resumeAt` as forensic info.
 *
 * Idempotent: subsequent boots find no matching rows and no-op.
 *
 * Returns the number of run rows rewritten.
 */
export async function fixUpAbruptCrashes(db: BetterSQLite3Database): Promise<number> {
  let count = 0;

  // (1) Abrupt-crash orphans: status='running'.
  const orphans = await db.select().from(runs).where(eq(runs.status, 'running')).all();
  for (const r of orphans) {
    await db
      .update(runs)
      .set({ status: 'paused', pausedReason: 'shutdown', resumeAt: null })
      .where(eq(runs.id, r.id))
      .run();
    await db
      .update(tasks)
      .set({ status: 'pending' })
      .where(and(eq(tasks.planId, r.planId), eq(tasks.status, 'running')))
      .run();
    console.log(
      JSON.stringify({
        event: 'recovery-fixup',
        kind: 'abrupt-crash',
        runId: r.id,
      }),
    );
    count += 1;
  }

  // (2) Rate-limit pauses: rewrite to 'shutdown' so user explicitly resumes.
  const rateLimited = await db
    .select()
    .from(runs)
    .where(and(eq(runs.status, 'paused'), eq(runs.pausedReason, 'rate-limit')))
    .all();
  for (const r of rateLimited) {
    await db
      .update(runs)
      .set({ pausedReason: 'shutdown' })
      // resumeAt left intact for forensic visibility.
      .where(eq(runs.id, r.id))
      .run();
    console.log(
      JSON.stringify({
        event: 'recovery-fixup',
        kind: 'rate-limit-rewrite',
        runId: r.id,
        priorResumeAt: r.resumeAt instanceof Date ? r.resumeAt.toISOString() : null,
      }),
    );
    count += 1;
  }

  return count;
}
