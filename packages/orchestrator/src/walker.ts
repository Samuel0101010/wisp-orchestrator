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
  HarnessEvent,
  Plan,
  RunOutcome,
  RunPausedReason,
  TaskNode,
} from '@agent-harness/schemas';
import type { SubprocessPool } from './pool.js';
import type { SuccessCriteria, VerificationResult } from './verification.js';

// ---------- public types ----------

export interface BudgetConfig {
  budgetMinutes: number;
  budgetTurns: number;
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

interface TaskRuntime {
  node: TaskNode;
  status: TaskStatusValue;
  retries: number; // number of retries already attempted (0 or 1)
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

    // Schedule auto-resume only for rate-limit pauses.
    if (reason === 'rate-limit') {
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
    for (const t of this.tasks.values()) {
      if (t.status === 'running' || t.status === 'paused') {
        if (t.status === 'running' && t.worktreePath) {
          runningWorktrees.push({ worktreePath: t.worktreePath });
        }
        t.abort?.abort();
        t.status = 'cancelled';
        await this.deps.onTaskState(t.node.id, { status: 'failed' });
      } else if (t.status === 'pending' || t.status === 'ready') {
        t.status = 'cancelled';
        await this.deps.onTaskState(t.node.id, { status: 'failed' });
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
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.state === 'running') {
        if (!this.budget || !this.plan || !this.runId || !this.repoPath) return;

        const ready = this.findReady();
        const slotsFree = this.budget.maxParallel - this.countRunning();

        if (ready.length === 0 || slotsFree <= 0) {
          // If no tasks running and none ready, the DAG is drained — finalize.
          if (this.countRunning() === 0 && ready.length === 0) {
            const allDone = Array.from(this.tasks.values()).every(
              (t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled',
            );
            if (allDone) {
              const anyFailed = Array.from(this.tasks.values()).some((t) => t.status === 'failed');
              await this.finalize(anyFailed ? 'failure' : 'success');
            }
          }
          return;
        }

        // Launch up to `slotsFree` ready tasks.
        const toLaunch = ready.slice(0, slotsFree);
        for (const t of toLaunch) {
          t.status = 'running';
          t.attempt += 1;
          t.startedAt = this.deps.now();
          // Fire-and-forget; runTask reschedules dispatch on completion.
          t.done = this.runTask(t).then(() => {
            // After each task settles, re-dispatch from outside the slot.
            void this.dispatch();
          });
        }

        // Yield: don't busy-loop. We only loop in this iteration if there are
        // still free slots AND ready tasks, which we filled above. Break.
        return;
      }
    } finally {
      this.dispatching = false;
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

  private countRunning(): number {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.status === 'running') n++;
    }
    return n;
  }

  private computeParentBranch(node: TaskNode): string | undefined {
    if (node.deps.length === 0) return undefined;
    return `harness/${this.runId}/${node.deps[0]}`;
  }

  private async runTask(t: TaskRuntime): Promise<void> {
    if (!this.runId || !this.plan || !this.repoPath) return;
    const runId = this.runId;
    const plan = this.plan;
    const repoPath = this.repoPath;
    const node = t.node;

    const branchName = `harness/${runId}/${node.id}`;
    t.branchName = branchName;
    t.rateLimited = false;
    const abort = new AbortController();
    t.abort = abort;

    let worktreePath: string | null = t.worktreePath;
    try {
      if (!worktreePath) {
        const parentBranch = this.computeParentBranch(node);
        worktreePath = await this.deps.worktree.add({ repoPath, branchName, baseBranch: parentBranch });
        t.worktreePath = worktreePath;
      }
    } catch (err) {
      t.status = 'failed';
      const errStr = err instanceof Error ? err.message : String(err);
      this.deps.emit({
        type: 'task.failed',
        payload: { taskId: node.id, error: `worktree add failed: ${errStr}` },
      });
      await this.deps.onTaskState(node.id, { status: 'failed', worktreeBranch: branchName });
      return;
    }

    await this.deps.onTaskState(node.id, {
      status: 'running',
      worktreeBranch: branchName,
    });
    this.deps.emit({ type: 'task.started', payload: { taskId: node.id } });

    const role = node.role;
    const agent = plan.team[role];

    let lastTaskFailedError: string | null = null;
    let cleanExit = false;

    try {
      const iter = this.deps.pool.run({
        cwd: worktreePath,
        prompt: composeTaskPrompt(plan, node, t.attempt > 1 ? t.lastError : null),
        systemPrompt: agent.systemPrompt,
        allowedTools: agent.allowedTools,
        model: agent.model,
        maxTurns: node.maxTurns,
        taskId: node.id,
        runId,
        resumeSessionId: t.sessionId ?? undefined,
        signal: abort.signal,
      });

      for await (const ev of iter) {
        // Always forward to the bus.
        this.deps.emit(ev);

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
        } else if (ev.type === 'rate-limit.hit') {
          t.rateLimited = true;
          // Fire pause AFTER we drain remaining events; pause aborts other tasks.
          // Pause synchronously here so further events stop being scheduled.
          await this.pause(
            'rate-limit',
            ev.payload.resetAt ?? this.deps.now() + RATE_LIMIT_DEFAULT_MS,
          );
          // Continue draining; subprocess will exit shortly.
        } else if (ev.type === 'task.failed') {
          lastTaskFailedError = ev.payload.error;
        } else if (ev.type === 'task.completed') {
          cleanExit = true;
        }
      }
    } catch (err) {
      const errStr = err instanceof Error ? err.message : String(err);
      lastTaskFailedError = `subprocess error: ${errStr}`;
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
      if (t.retries < 1) {
        t.retries += 1;
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
        return;
      }

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
      t.retries += 1;
      t.status = 'pending';
      t.lastError = `verification failed:\n${verifyResult.output}`;
      return;
    }

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

    const timeFrac = elapsedMin / this.budget.budgetMinutes;
    const turnFrac = totalTurns / this.budget.budgetTurns;

    if (turnFrac >= 1) {
      this.deps.emit({ type: 'resource.exceeded', payload: { runId: this.runId, kind: 'turns' } });
      await this.cancel('budget_exceeded');
      return;
    }
    if (timeFrac >= 1) {
      this.deps.emit({ type: 'resource.exceeded', payload: { runId: this.runId, kind: 'time' } });
      await this.cancel('budget_exceeded');
      return;
    }
    if (!this.warnedTurns && turnFrac >= 0.8) {
      this.warnedTurns = true;
      this.deps.emit({
        type: 'resource.warning',
        payload: { runId: this.runId, kind: 'turns', percent: Math.min(turnFrac * 100, 100) },
      });
    }
    if (!this.warnedTime && timeFrac >= 0.8) {
      this.warnedTime = true;
      this.deps.emit({
        type: 'resource.warning',
        payload: { runId: this.runId, kind: 'time', percent: Math.min(timeFrac * 100, 100) },
      });
    }
  }

  private async finalize(outcome: RunOutcome): Promise<void> {
    if (!this.runId) return;
    if (this.finalOutcome === null) this.finalOutcome = outcome;
    this.state = 'completed';
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
    });
    this.deps.emit({ type: 'run.completed', payload: { runId: this.runId, outcome } });
    const resolve = this.finishResolve;
    this.finishResolve = null;
    if (resolve) resolve(outcome);
  }
}

// ---------- prompt composition ----------

export function composeTaskPrompt(plan: Plan, node: TaskNode, retryError: string | null): string {
  const parts: string[] = [];
  parts.push(`# Goal\n${plan.goal}`);
  parts.push(`# Task: ${node.id} (${node.role})\n${node.prompt}`);
  const sc = node.successCriteria;
  const scLines: string[] = [];
  if (sc.build) scLines.push(`- build: \`${sc.build}\``);
  if (sc.test) scLines.push(`- test: \`${sc.test}\``);
  if (sc.lint) scLines.push(`- lint: \`${sc.lint}\``);
  if (sc.custom) scLines.push(`- custom: \`${sc.custom}\``);
  if (scLines.length > 0) {
    parts.push(`# Success criteria (must all pass)\n${scLines.join('\n')}`);
  }
  if (retryError) {
    parts.push(
      `# Retry context\nPrevious attempt failed: ${retryError}\nPlease address and re-implement.`,
    );
  }
  return parts.join('\n\n');
}
