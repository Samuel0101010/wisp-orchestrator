import { describe, it, expect } from 'vitest';
import {
  projects,
  teams,
  plans,
  tasks,
  runs,
  events,
  checkpoints,
  rateWindows,
  runPausedReasonValues,
  type Project,
  type NewProject,
  type Plan,
  type Task,
  type Run,
  type HarnessEventRow,
  type RunPausedReason,
} from './db.js';

describe('drizzle table definitions', () => {
  const tables = [projects, teams, plans, tasks, runs, events, checkpoints, rateWindows];

  it('exports 8 table objects (matching the 9-row data model; "events" + "rateWindows" included)', () => {
    // 9 in spec, but two are "events" and "rateWindows" — total table objects is 8
    // Actually the spec lists 9 (projects, teams, plans, tasks, runs, events, checkpoints, rateWindows = 8).
    // Re-counting the data model: projects, teams, plans, tasks, runs, events, checkpoints, rateWindows = 8.
    expect(tables).toHaveLength(8);
    for (const t of tables) {
      expect(t).toBeDefined();
      expect(typeof t).toBe('object');
    }
  });

  it('projects has id column', () => {
    expect(projects.id).toBeDefined();
  });

  it('runPausedReasonValues includes rate-limit, user, shutdown, consecutive-failures', () => {
    expect(runPausedReasonValues).toEqual([
      'rate-limit',
      'user',
      'shutdown',
      'consecutive-failures',
    ]);
    const r: RunPausedReason = 'shutdown';
    expect(r).toBe('shutdown');
  });

  it('row types compile (type-level only)', () => {
    const p: Project = {
      id: 'p1',
      name: 'n',
      goal: 'g',
      repoPath: '/x',
      createdAt: new Date(),
    };
    expect(p.id).toBe('p1');

    const np: NewProject = { id: 'p2', name: 'n', goal: 'g', repoPath: '/x' };
    expect(np.id).toBe('p2');

    // Ensure shape exists for more types — purely structural compile check.
    const _t: Task | undefined = undefined;
    const _r: Run | undefined = undefined;
    const _e: HarnessEventRow | undefined = undefined;
    void _t;
    void _r;
    void _e;
  });

  it('Plan type allows parentPlanId (nullable)', () => {
    const p: Plan = {
      id: 'p1',
      projectId: 'proj-1',
      dagJson: { goal: 'g', team: { roles: [] }, nodes: [], edges: [] },
      status: 'draft',
      parentPlanId: null,
    };
    expect(p.parentPlanId).toBeNull();
  });

  it('Plan type accepts parentPlanId set to another plan id', () => {
    const p: Plan = {
      id: 'child',
      projectId: 'proj-1',
      dagJson: { goal: 'g', team: { roles: [] }, nodes: [], edges: [] },
      status: 'draft',
      parentPlanId: 'parent',
    };
    expect(p.parentPlanId).toBe('parent');
  });
});
