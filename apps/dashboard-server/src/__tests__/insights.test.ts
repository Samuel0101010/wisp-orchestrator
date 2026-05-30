import './setup.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { db, sqlite } from '../db/index.js';
import {
  trajectories,
  runSummaries,
  modelRouterPriors,
  modelRouterSamples,
  projects,
  plans,
  runs,
} from '@wisp/schemas';

type SeedOpts = {
  id?: string;
  projectId?: string | null;
  prompt?: string;
  planJson?: string;
  outcome?: string;
  termsJson?: string;
  lessons?: string | null;
  tokensTotal?: number;
  createdAt?: Date;
};

function seedTrajectory(opts: SeedOpts = {}): { id: string } {
  const id = opts.id ?? randomUUID();
  db.insert(trajectories)
    .values({
      id,
      projectId: opts.projectId ?? null,
      prompt: opts.prompt ?? 'build a login page',
      planJson: opts.planJson ?? JSON.stringify({ tasks: [{ id: 't1' }] }),
      outcome: opts.outcome ?? 'success',
      termsJson: opts.termsJson ?? JSON.stringify(['login', 'auth']),
      lessons: opts.lessons ?? 'prefer typed wrappers',
      tokensTotal: opts.tokensTotal ?? 1234,
      createdAt: opts.createdAt ?? new Date(),
    })
    .run();
  return { id };
}

describe('insights routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    runMigrations();
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    sqlite.close();
  });

  beforeEach(() => {
    // Order matters: child tables / FK referencers first.
    sqlite.prepare('DELETE FROM trajectories').run();
    sqlite.prepare('DELETE FROM run_summaries').run();
    sqlite.prepare('DELETE FROM model_router_samples').run();
    sqlite.prepare('DELETE FROM model_router_priors').run();
    sqlite.prepare('DELETE FROM runs').run();
    sqlite.prepare('DELETE FROM plans').run();
    sqlite.prepare('DELETE FROM projects').run();
  });

  describe('GET /api/insights/trajectories', () => {
    it('returns the seeded list with the projected fields, newest first', async () => {
      const older = seedTrajectory({
        prompt: 'older prompt',
        tokensTotal: 10,
        outcome: 'failure',
        lessons: 'lesson-a',
        createdAt: new Date(Date.now() - 60_000),
      });
      const newer = seedTrajectory({
        prompt: 'newer prompt',
        tokensTotal: 20,
        outcome: 'success',
        lessons: 'lesson-b',
        createdAt: new Date(),
      });

      const res = await app.inject({ method: 'GET', url: '/api/insights/trajectories' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<Record<string, unknown>>;
      expect(body).toHaveLength(2);
      // desc(createdAt): newer first
      expect(body[0].id).toBe(newer.id);
      expect(body[1].id).toBe(older.id);
      // projected shape — only the whitelisted fields, no planJson / termsJson
      expect(body[0]).toEqual({
        id: newer.id,
        projectId: null,
        prompt: 'newer prompt',
        outcome: 'success',
        lessons: 'lesson-b',
        tokensTotal: 20,
        // timestamp_ms Date is JSON-serialized to an ISO string over the wire
        createdAt: expect.any(String),
      });
      expect(body[0]).not.toHaveProperty('planJson');
      expect(body[0]).not.toHaveProperty('termsJson');
    });

    it('filters by projectId when the query param is provided', async () => {
      const projectId = randomUUID();
      db.insert(projects)
        .values({ id: projectId, name: 'p', goal: 'g', repoPath: '/tmp/r', createdAt: new Date() })
        .run();
      const mine = seedTrajectory({ projectId, prompt: 'mine' });
      seedTrajectory({ projectId: null, prompt: 'unscoped' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/insights/trajectories?projectId=${projectId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ id: string; projectId: string | null }>;
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe(mine.id);
      expect(body[0].projectId).toBe(projectId);
    });

    it('returns an empty array when no trajectories exist', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/insights/trajectories' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });
  });

  describe('GET /api/insights/trajectories/:id', () => {
    it('returns one full row with parsed planJson', async () => {
      const { id } = seedTrajectory({
        planJson: JSON.stringify({ tasks: [{ id: 'a' }, { id: 'b' }] }),
      });
      const res = await app.inject({ method: 'GET', url: `/api/insights/trajectories/${id}` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { id: string; planJson: { tasks: Array<{ id: string }> } };
      expect(body.id).toBe(id);
      // planJson is parsed from the stored string into an object
      expect(body.planJson).toEqual({ tasks: [{ id: 'a' }, { id: 'b' }] });
    });

    it('returns 404 + { error: not_found } for an unknown id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/insights/trajectories/${randomUUID()}`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    });

    it('does not 500 on corrupt planJson — falls back to planJson: null', async () => {
      const { id } = seedTrajectory({ planJson: '{not valid json' });
      const res = await app.inject({ method: 'GET', url: `/api/insights/trajectories/${id}` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { id: string; planJson: unknown };
      expect(body.id).toBe(id);
      expect(body.planJson).toBeNull();
    });
  });

  describe('DELETE /api/insights/trajectories/:id', () => {
    it('removes the row (204) and a subsequent GET reflects the deletion', async () => {
      const { id } = seedTrajectory();

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/insights/trajectories/${id}`,
      });
      expect(del.statusCode).toBe(204);

      // detail GET now 404s
      const after = await app.inject({
        method: 'GET',
        url: `/api/insights/trajectories/${id}`,
      });
      expect(after.statusCode).toBe(404);

      // and the list no longer contains it
      const list = await app.inject({ method: 'GET', url: '/api/insights/trajectories' });
      expect((list.json() as Array<{ id: string }>).find((r) => r.id === id)).toBeUndefined();
    });

    it('is a no-op (still 204) when deleting a non-existent id', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/insights/trajectories/${randomUUID()}`,
      });
      expect(res.statusCode).toBe(204);
    });
  });

  describe('GET /api/insights/run-summaries', () => {
    function seedRunSummary(projectId: string, summaryMd: string, createdAt: Date): string {
      const planId = randomUUID();
      const runId = randomUUID();
      db.insert(plans)
        .values({ id: planId, projectId, dagJson: { tasks: [], edges: [] }, status: 'locked' })
        .run();
      db.insert(runs)
        .values({
          id: runId,
          planId,
          status: 'completed',
          outcome: 'success',
          budgetMinutes: 60,
          budgetTurns: 100,
          maxParallel: 1,
          tokensInTotal: 0,
          tokensOutTotal: 0,
          turnsTotal: 0,
        })
        .run();
      db.insert(runSummaries)
        .values({ runId, projectId, summaryMd, mode: null, tokensTotal: 0, createdAt })
        .run();
      return runId;
    }

    it('returns the seeded summaries newest-first and filters by projectId', async () => {
      const projectId = randomUUID();
      const otherProjectId = randomUUID();
      db.insert(projects)
        .values([
          { id: projectId, name: 'p', goal: 'g', repoPath: '/tmp/r', createdAt: new Date() },
          { id: otherProjectId, name: 'o', goal: 'g', repoPath: '/tmp/o', createdAt: new Date() },
        ])
        .run();

      const oldRun = seedRunSummary(projectId, 'old', new Date(Date.now() - 60_000));
      const newRun = seedRunSummary(projectId, 'new', new Date());
      seedRunSummary(otherProjectId, 'other', new Date());

      const all = await app.inject({ method: 'GET', url: '/api/insights/run-summaries' });
      expect(all.statusCode).toBe(200);
      expect(all.json() as unknown[]).toHaveLength(3);

      const scoped = await app.inject({
        method: 'GET',
        url: `/api/insights/run-summaries?projectId=${projectId}`,
      });
      expect(scoped.statusCode).toBe(200);
      const body = scoped.json() as Array<{ runId: string; summaryMd: string }>;
      expect(body).toHaveLength(2);
      expect(body.map((r) => r.runId)).toEqual([newRun, oldRun]); // desc(createdAt)
      expect(body[0].summaryMd).toBe('new');
    });
  });

  describe('GET /api/insights/router-priors', () => {
    it('returns priors with derived mean + recorded-sample counts', async () => {
      const now = new Date();
      db.insert(modelRouterPriors)
        .values([
          { role: 'planner-orchestration', model: 'opus', alpha: 3, beta: 1, updatedAt: now },
          { role: 'planner-substantive', model: 'sonnet', alpha: 1, beta: 1, updatedAt: now },
          { role: 'planner', model: 'haiku', alpha: 2, beta: 2, updatedAt: now },
        ])
        .run();

      // 2 recorded samples for planner-orchestration::opus, 1 pending (outcome=null, not counted)
      db.insert(modelRouterSamples)
        .values([
          {
            id: randomUUID(),
            role: 'planner-orchestration',
            model: 'opus',
            takenAt: now,
            outcome: 'success',
            recordedAt: now,
          },
          {
            id: randomUUID(),
            role: 'planner-orchestration',
            model: 'opus',
            takenAt: now,
            outcome: 'failure',
            recordedAt: now,
          },
          {
            id: randomUUID(),
            role: 'planner-orchestration',
            model: 'opus',
            takenAt: now,
            outcome: null,
            recordedAt: null,
          },
        ])
        .run();

      const res = await app.inject({ method: 'GET', url: '/api/insights/router-priors' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{
        role: string;
        baseRole: string;
        phase: string;
        model: string;
        mean: number;
        samples: number;
      }>;
      expect(body).toHaveLength(3);

      const orch = body.find((r) => r.role === 'planner-orchestration');
      expect(orch).toMatchObject({
        baseRole: 'planner',
        phase: 'orchestration',
        model: 'opus',
        samples: 2, // pending (null outcome) sample excluded
      });
      expect(orch?.mean).toBeCloseTo(3 / (3 + 1)); // alpha / (alpha + beta)

      const sub = body.find((r) => r.role === 'planner-substantive');
      expect(sub).toMatchObject({ baseRole: 'planner', phase: 'substantive', samples: 0 });

      const unspec = body.find((r) => r.role === 'planner');
      expect(unspec).toMatchObject({ baseRole: 'planner', phase: 'unspecified', samples: 0 });
    });

    it('returns an empty array when no priors exist', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/insights/router-priors' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });
  });
});
