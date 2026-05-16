import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { events as eventsTable, plans, projects } from '@wisp/schemas';
import { db, sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { RunRuntime } from '../orchestrator/runtime.js';
import type { Walker, WalkerDeps } from '@wisp/orchestrator';

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  sqlite.close();
});

async function seedLockedPlan(): Promise<{ planId: string; projectId: string }> {
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
        { role: 'qa', model: 'sonnet', allowedTools: [], systemPrompt: 'q'.repeat(60) },
      ],
    },
    nodes: [
      {
        id: 'n1',
        role: 'architect',
        prompt: 'p',
        deps: [],
        successCriteria: {},
        maxTurns: 5,
      },
    ],
    edges: [],
  };
  await db
    .insert(plans)
    .values({ id: planId, projectId, dagJson: plan as unknown, status: 'locked' })
    .run();
  return { planId, projectId };
}

describe('runtime emit — harness.verify-failed', () => {
  it('persists harness.verify-failed event to events table with full payload', async () => {
    const captured: { emit: WalkerDeps['emit'] | null } = { emit: null };
    const runtime = new RunRuntime({
      db,
      ws: { publishToRun: () => {} },
      snapshotIntervalMs: 60_000,
      buildWalker: ({ walkerDeps }) => {
        captured.emit = walkerDeps.emit;
        const walker: Partial<Walker> = {
          async start() {
            return new Promise(() => undefined); // never settles — keeps the run live
          },
          async pauseForShutdown() {},
          async cancel() {},
        };
        return walker as Walker;
      },
    });

    const { planId } = await seedLockedPlan();
    const start = await runtime.startRun({ planId });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const runId = start.runId;

    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(captured.emit).not.toBeNull();

    captured.emit!({
      type: 'harness.verify-failed',
      payload: {
        taskId: 't-1',
        attempt: 2,
        failures: [
          { kind: 'lint', cmd: 'pnpm lint', exitCode: 1, tail: 'no-unused-vars: foo' },
          { kind: 'test', cmd: 'pnpm test', exitCode: 1, tail: 'expected 3 got 4' },
        ],
        output:
          '[lint] pnpm lint (200ms, exit=1)\nno-unused-vars: foo\n[test] pnpm test (1s, exit=1)\nexpected 3 got 4',
      },
    });

    await new Promise((r) => setImmediate(r));

    const rows = await db.select().from(eventsTable).where(eq(eventsTable.runId, runId)).all();
    const verifyEvent = rows.find((r) => r.type === 'harness.verify-failed');
    expect(verifyEvent).toBeDefined();
    expect(verifyEvent!.taskId).toBe('t-1');
    const payload = verifyEvent!.payload as {
      taskId: string;
      attempt: number;
      failures: Array<{ kind: string; cmd: string; exitCode: number; tail: string }>;
      output: string;
    };
    expect(payload.attempt).toBe(2);
    expect(payload.failures).toHaveLength(2);
    expect(payload.failures[0]!.kind).toBe('lint');
    expect(payload.failures[1]!.kind).toBe('test');
    expect(payload.output).toContain('no-unused-vars');
  });
});
