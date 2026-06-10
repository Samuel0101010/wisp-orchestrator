import './setup.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { sqlite } from '../db/index.js';

// Spy on the worktree cleanup so the delete route's wiring (preview AND
// bootcheck worktree) is observable without touching git on disk.
const { cleanupSpy } = vi.hoisted(() => ({
  cleanupSpy: vi.fn(async () => {}),
}));
vi.mock('../orchestrator/preview-server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orchestrator/preview-server.js')>();
  return { ...actual, cleanupPreviewWorktree: cleanupSpy };
});

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

  it('reaps both the preview and the bootcheck worktree on delete', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'wt-clean', goal: 'g', repoPath: '/tmp/wt-clean' },
    });
    const { id } = created.json();
    const repoPath = (await app.inject({ method: 'GET', url: `/api/projects/${id}` })).json()
      .repoPath as string;

    cleanupSpy.mockClear();
    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${id}` });
    expect(del.statusCode).toBe(204);

    expect(cleanupSpy).toHaveBeenCalledWith(repoPath, id);
    expect(cleanupSpy).toHaveBeenCalledWith(repoPath, id, { dirName: `bootcheck-${id}` });
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
