import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { plans, projects } from '@agent-harness/schemas';
import { buildApp } from '../app.js';
import { db, sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';

describe('GET /api/plans/:planId/chain', () => {
  let app: FastifyInstance;
  let projectId: string;

  beforeAll(async () => {
    runMigrations();
    app = await buildApp();
    await app.ready();
    projectId = randomUUID();
    await db
      .insert(projects)
      .values({
        id: projectId,
        name: 'chain-proj',
        goal: 'g',
        repoPath: '/tmp',
      })
      .run();
  });

  afterAll(async () => {
    await app.close();
    sqlite.close();
  });

  it('returns 404 when planId does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/plans/00000000-0000-0000-0000-000000000000/chain',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns single-entry chain for a root plan (parentPlanId=null)', async () => {
    const planId = randomUUID();
    const dag = { goal: 'g', team: { roles: [] }, nodes: [], edges: [] };
    await db
      .insert(plans)
      .values({
        id: planId,
        projectId,
        dagJson: dag as unknown,
        status: 'locked',
        parentPlanId: null,
      })
      .run();
    const res = await app.inject({
      method: 'GET',
      url: `/api/plans/${planId}/chain`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { chain: Array<{ id: string; parentPlanId: string | null }> };
    expect(body.chain).toHaveLength(1);
    expect(body.chain[0]!.id).toBe(planId);
    expect(body.chain[0]!.parentPlanId).toBeNull();
  });

  it('returns ordered chain for a 2-link replan: child → root', async () => {
    const rootId = randomUUID();
    const childId = randomUUID();
    const dag = { goal: 'g', team: { roles: [] }, nodes: [], edges: [] };
    await db
      .insert(plans)
      .values({
        id: rootId,
        projectId,
        dagJson: dag as unknown,
        status: 'failed',
        parentPlanId: null,
      })
      .run();
    await db
      .insert(plans)
      .values({
        id: childId,
        projectId,
        dagJson: dag as unknown,
        status: 'locked',
        parentPlanId: rootId,
      })
      .run();
    const res = await app.inject({
      method: 'GET',
      url: `/api/plans/${childId}/chain`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { chain: Array<{ id: string; parentPlanId: string | null }> };
    expect(body.chain).toHaveLength(2);
    expect(body.chain[0]!.id).toBe(childId);
    expect(body.chain[0]!.parentPlanId).toBe(rootId);
    expect(body.chain[1]!.id).toBe(rootId);
    expect(body.chain[1]!.parentPlanId).toBeNull();
  });
});
