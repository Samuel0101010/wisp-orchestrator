import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { sqlite } from '../db/index.js';

describe('migrations', () => {
  beforeAll(() => {
    runMigrations();
  });

  afterAll(() => {
    sqlite.close();
  });

  it('creates all expected tables', () => {
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
      // v1.9 Phase 0 additions
      'project_briefs',
      'change_requests',
      'project_states',
      'project_agent_overrides',
    ]) {
      expect(names.has(t)).toBe(true);
    }
  });

  it('projects has package_target + artifact_path columns with correct defaults', () => {
    const cols = sqlite.prepare(`PRAGMA table_info('projects')`).all() as Array<{
      name: string;
      dflt_value: string | null;
      notnull: number;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    const pkg = byName.get('package_target');
    expect(pkg).toBeDefined();
    expect(pkg!.notnull).toBe(1);
    expect(pkg!.dflt_value).toBe("'web'");
    const artifact = byName.get('artifact_path');
    expect(artifact).toBeDefined();
    expect(artifact!.notnull).toBe(0);
  });

  it('plans has kind + parent_state_id columns', () => {
    const cols = sqlite.prepare(`PRAGMA table_info('plans')`).all() as Array<{
      name: string;
      dflt_value: string | null;
      notnull: number;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    const kind = byName.get('kind');
    expect(kind).toBeDefined();
    expect(kind!.notnull).toBe(1);
    expect(kind!.dflt_value).toBe("'initial'");
    expect(byName.has('parent_state_id')).toBe(true);
  });

  it('inserts into new v1.9 tables and reads them back', () => {
    // Seed a project + run so FKs validate.
    const now = Date.now();
    sqlite
      .prepare(
        `INSERT INTO projects (id, name, goal, repo_path, created_at, auto_merge_on_success, self_healing_enabled, max_chain_iterations, default_autopilot_mode, runtime_verify_enabled, package_target)
         VALUES ('p-mig-1', 'mig', 'goal', 'C:/tmp/mig', ?, 1, 0, 3, 0, 1, 'web')`,
      )
      .run(now);

    sqlite
      .prepare(
        `INSERT INTO project_briefs (id, project_id, target_audience, completeness_score, brief_ready, created_at, updated_at)
         VALUES ('b1', 'p-mig-1', 'developers', 75, 0, ?, ?)`,
      )
      .run(now, now);

    sqlite
      .prepare(
        `INSERT INTO change_requests (id, project_id, status, source, user_prompt, created_at)
         VALUES ('cr1', 'p-mig-1', 'pending', 'visual', 'make hero darker', ?)`,
      )
      .run(now);

    sqlite
      .prepare(
        `INSERT INTO project_states (id, project_id, completed_features, open_todos, known_issues, created_at)
         VALUES ('s1', 'p-mig-1', '[]', '[]', '[]', ?)`,
      )
      .run(now);

    sqlite
      .prepare(
        `INSERT INTO project_agent_overrides (id, project_id, role, extra_system_prompt, created_at, updated_at)
         VALUES ('o1', 'p-mig-1', 'developer', 'Prefer TanStack Query.', ?, ?)`,
      )
      .run(now, now);

    const brief = sqlite
      .prepare(`SELECT completeness_score FROM project_briefs WHERE id = 'b1'`)
      .get() as { completeness_score: number };
    expect(brief.completeness_score).toBe(75);

    const cr = sqlite
      .prepare(`SELECT status, source FROM change_requests WHERE id = 'cr1'`)
      .get() as { status: string; source: string };
    expect(cr.status).toBe('pending');
    expect(cr.source).toBe('visual');

    const state = sqlite
      .prepare(`SELECT completed_features FROM project_states WHERE id = 's1'`)
      .get() as { completed_features: string };
    expect(state.completed_features).toBe('[]');

    const override = sqlite
      .prepare(`SELECT extra_system_prompt FROM project_agent_overrides WHERE id = 'o1'`)
      .get() as { extra_system_prompt: string };
    expect(override.extra_system_prompt).toContain('TanStack');
  });

  it('project_agent_overrides enforces unique (project_id, role)', () => {
    const now = Date.now();
    sqlite
      .prepare(
        `INSERT INTO project_agent_overrides (id, project_id, role, extra_system_prompt, created_at, updated_at)
         VALUES ('o-dup-1', 'p-mig-1', 'qa-engineer', 'note A', ?, ?)`,
      )
      .run(now, now);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO project_agent_overrides (id, project_id, role, extra_system_prompt, created_at, updated_at)
           VALUES ('o-dup-2', 'p-mig-1', 'qa-engineer', 'note B', ?, ?)`,
        )
        .run(now, now),
    ).toThrow();
  });

  it('project_briefs enforces unique project_id (one brief per project)', () => {
    const now = Date.now();
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO project_briefs (id, project_id, completeness_score, brief_ready, created_at, updated_at)
           VALUES ('b-dup-1', 'p-mig-1', 0, 0, ?, ?)`,
        )
        .run(now, now),
    ).toThrow();
  });

  it('change_requests cascade-deletes when project is deleted', () => {
    const now = Date.now();
    sqlite
      .prepare(
        `INSERT INTO projects (id, name, goal, repo_path, created_at, auto_merge_on_success, self_healing_enabled, max_chain_iterations, default_autopilot_mode, runtime_verify_enabled, package_target)
         VALUES ('p-mig-cascade', 'c', 'g', 'C:/tmp/c', ?, 1, 0, 3, 0, 1, 'web')`,
      )
      .run(now);
    sqlite
      .prepare(
        `INSERT INTO change_requests (id, project_id, status, source, user_prompt, created_at)
         VALUES ('cr-cascade', 'p-mig-cascade', 'pending', 'text', 'note', ?)`,
      )
      .run(now);
    sqlite.prepare(`DELETE FROM projects WHERE id = 'p-mig-cascade'`).run();
    const remaining = sqlite
      .prepare(`SELECT id FROM change_requests WHERE id = 'cr-cascade'`)
      .get();
    expect(remaining).toBeUndefined();
  });
});
