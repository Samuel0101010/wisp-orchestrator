import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { teams } from '@agent-harness/schemas';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { db, sqlite } from '../db/index.js';

const FILLER = 'x'.repeat(80);

function makeTeam(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    architect: {
      role: 'architect',
      model: 'opus',
      allowedTools: ['Read', 'Write(architecture.md)'],
      systemPrompt: `arch ${FILLER}`,
    },
    developer: {
      role: 'developer',
      model: 'sonnet',
      allowedTools: ['Read', 'Edit', 'Write'],
      systemPrompt: `dev ${FILLER}`,
    },
    qa: {
      role: 'qa',
      model: 'sonnet',
      allowedTools: ['Read', 'Bash(pnpm test)'],
      systemPrompt: `qa ${FILLER}`,
    },
    ...overrides,
  };
}

describe('team routes', () => {
  let app: FastifyInstance;
  let projectId: string;

  beforeAll(async () => {
    runMigrations();
    app = await buildApp();
    await app.ready();
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'team-proj', goal: 'goal here', repoPath: '/tmp/repo' },
    });
    projectId = created.json().id;
  });

  afterAll(async () => {
    await app.close();
    sqlite.close();
  });

  it('GET on a project with no team returns 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/team`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET on nonexistent project returns 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/00000000-0000-0000-0000-000000000000/team',
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT with role/slot mismatch returns 400', async () => {
    const bad = makeTeam({
      architect: {
        role: 'developer',
        model: 'opus',
        allowedTools: [],
        systemPrompt: `wrong slot ${FILLER}`,
      },
    });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/team`,
      payload: bad,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/architect.role/);
  });

  it('PUT with too-short systemPrompt returns 400', async () => {
    const bad = makeTeam({
      architect: {
        role: 'architect',
        model: 'opus',
        allowedTools: [],
        systemPrompt: 'too short',
      },
    });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/team`,
      payload: bad,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/systemPrompt/);
  });

  it('PUT on nonexistent project returns 404', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/00000000-0000-0000-0000-000000000000/team',
      payload: makeTeam(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT a valid team returns 200 and echoes input', async () => {
    const team = makeTeam();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/team`,
      payload: team,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(team);
  });

  it('GET after PUT returns the team', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/team`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().architect.model).toBe('opus');
    expect(res.json().developer.model).toBe('sonnet');
  });

  it('persists rolesJson in slotted shape (object with architect/developer/qa keys)', async () => {
    const team = makeTeam();
    const create = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/team`,
      payload: team,
    });
    expect(create.statusCode).toBe(200);

    const rows = await db.select().from(teams).where(eq(teams.projectId, projectId)).all();
    expect(rows).toHaveLength(1);
    const stored = rows[0]!.rolesJson as unknown;
    // Must be a slotted object, NOT an array.
    expect(Array.isArray(stored)).toBe(false);
    expect(stored).toMatchObject({
      architect: { role: 'architect' },
      developer: { role: 'developer' },
      qa: { role: 'qa' },
    });
  });

  it('PUT same project again replaces (no duplicate row)', async () => {
    const team = makeTeam({
      developer: {
        role: 'developer',
        model: 'haiku',
        allowedTools: ['Read'],
        systemPrompt: `dev v2 ${FILLER}`,
      },
    });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/team`,
      payload: team,
    });
    expect(res.statusCode).toBe(200);

    const rows = await db.select().from(teams).where(eq(teams.projectId, projectId)).all();
    expect(rows).toHaveLength(1);

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/team`,
    });
    expect(fetched.json().developer.model).toBe('haiku');
  });
});
