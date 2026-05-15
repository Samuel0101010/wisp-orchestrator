import './setup.js';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { eq } from 'drizzle-orm';
import { leadNotes as leadNotesTable, projects as projectsTable } from '@agent-harness/schemas';
import { projectRoutes } from '../routes/projects.js';
import { createLeadRouter } from '../routes/lead.js';
import { runMigrations } from '../db/migrate.js';
import { seedAgents } from '../db/agents-seed.js';
import { db, sqlite } from '../db/index.js';
import type { RunLeadTickResult } from '../orchestrator/lead-runner.js';

beforeAll(() => {
  runMigrations();
  seedAgents();
});

afterAll(() => {
  sqlite.close();
});

function makeRunTick(
  result: RunLeadTickResult,
): (args: { projectId: string; runId?: string }) => Promise<RunLeadTickResult> {
  return async () => result;
}

async function buildApp(
  runTick?: (args: { projectId: string; runId?: string }) => Promise<RunLeadTickResult>,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors);
  await app.register(projectRoutes);
  await app.register(createLeadRouter(runTick ? { runTick: runTick as unknown as never } : {}));
  await app.ready();
  return app;
}

function seedProject(opts: { leadEnabled?: boolean } = {}): string {
  const id = randomUUID();
  db.insert(projectsTable)
    .values({
      id,
      name: 'lead-routes-test',
      goal: 'g',
      repoPath: '/tmp/x',
      createdAt: new Date(),
      leadEnabled: opts.leadEnabled ?? false,
    })
    .run();
  return id;
}

describe('lead routes', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('POST /lead/tick returns 412 when leadEnabled=false', async () => {
    app = await buildApp(makeRunTick({} as RunLeadTickResult));
    const projectId = seedProject({ leadEnabled: false });
    const r = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/lead/tick` });
    expect(r.statusCode).toBe(412);
    expect(r.json().error).toBe('lead_disabled');
  });

  it('POST /lead/tick returns 404 when project missing', async () => {
    app = await buildApp(makeRunTick({} as RunLeadTickResult));
    const r = await app.inject({ method: 'POST', url: '/api/projects/missing/lead/tick' });
    expect(r.statusCode).toBe(404);
  });

  it('POST /lead/tick happy path with mocked runTick', async () => {
    const fake: RunLeadTickResult = {
      noteId: 'n-1',
      summary: 'all good',
      decision: { recommendedAction: 'continue', nextRole: null },
      parseError: null,
      tokensIn: 10,
      tokensOut: 5,
      durationMs: 99,
      failed: null,
    };
    app = await buildApp(makeRunTick(fake));
    const projectId = seedProject({ leadEnabled: true });
    const r = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/lead/tick` });
    expect(r.statusCode).toBe(200);
    expect(r.json().summary).toBe('all good');
    expect(r.json().decision.recommendedAction).toBe('continue');
  });

  it('GET /lead/notes returns array ordered newest-first', async () => {
    app = await buildApp(makeRunTick({} as RunLeadTickResult));
    const projectId = seedProject({ leadEnabled: true });
    const now = Date.now();
    db.insert(leadNotesTable)
      .values({
        id: 'old',
        projectId,
        runId: null,
        summaryMd: 'older',
        decisionsJson: null,
        triggeredRunId: null,
        createdAt: new Date(now - 10_000),
      })
      .run();
    db.insert(leadNotesTable)
      .values({
        id: 'new',
        projectId,
        runId: null,
        summaryMd: 'newer',
        decisionsJson: { recommendedAction: 'continue' },
        triggeredRunId: null,
        createdAt: new Date(now),
      })
      .run();
    const r = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/lead/notes` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as Array<{ id: string; summaryMd: string }>;
    expect(body).toHaveLength(2);
    expect(body[0]!.id).toBe('new');
    expect(body[1]!.id).toBe('old');
  });

  it('GET /lead/notes/:id and DELETE work', async () => {
    app = await buildApp(makeRunTick({} as RunLeadTickResult));
    const projectId = seedProject({ leadEnabled: true });
    db.insert(leadNotesTable)
      .values({
        id: 'note-x',
        projectId,
        runId: null,
        summaryMd: 'pick me',
        decisionsJson: null,
        triggeredRunId: null,
        createdAt: new Date(),
      })
      .run();

    const get = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/lead/notes/note-x`,
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().summaryMd).toBe('pick me');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/lead/notes/note-x`,
    });
    expect(del.statusCode).toBe(204);

    const after = db.select().from(leadNotesTable).where(eq(leadNotesTable.id, 'note-x')).get();
    expect(after).toBeUndefined();
  });

  it('PATCH /api/projects/:id accepts leadEnabled', async () => {
    app = await buildApp(makeRunTick({} as RunLeadTickResult));
    const projectId = seedProject({ leadEnabled: false });
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      payload: { leadEnabled: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().leadEnabled).toBe(true);
  });
});
