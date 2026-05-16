import './setup.js';
import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { checkAutopilotBudget } from '../autopilot/budget.js';
import { tickAutopilot } from '../autopilot/runner.js';
import {
  events as eventsTable,
  plans,
  projects,
  runs as runsTable,
  type Run,
  type RunPausedReason,
} from '@wisp/schemas';
import { db } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';

const baseRun = {
  // satisfy the Run shape minimally — only the fields budget cares about matter
  id: 'r',
  planId: 'p',
  startedAt: null,
  endedAt: null,
  outcome: null,
  status: 'paused' as const,
  budgetMinutes: 1,
  budgetTurns: 1,
  maxParallel: 1,
  tokensInTotal: 0,
  tokensOutTotal: 0,
  turnsTotal: 0,
  pausedReason: null,
  resumeAt: null,
  autopilotMode: false,
  autopilotBudgetMinutes: null,
  autopilotBudgetTokens: null,
  autopilotStartedAt: null,
};

describe('autopilot budget', () => {
  it('passes when not in autopilot mode', () => {
    expect(checkAutopilotBudget({ ...baseRun, autopilotMode: false } as Run, 1e9).exceeded).toBe(
      false,
    );
  });
  it('passes when autopilot on and no budget set', () => {
    expect(
      checkAutopilotBudget({ ...baseRun, autopilotMode: true } as Run, 1_000_000).exceeded,
    ).toBe(false);
  });
  it('halts on token excess', () => {
    expect(
      checkAutopilotBudget(
        { ...baseRun, autopilotMode: true, autopilotBudgetTokens: 100 } as Run,
        200,
      ).exceeded,
    ).toBe(true);
  });
  it('halts on wallclock excess', () => {
    expect(
      checkAutopilotBudget(
        {
          ...baseRun,
          autopilotMode: true,
          autopilotBudgetMinutes: 1,
          autopilotStartedAt: new Date(Date.now() - 120_000),
        } as Run,
        0,
      ).exceeded,
    ).toBe(true);
  });
});

describe('autopilot tick — pause-reason + resumeAt gating', () => {
  let projectId: string;
  let planId: string;

  beforeAll(() => {
    runMigrations();
  });

  beforeEach(() => {
    projectId = randomUUID();
    planId = randomUUID();
    db.insert(projects)
      .values({ id: projectId, name: 'autopilot-tick-test', goal: 'g', repoPath: '/tmp' })
      .run();
    db.insert(plans).values({ id: planId, projectId, dagJson: {}, status: 'locked' }).run();
  });

  function seedPausedRun(
    pausedReason: RunPausedReason,
    overrides: Partial<typeof runsTable.$inferInsert> = {},
  ): string {
    const runId = randomUUID();
    db.insert(runsTable)
      .values({
        id: runId,
        planId,
        status: 'paused',
        startedAt: new Date(),
        budgetMinutes: 60,
        budgetTurns: 100,
        maxParallel: 1,
        autopilotMode: true,
        pausedReason,
        ...overrides,
      })
      .run();
    return runId;
  }

  it('skips runs paused by the user (no auto-resume)', async () => {
    const runId = seedPausedRun('user');
    const res = await tickAutopilot();
    expect(res.resumed).not.toContain(runId);
    expect(res.skipped.map((s) => s.runId)).toContain(runId);
    expect(res.skipped.find((s) => s.runId === runId)?.reason).toBe(
      'pause-reason-not-auto-resumable',
    );
  });

  it('skips runs paused by consecutive-failures (structural — needs human)', async () => {
    const runId = seedPausedRun('consecutive-failures');
    const res = await tickAutopilot();
    expect(res.resumed).not.toContain(runId);
    expect(res.skipped.map((s) => s.runId)).toContain(runId);
  });

  it('skips rate-limit runs whose resumeAt window is still in the future', async () => {
    const runId = seedPausedRun('rate-limit', { resumeAt: new Date(Date.now() + 5 * 60_000) });
    const res = await tickAutopilot();
    expect(res.resumed).not.toContain(runId);
    expect(res.skipped.find((s) => s.runId === runId)?.reason).toBe('rate-limit-window-still-open');
  });

  it('halts on budget exceeded and emits an autopilot.decision event', async () => {
    const runId = seedPausedRun('shutdown', {
      autopilotBudgetTokens: 100,
      tokensInTotal: 200,
      tokensOutTotal: 0,
    });
    const res = await tickAutopilot();
    expect(res.halted).toContain(runId);
    const events = db.select().from(eventsTable).where(eq(eventsTable.runId, runId)).all();
    const decision = events.find((e) => e.type === 'autopilot.decision');
    expect(decision).toBeTruthy();
    expect((decision?.payload as { action: string }).action).toBe('halted');
  });

  it('ignores runs whose autopilotMode is false', async () => {
    const runId = seedPausedRun('rate-limit', { autopilotMode: false });
    const res = await tickAutopilot();
    expect(res.resumed).not.toContain(runId);
    expect(res.halted).not.toContain(runId);
    expect(res.skipped.map((s) => s.runId)).not.toContain(runId);
  });
});
