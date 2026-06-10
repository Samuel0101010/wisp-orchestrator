import { describe, it, expect, vi } from 'vitest';
import type { HarnessEvent, Plan, Team, TaskNode } from '@wisp/schemas';
import {
  Walker,
  composeTaskPrompt,
  defaultIsQARole,
  isBuilderReplanFailure,
  BUILDER_REPLAN_SIGNATURES,
  type BudgetConfig,
  type TaskState,
  type WalkerDeps,
} from '../walker.js';
import type { VerificationResult } from '../verification.js';
import type { RunClaudeOpts } from '../subprocess.js';

// ---------- fakes ----------

interface FakeTask {
  /** A scripted sequence of events to emit when this task is spawned. */
  events?: HarnessEvent[];
  /** If set, hold the task at this gate until released. */
  gate?: { release: () => void; promise: Promise<void> };
  /** Optional override for what the iterator yields after the gate releases. */
  finishWith?: HarnessEvent[];
}

interface FakePoolOpts {
  scriptByTaskId: Map<string, FakeTask[]>;
  /** Records each spawn for later assertions. */
  spawns: Array<{ taskId: string; opts: RunClaudeOpts }>;
}

function makeFakePool(opts: FakePoolOpts): {
  pool: { run: (opts: RunClaudeOpts) => AsyncIterable<HarnessEvent>; maxParallel: number };
  setMaxParallel: (n: number) => void;
} {
  let max = 99;
  const counters = new Map<string, number>();
  return {
    pool: {
      get maxParallel() {
        return max;
      },
      run(o: RunClaudeOpts): AsyncIterable<HarnessEvent> {
        const id = o.taskId;
        opts.spawns.push({ taskId: id, opts: o });
        const list = opts.scriptByTaskId.get(id) ?? [];
        const idx = counters.get(id) ?? 0;
        counters.set(id, idx + 1);
        const script = list[idx] ?? {
          events: [
            { type: 'task.completed', payload: { taskId: id, outcome: 'pass', exitCode: 0 } },
          ],
        };
        return (async function* () {
          if (script.events) {
            for (const ev of script.events) yield ev;
          }
          if (script.gate) {
            await script.gate.promise;
            // If aborted via signal during gate, exit early.
            if (o.signal?.aborted) {
              yield {
                type: 'task.failed',
                payload: { taskId: id, error: 'aborted' },
              };
              return;
            }
          }
          if (script.finishWith) {
            for (const ev of script.finishWith) yield ev;
          } else if (
            !script.events?.some((e) => e.type === 'task.completed' || e.type === 'task.failed')
          ) {
            yield { type: 'task.completed', payload: { taskId: id, outcome: 'pass', exitCode: 0 } };
          }
        })();
      },
    },
    setMaxParallel: (n) => {
      max = n;
    },
  };
}

function makeWorktreeFake(): WalkerDeps['worktree'] & { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  return {
    added,
    removed,
    async add({ branchName }) {
      added.push(branchName);
      return `/fake/wt/${branchName.replace(/[^a-zA-Z0-9]+/g, '-')}`;
    },
    async remove({ worktreePath }) {
      removed.push(worktreePath);
    },
  };
}

interface FakeTimers {
  setTimeout: WalkerDeps['setTimeout'];
  advance: (ms: number) => void;
  pending: () => number;
  now: () => number;
  setNow: (ms: number) => void;
}

function makeFakeTimers(start = 0): FakeTimers {
  let now = start;
  let nextId = 1;
  const queue = new Map<number, { fireAt: number; cb: () => void }>();
  return {
    setNow: (n) => {
      now = n;
    },
    now: () => now,
    pending: () => queue.size,
    setTimeout(cb, ms) {
      const id = nextId++;
      queue.set(id, { fireAt: now + ms, cb });
      return () => {
        queue.delete(id);
      };
    },
    advance(ms) {
      now += ms;
      // Drain any due callbacks (in registration order).
      const due: Array<[number, { fireAt: number; cb: () => void }]> = [];
      for (const [id, entry] of queue) {
        if (entry.fireAt <= now) due.push([id, entry]);
      }
      due.sort((a, b) => a[0] - b[0]);
      for (const [id, entry] of due) {
        queue.delete(id);
        entry.cb();
      }
    },
  };
}

// ---------- plan helpers ----------

const FILLER = 'x'.repeat(80);

function makeTeam(): Team {
  return {
    roles: [
      { role: 'architect', model: 'opus', allowedTools: ['Read'], systemPrompt: `arch ${FILLER}` },
      {
        role: 'developer',
        model: 'sonnet',
        allowedTools: ['Read', 'Edit'],
        systemPrompt: `dev ${FILLER}`,
      },
      { role: 'qa', model: 'sonnet', allowedTools: ['Read'], systemPrompt: `qa ${FILLER}` },
    ],
  };
}

function node(id: string, role: TaskNode['role'], deps: string[] = []): TaskNode {
  return {
    id,
    role,
    prompt: `do ${id}`,
    deps,
    successCriteria: {},
    maxTurns: 5,
  };
}

function makePlan(nodes: TaskNode[]): Plan {
  const edges = nodes.flatMap((n) => n.deps.map((d) => ({ from: d, to: n.id })));
  return { goal: 'g', team: makeTeam(), nodes, edges };
}

// ---------- harness ----------

interface Harness {
  walker: Walker;
  deps: WalkerDeps;
  emitted: HarnessEvent[];
  spawns: Array<{ taskId: string; opts: RunClaudeOpts }>;
  worktree: ReturnType<typeof makeWorktreeFake>;
  timers: FakeTimers;
  taskStates: Map<string, TaskState>;
  runStateLog: Array<Parameters<WalkerDeps['onRunState']>[1]>;
  setVerify: (fn: WalkerDeps['verify']) => void;
}

function makeHarness(args: {
  scriptByTaskId?: Map<string, FakeTask[]>;
  maxParallel?: number;
  defaultVerify?: (
    cwd: string,
    criteria: import('../verification.js').SuccessCriteria,
  ) => Promise<VerificationResult>;
  probeSubprocessLiveness?: WalkerDeps['probeSubprocessLiveness'];
}): Harness {
  const emitted: HarnessEvent[] = [];
  const spawns: Array<{ taskId: string; opts: RunClaudeOpts }> = [];
  const fake = makeFakePool({ scriptByTaskId: args.scriptByTaskId ?? new Map(), spawns });
  fake.setMaxParallel(args.maxParallel ?? 99);
  const wt = makeWorktreeFake();
  const timers = makeFakeTimers();
  const taskStates = new Map<string, TaskState>();
  const runStateLog: Array<Parameters<WalkerDeps['onRunState']>[1]> = [];
  let verifyFn: WalkerDeps['verify'] =
    args.defaultVerify ?? (async () => ({ pass: true, output: 'ok', failures: [] }));

  const deps: WalkerDeps = {
    pool: fake.pool as unknown as WalkerDeps['pool'],
    worktree: wt,
    verify: (cwd, criteria, opts) => verifyFn(cwd, criteria, opts),
    emit: (ev) => {
      emitted.push(ev);
    },
    onTaskState: async (id, patch) => {
      taskStates.set(id, { ...taskStates.get(id), ...patch });
    },
    onRunState: async (_id, patch) => {
      runStateLog.push(patch);
    },
    snapshot: async () => '/fake/snap.json',
    setTimeout: timers.setTimeout,
    now: timers.now,
    autoCommit: async () => 'a'.repeat(40),
    mergeBranches: async () => ({ ok: true }),
    interTaskPacingMs: 0,
    autoResumeRateLimit: true,
    probeSubprocessLiveness: args.probeSubprocessLiveness,
  };

  const walker = new Walker(deps);

  return {
    walker,
    deps,
    emitted,
    spawns,
    worktree: wt,
    timers,
    taskStates,
    runStateLog,
    setVerify: (fn) => {
      verifyFn = fn;
    },
  };
}

const DEFAULT_BUDGET: BudgetConfig = { budgetMinutes: 60, budgetTurns: 1000, maxParallel: 99 };

// ---------- tests ----------

describe('Walker — topological dispatch', () => {
  it('runs A → B → C in order, emitting run.completed(success)', async () => {
    const h = makeHarness({});
    const plan = makePlan([
      node('a', 'architect'),
      node('b', 'developer', ['a']),
      node('c', 'qa', ['b']),
    ]);
    const outcome = await h.walker.start({
      runId: 'r1',
      plan,
      repoPath: '/fake/repo',
      budget: { ...DEFAULT_BUDGET, maxParallel: 1 },
    });
    expect(outcome).toBe('success');
    const order = h.spawns.map((s) => s.taskId);
    expect(order).toEqual(['a', 'b', 'c']);
    const last = h.emitted[h.emitted.length - 1];
    expect(last?.type).toBe('run.completed');
    if (last?.type === 'run.completed') {
      expect(last.payload.outcome).toBe('success');
    }
  });

  it('runs A and B in parallel up to maxParallel=2 then C', async () => {
    const releaseA = createGate();
    const releaseB = createGate();
    const scripts = new Map<string, FakeTask[]>([
      ['a', [{ gate: releaseA }]],
      ['b', [{ gate: releaseB }]],
      ['c', [{}]],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts });
    const plan = makePlan([
      node('a', 'architect'),
      node('b', 'developer'),
      node('c', 'qa', ['a', 'b']),
    ]);

    const startPromise = h.walker.start({
      runId: 'r2',
      plan,
      repoPath: '/fake/repo',
      budget: { ...DEFAULT_BUDGET, maxParallel: 2 },
    });

    // Wait microtasks: both A and B should be spawned (no slot 3rd until C deps satisfied).
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const initialIds = h.spawns.map((s) => s.taskId).sort();
    expect(initialIds).toEqual(['a', 'b']);

    // Release A then B.
    releaseA.release();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    releaseB.release();
    const outcome = await startPromise;
    expect(outcome).toBe('success');
    expect(h.spawns.map((s) => s.taskId).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('Walker — failure modes', () => {
  it('marks one task failed → run.completed(failure), other branch still completes', async () => {
    const scripts = new Map<string, FakeTask[]>([
      [
        'a',
        [
          {
            events: [{ type: 'task.failed', payload: { taskId: 'a', error: 'boom' } }],
            finishWith: [],
          },
          // retry script: still fails
          {
            events: [{ type: 'task.failed', payload: { taskId: 'a', error: 'boom2' } }],
            finishWith: [],
          },
        ],
      ],
      ['b', [{}]],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts });
    const plan = makePlan([node('a', 'architect'), node('b', 'developer')]);
    const outcome = await h.walker.start({
      runId: 'r3',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });
    expect(outcome).toBe('failure');
    expect(h.walker.status().taskStates['a']).toBe('failed');
    expect(h.walker.status().taskStates['b']).toBe('done');
    expect(h.walker.status().retries['a']).toBe(1);
  });

  it('emits harness.verify-failed when verification gate fails', async () => {
    const h = makeHarness({
      defaultVerify: async () => ({
        pass: false,
        output: 'lint: undefined var foo',
        failures: [{ kind: 'lint' as const, cmd: 'pnpm lint', exitCode: 1, tail: 'foo' }],
      }),
    });
    const plan = makePlan([node('t1', 'architect')]);
    await h.walker.start({ runId: 'r1', plan, repoPath: '/fake', budget: DEFAULT_BUDGET });
    const events = h.emitted.filter((x) => x.type === 'harness.verify-failed');
    expect(events).toHaveLength(2);
    expect(events[0]!.payload.failures[0].kind).toBe('lint');
    expect(events[0]!.payload.attempt).toBe(1);
    expect(events[1]!.payload.attempt).toBe(2);
  });

  it('verification fails first, retry succeeds → task done with retries=1', async () => {
    let calls = 0;
    const h = makeHarness({
      defaultVerify: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            pass: false,
            output: 'lint failed',
            failures: [{ kind: 'lint', cmd: 'lint', exitCode: 1, tail: 'oops' }],
          };
        }
        return { pass: true, output: 'ok', failures: [] };
      },
    });
    const plan = makePlan([node('a', 'architect')]);
    plan.nodes[0]!.successCriteria = { lint: 'pnpm lint' };

    const outcome = await h.walker.start({
      runId: 'r4',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });
    expect(outcome).toBe('success');
    expect(h.walker.status().retries['a']).toBe(1);
    // Two spawns: original + retry.
    expect(h.spawns.length).toBe(2);
    // Second spawn's prompt should mention "verification failed".
    expect(h.spawns[1]!.opts.prompt).toMatch(/verification failed/);
  });

  it('fails the task gracefully when its role is not in team.roles', async () => {
    const h = makeHarness({});
    // Build a plan where the node references a role the team does not have.
    const plan: Plan = {
      goal: 'g',
      team: {
        roles: [
          {
            role: 'architect',
            model: 'sonnet',
            allowedTools: ['Read'],
            systemPrompt: 'a'.repeat(60),
          },
        ],
      },
      nodes: [
        {
          id: 't1',
          role: 'mystery',
          prompt: 'p',
          deps: [],
          successCriteria: {},
          maxTurns: 5,
        },
      ],
      edges: [],
    };
    const outcome = await h.walker.start({
      runId: 'rmiss',
      plan,
      repoPath: '/fake',
      budget: DEFAULT_BUDGET,
    });
    expect(outcome).toBe('failure');
    const ev = h.emitted.find((e) => e.type === 'task.failed');
    expect(ev).toBeDefined();
    expect(ev!.payload.error).toContain("role 'mystery' not in team");
    // No worktree should have been added for the failed task.
    expect(h.worktree.added.length).toBe(0);
  });
});

describe('Walker — rate-limit pause/resume', () => {
  it('pauses on rate-limit.hit, resumes after fake timer advances', async () => {
    const resetAt = 5_000;
    const scripts = new Map<string, FakeTask[]>([
      [
        'a',
        [
          {
            events: [
              {
                type: 'rate-limit.hit',
                payload: { runId: 'r5', taskId: 'a', resetAt, source: 'stdout-marker' },
              },
              { type: 'task.failed', payload: { taskId: 'a', error: 'rate-limited' } },
            ],
            finishWith: [],
          },
          // After resume, succeed.
          {},
        ],
      ],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts });
    const plan = makePlan([node('a', 'architect')]);
    const startPromise = h.walker.start({
      runId: 'r5',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });

    // Let the first attempt drain.
    await waitForEvent(h.emitted, 'run.paused');
    expect(h.walker.status().state).toBe('paused');
    expect(h.walker.status().pausedReason).toBe('rate-limit');

    // Advance fake timer past resetAt — auto-resume fires.
    h.timers.advance(resetAt + 1);

    const outcome = await startPromise;
    expect(outcome).toBe('success');
    const types = h.emitted.map((e) => e.type);
    expect(types).toContain('run.paused');
    expect(types).toContain('run.resumed');
    expect(types[types.length - 1]).toBe('run.completed');
  });
});

describe('Walker — budget exceeded', () => {
  it('cancels with outcome=budget_exceeded when turns budget hit', async () => {
    const scripts = new Map<string, FakeTask[]>([
      [
        'a',
        [
          {
            events: [
              {
                type: 'task.usage',
                payload: { taskId: 'a', tokensIn: 10, tokensOut: 10, turns: 100 },
              },
            ],
            // After usage event, walker will cancel; the task subprocess will be aborted.
            finishWith: [
              { type: 'task.completed', payload: { taskId: 'a', outcome: 'pass', exitCode: 0 } },
            ],
          },
        ],
      ],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts });
    const plan = makePlan([node('a', 'architect')]);
    const outcome = await h.walker.start({
      runId: 'r6',
      plan,
      repoPath: '/fake/repo',
      budget: { ...DEFAULT_BUDGET, budgetTurns: 50 },
    });
    expect(outcome).toBe('budget_exceeded');
    const types = h.emitted.map((e) => e.type);
    expect(types).toContain('resource.exceeded');
  });

  it('treats budgetTurns=null as unlimited — never aborts on turns', async () => {
    // Drive a task that would have tripped a finite-cap (200 turns >= 50)
    // but verify the walker runs to completion when the cap is null.
    const scripts = new Map<string, FakeTask[]>([
      [
        'a',
        [
          {
            events: [
              { type: 'task.usage', payload: { taskId: 'a', tokensIn: 1, tokensOut: 1, turns: 1 } },
              {
                type: 'task.usage',
                payload: { taskId: 'a', tokensIn: 1, tokensOut: 1, turns: 200 },
              },
              { type: 'task.completed', payload: { taskId: 'a', outcome: 'pass', exitCode: 0 } },
            ],
          },
        ],
      ],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts });
    const plan = makePlan([node('a', 'architect')]);
    const outcome = await h.walker.start({
      runId: 'r-unlimited-turns',
      plan,
      repoPath: '/fake/repo',
      budget: { budgetMinutes: null, budgetTurns: null, maxParallel: 1 },
    });
    expect(outcome).toBe('success');
    // No resource.exceeded at all — confirms the null-skip path.
    const exceeded = h.emitted.filter((e) => e.type === 'resource.exceeded');
    expect(exceeded).toHaveLength(0);
    // And no premature warning either.
    const warnings = h.emitted.filter((e) => e.type === 'resource.warning');
    expect(warnings).toHaveLength(0);
  });

  it('emits resource.warning at 80% turns once', async () => {
    const scripts = new Map<string, FakeTask[]>([
      [
        'a',
        [
          {
            events: [
              {
                type: 'task.usage',
                payload: { taskId: 'a', tokensIn: 0, tokensOut: 0, turns: 80 },
              },
              { type: 'task.usage', payload: { taskId: 'a', tokensIn: 0, tokensOut: 0, turns: 5 } },
            ],
          },
        ],
      ],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts });
    const plan = makePlan([node('a', 'architect')]);
    const outcome = await h.walker.start({
      runId: 'r7',
      plan,
      repoPath: '/fake/repo',
      budget: { ...DEFAULT_BUDGET, budgetTurns: 100 },
    });
    expect(outcome).toBe('success');
    const warnings = h.emitted.filter(
      (e) => e.type === 'resource.warning' && e.payload.kind === 'turns',
    );
    expect(warnings).toHaveLength(1);
  });
});

describe('Walker — cumulative usage accounting', () => {
  it('treats task.usage as cumulative (Math.max) and run-totals add only the delta', async () => {
    const scripts = new Map<string, FakeTask[]>([
      [
        'a',
        [
          {
            events: [
              {
                type: 'task.usage',
                payload: { taskId: 'a', tokensIn: 100, tokensOut: 50, turns: 1 },
              },
              {
                type: 'task.usage',
                payload: { taskId: 'a', tokensIn: 250, tokensOut: 120, turns: 3 },
              },
            ],
          },
        ],
      ],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts });
    const plan = makePlan([node('a', 'architect')]);
    const outcome = await h.walker.start({
      runId: 'r-cumulative',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });
    expect(outcome).toBe('success');

    const aState = h.taskStates.get('a')!;
    // Per-task counters should reflect the LATER cumulative event, not a sum.
    expect(aState.tokensIn).toBe(250);
    expect(aState.tokensOut).toBe(120);
    expect(aState.turnsUsed).toBe(3);

    // Run-state log should contain final totals = the last cumulative values
    // (NOT 100+250=350 etc.).
    const lastTotals = h.runStateLog.filter(
      (p): p is { tokensInTotal: number; tokensOutTotal: number; turnsTotal: number } =>
        p.tokensInTotal !== undefined,
    );
    const finalTotals = lastTotals[lastTotals.length - 1];
    expect(finalTotals.tokensInTotal).toBe(250);
    expect(finalTotals.tokensOutTotal).toBe(120);
    expect(finalTotals.turnsTotal).toBe(3);
  });
});

describe('Walker — initialState (E2 resume rebuild)', () => {
  it('skips completedTaskIds, re-launches resumableTasks with --resume sessionId, dispatches pending fresh', async () => {
    // Plan: a (architect) → b (developer) → c (qa) → d (qa).
    // Pre-seed: a=done, b=resumable(sessionId=s-b), c=pending, d=failed.
    const scripts = new Map<string, FakeTask[]>([
      ['b', [{}]],
      ['c', [{}]],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts });
    const plan = makePlan([
      node('a', 'architect'),
      node('b', 'developer', ['a']),
      node('c', 'qa', ['b']),
      node('d', 'qa', ['c']),
    ]);

    const outcome = await h.walker.start({
      runId: 'r-resume-1',
      plan,
      repoPath: '/fake/repo',
      budget: { ...DEFAULT_BUDGET, maxParallel: 1 },
      initialState: {
        completedTaskIds: ['a'],
        failedTaskIds: ['d'],
        resumableTasks: [{ taskId: 'b', sessionId: 's-b' }],
      },
    });

    // 'd' was pre-seeded failed → run failure outcome (since one terminal failed).
    expect(outcome).toBe('failure');

    // Only 'b' and 'c' should have been spawned. 'a' and 'd' must NOT be spawned.
    const spawned = h.spawns.map((s) => s.taskId);
    expect(spawned.sort()).toEqual(['b', 'c']);

    // 'b' should have been launched with resumeSessionId=s-b.
    const bSpawn = h.spawns.find((s) => s.taskId === 'b');
    expect(bSpawn?.opts.resumeSessionId).toBe('s-b');

    // 'c' has no sessionId → no resume.
    const cSpawn = h.spawns.find((s) => s.taskId === 'c');
    expect(cSpawn?.opts.resumeSessionId).toBeUndefined();

    // Final task states: a=done (pre), b=done, c=done, d=failed (pre).
    const states = h.walker.status().taskStates;
    expect(states['a']).toBe('done');
    expect(states['b']).toBe('done');
    expect(states['c']).toBe('done');
    expect(states['d']).toBe('failed');
  });

  it('finalizes immediately when all tasks are pre-seeded done', async () => {
    const h = makeHarness({});
    const plan = makePlan([node('a', 'architect'), node('b', 'developer', ['a'])]);
    const outcome = await h.walker.start({
      runId: 'r-resume-2',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
      initialState: {
        completedTaskIds: ['a', 'b'],
        failedTaskIds: [],
        resumableTasks: [],
      },
    });
    expect(outcome).toBe('success');
    expect(h.spawns).toHaveLength(0);
  });
});

describe('Walker — pauseForShutdown', () => {
  it('pauses with reason=shutdown, runs settle', async () => {
    const gate = createGate();
    const scripts = new Map<string, FakeTask[]>([['a', [{ gate }]]]);
    const h = makeHarness({ scriptByTaskId: scripts });
    const plan = makePlan([node('a', 'architect')]);

    const startPromise = h.walker.start({
      runId: 'r-shutdown-1',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });
    // Wait for spawn.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(h.spawns).toHaveLength(1);

    // Trigger graceful shutdown pause.
    void h.walker.pauseForShutdown();
    // Release gate so subprocess generator finishes.
    gate.release();

    // Observe the run.paused event with reason=shutdown.
    await waitForEvent(h.emitted, 'run.paused');
    const paused = h.emitted.find((e) => e.type === 'run.paused');
    expect(paused?.type).toBe('run.paused');
    if (paused?.type === 'run.paused') {
      expect(paused.payload.pausedReason).toBe('shutdown');
      expect(paused.payload.resumeAt).toBeNull();
    }

    // Walker stays paused — start() resolves only when we cancel/resume.
    await h.walker.cancel();
    await startPromise;
  });
});

describe('Walker — verifier cancellation (M1)', () => {
  it('forwards the per-task abort signal to runVerification', async () => {
    let signalSeen: AbortSignal | null = null;
    let abortedDuringVerify = false;
    const verifyGate = createGate();
    const h = makeHarness({
      defaultVerify: async (_cwd, _criteria, opts) => {
        signalSeen = opts?.signal ?? null;
        // Wait for the test to release us; resolve early if signal aborts.
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) {
            abortedDuringVerify = true;
            resolve();
            return;
          }
          opts?.signal?.addEventListener(
            'abort',
            () => {
              abortedDuringVerify = true;
              resolve();
            },
            { once: true },
          );
          void verifyGate.promise.then(() => resolve());
        });
        if (abortedDuringVerify) {
          return {
            pass: false,
            output: 'aborted',
            failures: [{ kind: 'custom', cmd: 'verify', exitCode: 130, tail: 'aborted' }],
          };
        }
        return { pass: true, output: 'ok', failures: [] };
      },
    });
    const plan = makePlan([node('a', 'architect')]);
    plan.nodes[0]!.successCriteria = { custom: 'pretend-verify' };

    const startPromise = h.walker.start({
      runId: 'r-verify-cancel',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });
    // Wait until verify has started (signal observed).
    for (let i = 0; i < 20 && signalSeen === null; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(signalSeen).not.toBeNull();
    // Cancel mid-verify.
    await h.walker.cancel();
    // Release the gate so the verifier resolves either way.
    verifyGate.release();
    await startPromise;
    expect(abortedDuringVerify).toBe(true);
  });
});

describe('Walker — cancel', () => {
  it('removes worktrees of running tasks on user-cancel (outcome=cancelled)', async () => {
    const gate = createGate();
    const scripts = new Map<string, FakeTask[]>([['a', [{ gate }]]]);
    const h = makeHarness({ scriptByTaskId: scripts });
    const plan = makePlan([node('a', 'architect')]);
    const startPromise = h.walker.start({
      runId: 'r-cancel-cleanup',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(h.spawns).toHaveLength(1);
    expect(h.worktree.added).toHaveLength(1);

    await h.walker.cancel();
    gate.release();
    const outcome = await startPromise;
    expect(outcome).toBe('cancelled');
    // Worktree of the running task was removed by cancel.
    expect(h.worktree.removed.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT remove worktrees on budget_exceeded (forensic preservation)', async () => {
    const scripts = new Map<string, FakeTask[]>([
      [
        'a',
        [
          {
            events: [
              {
                type: 'task.usage',
                payload: { taskId: 'a', tokensIn: 1, tokensOut: 1, turns: 100 },
              },
            ],
            // Hold the task open until walker cancels via budget exceeded.
            gate: createGate(),
          },
        ],
      ],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts });
    const plan = makePlan([node('a', 'architect')]);
    const outcome = await h.walker.start({
      runId: 'r-budget-cleanup',
      plan,
      repoPath: '/fake/repo',
      budget: { ...DEFAULT_BUDGET, budgetTurns: 50 },
    });
    expect(outcome).toBe('budget_exceeded');
    // budget_exceeded should NOT trigger worktree removal during cancel().
    // (Successfully-completed tasks remove their worktrees in runTask, but
    // here the task was aborted, not completed.)
    expect(h.worktree.removed).toHaveLength(0);
  });

  it('cancel() aborts running tasks, run.completed has outcome=cancelled', async () => {
    const gate = createGate();
    const scripts = new Map<string, FakeTask[]>([['a', [{ gate }]]]);
    const h = makeHarness({ scriptByTaskId: scripts });
    const plan = makePlan([node('a', 'architect')]);

    const startPromise = h.walker.start({
      runId: 'r8',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });
    // Give dispatch + worktree.add + first event drain a chance.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(h.spawns.length).toBe(1);

    await h.walker.cancel();
    // Release gate so the task generator finishes (doesn't matter — walker is done).
    gate.release();

    const outcome = await startPromise;
    expect(outcome).toBe('cancelled');
    const last = h.emitted[h.emitted.length - 1];
    expect(last?.type).toBe('run.completed');
    if (last?.type === 'run.completed') {
      expect(last.payload.outcome).toBe('cancelled');
    }
  });
});

describe('Walker — D1: autoResumeRateLimit flag', () => {
  function makeRateLimitHarness(autoResumeRateLimit: boolean, runId: string) {
    const resetAt = 5_000;
    const scripts = new Map<string, FakeTask[]>([
      [
        'a',
        [
          {
            events: [
              {
                type: 'rate-limit.hit' as const,
                payload: { runId, taskId: 'a', resetAt, source: 'stdout-marker' as const },
              },
              { type: 'task.failed' as const, payload: { taskId: 'a', error: 'rate-limited' } },
            ],
            finishWith: [],
          },
          // Second attempt (after resume): succeeds.
          {},
        ],
      ],
    ]);

    const emitted: HarnessEvent[] = [];
    const spawns: Array<{ taskId: string; opts: RunClaudeOpts }> = [];
    const fake = makeFakePool({ scriptByTaskId: scripts, spawns });
    fake.setMaxParallel(99);
    const wt = makeWorktreeFake();
    const timers = makeFakeTimers();
    const taskStates = new Map<string, TaskState>();
    const runStateLog: Array<Parameters<WalkerDeps['onRunState']>[1]> = [];

    const deps: WalkerDeps = {
      pool: fake.pool as unknown as WalkerDeps['pool'],
      worktree: wt,
      verify: async () => ({ pass: true, output: 'ok', failures: [] }),
      emit: (ev) => {
        emitted.push(ev);
      },
      onTaskState: async (id, patch) => {
        taskStates.set(id, { ...taskStates.get(id), ...patch });
      },
      onRunState: async (_id, patch) => {
        runStateLog.push(patch);
      },
      snapshot: async () => '/fake/snap.json',
      setTimeout: timers.setTimeout,
      now: timers.now,
      autoCommit: async () => 'a'.repeat(40),
      mergeBranches: async () => ({ ok: true }),
      interTaskPacingMs: 0,
      autoResumeRateLimit,
    };

    return { walker: new Walker(deps), emitted, timers, resetAt };
  }

  it('rate-limit pause does NOT schedule auto-resume when autoResumeRateLimit=false', async () => {
    const runId = 'r-d1-off';
    const { walker, emitted, timers, resetAt } = makeRateLimitHarness(false, runId);
    const plan = makePlan([node('a', 'architect')]);

    const startPromise = walker.start({
      runId,
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });

    // Wait for the rate-limit pause.
    await waitForEvent(emitted, 'run.paused');
    expect(walker.status().state).toBe('paused');
    expect(walker.status().pausedReason).toBe('rate-limit');

    // Advance well past resetAt and the 5h default — auto-resume must NOT fire.
    timers.advance(resetAt + 5 * 60 * 60 * 1000 + 1);
    await new Promise((r) => setImmediate(r));

    // Still paused — user must resume manually.
    expect(walker.status().state).toBe('paused');

    // Cleanup.
    await walker.cancel();
    await startPromise;
  });

  it('rate-limit pause DOES schedule auto-resume when autoResumeRateLimit=true', async () => {
    const runId = 'r-d1-on';
    const { walker, emitted, timers, resetAt } = makeRateLimitHarness(true, runId);
    const plan = makePlan([node('a', 'architect')]);

    const startPromise = walker.start({
      runId,
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });

    // Wait for the rate-limit pause.
    await waitForEvent(emitted, 'run.paused');
    expect(walker.status().state).toBe('paused');
    expect(walker.status().pausedReason).toBe('rate-limit');

    // Advance past resetAt — auto-resume fires.
    timers.advance(resetAt + 1);

    const outcome = await startPromise;
    expect(outcome).toBe('success');
    const types = emitted.map((e) => e.type);
    expect(types).toContain('run.resumed');
  });
});

describe('Walker — D3: consecutive-failures pause', () => {
  it('pauses with reason consecutive-failures after 3 task failures in a row', async () => {
    // Three independent tasks all failing terminally (2 retries each, so the
    // pool script needs 2 fail entries per task to exhaust the retry).
    const failScript = (id: string): FakeTask[] => [
      {
        events: [{ type: 'task.failed', payload: { taskId: id, error: 'boom' } }],
        finishWith: [],
      },
      {
        events: [{ type: 'task.failed', payload: { taskId: id, error: 'boom2' } }],
        finishWith: [],
      },
    ];
    const scripts = new Map<string, FakeTask[]>([
      ['t1', failScript('t1')],
      ['t2', failScript('t2')],
      ['t3', failScript('t3')],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts, maxParallel: 1 });
    const plan = makePlan([node('t1', 'architect'), node('t2', 'developer'), node('t3', 'qa')]);

    const startPromise = h.walker.start({
      runId: 'r-d3-pause',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });

    // Wait for the walker to pause after 3 consecutive failures.
    await waitForEvent(h.emitted, 'run.paused');

    expect(h.walker.status().state).toBe('paused');
    expect(h.walker.status().pausedReason).toBe('consecutive-failures');
    expect(h.runStateLog).toEqual(
      expect.arrayContaining([expect.objectContaining({ pausedReason: 'consecutive-failures' })]),
    );

    // Cleanup.
    await h.walker.cancel();
    await startPromise;
  });

  it('resets consecutive-failures counter on a task success', async () => {
    // t1 fails (terminal, retries exhausted): consecutiveFailures → 1
    // t2 fails (terminal):                    consecutiveFailures → 2
    // t3 succeeds:                            consecutiveFailures → 0
    // t4 fails (terminal):                    consecutiveFailures → 1
    // t5 fails (terminal):                    consecutiveFailures → 2
    // → only 2 failures after the reset, so threshold of 3 is never reached.
    const failScript = (id: string): FakeTask[] => [
      {
        events: [{ type: 'task.failed', payload: { taskId: id, error: 'boom' } }],
        finishWith: [],
      },
      {
        events: [{ type: 'task.failed', payload: { taskId: id, error: 'boom2' } }],
        finishWith: [],
      },
    ];
    const scripts = new Map<string, FakeTask[]>([
      ['t1', failScript('t1')],
      ['t2', failScript('t2')],
      // t3 uses the default (success) script — no entry needed
      ['t4', failScript('t4')],
      ['t5', failScript('t5')],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts, maxParallel: 1 });
    const plan = makePlan([
      node('t1', 'architect'),
      node('t2', 'developer'),
      node('t3', 'qa'),
      node('t4', 'architect'),
      node('t5', 'developer'),
    ]);

    const outcome = await h.walker.start({
      runId: 'r-d3-reset',
      plan,
      repoPath: '/fake/repo',
      // maxParallel: 1 at the WALKER level (dispatch enforces budget.maxParallel;
      // the harness arg above only caps the fake pool, which the walker ignores)
      // so the t1✗ → t2✗ → t3✓(reset) → t4✗ → t5✗ order this test's comment
      // describes is deterministic instead of depending on the microtask
      // interleaving of 5 parallel tasks.
      budget: { ...DEFAULT_BUDGET, maxParallel: 1 },
    });

    // Walker should complete (failure outcome due to failed tasks), not pause.
    expect(outcome).toBe('failure');
    expect(h.walker.status().state).toBe('completed');
    // Must NOT have emitted run.paused with consecutive-failures reason.
    const pausedEvent = h.emitted.find(
      (e) => e.type === 'run.paused' && e.payload.pausedReason === 'consecutive-failures',
    );
    expect(pausedEvent).toBeUndefined();
  });
});

describe('composeTaskPrompt — retry-error truncation', () => {
  it('caps retry-error context to head + tail with omission marker', () => {
    const huge = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const plan = makePlan([node('t1', 'developer')]);
    const out = composeTaskPrompt(plan, plan.nodes[0]!, huge);
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain('line 0');
    expect(out).toContain('line 499');
    expect(out).toContain('[…');
    expect(out).toContain('lines omitted');
  });

  it('passes through small retry-error unchanged', () => {
    const small = 'short error\nwith two lines';
    const plan = makePlan([node('t1', 'developer')]);
    const out = composeTaskPrompt(plan, plan.nodes[0]!, small);
    expect(out).toContain(small);
    expect(out).not.toContain('omitted');
  });

  it('lists preflight ahead of build/test/lint in the success-criteria block', () => {
    const n: TaskNode = {
      id: 't1',
      role: 'developer',
      prompt: 'do t1',
      deps: [],
      successCriteria: {
        preflight: 'pnpm install',
        build: 'pnpm build',
        test: 'pnpm test',
      },
      maxTurns: 5,
    };
    const plan = makePlan([n]);
    const out = composeTaskPrompt(plan, plan.nodes[0]!, null);
    expect(out).toContain('- preflight: `pnpm install` (runs once before the rest)');
    expect(out).toContain('- build: `pnpm build`');
    expect(out).toContain('- test: `pnpm test`');
    // Order matters — preflight appears before the others so the agent sees
    // it as the first gate.
    expect(out.indexOf('- preflight:')).toBeLessThan(out.indexOf('- build:'));
  });

  it('emits the "## Project context" section when briefContext is provided', () => {
    const plan = makePlan([node('t1', 'developer')]);
    const brief = '## Project context\n\nDesign preferences: dark, minimal\nPlatform: web';
    const out = composeTaskPrompt(plan, plan.nodes[0]!, null, undefined, brief);
    expect(out).toContain('## Project context');
    expect(out).toContain('Design preferences: dark, minimal');
    // Placed after the goal and before the task.
    expect(out.indexOf('# Goal')).toBeLessThan(out.indexOf('## Project context'));
    expect(out.indexOf('## Project context')).toBeLessThan(out.indexOf('# Task:'));
  });

  it('omits the project-context section when briefContext is null/empty', () => {
    const plan = makePlan([node('t1', 'developer')]);
    expect(composeTaskPrompt(plan, plan.nodes[0]!, null, undefined, undefined)).not.toContain(
      '## Project context',
    );
    expect(composeTaskPrompt(plan, plan.nodes[0]!, null, undefined, '   ')).not.toContain(
      '## Project context',
    );
  });

  it('emits the "## Existing codebase" section between brief and task when set', () => {
    const plan = makePlan([node('t1', 'developer')]);
    const brief = '## Project context\n\nPlatform: web';
    const codebase =
      '## Existing codebase\n\nMODIFY the existing code.\n\n```\nsrc/\n  index.ts\n```';
    const out = composeTaskPrompt(plan, plan.nodes[0]!, null, undefined, brief, codebase);
    expect(out).toContain('## Existing codebase');
    expect(out).toContain('src/');
    // Order locked: # Goal → brief → codebase → # Task:
    expect(out.indexOf('# Goal')).toBeLessThan(out.indexOf('## Project context'));
    expect(out.indexOf('## Project context')).toBeLessThan(out.indexOf('## Existing codebase'));
    expect(out.indexOf('## Existing codebase')).toBeLessThan(out.indexOf('# Task:'));
  });

  it('places the codebase section after the goal when there is no brief', () => {
    const plan = makePlan([node('t1', 'developer')]);
    const codebase = '## Existing codebase\n\nMODIFY the existing code.';
    const out = composeTaskPrompt(plan, plan.nodes[0]!, null, undefined, undefined, codebase);
    expect(out.indexOf('# Goal')).toBeLessThan(out.indexOf('## Existing codebase'));
    expect(out.indexOf('## Existing codebase')).toBeLessThan(out.indexOf('# Task:'));
  });

  it('omits the codebase section when codebaseContext is undefined/empty', () => {
    const plan = makePlan([node('t1', 'developer')]);
    expect(
      composeTaskPrompt(plan, plan.nodes[0]!, null, undefined, undefined, undefined),
    ).not.toContain('## Existing codebase');
    expect(
      composeTaskPrompt(plan, plan.nodes[0]!, null, undefined, undefined, '   '),
    ).not.toContain('## Existing codebase');
  });
});

describe('Walker — QA-driven replan (M5)', () => {
  it('calls replanOnQAFailure when a qa-role task fails terminally', async () => {
    const callbackCalls: Array<{ failedTaskId: string; qaError: string }> = [];
    const replanFn = vi.fn(
      async (args: { failedTaskId: string; qaError: string; failedPlan: Plan }) => {
        callbackCalls.push({ failedTaskId: args.failedTaskId, qaError: args.qaError });
        return null; // returning null falls through to terminal failure
      },
    );
    const h = makeHarness({
      defaultVerify: async () => ({
        pass: false,
        output: 'qa says: pi precision insufficient',
        failures: [
          {
            kind: 'custom' as const,
            cmd: 'verify',
            exitCode: 1,
            tail: 'pi precision insufficient',
          },
        ],
      }),
    });
    h.walker = new Walker({ ...h.deps, replanOnQAFailure: replanFn });
    const plan = makePlan([node('q', 'qa')]);
    const outcome = await h.walker.start({
      runId: 'r-replan',
      plan,
      repoPath: '/fake',
      budget: DEFAULT_BUDGET,
    });
    expect(outcome).toBe('failure');
    expect(replanFn).toHaveBeenCalledTimes(1);
    expect(callbackCalls[0]!.failedTaskId).toBe('q');
    expect(callbackCalls[0]!.qaError).toContain('pi precision insufficient');
  });

  it('swaps in the new plan when replanOnQAFailure returns one', async () => {
    let verifyCallNum = 0;
    const h = makeHarness({
      defaultVerify: async () => {
        verifyCallNum += 1;
        // First plan's qa-task fails (2 times to exhaust retries); second plan's qa-task passes.
        return verifyCallNum <= 2
          ? {
              pass: false,
              output: 'fail attempt ' + verifyCallNum,
              failures: [{ kind: 'custom' as const, cmd: 'v', exitCode: 1, tail: 'x' }],
            }
          : { pass: true, output: 'ok', failures: [] };
      },
    });
    const newPlan: Plan = makePlan([node('q2', 'qa')]);
    const replanFn = vi.fn(async () => ({ newPlan, newPlanId: 'plan-2' }));
    h.walker = new Walker({ ...h.deps, replanOnQAFailure: replanFn });
    const plan = makePlan([node('q', 'qa')]);
    const outcome = await h.walker.start({
      runId: 'r-replan-ok',
      plan,
      repoPath: '/fake',
      budget: DEFAULT_BUDGET,
    });
    expect(outcome).toBe('success');
    expect(replanFn).toHaveBeenCalledTimes(1);
    const triggered = h.emitted.find((e) => e.type === 'qa.replan-triggered');
    expect(triggered).toBeDefined();
  });

  it('caps at 1 replan per run; second qa fail emits qa.replan-exhausted', async () => {
    const h = makeHarness({
      defaultVerify: async () => ({
        pass: false,
        output: 'always fails',
        failures: [{ kind: 'custom' as const, cmd: 'v', exitCode: 1, tail: 'x' }],
      }),
    });
    const newPlan: Plan = makePlan([node('q2', 'qa')]);
    const replanFn = vi.fn(async () => ({ newPlan, newPlanId: 'plan-2' }));
    h.walker = new Walker({ ...h.deps, replanOnQAFailure: replanFn });
    const plan = makePlan([node('q', 'qa')]);
    await h.walker.start({ runId: 'r-cap', plan, repoPath: '/fake', budget: DEFAULT_BUDGET });
    expect(replanFn).toHaveBeenCalledTimes(1);
    const exhausted = h.emitted.find((e) => e.type === 'qa.replan-exhausted');
    expect(exhausted).toBeDefined();
  });

  it('does not call replan callback for non-qa role failures', async () => {
    const replanFn = vi.fn(async () => null);
    const h = makeHarness({
      defaultVerify: async () => ({
        pass: false,
        output: 'dev fail',
        failures: [{ kind: 'custom' as const, cmd: 'v', exitCode: 1, tail: 'x' }],
      }),
    });
    h.walker = new Walker({ ...h.deps, replanOnQAFailure: replanFn });
    const plan = makePlan([node('d', 'developer')]);
    await h.walker.start({ runId: 'r-non-qa', plan, repoPath: '/fake', budget: DEFAULT_BUDGET });
    expect(replanFn).not.toHaveBeenCalled();
  });

  it('uses v2 branch prefix after replan so branches do not collide with the failed plan', async () => {
    let verifyCount = 0;
    const h = makeHarness({
      defaultVerify: async () => {
        verifyCount += 1;
        // Failed plan's qa fails twice (terminal); new plan's qa passes.
        return verifyCount <= 2
          ? {
              pass: false,
              output: 'pi precision',
              failures: [{ kind: 'custom' as const, cmd: 'v', exitCode: 1, tail: 'x' }],
            }
          : { pass: true, output: 'ok', failures: [] };
      },
    });
    const newPlan: Plan = makePlan([node('q', 'qa')]); // same id 'q' as the original
    const replanFn = vi.fn(async () => ({ newPlan, newPlanId: 'plan-2' }));
    h.walker = new Walker({ ...h.deps, replanOnQAFailure: replanFn });
    const plan = makePlan([node('q', 'qa')]);
    await h.walker.start({ runId: 'r-prefix', plan, repoPath: '/fake', budget: DEFAULT_BUDGET });
    // First plan's task added under the v1 prefix (no version segment).
    expect(h.deps.worktree.added).toContain('wisp/r-prefix/q');
    // After replan, the new plan's task adds under v2.
    expect(h.deps.worktree.added).toContain('wisp/r-prefix/v2/q');
  });
});

describe('Walker — builder replan broadening (P3)', () => {
  const buildFail = async (): Promise<VerificationResult> => ({
    pass: false,
    output: 'src/x.ts(3,1): error TS2304: Cannot find name',
    failures: [{ kind: 'build' as const, cmd: 'pnpm build', exitCode: 2, tail: 'TS2304' }],
  });

  it('isBuilderReplanFailure: structured build/test kinds are the primary signal', () => {
    expect(
      isBuilderReplanFailure([{ kind: 'build', cmd: 'b', exitCode: 1, tail: '' }], 'no sigs here'),
    ).toBe(true);
    expect(
      isBuilderReplanFailure([{ kind: 'test', cmd: 't', exitCode: 1, tail: '' }], 'no sigs here'),
    ).toBe(true);
    // pnpm appends ELIFECYCLE noise to EVERY failing script — a lint-only
    // failure must still take the plain terminal-fail path, not replan.
    expect(
      isBuilderReplanFailure(
        [{ kind: 'lint', cmd: 'l', exitCode: 1, tail: 'eslint found 3 problems (3 errors)' }],
        'eslint found 3 problems (3 errors)\nELIFECYCLE  Command failed with exit code 1.',
      ),
    ).toBe(false);
  });

  it('isBuilderReplanFailure: signature regexes are the fallback over custom-failure tails only', () => {
    const custom = (tail: string) => [{ kind: 'custom' as const, cmd: 'c', exitCode: 1, tail }];
    // Custom verify wrapping a test/build run triggers via its tail.
    expect(isBuilderReplanFailure(custom('Tests: 3 failed, 12 passed'), 'full transcript')).toBe(
      true,
    );
    expect(isBuilderReplanFailure(custom('2 specs failed'), 'full transcript')).toBe(true);
    expect(isBuilderReplanFailure(custom('Build failed with 1 error'), 'full transcript')).toBe(
      true,
    );
    expect(isBuilderReplanFailure(custom("Cannot find module './foo.js'"), 'full transcript')).toBe(
      true,
    );
    expect(isBuilderReplanFailure(custom('exit code 1, no details'), 'full transcript')).toBe(
      false,
    );
    // Non-custom failures never feed the fallback, even with build-ish text in the transcript.
    const lintOnly = [{ kind: 'lint' as const, cmd: 'l', exitCode: 1, tail: 'style nits' }];
    expect(isBuilderReplanFailure(lintOnly, 'error TS2307: Cannot find module x')).toBe(false);
    expect(isBuilderReplanFailure([], 'Tests: 3 failed, 12 passed')).toBe(false);
    // npm ERR!/ELIFECYCLE is generic package-manager noise, not a signature.
    expect(isBuilderReplanFailure(custom('npm ERR! code ELIFECYCLE'), 'full transcript')).toBe(
      false,
    );
    expect(BUILDER_REPLAN_SIGNATURES.length).toBe(6);
  });

  it('isBuilderReplanFailure: harness verify exceptions (verification threw) never replan', () => {
    // Mirrors the walker's catch wrapper: kind 'custom', output prefixed
    // "verification threw:", tail = the raw error message — which may itself
    // contain signature-like text (e.g. a module-resolution infra error).
    const errStr = "Cannot find module 'x'";
    expect(
      isBuilderReplanFailure(
        [{ kind: 'custom', cmd: '<verify>', exitCode: 1, tail: errStr }],
        `verification threw: ${errStr}`,
      ),
    ).toBe(false);
  });

  it('builder role + kind=build failure triggers the replan hook', async () => {
    const failedIds: string[] = [];
    const replanFn = vi.fn(
      async (args: { failedPlan: Plan; failedTaskId: string; qaError: string }) => {
        failedIds.push(args.failedTaskId);
        return null;
      },
    );
    const h = makeHarness({ defaultVerify: buildFail });
    h.walker = new Walker({ ...h.deps, replanOnQAFailure: replanFn });
    const plan = makePlan([node('d', 'developer')]);
    const outcome = await h.walker.start({
      runId: 'r-builder-replan',
      plan,
      repoPath: '/fake',
      budget: DEFAULT_BUDGET,
    });
    expect(outcome).toBe('failure');
    expect(replanFn).toHaveBeenCalledTimes(1);
    expect(failedIds).toEqual(['d']);
  });

  it('lint-only builder failure does NOT trigger the replan hook', async () => {
    const replanFn = vi.fn(async () => null);
    const h = makeHarness({
      defaultVerify: async () => ({
        pass: false,
        // pnpm appends this line to every failing script — it must not replan.
        output: 'eslint found 3 problems (3 errors)\nELIFECYCLE  Command failed with exit code 1.',
        failures: [{ kind: 'lint' as const, cmd: 'pnpm lint', exitCode: 1, tail: 'nits' }],
      }),
    });
    h.walker = new Walker({ ...h.deps, replanOnQAFailure: replanFn });
    const plan = makePlan([node('d', 'developer')]);
    await h.walker.start({
      runId: 'r-builder-lint',
      plan,
      repoPath: '/fake',
      budget: DEFAULT_BUDGET,
    });
    expect(replanFn).not.toHaveBeenCalled();
  });

  it('combined builder + QA failures still cap at 1 replan per run', async () => {
    // The builder failure consumes the single replan; the swapped-in plan's
    // qa task then fails terminally and must hit qa.replan-exhausted.
    const replanFn = vi.fn(async () => ({
      newPlan: makePlan([node('q2', 'qa')]),
      newPlanId: 'p2',
    }));
    const h = makeHarness({ defaultVerify: buildFail });
    h.walker = new Walker({ ...h.deps, replanOnQAFailure: replanFn });
    const plan = makePlan([node('d', 'developer')]);
    await h.walker.start({
      runId: 'r-builder-cap',
      plan,
      repoPath: '/fake',
      budget: DEFAULT_BUDGET,
    });
    expect(replanFn).toHaveBeenCalledTimes(1);
    const exhausted = h.emitted.find((e) => e.type === 'qa.replan-exhausted');
    expect(exhausted).toBeDefined();
  });
});

describe('Walker — QA-role predicate (isQARole)', () => {
  const failingVerify = async (): Promise<VerificationResult> => ({
    pass: false,
    output: 'qa gate failed',
    failures: [{ kind: 'custom' as const, cmd: 'v', exitCode: 1, tail: 'x' }],
  });

  function planWithRole(role: string, taskId = 'q'): Plan {
    const team: Team = {
      roles: [
        ...makeTeam().roles,
        { role, model: 'sonnet', allowedTools: ['Read'], systemPrompt: `extra ${FILLER}` },
      ],
    };
    const nodes = [node(taskId, role)];
    return { goal: 'g', team, nodes, edges: [] };
  }

  it('defaultIsQARole matches qa as a token, not as a substring', () => {
    expect(defaultIsQARole('qa')).toBe(true);
    expect(defaultIsQARole('qa-engineer')).toBe(true);
    expect(defaultIsQARole('senior_qa')).toBe(true);
    expect(defaultIsQARole('quality-analyst')).toBe(false);
  });

  it('fires the replan hook for role qa-engineer with the default predicate', async () => {
    const replanFn = vi.fn(async () => null);
    const h = makeHarness({ defaultVerify: failingVerify });
    h.walker = new Walker({ ...h.deps, replanOnQAFailure: replanFn });
    await h.walker.start({
      runId: 'r-qa-eng',
      plan: planWithRole('qa-engineer'),
      repoPath: '/fake',
      budget: DEFAULT_BUDGET,
    });
    expect(replanFn).toHaveBeenCalledTimes(1);
  });

  it('still fires for the literal qa role', async () => {
    const replanFn = vi.fn(async () => null);
    const h = makeHarness({ defaultVerify: failingVerify });
    h.walker = new Walker({ ...h.deps, replanOnQAFailure: replanFn });
    await h.walker.start({
      runId: 'r-qa-lit',
      plan: makePlan([node('q', 'qa')]),
      repoPath: '/fake',
      budget: DEFAULT_BUDGET,
    });
    expect(replanFn).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire for quality-analyst with the default predicate', async () => {
    const replanFn = vi.fn(async () => null);
    const h = makeHarness({ defaultVerify: failingVerify });
    h.walker = new Walker({ ...h.deps, replanOnQAFailure: replanFn });
    await h.walker.start({
      runId: 'r-quality',
      plan: planWithRole('quality-analyst'),
      repoPath: '/fake',
      budget: DEFAULT_BUDGET,
    });
    expect(replanFn).not.toHaveBeenCalled();
  });

  it('an injected custom isQARole wins over the default', async () => {
    const replanFn = vi.fn(async () => null);
    const h = makeHarness({ defaultVerify: failingVerify });
    h.walker = new Walker({
      ...h.deps,
      replanOnQAFailure: replanFn,
      // Custom predicate flips the default verdict for quality-analyst.
      isQARole: (role) => role === 'quality-analyst',
    });
    await h.walker.start({
      runId: 'r-custom-pred',
      plan: planWithRole('quality-analyst'),
      repoPath: '/fake',
      budget: DEFAULT_BUDGET,
    });
    expect(replanFn).toHaveBeenCalledTimes(1);
  });
});

describe('Walker — executor identity at dispatch', () => {
  it('running-state patch carries the override model + stored model when applyAgentOverride swaps it', async () => {
    const h = makeHarness({});
    h.walker = new Walker({
      ...h.deps,
      applyAgentOverride: (role, base) =>
        role === 'developer' ? { ...base, model: 'haiku' } : base,
    });
    await h.walker.start({
      runId: 'r-exec-override',
      plan: makePlan([node('d', 'developer')]),
      repoPath: '/fake',
      budget: DEFAULT_BUDGET,
    });
    const state = h.taskStates.get('d')!;
    // makeTeam stores developer as 'sonnet'; the override launched 'haiku'.
    expect(state.executorModel).toBe('haiku');
    expect(state.executorModelStored).toBe('sonnet');
    // No resolveExecutor wired → identity fields are null, not undefined.
    expect(state.executorName).toBeNull();
    expect(state.executorAvatarUrl).toBeNull();
  });

  it('running-state patch carries modelStored=null when no override swaps the model', async () => {
    const h = makeHarness({});
    await h.walker.start({
      runId: 'r-exec-plain',
      plan: makePlan([node('d', 'developer')]),
      repoPath: '/fake',
      budget: DEFAULT_BUDGET,
    });
    const state = h.taskStates.get('d')!;
    expect(state.executorModel).toBe('sonnet');
    expect(state.executorModelStored).toBeNull();
  });

  it('task.started payload carries the executor object', async () => {
    const h = makeHarness({});
    h.walker = new Walker({
      ...h.deps,
      resolveExecutor: (role) =>
        role === 'developer' ? { name: 'Maya', avatarUrl: '/avatars/maya.webp' } : null,
    });
    await h.walker.start({
      runId: 'r-exec-event',
      plan: makePlan([node('d', 'developer')]),
      repoPath: '/fake',
      budget: DEFAULT_BUDGET,
    });
    const started = h.emitted.find((e) => e.type === 'task.started');
    expect(started).toBeDefined();
    if (started?.type === 'task.started') {
      expect(started.payload.executor).toEqual({
        name: 'Maya',
        model: 'sonnet',
        modelStored: null,
        avatarUrl: '/avatars/maya.webp',
      });
    }
  });
});

// ---------- helpers ----------

describe('Walker — main task transient-retry', () => {
  it('retries the main task subprocess when it dies with a transient 529 / Overloaded marker', async () => {
    // Regression for the 2026-05-15 wertzeit-app run where n3-skeleton hit
    // Anthropic 529 on both its first attempt and its single normal retry,
    // cascade-failing every downstream task. Transient infra errors must
    // not consume the structural retry budget; they get their own pool of
    // attempts with backoff.
    const scripts = new Map<string, FakeTask[]>([
      [
        'n1',
        [
          // Attempt 1: transient error (worth retrying — infra blip).
          {
            events: [
              {
                type: 'task.text-delta',
                payload: { taskId: 'n1', text: 'API Error: 529 Overloaded. Try again.' },
              },
              { type: 'task.failed', payload: { taskId: 'n1', error: 'exit code 1' } },
            ],
            finishWith: [],
          },
          // Attempt 2: transient again.
          {
            events: [
              {
                type: 'task.text-delta',
                payload: { taskId: 'n1', text: 'API Error: 529 Overloaded. Try again.' },
              },
              { type: 'task.failed', payload: { taskId: 'n1', error: 'exit code 1' } },
            ],
            finishWith: [],
          },
          // Attempt 3: success.
          {
            events: [
              {
                type: 'task.completed',
                payload: { taskId: 'n1', outcome: 'pass', exitCode: 0 },
              },
            ],
          },
        ],
      ],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts });

    const plan = makePlan([node('n1', 'architect')]);
    const startPromise = h.walker.start({
      runId: 'r-transient-task',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });
    // Pump fake timers so backoffs resolve.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setImmediate(r));
      h.timers.advance(15_000);
    }
    const outcome = await startPromise;
    expect(outcome).toBe('success');

    // Three pool.run invocations: two transient attempts + the success.
    const spawns = h.spawns.filter((s) => s.taskId === 'n1');
    expect(spawns.length).toBe(3);

    // No task.failed for n1 — transient retries hid the infra blip.
    expect(h.emitted.some((e) => e.type === 'task.failed' && e.payload.taskId === 'n1')).toBe(
      true, // subprocess emits task.failed inside each transient attempt, that's fine
    );
    // ...but no terminal walker-emitted permanent failure.
    const lastFailedForN1 = [...h.emitted]
      .reverse()
      .find((e) => e.type === 'task.failed' && e.payload.taskId === 'n1');
    // Walker did NOT add a permanent-fail emit after exhausting attempts.
    // The last task.failed comes from the subprocess events (transient), and
    // run.completed must be the very last event with outcome=success.
    expect(lastFailedForN1).toBeDefined();
    const last = h.emitted[h.emitted.length - 1];
    expect(last?.type).toBe('run.completed');
    if (last?.type === 'run.completed') expect(last.payload.outcome).toBe('success');
  });

  it('aborts a hung subprocess after the inactivity timeout and retries as transient', async () => {
    // Regression for the 2026-05-15 n1-architecture freeze: subprocess emits
    // some events, then sits silently for hours without writing the result
    // frame. Without the watchdog the walker waits forever. With the
    // watchdog, the run-aborted attempt re-launches via the transient retry
    // path (so the structural budget is preserved for real bugs).
    const releaseHang = createGate();
    const scripts = new Map<string, FakeTask[]>([
      [
        'n1',
        [
          // Attempt 1: emits one event, then gates (= subprocess hangs).
          // When abort fires (from the watchdog), the FakePool's gated path
          // checks the abort signal and emits task.failed('aborted').
          {
            events: [
              {
                type: 'task.text-delta',
                payload: { taskId: 'n1', text: 'Doing some work...' },
              },
            ],
            gate: releaseHang,
            finishWith: [],
          },
          // Attempt 2: success.
          {
            events: [
              { type: 'task.completed', payload: { taskId: 'n1', outcome: 'pass', exitCode: 0 } },
            ],
          },
        ],
      ],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts });

    const plan = makePlan([node('n1', 'architect')]);
    const startPromise = h.walker.start({
      runId: 'r-inactivity',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });

    // Wait for the watchdog to be armed, then advance past the inactivity
    // timeout. Watchdog uses deps.setTimeout (the FakeTimers seam) so this
    // is deterministic.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    // INACTIVITY_TIMEOUT_MS is 15 minutes; advance a bit past it. No probe
    // hook is wired in this harness, so the watchdog falls back to the
    // "kill immediately" legacy path.
    h.timers.advance(16 * 60 * 1000);
    // Drain microtasks so abort propagates into the gated FakePool task.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    // Release any remaining gate (mostly a no-op once abort propagates).
    releaseHang.release();
    // Pump the transient-retry backoff timer too.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    h.timers.advance(15_000);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const outcome = await startPromise;
    expect(outcome).toBe('success');

    // Two spawns: the hung first attempt + the successful retry.
    expect(h.spawns.filter((s) => s.taskId === 'n1').length).toBe(2);

    // The harness emitted an inactivity-warning text-delta to surface what
    // happened in the dashboard.
    const watchdogWarn = h.emitted.find(
      (e) =>
        e.type === 'task.text-delta' &&
        e.payload.taskId === 'n1' &&
        /inactive for/i.test(e.payload.text),
    );
    expect(watchdogWarn).toBeDefined();
  });

  it('smart watchdog — pid gone triggers immediate kill+retry', async () => {
    // Case A from the 2026-05-17 fix: probe says alive=false (ESRCH equivalent).
    // Watchdog must kill+retry on the first firing, no extension.
    const releaseHang = createGate();
    const scripts = new Map<string, FakeTask[]>([
      [
        'n1',
        [
          {
            events: [{ type: 'task.text-delta', payload: { taskId: 'n1', text: 'work\n' } }],
            gate: releaseHang,
            finishWith: [],
          },
          {
            events: [
              { type: 'task.completed', payload: { taskId: 'n1', outcome: 'pass', exitCode: 0 } },
            ],
          },
        ],
      ],
    ]);
    const h = makeHarness({
      scriptByTaskId: scripts,
      probeSubprocessLiveness: () => ({ alive: false, cpuSeconds: null }),
    });

    const plan = makePlan([node('n1', 'architect')]);
    const startPromise = h.walker.start({
      runId: 'r-pid-gone',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });

    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    h.timers.advance(16 * 60 * 1000);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    releaseHang.release();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    h.timers.advance(15_000); // transient-retry backoff
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const outcome = await startPromise;
    expect(outcome).toBe('success');
    expect(h.spawns.filter((s) => s.taskId === 'n1').length).toBe(2);
    // Logs the pid-gone reason, not the generic inactivity reason.
    const pidGoneLog = h.emitted.find(
      (e) =>
        e.type === 'task.text-delta' &&
        e.payload.taskId === 'n1' &&
        /pid not found|pid gone/i.test(e.payload.text),
    );
    expect(pidGoneLog).toBeDefined();
  });

  it('smart watchdog — pid alive + CPU advancing extends grace period (no kill)', async () => {
    // Case B from the 2026-05-17 fix: each watchdog firing reports CPU has
    // advanced ≥1s since the last snapshot, so the watchdog must extend the
    // grace period instead of killing. After the subprocess completes
    // normally, no kill should have fired.
    let cpu = 100.0;
    const releaseFinish = createGate();
    const scripts = new Map<string, FakeTask[]>([
      [
        'n1',
        [
          {
            events: [{ type: 'task.text-delta', payload: { taskId: 'n1', text: 'work\n' } }],
            gate: releaseFinish,
            finishWith: [
              { type: 'task.completed', payload: { taskId: 'n1', outcome: 'pass', exitCode: 0 } },
            ],
          },
        ],
      ],
    ]);
    const h = makeHarness({
      scriptByTaskId: scripts,
      // Each call advances CPU by 2 seconds — well above the 1s threshold.
      probeSubprocessLiveness: () => {
        cpu += 2;
        return { alive: true, cpuSeconds: cpu };
      },
    });

    const plan = makePlan([node('n1', 'architect')]);
    const startPromise = h.walker.start({
      runId: 'r-extend',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });

    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    // Fire the watchdog three times — each firing must extend, not kill.
    h.timers.advance(16 * 60 * 1000); // primary window elapses
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    h.timers.advance(6 * 60 * 1000); // extension window elapses (still under MAX)
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    // Now release the subprocess so it completes normally.
    releaseFinish.release();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const outcome = await startPromise;
    expect(outcome).toBe('success');
    // No retry — only one spawn happened.
    expect(h.spawns.filter((s) => s.taskId === 'n1').length).toBe(1);
    // No kill was logged.
    const killLog = h.emitted.find(
      (e) =>
        e.type === 'task.text-delta' &&
        e.payload.taskId === 'n1' &&
        /aborting and retrying as transient/i.test(e.payload.text),
    );
    expect(killLog).toBeUndefined();
    // An "extending grace period" line was logged at least once.
    const extendLog = h.emitted.find(
      (e) =>
        e.type === 'task.text-delta' &&
        e.payload.taskId === 'n1' &&
        /extending grace period/i.test(e.payload.text),
    );
    expect(extendLog).toBeDefined();
  });

  it('smart watchdog — pid alive but CPU stuck kills at extended deadline', async () => {
    // Case C from the 2026-05-17 fix: probe says alive=true but CPU has not
    // advanced. Watchdog must kill on the first firing (no extension granted)
    // because there's no advancement signal to justify waiting longer.
    const releaseHang = createGate();
    const scripts = new Map<string, FakeTask[]>([
      [
        'n1',
        [
          {
            events: [{ type: 'task.text-delta', payload: { taskId: 'n1', text: 'work\n' } }],
            gate: releaseHang,
            finishWith: [],
          },
          {
            events: [
              { type: 'task.completed', payload: { taskId: 'n1', outcome: 'pass', exitCode: 0 } },
            ],
          },
        ],
      ],
    ]);
    const h = makeHarness({
      scriptByTaskId: scripts,
      // CPU is pegged — never advances, so each firing must kill.
      probeSubprocessLiveness: () => ({ alive: true, cpuSeconds: 42.0 }),
    });

    const plan = makePlan([node('n1', 'architect')]);
    const startPromise = h.walker.start({
      runId: 'r-stuck',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });

    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    h.timers.advance(16 * 60 * 1000);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    releaseHang.release();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    h.timers.advance(15_000);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const outcome = await startPromise;
    expect(outcome).toBe('success');
    // Retry fired — two spawns total.
    expect(h.spawns.filter((s) => s.taskId === 'n1').length).toBe(2);
    // The kill log mentions CPU did not advance.
    const stuckLog = h.emitted.find(
      (e) =>
        e.type === 'task.text-delta' &&
        e.payload.taskId === 'n1' &&
        /CPU advanced only|CPU probe unavailable/i.test(e.payload.text),
    );
    expect(stuckLog).toBeDefined();
  });

  it('non-transient subprocess failure still consumes the structural retry budget', async () => {
    // Inverse of the test above: a 'boom' error doesn't match TRANSIENT_RE, so
    // the task uses its normal `retries < 1` budget (1 retry) and then fails
    // terminally. Otherwise the transient-retry path would let real bugs
    // burn the whole transient budget too.
    const scripts = new Map<string, FakeTask[]>([
      [
        'n1',
        [
          {
            events: [{ type: 'task.failed', payload: { taskId: 'n1', error: 'boom' } }],
            finishWith: [],
          },
          {
            events: [{ type: 'task.failed', payload: { taskId: 'n1', error: 'boom' } }],
            finishWith: [],
          },
        ],
      ],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts });

    const plan = makePlan([node('n1', 'architect')]);
    await h.walker.start({
      runId: 'r-nontransient',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });

    // 1 attempt + 1 normal retry = 2 spawns. NO transient extras.
    const spawns = h.spawns.filter((s) => s.taskId === 'n1');
    expect(spawns.length).toBe(2);
  });
});

describe('Walker — dep-merge auto-resolver', () => {
  it('spawns a resolver subprocess on dep-merge conflict and continues the task when it succeeds', async () => {
    // n1 + n2 are parallel, n3 merges them both. mergeBranches reports a
    // conflict on the first attempt (auto-aborted), then on the resolver's
    // retry (leaveOnConflict=true) reports the same conflict. The resolver
    // subprocess "fixes" things; getMergeStatus reflects a clean post-merge
    // state with HEAD advanced. The walker must then fall through and run
    // the actual n3 task subprocess.
    const resolverEmitted: string[] = [];
    const scripts = new Map<string, FakeTask[]>([
      [
        'n3:merge-resolver',
        [
          {
            events: [
              {
                type: 'task.usage',
                payload: { taskId: 'n3:merge-resolver', tokensIn: 200, tokensOut: 100, turns: 3 },
              },
              {
                type: 'task.completed',
                payload: { taskId: 'n3:merge-resolver', outcome: 'pass', exitCode: 0 },
              },
            ],
          },
        ],
      ],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts });

    let mergeCallCount = 0;
    let mergeStatusCallCount = 0;
    h.deps.mergeBranches = async (_path, _branches, opts) => {
      mergeCallCount += 1;
      // Both attempts conflict. First call: auto-abort path. Second call:
      // leaveOnConflict=true so we expect the worktree to be left dirty
      // (simulated by the fake getMergeStatus below).
      expect(opts?.leaveOnConflict === true || mergeCallCount === 1).toBe(true);
      return { ok: false, conflict: 'CONFLICT in shared.txt' };
    };
    h.deps.abortMerge = async () => {
      // Should not be called when the resolver succeeds.
      throw new Error('abortMerge should not be called when the resolver succeeded');
    };
    h.deps.getMergeStatus = async () => {
      mergeStatusCallCount += 1;
      // First call (pre-resolver): in-merge with unmerged paths.
      // Second call (post-resolver): clean state, HEAD advanced.
      if (mergeStatusCallCount === 1) {
        return { inMerge: true, unmergedPaths: ['shared.txt'], headCommit: 'a'.repeat(40) };
      }
      return { inMerge: false, unmergedPaths: [], headCommit: 'b'.repeat(40) };
    };

    const plan = makePlan([
      node('n1', 'architect'),
      node('n2', 'developer'),
      node('n3', 'qa', ['n1', 'n2']),
    ]);
    const outcome = await h.walker.start({
      runId: 'r-mergefix',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });

    // Run finishes successfully because the resolver merged and n3 ran.
    expect(outcome).toBe('success');

    // The resolver subprocess was spawned with the compound taskId.
    const resolverSpawn = h.spawns.find((s) => s.taskId === 'n3:merge-resolver');
    expect(resolverSpawn).toBeDefined();
    expect(resolverSpawn!.opts.allowedTools).toEqual(
      expect.arrayContaining(['Read', 'Edit', 'Write', 'Bash']),
    );

    // The main n3 task also ran AFTER the resolver finalised the merge.
    const n3Spawn = h.spawns.find((s) => s.taskId === 'n3');
    expect(n3Spawn).toBeDefined();
    const resolverIdx = h.spawns.findIndex((s) => s.taskId === 'n3:merge-resolver');
    const n3Idx = h.spawns.findIndex((s) => s.taskId === 'n3');
    expect(resolverIdx).toBeLessThan(n3Idx);

    // Resolver tokens are attributed to the parent task so run-level counters
    // include them. The fake resolver reported 200/100 tokens + 3 turns.
    expect(h.taskStates.get('n3')?.tokensIn ?? 0).toBeGreaterThanOrEqual(200);
    expect(h.taskStates.get('n3')?.turnsUsed ?? 0).toBeGreaterThanOrEqual(3);

    // No task.failed for n3 — the dep-merge path was rescued.
    expect(h.emitted.some((e) => e.type === 'task.failed' && e.payload.taskId === 'n3')).toBe(
      false,
    );
    // Suppress unused-warning for the events captured above.
    void resolverEmitted;
  });

  it('retries the resolver subprocess when it dies with a transient 529 / Overloaded error', async () => {
    // Regression for the live n13-builder failure on 2026-05-15: Anthropic's
    // API returned 529 Overloaded inside the resolver subprocess, the CLI
    // exited 1 with text-delta "API Error: 529 Overloaded", and the walker
    // gave up after one attempt — cascade-failing n14 + n15. The resolver
    // must retry on transient infra errors and only fail if the condition
    // persists across attempts.
    const scripts = new Map<string, FakeTask[]>([
      [
        'n3:merge-resolver',
        [
          // Attempt 1: transient error.
          {
            events: [
              {
                type: 'task.text-delta',
                payload: { taskId: 'n3:merge-resolver', text: 'API Error: 529 Overloaded.\n' },
              },
              {
                type: 'task.failed',
                payload: { taskId: 'n3:merge-resolver', error: 'exit code 1' },
              },
            ],
            finishWith: [],
          },
          // Attempt 2: success.
          {
            events: [
              {
                type: 'task.usage',
                payload: { taskId: 'n3:merge-resolver', tokensIn: 1000, tokensOut: 500, turns: 7 },
              },
              {
                type: 'task.completed',
                payload: { taskId: 'n3:merge-resolver', outcome: 'pass', exitCode: 0 },
              },
            ],
          },
        ],
      ],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts });

    h.deps.mergeBranches = async () => ({ ok: false, conflict: 'CONFLICT' });
    h.deps.abortMerge = async () => {
      throw new Error('abortMerge should NOT fire when the retried resolver succeeds');
    };
    let statusCallCount = 0;
    h.deps.getMergeStatus = async () => {
      statusCallCount += 1;
      // Pre-resolver: in-merge.
      // Post-attempt-1: still in-merge (transient error → no progress).
      // Post-attempt-2: clean + HEAD advanced (resolver finalised).
      if (statusCallCount <= 2) {
        return { inMerge: true, unmergedPaths: ['shared.txt'], headCommit: 'a'.repeat(40) };
      }
      return { inMerge: false, unmergedPaths: [], headCommit: 'b'.repeat(40) };
    };

    const plan = makePlan([
      node('n1', 'architect'),
      node('n2', 'developer'),
      node('n3', 'qa', ['n1', 'n2']),
    ]);

    // Start the walker; advance fake timers so the retry-backoff resolves.
    const startPromise = h.walker.start({
      runId: 'r-retry',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });
    // Pump fake timers until the resolver retry-backoff has fired.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setImmediate(r));
      h.timers.advance(10_000);
    }
    const outcome = await startPromise;
    expect(outcome).toBe('success');

    const resolverSpawns = h.spawns.filter((s) => s.taskId === 'n3:merge-resolver');
    expect(resolverSpawns.length).toBe(2);

    const n3Spawn = h.spawns.find((s) => s.taskId === 'n3');
    expect(n3Spawn).toBeDefined();
    // n3 main task ran AFTER both resolver attempts.
    const n3Idx = h.spawns.findIndex((s) => s.taskId === 'n3');
    expect(n3Idx).toBeGreaterThan(h.spawns.lastIndexOf(resolverSpawns[1]!));

    // No task.failed for n3 — we recovered.
    expect(h.emitted.some((e) => e.type === 'task.failed' && e.payload.taskId === 'n3')).toBe(
      false,
    );
  });

  it('gives up after MAX_RESOLVER_ATTEMPTS when transient errors persist', async () => {
    // If the upstream blip keeps blocking the resolver across every retry,
    // the task must still fail (with a clear "transient retries" reason)
    // rather than spin forever.
    const transientScript: FakeTask = {
      events: [
        {
          type: 'task.text-delta',
          payload: { taskId: 'n3:merge-resolver', text: 'API Error: 529 Overloaded.\n' },
        },
        { type: 'task.failed', payload: { taskId: 'n3:merge-resolver', error: 'exit code 1' } },
      ],
      finishWith: [],
    };
    const scripts = new Map<string, FakeTask[]>([
      ['n3:merge-resolver', [transientScript, transientScript, transientScript]],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts });

    h.deps.mergeBranches = async () => ({ ok: false, conflict: 'CONFLICT' });
    let abortCalls = 0;
    h.deps.abortMerge = async () => {
      abortCalls += 1;
    };
    h.deps.getMergeStatus = async () => ({
      inMerge: true,
      unmergedPaths: ['shared.txt'],
      headCommit: 'a'.repeat(40),
    });

    const plan = makePlan([
      node('n1', 'architect'),
      node('n2', 'developer'),
      node('n3', 'qa', ['n1', 'n2']),
    ]);

    const startPromise = h.walker.start({
      runId: 'r-retry-exhaust',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setImmediate(r));
      h.timers.advance(15_000);
    }
    await startPromise;

    // Three resolver attempts fired then walker abandoned.
    const resolverSpawns = h.spawns.filter((s) => s.taskId === 'n3:merge-resolver');
    expect(resolverSpawns.length).toBe(3);
    expect(abortCalls).toBeGreaterThanOrEqual(1);

    const n3Failed = h.emitted.find(
      (e) => e.type === 'task.failed' && e.payload.taskId === 'n3',
    ) as Extract<HarnessEvent, { type: 'task.failed' }> | undefined;
    expect(n3Failed).toBeDefined();
    expect(n3Failed!.payload.error).toContain('transient retries');
  });

  it('does NOT retry the resolver on a non-transient failure (skip wasted budget)', async () => {
    // Resolver exited without resolving but with no transient marker — likely
    // a structural impossibility. Retrying would just burn tokens. The walker
    // must fail the task after exactly one attempt.
    const scripts = new Map<string, FakeTask[]>([
      [
        'n3:merge-resolver',
        [
          {
            events: [
              {
                type: 'task.completed',
                payload: { taskId: 'n3:merge-resolver', outcome: 'pass', exitCode: 0 },
              },
            ],
          },
        ],
      ],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts });

    h.deps.mergeBranches = async () => ({ ok: false, conflict: 'CONFLICT' });
    h.deps.abortMerge = async () => {};
    h.deps.getMergeStatus = async () => ({
      inMerge: true,
      unmergedPaths: ['weird.txt'],
      headCommit: 'a'.repeat(40),
    });

    const plan = makePlan([
      node('n1', 'architect'),
      node('n2', 'developer'),
      node('n3', 'qa', ['n1', 'n2']),
    ]);
    await h.walker.start({
      runId: 'r-no-retry',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });

    expect(h.spawns.filter((s) => s.taskId === 'n3:merge-resolver').length).toBe(1);
    const n3Failed = h.emitted.find(
      (e) => e.type === 'task.failed' && e.payload.taskId === 'n3',
    ) as Extract<HarnessEvent, { type: 'task.failed' }> | undefined;
    expect(n3Failed).toBeDefined();
    expect(n3Failed!.payload.error).not.toContain('transient retries');
  });

  it('falls back to task.failed when the resolver does not finalise the merge', async () => {
    const scripts = new Map<string, FakeTask[]>([
      [
        'n3:merge-resolver',
        [
          {
            events: [
              {
                type: 'task.completed',
                payload: { taskId: 'n3:merge-resolver', outcome: 'pass', exitCode: 0 },
              },
            ],
          },
        ],
      ],
    ]);
    const h = makeHarness({ scriptByTaskId: scripts });

    h.deps.mergeBranches = async () => ({ ok: false, conflict: 'CONFLICT in shared.txt' });
    let abortCalls = 0;
    h.deps.abortMerge = async () => {
      abortCalls += 1;
    };
    h.deps.getMergeStatus = async () => {
      // Always report still-in-merge: the "resolver" never actually fixed
      // anything. Walker must abort the merge and fail the task.
      return { inMerge: true, unmergedPaths: ['shared.txt'], headCommit: 'a'.repeat(40) };
    };

    const plan = makePlan([
      node('n1', 'architect'),
      node('n2', 'developer'),
      node('n3', 'qa', ['n1', 'n2']),
    ]);
    await h.walker.start({
      runId: 'r-mergefail',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });

    const n3Failed = h.emitted.find(
      (e) => e.type === 'task.failed' && e.payload.taskId === 'n3',
    ) as Extract<HarnessEvent, { type: 'task.failed' }> | undefined;
    expect(n3Failed).toBeDefined();
    expect(n3Failed!.payload.error).toContain('auto-resolver');
    expect(n3Failed!.payload.error).toContain('did not finalise');
    // We must have aborted the merge so the worktree is left clean.
    expect(abortCalls).toBeGreaterThanOrEqual(1);
  });

  it('falls back to legacy fail behaviour when abortMerge/getMergeStatus are not wired', async () => {
    const h = makeHarness({});
    h.deps.mergeBranches = async () => ({ ok: false, conflict: 'CONFLICT in shared.txt' });
    h.deps.abortMerge = undefined;
    h.deps.getMergeStatus = undefined;

    const plan = makePlan([
      node('n1', 'architect'),
      node('n2', 'developer'),
      node('n3', 'qa', ['n1', 'n2']),
    ]);
    await h.walker.start({
      runId: 'r-mergelegacy',
      plan,
      repoPath: '/fake/repo',
      budget: DEFAULT_BUDGET,
    });

    const n3Failed = h.emitted.find(
      (e) => e.type === 'task.failed' && e.payload.taskId === 'n3',
    ) as Extract<HarnessEvent, { type: 'task.failed' }> | undefined;
    expect(n3Failed).toBeDefined();
    expect(n3Failed!.payload.error).toContain('dep-merge conflict');
  });
});

function createGate(): { release: () => void; promise: Promise<void> } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, promise };
}

async function waitForEvent(buf: HarnessEvent[], type: HarnessEvent['type']): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (buf.some((e) => e.type === type)) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`event ${type} never arrived; saw: ${buf.map((e) => e.type).join(',')}`);
}
