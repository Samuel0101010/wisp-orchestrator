import './setup.js';
import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { sqlite } from '../db/index.js';

describe('migrations', () => {
  afterAll(() => {
    sqlite.close();
  });

  it('creates all expected tables', () => {
    runMigrations();
    const rows = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    for (const t of [
      'projects',
      'teams',
      'plans',
      'tasks',
      'runs',
      'events',
      'checkpoints',
      'rate_windows',
    ]) {
      expect(names.has(t)).toBe(true);
    }
  });
});
