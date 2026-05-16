import './setup.js';
import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { db, sqlite } from '../db/index.js';
import { runs, plans, projects, teams } from '@wisp/schemas';
import { randomUUID } from 'node:crypto';

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  sqlite.prepare('DELETE FROM runs').run();
  sqlite.prepare('DELETE FROM plans').run();
  sqlite.prepare('DELETE FROM teams').run();
  sqlite.prepare('DELETE FROM projects').run();
});

async function seedFailedRun(
  retryCount = 0,
  nextRetryAt: Date | null = new Date(Date.now() - 1000),
): Promise<string> {
  const projectId = randomUUID();
  const planId = randomUUID();
  const runId = randomUUID();
  await db
    .insert(projects)
    .values({ id: projectId, name: 'p', goal: 'g', repoPath: '/tmp/r', createdAt: new Date() })
    .run();
  await db
    .insert(teams)
    .values({ id: randomUUID(), projectId, rolesJson: { roles: [] } })
    .run();
  await db
    .insert(plans)
    .values({ id: planId, projectId, dagJson: { tasks: [], edges: [] }, status: 'locked' })
    .run();
  await db
    .insert(runs)
    .values({
      id: runId,
      planId,
      status: 'failed',
      outcome: 'failure',
      errorReason: 'max_turns',
      retryCount,
      nextRetryAt,
      budgetMinutes: 60,
      budgetTurns: 100,
      maxParallel: 1,
      tokensInTotal: 0,
      tokensOutTotal: 0,
      turnsTotal: 0,
    })
    .run();
  return runId;
}

describe('retryMaxTurns worker', () => {
  it('retries a run whose nextRetryAt is in the past', async () => {
    const runId = await seedFailedRun(0);
    const fakeRuntime: { resumeRun: ReturnType<typeof vi.fn> } = {
      resumeRun: vi.fn(async () => ({ ok: true })),
    };
    const { retryMaxTurnsImpl } = await import('../workers/handlers/retry-max-turns.js');
    const result = await retryMaxTurnsImpl(
      fakeRuntime as unknown as Parameters<typeof retryMaxTurnsImpl>[0],
    );
    expect(result.retried).toContain(runId);
    expect(fakeRuntime.resumeRun).toHaveBeenCalledWith(runId);
  });

  it('skips runs whose nextRetryAt is in the future', async () => {
    const runId = await seedFailedRun(0, new Date(Date.now() + 60_000));
    const fakeRuntime: { resumeRun: ReturnType<typeof vi.fn> } = {
      resumeRun: vi.fn(async () => ({ ok: true })),
    };
    const { retryMaxTurnsImpl } = await import('../workers/handlers/retry-max-turns.js');
    const result = await retryMaxTurnsImpl(
      fakeRuntime as unknown as Parameters<typeof retryMaxTurnsImpl>[0],
    );
    expect(result.retried).not.toContain(runId);
    expect(fakeRuntime.resumeRun).not.toHaveBeenCalled();
  });

  it('does not retry past 4 attempts', async () => {
    const runId = await seedFailedRun(4);
    const fakeRuntime: { resumeRun: ReturnType<typeof vi.fn> } = {
      resumeRun: vi.fn(async () => ({ ok: true })),
    };
    const { retryMaxTurnsImpl } = await import('../workers/handlers/retry-max-turns.js');
    const result = await retryMaxTurnsImpl(
      fakeRuntime as unknown as Parameters<typeof retryMaxTurnsImpl>[0],
    );
    expect(result.retried).not.toContain(runId);
  });
});
