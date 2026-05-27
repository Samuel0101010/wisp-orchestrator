import fs from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  changeRequests as changeRequestsTable,
  checkpoints,
  events as eventsTable,
  plans,
  projects,
  runs,
  tasks,
} from '@wisp/schemas';
import { db } from '../db/index.js';
import { env } from '../env.js';
import { wrap } from './wrap.js';
import { publishToRun } from '../ws.js';
import { DEFAULT_AUTOPILOT_BUDGET_TOKENS, RunRuntime } from '../orchestrator/runtime.js';
import { makeMockRunner } from '../orchestrator/mock-runner.js';
import { findResumableRuns } from '../orchestrator/recovery.js';

export interface RunsRouterDeps {
  runtime?: RunRuntime;
}

const startRunSchema = z.object({
  planId: z.string().min(1),
  budgetMinutes: z.number().int().positive().optional(),
  budgetTurns: z.number().int().positive().optional(),
  maxParallel: z.number().int().positive().optional(),
  // v1.10 — optional list of change_request rows to mark as 'in-run' and
  // link to this new run. Used when the iteration planner consumed a
  // specific subset of pending change-requests; the UI passes the same
  // ids here so the queue stays in sync. Silently ignores ids that
  // belong to another project or aren't in 'pending' status.
  changeRequestIds: z.array(z.string().min(1)).optional(),
});

let defaultRuntime: RunRuntime | null = null;
let _runtimeSkillRegistry: import('../skills/registry.js').SkillRegistry | null = null;

/**
 * Set the SkillRegistry the default runtime will be constructed with. Must be
 * called BEFORE the first `defaultRuntimeInstance()` call (i.e. before the
 * runs router is registered on the Fastify app); we cannot retroactively
 * change the readonly field on an already-constructed RunRuntime.
 */
export function setRuntimeSkillRegistry(reg: import('../skills/registry.js').SkillRegistry): void {
  _runtimeSkillRegistry = reg;
}

function defaultRuntimeInstance(): RunRuntime {
  if (!defaultRuntime) {
    defaultRuntime = new RunRuntime({
      db,
      ws: { publishToRun },
      runner: env.WISP_MOCK_CLI ? makeMockRunner() : undefined,
      skillRegistry: _runtimeSkillRegistry ?? undefined,
    });
  }
  return defaultRuntime;
}

/** Exposed so server.ts can call pauseAllForShutdown() on the live runtime. */
export function getDefaultRuntime(): RunRuntime {
  return defaultRuntimeInstance();
}

export function createRunsRouter(deps: RunsRouterDeps = {}): FastifyPluginAsync {
  // Deferred to the async router body so callers (routes/index.ts) can set
  // the skill registry via setRuntimeSkillRegistry() before the runtime is
  // first instantiated. If resolved here at module load, the runtime would
  // be built before any wiring in routes/index.ts had a chance to run.
  const router: FastifyPluginAsync = async (app) => {
    const runtime = deps.runtime ?? defaultRuntimeInstance();
    app.get(
      '/api/runs/daily-count',
      wrap(async () => {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const rows = await db
          .select({ projectId: plans.projectId })
          .from(runs)
          .innerJoin(plans, eq(runs.planId, plans.id))
          .where(gte(runs.startedAt, cutoff))
          .all();
        const byProject: Record<string, number> = {};
        for (const r of rows) {
          byProject[r.projectId] = (byProject[r.projectId] ?? 0) + 1;
        }
        return { totalLast24h: rows.length, byProject };
      }),
    );

    app.get(
      '/api/runs',
      wrap(async (req) => {
        const query = z
          .object({
            resumable: z
              .union([z.literal('true'), z.literal('false'), z.boolean()])
              .optional()
              .transform((v) => v === true || v === 'true'),
            include: z.enum(['project']).optional(),
            limit: z.coerce.number().int().min(1).max(500).optional().default(50),
          })
          .parse(req.query ?? {});

        if (query.resumable) {
          const resumable = await findResumableRuns(db);
          return { runs: resumable };
        }

        if (query.include === 'project') {
          // Mission Control: every run row carries its project name + id so the
          // global runs table can render across projects without N+1 lookups.
          const rows = await db
            .select({
              id: runs.id,
              planId: runs.planId,
              status: runs.status,
              outcome: runs.outcome,
              startedAt: runs.startedAt,
              endedAt: runs.endedAt,
              budgetMinutes: runs.budgetMinutes,
              budgetTurns: runs.budgetTurns,
              tokensInTotal: runs.tokensInTotal,
              tokensOutTotal: runs.tokensOutTotal,
              turnsTotal: runs.turnsTotal,
              pausedReason: runs.pausedReason,
              resumeAt: runs.resumeAt,
              projectId: projects.id,
              projectName: projects.name,
            })
            .from(runs)
            .innerJoin(plans, eq(runs.planId, plans.id))
            .innerJoin(projects, eq(plans.projectId, projects.id))
            .orderBy(desc(runs.startedAt))
            .limit(query.limit)
            .all();
          return { runs: rows };
        }

        const all = await db
          .select()
          .from(runs)
          .orderBy(desc(runs.startedAt))
          .limit(query.limit)
          .all();
        return { runs: all };
      }),
    );

    app.get(
      '/api/runs/summary',
      wrap(async (req) => {
        const query = z
          .object({
            windowDays: z.coerce.number().int().min(1).max(90).optional().default(7),
          })
          .parse(req.query ?? {});

        const now = Date.now();
        const cutoff = new Date(now - query.windowDays * 24 * 60 * 60 * 1000);

        // Single windowed scan — every aggregation downstream derives from these
        // rows so we never re-query the table per chart.
        const rows = await db
          .select({
            id: runs.id,
            status: runs.status,
            outcome: runs.outcome,
            startedAt: runs.startedAt,
            endedAt: runs.endedAt,
            tokensInTotal: runs.tokensInTotal,
            tokensOutTotal: runs.tokensOutTotal,
            projectId: projects.id,
            projectName: projects.name,
          })
          .from(runs)
          .innerJoin(plans, eq(runs.planId, plans.id))
          .innerJoin(projects, eq(plans.projectId, projects.id))
          .where(gte(runs.startedAt, cutoff))
          .orderBy(desc(runs.startedAt))
          .all();

        let activeCount = 0;
        const outcomeCounts: Record<string, number> = {
          success: 0,
          failure: 0,
          cancelled: 0,
          unknown: 0,
        };
        let totalTokens = 0;
        let completedDurationMs = 0;
        let completedCount = 0;
        const tokensByDay = new Map<string, number>();
        const runsByDay = new Map<string, number>();

        // Pre-seed days so the chart shows zero-buckets instead of gaps.
        for (let i = query.windowDays - 1; i >= 0; i--) {
          const d = new Date(now - i * 24 * 60 * 60 * 1000);
          const key = d.toISOString().slice(0, 10);
          tokensByDay.set(key, 0);
          runsByDay.set(key, 0);
        }

        for (const r of rows) {
          if (r.status === 'running' || r.status === 'paused') activeCount++;
          const tin = r.tokensInTotal ?? 0;
          const tout = r.tokensOutTotal ?? 0;
          const t = tin + tout;
          totalTokens += t;
          if (r.outcome) {
            outcomeCounts[r.outcome] = (outcomeCounts[r.outcome] ?? 0) + 1;
          }
          if (r.endedAt && r.startedAt) {
            const dur = r.endedAt.getTime() - r.startedAt.getTime();
            if (dur > 0) {
              completedDurationMs += dur;
              completedCount++;
            }
          }
          if (r.startedAt) {
            const key = r.startedAt.toISOString().slice(0, 10);
            tokensByDay.set(key, (tokensByDay.get(key) ?? 0) + t);
            runsByDay.set(key, (runsByDay.get(key) ?? 0) + 1);
          }
        }

        return {
          windowDays: query.windowDays,
          activeCount,
          totalRuns: rows.length,
          totalTokens,
          successRate:
            rows.length > 0 ? (outcomeCounts.success ?? 0) / Math.max(1, rows.length) : 0,
          avgDurationMs: completedCount > 0 ? completedDurationMs / completedCount : 0,
          outcomeCounts,
          tokensByDay: Array.from(tokensByDay, ([day, tokens]) => ({ day, tokens })),
          runsByDay: Array.from(runsByDay, ([day, runs]) => ({ day, runs })),
        };
      }),
    );

    app.post(
      '/api/runs',
      wrap(async (req, reply) => {
        const body = startRunSchema.parse(req.body ?? {});

        // Preflight: refuse to start a run if the project's repoPath isn't a
        // git repo. Without this, the first task fails with a cryptic
        // `git worktree add ... fatal: not a git repository` and the run-state
        // machine cancel-cascades every remaining task. The client gets a
        // structured error code so the UI can offer an Initialize button.
        const planRow = await db
          .select({ projectId: plans.projectId })
          .from(plans)
          .where(eq(plans.id, body.planId))
          .get();
        if (planRow) {
          const projectRow = await db
            .select({ id: projects.id, repoPath: projects.repoPath })
            .from(projects)
            .where(eq(projects.id, planRow.projectId))
            .get();
          if (projectRow) {
            const dotGit = path.join(projectRow.repoPath, '.git');
            if (!fs.existsSync(dotGit)) {
              reply.code(400);
              return {
                error: 'repo_not_initialized',
                projectId: projectRow.id,
                repoPath: projectRow.repoPath,
                repoPathExists: fs.existsSync(projectRow.repoPath),
                hint: 'POST /api/projects/:id/init-repo to auto-init, or run `git init` manually.',
              };
            }
          }
        }

        const result = await runtime.startRun(body);
        if (!result.ok) {
          reply.code(result.status);
          return { error: result.error, ...(result.details ? { details: result.details } : {}) };
        }

        // v1.10 — link the requested change_requests to this run. We do this
        // POST-startRun so a failed startRun doesn't lock the queue. The
        // filter (projectId match + status='pending') is enforced server-
        // side so a malicious client cannot mutate other projects' rows.
        let linkedChangeRequestCount = 0;
        if (body.changeRequestIds && body.changeRequestIds.length > 0 && planRow) {
          try {
            const candidates = await db
              .select({
                id: changeRequestsTable.id,
                projectId: changeRequestsTable.projectId,
                status: changeRequestsTable.status,
              })
              .from(changeRequestsTable)
              .where(inArray(changeRequestsTable.id, body.changeRequestIds))
              .all();
            const eligible = candidates
              .filter((c) => c.projectId === planRow.projectId && c.status === 'pending')
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
            // Don't fail the run because the link failed — the run is
            // already started. Log and continue.
            console.error('[runs] failed to link change_requests', err);
          }
        }

        reply.code(201);
        return {
          runId: result.runId,
          ...(linkedChangeRequestCount > 0 ? { linkedChangeRequestCount } : {}),
        };
      }),
    );

    app.get(
      '/api/runs/:runId',
      wrap(async (req, reply) => {
        const { runId } = z.object({ runId: z.string().min(1) }).parse(req.params);
        const run = await db.select().from(runs).where(eq(runs.id, runId)).get();
        if (!run) {
          reply.code(404);
          return { error: 'run not found' };
        }
        const taskRows = await db.select().from(tasks).where(eq(tasks.planId, run.planId)).all();
        const lastCheckpoint = await db
          .select()
          .from(checkpoints)
          .where(eq(checkpoints.runId, runId))
          .orderBy(desc(checkpoints.ts))
          .get();
        return { run, tasks: taskRows, lastCheckpoint: lastCheckpoint ?? null };
      }),
    );

    app.get(
      '/api/runs/:runId/events',
      wrap(async (req, reply) => {
        const { runId } = z.object({ runId: z.string().min(1) }).parse(req.params);
        const query = z
          .object({
            limit: z.coerce.number().int().min(1).max(2000).optional().default(500),
            type: z.string().optional(),
          })
          .parse(req.query ?? {});

        const run = await db.select().from(runs).where(eq(runs.id, runId)).get();
        if (!run) {
          reply.code(404);
          return { error: 'run not found' };
        }

        const q = db
          .select()
          .from(eventsTable)
          .where(
            query.type
              ? and(eq(eventsTable.runId, runId), eq(eventsTable.type, query.type))
              : eq(eventsTable.runId, runId),
          )
          .orderBy(desc(eventsTable.ts))
          .limit(query.limit);
        const rows = await q.all();
        // Reverse so oldest first (timeline order).
        rows.reverse();
        return { events: rows };
      }),
    );

    app.post(
      '/api/runs/:runId/pause',
      wrap(async (req, reply) => {
        const { runId } = z.object({ runId: z.string().min(1) }).parse(req.params);
        const result = await runtime.pauseRun(runId);
        if (!result.ok) {
          reply.code(result.status);
          return { error: result.error };
        }
        const updated = await db.select().from(runs).where(eq(runs.id, runId)).get();
        return updated;
      }),
    );

    app.post(
      '/api/runs/:runId/resume',
      wrap(async (req, reply) => {
        const { runId } = z.object({ runId: z.string().min(1) }).parse(req.params);
        const result = await runtime.resumeRun(runId);
        if (!result.ok) {
          reply.code(result.status);
          return {
            error: result.error,
            ...(result.hint ? { hint: result.hint } : {}),
            ...(result.details ? { details: result.details } : {}),
          };
        }
        const updated = await db.select().from(runs).where(eq(runs.id, runId)).get();
        return { ...updated, ...(result.rebuilt ? { rebuilt: true } : {}) };
      }),
    );

    app.post(
      '/api/runs/:runId/cancel',
      wrap(async (req, reply) => {
        const { runId } = z.object({ runId: z.string().min(1) }).parse(req.params);
        const result = await runtime.cancelRun(runId);
        if (!result.ok) {
          reply.code(result.status);
          return { error: result.error };
        }
        const updated = await db.select().from(runs).where(eq(runs.id, runId)).get();
        return updated;
      }),
    );

    app.post(
      '/api/runs/:id/autopilot',
      wrap(async (req, reply) => {
        const { id } = z.object({ id: z.string() }).parse(req.params);
        // Both `budgetMinutes` and `budgetTokens` accept three states:
        //   - omitted (`undefined`)  → fall back to the autopilot default
        //   - explicit positive int  → that exact cap
        //   - explicit `null`        → unlimited (no enforcement at all)
        // This lets a user opt into "let it run for a week" without us
        // silently clamping back to a default ceiling.
        const body = z
          .object({
            enabled: z.boolean(),
            budgetMinutes: z.number().int().positive().nullable().optional(),
            budgetTokens: z.number().int().positive().nullable().optional(),
          })
          .parse(req.body ?? {});

        const existing = db.select().from(runs).where(eq(runs.id, id)).get();
        if (!existing) {
          reply.code(404);
          return { error: 'not_found' };
        }

        // When enabling autopilot without an explicit token cap, fall back to
        // the new high-but-finite default so a true runaway loop still gets
        // killed. Explicit user-provided caps (including `null` for
        // unlimited) always win.
        const effectiveBudgetTokens =
          body.budgetTokens === undefined
            ? body.enabled
              ? DEFAULT_AUTOPILOT_BUDGET_TOKENS
              : null
            : body.budgetTokens;
        const effectiveBudgetMinutes = body.budgetMinutes === undefined ? null : body.budgetMinutes;

        await db
          .update(runs)
          .set({
            autopilotMode: body.enabled,
            autopilotBudgetMinutes: effectiveBudgetMinutes,
            autopilotBudgetTokens: effectiveBudgetTokens,
            autopilotStartedAt: body.enabled ? new Date() : null,
          })
          .where(eq(runs.id, id))
          .run();

        return {
          id,
          autopilotMode: body.enabled,
          autopilotBudgetMinutes: effectiveBudgetMinutes,
          autopilotBudgetTokens: effectiveBudgetTokens,
        };
      }),
    );

    app.post(
      '/api/runs/:runId/replay-checkpoint',
      wrap(async (req, reply) => {
        const { runId } = z.object({ runId: z.string().min(1) }).parse(req.params);
        const last = await db
          .select()
          .from(checkpoints)
          .where(eq(checkpoints.runId, runId))
          .orderBy(desc(checkpoints.ts))
          .get();
        if (!last) {
          reply.code(404);
          return { error: 'no checkpoint found for run' };
        }
        // Replay-from-checkpoint is intentionally not implemented; the
        // pause/resume flow handles crash-recovery via the snapshot the walker
        // writes on a 1s timer. Return 501 explicitly so clients don't
        // misinterpret 200 + a "not yet implemented" hint as success.
        reply.code(501);
        return {
          error: 'not_implemented',
          checkpoint: last,
          hint: 'replay restore is not implemented; use /pause + /resume for crash recovery',
        };
      }),
    );
  };
  return router;
}

export const runRoutes: FastifyPluginAsync = createRunsRouter();
