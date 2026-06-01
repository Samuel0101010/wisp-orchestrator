import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { wrap } from './wrap.js';
import { planGoap, GoapBudgetExceededError, type Action } from '@wisp/orchestrator';

const actionSchema = z.object({
  name: z.string().min(1),
  cost: z.number().int().nonnegative(),
  preconditions: z.record(z.string(), z.boolean()).default({}),
  effects: z.record(z.string(), z.boolean()).default({}),
});

const planRequestSchema = z.object({
  initial: z.record(z.string(), z.boolean()).default({}),
  goal: z.record(z.string(), z.boolean()),
  // Allow zero actions — `planGoap` correctly returns `[]` when the initial
  // state already satisfies the goal, and `null` otherwise. Rejecting empty
  // arrays at the schema layer leaks a 400 to the UI for a legitimate edge
  // case (e.g., user wants to check whether goal is already satisfied).
  // Cap the array so an absurd payload can't even reach the solver; the
  // solver's own expansion budget is the real guard against blow-up.
  actions: z.array(actionSchema).max(200),
});

export const goapRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/api/goap/plan',
    wrap(async (req, reply) => {
      const parsed = planRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return { error: 'invalid_body', issues: parsed.error.issues };
      }
      try {
        const plan = planGoap(
          parsed.data as unknown as {
            initial: Record<string, boolean>;
            goal: Record<string, boolean>;
            actions: Action[];
          },
        );
        if (plan === null) {
          return { plan: null, totalCost: null };
        }
        const totalCost = plan.reduce((s, a) => s + a.cost, 0);
        return { plan, totalCost };
      } catch (err) {
        if (err instanceof GoapBudgetExceededError) {
          reply.code(422);
          return { error: 'search_exhausted' };
        }
        throw err;
      }
    }),
  );
};
