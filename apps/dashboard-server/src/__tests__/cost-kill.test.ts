import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type {
  BudgetConfig,
  RunState,
  TaskState,
  WalkerDeps,
  RunClaudeOpts,
  VerificationResult,
} from '@wisp/orchestrator';
import { Walker } from '@wisp/orchestrator';
import type { HarnessEvent, Plan, Team, TaskNode } from '@wisp/schemas';
import { plans, projects, runs as runsTable } from '@wisp/schemas';
import { db, sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { checkAutopilotBudget } from '../autopilot/budget.js';

/**
 * Cost-kill regression: when `checkAutopilotBudget` returns `exceeded:true`
 * during an active run, the walker must hard-abort. Previously the verdict
 * was only consulted by the autopilot tick (paused-run resume gate) and a
 * runaway live run kept burning tokens. The fix routes the verdict through
 * the walker's existing `cancel('budget_exceeded')` path so the SIGTERM /
 * worktree-retention / run.completed wiring is shared with the walker's
 * own minutes/turns enforcement.
 */

// ---------- harness ----------

const FILLER = 'x'.repeat(80);

function makeTeam(): Team {
  return {
    roles: [
      { role: 'architect', model: 'opus', allowedTools: ['Read'], systemPrompt: `arch ${FILLER}` },
    ],
  };
}

function makePlan(nodes: TaskNode[]): Plan {
  const edges = nodes.flatMap((n) => n.deps.map((d) => ({ from: d, to: n.id })));
  return { goal: 'g', team: makeTeam(), nodes, edges };
}

interface KillTestSubprocess {
  signal?: AbortSignal;
  ended: boolean;
}

/**
 * Fake pool that mirrors the script-driven shape used in the walker tests but
 * also exposes the subprocess abort signal so we can assert SIGTERM-equivalent
 * propagation. The cancel() path inside Walker calls `pool.terminateAll()` —
 * we record the call and trip the per-subprocess AbortController to mimic the
 * real SubprocessPool behaviour without spawning real binaries.
 */
function makeKillPool(scripts: Map<string, HarnessEvent[]>): {
  pool: WalkerDeps['pool'];
  spawned: KillTestSubprocess[];
  terminateAllCalls: number;
} {
  const spawned: KillTestSubprocess[] = [];
  let terminateAllCalls = 0;
  const pool = {
    get maxParallel() {
      return 99;
    },
    terminateAll() {
      // Walker.cancel() also fires t.abort?.abort() which is what
      // propagates to s.signal in the subprocess generator below.
      // terminateAll is the belt-and-suspenders escape hatch; the per-task
      // abort is the primary kill lever and is what the test asserts on.
      terminateAllCalls += 1;
    },
    run(o: RunClaudeOpts): AsyncIterable<HarnessEvent> {
      const sub: KillTestSubprocess = { signal: o.signal, ended: false };
      spawned.push(sub);
      const events = scripts.get(o.taskId) ?? [];
      // If the script already includes a terminal event (task.completed or
      // task.failed), the subprocess exits cleanly. Otherwise it parks
      // waiting for an external abort — mirroring a still-running CLI when
      // the budget kill arrives.
      const hasTerminal = events.some(
        (e) => e.type === 'task.completed' || e.type === 'task.failed',
      );
      return (async function* () {
        for (const ev of events) {
          if (o.signal?.aborted) break;
          yield ev;
          // Yield to the microtask queue so the walker's budget check fires
          // BEFORE the next event. Without this, the script drains
          // synchronously and the cancel() races with task.completed.
          await new Promise((r) => setImmediate(r));
        }
        if (hasTerminal) {
          sub.ended = true;
          return;
        }
        // Park until abort. When Walker.cancel() flips t.abort.abort(), the
        // signal trips and we exit with a task.failed frame.
        if (!o.signal?.aborted) {
          await new Promise<void>((resolve) => {
            if (!o.signal) return resolve();
            o.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        sub.ended = true;
        yield { type: 'task.failed', payload: { taskId: o.taskId, error: 'aborted' } };
      })();
    },
  } as unknown as WalkerDeps['pool'];
  return {
    pool,
    spawned,
    getTerminateAllCalls: () => terminateAllCalls,
  };
}

interface FakeTimers {
  setTimeout: WalkerDeps['setTimeout'];
  now: () => number;
}

function makeRealishTimers(): FakeTimers {
  const start = Date.now();
  return {
    setTimeout(cb, ms) {
      const t = setTimeout(cb, ms);
      return () => clearTimeout(t);
    },
    now: () => Date.now() - start,
  };
}

interface Harness {
  walker: Walker;
  emitted: HarnessEvent[];
  runStatePatches: Array<{ runId: string; patch: RunState }>;
  spawned: KillTestSubprocess[];
  terminateAllCalls: () => number;
}

function makeHarness(args: {
  runId: string;
  scripts: Map<string, HarnessEvent[]>;
  extraBudgetCheck?: WalkerDeps['extraBudgetCheck'];
}): Harness {
  const emitted: HarnessEvent[] = [];
  const runStatePatches: Array<{ runId: string; patch: RunState }> = [];
  const killPool = makeKillPool(args.scripts);
  const timers = makeRealishTimers();
  const taskStates = new Map<string, TaskState>();
  const deps: WalkerDeps = {
    pool: killPool.pool,
    worktree: {
      async add({ branchName }) {
        return `/fake/wt/${branchName.replace(/[^a-zA-Z0-9]+/g, '-')}`;
      },
      async remove() {
        /* no-op */
      },
    },
    verify: async (): Promise<VerificationResult> => ({ pass: true, output: 'ok', failures: [] }),
    emit: (ev) => {
      emitted.push(ev);
    },
    onTaskState: async (id, patch) => {
      taskStates.set(id, { ...taskStates.get(id), ...patch });
    },
    onRunState: async (runId, patch) => {
      runStatePatches.push({ runId, patch });
    },
    snapshot: async () => '/fake/snap.json',
    setTimeout: timers.setTimeout,
    now: timers.now,
    autoCommit: async () => 'a'.repeat(40),
    mergeBranches: async () => ({ ok: true }),
    interTaskPacingMs: 0,
    autoResumeRateLimit: true,
    extraBudgetCheck: args.extraBudgetCheck,
  };
  const walker = new Walker(deps);
  return {
    walker,
    emitted,
    runStatePatches,
    spawned: killPool.spawned,
    terminateAllCalls: killPool.getTerminateAllCalls,
  };
}

const HUGE_BUDGET: BudgetConfig = {
  budgetMinutes: 60_000,
  budgetTurns: 1_000_000,
  maxParallel: 1,
};

// ---------- tests ----------

describe('cost-kill — autopilot budget hard-aborts a live run', () => {
  beforeAll(() => {
    runMigrations();
  });

  afterAll(() => {
    sqlite.close();
  });

  it('walker.start resolves with budget_exceeded when extraBudgetCheck returns exceeded:true', async () => {
    const runId = 'r-cost-kill-1';
    const scripts = new Map<string, HarnessEvent[]>([
      [
        'a',
        [
          // First usage frame: 50 tokens, under the cap.
          { type: 'task.usage', payload: { taskId: 'a', tokensIn: 30, tokensOut: 20, turns: 1 } },
          // Second usage frame: 250 tokens cumulative, over the 100-token cap.
          { type: 'task.usage', payload: { taskId: 'a', tokensIn: 200, tokensOut: 50, turns: 2 } },
        ],
      ],
    ]);
    const h = makeHarness({
      runId,
      scripts,
      extraBudgetCheck: async ({ tokensTotal }) => {
        if (tokensTotal > 100) {
          return { exceeded: true, reason: `tokens ${tokensTotal} > 100` };
        }
        return { exceeded: false, reason: null };
      },
    });

    const outcome = await h.walker.start({
      runId,
      plan: makePlan([
        {
          id: 'a',
          role: 'architect',
          prompt: 'do a',
          deps: [],
          successCriteria: {},
          maxTurns: 5,
        },
      ]),
      repoPath: '/fake/repo',
      // Set walker-level caps high so the only path to budget_exceeded is via
      // the new extraBudgetCheck.
      budget: HUGE_BUDGET,
    });

    expect(outcome).toBe('budget_exceeded');
    // The walker should have emitted a tokens-kind resource.exceeded event.
    const exceeded = h.emitted.find(
      (e) => e.type === 'resource.exceeded' && e.payload.kind === 'tokens',
    );
    expect(exceeded).toBeTruthy();
    // The subprocess should have observed an aborted signal (SIGTERM equiv).
    expect(h.spawned.length).toBeGreaterThan(0);
    expect(h.spawned[0]?.signal?.aborted).toBe(true);
    // The run-state patch trail should end with status='failed', outcome='budget_exceeded'
    // (matches Walker.finalize's mapping of budget_exceeded → failed status).
    const terminal = h.runStatePatches.find((p) => p.patch.outcome === 'budget_exceeded');
    expect(terminal).toBeTruthy();
    expect(terminal?.patch.status).toBe('failed');
  });

  it('a non-exceeded extraBudgetCheck does not interfere with normal completion', async () => {
    const runId = 'r-cost-kill-2';
    const scripts = new Map<string, HarnessEvent[]>([
      [
        'a',
        [
          { type: 'task.usage', payload: { taskId: 'a', tokensIn: 10, tokensOut: 5, turns: 1 } },
          { type: 'task.completed', payload: { taskId: 'a', outcome: 'pass', exitCode: 0 } },
        ],
      ],
    ]);
    const h = makeHarness({
      runId,
      scripts,
      extraBudgetCheck: async () => ({ exceeded: false, reason: null }),
    });

    const outcome = await h.walker.start({
      runId,
      plan: makePlan([
        {
          id: 'a',
          role: 'architect',
          prompt: 'do a',
          deps: [],
          successCriteria: {},
          maxTurns: 5,
        },
      ]),
      repoPath: '/fake/repo',
      budget: HUGE_BUDGET,
    });

    expect(outcome).toBe('success');
  });

  it('checkAutopilotBudget driving the closure aborts when run row has autopilotBudgetTokens', async () => {
    // End-to-end: seed a row with autopilot caps, build the closure exactly
    // like makeWalkerDeps does, drive the walker. This is the integration
    // path that catches regressions where the closure is wired wrong even
    // though the unit tests above pass.
    const projectId = randomUUID();
    const planId = randomUUID();
    const runId = randomUUID();
    db.insert(projects)
      .values({ id: projectId, name: 'cost-kill-e2e', goal: 'g', repoPath: '/tmp/repo-ckill' })
      .run();
    db.insert(plans).values({ id: planId, projectId, dagJson: {}, status: 'locked' }).run();
    db.insert(runsTable)
      .values({
        id: runId,
        planId,
        status: 'running',
        startedAt: new Date(),
        budgetMinutes: 60_000,
        budgetTurns: 1_000_000,
        maxParallel: 1,
        autopilotMode: true,
        autopilotBudgetMinutes: null,
        autopilotBudgetTokens: 100,
        autopilotStartedAt: new Date(),
      })
      .run();

    const scripts = new Map<string, HarnessEvent[]>([
      [
        'a',
        [
          { type: 'task.usage', payload: { taskId: 'a', tokensIn: 30, tokensOut: 20, turns: 1 } },
          { type: 'task.usage', payload: { taskId: 'a', tokensIn: 200, tokensOut: 50, turns: 2 } },
        ],
      ],
    ]);

    const h = makeHarness({
      runId,
      scripts,
      // Same closure shape that runtime.makeWalkerDeps builds.
      extraBudgetCheck: async ({ runId: rid, tokensTotal }) => {
        const row = db.select().from(runsTable).where(eq(runsTable.id, rid)).get();
        if (!row) return { exceeded: false, reason: null };
        return checkAutopilotBudget(row, tokensTotal);
      },
    });

    const start = Date.now();
    const outcome = await h.walker.start({
      runId,
      plan: makePlan([
        {
          id: 'a',
          role: 'architect',
          prompt: 'do a',
          deps: [],
          successCriteria: {},
          maxTurns: 5,
        },
      ]),
      repoPath: '/fake/repo',
      budget: HUGE_BUDGET,
    });
    const elapsed = Date.now() - start;

    expect(outcome).toBe('budget_exceeded');
    // Latency budget: the walker must trip within hundreds of ms, not
    // multiple seconds. Generous bound to absorb CI noise.
    expect(elapsed).toBeLessThan(2000);
    expect(h.spawned[0]?.signal?.aborted).toBe(true);
  });
});
