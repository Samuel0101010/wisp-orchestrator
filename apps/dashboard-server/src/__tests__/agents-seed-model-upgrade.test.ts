import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents } from '@wisp/schemas';
import { db, sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { seedAgents } from '../db/agents-seed.js';

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  sqlite.close();
});

function getQaModel(): string {
  const row = db.select().from(agents).where(eq(agents.seedKey, 'qa-engineer')).get();
  if (!row) throw new Error('qa-engineer seed missing — did seedAgents() run?');
  return row.model;
}

describe('seed refresh — LEGACY_MODEL_UPGRADES (qa-engineer sonnet → haiku)', () => {
  it('seeds qa-engineer with model haiku on a fresh install', () => {
    seedAgents();
    expect(getQaModel()).toBe('haiku');
  });

  it('refreshes an existing row still on the legacy sonnet default to haiku', () => {
    seedAgents();
    // Simulate a DB seeded by an older release where qa-engineer = sonnet.
    sqlite.prepare(`UPDATE agents SET model = 'sonnet' WHERE seed_key = 'qa-engineer'`).run();
    expect(getQaModel()).toBe('sonnet');

    const stats = seedAgents();
    expect(getQaModel()).toBe('haiku');
    expect(stats.refreshed).toBeGreaterThanOrEqual(1);
  });

  it('leaves a user-customised model (opus) untouched on refresh', () => {
    seedAgents();
    sqlite.prepare(`UPDATE agents SET model = 'opus' WHERE seed_key = 'qa-engineer'`).run();

    seedAgents();
    expect(getQaModel()).toBe('opus');
  });
});
