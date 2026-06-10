import fs from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  changeRequests as changeRequestsTable,
  plans,
  projects,
  projectStates,
  runs,
} from '@wisp/schemas';
import { db } from '../db/index.js';
import { wrap } from './wrap.js';
import { defaultRunner, type Runner } from '../orchestrator/planner-runner.js';
import { generateAndPersistPlan } from '../orchestrator/plan-generation.js';
import { getLatestProjectState } from '../orchestrator/project-state-loader.js';
import type { RunRuntime } from '../orchestrator/runtime.js';
import { getDefaultRuntime } from './runs.js';

/**
 * One-shot iteration endpoint (P2 Lane A).
 *
 * POST /api/projects/:projectId/iterations collapses the fragile client-driven
 * 3-step iteration flow (generate plan → lock → start run) into a single
 * server-side transaction-ish sequence: generate + persist a LOCKED iteration
 * plan via the shared plan-generation pipeline, then start the run, then link
 * the consumed change-requests. Failure semantics:
 *   - plan generation fails → zero plan rows inserted, CRs stay 'pending'
 *   - run start fails → the plan row is demoted to 'draft', CRs stay 'pending'
 *   - CR linking fails → non-fatal (run already started), count reported as 0
 */

export interface IterationsRouterDeps {
  runner?: Runner;
  runtime?: RunRuntime;
}

const iterationBodySchema = z.object({
  changeRequestIds: z.array(z.string().min(1)).optional(),
});

export function createIterationsRouter(deps: IterationsRouterDeps = {}): FastifyPluginAsync {
  const runner: Runner = deps.runner ?? defaultRunner();

  const router: FastifyPluginAsync = async (app) => {
    // Deferred to the router body (mirrors createRunsRouter): the default
    // runtime singleton must not be constructed before routes/index.ts has
    // wired the skill registry.
    const runtime = deps.runtime ?? getDefaultRuntime();

    app.post(
      '/api/projects/:projectId/iterations',
      wrap(async (req, reply) => {
        const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);
        const body = iterationBodySchema.parse(req.body ?? {});

        const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!project) {
          reply.code(404);
          return { error: 'project_not_found' };
        }

        // Iterations build on a prior verified run — without a project-state
        // snapshot there is nothing to iterate against (use POST /plan for the
        // initial build).
        const latestState = await getLatestProjectState(db, projectId);
        if (!latestState) {
          reply.code(409);
          return {
            error: 'no_prior_state',
            message:
              'No prior project state exists for this project. Run an initial build first; iterations plan deltas against a verified run.',
          };
        }

        // Preflight: refuse to start an iteration if the project's repoPath
        // isn't a git repo (mirrors the POST /api/runs preflight). Without
        // this, the first task fails with a cryptic `git worktree add ...
        // fatal: not a git repository` and the run-state machine
        // cancel-cascades every remaining task.
        const dotGit = path.join(project.repoPath, '.git');
        if (!fs.existsSync(dotGit)) {
          reply.code(400);
          return {
            error: 'repo_not_initialized',
            projectId: project.id,
            repoPath: project.repoPath,
            repoPathExists: fs.existsSync(project.repoPath),
            hint: 'POST /api/projects/:id/init-repo to auto-init, or run `git init` manually.',
          };
        }

        // absent / [] → consume ALL pending change-requests for the project.
        const changeRequestIds =
          body.changeRequestIds && body.changeRequestIds.length > 0 ? body.changeRequestIds : null;

        const outcome = await generateAndPersistPlan({
          projectId,
          runner,
          changeRequestIds,
          allowUnbriefed: true,
          persistStatus: 'locked',
        });
        if (!outcome.ok) {
          // Failed plan-gen inserted zero rows; CRs stay pending.
          reply.code(outcome.status);
          return outcome.body;
        }
        const planId = outcome.planRow.id;

        // Resolve the parent run back-pointer exactly like POST /api/runs:
        // iteration plans point at the project_states row they were built
        // against; that state row knows the run that produced it. We
        // deliberately do NOT touch chainIteration — that column is owned
        // exclusively by the self-healing chain as its cap counter and MUST
        // stay 0 for user-launched runs.
        let parentRunId: string | undefined;
        if (outcome.planRow.kind === 'iteration' && outcome.planRow.parentStateId) {
          const parentState = await db
            .select({ runId: projectStates.runId })
            .from(projectStates)
            .where(eq(projectStates.id, outcome.planRow.parentStateId))
            .get();
          if (parentState?.runId) {
            const priorRun = await db
              .select({ id: runs.id })
              .from(runs)
              .where(eq(runs.id, parentState.runId))
              .get();
            if (priorRun) {
              parentRunId = priorRun.id;
            }
          }
        }

        let result: Awaited<ReturnType<RunRuntime['startRun']>>;
        try {
          result = await runtime.startRun({
            planId,
            ...(parentRunId ? { parentRunId } : {}),
          });
        } catch (err) {
          // startRun threw instead of returning {ok:false} — same contract as
          // the structured-failure path: best-effort demote (an orphan locked
          // plan must not survive), then 502. CRs were never linked.
          try {
            await db.update(plans).set({ status: 'draft' }).where(eq(plans.id, planId)).run();
          } catch (demoteErr) {
            console.error('[iterations] failed to demote plan after startRun threw', demoteErr);
          }
          reply.code(502);
          return { error: 'run_start_failed', planId, runStartError: String(err) };
        }
        if (!result.ok) {
          // Demote the just-locked plan back to draft so it can be inspected /
          // re-launched; the CRs were never linked, so they stay pending.
          await db.update(plans).set({ status: 'draft' }).where(eq(plans.id, planId)).run();
          if (result.status === 409 && result.error === 'run_already_active') {
            // Another run is already active for this project. The iteration
            // run never started, so the plan was demoted above for a clean
            // retry (CRs stay pending) — but pass the 409 through instead of
            // masking it as a generic 502 so the UI can tell the user to wait
            // for the active run.
            reply.code(409);
            return {
              error: 'run_already_active',
              planId,
              ...(result.details ? { details: result.details } : {}),
            };
          }
          reply.code(502);
          return { error: 'run_start_failed', planId, runStartError: result.error };
        }

        // Link the consumed change_requests to this run (mirrors POST
        // /api/runs). Done POST-startRun so a failed start doesn't lock the
        // queue. The filter (projectId match + status='pending') is enforced
        // server-side; a link failure is non-fatal — the run is already going.
        let linkedChangeRequestCount = 0;
        if (outcome.pendingChangeRequestIds.length > 0) {
          try {
            const candidates = await db
              .select({
                id: changeRequestsTable.id,
                projectId: changeRequestsTable.projectId,
                status: changeRequestsTable.status,
              })
              .from(changeRequestsTable)
              .where(inArray(changeRequestsTable.id, outcome.pendingChangeRequestIds))
              .all();
            const eligible = candidates
              .filter((c) => c.projectId === projectId && c.status === 'pending')
              .map((c) => c.id);
            if (eligible.length > 0) {
              await db
                .update(changeRequestsTable)
                .set({ status: 'in-run', runId: result.runId })
                .where(inArray(changeRequestsTable.id, eligible))
                .run();
              linkedChangeRequestCount = eligible.length;
            }
          } catch (err) {
            console.error('[iterations] failed to link change_requests', err);
          }
        }

        reply.code(201);
        return { planId, runId: result.runId, linkedChangeRequestCount };
      }),
    );
  };

  return router;
}

export const iterationRoutes: FastifyPluginAsync = createIterationsRouter();
