import './setup.js';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { eq } from 'drizzle-orm';
import {
  changeRequests as changeRequestsTable,
  plans as plansTable,
  projects as projectsTable,
  runs as runsTable,
} from '@agent-harness/schemas';
import { projectRoutes } from '../routes/projects.js';
import { createBuildRouter, _resetBuildCache } from '../routes/build.js';
import { runMigrations } from '../db/migrate.js';
import { db, sqlite } from '../db/index.js';
import type { PackagerResult } from '../orchestrator/packager-runner.js';

interface MockCall {
  projectId: string;
  runId: string;
}

function makeFakePackager(result: PackagerResult, capture: MockCall[] = []) {
  return async (args: { projectId: string; runId: string }): Promise<PackagerResult> => {
    capture.push({ projectId: args.projectId, runId: args.runId });
    return result;
  };
}

async function buildAppWith(
  runPackager: ReturnType<typeof makeFakePackager>,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors);
  await app.register(projectRoutes);
  await app.register(createBuildRouter({ runPackager }));
  return app;
}

async function seedProject(opts: { packageTarget?: 'web' | 'tauri-exe' } = {}): Promise<string> {
  const projectId = randomUUID();
  await db
    .insert(projectsTable)
    .values({
      id: projectId,
      name: 'build-test',
      goal: 'g',
      repoPath: '/tmp/x',
      createdAt: new Date(),
      packageTarget: opts.packageTarget ?? 'tauri-exe',
    })
    .run();
  return projectId;
}

async function seedSuccessfulRun(projectId: string): Promise<{ runId: string; planId: string }> {
  const planId = randomUUID();
  await db
    .insert(plansTable)
    .values({
      id: planId,
      projectId,
      dagJson: { goal: 'g', team: {}, nodes: [], edges: [] } as unknown,
      status: 'done',
    })
    .run();
  const runId = randomUUID();
  await db
    .insert(runsTable)
    .values({
      id: runId,
      planId,
      status: 'completed',
      outcome: 'success',
      startedAt: new Date(Date.now() - 60_000),
      endedAt: new Date(),
      budgetMinutes: 120,
      budgetTurns: 500,
      maxParallel: 2,
    })
    .run();
  return { runId, planId };
}

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  sqlite.close();
});

describe('build routes', () => {
  let app: FastifyInstance | null = null;

  beforeEach(() => {
    _resetBuildCache();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('POST /build returns 404 when project missing', async () => {
    app = await buildAppWith(makeFakePackager({} as PackagerResult));
    const r = await app.inject({ method: 'POST', url: '/api/projects/does-not-exist/build' });
    expect(r.statusCode).toBe(404);
  });

  it('POST /build returns 400 when packageTarget=web', async () => {
    app = await buildAppWith(makeFakePackager({} as PackagerResult));
    const projectId = await seedProject({ packageTarget: 'web' });
    const r = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/build` });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('package_target_is_web');
  });

  it('POST /build returns 400 when no successful run exists', async () => {
    app = await buildAppWith(makeFakePackager({} as PackagerResult));
    const projectId = await seedProject();
    const r = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/build` });
    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(['no_runs', 'no_successful_run']).toContain(body.error);
  });

  it('POST /build happy path: calls packager and persists artifactPath', async () => {
    const capture: MockCall[] = [];
    const fakeResult: PackagerResult = {
      ok: true,
      artifactPath: '/data/artifacts/p/r/demo.msi',
      relativeBuildPath: 'src-tauri/target/release/bundle/msi/demo.msi',
      sizeBytes: 12345,
      sha256: 'a'.repeat(64),
      buildLog: 'ok',
      durationMs: 100,
    };
    app = await buildAppWith(makeFakePackager(fakeResult, capture));
    const projectId = await seedProject();
    const { runId } = await seedSuccessfulRun(projectId);

    const r = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/build` });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.ok).toBe(true);
    expect(body.artifactPath).toBe(fakeResult.artifactPath);
    expect(capture).toHaveLength(1);
    expect(capture[0].projectId).toBe(projectId);
    expect(capture[0].runId).toBe(runId);

    // Project row should now carry artifactPath.
    const proj = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get();
    expect(proj?.artifactPath).toBe(fakeResult.artifactPath);
  });

  it('POST /build returns 422 when packager fails (e.g. tauri_cli_missing)', async () => {
    const fakeResult: PackagerResult = {
      ok: false,
      artifactPath: null,
      relativeBuildPath: null,
      sizeBytes: null,
      sha256: null,
      error: 'tauri_cli_missing',
      buildLog: 'command not found',
      durationMs: 5,
    };
    app = await buildAppWith(makeFakePackager(fakeResult));
    const projectId = await seedProject();
    await seedSuccessfulRun(projectId);

    const r = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/build` });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe('tauri_cli_missing');
  });

  it('POST /build returns 409 when pending change-requests exist', async () => {
    app = await buildAppWith(makeFakePackager({} as PackagerResult));
    const projectId = await seedProject();
    await seedSuccessfulRun(projectId);
    await db
      .insert(changeRequestsTable)
      .values({
        id: randomUUID(),
        projectId,
        source: 'text',
        userPrompt: 'Add dark mode',
        status: 'pending',
        createdAt: new Date(),
      })
      .run();
    const r = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/build` });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('pending_change_requests');
  });

  it('GET /build/status returns current artifactPath + packageTarget', async () => {
    app = await buildAppWith(makeFakePackager({} as PackagerResult));
    const projectId = await seedProject();
    const r = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/build/status` });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.packageTarget).toBe('tauri-exe');
    expect(body.artifactPath).toBeNull();
    expect(body.recentBuild).toBeNull();
  });

  it('GET /artifact returns 404 when no artifact is set', async () => {
    app = await buildAppWith(makeFakePackager({} as PackagerResult));
    const projectId = await seedProject();
    const r = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/artifact` });
    expect(r.statusCode).toBe(404);
  });
});
