import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { sqlite } from '../db/index.js';

describe('DELETE /api/projects/:id', () => {
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

  it('deletes an existing project and returns 204', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'to-delete', goal: 'g', repoPath: '/tmp/del' },
    });
    const { id } = created.json();

    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${id}` });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: `/api/projects/${id}` });
    expect(after.statusCode).toBe(404);
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/projects/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'project not found' });
  });
});
