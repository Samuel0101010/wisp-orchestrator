import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { plans, projects } from '@wisp/schemas';
import { db, sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { RunRuntime } from '../orchestrator/runtime.js';
import type { Walker } from '@wisp/orchestrator';

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  sqlite.close();
});

async function seedProject(): Promise<string> {
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
  return projectId;
}

async function seedLockedPlan(projectId: string): Promise<string> {
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
    ],
    edges: [],
  };
  await db
    .insert(plans)
    .values({ id: planId, projectId, dagJson: plan as unknown, status: 'locked' })
    .run();
  return planId;
}

interface StubHandle {
  /** Mutable walker state the stub's status() reads from. */
  state: 'idle' | 'running' | 'paused' | 'completed';
}

/**
 * Runtime with a stub walker whose start() never settles, so each started run
 * stays resident — exactly the condition the per-project guard keys off. Each
 * built walker pushes a handle so tests can flip its reported state.
 */
function makeRuntime(): { runtime: RunRuntime; handles: StubHandle[] } {
  const handles: StubHandle[] = [];
  const runtime = new RunRuntime({
    db,
    ws: { publishToRun: () => {} },
    snapshotIntervalMs: 60_000,
    buildWalker: () => {
      const handle: StubHandle = { state: 'running' };
      handles.push(handle);
      const walker: Partial<Walker> = {
        async start() {
          return new Promise(() => undefined);
        },
        async pauseForShutdown() {},
        async cancel() {},
        status() {
          return {
            runId: null,
            state: handle.state,
            pausedReason: null,
            resumeAt: null,
            taskStates: {},
            retries: {},
          };
        },
      };
      return walker as Walker;
    },
  });
  return { runtime, handles };
}

describe('RunRuntime.startRun — per-project active-run guard', () => {
  it('409 run_already_active when another run for the SAME project is resident', async () => {
    const { runtime } = makeRuntime();
    const projectId = await seedProject();
    const planA = await seedLockedPlan(projectId);
    const planB = await seedLockedPlan(projectId);

    const first = await runtime.startRun({ planId: planA });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await runtime.startRun({ planId: planB });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(409);
    expect(second.error).toBe('run_already_active');
    expect(second.details).toEqual({ activeRunId: first.runId });
  });

  it('a resident run does NOT block a different project', async () => {
    const { runtime } = makeRuntime();
    const projectA = await seedProject();
    const projectB = await seedProject();
    const planA = await seedLockedPlan(projectA);
    const planB = await seedLockedPlan(projectB);

    const first = await runtime.startRun({ planId: planA });
    expect(first.ok).toBe(true);

    const second = await runtime.startRun({ planId: planB });
    expect(second.ok).toBe(true);
  });

  it('allows the self-healing chain: parentRunId pointing at a FINALIZED resident', async () => {
    // handlePostRunSuccess spawns the follow-up run while the parent walker
    // is still resident (pre grace-window delete) but already finalized
    // (state 'completed'). That exact combination must pass the guard.
    const { runtime, handles } = makeRuntime();
    const projectId = await seedProject();
    const planA = await seedLockedPlan(projectId);
    const planB = await seedLockedPlan(projectId);

    const first = await runtime.startRun({ planId: planA });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    handles[0]!.state = 'completed';

    const chained = await runtime.startRun({ planId: planB, parentRunId: first.runId });
    expect(chained.ok).toBe(true);
  });

  it('blocks when parentRunId matches a resident that is still RUNNING', async () => {
    const { runtime } = makeRuntime();
    const projectId = await seedProject();
    const planA = await seedLockedPlan(projectId);
    const planB = await seedLockedPlan(projectId);

    const first = await runtime.startRun({ planId: planA });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await runtime.startRun({ planId: planB, parentRunId: first.runId });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(409);
    expect(second.error).toBe('run_already_active');
  });

  it('race: two concurrent startRun calls for the same project — exactly one wins (launchingProjects window)', async () => {
    // Both calls use DIFFERENT planIds, so the per-plan launchingPlans guard
    // cannot help; only the launchingProjects set closes the window between
    // the guard check and walker registration.
    const { runtime } = makeRuntime();
    const projectId = await seedProject();
    const planA = await seedLockedPlan(projectId);
    const planB = await seedLockedPlan(projectId);

    const [a, b] = await Promise.all([
      runtime.startRun({ planId: planA }),
      runtime.startRun({ planId: planB }),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    const fails = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(fails).toHaveLength(1);
    const loser = fails[0]!;
    if (loser.ok) return;
    expect(loser.status).toBe(409);
    expect(loser.error).toBe('run_already_active');
  });
});
