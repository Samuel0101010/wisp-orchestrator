import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { wrap } from './wrap.js';
import { db } from '../db/index.js';
import { trajectories, modelRouterPriors, modelRouterSamples } from '@agent-harness/schemas';

export const insightsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/insights/trajectories', wrap(async (req) => {
    const { projectId } = z.object({ projectId: z.string().optional() }).parse(req.query ?? {});
    const rows = projectId
      ? db.select().from(trajectories).where(eq(trajectories.projectId, projectId)).orderBy(desc(trajectories.createdAt)).limit(50).all()
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
  }));

  app.get('/api/insights/trajectories/:id', wrap(async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const row = db.select().from(trajectories).where(eq(trajectories.id, id)).get();
    if (!row) { reply.code(404); return { error: 'not_found' }; }
    let planJson: unknown = null;
    try { planJson = JSON.parse(row.planJson as unknown as string); } catch { /* keep null */ }
    return { ...row, planJson };
  }));

  app.delete('/api/insights/trajectories/:id', wrap(async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    db.delete(trajectories).where(eq(trajectories.id, id)).run();
    return { id, deleted: true };
  }));

  // Re-expose router priors for the UI's combined Insights view
  app.get('/api/insights/router-priors', wrap(async () => {
    const rows = db.select().from(modelRouterPriors).all();
    const samples = db.select().from(modelRouterSamples).all();
    const samplesByKey = new Map<string, number>();
    for (const s of samples) {
      if (s.outcome == null) continue; // only count recorded samples
      const k = `${s.role}::${s.model}`;
      samplesByKey.set(k, (samplesByKey.get(k) ?? 0) + 1);
    }
    return rows.map((r) => ({
      role: r.role,
      model: r.model,
      alpha: r.alpha,
      beta: r.beta,
      mean: r.alpha / (r.alpha + r.beta),
      samples: samplesByKey.get(`${r.role}::${r.model}`) ?? 0,
    }));
  }));
};
