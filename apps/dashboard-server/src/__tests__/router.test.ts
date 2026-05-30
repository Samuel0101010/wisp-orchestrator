import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { db, sqlite } from '../db/index.js';
import { modelRouterPriors, modelRouterSamples } from '@wisp/schemas';

/**
 * GET /api/router/priors projects the Thompson Beta priors:
 *   mean = alpha / (alpha + beta)
 * and joins a recorded-sample count (samples with a non-null outcome)
 * per (role, model). We seed both tables directly and assert the exact
 * projection. Unique role/model names per case keep counts independent of
 * any rows another test may have inserted.
 */
describe('GET /api/router/priors', () => {
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

  function seedPrior(role: string, model: string, alpha: number, beta: number) {
    db.insert(modelRouterPriors).values({ role, model, alpha, beta, updatedAt: new Date() }).run();
  }

  function seedSample(role: string, model: string, outcome: 'success' | 'failure' | null) {
    db.insert(modelRouterSamples)
      .values({
        id: `${role}::${model}::${Math.random().toString(36).slice(2)}`,
        role,
        model,
        takenAt: new Date(),
        outcome,
        recordedAt: outcome == null ? null : new Date(),
      })
      .run();
  }

  it('computes mean = alpha/(alpha+beta) and counts recorded samples per (role,model)', async () => {
    const role = 'router-test-lead';
    const model = 'router-test-opus';
    const alpha = 7;
    const beta = 3;
    seedPrior(role, model, alpha, beta);
    // 3 recorded samples (counted) + 1 pending (outcome null, NOT counted)
    seedSample(role, model, 'success');
    seedSample(role, model, 'success');
    seedSample(role, model, 'failure');
    seedSample(role, model, null);

    const res = await app.inject({ method: 'GET', url: '/api/router/priors' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Array<{
      role: string;
      model: string;
      alpha: number;
      beta: number;
      mean: number;
      samples: number;
    }>;
    const entry = body.find((r) => r.role === role && r.model === model);
    expect(entry).toBeDefined();
    expect(entry!.alpha).toBe(alpha);
    expect(entry!.beta).toBe(beta);
    expect(entry!.mean).toBeCloseTo(alpha / (alpha + beta), 12);
    expect(entry!.mean).toBe(0.7);
    // Only the 3 samples with a non-null outcome count; the pending one does not.
    expect(entry!.samples).toBe(3);
  });

  it('reports samples=0 for a prior with no recorded samples', async () => {
    const role = 'router-test-reviewer';
    const model = 'router-test-haiku';
    const alpha = 1;
    const beta = 1;
    seedPrior(role, model, alpha, beta);

    const res = await app.inject({ method: 'GET', url: '/api/router/priors' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{
      role: string;
      model: string;
      mean: number;
      samples: number;
    }>;
    const entry = body.find((r) => r.role === role && r.model === model);
    expect(entry).toBeDefined();
    expect(entry!.mean).toBe(0.5);
    expect(entry!.samples).toBe(0);
  });

  it('does not attribute a sample to a different (role,model) prior', async () => {
    const role = 'router-test-iso';
    const modelA = 'router-test-A';
    const modelB = 'router-test-B';
    seedPrior(role, modelA, 2, 2);
    seedPrior(role, modelB, 2, 2);
    // Two recorded samples for modelA only.
    seedSample(role, modelA, 'success');
    seedSample(role, modelA, 'failure');

    const res = await app.inject({ method: 'GET', url: '/api/router/priors' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{
      role: string;
      model: string;
      samples: number;
    }>;
    const a = body.find((r) => r.role === role && r.model === modelA);
    const b = body.find((r) => r.role === role && r.model === modelB);
    expect(a?.samples).toBe(2);
    // The samples for modelA must NOT leak into modelB's count.
    expect(b?.samples).toBe(0);
  });
});
