import './setup.js';
import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { tryCheckoutRun } from '../checkout/atomic-checkout.js';
import { db, sqlite } from '../db/index.js';
import { runs, plans, projects, teams } from '@agent-harness/schemas';
import { runMigrations } from '../db/migrate.js';
import { randomUUID } from 'node:crypto';

beforeAll(() => {
  runMigrations();
});

async function seedRun(status: 'running' | 'paused' = 'paused'): Promise<string> {
  const projectId = randomUUID();
  const planId = randomUUID();
  const runId = randomUUID();
  await db
    .insert(projects)
    .values({
      id: projectId,
      name: 'p',
      goal: 'g',
      repoPath: '/tmp/r',
      createdAt: new Date(),
    })
    .run();
  await db.insert(teams).values({ id: randomUUID(), projectId, rolesJson: { roles: [] } }).run();
  await db
    .insert(plans)
    .values({
      id: planId,
      projectId,
      dagJson: { tasks: [], edges: [] },
      status: 'locked',
    })
    .run();
  await db
    .insert(runs)
    .values({
      id: runId,
      planId,
      status,
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

describe('tryCheckoutRun', () => {
  beforeEach(() => {
    sqlite.prepare('DELETE FROM runs').run();
    sqlite.prepare('DELETE FROM plans').run();
    sqlite.prepare('DELETE FROM teams').run();
    sqlite.prepare('DELETE FROM projects').run();
  });

  it('claims a paused run, returns the token', async () => {
    const runId = await seedRun('paused');
    const result = tryCheckoutRun(runId, 'paused', 'running');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.token).toMatch(/^[0-9a-f-]{36}$/);
    const row = db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(row?.status).toBe('running');
    expect(row?.checkoutToken).toBe(result.token);
  });

  it('returns ok=false when status mismatches', async () => {
    const runId = await seedRun('running');
    const result = tryCheckoutRun(runId, 'paused', 'running');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('status_mismatch');
  });

  it('only one of two concurrent calls succeeds', async () => {
    const runId = await seedRun('paused');
    const [a, b] = await Promise.all([
      Promise.resolve(tryCheckoutRun(runId, 'paused', 'running')),
      Promise.resolve(tryCheckoutRun(runId, 'paused', 'running')),
    ]);
    const winners = [a, b].filter((r) => r.ok).length;
    expect(winners).toBe(1);
  });

  it('returns ok=false when run does not exist', async () => {
    const result = tryCheckoutRun('non-existent-id', 'paused', 'running');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('not_found');
  });
});
