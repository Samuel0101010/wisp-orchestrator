import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { plans, projects, tasks as tasksTable } from '@agent-harness/schemas';
import { db, sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { RunRuntime } from '../orchestrator/runtime.js';
import type { Walker } from '@agent-harness/orchestrator';

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  sqlite.close();
});

async function seedLockedPlanWithTwoNodes(): Promise<{ planId: string; projectId: string }> {
  const projectId = randomUUID();
  await db
    .insert(projects)
    .values({
      id: projectId,
      name: 'p',
      goal: 'g',
      repoPath: '/tmp/repo',
      createdAt: new Date(),
    })
    .run();
  const planId = randomUUID();
  const plan = {
    goal: 'g',
    team: {
      roles: [
        { role: 'architect', model: 'opus', allowedTools: [], systemPrompt: 'a'.repeat(60) },
        { role: 'developer', model: 'sonnet', allowedTools: [], systemPrompt: 'd'.repeat(60) },
      ],
    },
    nodes: [
      { id: 'n1', role: 'architect', prompt: 'p', deps: [], successCriteria: {}, maxTurns: 5 },
      {
        id: 'n2',
        role: 'developer',
        prompt: 'p',
        deps: ['n1'],
        successCriteria: {},
        maxTurns: 5,
      },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
  };
  await db
    .insert(plans)
    .values({ id: planId, projectId, dagJson: plan as unknown, status: 'locked' })
    .run();
  return { planId, projectId };
}

function makeRuntime(): RunRuntime {
  return new RunRuntime({
    db,
    ws: { publishToRun: () => {} },
    snapshotIntervalMs: 60_000,
    buildWalker: () => {
      const walker: Partial<Walker> = {
        async start() {
          return new Promise(() => undefined);
        },
        async pauseForShutdown() {},
        async cancel() {},
      };
      return walker as Walker;
    },
  });
}

describe('RunRuntime.startRun — task state reset between runs', () => {
  it('resets tasks to pending + zeros counters when a new run starts on a plan with prior failed/done rows', async () => {
    // Regression: tasks are keyed by (planId, id) and shared across runs, so
    // a second run on the same plan was rendering the previous run's
    // failed/done statuses (and non-zero token/turn/duration counters) in
    // the UI until the walker reached each task and overwrote them.
    const runtime = makeRuntime();
    const { planId } = await seedLockedPlanWithTwoNodes();

    // First run: tasks should land pending.
    const first = await runtime.startRun({ planId });
    expect(first.ok).toBe(true);

    let rows = await db.select().from(tasksTable).where(eq(tasksTable.planId, planId)).all();
    expect(rows.map((r) => r.status).sort()).toEqual(['pending', 'pending']);

    // Simulate a finished run: mark n1 failed with metrics, n2 done with metrics.
    await db
      .update(tasksTable)
      .set({
        status: 'failed',
        worktreeBranch: 'harness/old/n1',
        sessionId: 'old-sess-1',
        tokensIn: 9000,
        tokensOut: 7000,
        turnsUsed: 8,
        durationMs: 80_000,
      })
      .where(eq(tasksTable.id, 'n1'))
      .run();
    await db
      .update(tasksTable)
      .set({
        status: 'done',
        worktreeBranch: 'harness/old/n2',
        sessionId: 'old-sess-2',
        tokensIn: 500,
        tokensOut: 300,
        turnsUsed: 3,
        durationMs: 12_000,
      })
      .where(eq(tasksTable.id, 'n2'))
      .run();

    // Re-lock the plan (startRun expects status='locked'; first startRun does
    // not currently mutate plan.status, but this stays robust if it ever does).
    await db.update(plans).set({ status: 'locked' }).where(eq(plans.id, planId)).run();

    // Second run on the SAME plan: every task row must be reset.
    const second = await runtime.startRun({ planId });
    expect(second.ok).toBe(true);

    rows = await db.select().from(tasksTable).where(eq(tasksTable.planId, planId)).all();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('pending');
      expect(row.worktreeBranch).toBeNull();
      expect(row.sessionId).toBeNull();
      expect(row.tokensIn).toBe(0);
      expect(row.tokensOut).toBe(0);
      expect(row.turnsUsed).toBe(0);
      expect(row.durationMs).toBe(0);
    }
  });
});
