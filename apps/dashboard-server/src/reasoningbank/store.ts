import { db } from '../db/index.js';
import { trajectories } from '@agent-harness/schemas';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { tokenize, computeTfidf, cosineSim, type SparseVec } from './tfidf.js';

export interface StoreTrajectoryInput {
  projectId: string | null;
  prompt: string;
  planJson: unknown;
  outcome: 'success' | 'failure' | 'budget_exceeded' | 'cancelled';
  lessons?: string;
  tokensTotal?: number;
}

export async function storeTrajectory(input: StoreTrajectoryInput): Promise<string> {
  const id = randomUUID();
  const all = db.select({ prompt: trajectories.prompt }).from(trajectories).all();
  const corpus = all.map((r) => tokenize(r.prompt));
  const docTokens = tokenize(input.prompt);
  const terms = computeTfidf(docTokens, [...corpus, docTokens]);
  await db.insert(trajectories).values({
    id,
    projectId: input.projectId,
    prompt: input.prompt,
    planJson: JSON.stringify(input.planJson),
    outcome: input.outcome,
    termsJson: JSON.stringify(terms),
    lessons: input.lessons ?? null,
    tokensTotal: input.tokensTotal ?? 0,
    createdAt: new Date(),
  }).run();
  return id;
}

export interface RetrievedTrajectory {
  id: string;
  projectId: string | null;
  prompt: string;
  planJson: unknown;
  outcome: string;
  lessons: string | null;
  score: number;
  createdAt: Date;
}

export async function retrieveSimilar(
  prompt: string,
  projectId: string | null,
  k = 3,
): Promise<RetrievedTrajectory[]> {
  const rows = projectId
    ? db.select().from(trajectories).where(eq(trajectories.projectId, projectId)).all()
    : db.select().from(trajectories).all();
  if (rows.length === 0) return [];
  const docTokens = tokenize(prompt);
  const corpus = rows.map((r) => tokenize(r.prompt));
  const queryVec = computeTfidf(docTokens, [...corpus, docTokens]);
  return rows
    .map((r) => {
      let terms: SparseVec = {};
      try { terms = JSON.parse(r.termsJson as unknown as string) as SparseVec; } catch { /* skip */ }
      return {
        id: r.id,
        projectId: r.projectId,
        prompt: r.prompt,
        planJson: (() => { try { return JSON.parse(r.planJson as unknown as string); } catch { return null; } })(),
        outcome: r.outcome,
        lessons: r.lessons,
        score: cosineSim(queryVec, terms),
        createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt as unknown as string),
      };
    })
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
