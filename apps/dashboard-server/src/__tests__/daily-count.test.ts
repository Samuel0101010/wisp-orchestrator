import './setup.js';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { plans, projects, runs } from '@agent-harness/schemas';
import { db, sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createRunsRouter } from '../routes/runs.js';
import type { RunRuntime } from '../orchestrator/runtime.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors);
  await app.register(websocket);
  // Use a no-op runtime stub — daily-count doesn't need walker behavior.
  const stub = {
    startRun: async () => ({ ok: true as const, runId: 'x' }),
    pauseRun: async () => ({ ok: true as const }),
    resumeRun: async () => ({ ok: true as const }),
    cancelRun: async () => ({ ok: true as const }),
  } as unknown as RunRuntime;
  await app.register(createRunsRouter({ runtime: stub }));
  return app;
}

async function seedProjectAndPlan(): Promise<{ projectId: string; planId: string }> {
  const projectId = randomUUID();
  const planId = randomUUID();
  await db
    .insert(projects)
    .values({ id: projectId, name: 'p', goal: 'g', repoPath: '/tmp/r', createdAt: new Date() })
    .run();
  await db
    .insert(plans)
    .values({
      id: planId,
      projectId,
      dagJson: {},
      status: 'locked',
    })
    .run();
  return { projectId, planId };
}

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  sqlite.close();
});

describe('GET /api/runs/daily-count', () => {
  beforeEach(async () => {
    await db.delete(runs).run();
    await db.delete(plans).run();
    await db.delete(projects).run();
  });

  it('returns 0 when no runs exist', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/runs/daily-count' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ totalLast24h: 0, byProject: {} });
    await app.close();
  });

  it('counts runs from the last 24h grouped by project, ignoring older runs', async () => {
    const app = await buildApp();
    const { projectId, planId } = await seedProjectAndPlan();
    const now = Date.now();
    const recent1 = new Date(now - 1 * 60 * 60 * 1000); // 1h ago
    const recent2 = new Date(now - 23 * 60 * 60 * 1000); // 23h ago
    const old = new Date(now - 25 * 60 * 60 * 1000); // 25h ago
    await db
      .insert(runs)
      .values([
        {
          id: randomUUID(),
          planId,
          status: 'running',
          startedAt: recent1,
          budgetMinutes: 60,
          budgetTurns: 100,
          maxParallel: 2,
        },
        {
          id: randomUUID(),
          planId,
          status: 'completed',
          startedAt: recent2,
          budgetMinutes: 60,
          budgetTurns: 100,
          maxParallel: 2,
        },
        {
          id: randomUUID(),
          planId,
          status: 'failed',
          startedAt: old,
          budgetMinutes: 60,
          budgetTurns: 100,
          maxParallel: 2,
        },
      ])
      .run();
    const res = await app.inject({ method: 'GET', url: '/api/runs/daily-count' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ totalLast24h: 2, byProject: { [projectId]: 2 } });
    await app.close();
  });
});
