import './setup.js';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkpoints,
  plans,
  projects,
  runs as runsTable,
  tasks as tasksTable,
} from '@wisp/schemas';
import { db, sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { findResumableRuns, fixUpAbruptCrashes } from '../orchestrator/recovery.js';

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  sqlite.close();
});

async function seedRunWithTasks(args: {
  runStatus: 'running' | 'paused' | 'completed';
  pausedReason?: 'rate-limit' | 'user' | 'shutdown' | null;
  taskStatuses: Array<'pending' | 'running' | 'done' | 'failed'>;
}): Promise<{ runId: string; planId: string; projectId: string; projectName: string }> {
  const projectId = randomUUID();
  const projectName = `proj-${projectId.slice(0, 6)}`;
  await db
    .insert(projects)
    .values({
      id: projectId,
      name: projectName,
      goal: 'g',
      repoPath: '/tmp/repo',
      createdAt: new Date(),
    })
    .run();
  const planId = randomUUID();
  await db
    .insert(plans)
    .values({
      id: planId,
      projectId,
      dagJson: { goal: 'g', nodes: [] } as unknown,
      status: 'locked',
    })
    .run();
  const runId = randomUUID();
  await db
    .insert(runsTable)
    .values({
      id: runId,
      planId,
      status: args.runStatus,
      pausedReason: args.pausedReason ?? null,
      startedAt: new Date(),
      budgetMinutes: 60,
      budgetTurns: 100,
      maxParallel: 2,
    })
    .run();

  for (let i = 0; i < args.taskStatuses.length; i++) {
    await db
      .insert(tasksTable)
      .values({
        id: `${runId}-t${i}`,
        planId,
        role: 'developer',
        title: `t${i}`,
        deps: [],
        status: args.taskStatuses[i]!,
      })
      .run();
  }
  return { runId, planId, projectId, projectName };
}

describe('recovery — findResumableRuns', () => {
  it('returns running runs with hadAbruptCrash=true', async () => {
    const { runId, projectName } = await seedRunWithTasks({
      runStatus: 'running',
      taskStatuses: ['running', 'done', 'pending'],
    });
    const result = await findResumableRuns(db);
    const found = result.find((r) => r.runId === runId);
    expect(found).toBeDefined();
    expect(found!.hadAbruptCrash).toBe(true);
    expect(found!.status).toBe('running');
    expect(found!.projectName).toBe(projectName);
    expect(found!.taskCounts).toEqual({
      pending: 1,
      running: 1,
      paused: 0,
      done: 1,
      failed: 0,
    });
    expect(found!.lastCheckpointAt).toBeNull();
  });

  it('returns paused-shutdown runs with hadAbruptCrash=false', async () => {
    const { runId } = await seedRunWithTasks({
      runStatus: 'paused',
      pausedReason: 'shutdown',
      taskStatuses: ['done', 'failed'],
    });
    const result = await findResumableRuns(db);
    const found = result.find((r) => r.runId === runId);
    expect(found).toBeDefined();
    expect(found!.hadAbruptCrash).toBe(false);
    expect(found!.pausedReason).toBe('shutdown');
    expect(found!.taskCounts.done).toBe(1);
    expect(found!.taskCounts.failed).toBe(1);
  });

  it('does not return paused-rate-limit runs (only included after fixUpAbruptCrashes rewrites them)', async () => {
    const { runId } = await seedRunWithTasks({
      runStatus: 'paused',
      pausedReason: 'rate-limit',
      taskStatuses: ['pending'],
    });
    const result = await findResumableRuns(db);
    expect(result.find((r) => r.runId === runId)).toBeUndefined();
  });

  it('does not return completed runs', async () => {
    const { runId } = await seedRunWithTasks({
      runStatus: 'completed',
      taskStatuses: ['done'],
    });
    const result = await findResumableRuns(db);
    expect(result.find((r) => r.runId === runId)).toBeUndefined();
  });

  it('surfaces lastCheckpointAt timestamp when checkpoint exists', async () => {
    const { runId } = await seedRunWithTasks({
      runStatus: 'paused',
      pausedReason: 'shutdown',
      taskStatuses: ['pending'],
    });
    const ts = new Date(Date.now() - 5_000);
    await db
      .insert(checkpoints)
      .values({ id: randomUUID(), runId, snapshotPath: '/tmp/s.json', ts })
      .run();
    const result = await findResumableRuns(db);
    const found = result.find((r) => r.runId === runId);
    expect(found!.lastCheckpointAt).toBe(ts.getTime());
  });
});

describe('recovery — fixUpAbruptCrashes', () => {
  it('rewrites running runs to paused/shutdown and pending-tasks-orphans to pending', async () => {
    const { runId, planId } = await seedRunWithTasks({
      runStatus: 'running',
      taskStatuses: ['running', 'done', 'running'],
    });
    const fixed = await fixUpAbruptCrashes(db);
    expect(fixed).toBeGreaterThanOrEqual(1);

    const runRow = await db.select().from(runsTable).all();
    const updated = runRow.find((x) => x.id === runId);
    expect(updated!.status).toBe('paused');
    expect(updated!.pausedReason).toBe('shutdown');

    const taskRows = await db.select().from(tasksTable).all();
    const fixedTasks = taskRows.filter((t) => t.planId === planId);
    // No 'running' task should remain.
    expect(fixedTasks.every((t) => t.status !== 'running')).toBe(true);
    // Done tasks preserved.
    expect(fixedTasks.some((t) => t.status === 'done')).toBe(true);
  });

  it('is idempotent on a clean DB', async () => {
    const fixed = await fixUpAbruptCrashes(db);
    expect(fixed).toBe(0);
  });

  it('rewrites paused/rate-limit runs to paused/shutdown and leaves resumeAt intact', async () => {
    const futureResumeAt = new Date(Date.now() + 60_000);
    const { runId, planId } = await seedRunWithTasks({
      runStatus: 'paused',
      pausedReason: 'rate-limit',
      taskStatuses: ['pending', 'done'],
    });
    // Set resumeAt directly via a follow-up update (seed helper doesn't accept it).
    await db
      .update(runsTable)
      .set({ resumeAt: futureResumeAt })
      .where(eq(runsTable.id, runId))
      .run();

    const fixed = await fixUpAbruptCrashes(db);
    expect(fixed).toBeGreaterThanOrEqual(1);

    const row = await db.select().from(runsTable).where(eq(runsTable.id, runId)).get();
    expect(row!.status).toBe('paused');
    expect(row!.pausedReason).toBe('shutdown');
    // resumeAt preserved.
    expect(row!.resumeAt?.getTime()).toBe(futureResumeAt.getTime());

    // Tasks unchanged by rate-limit rewrite (no running tasks present).
    const taskRows = await db.select().from(tasksTable).where(eq(tasksTable.planId, planId)).all();
    const statuses = taskRows.map((t) => t.status).sort();
    expect(statuses).toEqual(['done', 'pending']);
  });

  it('rate-limit rewrite is idempotent (a second run is a no-op for those rows)', async () => {
    // Seed once + fix once.
    const { runId } = await seedRunWithTasks({
      runStatus: 'paused',
      pausedReason: 'rate-limit',
      taskStatuses: ['pending'],
    });
    await fixUpAbruptCrashes(db);
    const row1 = await db.select().from(runsTable).where(eq(runsTable.id, runId)).get();
    expect(row1!.pausedReason).toBe('shutdown');
    // Second invocation must not flip anything for this run.
    const fixedSecond = await fixUpAbruptCrashes(db);
    const row2 = await db.select().from(runsTable).where(eq(runsTable.id, runId)).get();
    expect(row2!.pausedReason).toBe('shutdown');
    // And the count returned for THIS run should be 0 (no new rate-limit rows).
    // Other tests may have left their own data; assert the row didn't change.
    expect(row2!.status).toBe('paused');
    expect(fixedSecond).toBeGreaterThanOrEqual(0);
  });

  it('findResumableRuns surfaces rate-limit rows after fixup as shutdown', async () => {
    const { runId } = await seedRunWithTasks({
      runStatus: 'paused',
      pausedReason: 'rate-limit',
      taskStatuses: ['pending'],
    });
    await fixUpAbruptCrashes(db);
    const result = await findResumableRuns(db);
    const found = result.find((r) => r.runId === runId);
    expect(found).toBeDefined();
    expect(found!.pausedReason).toBe('shutdown');
    expect(found!.hadAbruptCrash).toBe(false);
  });
});
