import { db } from '../db/index.js';
import { modelRouterPriors, modelRouterSamples } from '@agent-harness/schemas';
import { sampleBeta } from './sampler.js';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

const MODELS = ['opus', 'sonnet', 'haiku'] as const;
type ModelName = (typeof MODELS)[number];

const COST: Record<ModelName, number> = { opus: 5, sonnet: 1, haiku: 0.07 };

export interface ModelPick {
  model: ModelName;
  sampleId: string;
  theta: number;
}

function getOrInitPrior(role: string, model: ModelName): { alpha: number; beta: number } {
  const row = db
    .select()
    .from(modelRouterPriors)
    .where(and(eq(modelRouterPriors.role, role), eq(modelRouterPriors.model, model)))
    .get();
  if (row) return { alpha: row.alpha, beta: row.beta };
  db.insert(modelRouterPriors)
    .values({
      role,
      model,
      alpha: 1,
      beta: 1,
      updatedAt: new Date(),
    })
    .run();
  return { alpha: 1, beta: 1 };
}

export function pickModel(role: string): ModelPick {
  let best: { model: ModelName; theta: number } | null = null;
  for (const m of MODELS) {
    const { alpha, beta } = getOrInitPrior(role, m);
    const sampledTheta = sampleBeta(alpha, beta);
    const adjusted = sampledTheta / COST[m];
    if (!best || adjusted > best.theta) best = { model: m, theta: adjusted };
  }
  if (!best) throw new Error('unreachable: no models');
  const sampleId = randomUUID();
  db.insert(modelRouterSamples)
    .values({
      id: sampleId,
      role,
      model: best.model,
      takenAt: new Date(),
      outcome: null,
      recordedAt: null,
    })
    .run();
  return { model: best.model, sampleId, theta: best.theta };
}

export async function recordOutcome(
  sampleId: string,
  outcome: 'success' | 'failure',
): Promise<void> {
  if (sampleId === 'NO_OP') return; // pickFixed paths skip Thompson updates
  const sample = db
    .select()
    .from(modelRouterSamples)
    .where(eq(modelRouterSamples.id, sampleId))
    .get();
  if (!sample || sample.outcome) return; // idempotent

  const role = sample.role;
  const model = sample.model as ModelName;
  const prior = getOrInitPrior(role, model);
  const updated =
    outcome === 'success'
      ? { alpha: prior.alpha + 1, beta: prior.beta }
      : { alpha: prior.alpha, beta: prior.beta + 1 };
  db.update(modelRouterPriors)
    .set({ ...updated, updatedAt: new Date() })
    .where(and(eq(modelRouterPriors.role, role), eq(modelRouterPriors.model, model)))
    .run();
  db.update(modelRouterSamples)
    .set({
      outcome,
      recordedAt: new Date(),
    })
    .where(eq(modelRouterSamples.id, sampleId))
    .run();
}

/**
 * Force-pick a model without consuming a Thompson sample slot. Use for
 * orchestration phases (context-ingest, status-post, workspace-inspect)
 * where the model choice is fixed by policy, not by exploration.
 *
 * The returned sampleId is the literal string 'NO_OP' — recordOutcome
 * is a no-op for it (silent return). Callers can therefore use the
 * same recordOutcome path for both pickModel and pickFixed without
 * branching.
 */
export function pickFixed(model: ModelName, _role: string): ModelPick {
  return { model, sampleId: 'NO_OP', theta: 0 };
}
