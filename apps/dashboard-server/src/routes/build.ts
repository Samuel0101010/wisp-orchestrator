/**
 * build routes — Phase 7 (v1.15) native-packaging endpoints.
 *
 *   POST /api/projects/:projectId/build        — synchronously runs the packager
 *   GET  /api/projects/:projectId/build/status — last in-memory result + artifact path
 *   GET  /api/projects/:projectId/artifact     — streams the latest installer
 *
 * The route is intentionally synchronous: the packager pipeline runs end-to-
 * end inside the request, then the route persists `projects.artifact_path`.
 * Build runs can take 30s–5min in production; that's an acceptable trade-off
 * for v1 (no background worker, no extra schema). The UI shows a loading
 * state while the POST is in flight.
 *
 * `runPackager` is injected via the router factory so tests can substitute a
 * mock that never shells out.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  changeRequests as changeRequestsTable,
  plans as plansTable,
  projects as projectsTable,
  runs as runsTable,
} from '@wisp/schemas';
import { db } from '../db/index.js';
import { wrap } from './wrap.js';
import {
  runPackager as defaultRunPackager,
  type PackagerResult,
} from '../orchestrator/packager-runner.js';

export interface BuildRouterDeps {
  /** Test seam — production passes the real runPackager. */
  runPackager?: typeof defaultRunPackager;
}

/**
 * Cache of the most recent PackagerResult, keyed by projectId. Lost on
 * server restart — by design. The persistent state is `projects.artifact_path`.
 */
const lastBuildByProject = new Map<string, PackagerResult>();

const buildBodySchema = z
  .object({
    runId: z.string().min(1).optional(),
  })
  .optional();

export function createBuildRouter(deps: BuildRouterDeps = {}): FastifyPluginAsync {
  const runPackager = deps.runPackager ?? defaultRunPackager;

  const router: FastifyPluginAsync = async (app) => {
    app.post(
      '/api/projects/:projectId/build',
      wrap(async (req, reply) => {
        const params = z.object({ projectId: z.string().min(1) }).parse(req.params);
        const body = buildBodySchema.parse(req.body ?? {}) ?? {};

        const project = await db
          .select()
          .from(projectsTable)
          .where(eq(projectsTable.id, params.projectId))
          .get();
        if (!project) {
          reply.code(404);
          return { error: 'project not found' };
        }

        if (project.packageTarget === 'web') {
          reply.code(400);
          return {
            error: 'package_target_is_web',
            message:
              'Native packaging is disabled. Set packageTarget to a non-web value to enable.',
          };
        }

        // Find the source run. Default = latest successful run on this project.
        const planRows = await db
          .select({ id: plansTable.id })
          .from(plansTable)
          .where(eq(plansTable.projectId, params.projectId))
          .all();
        const planIds = planRows.map((p) => p.id);
        if (planIds.length === 0) {
          reply.code(400);
          return { error: 'no_runs', message: 'Project has no plans yet.' };
        }

        let sourceRun;
        if (body.runId) {
          sourceRun = await db.select().from(runsTable).where(eq(runsTable.id, body.runId)).get();
          if (!sourceRun || !planIds.includes(sourceRun.planId)) {
            reply.code(404);
            return { error: 'run not found' };
          }
          if (sourceRun.outcome !== 'success') {
            reply.code(400);
            return {
              error: 'run_not_successful',
              actual: sourceRun.outcome,
            };
          }
        } else {
          const all = await db
            .select()
            .from(runsTable)
            .where(eq(runsTable.outcome, 'success'))
            .orderBy(desc(runsTable.endedAt))
            .all();
          sourceRun = all.find((r) => planIds.includes(r.planId));
          if (!sourceRun) {
            reply.code(400);
            return {
              error: 'no_successful_run',
              message: 'No successful run available to build from.',
            };
          }
        }

        // Block if there are pending change-requests — the user should land
        // those iterations into a new successful run before packaging.
        const pending = await db
          .select({ id: changeRequestsTable.id })
          .from(changeRequestsTable)
          .where(
            and(
              eq(changeRequestsTable.projectId, params.projectId),
              eq(changeRequestsTable.status, 'pending'),
            ),
          )
          .all();
        if (pending.length > 0) {
          reply.code(409);
          return {
            error: 'pending_change_requests',
            pendingCount: pending.length,
            message: 'Resolve or run pending change-requests before building.',
          };
        }

        const result = await runPackager({
          projectId: params.projectId,
          runId: sourceRun.id,
          repoPath: project.repoPath,
          packageTarget: project.packageTarget,
          appName: project.name,
        });

        lastBuildByProject.set(params.projectId, result);

        if (!result.ok) {
          reply.code(422);
          return result;
        }

        // Persist the artifact path on success.
        await db
          .update(projectsTable)
          .set({ artifactPath: result.artifactPath })
          .where(eq(projectsTable.id, params.projectId))
          .run();

        reply.code(200);
        return result;
      }),
    );

    app.get(
      '/api/projects/:projectId/build/status',
      wrap(async (req, reply) => {
        const params = z.object({ projectId: z.string().min(1) }).parse(req.params);
        const project = await db
          .select()
          .from(projectsTable)
          .where(eq(projectsTable.id, params.projectId))
          .get();
        if (!project) {
          reply.code(404);
          return { error: 'project not found' };
        }
        return {
          artifactPath: project.artifactPath,
          packageTarget: project.packageTarget,
          recentBuild: lastBuildByProject.get(params.projectId) ?? null,
        };
      }),
    );

    app.get(
      '/api/projects/:projectId/artifact',
      wrap(async (req, reply) => {
        const params = z.object({ projectId: z.string().min(1) }).parse(req.params);
        const project = await db
          .select()
          .from(projectsTable)
          .where(eq(projectsTable.id, params.projectId))
          .get();
        if (!project) {
          reply.code(404);
          return { error: 'project not found' };
        }
        const artifactPath = project.artifactPath;
        if (!artifactPath || !fs.existsSync(artifactPath)) {
          reply.code(404);
          return { error: 'artifact not found' };
        }
        const basename = path.basename(artifactPath);
        reply
          .header('Content-Type', 'application/octet-stream')
          .header('Content-Disposition', `attachment; filename="${basename}"`);
        return reply.send(fs.createReadStream(artifactPath));
      }),
    );
  };
  return router;
}

/** Test-only escape hatch — clear the in-memory cache between tests. */
export function _resetBuildCache(): void {
  lastBuildByProject.clear();
}

export const buildRoutes: FastifyPluginAsync = createBuildRouter();
