import type { FastifyPluginAsync } from 'fastify';
import { wrap } from './wrap.js';
import { db } from '../db/index.js';
import { modelRouterPriors, modelRouterSamples } from '@wisp/schemas';

export const routerRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/router/priors',
    wrap(async () => {
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
        updatedAt: r.updatedAt,
      }));
    }),
  );
};
