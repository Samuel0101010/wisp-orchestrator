import './setup.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { HarnessEvent } from '@wisp/schemas';
import type { RunClaudeOpts } from '@wisp/orchestrator';
import { healthRoutes } from '../routes/health.js';
import { projectRoutes } from '../routes/projects.js';
import { createPlansRouter } from '../routes/plans.js';
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

function makeRunner(team: Record<string, unknown>) {
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

async function buildApp(team: Record<string, unknown>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors);
  await app.register(websocket);
  await app.register(healthRoutes);
  await app.register(projectRoutes);
  await app.register(createPlansRouter({ runner: makeRunner(team) }));
  return app;
}

async function createProjectAndTeam(app: FastifyInstance): Promise<string> {
  const c = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'iter-proj', goal: 'g', repoPath: '/tmp/iter' },
  });
  const projectId = c.json().id as string;
  await app.inject({
    method: 'PUT',
    url: `/api/projects/${projectId}/team`,
    payload: defaultTeam(),
  });
  sqlite
    .prepare(
      `UPDATE project_briefs SET brief_ready = 1, completeness_score = 100, updated_at = ? WHERE project_id = ?`,
    )
    .run(Date.now(), projectId);
  return projectId;
}

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  sqlite.close();
});

describe('plan kind detection + iteration context', () => {
  it('plan.kind = "iteration" when a project_state row exists', async () => {
    const team = defaultTeam();
    const app = await buildApp(team);
    await app.ready();
    try {
      const projectId = await createProjectAndTeam(app);
      const stateId = await persistProjectState({
        db,
        projectId,
        runId: null,
        stateMdPath: null,
        parsed: {
          completedFeatures: ['Login flow', 'Goal CRUD'],
          openTodos: ['Add export'],
          knownIssues: ['Slow render on >1000 rows'],
          architectureSnapshot: null,
        },
      });

      const r = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/plan`,
        payload: {},
      });
      expect(r.statusCode).toBe(201);
      const body = r.json();
      expect(body.kind).toBe('iteration');
      expect(body.parentStateId).toBe(stateId);
    } finally {
      await app.close();
    }
  });

  it('plan.kind stays "initial" when no project_state row exists', async () => {
    const team = defaultTeam();
    const app = await buildApp(team);
    await app.ready();
    try {
      const projectId = await createProjectAndTeam(app);
      const r = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/plan`,
        payload: {},
      });
      expect(r.statusCode).toBe(201);
      const body = r.json();
      expect(body.kind).toBe('initial');
      expect(body.parentStateId).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('iteration plans receive pending change_requests in pendingChangeRequestIds', async () => {
    const team = defaultTeam();
    const app = await buildApp(team);
    await app.ready();
    try {
      const projectId = await createProjectAndTeam(app);
      await persistProjectState({
        db,
        projectId,
        runId: null,
        stateMdPath: null,
        parsed: {
          completedFeatures: ['Login'],
          openTodos: [],
          knownIssues: [],
          architectureSnapshot: null,
        },
      });
      const crA = randomUUID();
      const crB = randomUUID();
      const crDone = randomUUID();
      const now = Date.now();
      sqlite
        .prepare(
          `INSERT INTO change_requests (id, project_id, status, source, user_prompt, created_at) VALUES (?, ?, 'pending', 'text', ?, ?)`,
        )
        .run(crA, projectId, 'Make hero darker', now);
      sqlite
        .prepare(
          `INSERT INTO change_requests (id, project_id, status, source, user_prompt, created_at) VALUES (?, ?, 'pending', 'visual', ?, ?)`,
        )
        .run(crB, projectId, 'Add settings menu', now);
      sqlite
        .prepare(
          `INSERT INTO change_requests (id, project_id, status, source, user_prompt, created_at) VALUES (?, ?, 'done', 'text', ?, ?)`,
        )
        .run(crDone, projectId, 'Already shipped', now);

      const r = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/plan`,
        payload: {},
      });
      expect(r.statusCode).toBe(201);
      const ids: string[] = r.json().pendingChangeRequestIds;
      expect(ids).toContain(crA);
      expect(ids).toContain(crB);
      expect(ids).not.toContain(crDone);
      expect(ids).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('explicit changeRequestIds filter narrows the injection set', async () => {
    const team = defaultTeam();
    const app = await buildApp(team);
    await app.ready();
    try {
      const projectId = await createProjectAndTeam(app);
      await persistProjectState({
        db,
        projectId,
        runId: null,
        stateMdPath: null,
        parsed: {
          completedFeatures: [],
          openTodos: [],
          knownIssues: [],
          architectureSnapshot: null,
        },
      });
      const crA = randomUUID();
      const crB = randomUUID();
      const now = Date.now();
      sqlite
        .prepare(
          `INSERT INTO change_requests (id, project_id, status, source, user_prompt, created_at) VALUES (?, ?, 'pending', 'text', ?, ?)`,
        )
        .run(crA, projectId, 'A', now);
      sqlite
        .prepare(
          `INSERT INTO change_requests (id, project_id, status, source, user_prompt, created_at) VALUES (?, ?, 'pending', 'text', ?, ?)`,
        )
        .run(crB, projectId, 'B', now);

      const r = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/plan`,
        payload: { changeRequestIds: [crA] },
      });
      expect(r.statusCode).toBe(201);
      const ids: string[] = r.json().pendingChangeRequestIds;
      expect(ids).toEqual([crA]);
    } finally {
      await app.close();
    }
  });
});
