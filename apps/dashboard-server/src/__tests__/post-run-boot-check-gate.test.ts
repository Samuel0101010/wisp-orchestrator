import './setup.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { events, plans, projects } from '@wisp/schemas';
import type { Walker } from '@wisp/orchestrator';
import { db, sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { RunRuntime } from '../orchestrator/runtime.js';

// Intercept the harness boot check so the post-run hook never spawns a real
// worktree/install/dev-server — these tests only assert WHETHER it is invoked.
const { bootCheckMock } = vi.hoisted(() => ({
  bootCheckMock: vi.fn(async (): Promise<{ ok: boolean; reason?: string } | null> => null),
}));
vi.mock('../orchestrator/harness-boot-check.js', () => ({
  runHarnessBootCheck: bootCheckMock,
}));

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  sqlite.close();
});

beforeEach(() => {
  bootCheckMock.mockClear();
});

/**
 * Seed a project + locked plan (with a runtime-verifier role so
 * `verifierExpected` is true and the ONLY gate-off lever under test is the
 * project's runtimeVerifyEnabled flag) and drive a run to a `success`
 * outcome through a stub walker.
 */
async function runToSuccess(opts: { runtimeVerifyEnabled: boolean }): Promise<string> {
  const projectId = randomUUID();
  await db
    .insert(projects)
    .values({
      id: projectId,
      name: 'p',
      goal: 'g',
      repoPath: '/tmp/repo',
      createdAt: new Date(),
      runtimeVerifyEnabled: opts.runtimeVerifyEnabled,
      autoMergeOnSuccess: false,
      selfHealingEnabled: false,
    })
    .run();
  const planId = randomUUID();
  const plan = {
    goal: 'g',
    team: {
      roles: [
        { role: 'developer', model: 'sonnet', allowedTools: [], systemPrompt: 'd'.repeat(60) },
        {
          role: 'runtime-verifier',
          model: 'sonnet',
          allowedTools: [],
          systemPrompt: 'v'.repeat(60),
        },
      ],
    },
    nodes: [
      { id: 'n1', role: 'developer', prompt: 'p', deps: [], successCriteria: {}, maxTurns: 5 },
      {
        id: 'n2',
        role: 'runtime-verifier',
        prompt: 'v',
        deps: ['n1'],
        successCriteria: {},
        maxTurns: 5,
      },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
  };
  await db
    .insert(plans)
    .values({ id: planId, projectId, dagJson: plan as unknown, status: 'locked' })
    .run();

  const runtime = new RunRuntime({
    db,
    ws: { publishToRun: () => {} },
    snapshotIntervalMs: 60_000,
    buildWalker: () => {
      const walker: Partial<Walker> = {
        async start() {
          return 'success' as const;
        },
        async pauseForShutdown() {},
        async cancel() {},
      };
      return walker as Walker;
    },
  });

  const start = await runtime.startRun({ planId });
  if (!start.ok) throw new Error(`startRun failed: ${JSON.stringify(start)}`);

  // handlePostRunSuccess runs fire-and-forget after walker.start resolves.
  // The "[harness] release-gate: ..." event is its LAST persisted artifact
  // (auto-merge + self-healing are disabled on this project), so once it
  // appears the gating decision has been made and the hook is done — safe
  // for the suite to close the DB without racing the hook's tail.
  for (let i = 0; i < 400; i++) {
    const rows = await db.select().from(events).where(eq(events.runId, start.runId)).all();
    const gateEvent = rows.some((r) => JSON.stringify(r.payload ?? {}).includes('release-gate'));
    if (gateEvent) return start.runId;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('release-gate event never appeared — post-run hook did not complete');
}

describe('post-run harness boot check gating', () => {
  it('skips the boot check entirely when the project disabled runtime verification', async () => {
    await runToSuccess({ runtimeVerifyEnabled: false });
    expect(bootCheckMock).not.toHaveBeenCalled();
  });

  it('runs the boot check when the effective runtime-verify flag is on', async () => {
    const runId = await runToSuccess({ runtimeVerifyEnabled: true });
    expect(bootCheckMock).toHaveBeenCalledTimes(1);
    expect(bootCheckMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/tmp/repo',
        runId,
        resultBranch: `wisp/${runId}/result`,
      }),
    );
  });
});
