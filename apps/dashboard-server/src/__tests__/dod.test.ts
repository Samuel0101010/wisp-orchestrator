import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { sqlite } from '../db/index.js';

async function createProject(app: FastifyInstance, name = 'dod-tests'): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name, goal: 'g', repoPath: '/tmp/x' },
  });
  return r.json().id;
}

describe('DoD CRUD', () => {
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

  it('returns empty list for a fresh project', async () => {
    const projectId = await createProject(app);
    const r = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/dod` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it('rejects an e2e criterion with smoke-shaped spec', async () => {
    const projectId = await createProject(app);
    const r = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/dod`,
      payload: {
        title: 'Login',
        kind: 'smoke',
        spec: { description: 'login flow' }, // no url ⇒ smokeSpec fails
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid_spec_for_kind');
  });

  it('creates smoke + e2e + manual criteria and lists them ordered by position', async () => {
    const projectId = await createProject(app);
    const a = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/dod`,
      payload: { title: 'API up', kind: 'smoke', spec: { url: '/api/health' } },
    });
    expect(a.statusCode).toBe(201);
    const b = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/dod`,
      payload: {
        title: 'User logs in',
        kind: 'e2e',
        spec: { testFile: 'tests/runtime/login.spec.ts' },
      },
    });
    expect(b.statusCode).toBe(201);
    const c = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/dod`,
      payload: { title: 'Eyeball it', kind: 'manual', spec: { note: 'check the dashboard' } },
    });
    expect(c.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/dod` });
    expect(list.statusCode).toBe(200);
    const rows = list.json();
    expect(rows.length).toBe(3);
    expect(rows.map((r: { title: string }) => r.title)).toEqual([
      'API up',
      'User logs in',
      'Eyeball it',
    ]);
    expect(rows.map((r: { position: number }) => r.position)).toEqual([0, 1, 2]);
  });

  it('PATCH updates fields and re-validates spec against the new kind', async () => {
    const projectId = await createProject(app);
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/dod`,
      payload: { title: 't', kind: 'smoke', spec: { url: '/x' } },
    });
    const id = create.json().id;
    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/dod/${id}`,
      payload: { title: 'renamed' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().title).toBe('renamed');

    // Switching kind WITHOUT supplying a matching spec keeps the old spec —
    // we only re-validate when both kind and spec are present, or when only
    // spec is present (validated against existing kind).
    const partial = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/dod/${id}`,
      payload: { kind: 'manual' },
    });
    expect(partial.statusCode).toBe(200);
    expect(partial.json().kind).toBe('manual');

    // Now patch the spec — it must match the new (manual) kind. Smoke shape
    // would fail, but { note } is valid for manual.
    const specPatch = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/dod/${id}`,
      payload: { spec: { note: 'human gate' } },
    });
    expect(specPatch.statusCode).toBe(200);
    expect(specPatch.json().specJson).toEqual({ note: 'human gate' });
  });

  it('PATCH with an empty body returns 400', async () => {
    const projectId = await createProject(app);
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/dod`,
      payload: { title: 't', kind: 'smoke', spec: { url: '/x' } },
    });
    const id = create.json().id;
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/dod/${id}`,
      payload: {},
    });
    expect(r.statusCode).toBe(400);
  });

  it('DELETE returns 204 and removes the row from the list', async () => {
    const projectId = await createProject(app);
    const create = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/dod`,
      payload: { title: 't', kind: 'smoke', spec: { url: '/x' } },
    });
    const id = create.json().id;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/dod/${id}`,
    });
    expect(del.statusCode).toBe(204);
    const list = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/dod` });
    expect(list.json()).toEqual([]);
  });

  it('PUT bulk replaces the entire list atomically', async () => {
    const projectId = await createProject(app);
    // Seed two criteria first.
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/dod`,
      payload: { title: 'old1', kind: 'smoke', spec: { url: '/a' } },
    });
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/dod`,
      payload: { title: 'old2', kind: 'manual', spec: {} },
    });
    const replace = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/dod`,
      payload: {
        criteria: [
          { title: 'new1', kind: 'smoke', spec: { url: '/health' } },
          { title: 'new2', kind: 'e2e', spec: { description: 'login flow' } },
        ],
      },
    });
    expect(replace.statusCode).toBe(200);
    const rows = replace.json();
    expect(rows.length).toBe(2);
    expect(rows.map((r: { title: string }) => r.title)).toEqual(['new1', 'new2']);
  });

  it('PUT rejects the whole batch when any item has an invalid spec', async () => {
    const projectId = await createProject(app);
    const r = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/dod`,
      payload: {
        criteria: [
          { title: 'ok', kind: 'smoke', spec: { url: '/h' } },
          { title: 'broken', kind: 'smoke', spec: { description: 'no url' } },
        ],
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().index).toBe(1);
  });

  it('GET /api/runs/:runId/runtime-report returns 404 when none exists', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/runs/run-nonexistent/runtime-report',
    });
    expect(r.statusCode).toBe(404);
  });

  it('returns 404 for unknown project', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/nope/dod' });
    expect(r.statusCode).toBe(404);
  });
});
