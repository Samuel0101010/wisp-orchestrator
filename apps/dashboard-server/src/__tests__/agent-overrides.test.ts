import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { sqlite } from '../db/index.js';

async function createProject(app: FastifyInstance, name = 'aov-tests'): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name, goal: 'g', repoPath: '/tmp/x' },
  });
  return r.json().id;
}

describe('agent overrides CRUD', () => {
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

  it('GET returns an empty list for a fresh project', async () => {
    const projectId = await createProject(app);
    const r = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/agent-overrides`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it('GET 404 for unknown project', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/projects/does-not-exist/agent-overrides`,
    });
    expect(r.statusCode).toBe(404);
  });

  it('PUT creates a new override row', async () => {
    const projectId = await createProject(app);
    const r = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/agent-overrides/developer`,
      payload: {
        model: 'opus',
        extraSystemPrompt: 'Prefer functional patterns.',
        extraAllowedTools: ['Read', 'Write', 'Bash'],
        memoryNamespace: 'shared-dev',
      },
    });
    expect(r.statusCode).toBe(200);
    const row = r.json();
    expect(row.role).toBe('developer');
    expect(row.model).toBe('opus');
    expect(row.extraSystemPrompt).toBe('Prefer functional patterns.');
    expect(row.extraAllowedTools).toEqual(['Read', 'Write', 'Bash']);
    expect(row.memoryNamespace).toBe('shared-dev');
  });

  it('PUT updates an existing row (UNIQUE on project+role enforces upsert semantics)', async () => {
    const projectId = await createProject(app);
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/agent-overrides/architect`,
      payload: { model: 'opus' },
    });
    const r = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/agent-overrides/architect`,
      payload: { model: 'sonnet', extraSystemPrompt: 'Be concise.' },
    });
    expect(r.statusCode).toBe(200);
    const row = r.json();
    expect(row.model).toBe('sonnet');
    expect(row.extraSystemPrompt).toBe('Be concise.');

    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/agent-overrides`,
    });
    expect(list.json()).toHaveLength(1);
  });

  it('GET :role returns the row when present and 404 otherwise', async () => {
    const projectId = await createProject(app);
    const miss = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/agent-overrides/developer`,
    });
    expect(miss.statusCode).toBe(404);

    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/agent-overrides/developer`,
      payload: { model: 'haiku' },
    });
    const hit = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/agent-overrides/developer`,
    });
    expect(hit.statusCode).toBe(200);
    expect(hit.json().model).toBe('haiku');
  });

  it('DELETE removes the row and returns 204', async () => {
    const projectId = await createProject(app);
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/agent-overrides/qa`,
      payload: { extraSystemPrompt: 'Run e2e' },
    });
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/agent-overrides/qa`,
    });
    expect(del.statusCode).toBe(204);

    const miss = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/agent-overrides/qa`,
    });
    expect(miss.statusCode).toBe(404);
  });

  it('PUT rejects empty body (no editable fields)', async () => {
    const projectId = await createProject(app);
    const r = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/agent-overrides/developer`,
      payload: {},
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });

  it('PUT to unknown project returns 404', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: `/api/projects/does-not-exist/agent-overrides/developer`,
      payload: { model: 'opus' },
    });
    expect(r.statusCode).toBe(404);
  });
});
