import './setup.js';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { eq } from 'drizzle-orm';
import { plans, projects, runs as runsTable } from '@agent-harness/schemas';
import { healthRoutes } from '../routes/health.js';
import { projectRoutes } from '../routes/projects.js';
import { createRunsRouter } from '../routes/runs.js';
import { runMigrations } from '../db/migrate.js';
import { db, sqlite } from '../db/index.js';
import type { RunRuntime } from '../orchestrator/runtime.js';

interface FakeRuntime {
  startRun: RunRuntime['startRun'];
  pauseRun: RunRuntime['pauseRun'];
  resumeRun: RunRuntime['resumeRun'];
  cancelRun: RunRuntime['cancelRun'];
  walkers: RunRuntime['walkers'];
  startCalls: number;
  pauseCalls: number;
  resumeCalls: number;
  cancelCalls: number;
}

function makeFakeRuntime(overrides: Partial<RunRuntime> = {}): FakeRuntime {
  let startCalls = 0;
  let pauseCalls = 0;
  let resumeCalls = 0;
  let cancelCalls = 0;

  const stub: FakeRuntime = {
    walkers: new Map(),
    startCalls: 0,
    pauseCalls: 0,
    resumeCalls: 0,
    cancelCalls: 0,
    startRun: async (args) => {
      startCalls += 1;
      stub.startCalls = startCalls;
      // Look up the plan to mimic real behavior (not-found / not-locked).
      const plan = await db.select().from(plans).where(eq(plans.id, args.planId)).get();
      if (!plan) return { ok: false, status: 404, error: 'plan not found' };
      if (plan.status !== 'locked') {
        return {
          ok: false,
          status: 409,
          error: 'plan not locked',
          details: { currentStatus: plan.status },
        };
      }
      const runId = randomUUID();
      const startedAt = new Date();
      // Insert a real runs row so GET /api/runs/:id can read it.
      await db
        .insert(runsTable)
        .values({
          id: runId,
          planId: args.planId,
          status: 'running',
          startedAt,
          budgetMinutes: args.budgetMinutes ?? 120,
          budgetTurns: args.budgetTurns ?? 500,
          maxParallel: args.maxParallel ?? 2,
        })
        .run();
      return { ok: true, runId };
    },
    pauseRun: async (runId) => {
      pauseCalls += 1;
      stub.pauseCalls = pauseCalls;
      const row = await db.select().from(runsTable).where(eq(runsTable.id, runId)).get();
      if (!row) return { ok: false, status: 404, error: 'run not found' };
      await db
        .update(runsTable)
        .set({ status: 'paused', pausedReason: 'user' })
        .where(eq(runsTable.id, runId))
        .run();
      return { ok: true };
    },
    resumeRun: async (runId) => {
      resumeCalls += 1;
      stub.resumeCalls = resumeCalls;
      const row = await db.select().from(runsTable).where(eq(runsTable.id, runId)).get();
      if (!row) return { ok: false, status: 404, error: 'run not found' };
      await db
        .update(runsTable)
        .set({ status: 'running', pausedReason: null })
        .where(eq(runsTable.id, runId))
        .run();
      return { ok: true };
    },
    cancelRun: async (runId) => {
      cancelCalls += 1;
      stub.cancelCalls = cancelCalls;
      const row = await db.select().from(runsTable).where(eq(runsTable.id, runId)).get();
      if (!row) return { ok: false, status: 404, error: 'run not found' };
      await db
        .update(runsTable)
        .set({ status: 'cancelled', outcome: 'cancelled', endedAt: new Date() })
        .where(eq(runsTable.id, runId))
        .run();
      return { ok: true };
    },
    ...overrides,
  };
  return stub;
}

async function buildAppWithRuntime(runtime: FakeRuntime): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors);
  await app.register(websocket);
  await app.register(healthRoutes);
  await app.register(projectRoutes);
  await app.register(createRunsRouter({ runtime: runtime as unknown as RunRuntime }));
  return app;
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
      architect: { role: 'architect', model: 'opus', allowedTools: [], systemPrompt: 'a' },
      developer: { role: 'developer', model: 'sonnet', allowedTools: [], systemPrompt: 'd' },
      qa: { role: 'qa', model: 'sonnet', allowedTools: [], systemPrompt: 'q' },
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

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  sqlite.close();
});

describe('run routes', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('POST /api/runs returns 201 with runId for a locked plan', async () => {
    const runtime = makeFakeRuntime();
    app = await buildAppWithRuntime(runtime);
    const { planId } = await seedLockedPlan();
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { planId },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.runId).toBe('string');
    expect(runtime.startCalls).toBe(1);
  });

  it('POST /api/runs returns 404 for unknown plan', async () => {
    const runtime = makeFakeRuntime();
    app = await buildAppWithRuntime(runtime);
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { planId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('plan not found');
  });

  it('POST /api/runs returns 409 when plan not locked', async () => {
    const runtime = makeFakeRuntime();
    app = await buildAppWithRuntime(runtime);
    // Insert a draft plan.
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
    await db
      .insert(plans)
      .values({ id: planId, projectId, dagJson: {} as unknown, status: 'draft' })
      .run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { planId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('plan not locked');
  });

  it('GET /api/runs/:id returns run + tasks + lastCheckpoint', async () => {
    const runtime = makeFakeRuntime();
    app = await buildAppWithRuntime(runtime);
    const { planId } = await seedLockedPlan();
    const start = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { planId },
    });
    const { runId } = start.json();
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run.id).toBe(runId);
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.lastCheckpoint).toBeNull();
  });

  it('GET /api/runs/:id returns 404 for unknown run', async () => {
    const runtime = makeFakeRuntime();
    app = await buildAppWithRuntime(runtime);
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });

  it('pause / resume / cancel round-trip', async () => {
    const runtime = makeFakeRuntime();
    app = await buildAppWithRuntime(runtime);
    const { planId } = await seedLockedPlan();
    const start = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { planId },
    });
    const { runId } = start.json();

    const pauseRes = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/pause`,
    });
    expect(pauseRes.statusCode).toBe(200);
    expect(pauseRes.json().status).toBe('paused');
    expect(runtime.pauseCalls).toBe(1);

    const resumeRes = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/resume`,
    });
    expect(resumeRes.statusCode).toBe(200);
    expect(resumeRes.json().status).toBe('running');
    expect(runtime.resumeCalls).toBe(1);

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/cancel`,
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json().status).toBe('cancelled');
    expect(runtime.cancelCalls).toBe(1);
  });

  it('pause/resume/cancel return 404 for unknown run', async () => {
    const runtime = makeFakeRuntime();
    app = await buildAppWithRuntime(runtime);
    const fake = '00000000-0000-0000-0000-000000000000';
    expect((await app.inject({ method: 'POST', url: `/api/runs/${fake}/pause` })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: 'POST', url: `/api/runs/${fake}/resume` })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: 'POST', url: `/api/runs/${fake}/cancel` })).statusCode).toBe(
      404,
    );
  });

  it('GET /api/projects/:id/runs returns runs ordered desc by startedAt', async () => {
    const runtime = makeFakeRuntime();
    app = await buildAppWithRuntime(runtime);
    const { planId, projectId } = await seedLockedPlan();

    // Start two runs ~10ms apart so startedAt differs.
    const r1 = await app.inject({ method: 'POST', url: '/api/runs', payload: { planId } });
    const id1 = r1.json().runId;
    await new Promise((r) => setTimeout(r, 15));
    const r2 = await app.inject({ method: 'POST', url: '/api/runs', payload: { planId } });
    const id2 = r2.json().runId;

    const list = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/runs` });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    // Most recent first.
    expect(body[0].id).toBe(id2);
    expect(body[1].id).toBe(id1);
    expect(body[0].status).toBe('running');
    expect(body[0]).toHaveProperty('outcome');
    expect(body[0]).toHaveProperty('pausedReason');
    expect(body[0]).toHaveProperty('resumeAt');
  });

  it('GET /api/projects/:id/runs returns 404 for unknown project', async () => {
    const runtime = makeFakeRuntime();
    app = await buildAppWithRuntime(runtime);
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/00000000-0000-0000-0000-000000000000/runs',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/runs returns the last 50 runs', async () => {
    const runtime = makeFakeRuntime();
    app = await buildAppWithRuntime(runtime);
    const { planId } = await seedLockedPlan();
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/api/runs', payload: { planId } });
    }
    const res = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs.length).toBeGreaterThanOrEqual(3);
  });

  it('GET /api/runs?resumable=true returns only resumable runs', async () => {
    const runtime = makeFakeRuntime();
    app = await buildAppWithRuntime(runtime);
    const { planId } = await seedLockedPlan();

    const orphanId = randomUUID();
    await db
      .insert(runsTable)
      .values({
        id: orphanId,
        planId,
        status: 'running',
        startedAt: new Date(),
        budgetMinutes: 60,
        budgetTurns: 100,
        maxParallel: 2,
      })
      .run();
    const shutdownId = randomUUID();
    await db
      .insert(runsTable)
      .values({
        id: shutdownId,
        planId,
        status: 'paused',
        pausedReason: 'shutdown',
        startedAt: new Date(),
        budgetMinutes: 60,
        budgetTurns: 100,
        maxParallel: 2,
      })
      .run();
    const completedId = randomUUID();
    await db
      .insert(runsTable)
      .values({
        id: completedId,
        planId,
        status: 'completed',
        outcome: 'success',
        startedAt: new Date(),
        endedAt: new Date(),
        budgetMinutes: 60,
        budgetTurns: 100,
        maxParallel: 2,
      })
      .run();

    const res = await app.inject({ method: 'GET', url: '/api/runs?resumable=true' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids: string[] = body.runs.map((r: { runId: string }) => r.runId);
    expect(ids).toContain(orphanId);
    expect(ids).toContain(shutdownId);
    expect(ids).not.toContain(completedId);

    const orphanRow = body.runs.find((r: { runId: string }) => r.runId === orphanId);
    expect(orphanRow.hadAbruptCrash).toBe(true);
    const shutdownRow = body.runs.find((r: { runId: string }) => r.runId === shutdownId);
    expect(shutdownRow.hadAbruptCrash).toBe(false);
    expect(shutdownRow.pausedReason).toBe('shutdown');
  });

  it('POST /api/runs/:id/resume rebuilds walker when not in memory', async () => {
    let buildCount = 0;
    const runtime = makeFakeRuntime({
      resumeRun: async (runId: string) => {
        buildCount += 1;
        const row = await db.select().from(runsTable).where(eq(runsTable.id, runId)).get();
        if (!row) return { ok: false, status: 404 as const, error: 'run not found' };
        if (row.status !== 'paused') {
          return { ok: false, status: 409 as const, error: 'run not paused' };
        }
        await db
          .update(runsTable)
          .set({ status: 'running', pausedReason: null, resumeAt: null })
          .where(eq(runsTable.id, runId))
          .run();
        return { ok: true, rebuilt: true };
      },
    });
    app = await buildAppWithRuntime(runtime);
    const { planId } = await seedLockedPlan();

    const pausedId = randomUUID();
    await db
      .insert(runsTable)
      .values({
        id: pausedId,
        planId,
        status: 'paused',
        pausedReason: 'shutdown',
        startedAt: new Date(),
        budgetMinutes: 60,
        budgetTurns: 100,
        maxParallel: 2,
      })
      .run();

    const res = await app.inject({ method: 'POST', url: `/api/runs/${pausedId}/resume` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('running');
    expect(res.json().rebuilt).toBe(true);
    expect(buildCount).toBe(1);
  });

  it('replay-checkpoint returns 404 with no checkpoint', async () => {
    const runtime = makeFakeRuntime();
    app = await buildAppWithRuntime(runtime);
    const { planId } = await seedLockedPlan();
    const start = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { planId },
    });
    const { runId } = start.json();
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/replay-checkpoint`,
    });
    expect(res.statusCode).toBe(404);
  });
});
