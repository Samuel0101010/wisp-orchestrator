import './setup.js';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { plans, projects, runs, tasks } from '@agent-harness/schemas';
import { db, sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { setLastAuthProbe } from '../auth-status.js';
import { RunRuntime } from '../orchestrator/runtime.js';
import { createRunsRouter } from '../routes/runs.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors);
  await app.register(websocket);
  const runtime = new RunRuntime({ db, ws: { publishToRun: () => {} } });
  await app.register(createRunsRouter({ runtime }));
  return app;
}

async function seedLockedPlan(): Promise<{ planId: string; projectId: string }> {
  const projectId = randomUUID();
  const planId = randomUUID();
  await db
    .insert(projects)
    .values({ id: projectId, name: 'p', goal: 'g', repoPath: '/tmp/r', createdAt: new Date() })
    .run();
  const validPlan = {
    goal: 'g',
    team: {
      roles: [
        { role: 'architect', model: 'opus', allowedTools: [], systemPrompt: 'a'.repeat(60) },
        { role: 'developer', model: 'sonnet', allowedTools: [], systemPrompt: 'b'.repeat(60) },
        { role: 'qa', model: 'sonnet', allowedTools: [], systemPrompt: 'c'.repeat(60) },
      ],
    },
    nodes: [
      { id: 'a', role: 'architect', prompt: 'p', deps: [], successCriteria: {}, maxTurns: 5 },
    ],
    edges: [],
  };
  await db
    .insert(plans)
    .values({
      id: planId,
      projectId,
      dagJson: validPlan as unknown,
      status: 'locked',
    })
    .run();
  return { planId, projectId };
}

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  sqlite.close();
});

describe('POST /api/runs — auth probe gate', () => {
  beforeEach(async () => {
    await db.delete(tasks).run();
    await db.delete(runs).run();
    await db.delete(plans).run();
    await db.delete(projects).run();
  });
  afterEach(() => {
    setLastAuthProbe(null);
  });

  it('returns 503 when auth probe last failed and mode=subscription', async () => {
    if (process.env.HARNESS_MOCK_CLI === '1') {
      // Gate is bypassed in mock-cli mode; skip.
      return;
    }
    setLastAuthProbe({ ok: false, error: 'invalid', hint: 'run claude login' });
    const app = await buildApp();
    try {
      const { planId } = await seedLockedPlan();
      const res = await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { planId },
      });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body).toMatchObject({
        error: 'auth-failed',
        details: { hint: 'run claude login' },
      });
    } finally {
      await app.close();
    }
  });

  it('proceeds normally when auth probe is ok (delegates to startRun)', async () => {
    setLastAuthProbe({ ok: true, durationMs: 100 });
    let startCalled = false;
    const stubRuntime = {
      startRun: async () => {
        startCalled = true;
        return { ok: true as const, runId: 'r1' };
      },
      pauseRun: async () => ({ ok: true as const }),
      resumeRun: async () => ({ ok: true as const }),
      cancelRun: async () => ({ ok: true as const }),
    } as unknown as RunRuntime;
    const app = Fastify({ logger: false });
    await app.register(cors);
    await app.register(websocket);
    await app.register(createRunsRouter({ runtime: stubRuntime }));
    try {
      const { planId } = await seedLockedPlan();
      const res = await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { planId },
      });
      expect(startCalled).toBe(true);
      expect(res.statusCode).toBeLessThan(400);
    } finally {
      await app.close();
    }
  });
});
