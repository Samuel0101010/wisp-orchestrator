import './setup.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../db/migrate.js';
import { db, sqlite } from '../db/index.js';
import { projects } from '@wisp/schemas';
import {
  PreviewProcessRegistry,
  type StartPreviewArgs,
  type StartPreviewResult,
} from '../orchestrator/preview-server.js';
import type { ProjectDetection } from '../orchestrator/detect-project-type.js';
import { createPreviewRouter, type PreviewRouterDeps } from '../routes/preview.js';

/**
 * Coverage for the preview ROUTE handlers in src/routes/preview.ts via
 * app.inject — exercising the start-route's branch logic (404 / no-dev-cmd /
 * worktree-setup-failed / running-short-circuit / --base framework gating).
 *
 * NOT covered here: the reverse-proxy (HTTP/WS) and ensurePreviewWorktree
 * internals — those live in preview-server.test.ts and preview-ws.test.ts.
 *
 * We register the router directly (not via buildApp) so we can inject the
 * detectProjectType / ensurePreviewWorktree / registry seams the factory
 * exposes. The `db` is the real per-test temp SQLite; projects are seeded by
 * direct drizzle insert so the route's project-existence pre-check passes.
 */

/** Build a fresh Fastify app wired to the given router deps. */
async function buildPreviewApp(deps: PreviewRouterDeps): Promise<FastifyInstance> {
  const app = Fastify();
  // The router hangs a `wsHandler` on its GET proxy route, which requires the
  // websocket plugin to be registered or Fastify's onRoute hook throws.
  await app.register(websocket);
  await app.register(createPreviewRouter(deps));
  await app.ready();
  return app;
}

/** A ProjectDetection for a given framework + dev command. */
function detection(
  framework: string | null,
  devCommand: string | null,
  probeUrl: string | null,
): ProjectDetection {
  return {
    type: framework ? 'web-app' : 'unknown',
    devCommand,
    probeUrl,
    reason: 'test stub',
    framework,
  };
}

/** A running StartPreviewResult the spawn seam can return. */
function runningResult(port: number): StartPreviewResult {
  return { status: 'running', port, pid: 4242, startedAt: Date.now() };
}

/** Insert a project row so the route's existence pre-check passes. */
async function seedProject(opts: {
  id: string;
  repoPath?: string;
  devCmd?: string | null;
  probeUrl?: string | null;
}): Promise<void> {
  await db
    .insert(projects)
    .values({
      id: opts.id,
      name: 'preview-routes-test',
      goal: 'g',
      repoPath: opts.repoPath ?? '/tmp/preview-routes',
      createdAt: new Date(),
      runtimeVerifyDevCmd: opts.devCmd ?? null,
      runtimeVerifyProbeUrl: opts.probeUrl ?? null,
    })
    .run();
}

let app: FastifyInstance | undefined;

beforeAll(() => {
  runMigrations();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

afterAll(() => {
  sqlite.close();
});

describe('POST /api/projects/:id/preview/start', () => {
  it('404s when the project does not exist', async () => {
    const registry = new PreviewProcessRegistry();
    const ensureWt = vi.fn();
    const detectFn = vi.fn();
    app = await buildPreviewApp({
      registry,
      ensurePreviewWorktree: ensureWt as unknown as PreviewRouterDeps['ensurePreviewWorktree'],
      detectProjectType: detectFn as unknown as PreviewRouterDeps['detectProjectType'],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/no-such-project/preview/start',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'project not found' });
    // We short-circuit before touching the worktree or detector.
    expect(ensureWt).not.toHaveBeenCalled();
    expect(detectFn).not.toHaveBeenCalled();
  });

  it('400 no_dev_cmd when detection yields no dev command and the project configures none', async () => {
    const id = `proj-${randomUUID()}`;
    await seedProject({ id, devCmd: null, probeUrl: null });

    const registry = new PreviewProcessRegistry();
    const startSpy = vi.spyOn(registry, 'startPreview');
    const ensureWt = vi.fn().mockResolvedValue('/tmp/preview-routes/.wt');
    // Detection returns a library-like result: no framework, no dev command.
    const detectFn = vi.fn().mockReturnValue(detection(null, null, null));

    app = await buildPreviewApp({
      registry,
      ensurePreviewWorktree: ensureWt as unknown as PreviewRouterDeps['ensurePreviewWorktree'],
      detectProjectType: detectFn as unknown as PreviewRouterDeps['detectProjectType'],
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/preview/start`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('no_dev_cmd');
    // The worktree was resolved and detection ran against it, but we never
    // reached the spawn because there is no command to run.
    expect(ensureWt).toHaveBeenCalledTimes(1);
    expect(detectFn).toHaveBeenCalledWith('/tmp/preview-routes/.wt');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('500 worktree_setup_failed when ensurePreviewWorktree throws', async () => {
    const id = `proj-${randomUUID()}`;
    await seedProject({ id });

    const registry = new PreviewProcessRegistry();
    const startSpy = vi.spyOn(registry, 'startPreview');
    const ensureWt = vi.fn().mockRejectedValue(new Error('git worktree add exploded'));
    const detectFn = vi.fn();

    app = await buildPreviewApp({
      registry,
      ensurePreviewWorktree: ensureWt as unknown as PreviewRouterDeps['ensurePreviewWorktree'],
      detectProjectType: detectFn as unknown as PreviewRouterDeps['detectProjectType'],
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/preview/start`,
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe('worktree_setup_failed');
    expect(body.detail).toContain('git worktree add exploded');
    // Detection + spawn are unreachable once the worktree setup fails.
    expect(detectFn).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('short-circuits to the SAME running instance without re-resolving the worktree', async () => {
    const id = `proj-${randomUUID()}`;
    await seedProject({ id });

    const registry = new PreviewProcessRegistry();
    // Simulate an already-running preview on a known port. Use this test
    // process's own pid so the route's internal `getPreviewStatus` liveness
    // probe (real `pidAlive`, no override) reports the entry as still running.
    registry.__test_register({ projectId: id, port: 5199, pid: process.pid });

    const startSpy = vi.spyOn(registry, 'startPreview');
    const ensureWt = vi.fn().mockResolvedValue('/tmp/preview-routes/.wt');
    const detectFn = vi.fn();

    app = await buildPreviewApp({
      registry,
      ensurePreviewWorktree: ensureWt as unknown as PreviewRouterDeps['ensurePreviewWorktree'],
      detectProjectType: detectFn as unknown as PreviewRouterDeps['detectProjectType'],
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/preview/start`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('running');
    expect(body.port).toBe(5199);
    expect(body.pid).toBe(process.pid);
    // The whole point of the short-circuit: the live worktree is NOT touched
    // (no git reset --hard on a running dev server), and no second spawn.
    expect(ensureWt).not.toHaveBeenCalled();
    expect(detectFn).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/projects/:id/preview/start — BASE_FLAG_FRAMEWORKS gating', () => {
  /**
   * Run a start against a project whose detection reports `framework`, and
   * return the StartPreviewArgs the spawn seam received. The spawn seam is the
   * registry's `startPreview`, stubbed to report running so the route returns
   * cleanly without polling a real dev server.
   */
  async function startWithFramework(framework: string): Promise<StartPreviewArgs> {
    const id = `proj-${randomUUID()}`;
    await seedProject({ id });

    const registry = new PreviewProcessRegistry();
    const startSpy = vi
      .spyOn(registry, 'startPreview')
      .mockImplementation(async () => runningResult(5173));
    const ensureWt = vi.fn().mockResolvedValue('/tmp/preview-routes/.wt');
    const detectFn = vi
      .fn()
      .mockReturnValue(detection(framework, 'pnpm dev', 'http://127.0.0.1:5173/'));

    app = await buildPreviewApp({
      registry,
      ensurePreviewWorktree: ensureWt as unknown as PreviewRouterDeps['ensurePreviewWorktree'],
      detectProjectType: detectFn as unknown as PreviewRouterDeps['detectProjectType'],
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/preview/start`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('running');
    expect(startSpy).toHaveBeenCalledTimes(1);
    return startSpy.mock.calls[0]![0] as StartPreviewArgs;
  }

  it('vite gets --base /preview/<id>/ forwarded as basePath', async () => {
    const args = await startWithFramework('vite');
    expect(args.basePath).toMatch(/^\/preview\/proj-[\w-]+\/$/);
    expect(args.basePath).toBe(`/preview/${args.projectId}/`);
  });

  it('@sveltejs/kit gets --base /preview/<id>/ forwarded as basePath', async () => {
    const args = await startWithFramework('@sveltejs/kit');
    expect(args.basePath).toBe(`/preview/${args.projectId}/`);
  });

  it('next does NOT receive a basePath (would crash on the unknown flag)', async () => {
    const args = await startWithFramework('next');
    expect(args.basePath).toBeUndefined();
  });

  it('nuxt does NOT receive a basePath', async () => {
    const args = await startWithFramework('nuxt');
    expect(args.basePath).toBeUndefined();
  });

  it('passes the resolved cwd + detection dev command through to the spawn seam', async () => {
    const args = await startWithFramework('vite');
    expect(args.cwd).toBe('/tmp/preview-routes/.wt');
    expect(args.devCmd).toBe('pnpm dev');
    expect(args.probeUrl).toBe('http://127.0.0.1:5173/');
  });
});
