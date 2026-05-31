import './setup.js';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { plans, projects, runs } from '@wisp/schemas';
import { db, sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createRunsRouter } from '../routes/runs.js';
import type { RunRuntime } from '../orchestrator/runtime.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors);
  await app.register(websocket);
  const stub = {
    startRun: async () => ({ ok: true as const, runId: 'x' }),
    pauseRun: async () => ({ ok: true as const }),
    resumeRun: async () => ({ ok: true as const }),
    cancelRun: async () => ({ ok: true as const }),
  } as unknown as RunRuntime;
  await app.register(createRunsRouter({ runtime: stub }));
  return app;
}

async function seed(): Promise<void> {
  const projectId = randomUUID();
  const planId = randomUUID();
  await db
    .insert(projects)
    .values({ id: projectId, name: 'p', goal: 'g', repoPath: '/tmp/r', createdAt: new Date() })
    .run();
  await db.insert(plans).values({ id: planId, projectId, dagJson: {}, status: 'locked' }).run();
  const base = { planId, budgetMinutes: 60, budgetTurns: 100, maxParallel: 2 };
  await db
    .insert(runs)
    .values([
      { id: randomUUID(), status: 'running', startedAt: new Date(), ...base },
      { id: randomUUID(), status: 'paused', startedAt: new Date(), ...base },
      { id: randomUUID(), status: 'completed', startedAt: new Date(), ...base },
    ])
    .run();
}

beforeAll(() => {
  runMigrations();
});
afterAll(() => {
  sqlite.close();
});

describe('GET /api/runs ?status= filter', () => {
  beforeEach(async () => {
    await db.delete(runs).run();
    await db.delete(plans).run();
    await db.delete(projects).run();
    await seed();
  });

  it('returns only running runs when status=running', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/runs?status=running' });
    expect(res.statusCode).toBe(200);
    const { runs: rows } = res.json() as { runs: Array<{ status: string }> };
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('running');
    await app.close();
  });

  it('returns only paused runs when status=paused (does not leak other states)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/runs?status=paused' });
    expect(res.statusCode).toBe(200);
    const { runs: rows } = res.json() as { runs: Array<{ status: string }> };
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('paused');
    await app.close();
  });

  it('returns all runs when no status filter is given', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(res.statusCode).toBe(200);
    const { runs: rows } = res.json() as { runs: unknown[] };
    expect(rows).toHaveLength(3);
    await app.close();
  });

  it('applies the status filter on the include=project branch too', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs?include=project&status=completed',
    });
    expect(res.statusCode).toBe(200);
    const { runs: rows } = res.json() as { runs: Array<{ status: string }> };
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('completed');
    await app.close();
  });
});
