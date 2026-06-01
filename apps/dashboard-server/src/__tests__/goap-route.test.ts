import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { sqlite } from '../db/index.js';

const exampleActions = [
  { name: 'gather-info', cost: 1, preconditions: {}, effects: { hasInfo: true } },
  {
    name: 'analyze',
    cost: 2,
    preconditions: { hasInfo: true },
    effects: { hasAnalysis: true },
  },
  {
    name: 'write-report',
    cost: 3,
    preconditions: { hasAnalysis: true },
    effects: { hasReport: true },
  },
];

describe('/api/goap/plan', () => {
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

  it('returns the cheapest plan + total cost for a solvable problem', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/goap/plan',
      payload: {
        initial: {},
        goal: { hasReport: true },
        actions: exampleActions,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.plan.map((a: { name: string }) => a.name)).toEqual([
      'gather-info',
      'analyze',
      'write-report',
    ]);
    expect(body.totalCost).toBe(6);
  });

  it('returns plan=null and totalCost=null when no plan exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/goap/plan',
      payload: {
        initial: {},
        goal: { unreachable: true },
        actions: exampleActions,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plan: null, totalCost: null });
  });

  it('returns empty plan when initial state already satisfies goal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/goap/plan',
      payload: {
        initial: { hasReport: true },
        goal: { hasReport: true },
        actions: exampleActions,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plan: [], totalCost: 0 });
  });

  it('accepts an empty actions array and short-circuits the trivially-satisfied case', async () => {
    // Regression: previously the schema rejected `actions: []` with 400,
    // which leaked a useless error to the UI when the user had unchecked
    // every action in the library. Plan should now be `[]` for an already-
    // satisfied goal and `null` otherwise.
    const okRes = await app.inject({
      method: 'POST',
      url: '/api/goap/plan',
      payload: { initial: { hasReport: true }, goal: { hasReport: true }, actions: [] },
    });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json().plan).toEqual([]);

    const noRes = await app.inject({
      method: 'POST',
      url: '/api/goap/plan',
      payload: { initial: {}, goal: { hasReport: true }, actions: [] },
    });
    expect(noRes.statusCode).toBe(200);
    expect(noRes.json()).toEqual({ plan: null, totalCost: null });
  });

  it('rejects malformed body with 400 + zod issues', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/goap/plan',
      payload: { initial: 'not-an-object', goal: {}, actions: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
    expect(Array.isArray(res.json().issues)).toBe(true);
  });

  it('rejects an oversized actions array (>200) with 400', async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      name: `a${i}`,
      cost: 1,
      preconditions: {},
      effects: { [`f${i}`]: true },
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/goap/plan',
      payload: { initial: {}, goal: { f0: true }, actions: many },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
  });

  it('returns 422 search_exhausted instead of hanging on an exponential search', async () => {
    // 16 independent flag-setting actions toward an unreachable goal forces the
    // solver to exhaust 2^16 states; the expansion cap aborts and the route
    // maps the typed error to a clean 422 rather than pinning the event loop.
    const many = Array.from({ length: 16 }, (_, i) => ({
      name: `set-${i}`,
      cost: 1,
      preconditions: {},
      effects: { [`f${i}`]: true },
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/goap/plan',
      payload: { initial: {}, goal: { unreachable: true }, actions: many },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'search_exhausted' });
  }, 15_000);
});
