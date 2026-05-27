/**
 * Walker — DAG execution orchestrator (Phase D4).
 *
 * Pure orchestration logic: no HTTP, no DB, no filesystem (apart from
 * delegated callbacks). All side-effects happen through the {@link WalkerDeps}
 * seam, which makes this file unit-testable end-to-end with fakes.
 *
 * Lifecycle:
 *   start() ─┐
 *            ├─► dispatch()  ──► spawn task slots up to maxParallel
 *            ├─► pause()      ◄──── (rate-limit | user)
 *            ├─► resume()     ───► relaunches paused tasks
 *            ├─► cancel()     ───► pool.terminateAll() + per-task abort
 *            │                      + worktree.remove for running tasks
 *            │                      (only when outcome='cancelled') +
 *            │                      run.completed(<outcome>)
 *            └─► run.completed once DAG drains or budget exceeded
 */

import type {
  AgentSpec,
  HarnessEvent,
  Plan,
  RunOutcome,
  RunPausedReason,
  TaskNode,
} from '@wisp/schemas';
import type { SubprocessPool } from './pool.js';
import type { SuccessCriteria, VerificationResult } from './verification.js';

// ---------- public types ----------

export interface BudgetConfig {
  /**
   * Wallclock cap for the entire run in minutes. `null` means unlimited —
   * the walker will not abort on elapsed time. Users opt into this when
   * they explicitly want a multi-day project to run to completion. Token
   * and turn caps still apply unless they are also `null`.
   */
  budgetMinutes: number | null;
  /**
   * Cumulative cap for assistant turns across all tasks in the run.
   * `null` means unlimited.
   */
  budgetTurns: number | null;
  maxParallel: number;
}

export type TaskStatusValue =
  | 'pending'
  | 'ready'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface TaskState {
  status?: TaskStatusValue;
  worktreeBranch?: string | null;
  sessionId?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  turnsUsed?: number;
  durationMs?: number;
}

export interface RunState {
  status?: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  startedAt?: Date;
  endedAt?: Date;
  outcome?: RunOutcome;
  pausedReason?: RunPausedReason | null;
  resumeAt?: Date | null;
  tokensInTotal?: number;
  tokensOutTotal?: number;
  turnsTotal?: number;
  /** Structured error reason for analytics + retry routing.
   *  Currently set to 'max_turns' when a task fails because the
   *  Claude CLI exhausted its --max-turns budget. */
  errorReason?: string | null;
}

export interface WorktreeAdapter {
  add(args: { repoPath: string; branchName: string; baseBranch?: string }): Promise<string>;
  remove(args: { repoPath: string; worktreePath: string; force?: boolean }): Promise<void>;
}

export interface WalkerDeps {
  pool: SubprocessPool;
  worktree: WorktreeAdapter;
  verify: (
    worktreePath: string,
    criteria: SuccessCriteria,
    opts?: { signal?: AbortSignal },
  ) => Promise<VerificationResult>;
  emit: (event: HarnessEvent) => void;
  onTaskState: (taskId: string, patch: TaskState) => Promise<void>;
  onRunState: (runId: string, patch: RunState) => Promise<void>;
  /** Periodic snapshotter; receives runId, returns the snapshot path. */
  snapshot: (runId: string) => Promise<string>;
  /**
   * Schedules `cb` to fire after `ms`. Returns a canceler. Test seam: replace
   * with a deterministic fake timer.
   */
  setTimeout: (cb: () => void, ms: number) => () => void;
  now: () => number;
  /** Commits the worktree so downstream tasks see the artifacts on the branch tip. */
  autoCommit: (worktreePath: string, taskId: string) => Promise<string>;
  /** Merges additional dep branches into the worktree (diamond DAG support). */
  mergeBranches: (
    worktreePath: string,
    branches: string[],
    opts?: { leaveOnConflict?: boolean },
  ) => Promise<{ ok: true } | { ok: false; conflict: string }>;
  /**
   * Best-effort abort of an in-progress merge. Used by the auto-resolver path
   * after a resolver subprocess fails to finalize the merge. Optional — when
   * absent, the walker falls back to its legacy "merge conflict = task fail"
   * behavior with no resolver attempt.
   */
  abortMerge?: (worktreePath: string) => Promise<void>;
  /**
   * Inspect the worktree's merge / unmerged state. The walker uses this to
   * decide whether a resolver subprocess actually finalised the merge or
   * left it dangling. Optional; see {@link WalkerDeps.abortMerge}.
   */
  getMergeStatus?: (worktreePath: string) => Promise<{
    inMerge: boolean;
    unmergedPaths: string[];
    headCommit: string;
  }>;
  /** Minimum milliseconds between subprocess launches. 0 disables pacing. */
  interTaskPacingMs: number;
  /**
   * When true, rate-limit pauses auto-schedule a resume timer after the reset
   * window. When false (default), the walker stays paused until the user
   * explicitly calls resume() — matching ToS-conservative posture.
   */
  autoResumeRateLimit: boolean;
  /**
   * Optional QA-replan hook. Called when a `qa`-role task fails terminally.
   * Returns a fresh Plan to swap in (under the same runId), or null to fall
   * through to the normal failure path. Capped at 1 invocation per run by
   * the walker.
   */
  replanOnQAFailure?: (args: {
    failedPlan: Plan;
    failedTaskId: string;
    qaError: string;
  }) => Promise<{ newPlan: Plan; newPlanId: string } | null>;
  /**
   * Optional extra budget check, evaluated after the walker's own
   * minutes/turns gates inside {@link Walker.checkBudget}. The dashboard wires
   * this to the autopilot budget so an `autopilotBudgetTokens` or
   * `autopilotBudgetMinutes` ceiling actually hard-kills a live run instead of
   * only being consulted at autopilot-resume time.
   *
   * Receives the current cumulative token total (in + out) the walker has
   * observed via task.usage events. Returns `{exceeded:true}` to trigger a
   * `cancel('budget_exceeded')` with a `resource.exceeded` event whose `kind`
   * is `'tokens'` (so the UI can distinguish autopilot caps from the walker's
   * own time/turns caps). Errors are swallowed — a flaky check must never
   * crash the dispatch loop.
   */
  extraBudgetCheck?: (args: {
    runId: string;
    tokensTotal: number;
  }) => Promise<{ exceeded: boolean; reason: string | null }>;
  /**
   * Optional inactivity-watchdog liveness probe. When the watchdog timer
   * fires the walker calls this with the task id and uses the result to
   * decide whether to kill+retry or extend the grace period.
   *
   * Return value:
   * - `null` — probe unavailable for this task (no pid wired yet, or
   *   the underlying process handle was reaped). Walker falls back to
   *   "kill immediately" — preserving the pre-v1.7.13 behavior for
   *   callers that haven't opted in.
   * - `{alive: false, cpuSeconds: *}` — pid is gone (e.g. process.kill
   *   with signal 0 threw ESRCH). Walker kills+retries immediately.
   * - `{alive: true, cpuSeconds: null}` — pid is alive but CPU read
   *   failed. Walker assumes "stuck" and kills at the extended deadline
   *   on the next tick (no CPU-advancement signal to act on).
   * - `{alive: true, cpuSeconds: n}` — pid is alive. Walker compares
   *   `n` to the CPU snapshot taken when the current idle window
   *   started; if it advanced ≥1s the proc is doing work and the
   *   grace period is extended (capped by
   *   {@link INACTIVITY_MAX_TOTAL_MS}).
   *
   * Why optional: the production wiring lives in the dashboard server
   * (which owns the spawn pid). The default `liveness.probePidLiveness`
   * helper is shipped from this package so the dashboard can pass it
   * through trivially once it tracks per-task pids.
   *
   * See {@link INACTIVITY_TIMEOUT_MS} for the 2026-05-17 FocusBoard
   * `n3-store` regression that motivated this.
   */
  probeSubprocessLiveness?: (
    taskId: string,
  ) => { alive: boolean; cpuSeconds: number | null } | null;
  /**
   * Optional per-role override merger built by the runtime from the project's
   * `project_agent_overrides` rows. Lets a project swap a role's model,
   * append an extra system prompt, or union extra allowed-tools without
   * touching the team config. Passed as a closure so the orchestrator
   * package doesn't have to know about the AgentOverride schema.
   *
   * Implementation lives in `apps/dashboard-server/src/orchestrator/agent-overrides.ts`
   * (`applyAgentOverride`); the runtime closes over the loaded override map.
   */
  applyAgentOverride?: <T extends { model: string; systemPrompt: string; allowedTools: string[] }>(
    role: string,
    base: T,
  ) => T;
  /**
   * Pre-rendered "## Prior Handoffs" markdown section for the current
   * project. Built by the runtime from
   * `loadHandoffsForProject + renderHandoffsSection`. Empty string when no
   * handoffs exist (the prompt composer omits the section in that case).
   */
  handoffsSection?: string;
}

/**
 * Optional state to seed when resuming a previously-paused walker (E2).
 *
 * - `completedTaskIds`: tasks already done — Walker treats them as `done` and
 *   never dispatches them again.
 * - `failedTaskIds`: tasks that already terminally failed — Walker treats them
 *   as `failed` and skips them.
 * - `resumableTasks`: tasks that were running/paused at shutdown. Walker queues
 *   them for re-launch; if `sessionId` is provided, the next subprocess invoke
 *   passes `--resume <sessionId>` via {@link RunClaudeOpts.resumeSessionId}.
 *
 * Tasks not in any list are dispatched fresh as new pending work.
 */
export interface InitialWalkerState {
  completedTaskIds: string[];
  failedTaskIds: string[];
  resumableTasks: Array<{ taskId: string; sessionId?: string }>;
}

export interface StartArgs {
  runId: string;
  plan: Plan;
  repoPath: string;
  budget: BudgetConfig;
  /** E2: pre-seed state when rebuilding a walker after a server restart. */
  initialState?: InitialWalkerState;
}

export interface WalkerStatus {
  runId: string | null;
  state: 'idle' | 'running' | 'paused' | 'completed';
  pausedReason: RunPausedReason | null;
  resumeAt: number | null;
  taskStates: Record<string, TaskStatusValue>;
  retries: Record<string, number>;
}

// ---------- internal types ----------

/**
 * Transient infrastructure failures (Anthropic 5xx, network blips, rate-limit
 * chatter) that should NOT count against a task's regular retry budget. Used
 * by both the resolver subprocess loop and the main task subprocess loop.
 */
export const TRANSIENT_RE =
  /(\b5(29|03)\b|Overloaded|Service Unavailable|temporarily unavailable|rate.?limit|ETIMEDOUT|ECONNRESET)/i;

/**
 * Max attempts a task subprocess can take when every prior attempt died with a
 * transient marker. Independent of {@link TaskRuntime.retries} (which is the
 * structural-error budget). 5 attempts × ~10s backoff per step covers a
 * multi-minute Anthropic 529 storm without spending the structural budget.
 */
export const MAX_TRANSIENT_RETRIES = 5;

/** Base backoff (multiplied by attempt #) before re-launching a task subprocess after a transient failure. */
export const TRANSIENT_BACKOFF_MS = 10_000;

/**
 * Maximum time the walker waits between events from a task subprocess before
 * assuming it's hung and aborting it. The 2026-05-15 wertzeit-app retry on
 * v1.7.11 surfaced a real hang: n1-architecture emitted its final
 * "Documentation complete" text-delta then sat for 3 hours without exiting
 * — the claude CLI never wrote its `result` frame, the walker had no
 * inactivity timeout, and the whole run froze. Counts as a transient failure
 * so the existing retry budget recovers it.
 *
 * Bumped 10→15 min on the 2026-05-17 FocusBoard run: the previous 10-min
 * default false-killed `n3-store` after a normal LLM thinking pause (no
 * tool/text frame, but the subprocess was alive and burning CPU). The new
 * watchdog also probes pid-liveness + CPU advancement before killing — see
 * {@link WalkerDeps.probeSubprocessLiveness} and the watchdog handler in
 * runTask.
 */
export const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Grace-period extension when the watchdog fires and the probe shows the
 * subprocess is alive AND its CPU time has advanced ≥1s during the idle
 * window. The watchdog re-arms for another {@link INACTIVITY_EXTENSION_MS}
 * before re-probing.
 */
export const INACTIVITY_EXTENSION_MS = 5 * 60 * 1000;

/**
 * Hard ceiling on cumulative grace-period extensions. Even a subprocess
 * that keeps showing CPU progress gets killed once it has been silent on
 * the event stream for this long — the alternative is an infinite-loop
 * agent that produces no observable output ever finishing.
 */
export const INACTIVITY_MAX_TOTAL_MS = 25 * 60 * 1000;

/**
 * Minimum CPU-time advancement (seconds) within the idle window that
 * counts as "doing real work". A subprocess that has burned <1s of CPU
 * across a full 15-min idle window is almost certainly stuck (the claude
 * CLI is reading a streaming HTTP response, not running compute).
 */
export const INACTIVITY_MIN_CPU_DELTA_S = 1;

interface TaskRuntime {
  node: TaskNode;
  status: TaskStatusValue;
  retries: number; // number of retries already attempted (0 or 1)
  /**
   * Separate retry counter that increments only when the previous attempt died
   * with a transient infrastructure marker (5xx, rate-limit, network reset).
   * Bounded by {@link MAX_TRANSIENT_RETRIES}; does NOT consume the regular
   * `retries` budget so a real bug still surfaces after 1 normal retry.
   */
  transientRetries: number;
  attempt: number; // attempt counter (1, 2)
  worktreePath: string | null;
  branchName: string | null;
  sessionId: string | null;
  tokensIn: number;
  tokensOut: number;
  turnsUsed: number;
  startedAt: number | null;
  abort: AbortController | null;
  /** Resolves when the running attempt's drain loop finishes. */
  done: Promise<void> | null;
  /** Set true if a rate-limit was observed for this attempt. */
  rateLimited: boolean;
  /** Error from previous attempt; included in next attempt's prompt. */
  lastError: string | null;
  /**
   * Last per-task usage counters reported via task.usage. Used to compute the
   * delta to add to run-level totals when cumulative usage events arrive.
   */
  lastReportedTokensIn: number;
  lastReportedTokensOut: number;
  lastReportedTurns: number;
}

const RATE_LIMIT_DEFAULT_MS = 5 * 60 * 60 * 1000; // 5h

// ---------- Walker ----------

export class Walker {
  private readonly deps: WalkerDeps;

  private runId: string | null = null;
  private plan: Plan | null = null;
  private repoPath: string | null = null;
  private budget: BudgetConfig | null = null;

  private tasks: Map<string, TaskRuntime> = new Map();
  private state: 'idle' | 'running' | 'paused' | 'completed' = 'idle';
  private pausedReason: RunPausedReason | null = null;
  private resumeAt: number | null = null;
  private resumeCanceler: (() => void) | null = null;

  private startedAt = 0;
  private finalOutcome: RunOutcome | null = null;
  private warnedTime = false;
  private warnedTurns = false;

  /**
   * Run-level totals are sums of per-task maxes. We maintain them incrementally
   * (delta-add per task.usage event) rather than re-summing every event so the
   * cost stays O(1) per usage event regardless of plan size.
   */
  private runTokensInTotal = 0;
  private runTokensOutTotal = 0;
  private runTurnsTotal = 0;

  private finishResolve: ((outcome: RunOutcome) => void) | null = null;
  private finishPromise: Promise<RunOutcome> | null = null;

  /** Set when dispatch() is currently active; prevents re-entrancy storms. */
  private dispatching = false;
  /**
   * Set to `true` when `dispatch()` is called while another dispatch is
   * already in flight. The in-flight call clears the flag in its `finally`
   * block and re-fires once if it was set, so concurrent task completions
   * can never silently lose a wake-up. Without this, two tasks finishing in
   * the same microtask flush would race for the dispatch lock and the loser
   * would `return` immediately even if new slots were free.
   */
  private pendingDispatch = false;
  /** Timestamp of the last subprocess launch batch. 0 means no launch yet. */
  private lastLaunchAt = 0;

  private consecutiveFailures = 0;
  private runErrorReason: string | null = null;
  private static readonly CONSECUTIVE_FAILURE_THRESHOLD = 3;

  private replanCount = 0;
  private static readonly MAX_REPLANS_PER_RUN = 1;

  constructor(deps: WalkerDeps) {
    this.deps = deps;
  }

  // ---------- lifecycle ----------

  async start(args: StartArgs): Promise<RunOutcome> {
    if (this.state !== 'idle') {
      throw new Error(`Walker already started (state=${this.state})`);
    }
    this.runId = args.runId;
    this.plan = args.plan;
    this.repoPath = args.repoPath;
    this.budget = args.budget;
    this.startedAt = this.deps.now();
    this.replanCount = 0;

    // Build seed maps from initialState (E2 — resume after shutdown).
    const seed = args.initialState;
    const completed = new Set(seed?.completedTaskIds ?? []);
    const failed = new Set(seed?.failedTaskIds ?? []);
    const resumableSessions = new Map<string, string | undefined>();
    for (const r of seed?.resumableTasks ?? []) {
      resumableSessions.set(r.taskId, r.sessionId);
    }

    // Seed task runtimes.
    for (const node of args.plan.nodes) {
      let status: TaskStatusValue = 'pending';
      let sessionId: string | null = null;
      if (completed.has(node.id)) {
        status = 'done';
      } else if (failed.has(node.id)) {
        status = 'failed';
      } else if (resumableSessions.has(node.id)) {
        // Resumable tasks dispatch as fresh `pending` but carry their sessionId
        // so runClaude is invoked with --resume <sessionId>.
        sessionId = resumableSessions.get(node.id) ?? null;
      }
      this.tasks.set(node.id, {
        node,
        status,
        retries: 0,
        transientRetries: 0,
        attempt: 0,
        worktreePath: null,
        branchName: null,
        sessionId,
        tokensIn: 0,
        tokensOut: 0,
        turnsUsed: 0,
        startedAt: null,
        abort: null,
        done: null,
        rateLimited: false,
        lastError: null,
        lastReportedTokensIn: 0,
        lastReportedTokensOut: 0,
        lastReportedTurns: 0,
      });
    }

    this.state = 'running';
    this.deps.emit({ type: 'run.started', payload: { runId: args.runId } });
    await this.deps.onRunState(args.runId, {
      status: 'running',
      startedAt: new Date(this.startedAt),
    });

    this.finishPromise = new Promise<RunOutcome>((resolve) => {
      this.finishResolve = resolve;
    });

    // Kick off dispatch (don't await — dispatch returns immediately after
    // launching slots; tasks complete asynchronously and re-trigger dispatch).
    void this.dispatch();

    return this.finishPromise;
  }

  async pause(reason: RunPausedReason, resumeAt?: number): Promise<void> {
    if (this.state !== 'running' || !this.runId) return;
    this.state = 'paused';
    this.pausedReason = reason;
    this.resumeAt = resumeAt ?? null;

    // Abort all running tasks (subprocesses get SIGTERM via abort signal).
    for (const t of this.tasks.values()) {
      if (t.status === 'running') {
        t.abort?.abort();
        t.status = 'paused';
        await this.deps.onTaskState(t.node.id, { status: 'pending' }); // DB has no 'paused' enum
      }
    }

    await this.deps.onRunState(this.runId, {
      status: 'paused',
      pausedReason: reason,
      resumeAt: resumeAt != null ? new Date(resumeAt) : null,
    });
    this.deps.emit({
      type: 'run.paused',
      payload: { runId: this.runId, pausedReason: reason, resumeAt: resumeAt ?? null },
    });

    // Schedule auto-resume only for rate-limit pauses AND only when explicitly enabled.
    if (reason === 'rate-limit' && this.deps.autoResumeRateLimit) {
      const delay = Math.max(
        (resumeAt ?? this.deps.now() + RATE_LIMIT_DEFAULT_MS) - this.deps.now(),
        0,
      );
      this.resumeCanceler = this.deps.setTimeout(() => {
        void this.resume();
      }, delay);
    }
  }

  /**
   * E2 — graceful shutdown pause.
   *
   * Stops dispatching, aborts running subprocesses, persists a checkpoint, and
   * marks the run as `paused` with `pausedReason='shutdown'`. Awaits the running
   * task drain promises so callers can sequence with Fastify.close().
   *
   * Safe to call multiple times — second call is a no-op.
   */
  async pauseForShutdown(): Promise<void> {
    if (this.state !== 'running' || !this.runId) {
      // Already paused / completed — nothing to do.
      return;
    }
    // Capture in-flight task drains so we can await them after the abort.
    const drains: Array<Promise<void>> = [];
    for (const t of this.tasks.values()) {
      if (t.status === 'running' && t.done) drains.push(t.done);
    }
    await this.pause('shutdown');
    // Best-effort snapshot AFTER state is recorded. The snapshot reads DB rows
    // which were just updated by pause()'s onRunState/onTaskState calls.
    try {
      await this.deps.snapshot(this.runId);
    } catch {
      // Snapshot is best-effort; failure must not block shutdown.
    }
    // Wait for the abort signals to drain (with a soft cap so a stuck pool
    // doesn't deadlock the shutdown sequence — outer caller still enforces
    // a hard timeout).
    await Promise.allSettled(drains);
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused' || !this.runId) return;
    if (this.resumeCanceler) {
      this.resumeCanceler();
      this.resumeCanceler = null;
    }
    this.state = 'running';
    this.pausedReason = null;
    this.resumeAt = null;
    await this.deps.onRunState(this.runId, {
      status: 'running',
      pausedReason: null,
      resumeAt: null,
    });
    this.deps.emit({ type: 'run.resumed', payload: { runId: this.runId } });

    // Re-mark paused tasks as pending so dispatch picks them up.
    for (const t of this.tasks.values()) {
      if (t.status === 'paused') {
        t.status = 'pending';
        // Reset abort controller so the new attempt is independent.
        t.abort = null;
      }
    }
    void this.dispatch();
  }

  async cancel(outcome: RunOutcome = 'cancelled'): Promise<void> {
    if (!this.runId || this.state === 'completed') return;
    if (this.resumeCanceler) {
      this.resumeCanceler();
      this.resumeCanceler = null;
    }
    this.finalOutcome = outcome;
    // Flip to a terminal state quickly so dispatch() stops scheduling.
    this.state = 'completed';
    // Belt-and-suspenders: also pull the pool-level abort lever so any
    // subprocess that bypassed the per-task signal still terminates.
    try {
      this.deps.pool.terminateAll();
    } catch {
      // ignore
    }
    // Track running tasks so we can clean their worktrees on user-cancel.
    const runningWorktrees: Array<{ worktreePath: string }> = [];
    // v1.7.13 — Persist 'cancelled' (not 'failed') for tasks killed by the
    // explicit user-cancel path. The UI splits these into a distinct bucket
    // so users can tell "I cancelled this" from "it crashed". Tasks killed
    // by upstream dep-failure cascade (cancelTasksWithDeadDeps) still write
    // 'failed' since that is semantically a failure cascade, not a cancel.
    const persistedCancelStatus = outcome === 'cancelled' ? 'cancelled' : 'failed';
    for (const t of this.tasks.values()) {
      if (t.status === 'running' || t.status === 'paused') {
        if (t.status === 'running' && t.worktreePath) {
          runningWorktrees.push({ worktreePath: t.worktreePath });
        }
        t.abort?.abort();
        t.status = 'cancelled';
        await this.deps.onTaskState(t.node.id, { status: persistedCancelStatus });
      } else if (t.status === 'pending' || t.status === 'ready') {
        t.status = 'cancelled';
        await this.deps.onTaskState(t.node.id, { status: persistedCancelStatus });
      }
    }
    // Worktree cleanup policy:
    //   - 'cancelled' (user) — remove worktrees of running tasks.
    //   - 'budget_exceeded' — leave them intact for forensics.
    //   - other terminal outcomes — leave intact.
    if (outcome === 'cancelled' && this.repoPath) {
      const repoPath = this.repoPath;
      await Promise.allSettled(
        runningWorktrees.map((w) =>
          this.deps.worktree.remove({ repoPath, worktreePath: w.worktreePath, force: true }),
        ),
      );
    }
    await this.finalize(outcome);
  }

  status(): WalkerStatus {
    const taskStates: Record<string, TaskStatusValue> = {};
    const retries: Record<string, number> = {};
    for (const [id, t] of this.tasks) {
      taskStates[id] = t.status;
      retries[id] = t.retries;
    }
    return {
      runId: this.runId,
      state: this.state,
      pausedReason: this.pausedReason,
      resumeAt: this.resumeAt,
      taskStates,
      retries,
    };
  }

  // ---------- internals ----------

  private async dispatch(): Promise<void> {
    if (this.dispatching) {
      // Another dispatch is in flight — record that we tried to re-arm so
      // the holder re-fires once it releases the lock.
      this.pendingDispatch = true;
      return;
    }
    this.dispatching = true;
    try {
      while (this.state === 'running') {
        if (!this.budget || !this.plan || !this.runId || !this.repoPath) return;

        const ready = this.findReady();
        const slotsFree = this.budget.maxParallel - this.countRunning();

        if (ready.length === 0 || slotsFree <= 0) {
          // If no tasks running and none ready, the DAG is drained — finalize.
          if (this.countRunning() === 0 && ready.length === 0) {
            // Mark pending tasks whose deps will never be satisfied as
            // cancelled. Without this, a single terminal failure upstream
            // would leave the walker spinning forever waiting for tasks
            // that can never become ready.
            this.cancelTasksWithDeadDeps();
            const allDone = Array.from(this.tasks.values()).every(
              (t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled',
            );
            if (allDone) {
              const anyFailed = Array.from(this.tasks.values()).some(
                (t) => t.status === 'failed' || t.status === 'cancelled',
              );
              await this.finalize(anyFailed ? 'failure' : 'success');
            }
          }
          return;
        }

        // Inter-task pacing: enforce a minimum gap between subprocess launches.
        const pacingMs = this.deps.interTaskPacingMs;
        if (pacingMs > 0 && this.lastLaunchAt > 0) {
          const wait = this.lastLaunchAt + pacingMs - this.deps.now();
          if (wait > 0) {
            this.deps.setTimeout(() => {
              void this.dispatch();
            }, wait);
            return;
          }
        }

        // Launch up to `slotsFree` ready tasks.
        const toLaunch = ready.slice(0, slotsFree);
        for (const t of toLaunch) {
          t.status = 'running';
          t.attempt += 1;
          t.startedAt = this.deps.now();
          // Fire-and-forget. We DON'T `.then(() => void this.dispatch())`
          // here: the `pendingDispatch` flag in the dispatch lock-release
          // path is the single re-arm channel. Two channels firing
          // simultaneously can race in `findReady()` and double-launch the
          // same task. The completion bumps `pendingDispatch` via runTask's
          // completion-side dispatch() call.
          t.done = this.runTask(t).finally(() => {
            void this.dispatch();
          });
        }
        this.lastLaunchAt = this.deps.now();

        // Yield: don't busy-loop. We only loop in this iteration if there are
        // still free slots AND ready tasks, which we filled above. Break.
        return;
      }
    } finally {
      this.dispatching = false;
      if (this.pendingDispatch) {
        // A concurrent caller bumped the pending flag while we held the
        // lock. Re-fire once so any newly-ready tasks get launched even if
        // the slot-counts and ready-set changed during this dispatch.
        this.pendingDispatch = false;
        void this.dispatch();
      }
    }
  }

  private findReady(): TaskRuntime[] {
    const ready: TaskRuntime[] = [];
    for (const t of this.tasks.values()) {
      if (t.status !== 'pending') continue;
      const allDepsDone = t.node.deps.every((dep) => {
        const d = this.tasks.get(dep);
        return !!d && d.status === 'done';
      });
      if (allDepsDone) ready.push(t);
    }
    return ready;
  }

  /**
   * Auto-resolve a dep-merge conflict by spawning a focused subprocess that
   * integrates both sides and commits the merge. The conflict is real (two
   * parallel deps edited overlapping regions of the same file); this method
   * only succeeds if the subprocess produces a proper merge commit.
   *
   * Returns `{ ok: true }` when the worktree is back to a clean post-merge
   * state. Returns `{ ok: false, reason }` when:
   *   - the new walker deps (abortMerge/getMergeStatus) are not wired
   *   - re-attempting the merge does not even enter conflict state
   *   - the resolver subprocess crashes
   *   - the resolver leaves unmerged paths or aborts the merge
   *
   * Token usage from the resolver is attributed to the parent task so the
   * run-level counters stay honest.
   */
  private async attemptAutoResolveMerge(args: {
    runId: string;
    worktreePath: string;
    otherDepBranches: string[];
    node: TaskNode;
    taskRuntime: TaskRuntime;
    initialConflict: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { runId, worktreePath, otherDepBranches, node, taskRuntime } = args;
    const abortMerge = this.deps.abortMerge;
    const getMergeStatus = this.deps.getMergeStatus;
    if (!abortMerge || !getMergeStatus) {
      // Legacy deps: no resolver capability wired.
      return { ok: false, reason: 'auto-resolver unavailable (deps not wired)' };
    }

    // Re-attempt the merge, this time leaving the conflict in the working
    // tree so the resolver can fix it in place. The first attempt already
    // auto-aborted, so we're back at the pre-merge HEAD.
    const attempt = await this.deps.mergeBranches(worktreePath, otherDepBranches, {
      leaveOnConflict: true,
    });
    if (attempt.ok) {
      // Race: the re-attempt merged cleanly. Accept and continue.
      return { ok: true };
    }

    const preStatus = await getMergeStatus(worktreePath);
    if (!preStatus.inMerge && preStatus.unmergedPaths.length === 0) {
      return { ok: false, reason: 'merge did not enter conflict state on retry' };
    }

    this.deps.emit({
      type: 'task.text-delta',
      payload: {
        taskId: node.id,
        text: `\n[harness] dep-merge conflict in: ${preStatus.unmergedPaths.join(', ')}\n[harness] spawning merge-resolver agent...\n`,
      },
    });

    const resolverPrompt =
      `A git merge has just failed in this worktree with conflicts in:\n` +
      preStatus.unmergedPaths.map((p) => `  - ${p}`).join('\n') +
      `\n\nThe merge is mid-flight: HEAD is pre-merge, MERGE_HEAD points at the second parent, and the conflicted files contain <<<<<<< / ======= / >>>>>>> markers.\n\n` +
      `Your single job: integrate both sides of every conflict and finalise the merge.\n\n` +
      `Procedure:\n` +
      `  1. For each conflicted file, read its current contents (with the markers) and inspect both intents via "git show :2:<file>" (ours) and "git show :3:<file>" (theirs).\n` +
      `  2. Edit the file to a single coherent version that preserves BOTH intents wherever they don't logically collide. Never blindly delete one side's work.\n` +
      `  3. Run "git add <file>" for each resolved file.\n` +
      `  4. After every conflict is resolved, run:\n` +
      `       git -c user.email=wisp@wisp.local -c user.name=WISP -c commit.gpgsign=false -c tag.gpgsign=false commit --no-edit\n` +
      `     to finalise the merge.\n\n` +
      `Hard rules:\n` +
      `  - Do NOT run "git merge --abort". Resolving the conflict is the only acceptable outcome.\n` +
      `  - Do NOT introduce new functionality beyond what is needed to integrate the conflicting changes.\n` +
      `  - Do NOT modify files that are not unmerged.\n\n` +
      `Context (do not start implementing this task itself — only resolve the merge):\n` +
      `  Role: ${node.role}\n  Task: ${node.id}\n`;

    // Transient infrastructure errors (Anthropic 529 / 503 / "Overloaded" /
    // rate-limit chatter) can kill a resolver subprocess before it does any
    // real work — exactly what happened on n13-builder during the 2026-05-15
    // wertzeit-app run. Without retry, a momentary upstream blip cascade-
    // fails every downstream task. Retry the resolver up to N times when we
    // detect a transient pattern AND the worktree is still in merge state.
    // Pattern (TRANSIENT_RE) is shared with the main task subprocess retry
    // path so the two paths agree on what counts as "infra blip".
    const MAX_RESOLVER_ATTEMPTS = 3;
    const RETRY_BACKOFF_MS = 5000;

    let postStatus: { inMerge: boolean; unmergedPaths: string[]; headCommit: string } = preStatus;
    let lastReason = 'resolver did not finalise merge';
    let lastTransientSeen = false;

    for (let attempt = 1; attempt <= MAX_RESOLVER_ATTEMPTS; attempt++) {
      let resolverCrashed = false;
      let transientSeen = false;

      if (attempt > 1) {
        this.deps.emit({
          type: 'task.text-delta',
          payload: {
            taskId: node.id,
            text: `[harness] retrying merge-resolver (attempt ${attempt}/${MAX_RESOLVER_ATTEMPTS}) after transient infra error\n`,
          },
        });
      }

      try {
        const iter = this.deps.pool.run({
          cwd: worktreePath,
          prompt: resolverPrompt,
          systemPrompt:
            'You are an automated merge-conflict resolver embedded in a multi-agent harness. You operate inside a worktree with an unfinished git merge. Your single job is to resolve every conflict and commit the merge. Be precise, brief, and stay strictly within scope.',
          allowedTools: ['Read', 'Edit', 'Write', 'Bash'],
          maxTurns: 25,
          taskId: `${node.id}:merge-resolver`,
          runId,
        });
        for await (const ev of iter) {
          this.deps.emit(ev);
          // Watch for transient infra error markers anywhere the CLI surfaces
          // them — `claude -p` emits API 529/503 errors as text-delta frames
          // (treated as model output) right before exiting non-zero. The
          // detector here is intentionally narrow so an agent legitimately
          // discussing rate limits in resolved code doesn't trigger a retry.
          if (ev.type === 'task.text-delta' && TRANSIENT_RE.test(ev.payload.text)) {
            transientSeen = true;
          }
          if (ev.type === 'task.failed' && TRANSIENT_RE.test(ev.payload.error)) {
            transientSeen = true;
          }
          // Attribute resolver usage to the parent task so run-level totals
          // include the resolver's tokens/turns. Without this, the resolver
          // is invisible in the dashboard counters even though it consumed
          // real quota.
          if (ev.type === 'task.usage') {
            const newTokensIn = Math.max(taskRuntime.tokensIn, ev.payload.tokensIn);
            const newTokensOut = Math.max(taskRuntime.tokensOut, ev.payload.tokensOut);
            const newTurns = Math.max(taskRuntime.turnsUsed, ev.payload.turns);
            this.runTokensInTotal += newTokensIn - taskRuntime.lastReportedTokensIn;
            this.runTokensOutTotal += newTokensOut - taskRuntime.lastReportedTokensOut;
            this.runTurnsTotal += newTurns - taskRuntime.lastReportedTurns;
            taskRuntime.tokensIn = newTokensIn;
            taskRuntime.tokensOut = newTokensOut;
            taskRuntime.turnsUsed = newTurns;
            taskRuntime.lastReportedTokensIn = newTokensIn;
            taskRuntime.lastReportedTokensOut = newTokensOut;
            taskRuntime.lastReportedTurns = newTurns;
            await this.deps.onTaskState(node.id, {
              tokensIn: taskRuntime.tokensIn,
              tokensOut: taskRuntime.tokensOut,
              turnsUsed: taskRuntime.turnsUsed,
            });
          }
        }
      } catch (err) {
        resolverCrashed = true;
        const errStr = err instanceof Error ? err.message : String(err);
        if (TRANSIENT_RE.test(errStr)) transientSeen = true;
        this.deps.emit({
          type: 'task.text-delta',
          payload: { taskId: node.id, text: `[harness] resolver crashed: ${errStr}\n` },
        });
      }

      postStatus = await getMergeStatus(worktreePath);
      const clean = !postStatus.inMerge && postStatus.unmergedPaths.length === 0;
      const headAdvanced = postStatus.headCommit !== preStatus.headCommit;

      if (clean && headAdvanced) {
        this.deps.emit({
          type: 'task.text-delta',
          payload: {
            taskId: node.id,
            text: `[harness] merge-resolver finalised the merge; continuing task\n`,
          },
        });
        return { ok: true };
      }

      if (clean && !headAdvanced) {
        // Resolver explicitly aborted the merge — no retry would help.
        return { ok: false, reason: 'resolver aborted the merge instead of resolving' };
      }

      lastTransientSeen = transientSeen;
      lastReason = resolverCrashed
        ? 'resolver crashed mid-merge'
        : `resolver did not finalise merge (still unmerged: ${postStatus.unmergedPaths.join(', ') || 'MERGE_HEAD set'})`;

      // Retry only when the failure looks transient and we have attempts left.
      // A "structurally impossible" merge would just consume the budget without
      // changing outcome — give up early in that case.
      if (transientSeen && attempt < MAX_RESOLVER_ATTEMPTS) {
        await new Promise<void>((resolve) => {
          this.deps.setTimeout(resolve, RETRY_BACKOFF_MS * attempt);
        });
        continue;
      }
      break;
    }

    await abortMerge(worktreePath);
    return {
      ok: false,
      reason: lastTransientSeen ? `${lastReason}; gave up after transient retries` : lastReason,
    };
  }

  /**
   * Synchronously transitions every pending task with at least one terminally-
   * failed (or cancelled) dependency to `cancelled`, emitting a `task.failed`
   * event with a synthetic "upstream dep failed" error. Called from the
   * dispatch finalizer when no tasks are running and none are ready, so the
   * walker can finalize instead of spinning.
   *
   * Kept synchronous (no await) on purpose: introducing an await here would
   * yield to the event loop in the middle of finalization and could re-order
   * other in-flight runTask completions, which is its own subtle bug class.
   */
  private cancelTasksWithDeadDeps(): void {
    for (const t of this.tasks.values()) {
      if (t.status !== 'pending') continue;
      const blocked = t.node.deps.some((dep) => {
        const d = this.tasks.get(dep);
        return !!d && (d.status === 'failed' || d.status === 'cancelled');
      });
      if (blocked) {
        t.status = 'cancelled';
        // Persist the cancellation; not awaiting is intentional — we want
        // the local state machine to advance synchronously. The DB write is
        // best-effort and bubbles up via the normal persistTaskPatch error
        // swallow.
        void this.deps.onTaskState(t.node.id, { status: 'failed' });
        this.deps.emit({
          type: 'task.failed',
          payload: { taskId: t.node.id, error: 'cancelled: upstream dep failed' },
        });
      }
    }
  }

  private countRunning(): number {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.status === 'running') n++;
    }
    return n;
  }

  /**
   * Branch prefix for the current plan version. v1 (the original plan) has no
   * prefix to preserve backward compatibility with existing tests + the result-
   * branch finalize path. Replans get an explicit v2/v3/... prefix so their
   * tasks don't collide with the predecessor plan's branches.
   */
  private branchPrefix(): string {
    if (this.replanCount === 0) return `wisp/${this.runId}`;
    const version = this.replanCount + 1;
    return `wisp/${this.runId}/v${version}`;
  }

  /**
   * Resolve the actual git branch name for a dependency. Carried-over `done`
   * tasks after a replan have branches under the OLD prefix (e.g.
   * `wisp/<runId>/B` from the original plan), while new tasks live under
   * the v<N> prefix. Recomputing from `branchPrefix()` here would synthesise
   * non-existent refs like `wisp/<runId>/v2/B` and any new task that
   * depends on a carried-over done task would fail at `git worktree add`
   * with "fatal: invalid reference". Use the runtime's stored branchName
   * for done deps; fall back to the current prefix for everything else.
   */
  private branchForDep(depId: string): string {
    const dep = this.tasks.get(depId);
    if (dep?.status === 'done' && dep.branchName) return dep.branchName;
    return `${this.branchPrefix()}/${depId}`;
  }

  private computeParentBranch(node: TaskNode): string | undefined {
    const firstDep = node.deps[0];
    if (firstDep === undefined) return undefined;
    return this.branchForDep(firstDep);
  }

  private async runTask(t: TaskRuntime): Promise<void> {
    if (!this.runId || !this.plan || !this.repoPath) return;
    const runId = this.runId;
    const plan = this.plan;
    const repoPath = this.repoPath;
    const node = t.node;

    const branchName = `${this.branchPrefix()}/${node.id}`;
    t.branchName = branchName;
    t.rateLimited = false;
    const abort = new AbortController();
    t.abort = abort;

    const agent: AgentSpec | undefined = plan.team.roles.find((r) => r.role === node.role);
    if (!agent) {
      t.status = 'failed';
      await this.deps.onTaskState(node.id, { status: 'failed' });
      this.deps.emit({
        type: 'task.failed',
        payload: {
          taskId: node.id,
          error: `role '${node.role}' not in team`,
        },
      });
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= Walker.CONSECUTIVE_FAILURE_THRESHOLD) {
        await this.pause('consecutive-failures');
      }
      return;
    }

    let worktreePath: string | null = t.worktreePath;
    let createdWorktreeNow = false;
    try {
      if (!worktreePath) {
        const parentBranch = this.computeParentBranch(node);
        worktreePath = await this.deps.worktree.add({
          repoPath,
          branchName,
          baseBranch: parentBranch,
        });
        t.worktreePath = worktreePath;
        createdWorktreeNow = true;
      }
    } catch (err) {
      t.status = 'failed';
      const errStr = err instanceof Error ? err.message : String(err);
      this.deps.emit({
        type: 'task.failed',
        payload: { taskId: node.id, error: `worktree add failed: ${errStr}` },
      });
      await this.deps.onTaskState(node.id, { status: 'failed', worktreeBranch: branchName });
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= Walker.CONSECUTIVE_FAILURE_THRESHOLD) {
        await this.pause('consecutive-failures');
      }
      return;
    }

    if (createdWorktreeNow && node.deps.length > 1) {
      // Same carry-over correction as computeParentBranch: a new task whose
      // 2nd+ dep is a carried-over done task needs to merge the dep's old
      // branch (under the original prefix), not a non-existent v<N> branch.
      const otherDepBranches = node.deps.slice(1).map((d) => this.branchForDep(d));
      const mergeResult = await this.deps.mergeBranches(worktreePath, otherDepBranches);
      if (!mergeResult.ok) {
        // Auto-resolver path: when two parallel deps edited the same files,
        // a plain `git merge --no-ff` will conflict — but the conflicts are
        // usually mechanical to integrate. Spawn a focused resolver subprocess
        // in the worktree before giving up. Only when the resolver itself
        // fails do we cascade-fail the task.
        const resolve = await this.attemptAutoResolveMerge({
          runId,
          worktreePath,
          otherDepBranches,
          node,
          taskRuntime: t,
          initialConflict: mergeResult.conflict,
        });
        if (!resolve.ok) {
          t.status = 'failed';
          await this.deps.onTaskState(node.id, { status: 'failed', worktreeBranch: branchName });
          this.deps.emit({
            type: 'task.failed',
            payload: {
              taskId: node.id,
              error: `dep-merge conflict: ${mergeResult.conflict} (auto-resolver: ${resolve.reason})`,
            },
          });
          this.consecutiveFailures += 1;
          if (this.consecutiveFailures >= Walker.CONSECUTIVE_FAILURE_THRESHOLD) {
            await this.pause('consecutive-failures');
          }
          return;
        }
        // Resolver finalised the merge — fall through to the normal subprocess
        // launch below.
      }
    }

    await this.deps.onTaskState(node.id, {
      status: 'running',
      worktreeBranch: branchName,
    });
    this.deps.emit({ type: 'task.started', payload: { taskId: node.id } });

    let lastTaskFailedError: string | null = null;
    let cleanExit = false;
    let transientErrorSeen = false;
    let inactivityKillFired = false;

    // Watchdog: abort the subprocess if no events arrive for
    // INACTIVITY_TIMEOUT_MS. The claude CLI can hang after emitting its
    // final text-delta without writing the `result` frame; without this
    // watchdog the walker waits forever (seen on a 2026-05-15 wertzeit-app
    // run where n1-architecture froze for 3 hours after finishing).
    //
    // BUT: the watchdog used to kill any subprocess that didn't emit an
    // event within the timeout, even if the subprocess was still alive and
    // burning CPU on a long model "thinking" pause (the claude CLI streams
    // an HTTP response, not necessarily a tool/text frame, while the LLM
    // is generating). The 2026-05-17 FocusBoard `n3-store` run lost
    // ~12 min that way. The smart watchdog now probes pid-liveness +
    // CPU advancement before pulling the trigger:
    //
    //   1. Probe via {@link WalkerDeps.probeSubprocessLiveness}.
    //   2. If hook missing or returns null → kill immediately (legacy).
    //   3. If pid gone → kill immediately (retry will pick up).
    //   4. If pid alive + CPU advanced ≥1s since last probe → log
    //      "extending", re-arm watchdog for INACTIVITY_EXTENSION_MS,
    //      capped at INACTIVITY_MAX_TOTAL_MS cumulative.
    //   5. If pid alive but CPU stuck (or unreadable) → kill — proc is
    //      hung at the syscall layer.
    let inactivityCancel: (() => void) | null = null as (() => void) | null;
    // Wall-clock ms at which the original (un-extended) watchdog armed.
    // Used to enforce the INACTIVITY_MAX_TOTAL_MS ceiling.
    let inactivityWindowStartedAt = 0;
    // CPU seconds captured at the start of the current idle window. Compared
    // against a fresh probe when the timer fires to detect advancement.
    let cpuAtWindowStart: number | null = null;

    const fireKill = (reason: string): void => {
      inactivityCancel = null;
      if (abort.signal.aborted) return;
      inactivityKillFired = true;
      this.deps.emit({
        type: 'task.text-delta',
        payload: {
          taskId: node.id,
          text: `[harness] ${reason} — aborting and retrying as transient\n`,
        },
      });
      try {
        abort.abort();
      } catch {
        /* ignore */
      }
    };

    const onWatchdogFire = (): void => {
      inactivityCancel = null;
      if (abort.signal.aborted) return;

      const now = this.deps.now();
      const elapsed = now - inactivityWindowStartedAt;
      const probe = this.deps.probeSubprocessLiveness?.(node.id) ?? null;

      // No probe available → preserve pre-v1.7.13 behavior (kill now).
      if (!probe) {
        fireKill(`subprocess inactive for ${Math.round(INACTIVITY_TIMEOUT_MS / 60_000)}min`);
        return;
      }

      // pid is gone → kill immediately so the retry path fires now.
      if (!probe.alive) {
        this.deps.emit({
          type: 'task.text-delta',
          payload: {
            taskId: node.id,
            text: `[harness] subprocess pid not found (ESRCH) — killing immediately\n`,
          },
        });
        fireKill('subprocess pid gone');
        return;
      }

      // pid alive — decide based on CPU advancement.
      const cpuNow = probe.cpuSeconds;
      const cpuStart = cpuAtWindowStart;
      const cpuDelta = cpuNow !== null && cpuStart !== null ? cpuNow - cpuStart : null;
      const advancing = cpuDelta !== null && cpuDelta >= INACTIVITY_MIN_CPU_DELTA_S;

      // Cap: even an advancing process can't extend past
      // INACTIVITY_MAX_TOTAL_MS — otherwise an infinite-loop agent that
      // happens to burn CPU never gets killed.
      if (advancing && elapsed < INACTIVITY_MAX_TOTAL_MS) {
        this.deps.emit({
          type: 'task.text-delta',
          payload: {
            taskId: node.id,
            text: `[harness] subprocess silent on events but CPU advanced ${cpuDelta!.toFixed(2)}s in last ${Math.round(elapsed / 60_000)}min — extending grace period by ${Math.round(INACTIVITY_EXTENSION_MS / 60_000)}min\n`,
          },
        });
        // Snapshot the new CPU baseline so the NEXT firing compares against
        // this checkpoint, not the original window start.
        cpuAtWindowStart = cpuNow;
        inactivityCancel = this.deps.setTimeout(onWatchdogFire, INACTIVITY_EXTENSION_MS);
        return;
      }

      // Either CPU stuck, CPU unreadable, or we hit the hard cap → kill.
      const reason = advancing
        ? `subprocess silent on events for ${Math.round(elapsed / 60_000)}min (max extension window reached)`
        : cpuDelta === null
          ? `subprocess inactive for ${Math.round(elapsed / 60_000)}min (CPU probe unavailable)`
          : `subprocess inactive for ${Math.round(elapsed / 60_000)}min (CPU advanced only ${cpuDelta.toFixed(2)}s)`;
      fireKill(reason);
    };

    const armInactivityWatchdog = (): void => {
      if (inactivityCancel) inactivityCancel();
      // Re-snapshot the window start + CPU baseline on every event arrival,
      // so a steady event stream resets the watchdog as before.
      inactivityWindowStartedAt = this.deps.now();
      const probe = this.deps.probeSubprocessLiveness?.(node.id) ?? null;
      cpuAtWindowStart = probe?.cpuSeconds ?? null;
      inactivityCancel = this.deps.setTimeout(onWatchdogFire, INACTIVITY_TIMEOUT_MS);
    };

    // Apply any per-role override from the project — model swap, extra system
    // prompt, extra allowed-tools. When no merger is wired or no override
    // exists for this role, `applyAgentOverride` is a no-op identity.
    const baseAgent = {
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      allowedTools: agent.allowedTools,
    };
    const effective = this.deps.applyAgentOverride
      ? this.deps.applyAgentOverride(node.role, baseAgent)
      : baseAgent;

    try {
      const iter = this.deps.pool.run({
        cwd: worktreePath,
        prompt: composeTaskPrompt(
          plan,
          node,
          t.attempt > 1 ? t.lastError : null,
          this.deps.handoffsSection,
        ),
        systemPrompt: effective.systemPrompt,
        allowedTools: effective.allowedTools,
        model: effective.model,
        maxTurns: node.maxTurns,
        taskId: node.id,
        runId,
        resumeSessionId: t.sessionId ?? undefined,
        signal: abort.signal,
      });

      armInactivityWatchdog();
      for await (const ev of iter) {
        // Reset watchdog on every event from the subprocess.
        armInactivityWatchdog();

        // Always forward to the bus.
        this.deps.emit(ev);

        // The claude CLI surfaces upstream Anthropic 5xx / rate-limit / network
        // errors as text-delta frames right before exiting non-zero. Detecting
        // them here lets the retry path below distinguish "infrastructure
        // blip" from "real bug in the agent's work", and apply a separate
        // (higher) retry budget with backoff.
        if (ev.type === 'task.text-delta' && TRANSIENT_RE.test(ev.payload.text)) {
          transientErrorSeen = true;
        } else if (ev.type === 'task.failed' && TRANSIENT_RE.test(ev.payload.error)) {
          transientErrorSeen = true;
        }

        if (ev.type === 'task.usage') {
          // task.usage carries CUMULATIVE counters from `claude -p
          // --output-format stream-json`. Treat as max over time so out-of-order
          // or duplicate events never inflate the total.
          const newTokensIn = Math.max(t.tokensIn, ev.payload.tokensIn);
          const newTokensOut = Math.max(t.tokensOut, ev.payload.tokensOut);
          const newTurns = Math.max(t.turnsUsed, ev.payload.turns);
          // Delta-update run totals so we don't re-sum every task per event.
          this.runTokensInTotal += newTokensIn - t.lastReportedTokensIn;
          this.runTokensOutTotal += newTokensOut - t.lastReportedTokensOut;
          this.runTurnsTotal += newTurns - t.lastReportedTurns;
          t.tokensIn = newTokensIn;
          t.tokensOut = newTokensOut;
          t.turnsUsed = newTurns;
          t.lastReportedTokensIn = newTokensIn;
          t.lastReportedTokensOut = newTokensOut;
          t.lastReportedTurns = newTurns;
          await this.deps.onTaskState(node.id, {
            tokensIn: t.tokensIn,
            tokensOut: t.tokensOut,
            turnsUsed: t.turnsUsed,
          });
          await this.checkBudget();
        } else if (ev.type === 'task.session-id') {
          // Capture the CLI's session id once per task and persist it so
          // cold-resume after a server restart can pass `--resume <id>` and
          // pick up the agent's existing conversation context. Without this
          // the cold-resume path always re-launches from scratch — see the
          // session-id watcher in subprocess.ts.
          if (!t.sessionId) {
            t.sessionId = ev.payload.sessionId;
            await this.deps.onTaskState(node.id, { sessionId: ev.payload.sessionId });
          }
        } else if (ev.type === 'rate-limit.hit') {
          t.rateLimited = true;
          // Fire pause AFTER we drain remaining events; pause aborts other tasks.
          // Pause synchronously here so further events stop being scheduled.
          await this.pause(
            'rate-limit',
            ev.payload.resetAt ?? this.deps.now() + RATE_LIMIT_DEFAULT_MS,
          );
          // Continue draining; subprocess will exit shortly.
        } else if (ev.type === 'task.max-turns-exhausted') {
          this.runErrorReason = 'max_turns';
        } else if (ev.type === 'task.failed') {
          lastTaskFailedError = ev.payload.error;
        } else if (ev.type === 'task.completed') {
          cleanExit = true;
        }
      }
    } catch (err) {
      const errStr = err instanceof Error ? err.message : String(err);
      lastTaskFailedError = `subprocess error: ${errStr}`;
      if (TRANSIENT_RE.test(errStr)) transientErrorSeen = true;
    } finally {
      if (inactivityCancel) inactivityCancel();
    }

    // An inactivity-triggered abort is treated as a transient failure so the
    // task retries via the transient-retry budget instead of consuming a
    // structural retry. The subprocess hang itself is not the agent's fault.
    if (inactivityKillFired) {
      transientErrorSeen = true;
      if (!lastTaskFailedError) {
        lastTaskFailedError = `subprocess inactivity timeout (no events for >${Math.round(INACTIVITY_TIMEOUT_MS / 60_000)}min)`;
      }
    }

    // After the subprocess loop:

    // If we were paused (rate-limit or user), leave task as paused — the
    // resume() flow will re-invoke runTask() with status reset to pending.
    if (t.rateLimited || this.state === 'paused') {
      // Defensive: if pause() didn't catch this task because it was already
      // in the middle of the loop, mark it paused now.
      if (t.status === 'running') {
        t.status = 'paused';
        await this.deps.onTaskState(node.id, { status: 'pending' });
      }
      return;
    }

    if (this.state === 'completed') {
      // We were cancelled mid-flight; nothing more to do.
      return;
    }

    if (!cleanExit) {
      // Subprocess errored before completing.
      const errMsg = lastTaskFailedError ?? 'subprocess exited without completion';

      // Transient infrastructure retry — separate from the structural retry
      // below. Anthropic 5xx storms can wipe out an hour-long run if every
      // task subprocess gets one normal retry then dies. Detected via the
      // TRANSIENT_RE patterns from the subprocess event stream above; bounded
      // by MAX_TRANSIENT_RETRIES with linear-on-attempt backoff.
      if (transientErrorSeen && t.transientRetries < MAX_TRANSIENT_RETRIES) {
        t.transientRetries += 1;
        t.status = 'pending';
        t.lastError = errMsg;
        const waitMs = TRANSIENT_BACKOFF_MS * t.transientRetries;
        this.deps.emit({
          type: 'task.text-delta',
          payload: {
            taskId: node.id,
            text: `[harness] transient infra error on task subprocess (attempt ${t.transientRetries}/${MAX_TRANSIENT_RETRIES}); retrying in ${waitMs}ms\n`,
          },
        });
        await new Promise<void>((resolve) => {
          this.deps.setTimeout(resolve, waitMs);
        });
        return;
      }

      if (t.retries < 1) {
        t.retries += 1;
        // Reset the transient counter so the structural retry attempt gets a
        // fresh budget. Without this, a task that exhausted its transient
        // retries then transitioned to a structural retry would still see
        // `t.transientRetries === MAX_TRANSIENT_RETRIES`, and any single
        // infra blip on the structural attempt would fall through to a
        // terminal failure instead of recovering.
        t.transientRetries = 0;
        t.status = 'pending';
        t.lastError = errMsg;
        // Keep worktreePath so the next attempt re-uses it.
        return;
      }
      t.status = 'failed';
      const elapsed = this.deps.now() - (t.startedAt ?? this.deps.now());
      await this.deps.onTaskState(node.id, {
        status: 'failed',
        durationMs: elapsed,
        sessionId: t.sessionId,
      });
      this.deps.emit({ type: 'task.failed', payload: { taskId: node.id, error: errMsg } });
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= Walker.CONSECUTIVE_FAILURE_THRESHOLD) {
        await this.pause('consecutive-failures');
      }
      return;
    }

    // Verify against successCriteria. Pass the per-task abort signal so a
    // cancel/pause mid-verify halts the verifier subprocesses promptly.
    let verifyResult: VerificationResult;
    try {
      verifyResult = await this.deps.verify(worktreePath, node.successCriteria, {
        signal: t.abort?.signal,
      });
    } catch (err) {
      const errStr = err instanceof Error ? err.message : String(err);
      verifyResult = {
        pass: false,
        output: `verification threw: ${errStr}`,
        failures: [{ kind: 'custom', cmd: '<verify>', exitCode: 1, tail: errStr }],
      };
    }

    if (verifyResult.pass) {
      // First, persist the task's output via auto-commit. If this fails, the task
      // hasn't really succeeded — downstream chaining would fail anyway.
      try {
        await this.deps.autoCommit(worktreePath, node.id);
      } catch (err) {
        const errStr = err instanceof Error ? err.message : String(err);
        t.status = 'failed';
        const elapsed = this.deps.now() - (t.startedAt ?? this.deps.now());
        await this.deps.onTaskState(node.id, { status: 'failed', durationMs: elapsed });
        this.deps.emit({
          type: 'task.failed',
          payload: { taskId: node.id, error: `auto-commit failed: ${errStr}` },
        });
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= Walker.CONSECUTIVE_FAILURE_THRESHOLD) {
          await this.pause('consecutive-failures');
        }
        return;
      }

      this.consecutiveFailures = 0;
      t.status = 'done';
      const elapsed = this.deps.now() - (t.startedAt ?? this.deps.now());
      await this.deps.onTaskState(node.id, {
        status: 'done',
        durationMs: elapsed,
      });
      this.deps.emit({
        type: 'task.completed',
        payload: { taskId: node.id, outcome: 'pass', exitCode: 0 },
      });
      // Best-effort worktree removal (branch is preserved).
      try {
        await this.deps.worktree.remove({ repoPath, worktreePath, force: true });
      } catch {
        // ignore — surface in logs later.
      }
      return;
    }

    // Verification failed.
    if (t.retries < 1) {
      const attempt = t.retries + 1;
      this.deps.emit({
        type: 'harness.verify-failed',
        payload: {
          taskId: node.id,
          attempt,
          failures: verifyResult.failures,
          output: verifyResult.output,
        },
      });
      t.retries += 1;
      t.status = 'pending';
      t.lastError = `verification failed:\n${verifyResult.output}`;
      return;
    }

    const attempt = t.retries + 1;
    this.deps.emit({
      type: 'harness.verify-failed',
      payload: {
        taskId: node.id,
        attempt,
        failures: verifyResult.failures,
        output: verifyResult.output,
      },
    });

    // QA-driven replan (M5/5.3): only on qa-role terminal fails, capped at MAX_REPLANS_PER_RUN.
    if (node.role === 'qa' && this.deps.replanOnQAFailure && this.runId && this.plan) {
      const planForReplan = this.plan;
      if (this.replanCount >= Walker.MAX_REPLANS_PER_RUN) {
        this.deps.emit({
          type: 'qa.replan-exhausted',
          payload: {
            runId: this.runId,
            failedTaskId: node.id,
            reason: 'max replans per run reached',
          },
        });
      } else {
        this.replanCount += 1;
        let replanResult: { newPlan: Plan; newPlanId: string } | null = null;
        try {
          replanResult = await this.deps.replanOnQAFailure({
            failedPlan: planForReplan,
            failedTaskId: node.id,
            qaError: verifyResult.output,
          });
        } catch (err) {
          // Swallow — fall through to terminal task.failed.
          replanResult = null;
          const errMsg = err instanceof Error ? err.message : String(err);
          this.deps.emit({
            type: 'qa.replan-exhausted',
            payload: {
              runId: this.runId,
              failedTaskId: node.id,
              reason: `replan callback threw: ${errMsg}`,
            },
          });
        }
        if (replanResult) {
          this.deps.emit({
            type: 'qa.replan-triggered',
            payload: {
              runId: this.runId,
              failedTaskId: node.id,
              reason: verifyResult.output.slice(0, 200),
            },
          });
          this.plan = replanResult.newPlan;
          // Rebuild task runtimes for the new plan, preserving 'done' status for
          // tasks whose ids carry over (rare but possible).
          const oldRuntimes = new Map(this.tasks);
          this.tasks = new Map();
          for (const newNode of replanResult.newPlan.nodes) {
            const old = oldRuntimes.get(newNode.id);
            const carryDone = old?.status === 'done';
            this.tasks.set(newNode.id, {
              node: newNode,
              status: carryDone ? 'done' : 'pending',
              retries: 0,
              transientRetries: 0,
              attempt: 1,
              worktreePath: carryDone ? old!.worktreePath : null,
              branchName: carryDone ? old!.branchName : null,
              sessionId: null,
              tokensIn: carryDone ? old!.tokensIn : 0,
              tokensOut: carryDone ? old!.tokensOut : 0,
              turnsUsed: carryDone ? old!.turnsUsed : 0,
              startedAt: null,
              abort: null,
              done: null,
              rateLimited: false,
              lastError: null,
              lastReportedTokensIn: 0,
              lastReportedTokensOut: 0,
              lastReportedTurns: 0,
            });
          }
          // Reset consecutive-failures since we're starting a new plan attempt.
          this.consecutiveFailures = 0;
          // Don't emit task.failed — the task is being replaced, not failed.
          return;
        }
      }
    }

    // Original terminal-fail flow continues from here.
    t.status = 'failed';
    const elapsed = this.deps.now() - (t.startedAt ?? this.deps.now());
    await this.deps.onTaskState(node.id, { status: 'failed', durationMs: elapsed });
    this.deps.emit({
      type: 'task.failed',
      payload: {
        taskId: node.id,
        error: `verification failed after retry: ${verifyResult.output}`,
      },
    });
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= Walker.CONSECUTIVE_FAILURE_THRESHOLD) {
      await this.pause('consecutive-failures');
    }
    // Leave worktree intact for forensics.
  }

  private async checkBudget(): Promise<void> {
    if (!this.budget || !this.runId) return;
    const elapsedMs = this.deps.now() - this.startedAt;
    const elapsedMin = elapsedMs / 60_000;
    const totalTurns = this.runTurnsTotal;
    const totalIn = this.runTokensInTotal;
    const totalOut = this.runTokensOutTotal;
    await this.deps.onRunState(this.runId, {
      tokensInTotal: totalIn,
      tokensOutTotal: totalOut,
      turnsTotal: totalTurns,
    });

    // A `null` cap means "unlimited" — the user explicitly opted into a
    // long-running run. Skip both the kill and the 80% warning in that case.
    const timeFrac = this.budget.budgetMinutes == null ? 0 : elapsedMin / this.budget.budgetMinutes;
    const turnFrac = this.budget.budgetTurns == null ? 0 : totalTurns / this.budget.budgetTurns;

    if (this.budget.budgetTurns != null && turnFrac >= 1) {
      this.deps.emit({ type: 'resource.exceeded', payload: { runId: this.runId, kind: 'turns' } });
      await this.cancel('budget_exceeded');
      return;
    }
    if (this.budget.budgetMinutes != null && timeFrac >= 1) {
      this.deps.emit({ type: 'resource.exceeded', payload: { runId: this.runId, kind: 'time' } });
      await this.cancel('budget_exceeded');
      return;
    }
    // Dashboard-supplied autopilot caps (tokens, longer-than-walker wallclock).
    // Re-uses the existing cancel('budget_exceeded') path so the abort wiring
    // (subprocess SIGTERM, worktree retention, run.completed event) is shared
    // with the walker's own minutes/turns enforcement above.
    if (this.deps.extraBudgetCheck) {
      try {
        const verdict = await this.deps.extraBudgetCheck({
          runId: this.runId,
          tokensTotal: totalIn + totalOut,
        });
        if (verdict.exceeded) {
          this.runErrorReason = verdict.reason ?? 'budget_exceeded';
          this.deps.emit({
            type: 'resource.exceeded',
            payload: { runId: this.runId, kind: 'tokens' },
          });
          await this.cancel('budget_exceeded');
          return;
        }
      } catch (err) {
        // A failing budget probe must not crash dispatch. Best-effort log.
        console.error('[walker] extraBudgetCheck threw — ignoring', err);
      }
    }
    if (this.budget.budgetTurns != null && !this.warnedTurns && turnFrac >= 0.8) {
      this.warnedTurns = true;
      this.deps.emit({
        type: 'resource.warning',
        payload: { runId: this.runId, kind: 'turns', percent: Math.min(turnFrac * 100, 100) },
      });
    }
    if (this.budget.budgetMinutes != null && !this.warnedTime && timeFrac >= 0.8) {
      this.warnedTime = true;
      this.deps.emit({
        type: 'resource.warning',
        payload: { runId: this.runId, kind: 'time', percent: Math.min(timeFrac * 100, 100) },
      });
    }
  }

  /**
   * After a successful run, consolidate all leaf-task branches into a single
   * `wisp/<runId>/result` branch on top of the repo's HEAD. The user can
   * inspect this one branch to see every task's contribution as a merge commit.
   *
   * Best-effort: if anything fails (worktree creation, merge conflict), the
   * leaf branches stay intact and the run is still considered successful — the
   * user can manually merge them.
   */
  private async finalizeResultBranch(): Promise<void> {
    if (!this.runId || !this.repoPath || !this.plan) return;
    const plan = this.plan;
    const runId = this.runId;
    const repoPath = this.repoPath;

    // Leaves: nodes with no successors AND status === 'done'.
    const successors = new Set<string>();
    for (const n of plan.nodes) {
      for (const dep of n.deps) successors.add(dep);
    }
    const leafBranches: string[] = [];
    for (const n of plan.nodes) {
      if (successors.has(n.id)) continue; // not a leaf
      const t = this.tasks.get(n.id);
      if (t?.status === 'done') {
        // Use the stored branchName, not branchPrefix() — after a replan,
        // carried-over 'done' tasks have branches under the OLD prefix
        // (`wisp/<runId>/...`) while branchPrefix() now returns the v<N>
        // prefix. Recomputing would silently drop those carried-over commits
        // from the result merge.
        const branch = t.branchName ?? `${this.branchPrefix()}/${n.id}`;
        leafBranches.push(branch);
      }
    }
    if (leafBranches.length === 0) return;

    const resultBranch = `wisp/${runId}/result`;
    let resultPath: string;
    try {
      resultPath = await this.deps.worktree.add({
        repoPath,
        branchName: resultBranch,
        // baseBranch undefined → branch from HEAD
      });
    } catch {
      // Best-effort — leaves already exist for the user to merge manually.
      return;
    }

    try {
      await this.deps.mergeBranches(resultPath, leafBranches);
    } finally {
      try {
        await this.deps.worktree.remove({ repoPath, worktreePath: resultPath, force: true });
      } catch {
        // ignore
      }
    }
  }

  private async finalize(outcome: RunOutcome): Promise<void> {
    if (!this.runId) return;
    if (this.finalOutcome === null) this.finalOutcome = outcome;
    this.state = 'completed';

    // Best-effort consolidate leaves into a single result branch on success.
    if (outcome === 'success') {
      try {
        await this.finalizeResultBranch();
      } catch {
        // Don't let finalize failures change the run outcome.
      }
    }

    const status =
      outcome === 'success'
        ? 'completed'
        : outcome === 'cancelled'
          ? 'cancelled'
          : outcome === 'budget_exceeded'
            ? 'failed'
            : 'failed';
    await this.deps.onRunState(this.runId, {
      status,
      outcome,
      endedAt: new Date(this.deps.now()),
      errorReason: this.runErrorReason ?? undefined,
    });
    this.deps.emit({ type: 'run.completed', payload: { runId: this.runId, outcome } });
    const resolve = this.finishResolve;
    this.finishResolve = null;
    if (resolve) resolve(outcome);
  }
}

// ---------- prompt composition ----------

const RETRY_ERROR_HEAD_LINES = 30;
const RETRY_ERROR_TAIL_LINES = 60;

function truncateRetryError(s: string): string {
  const lines = s.split(/\r?\n/);
  if (lines.length <= RETRY_ERROR_HEAD_LINES + RETRY_ERROR_TAIL_LINES + 2) return s;
  const head = lines.slice(0, RETRY_ERROR_HEAD_LINES).join('\n');
  const tail = lines.slice(-RETRY_ERROR_TAIL_LINES).join('\n');
  const omitted = lines.length - RETRY_ERROR_HEAD_LINES - RETRY_ERROR_TAIL_LINES;
  return `${head}\n[… ${omitted} lines omitted …]\n${tail}`;
}

export function composeTaskPrompt(
  plan: Plan,
  node: TaskNode,
  retryError: string | null,
  handoffsSection?: string,
): string {
  const parts: string[] = [];
  parts.push(`# Goal\n${plan.goal}`);
  parts.push(`# Task: ${node.id} (${node.role})\n${node.prompt}`);
  const sc = node.successCriteria;
  const scLines: string[] = [];
  if (sc.preflight) scLines.push(`- preflight: \`${sc.preflight}\` (runs once before the rest)`);
  if (sc.build) scLines.push(`- build: \`${sc.build}\``);
  if (sc.test) scLines.push(`- test: \`${sc.test}\``);
  if (sc.lint) scLines.push(`- lint: \`${sc.lint}\``);
  if (sc.custom) scLines.push(`- custom: \`${sc.custom}\``);
  if (scLines.length > 0) {
    parts.push(`# Success criteria (must all pass)\n${scLines.join('\n')}`);
  }
  if (retryError) {
    parts.push(
      `# Retry context\nPrevious attempt failed: ${truncateRetryError(retryError)}\nPlease address and re-implement.`,
    );
  }
  // Supplementary context — last so the agent sees primary instructions first.
  if (handoffsSection && handoffsSection.trim().length > 0) {
    parts.push(handoffsSection);
  }
  return parts.join('\n\n');
}
