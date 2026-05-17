import './setup.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { eq } from 'drizzle-orm';
import { plans, type HarnessEvent } from '@wisp/schemas';
import type { RunClaudeOpts } from '@wisp/orchestrator';
import { healthRoutes } from '../routes/health.js';
import { projectRoutes } from '../routes/projects.js';
import { runRoutes } from '../routes/runs.js';
import { createPlansRouter } from '../routes/plans.js';
import { runMigrations } from '../db/migrate.js';
import { db, sqlite } from '../db/index.js';

interface FakeRunnerScript {
  events: HarnessEvent[];
  /** Optional plan.json content to write into opts.cwd before completion. */
  writePlan?: () => unknown;
}

function makeRunner(scripts: FakeRunnerScript[]): {
  runner: (opts: RunClaudeOpts) => AsyncIterable<HarnessEvent>;
  callCount: () => number;
} {
  let i = 0;
  const calls: number[] = [];
  const runner = (opts: RunClaudeOpts): AsyncIterable<HarnessEvent> => {
    const idx = i++;
    calls.push(idx);
    const script = scripts[idx];
    if (!script) {
      // Default: generic failure if we run out of scripts.
      return (async function* () {
        yield {
          type: 'task.failed',
          payload: { taskId: opts.taskId, error: 'no script for this attempt' },
        };
      })();
    }
    return (async function* () {
      for (const ev of script.events) {
        yield ev;
      }
      if (script.writePlan) {
        const planJson = JSON.stringify(script.writePlan(), null, 2);
        fs.writeFileSync(path.join(opts.cwd, 'plan.json'), planJson);
      }
      yield {
        type: 'task.completed',
        payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 },
      };
    })();
  };
  return { runner, callCount: () => calls.length };
}

const FILLER = 'x'.repeat(80);

function defaultTeamPayload(): Record<string, unknown> {
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

function buildValidPlan(team: Record<string, unknown>) {
  return {
    goal: 'Build a thing',
    team,
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
        prompt: 'implement',
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
      { from: 'b', to: 'c' },
    ],
  };
}

async function buildAppWithRunner(
  runner: (opts: RunClaudeOpts) => AsyncIterable<HarnessEvent>,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors);
  await app.register(websocket);
  await app.register(healthRoutes);
  await app.register(projectRoutes);
  await app.register(createPlansRouter({ runner }));
  await app.register(runRoutes);
  return app;
}

async function createProject(app: FastifyInstance, goal = 'goal'): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'plan-proj', goal, repoPath: '/tmp/r' },
  });
  return created.json().id;
}

/**
 * v1.9 — plans-route now requires the project brief to be finalised before
 * plan generation. `saveTeam` auto-finalises so the bulk of the existing
 * tests stay focused on plan-route behaviour. Tests that exercise the
 * brief-gate itself bypass this helper and use direct SQL.
 */
async function saveTeam(
  app: FastifyInstance,
  projectId: string,
  team: Record<string, unknown> = defaultTeamPayload(),
): Promise<void> {
  await app.inject({
    method: 'PUT',
    url: `/api/projects/${projectId}/team`,
    payload: team,
  });
  sqlite
    .prepare(
      `UPDATE project_briefs SET brief_ready = 1, completeness_score = 100, updated_at = ? WHERE project_id = ?`,
    )
    .run(Date.now(), projectId);
}

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  sqlite.close();
});

describe('plan generation route', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('happy path: returns 201 with the persisted plan', async () => {
    const team = defaultTeamPayload();
    const { runner, callCount } = makeRunner([
      {
        events: [],
        writePlan: () => buildValidPlan(team),
      },
    ]);
    app = await buildAppWithRunner(runner);
    await app.ready();
    const projectId = await createProject(app);
    await saveTeam(app, projectId, team);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/plan`,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.attempts).toBe(1);
    expect(body.status).toBe('draft');
    // v1.8 — projects default to runtimeVerifyEnabled=true, so the planner's
    // 3-node output gets the auto-injected runtime-verifier. Wire-up is
    // skipped because there is only a single linear core-dev (no parallel
    // reconciliation needed) — see wire-up.ts single-core-dev-skip path.
    // Final shape: 3 planner nodes + runtime-verifier = 4.
    expect(body.plan.nodes).toHaveLength(4);
    expect(body.plan.nodes.map((n: { role: string }) => n.role)).toContain('runtime-verifier');
    expect(body.plan.nodes.map((n: { role: string }) => n.role)).not.toContain('wire-up');
    expect(callCount()).toBe(1);

    // v1.10 — first plan on a fresh project is `kind='initial'`.
    expect(body.kind).toBe('initial');
    expect(body.parentStateId).toBeNull();

    // GET returns the persisted plan
    const fetched = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/plan`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().status).toBe('draft');
  });

  it('retries once on validation failure then succeeds', async () => {
    const team = defaultTeamPayload();
    const { runner, callCount } = makeRunner([
      {
        events: [],
        writePlan: () => ({ goal: 'nope' }),
      },
      {
        events: [],
        writePlan: () => buildValidPlan(team),
      },
    ]);
    app = await buildAppWithRunner(runner);
    await app.ready();
    const projectId = await createProject(app);
    await saveTeam(app, projectId, team);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/plan`,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().attempts).toBe(2);
    expect(callCount()).toBe(2);
  });

  it('returns 422 after three failures', async () => {
    const team = defaultTeamPayload();
    const { runner, callCount } = makeRunner([
      { events: [], writePlan: () => ({ bad: 1 }) },
      { events: [], writePlan: () => ({ bad: 2 }) },
      { events: [], writePlan: () => ({ bad: 3 }) },
    ]);
    app = await buildAppWithRunner(runner);
    await app.ready();
    const projectId = await createProject(app);
    await saveTeam(app, projectId, team);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/plan`,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('plan_generation_failed');
    expect(res.json().attempts).toBe(3);
    expect(callCount()).toBe(3);
  });

  it('returns 400 when project is missing', async () => {
    const { runner } = makeRunner([]);
    app = await buildAppWithRunner(runner);
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/00000000-0000-0000-0000-000000000000/plan',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('project_missing');
  });

  it('returns 400 when team is missing', async () => {
    const { runner } = makeRunner([]);
    app = await buildAppWithRunner(runner);
    await app.ready();
    const projectId = await createProject(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/plan`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('team_missing');
  });

  it('returns 503 on rate-limit mid-stream with resetAt propagated', async () => {
    const team = defaultTeamPayload();
    const resetAt = Date.now() + 60_000;
    const runner = (_opts: RunClaudeOpts): AsyncIterable<HarnessEvent> => {
      return (async function* () {
        yield {
          type: 'rate-limit.hit',
          payload: { runId: '', taskId: _opts.taskId, resetAt, source: 'stdout-marker' },
        };
        yield {
          type: 'task.failed',
          payload: { taskId: _opts.taskId, error: 'rate-limited' },
        };
      })();
    };
    app = await buildAppWithRunner(runner);
    await app.ready();
    const projectId = await createProject(app);
    await saveTeam(app, projectId, team);

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/plan`,
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('rate-limit');
    expect(res.json().resetAt).toBe(resetAt);
  });

  it('GET plan returns 200 + null when none exists', async () => {
    const { runner } = makeRunner([]);
    app = await buildAppWithRunner(runner);
    await app.ready();
    const projectId = await createProject(app);
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/plan`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
  });
});

describe('plan PATCH and LOCK routes', () => {
  // Migrations + sqlite lifecycle are owned by the first describe in this file.
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  async function setupDraftPlan(): Promise<{
    app: FastifyInstance;
    planId: string;
    team: ReturnType<typeof defaultTeamPayload>;
  }> {
    const team = defaultTeamPayload();
    const { runner } = makeRunner([
      {
        events: [],
        writePlan: () => buildValidPlan(team),
      },
    ]);
    const a = await buildAppWithRunner(runner);
    await a.ready();
    const projectId = await createProject(a);
    await saveTeam(a, projectId, team);
    const res = await a.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/plan`,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const planId = res.json().id as string;
    return { app: a, planId, team };
  }

  it('PATCH valid plan body returns 200 with updated dag', async () => {
    const ctx = await setupDraftPlan();
    app = ctx.app;
    const updatedPlan = buildValidPlan(ctx.team);
    updatedPlan.nodes[0].prompt = 'design v2';

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/plans/${ctx.planId}`,
      payload: { dagJson: updatedPlan },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(ctx.planId);
    expect(body.dagJson.nodes[0].prompt).toBe('design v2');
    expect(body.status).toBe('draft');
  });

  it('PATCH with missing-edge-target returns 400 with errors[]', async () => {
    const ctx = await setupDraftPlan();
    app = ctx.app;
    const bad = buildValidPlan(ctx.team);
    bad.edges.push({ from: 'a', to: 'nope' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/plans/${ctx.planId}`,
      payload: { dagJson: bad },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('invalid_dag');
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.join(' ')).toMatch(/nope/);
  });

  it('PATCH with cycle returns 400', async () => {
    const ctx = await setupDraftPlan();
    app = ctx.app;
    const cyclic = buildValidPlan(ctx.team);
    // a depends on c, while c depends on b depends on a -> cycle
    cyclic.nodes[0].deps = ['c'];

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/plans/${ctx.planId}`,
      payload: { dagJson: cyclic },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('invalid_dag');
    expect(body.errors.join(' ')).toMatch(/cycle/i);
  });

  it('PATCH with empty body returns 400 empty-patch', async () => {
    const ctx = await setupDraftPlan();
    app = ctx.app;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/plans/${ctx.planId}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('empty-patch');
  });

  it('PATCH on locked plan returns 409', async () => {
    const ctx = await setupDraftPlan();
    app = ctx.app;
    // Lock the plan first.
    const lockRes = await app.inject({
      method: 'POST',
      url: `/api/plans/${ctx.planId}/lock`,
    });
    expect(lockRes.statusCode).toBe(200);

    const next = buildValidPlan(ctx.team);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/plans/${ctx.planId}`,
      payload: { dagJson: next },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('plan-locked');
  });

  it('LOCK draft plan returns 200 with status=locked', async () => {
    const ctx = await setupDraftPlan();
    app = ctx.app;
    const res = await app.inject({
      method: 'POST',
      url: `/api/plans/${ctx.planId}/lock`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('locked');
  });

  it('LOCK already-locked plan returns 409', async () => {
    const ctx = await setupDraftPlan();
    app = ctx.app;
    await app.inject({ method: 'POST', url: `/api/plans/${ctx.planId}/lock` });
    const res = await app.inject({
      method: 'POST',
      url: `/api/plans/${ctx.planId}/lock`,
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe('invalid-transition');
    expect(body.currentStatus).toBe('locked');
  });

  it('LOCK plan that fails validation returns 400', async () => {
    const { runner } = makeRunner([]);
    app = await buildAppWithRunner(runner);
    await app.ready();
    const projectId = await createProject(app);
    // Insert a corrupt plan row directly.
    const planId = randomUUID();
    await db
      .insert(plans)
      .values({
        id: planId,
        projectId,
        dagJson: { nope: true } as unknown,
        status: 'draft',
      })
      .run();
    // Sanity: row exists.
    const row = await db.select().from(plans).where(eq(plans.id, planId)).get();
    expect(row).toBeDefined();

    const res = await app.inject({
      method: 'POST',
      url: `/api/plans/${planId}/lock`,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(['invalid_plan', 'invalid_dag']).toContain(body.error);
    expect(Array.isArray(body.errors)).toBe(true);
  });
});
