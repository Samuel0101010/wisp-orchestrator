import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { plans as plansTable } from '@agent-harness/schemas';
import { db } from '../db/index.js';
import { wrap } from './wrap.js';

interface PlanChainEntry {
  id: string;
  parentPlanId: string | null;
  status: string;
  createdAt: number | null;
}

/**
 * Walk parent_plan_id back from a given plan to the root. Returns the chain
 * from latest (the requested plan) → root, so a UI can render newest-first.
 */
async function loadChain(planId: string): Promise<PlanChainEntry[]> {
  const out: PlanChainEntry[] = [];
  const seen = new Set<string>();
  let cursor: string | null = planId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const row = await db.select().from(plansTable).where(eq(plansTable.id, cursor)).get();
    if (!row) break;
    out.push({
      id: row.id,
      parentPlanId: row.parentPlanId,
      status: row.status,
      // plans table doesn't have createdAt today; if it gets one, use it. For now null.
      createdAt: null,
    });
    cursor = row.parentPlanId;
  }
  return out;
}

export const planChainRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/plans/:planId/chain',
    wrap(async (req, reply) => {
      const { planId } = z.object({ planId: z.string().min(1) }).parse(req.params);
      const chain = await loadChain(planId);
      if (chain.length === 0) {
        reply.code(404);
        return { error: 'plan not found' };
      }
      return { chain };
    }),
  );
};
