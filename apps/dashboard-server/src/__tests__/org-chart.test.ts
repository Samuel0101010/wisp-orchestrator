import './setup.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { plans, runs, tasks, teams } from '@agent-harness/schemas';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { db, sqlite } from '../db/index.js';

const FILLER = 'x'.repeat(80);

function defaultTeam(): {
  roles: Array<{ role: string; model: string; allowedTools: string[]; systemPrompt: string }>;
} {
  return {
    roles: [
      { role: 'architect', model: 'opus', allowedTools: ['Read'], systemPrompt: `arch ${FILLER}` },
      {
        role: 'developer',
        model: 'sonnet',
        allowedTools: ['Read', 'Edit'],
        systemPrompt: `dev ${FILLER}`,
      },
      { role: 'qa', model: 'sonnet', allowedTools: ['Read'], systemPrompt: `qa ${FILLER}` },
    ],
  };
}

async function createProject(app: FastifyInstance, name = 'oc-test'): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name, goal: 'goal here', repoPath: '/tmp/oc' },
  });
  return r.json().id;
}

async function putTeam(app: FastifyInstance, projectId: string, payload: unknown): Promise<void> {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/projects/${projectId}/team`,
    payload,
  });
  if (res.statusCode !== 200) {
    throw new Error(`team PUT failed: ${res.statusCode} ${res.body}`);
  }
}

function buildDagWith(): unknown {
  return {
    goal: 'Build a thing',
    team: defaultTeam(),
    nodes: [
      {
        id: 'a',
        role: 'architect',
        prompt: 'design',
        deps: [],
        successCriteria: { build: 'pnpm build' },
        maxTurns: 10,
      },
      {
        id: 'b',
        role: 'developer',
        prompt: 'implement-1',
        deps: ['a'],
        successCriteria: { test: 'pnpm test' },
        maxTurns: 30,
      },
      {
        id: 'b2',
        role: 'developer',
        prompt: 'implement-2',
        deps: ['a'],
        successCriteria: { test: 'pnpm test' },
        maxTurns: 30,
      },
      {
        id: 'c',
        role: 'qa',
        prompt: 'validate',
        deps: ['b'],
        successCriteria: { lint: 'pnpm lint' },
        maxTurns: 10,
      },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'b2' },
      { from: 'b', to: 'c' },
      { from: 'b2', to: 'c' },
    ],
  };
}

describe('GET /api/projects/:projectId/org-chart', () => {
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

  it('returns 404 for unknown project', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/projects/00000000-0000-0000-0000-000000000000/org-chart',
    });
    expect(r.statusCode).toBe(404);
  });

  it('returns empty roles when project has no team yet', async () => {
    const projectId = await createProject(app, 'oc-empty');
    const r = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/org-chart`,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      roles: unknown[];
      edges: unknown[];
      liveStatus: unknown[];
      latestPlanId: string | null;
      latestRunId: string | null;
    };
    expect(body.roles).toEqual([]);
    expect(body.edges).toEqual([]);
    expect(body.liveStatus).toEqual([]);
    expect(body.latestPlanId).toBeNull();
    expect(body.latestRunId).toBeNull();
  });

  it('returns roles + plan-derived edges deduped at role granularity', async () => {
    const projectId = await createProject(app, 'oc-edges');
    await putTeam(app, projectId, defaultTeam());

    // Insert a plan with two developer nodes both depending on architect, both
    // feeding qa. At role-granularity we expect exactly: architect→developer
    // and developer→qa.
    const planId = randomUUID();
    await db
      .insert(plans)
      .values({
        id: planId,
        projectId,
        dagJson: buildDagWith() as unknown,
        status: 'draft',
        kind: 'initial',
      })
      .run();

    const r = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/org-chart`,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      roles: Array<{ role: string; model: string }>;
      edges: Array<{ from: string; to: string; kind: string }>;
      latestPlanId: string | null;
    };
    expect(body.roles.map((r) => r.role)).toEqual(['architect', 'developer', 'qa']);
    expect(body.latestPlanId).toBe(planId);

    // Dedup: 4 node-level edges collapse to 2 role-level edges.
    expect(body.edges).toHaveLength(2);
    const pairs = body.edges.map((e) => `${e.from}->${e.to}`).sort();
    expect(pairs).toEqual(['architect->developer', 'developer->qa']);
    expect(body.edges.every((e) => e.kind === 'plan-dep')).toBe(true);
  });

  it('aggregates live status across role tasks (done + running → working)', async () => {
    const projectId = await createProject(app, 'oc-live');
    await putTeam(app, projectId, defaultTeam());

    const planId = randomUUID();
    await db
      .insert(plans)
      .values({
        id: planId,
        projectId,
        dagJson: buildDagWith() as unknown,
        status: 'locked',
        kind: 'initial',
      })
      .run();

    const runId = randomUUID();
    await db
      .insert(runs)
      .values({
        id: runId,
        planId,
        startedAt: new Date(),
        status: 'running',
        budgetMinutes: 30,
        budgetTurns: 100,
        maxParallel: 2,
      })
      .run();

    // architect: 1 task done
    await db
      .insert(tasks)
      .values({
        id: 'a',
        planId,
        role: 'architect',
        title: 'design',
        deps: [],
        status: 'done',
      })
      .run();
    // developer: 1 task running, 1 task done → role status should be 'working'
    await db
      .insert(tasks)
      .values({
        id: 'b',
        planId,
        role: 'developer',
        title: 'implement-1',
        deps: ['a'],
        status: 'running',
      })
      .run();
    await db
      .insert(tasks)
      .values({
        id: 'b2',
        planId,
        role: 'developer',
        title: 'implement-2',
        deps: ['a'],
        status: 'done',
      })
      .run();
    // qa: pending → 'idle'
    await db
      .insert(tasks)
      .values({
        id: 'c',
        planId,
        role: 'qa',
        title: 'validate',
        deps: ['b'],
        status: 'pending',
      })
      .run();

    const r = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/org-chart`,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      liveStatus: Array<{ role: string; status: string }>;
      latestRunId: string | null;
    };
    expect(body.latestRunId).toBe(runId);
    const byRole = Object.fromEntries(body.liveStatus.map((s) => [s.role, s.status]));
    expect(byRole.architect).toBe('done');
    expect(byRole.developer).toBe('working');
    expect(byRole.qa).toBe('idle');
  });

  it('surfaces failed status when any task for the role is failed', async () => {
    const projectId = await createProject(app, 'oc-failed');
    await putTeam(app, projectId, defaultTeam());

    const planId = randomUUID();
    await db
      .insert(plans)
      .values({
        id: planId,
        projectId,
        dagJson: buildDagWith() as unknown,
        status: 'locked',
        kind: 'initial',
      })
      .run();
    const runId = randomUUID();
    await db
      .insert(runs)
      .values({
        id: runId,
        planId,
        startedAt: new Date(),
        status: 'running',
        budgetMinutes: 30,
        budgetTurns: 100,
        maxParallel: 2,
      })
      .run();
    // developer: one done + one failed → 'failed' wins
    await db
      .insert(tasks)
      .values({
        id: 'b',
        planId,
        role: 'developer',
        title: 't1',
        deps: [],
        status: 'done',
      })
      .run();
    await db
      .insert(tasks)
      .values({
        id: 'b2',
        planId,
        role: 'developer',
        title: 't2',
        deps: [],
        status: 'failed',
      })
      .run();

    const r = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/org-chart`,
    });
    const body = r.json() as { liveStatus: Array<{ role: string; status: string }> };
    const byRole = Object.fromEntries(body.liveStatus.map((s) => [s.role, s.status]));
    expect(byRole.developer).toBe('failed');
  });

  it('uses the most-recent plan when multiple plans exist', async () => {
    const projectId = await createProject(app, 'oc-latest');
    await putTeam(app, projectId, defaultTeam());

    const oldPlanId = randomUUID();
    await db
      .insert(plans)
      .values({
        id: oldPlanId,
        projectId,
        // Plan with only architect→qa edge (different shape)
        dagJson: {
          goal: 'old',
          team: defaultTeam(),
          nodes: [
            {
              id: 'a',
              role: 'architect',
              prompt: 'x',
              deps: [],
              successCriteria: {},
              maxTurns: 5,
            },
            {
              id: 'z',
              role: 'qa',
              prompt: 'x',
              deps: ['a'],
              successCriteria: {},
              maxTurns: 5,
            },
          ],
          edges: [{ from: 'a', to: 'z' }],
        } as unknown,
        status: 'locked',
        kind: 'initial',
      })
      .run();
    const newPlanId = randomUUID();
    await db
      .insert(plans)
      .values({
        id: newPlanId,
        projectId,
        dagJson: buildDagWith() as unknown,
        status: 'draft',
        kind: 'iteration',
      })
      .run();

    const r = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/org-chart`,
    });
    const body = r.json() as {
      latestPlanId: string | null;
      edges: Array<{ from: string; to: string }>;
    };
    expect(body.latestPlanId).toBe(newPlanId);
    // newPlanId's edges include developer→qa
    const pairs = body.edges.map((e) => `${e.from}->${e.to}`);
    expect(pairs).toContain('developer->qa');
  });

  // touch teams import so it stays used
  void teams;
});
