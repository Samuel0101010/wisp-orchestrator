import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { wrap } from './wrap.js';
import { db } from '../db/index.js';
import { workerRuns } from '@wisp/schemas';
import type { WorkerRegistry } from '../workers/registry.js';

export interface WorkersRouterDeps {
  registry: WorkerRegistry;
}

export const createWorkersRouter =
  (deps: WorkersRouterDeps): FastifyPluginAsync =>
  async (app) => {
    app.get(
      '/api/workers',
      wrap(async () => {
        return deps.registry.list().map((w) => ({
          name: w.name,
          cronSpec: w.cronSpec,
          enabled: w.enabled,
        }));
      }),
    );

    app.post(
      '/api/workers/:name/run',
      wrap(async (req, reply) => {
        const { name } = z.object({ name: z.string().min(1) }).parse(req.params);
        if (!deps.registry.get(name)) {
          reply.code(404);
          return { error: 'unknown_worker' };
        }
        const run = await deps.registry.runNow(name);
        await db
          .insert(workerRuns)
          .values({
            id: run.id,
            workerName: run.workerName,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            status: run.status,
            resultJson: run.result,
            errorReason: run.errorReason,
          })
          .run();
        return run;
      }),
    );

    app.get(
      '/api/workers/:name/runs',
      wrap(async (req) => {
        const { name } = z.object({ name: z.string().min(1) }).parse(req.params);
        const rows = db
          .select()
          .from(workerRuns)
          .where(eq(workerRuns.workerName, name))
          .orderBy(desc(workerRuns.startedAt))
          .limit(50)
          .all();
        return rows;
      }),
    );
  };
