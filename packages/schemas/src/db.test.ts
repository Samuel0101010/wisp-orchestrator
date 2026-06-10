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
  planKindValues,
  packageTargetValues,
  changeRequestStatusValues,
  changeRequestSourceValues,
  projectBriefs,
  changeRequests,
  projectStates,
  projectAgentOverrides,
  type Project,
  type NewProject,
  type Plan,
  type Task,
  type Run,
  type HarnessEventRow,
  type RunPausedReason,
  type PlanKind,
  type PackageTarget,
  type ProjectBrief,
  type ChangeRequest,
  type ProjectState,
  type ProjectAgentOverride,
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

  it('tasks has the four nullable executor identity columns (migration 0020)', () => {
    expect(tasks.executorName).toBeDefined();
    expect(tasks.executorModel).toBeDefined();
    expect(tasks.executorModelStored).toBeDefined();
    expect(tasks.executorAvatarUrl).toBeDefined();
    // All nullable — task rows from runs before v2.3 have no identity.
    const t: Task = {
      id: 't1',
      planId: 'p1',
      role: 'developer',
      title: 'do work',
      deps: [],
      status: 'pending',
      worktreeBranch: null,
      sessionId: null,
      executorName: null,
      executorModel: null,
      executorModelStored: null,
      executorAvatarUrl: null,
      tokensIn: 0,
      tokensOut: 0,
      turnsUsed: 0,
      durationMs: 0,
    };
    expect(t.executorName).toBeNull();
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
      kind: 'initial',
      parentStateId: null,
    };
    expect(p.parentPlanId).toBe('parent');
  });

  // ---- v1.9 Phase 0 additions ----

  it('planKindValues + packageTargetValues are stable', () => {
    expect(planKindValues).toEqual(['initial', 'iteration', 'hardening']);
    expect(packageTargetValues).toEqual(['web', 'tauri-exe', 'electron-exe', 'pkg-bin']);
    const k: PlanKind = 'iteration';
    const t: PackageTarget = 'tauri-exe';
    expect(k).toBe('iteration');
    expect(t).toBe('tauri-exe');
  });

  it('change-request enum values are stable', () => {
    expect(changeRequestStatusValues).toEqual(['pending', 'in-run', 'done', 'dismissed']);
    expect(changeRequestSourceValues).toEqual(['visual', 'text']);
  });

  it('Plan type carries kind + parentStateId (defaults initial / null)', () => {
    const p: Plan = {
      id: 'p-initial',
      projectId: 'proj-1',
      dagJson: { goal: 'g', team: { roles: [] }, nodes: [], edges: [] },
      status: 'draft',
      parentPlanId: null,
      kind: 'initial',
      parentStateId: null,
    };
    expect(p.kind).toBe('initial');
    expect(p.parentStateId).toBeNull();
  });

  it('Project type carries packageTarget + artifactPath', () => {
    const np: NewProject = {
      id: 'p3',
      name: 'n',
      goal: 'g',
      repoPath: '/x',
      packageTarget: 'tauri-exe',
    };
    expect(np.packageTarget).toBe('tauri-exe');
  });

  it('exports all 4 new v1.9 tables', () => {
    for (const t of [projectBriefs, changeRequests, projectStates, projectAgentOverrides]) {
      expect(t).toBeDefined();
      expect(typeof t).toBe('object');
    }
  });

  it('row types for new tables compile', () => {
    const _b: ProjectBrief | undefined = undefined;
    const _c: ChangeRequest | undefined = undefined;
    const _s: ProjectState | undefined = undefined;
    const _o: ProjectAgentOverride | undefined = undefined;
    void _b;
    void _c;
    void _s;
    void _o;
  });
});
