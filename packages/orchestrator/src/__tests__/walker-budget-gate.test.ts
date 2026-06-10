import { describe, it, expect, vi } from 'vitest';
import type { HarnessEvent, Plan, Team, TaskNode } from '@wisp/schemas';
import { Walker, type BudgetConfig, type WalkerDeps } from '../walker.js';
import type { RunClaudeOpts } from '../subprocess.js';

/**
 * P3 — pre-dispatch budget gate.
 *
 * `checkBudget` only fires on `task.usage` events, so before this gate the
 * window BETWEEN tasks never re-checked the budget: a run at 95% of its turn
 * cap happily launched the next subprocess. These tests drive the new
 * `preDispatchBudgetExceeded` path in `dispatch()`:
 *   - budget (nearly) consumed by task1 → task2 never launches, the run
 *     resolves `budget_exceeded`, and `resource.exceeded` carries the
 *     matching kind;
 *   - `budgetReserveFraction: 0.1` trips at frac >= 0.9 (and not below);
 *   - the reserve clamps to 0.5;
 *   - a throwing `extraBudgetCheck` never blocks dispatch.
 */

// ---------- minimal fakes (mirrors walker.test.ts conventions) ----------

interface FakeTask {
  events?: HarnessEvent[];
  gate?: { release: () => void; promise: Promise<void> };
}

function createGate(): { release: () => void; promise: Promise<void> } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, promise };
}

function makeTeam(): Team {
  return {
    roles: [
      { role: 'architect', model: 'opus', allowedTools: ['Read'], systemPrompt: 'arch sys' },
      { role: 'developer', model: 'sonnet', allowedTools: ['Read'], systemPrompt: 'dev sys' },
    ],
  };
}

function node(id: string, role: string, deps: string[] = []): TaskNode {
  return { id, role, prompt: `do ${id}`, deps, successCriteria: {}, maxTurns: 5 };
}

function makePlan(nodes: TaskNode[]): Plan {
  const edges = nodes.flatMap((n) => n.deps.map((d) => ({ from: d, to: n.id })));
  return { goal: 'g', team: makeTeam(), nodes, edges };
}

interface Harness {
  walker: Walker;
  emitted: HarnessEvent[];
  spawns: string[];
  setNow: (ms: number) => void;
}

function makeHarness(args: {
  scripts?: Map<string, FakeTask>;
  budgetReserveFraction?: number;
  extraBudgetCheck?: WalkerDeps['extraBudgetCheck'];
}): Harness {
  const emitted: HarnessEvent[] = [];
  const spawns: string[] = [];
  let now = 0;
  const deps: WalkerDeps = {
    pool: {
      get maxParallel() {
        return 99;
      },
      terminateAll() {
        /* no-op */
      },
      run(o: RunClaudeOpts): AsyncIterable<HarnessEvent> {
        spawns.push(o.taskId);
        const script = args.scripts?.get(o.taskId);
        return (async function* () {
          for (const ev of script?.events ?? []) {
            yield ev;
            await new Promise((r) => setImmediate(r));
          }
          if (script?.gate) await script.gate.promise;
          if (
            !script?.events?.some((e) => e.type === 'task.completed' || e.type === 'task.failed')
          ) {
            yield {
              type: 'task.completed',
              payload: { taskId: o.taskId, outcome: 'pass', exitCode: 0 },
            };
          }
        })();
      },
    } as unknown as WalkerDeps['pool'],
    worktree: {
      async add({ branchName }) {
        return `/fake/wt/${branchName.replace(/[^a-zA-Z0-9]+/g, '-')}`;
      },
      async remove() {
        /* no-op */
      },
    },
    verify: async () => ({ pass: true, output: 'ok', failures: [] }),
    emit: (ev) => {
      emitted.push(ev);
    },
    onTaskState: async () => {
      /* no-op */
    },
    onRunState: async () => {
      /* no-op */
    },
    snapshot: async () => '/fake/snap.json',
    // Inert timer: registered callbacks (inactivity watchdog) never fire —
    // these tests never advance the clock into watchdog territory.
    setTimeout: () => () => undefined,
    now: () => now,
    autoCommit: async () => 'a'.repeat(40),
    mergeBranches: async () => ({ ok: true }),
    interTaskPacingMs: 0,
    autoResumeRateLimit: true,
    budgetReserveFraction: args.budgetReserveFraction,
    extraBudgetCheck: args.extraBudgetCheck,
  };
  return {
    walker: new Walker(deps),
    emitted,
    spawns,
    setNow: (ms) => {
      now = ms;
    },
  };
}

function usage(taskId: string, turns: number): HarnessEvent {
  return { type: 'task.usage', payload: { taskId, tokensIn: 1, tokensOut: 1, turns } };
}

function completed(taskId: string): HarnessEvent {
  return { type: 'task.completed', payload: { taskId, outcome: 'pass', exitCode: 0 } };
}

const BUDGET_100_TURNS: BudgetConfig = { budgetMinutes: 60, budgetTurns: 100, maxParallel: 1 };

const twoTaskPlan = (): Plan => makePlan([node('a', 'architect'), node('b', 'developer', ['a'])]);

// ---------- tests ----------

describe('Walker — pre-dispatch budget gate (P3)', () => {
  it('turns budget consumed by task1 → task2 never launches; outcome budget_exceeded; kind=turns', async () => {
    // task1 burns 95/100 turns — under checkBudget's >=1 kill threshold, so
    // the mid-task path never cancels; only the pre-dispatch gate (threshold
    // 0.9 with reserve 0.1) can stop task2.
    const scripts = new Map<string, FakeTask>([
      ['a', { events: [usage('a', 95), completed('a')] }],
    ]);
    const h = makeHarness({ scripts, budgetReserveFraction: 0.1 });
    const outcome = await h.walker.start({
      runId: 'r-gate-turns',
      plan: twoTaskPlan(),
      repoPath: '/fake/repo',
      budget: BUDGET_100_TURNS,
    });
    expect(outcome).toBe('budget_exceeded');
    expect(h.spawns).toEqual(['a']);
    const exceeded = h.emitted.filter((e) => e.type === 'resource.exceeded');
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]!.type === 'resource.exceeded' && exceeded[0]!.payload.kind).toBe('turns');
  });

  it('reserve 0.1 trips at exactly turnFrac >= 0.9', async () => {
    const scripts = new Map<string, FakeTask>([
      ['a', { events: [usage('a', 90), completed('a')] }],
    ]);
    const h = makeHarness({ scripts, budgetReserveFraction: 0.1 });
    const outcome = await h.walker.start({
      runId: 'r-gate-boundary',
      plan: twoTaskPlan(),
      repoPath: '/fake/repo',
      budget: BUDGET_100_TURNS,
    });
    expect(outcome).toBe('budget_exceeded');
    expect(h.spawns).toEqual(['a']);
  });

  it('reserve 0.1 does NOT trip below 0.9 — task2 launches and the run succeeds', async () => {
    const scripts = new Map<string, FakeTask>([
      ['a', { events: [usage('a', 89), completed('a')] }],
    ]);
    const h = makeHarness({ scripts, budgetReserveFraction: 0.1 });
    const outcome = await h.walker.start({
      runId: 'r-gate-under',
      plan: twoTaskPlan(),
      repoPath: '/fake/repo',
      budget: BUDGET_100_TURNS,
    });
    expect(outcome).toBe('success');
    expect(h.spawns).toEqual(['a', 'b']);
    expect(h.emitted.filter((e) => e.type === 'resource.exceeded')).toHaveLength(0);
  });

  it('clamps budgetReserveFraction to 0.5 — an absurd 0.9 reserve trips at 0.5, not 0.1', async () => {
    // 45/100 turns = 0.45 < clamped threshold 0.5 → must NOT trip.
    const under = makeHarness({
      scripts: new Map<string, FakeTask>([['a', { events: [usage('a', 45), completed('a')] }]]),
      budgetReserveFraction: 0.9,
    });
    const underOutcome = await under.walker.start({
      runId: 'r-clamp-under',
      plan: twoTaskPlan(),
      repoPath: '/fake/repo',
      budget: BUDGET_100_TURNS,
    });
    expect(underOutcome).toBe('success');
    expect(under.spawns).toEqual(['a', 'b']);

    // 50/100 turns = 0.5 >= clamped threshold 0.5 → trips.
    const over = makeHarness({
      scripts: new Map<string, FakeTask>([['a', { events: [usage('a', 50), completed('a')] }]]),
      budgetReserveFraction: 0.9,
    });
    const overOutcome = await over.walker.start({
      runId: 'r-clamp-over',
      plan: twoTaskPlan(),
      repoPath: '/fake/repo',
      budget: BUDGET_100_TURNS,
    });
    expect(overOutcome).toBe('budget_exceeded');
    expect(over.spawns).toEqual(['a']);
  });

  it('time budget elapsed while task1 ran → task2 never launches with kind=time (default reserve 0)', async () => {
    // task1 emits NO usage events, so checkBudget never runs; the clock jumps
    // past budgetMinutes while it holds at the gate. Only the pre-dispatch
    // gate can observe the elapsed time before task2 launches.
    const gate = createGate();
    const scripts = new Map<string, FakeTask>([['a', { gate }]]);
    const h = makeHarness({ scripts });
    const startPromise = h.walker.start({
      runId: 'r-gate-time',
      plan: twoTaskPlan(),
      repoPath: '/fake/repo',
      budget: { budgetMinutes: 10, budgetTurns: null, maxParallel: 1 },
    });
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(h.spawns).toEqual(['a']);
    h.setNow(11 * 60_000); // 11 min > 10-min budget
    gate.release();
    const outcome = await startPromise;
    expect(outcome).toBe('budget_exceeded');
    expect(h.spawns).toEqual(['a']);
    const exceeded = h.emitted.find((e) => e.type === 'resource.exceeded');
    expect(exceeded?.type === 'resource.exceeded' && exceeded.payload.kind).toBe('time');
  });

  it('a throwing extraBudgetCheck does not block dispatch', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const h = makeHarness({
        extraBudgetCheck: async () => {
          throw new Error('budget probe down');
        },
      });
      const outcome = await h.walker.start({
        runId: 'r-gate-throw',
        plan: twoTaskPlan(),
        repoPath: '/fake/repo',
        budget: BUDGET_100_TURNS,
      });
      expect(outcome).toBe('success');
      expect(h.spawns).toEqual(['a', 'b']);
      expect(h.emitted.filter((e) => e.type === 'resource.exceeded')).toHaveLength(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('extraBudgetCheck exceeded pre-dispatch → kind=tokens, second task never launches', async () => {
    // No usage events → checkBudget never runs; the gate is the only caller.
    // 1st gate call (before task a) passes; 2nd (before task b) trips.
    let calls = 0;
    const h = makeHarness({
      extraBudgetCheck: async () => {
        calls += 1;
        return calls >= 2
          ? { exceeded: true, reason: 'autopilot token cap' }
          : { exceeded: false, reason: null };
      },
    });
    const outcome = await h.walker.start({
      runId: 'r-gate-tokens',
      plan: twoTaskPlan(),
      repoPath: '/fake/repo',
      budget: BUDGET_100_TURNS,
    });
    expect(outcome).toBe('budget_exceeded');
    expect(h.spawns).toEqual(['a']);
    const exceeded = h.emitted.find((e) => e.type === 'resource.exceeded');
    expect(exceeded?.type === 'resource.exceeded' && exceeded.payload.kind).toBe('tokens');
  });
});
