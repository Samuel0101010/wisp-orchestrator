/**
 * Regression: a user-started ITERATION run must be linked to the prior run it
 * builds upon (parentRunId + chainIteration), the same way the self-healing
 * chain links its hardening runs. Before the fix the linkage lived only on the
 * plan (kind='iteration', parentStateId) and the run row had parentRunId=null /
 * chainIteration=0, so the run history couldn't show the parent→child chain.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { plans, projects, projectStates, runs } from '@wisp/schemas';
import { db } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createRunsRouter } from '../routes/runs.js';
import type { RunRuntime } from '../orchestrator/runtime.js';

interface CapturedStartArgs {
  parentRunId?: string;
  chainIteration?: number;
}

function stubRuntime(capture: (args: CapturedStartArgs) => void): RunRuntime {
  return {
    startRun: async (args: CapturedStartArgs) => {
      capture(args);
      return { ok: true as const, runId: 'stub-run-' + randomUUID() };
    },
  } as unknown as RunRuntime;
}

/** A repo dir with a `.git` marker so the run-start preflight passes. */
function makeGitDir(tmpDirs: string[]): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-iter-link-'));
  tmpDirs.push(repoPath);
  fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
  return repoPath;
}

describe('POST /api/runs — iteration run parent linkage', () => {
  beforeAll(() => {
    runMigrations();
  });

  let app: FastifyInstance | null = null;
  const tmpDirs: string[] = [];
  afterEach(async () => {
    if (app) await app.close();
    app = null;
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('links an iteration run to the prior run via parentRunId without touching chainIteration', async () => {
    const repoPath = makeGitDir(tmpDirs);
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, name: 'iter', goal: 'g', repoPath }).run();

    // Prior completed run (chainIteration 0) under its own initial plan.
    const priorPlanId = randomUUID();
    await db
      .insert(plans)
      .values({
        id: priorPlanId,
        projectId,
        dagJson: { nodes: [], edges: [] },
        status: 'done',
        kind: 'initial',
      })
      .run();
    const priorRunId = randomUUID();
    await db
      .insert(runs)
      .values({
        id: priorRunId,
        planId: priorPlanId,
        status: 'completed',
        outcome: 'success',
        budgetMinutes: 60,
        budgetTurns: 100,
        maxParallel: 2,
        // Simulate a project that already self-healed to its cap: the prior run
        // is a hardening run at depth 3. The user iteration must NOT inherit it.
        chainIteration: 3,
      })
      .run();

    // Project-state snapshot derived from that run.
    const stateId = randomUUID();
    await db
      .insert(projectStates)
      .values({
        id: stateId,
        projectId,
        runId: priorRunId,
        completedFeatures: [],
        openTodos: [],
        knownIssues: [],
      })
      .run();

    // The new iteration plan points at that state.
    const iterPlanId = randomUUID();
    await db
      .insert(plans)
      .values({
        id: iterPlanId,
        projectId,
        dagJson: { nodes: [], edges: [] },
        status: 'locked',
        kind: 'iteration',
        parentStateId: stateId,
      })
      .run();

    let captured: CapturedStartArgs | null = null;
    app = Fastify();
    await app.register(createRunsRouter({ runtime: stubRuntime((a) => (captured = a)) }));
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { planId: iterPlanId },
    });

    expect(res.statusCode).toBe(201);
    expect(captured).not.toBeNull();
    expect(captured!.parentRunId).toBe(priorRunId);
    // chainIteration is owned by the self-healing chain (cap counter). A
    // user-launched iteration must NOT inherit the prior run's depth (here 3) —
    // it stays unset/0 so self-healing keeps a fresh budget and the run is not
    // mislabeled as a hardening iteration in the UI.
    expect(captured!.chainIteration).toBeUndefined();
  });

  it('leaves an initial (non-iteration) run unlinked', async () => {
    const repoPath = makeGitDir(tmpDirs);
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, name: 'init', goal: 'g', repoPath }).run();
    const planId = randomUUID();
    await db
      .insert(plans)
      .values({
        id: planId,
        projectId,
        dagJson: { nodes: [], edges: [] },
        status: 'locked',
        kind: 'initial',
      })
      .run();

    let captured: CapturedStartArgs | null = null;
    app = Fastify();
    await app.register(createRunsRouter({ runtime: stubRuntime((a) => (captured = a)) }));
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { planId } });

    expect(res.statusCode).toBe(201);
    expect(captured).not.toBeNull();
    expect(captured!.parentRunId).toBeUndefined();
    expect(captured!.chainIteration).toBeUndefined();
  });
});
