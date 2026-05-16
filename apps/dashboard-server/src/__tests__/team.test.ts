import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { teams } from '@wisp/schemas';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { db, sqlite } from '../db/index.js';

const FILLER = 'x'.repeat(80);

function makeRole(
  role: string,
  model: string = 'sonnet',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    role,
    model,
    allowedTools: ['Read'],
    systemPrompt: `${role} ${FILLER}`,
    ...overrides,
  };
}

function makeTeam(roles?: Record<string, unknown>[]): { roles: Record<string, unknown>[] } {
  return {
    roles: roles ?? [
      makeRole('architect', 'opus', { allowedTools: ['Read', 'Write(architecture.md)'] }),
      makeRole('developer', 'sonnet', { allowedTools: ['Read', 'Edit', 'Write'] }),
      makeRole('qa', 'sonnet', { allowedTools: ['Read', 'Bash(pnpm test)'] }),
    ],
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

  it('PUT with duplicate role names returns 400', async () => {
    const bad = makeTeam([makeRole('architect', 'opus'), makeRole('architect', 'sonnet')]);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/team`,
      payload: bad,
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT a 4-role team with custom role names returns 200', async () => {
    const team = makeTeam([
      makeRole('architect', 'opus'),
      makeRole('backend-dev', 'sonnet'),
      makeRole('frontend-dev', 'sonnet'),
      makeRole('qa', 'haiku'),
    ]);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/team`,
      payload: team,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { roles: Array<{ role: string; model: string }> };
    expect(body.roles).toHaveLength(4);
    expect(body.roles.map((r) => r.role)).toEqual([
      'architect',
      'backend-dev',
      'frontend-dev',
      'qa',
    ]);
  });

  it('PUT an 8-role team is accepted (max boundary)', async () => {
    const roles = Array.from({ length: 8 }, (_, i) => makeRole(`role-${i + 1}`));
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/team`,
      payload: { roles },
    });
    expect(res.statusCode).toBe(200);
  });

  it('PUT a 9-role team returns 400 (over max)', async () => {
    const roles = Array.from({ length: 9 }, (_, i) => makeRole(`role-${i + 1}`));
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/team`,
      payload: { roles },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT an empty roles array returns 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/team`,
      payload: { roles: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT with non-kebab-case role name returns 400', async () => {
    const bad = makeTeam([makeRole('Architect'), makeRole('developer'), makeRole('qa')]);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/team`,
      payload: bad,
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT with model not in opus/sonnet/haiku returns 400', async () => {
    const bad = makeTeam([makeRole('architect', 'gpt-4'), makeRole('developer'), makeRole('qa')]);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/team`,
      payload: bad,
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT with too-short systemPrompt returns 400', async () => {
    const bad = makeTeam([makeRole('architect', 'opus', { systemPrompt: 'too short' })]);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/team`,
      payload: bad,
    });
    expect(res.statusCode).toBe(400);
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
    const body = res.json() as { roles: Array<{ role: string; model: string }> };
    expect(body.roles.find((r) => r.role === 'architect')?.model).toBe('opus');
    expect(body.roles.find((r) => r.role === 'developer')?.model).toBe('sonnet');
  });

  it('persists rolesJson in the new {roles:[...]} shape', async () => {
    const team = makeTeam();
    const create = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/team`,
      payload: team,
    });
    expect(create.statusCode).toBe(200);

    const rows = await db.select().from(teams).where(eq(teams.projectId, projectId)).all();
    expect(rows).toHaveLength(1);
    const stored = rows[0]!.rolesJson as { roles: Array<{ role: string }> };
    expect(Array.isArray(stored.roles)).toBe(true);
    expect(stored.roles.some((r) => r.role === 'architect')).toBe(true);
  });

  it('PUT same project again replaces (no duplicate row)', async () => {
    const team = makeTeam([
      makeRole('architect', 'opus'),
      makeRole('developer', 'haiku'),
      makeRole('qa', 'sonnet'),
    ]);
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
    const body = fetched.json() as { roles: Array<{ role: string; model: string }> };
    expect(body.roles.find((r) => r.role === 'developer')?.model).toBe('haiku');
  });
});
