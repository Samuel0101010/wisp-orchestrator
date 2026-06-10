import './setup.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { changeRequests, plans, projects, runs, teams, type HarnessEvent } from '@wisp/schemas';
import type { RunClaudeOpts } from '@wisp/orchestrator';
import { createIterationsRouter } from '../routes/iterations.js';
import type { RunRuntime } from '../orchestrator/runtime.js';
import { runMigrations } from '../db/migrate.js';
import { db, sqlite } from '../db/index.js';
import { persistProjectState } from '../orchestrator/project-state-loader.js';

const FILLER = 'x'.repeat(80);

function defaultTeam() {
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

function buildPlanDag(team: Record<string, unknown>) {
  return {
    goal: 'do thing',
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
        prompt: 'verify',
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

/** Fake planner runner that writes a valid plan.json. */
function planWritingRunner(team: Record<string, unknown>) {
  return (opts: RunClaudeOpts): AsyncIterable<HarnessEvent> => {
    return (async function* () {
      fs.writeFileSync(path.join(opts.cwd, 'plan.json'), JSON.stringify(buildPlanDag(team)));
      yield {
        type: 'task.completed',
        payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 },
      };
    })();
  };
}

/** Fake planner runner that completes WITHOUT ever writing plan.json. */
function noPlanRunner() {
  return (opts: RunClaudeOpts): AsyncIterable<HarnessEvent> => {
    return (async function* () {
      yield {
        type: 'task.completed',
        payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 },
      };
    })();
  };
}

/**
 * Stub runtime that inserts a REAL runs row (FKs are enforced — the route's
 * change-request linking sets run_id) and returns ok, capturing startRun args.
 */
function okRuntime(capture?: (args: { planId: string; parentRunId?: string }) => void): RunRuntime {
  return {
    startRun: async (args: { planId: string; parentRunId?: string }) => {
      capture?.(args);
      const runId = randomUUID();
      await db
        .insert(runs)
        .values({
          id: runId,
          planId: args.planId,
          status: 'running',
          budgetMinutes: 60,
          budgetTurns: 100,
          maxParallel: 2,
        })
        .run();
      return { ok: true as const, runId };
    },
  } as unknown as RunRuntime;
}

function failingRuntime(): RunRuntime {
  return {
    startRun: async () => ({
      ok: false as const,
      status: 503 as const,
      error: 'auth probe failed',
    }),
  } as unknown as RunRuntime;
}

/** Stub runtime that reports another run already active for the project. */
function busyRuntime(activeRunId: string): RunRuntime {
  return {
    startRun: async () => ({
      ok: false as const,
      status: 409 as const,
      error: 'run_already_active',
      details: { activeRunId },
    }),
  } as unknown as RunRuntime;
}

/** Stub runtime whose startRun THROWS instead of returning {ok:false}. */
function throwingRuntime(): RunRuntime {
  return {
    startRun: async () => {
      throw new Error('runtime exploded');
    },
  } as unknown as RunRuntime;
}

const tmpDirs: string[] = [];

/** A repo dir with a `.git` marker so the iteration preflight passes. */
function makeGitDir(): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-iter-ep-'));
  tmpDirs.push(repoPath);
  fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
  return repoPath;
}

async function seedProject(opts: { repoPath: string; withState?: boolean }): Promise<string> {
  const projectId = randomUUID();
  await db
    .insert(projects)
    .values({ id: projectId, name: 'iter-ep', goal: 'g', repoPath: opts.repoPath })
    .run();
  await db.insert(teams).values({ id: randomUUID(), projectId, rolesJson: defaultTeam() }).run();
  if (opts.withState !== false) {
    await persistProjectState({
      db,
      projectId,
      runId: null,
      stateMdPath: null,
      parsed: {
        completedFeatures: ['v1 shipped'],
        openTodos: [],
        knownIssues: [],
        architectureSnapshot: null,
      },
    });
  }
  return projectId;
}

async function seedPendingChangeRequest(projectId: string, prompt: string): Promise<string> {
  const id = randomUUID();
  await db
    .insert(changeRequests)
    .values({ id, projectId, status: 'pending', source: 'text', userPrompt: prompt })
    .run();
  return id;
}

async function buildApp(deps: {
  runner: (opts: RunClaudeOpts) => AsyncIterable<HarnessEvent>;
  runtime: RunRuntime;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(createIterationsRouter(deps));
  await app.ready();
  return app;
}

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  sqlite.close();
});

describe('POST /api/projects/:projectId/iterations', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('201 happy path: locked plan, started run, change-requests flipped to in-run', async () => {
    const team = defaultTeam();
    let startArgs: { planId: string; parentRunId?: string } | null = null;
    app = await buildApp({
      runner: planWritingRunner(team),
      runtime: okRuntime((a) => (startArgs = a)),
    });
    const projectId = await seedProject({ repoPath: makeGitDir() });
    const crA = await seedPendingChangeRequest(projectId, 'Make hero darker');
    const crB = await seedPendingChangeRequest(projectId, 'Add settings menu');

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/iterations`,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.planId).toBe('string');
    expect(typeof body.runId).toBe('string');
    expect(body.linkedChangeRequestCount).toBe(2);
    expect(startArgs!.planId).toBe(body.planId);

    // Plan persisted directly as 'locked' (no draft→lock client round-trip).
    const planRow = await db.select().from(plans).where(eq(plans.id, body.planId)).get();
    expect(planRow).toBeDefined();
    expect(planRow!.status).toBe('locked');
    expect(planRow!.kind).toBe('iteration');

    // Both pending CRs consumed: 'in-run' + linked to the new run.
    for (const crId of [crA, crB]) {
      const cr = await db.select().from(changeRequests).where(eq(changeRequests.id, crId)).get();
      expect(cr!.status).toBe('in-run');
      expect(cr!.runId).toBe(body.runId);
    }
  });

  it('422 when the planner never writes plan.json: zero plan rows, CRs stay pending', async () => {
    app = await buildApp({ runner: noPlanRunner(), runtime: okRuntime() });
    const projectId = await seedProject({ repoPath: makeGitDir() });
    const crId = await seedPendingChangeRequest(projectId, 'Never consumed');

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/iterations`,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('plan_generation_failed');

    const planRows = await db.select().from(plans).where(eq(plans.projectId, projectId)).all();
    expect(planRows).toHaveLength(0);
    const cr = await db.select().from(changeRequests).where(eq(changeRequests.id, crId)).get();
    expect(cr!.status).toBe('pending');
    expect(cr!.runId).toBeNull();
  });

  it('502 when startRun fails: plan demoted to draft, CRs stay pending', async () => {
    const team = defaultTeam();
    app = await buildApp({ runner: planWritingRunner(team), runtime: failingRuntime() });
    const projectId = await seedProject({ repoPath: makeGitDir() });
    const crId = await seedPendingChangeRequest(projectId, 'Still pending after failure');

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/iterations`,
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toBe('run_start_failed');
    expect(typeof body.planId).toBe('string');
    expect(body.runStartError).toBe('auth probe failed');

    const planRow = await db.select().from(plans).where(eq(plans.id, body.planId)).get();
    expect(planRow!.status).toBe('draft');
    const cr = await db.select().from(changeRequests).where(eq(changeRequests.id, crId)).get();
    expect(cr!.status).toBe('pending');
    expect(cr!.runId).toBeNull();
  });

  it('502 when startRun THROWS: plan demoted to draft, CRs stay pending', async () => {
    const team = defaultTeam();
    app = await buildApp({ runner: planWritingRunner(team), runtime: throwingRuntime() });
    const projectId = await seedProject({ repoPath: makeGitDir() });
    const crId = await seedPendingChangeRequest(projectId, 'Still pending after throw');

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/iterations`,
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toBe('run_start_failed');
    expect(typeof body.planId).toBe('string');
    expect(body.runStartError).toContain('runtime exploded');

    const planRow = await db.select().from(plans).where(eq(plans.id, body.planId)).get();
    expect(planRow!.status).toBe('draft');
    const cr = await db.select().from(changeRequests).where(eq(changeRequests.id, crId)).get();
    expect(cr!.status).toBe('pending');
    expect(cr!.runId).toBeNull();
  });

  it('409 run_already_active passes through (not 502): plan demoted to draft, CRs stay pending', async () => {
    const team = defaultTeam();
    app = await buildApp({ runner: planWritingRunner(team), runtime: busyRuntime('active-run-1') });
    const projectId = await seedProject({ repoPath: makeGitDir() });
    const crId = await seedPendingChangeRequest(projectId, 'Still pending while busy');

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/iterations`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe('run_already_active');
    expect(typeof body.planId).toBe('string');
    expect(body.details).toEqual({ activeRunId: 'active-run-1' });

    // The run never started: the plan is demoted for a clean retry and the
    // change-requests stay queued.
    const planRow = await db.select().from(plans).where(eq(plans.id, body.planId)).get();
    expect(planRow!.status).toBe('draft');
    const cr = await db.select().from(changeRequests).where(eq(changeRequests.id, crId)).get();
    expect(cr!.status).toBe('pending');
    expect(cr!.runId).toBeNull();
  });

  it('409 no_prior_state when the project has never produced a project-state snapshot', async () => {
    app = await buildApp({ runner: planWritingRunner(defaultTeam()), runtime: okRuntime() });
    const projectId = await seedProject({ repoPath: makeGitDir(), withState: false });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/iterations`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_prior_state');
  });

  it('404 project_not_found for an unknown project id', async () => {
    app = await buildApp({ runner: planWritingRunner(defaultTeam()), runtime: okRuntime() });
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${randomUUID()}/iterations`,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('project_not_found');
  });
});
