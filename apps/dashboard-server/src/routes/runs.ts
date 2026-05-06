import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { checkpoints, events as eventsTable, plans, runs, tasks } from '@agent-harness/schemas';
import { db } from '../db/index.js';
import { env } from '../env.js';
import { wrap } from './wrap.js';
import { publishToRun } from '../ws.js';
import { RunRuntime } from '../orchestrator/runtime.js';
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
});

let defaultRuntime: RunRuntime | null = null;
function defaultRuntimeInstance(): RunRuntime {
  if (!defaultRuntime) {
    defaultRuntime = new RunRuntime({
      db,
      ws: { publishToRun },
      runner: env.HARNESS_MOCK_CLI ? makeMockRunner() : undefined,
    });
  }
  return defaultRuntime;
}

/** Exposed so server.ts can call pauseAllForShutdown() on the live runtime. */
export function getDefaultRuntime(): RunRuntime {
  return defaultRuntimeInstance();
}

export function createRunsRouter(deps: RunsRouterDeps = {}): FastifyPluginAsync {
  const runtime = deps.runtime ?? defaultRuntimeInstance();
  const router: FastifyPluginAsync = async (app) => {
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
          })
          .parse(req.query ?? {});

        if (query.resumable) {
          const resumable = await findResumableRuns(db);
          return { runs: resumable };
        }
        const all = await db.select().from(runs).orderBy(desc(runs.startedAt)).limit(50).all();
        return { runs: all };
      }),
    );

    app.post(
      '/api/runs',
      wrap(async (req, reply) => {
        const body = startRunSchema.parse(req.body ?? {});
        const result = await runtime.startRun(body);
        if (!result.ok) {
          reply.code(result.status);
          return { error: result.error, ...(result.details ? { details: result.details } : {}) };
        }
        reply.code(201);
        return { runId: result.runId };
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
        // M1-D4: surface the last checkpoint for the UI; replay restoration is E2.
        return { checkpoint: last, hint: 'replay restore not yet implemented in M1-D4' };
      }),
    );
  };
  return router;
}

export const runRoutes: FastifyPluginAsync = createRunsRouter();
