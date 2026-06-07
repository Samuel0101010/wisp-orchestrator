import './setup.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { sqlite } from '../db/index.js';

describe('projects routes', () => {
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

  it('POST /api/projects creates and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'p1', goal: 'g1', repoPath: '/tmp/repo' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/[0-9a-f-]{36}/);
    expect(body.name).toBe('p1');
  });

  it('GET /api/projects lists created project', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it('GET /api/projects/:id returns the project', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'p2', goal: 'g2', repoPath: '/tmp/repo2' },
    });
    const { id } = created.json();
    const res = await app.inject({ method: 'GET', url: `/api/projects/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });

  it('GET /api/projects/:id 404 on unknown', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/projects 400 on missing field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'only-name' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('validation_error');
  });

  it('PATCH /api/projects/:id updates the goal field and returns the updated row', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'p-patch', goal: 'old goal', repoPath: '/tmp/p-patch' },
    });
    const { id } = created.json();

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${id}`,
      payload: { goal: 'new goal that has been updated' },
    });
    expect(patch.statusCode).toBe(200);
    const body = patch.json();
    expect(body.id).toBe(id);
    expect(body.goal).toBe('new goal that has been updated');
    expect(body.name).toBe('p-patch');
    expect(body.repoPath).toBe('/tmp/p-patch');
  });

  it('PATCH /api/projects/:id 400 when no fields are provided', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/projects/00000000-0000-0000-0000-000000000000',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH /api/projects/:id 404 on unknown project', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/projects/00000000-0000-0000-0000-000000000000',
      payload: { goal: 'whatever' },
    });
    expect(res.statusCode).toBe(404);
  });

  describe('POST /api/projects/:id/init-repo', () => {
    const tmpDirs: string[] = [];
    afterEach(() => {
      for (const d of tmpDirs.splice(0)) {
        try {
          fs.rmSync(d, { recursive: true, force: true });
        } catch {
          /* ignore — Windows occasionally holds locks on .git index briefly */
        }
      }
    });

    async function createProjectWithRepo(repoPath: string): Promise<string> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'init-test', goal: 'cover init-repo endpoint', repoPath },
      });
      return res.json().id;
    }

    it('initializes a missing-git but existing dir, returns 201 + head sha', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-init-'));
      tmpDirs.push(dir);
      const id = await createProjectWithRepo(dir);
      const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/init-repo` });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.alreadyInitialized).toBe(false);
      expect(body.head).toMatch(/^[0-9a-f]{40}$/);
      expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
    });

    it('is idempotent on already-initialized repos', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-init-'));
      tmpDirs.push(dir);
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      execFileSync('git', ['init', '-b', 'main'], { cwd: dir, env, stdio: 'pipe' });
      const id = await createProjectWithRepo(dir);
      const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/init-repo` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, alreadyInitialized: true });
    });

    it('returns 400 when repoPath does not exist on disk', async () => {
      const dir = path.join(os.tmpdir(), `harness-missing-${Date.now()}`);
      const id = await createProjectWithRepo(dir);
      const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/init-repo` });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'repo_path_missing' });
    });

    it('creates the directory when createDir is passed', async () => {
      const dir = path.join(os.tmpdir(), `harness-createdir-${Date.now()}`);
      tmpDirs.push(dir);
      const id = await createProjectWithRepo(dir);
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${id}/init-repo`,
        payload: { createDir: true },
      });
      expect(res.statusCode).toBe(201);
      expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
    });

    it('returns 404 on unknown project id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/00000000-0000-0000-0000-000000000000/init-repo',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/projects/repo-status', () => {
    const tmpDirs: string[] = [];
    afterEach(() => {
      for (const d of tmpDirs.splice(0)) {
        try {
          fs.rmSync(d, { recursive: true, force: true });
        } catch {
          /* ignore — Windows occasionally holds locks on .git index briefly */
        }
      }
    });

    it('reports a git repo as exists + isGitRepo', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-status-'));
      tmpDirs.push(dir);
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      execFileSync('git', ['init', '-b', 'main'], { cwd: dir, env, stdio: 'pipe' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/repo-status',
        payload: { path: dir },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ exists: true, isGitRepo: true });
    });

    it('reports an existing non-git folder', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-status-'));
      tmpDirs.push(dir);
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/repo-status',
        payload: { path: dir },
      });
      expect(res.json()).toMatchObject({ exists: true, isGitRepo: false });
    });

    it('reports a missing path', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/repo-status',
        payload: { path: path.join(os.tmpdir(), `harness-nope-${Date.now()}`) },
      });
      expect(res.json()).toMatchObject({ exists: false, isGitRepo: false });
    });
  });
});
