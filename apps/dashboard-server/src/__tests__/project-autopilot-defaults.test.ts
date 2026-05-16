import './setup.js';
import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { plans, projects, runs, tasks } from '@wisp/schemas';
import { db } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { RunRuntime } from '../orchestrator/runtime.js';
import { Walker } from '@wisp/orchestrator';

// Test that project-level autopilot defaults propagate into new run rows.
// Uses a Walker stub that never actually starts so we can inspect the
// inserted row before any async work happens.
describe('project autopilot defaults → new run inheritance', () => {
  let projectId: string;
  let planId: string;

  // The setup.ts sibling import wires WISP_DATA_DIR to a tmpdir but does
  // NOT apply migrations — the production server runs them on boot from
  // server.ts. We do the same here once, then each test seeds fresh rows.
  beforeAll(() => {
    runMigrations();
  });

  beforeEach(async () => {
    projectId = randomUUID();
    planId = randomUUID();
    db.delete(tasks).where(eq(tasks.planId, planId)).run();
    db.delete(plans).where(eq(plans.id, planId)).run();
    db.delete(projects).where(eq(projects.id, projectId)).run();
  });

  function makeRuntime() {
    return new RunRuntime({
      db: db as never,
      ws: { publishToRun: () => undefined },
      // Stub walker — start returns a never-resolving promise so the runtime
      // doesn't actually advance the run. We're only asserting on the DB
      // row that startRun INSERTS synchronously.
      buildWalker: () =>
        ({
          start: () => new Promise(() => undefined),
          pause: async () => undefined,
          state: 'idle',
        }) as unknown as Walker,
    });
  }

  async function seedProject(autopilotDefaults: {
    mode: boolean;
    minutes: number | null;
    tokens: number | null;
  }) {
    const team = {
      roles: [
        {
          role: 'security' as const,
          model: 'sonnet' as const,
          allowedTools: ['Read', 'Edit'],
          systemPrompt: 'x'.repeat(60),
        },
      ],
    };
    const plan = {
      goal: 'g',
      team,
      nodes: [
        {
          id: 'n1',
          role: 'security',
          prompt: 'p',
          deps: [],
          successCriteria: { lint: 'echo' },
          maxTurns: 5,
        },
      ],
      edges: [],
    };

    await db
      .insert(projects)
      .values({
        id: projectId,
        name: 'autopilot-defaults-test',
        goal: 'g',
        repoPath: process.cwd(),
        defaultAutopilotMode: autopilotDefaults.mode,
        defaultAutopilotBudgetMinutes: autopilotDefaults.minutes,
        defaultAutopilotBudgetTokens: autopilotDefaults.tokens,
      })
      .run();
    await db
      .insert(plans)
      .values({
        id: planId,
        projectId,
        dagJson: plan as unknown,
        status: 'locked',
      })
      .run();
    await db
      .insert(tasks)
      .values({
        id: 'n1',
        planId,
        role: 'security',
        title: 'n1',
        deps: [],
        status: 'pending',
      })
      .run();
  }

  it('copies project.defaultAutopilotMode=true into the new run row', async () => {
    await seedProject({ mode: true, minutes: 240, tokens: 1_000_000 });
    const runtime = makeRuntime();
    const res = await runtime.startRun({ planId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = db.select().from(runs).where(eq(runs.id, res.runId)).get();
    expect(row?.autopilotMode).toBe(true);
    expect(row?.autopilotBudgetMinutes).toBe(240);
    expect(row?.autopilotBudgetTokens).toBe(1_000_000);
    expect(row?.autopilotStartedAt).toBeTruthy();
  });

  it('leaves autopilotMode=false when project default is false', async () => {
    await seedProject({ mode: false, minutes: null, tokens: null });
    const runtime = makeRuntime();
    const res = await runtime.startRun({ planId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = db.select().from(runs).where(eq(runs.id, res.runId)).get();
    expect(row?.autopilotMode).toBe(false);
    expect(row?.autopilotBudgetMinutes).toBeNull();
    expect(row?.autopilotStartedAt).toBeNull();
  });

  it('honors explicit parentRunId + chainIteration overrides', async () => {
    await seedProject({ mode: false, minutes: null, tokens: null });
    const runtime = makeRuntime();
    const res = await runtime.startRun({
      planId,
      parentRunId: 'fake-parent-uuid',
      chainIteration: 2,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = db.select().from(runs).where(eq(runs.id, res.runId)).get();
    expect(row?.parentRunId).toBe('fake-parent-uuid');
    expect(row?.chainIteration).toBe(2);
  });
});
