import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { sqlite } from '../db/index.js';

async function createProject(app: FastifyInstance, name = 'cr-tests'): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name, goal: 'g', repoPath: '/tmp/x' },
  });
  return r.json().id;
}

describe('Change-request CRUD', () => {
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

  it('GET returns empty array for a new project', async () => {
    const projectId = await createProject(app);
    const r = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/change-requests`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it('POST with text source creates a pending row', async () => {
    const projectId = await createProject(app);
    const r = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/change-requests`,
      payload: { source: 'text', userPrompt: 'Add a dark-mode toggle' },
    });
    expect(r.statusCode).toBe(201);
    const row = r.json();
    expect(row.status).toBe('pending');
    expect(row.source).toBe('text');
    expect(row.selector).toBeNull();
    expect(row.rectJson).toBeNull();
    expect(row.userPrompt).toBe('Add a dark-mode toggle');
  });

  it('POST visual source with selector + rect roundtrips', async () => {
    const projectId = await createProject(app);
    const rect = { x: 12, y: 34, width: 200, height: 60 };
    const r = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/change-requests`,
      payload: {
        source: 'visual',
        selector: 'div.card:nth-of-type(2)',
        rectJson: rect,
        userPrompt: 'Make this card blue',
      },
    });
    expect(r.statusCode).toBe(201);
    const row = r.json();
    expect(row.source).toBe('visual');
    expect(row.selector).toBe('div.card:nth-of-type(2)');
    expect(row.rectJson).toEqual(rect);

    // Re-fetch via GET to confirm the JSON column survives storage.
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/change-requests`,
    });
    const rows = list.json();
    expect(rows.length).toBe(1);
    expect(rows[0].rectJson).toEqual(rect);
  });

  it('POST rejects empty userPrompt', async () => {
    const projectId = await createProject(app);
    const r = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/change-requests`,
      payload: { source: 'text', userPrompt: '' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('PATCH flips status pending → dismissed', async () => {
    const projectId = await createProject(app);
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/change-requests`,
      payload: { source: 'text', userPrompt: 'eh nevermind' },
    });
    const id = created.json().id;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/change-requests/${id}`,
      payload: { status: 'dismissed' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().status).toBe('dismissed');

    // Default GET (status=pending) should no longer include it.
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/change-requests`,
    });
    expect(list.json()).toEqual([]);
    // GET with explicit status=dismissed finds it.
    const listDismissed = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/change-requests?status=dismissed`,
    });
    expect(listDismissed.json().length).toBe(1);
  });

  it('DELETE removes the row', async () => {
    const projectId = await createProject(app);
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/change-requests`,
      payload: { source: 'text', userPrompt: 'temp' },
    });
    const id = created.json().id;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/change-requests/${id}`,
    });
    expect(del.statusCode).toBe(204);
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/change-requests`,
    });
    expect(list.json()).toEqual([]);
  });

  it('cross-project isolation: project A row does not leak to project B', async () => {
    const projectA = await createProject(app, 'A');
    const projectB = await createProject(app, 'B');
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectA}/change-requests`,
      payload: { source: 'text', userPrompt: 'A-only note' },
    });
    const listB = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectB}/change-requests`,
    });
    expect(listB.json()).toEqual([]);
    const listA = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectA}/change-requests`,
    });
    expect(listA.json().length).toBe(1);
  });

  it('404 on unknown project for GET and POST', async () => {
    const getR = await app.inject({
      method: 'GET',
      url: '/api/projects/missing-xyz/change-requests',
    });
    expect(getR.statusCode).toBe(404);
    const postR = await app.inject({
      method: 'POST',
      url: '/api/projects/missing-xyz/change-requests',
      payload: { source: 'text', userPrompt: 'hi' },
    });
    expect(postR.statusCode).toBe(404);
  });
});
