import './setup.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { plans, projects, runs as runsTable, tasks as tasksTable } from '@agent-harness/schemas';
import { db, sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { RunRuntime } from '../orchestrator/runtime.js';
import type { Walker, WalkerDeps } from '@agent-harness/orchestrator';

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  sqlite.close();
});

interface FakeWalker {
  pauseForShutdownCalls: number;
  startArgs: Parameters<Walker['start']>[0] | null;
  startResolve: (() => void) | null;
}

/**
 * A minimal Walker stub that records pauseForShutdown calls. We only need to
 * exercise RunRuntime.pauseAllForShutdown — not the real DAG.
 */
function buildFakeWalker(_walkerDeps: WalkerDeps): { walker: Walker; fake: FakeWalker } {
  const fake: FakeWalker = {
    pauseForShutdownCalls: 0,
    startArgs: null,
    startResolve: null,
  };
  const walker: Partial<Walker> = {
    async start(args) {
      fake.startArgs = args;
      // Hold open until pauseForShutdown or external resolver fires.
      return new Promise((resolve) => {
        fake.startResolve = () => resolve('cancelled');
      });
    },
    async pauseForShutdown() {
      fake.pauseForShutdownCalls += 1;
      // Persist the run as paused/shutdown via the supplied dep.
      if (fake.startArgs) {
        await _walkerDeps.onRunState(fake.startArgs.runId, {
          status: 'paused',
          pausedReason: 'shutdown',
          resumeAt: null,
        });
      }
      // Resolve start() so cleanup can proceed.
      fake.startResolve?.();
    },
    async pause() {
      // unused
    },
    async resume() {
      // unused
    },
    async cancel() {
      fake.startResolve?.();
    },
    status() {
      return {
        runId: fake.startArgs?.runId ?? null,
        state: 'running',
        pausedReason: null,
        resumeAt: null,
        taskStates: {},
        retries: {},
      };
    },
  };
  return { walker: walker as Walker, fake };
}

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

describe('graceful shutdown', () => {
  it('pauseAllForShutdown calls walker.pauseForShutdown and persists paused/shutdown', async () => {
    let captured: FakeWalker | null = null;
    const runtime = new RunRuntime({
      db,
      ws: { publishToRun: () => {} },
      buildWalker: ({ walkerDeps }) => {
        const { walker, fake } = buildFakeWalker(walkerDeps);
        captured = fake;
        return walker;
      },
      snapshotIntervalMs: 60_000,
    });

    const { planId } = await seedLockedPlan();
    const start = await runtime.startRun({ planId });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const runId = start.runId;

    // Wait a few microtasks so walker.start() has been invoked.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(captured).not.toBeNull();

    await runtime.pauseAllForShutdown();
    expect(captured!.pauseForShutdownCalls).toBe(1);

    const row = await db.select().from(runsTable).where(eq(runsTable.id, runId)).get();
    expect(row?.status).toBe('paused');
    expect(row?.pausedReason).toBe('shutdown');
  });

  it('pauseAllForShutdown is a no-op when no walkers resident', async () => {
    const runtime = new RunRuntime({
      db,
      ws: { publishToRun: () => {} },
      snapshotIntervalMs: 60_000,
    });
    await expect(runtime.pauseAllForShutdown()).resolves.toBeUndefined();
  });
});

describe('runtime emit — task.tool-use (post-PR #22 parser fix)', () => {
  it('persists and publishes task.tool-use events alongside other events', async () => {
    const published: Array<{ runId: string; type: string }> = [];
    const captured: { emit: WalkerDeps['emit'] | null } = { emit: null };
    const runtime = new RunRuntime({
      db,
      ws: {
        publishToRun: (runId, ev) => {
          published.push({ runId, type: ev.type });
        },
      },
      snapshotIntervalMs: 60_000,
      buildWalker: ({ walkerDeps }) => {
        captured.emit = walkerDeps.emit;
        const walker: Partial<Walker> = {
          async start() {
            return new Promise(() => undefined);
          },
          async pauseForShutdown() {
            // unused
          },
          async cancel() {
            // unused
          },
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

    // Send a task.tool-use through the walker's emit.
    captured.emit!({
      type: 'task.tool-use',
      payload: { taskId: 't1', tool: 'Read', input: { path: '/x' } },
    });
    // And a normal event for comparison.
    captured.emit!({
      type: 'task.started',
      payload: { taskId: 't1' },
    });

    // Wait briefly for any async side-effects.
    await new Promise((r) => setImmediate(r));

    // Tool-use events now carry signal (the orchestrator parser was fixed in
    // PR #22 to read `assistant.message.content[type=tool_use]`), so the
    // runtime persists + publishes them like every other event.
    expect(published.some((p) => p.type === 'task.tool-use' && p.runId === runId)).toBe(true);
    expect(published.some((p) => p.type === 'task.started' && p.runId === runId)).toBe(true);
  });
});

describe('resume — sessionId edge cases (M4)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    consoleSpy?.mockRestore();
  });

  it('logs resume-no-session for tasks with worktree but null sessionId', async () => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // Build a fake walker that swallows start() so we can inspect log output
    // without needing the real walker to drain.
    const runtime = new RunRuntime({
      db,
      ws: { publishToRun: () => {} },
      snapshotIntervalMs: 60_000,
      buildWalker: ({ walkerDeps }) => {
        void walkerDeps;
        const walker: Partial<Walker> = {
          async start() {
            return new Promise(() => undefined); // never settles
          },
          async pauseForShutdown() {
            // unused
          },
          async cancel() {
            // unused
          },
        };
        return walker as Walker;
      },
    });

    // Seed: project + plan + paused run + a single task with worktreeBranch
    // set but sessionId null.
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
          id: 'no-session-task',
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
    const runId = randomUUID();
    await db
      .insert(runsTable)
      .values({
        id: runId,
        planId,
        status: 'paused',
        pausedReason: 'shutdown',
        startedAt: new Date(),
        budgetMinutes: 60,
        budgetTurns: 100,
        maxParallel: 2,
      })
      .run();
    await db
      .insert(tasksTable)
      .values({
        id: 'no-session-task',
        planId,
        role: 'architect',
        title: 't',
        deps: [],
        status: 'pending',
        worktreeBranch: 'harness/r/no-session-task',
        sessionId: null,
      })
      .run();

    const result = await runtime.resumeRun(runId);
    expect(result.ok).toBe(true);

    const logs = consoleSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('resume-no-session'));
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.event).toBe('resume-no-session');
    expect(parsed.runId).toBe(runId);
    expect(parsed.taskId).toBe('no-session-task');
    expect(parsed.worktreeBranch).toBe('harness/r/no-session-task');
  });
});
