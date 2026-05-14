import { describe, it, expect, vi } from 'vitest';
import type { HarnessEvent, Plan, Team, TaskNode } from '@agent-harness/schemas';
import {
  Walker,
  composeTaskPrompt,
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
      budget: DEFAULT_BUDGET,
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
    expect(h.deps.worktree.added).toContain('harness/r-prefix/q');
    // After replan, the new plan's task adds under v2.
    expect(h.deps.worktree.added).toContain('harness/r-prefix/v2/q');
  });
});

// ---------- helpers ----------

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
    expect(h.emitted.some((e) => e.type === 'task.failed' && e.payload.taskId === 'n3')).toBe(false);
    // Suppress unused-warning for the events captured above.
    void resolverEmitted;
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
