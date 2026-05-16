import './setup.js';
import { describe, expect, it, beforeAll } from 'vitest';
import { pickFixed, pickModel, recordOutcome } from '../router/thompson.js';
import { db } from '../db/index.js';
import { modelRouterSamples } from '@wisp/schemas';
import { runMigrations } from '../db/migrate.js';

beforeAll(() => {
  runMigrations();
});

describe('pickFixed', () => {
  it('returns the fixed model with NO_OP sampleId and writes no DB row', () => {
    const before = db.select().from(modelRouterSamples).all().length;
    const pick = pickFixed('haiku', 'planner-orchestration');
    expect(pick.model).toBe('haiku');
    expect(pick.sampleId).toBe('NO_OP');
    expect(pick.theta).toBe(0);
    const after = db.select().from(modelRouterSamples).all().length;
    expect(after).toBe(before);
  });

  it('pickModel still writes a sample row for substantive roles', () => {
    const before = db.select().from(modelRouterSamples).all().length;
    pickModel('planner-substantive');
    const after = db.select().from(modelRouterSamples).all().length;
    expect(after).toBe(before + 1);
  });

  it('recordOutcome is a no-op for NO_OP sampleId', async () => {
    await expect(recordOutcome('NO_OP', 'success')).resolves.toBeUndefined();
  });
});
