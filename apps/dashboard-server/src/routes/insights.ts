import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { wrap } from './wrap.js';
import { db } from '../db/index.js';
import {
  trajectories,
  modelRouterPriors,
  modelRouterSamples,
  runSummaries,
} from '@agent-harness/schemas';

export const insightsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/insights/trajectories',
    wrap(async (req) => {
      const { projectId } = z.object({ projectId: z.string().optional() }).parse(req.query ?? {});
      const rows = projectId
        ? db
            .select()
            .from(trajectories)
            .where(eq(trajectories.projectId, projectId))
            .orderBy(desc(trajectories.createdAt))
            .limit(50)
            .all()
        : db.select().from(trajectories).orderBy(desc(trajectories.createdAt)).limit(50).all();
      return rows.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        prompt: r.prompt,
        outcome: r.outcome,
        lessons: r.lessons,
        tokensTotal: r.tokensTotal,
        createdAt: r.createdAt,
      }));
    }),
  );

  app.get(
    '/api/insights/trajectories/:id',
    wrap(async (req, reply) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const row = db.select().from(trajectories).where(eq(trajectories.id, id)).get();
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      let planJson: unknown = null;
      try {
        planJson = JSON.parse(row.planJson);
      } catch (err) {
        console.warn(
          `[insights:trajectory] corrupt planJson for ${id}:`,
          err instanceof Error ? err.message : err,
        );
      }
      return { ...row, planJson };
    }),
  );

  app.delete(
    '/api/insights/trajectories/:id',
    wrap(async (req, reply) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      db.delete(trajectories).where(eq(trajectories.id, id)).run();
      reply.code(204);
      return null;
    }),
  );

  app.get(
    '/api/insights/run-summaries',
    wrap(async (req) => {
      const { projectId } = z.object({ projectId: z.string().optional() }).parse(req.query ?? {});
      const rows = projectId
        ? db
            .select()
            .from(runSummaries)
            .where(eq(runSummaries.projectId, projectId))
            .orderBy(desc(runSummaries.createdAt))
            .limit(50)
            .all()
        : db.select().from(runSummaries).orderBy(desc(runSummaries.createdAt)).limit(50).all();
      return rows;
    }),
  );

  // Re-expose router priors for the UI's combined Insights view
  app.get(
    '/api/insights/router-priors',
    wrap(async () => {
      const rows = db.select().from(modelRouterPriors).all();
      const samples = db.select().from(modelRouterSamples).all();
      const samplesByKey = new Map<string, number>();
      for (const s of samples) {
        if (s.outcome == null) continue; // only count recorded samples
        const k = `${s.role}::${s.model}`;
        samplesByKey.set(k, (samplesByKey.get(k) ?? 0) + 1);
      }
      return rows.map((r) => {
        const phaseMatch = r.role.match(/-(orchestration|substantive)$/);
        const phase = phaseMatch ? phaseMatch[1] : 'unspecified';
        const baseRole = phaseMatch ? r.role.slice(0, -phaseMatch[0].length) : r.role;
        return {
          role: r.role,
          baseRole,
          phase,
          model: r.model,
          alpha: r.alpha,
          beta: r.beta,
          mean: r.alpha / (r.alpha + r.beta),
          samples: samplesByKey.get(`${r.role}::${r.model}`) ?? 0,
        };
      });
    }),
  );
};
