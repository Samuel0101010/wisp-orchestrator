/**
 * RunRuntime — wiring layer between HTTP routes and the Walker.
 *
 * Owns:
 *   - DB row creation/updates for runs/tasks/events/checkpoints
 *   - WS publishing (via injected ws.publishToRun)
 *   - Periodic snapshotting (every 10 minutes)
 *   - Lifecycle of in-memory `Walker` instances per run
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  checkpoints,
  events as eventsTable,
  parsePlan,
  plans,
  projects,
  runs,
  tasks,
  type HarnessEvent,
  type Plan,
  type RunStatus,
  type TaskRole,
  type TaskStatus,
} from '@agent-harness/schemas';
import {
  SubprocessPool,
  Walker,
  addWorktree,
  commitWorktreeChanges,
  mergeBranchesInWorktree,
  removeWorktree,
  runVerification,
  type InitialWalkerState,
  type RunState,
  type SubprocessRunner,
  type TaskState,
  type WalkerDeps,
} from '@agent-harness/orchestrator';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

// Shape of the in-memory ws bus.
export interface WsBus {
  publishToRun: (runId: string, event: HarnessEvent) => void;
}

export interface RunRuntimeDeps {
  db: BetterSQLite3Database;
  ws: WsBus;
  /** Where to write checkpoint snapshots; defaults to <HARNESS_DATA_DIR>/snapshots. */
  snapshotsDir?: string;
  /** Test seam: build the Walker with a swapped pool/runner. */
  buildWalker?: (args: { walkerDeps: WalkerDeps; runId: string }) => Walker;
  /** Test seam: snapshot interval in ms. Default 10 minutes. */
  snapshotIntervalMs?: number;
  /**
   * Optional subprocess runner. When provided, the SubprocessPool inside each
   * Walker uses this runner instead of the real `runClaude`. Used by the F1
   * mock-CLI mode (see env.HARNESS_MOCK_CLI) and for tests.
   */
  runner?: SubprocessRunner;
}

export interface StartRunArgs {
  planId: string;
  budgetMinutes?: number;
  budgetTurns?: number;
  maxParallel?: number;
}

const DEFAULT_BUDGET_MIN = 360;
const DEFAULT_BUDGET_TURNS = 500;
const DEFAULT_MAX_PARALLEL = 3;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

interface ResidentRun {
  walker: Walker;
  snapshotTimer: NodeJS.Timeout | null;
}

const TASK_STATUS_MAP: Record<NonNullable<TaskState['status']>, TaskStatus> = {
  pending: 'pending',
  ready: 'ready',
  running: 'running',
  paused: 'pending', // db has no 'paused' enum
  done: 'done',
  failed: 'failed',
  cancelled: 'failed',
};

const RUN_STATUS_MAP: Record<NonNullable<RunState['status']>, RunStatus> = {
  running: 'running',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

export class RunRuntime {
  readonly walkers: Map<string, ResidentRun> = new Map();
  private readonly db: BetterSQLite3Database;
  private readonly ws: WsBus;
  private readonly snapshotsDir: string;
  private readonly buildWalker: (args: { walkerDeps: WalkerDeps; runId: string }) => Walker;
  private readonly snapshotIntervalMs: number;
  private readonly runner: SubprocessRunner | undefined;

  constructor(deps: RunRuntimeDeps) {
    this.db = deps.db;
    this.ws = deps.ws;
    this.snapshotsDir =
      deps.snapshotsDir ?? path.join(process.env.HARNESS_DATA_DIR ?? '.', 'snapshots');
    this.buildWalker = deps.buildWalker ?? (({ walkerDeps }) => new Walker(walkerDeps));
    this.snapshotIntervalMs = deps.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    this.runner = deps.runner;
  }

  /**
   * Build the Walker dependencies for a given run. Factored out so both
   * startRun() and resumeRun() (rebuild path) share the same wiring.
   */
  private makeWalkerDeps(runId: string, planId: string, maxParallel: number): WalkerDeps {
    const pool = new SubprocessPool({ maxParallel, runner: this.runner });
    return {
      pool,
      worktree: { add: addWorktree, remove: removeWorktree },
      verify: runVerification,
      emit: (ev) => {
        // M5: skip persisting+broadcasting `task.tool-use`. Nobody consumes it
        // today (M2 may build a tool timeline UI; the schema entry stays).
        if (ev.type === 'task.tool-use') {
          return;
        }
        this.persistEvent(runId, ev);
        try {
          this.ws.publishToRun(runId, ev);
        } catch {
          // ignore publish errors
        }
      },
      onTaskState: async (taskId, patch) => {
        await this.persistTaskPatch(planId, taskId, patch);
      },
      onRunState: async (id, patch) => {
        await this.persistRunPatch(id, patch);
      },
      snapshot: async (id) => this.writeSnapshot(id),
      setTimeout: (cb, ms) => {
        const t = setTimeout(cb, ms);
        return () => clearTimeout(t);
      },
      now: () => Date.now(),
      autoCommit: commitWorktreeChanges,
      mergeBranches: mergeBranchesInWorktree,
    };
  }

  /**
   * Register a freshly-built walker as resident for `runId` and start its
   * periodic snapshot timer. Wires up cleanup on terminate.
   */
  private registerResidentWalker(runId: string, walker: Walker): void {
    const snapshotTimer = setInterval(() => {
      void this.writeSnapshot(runId).catch(() => {
        /* swallow */
      });
    }, this.snapshotIntervalMs);
    if (typeof snapshotTimer.unref === 'function') snapshotTimer.unref();
    this.walkers.set(runId, { walker, snapshotTimer });
  }

  async startRun(
    args: StartRunArgs,
  ): Promise<
    | { ok: true; runId: string }
    | { ok: false; status: 404 | 409 | 400; error: string; details?: unknown }
  > {
    const planRow = await this.db.select().from(plans).where(eq(plans.id, args.planId)).get();
    if (!planRow) return { ok: false, status: 404, error: 'plan not found' };
    if (planRow.status !== 'locked') {
      return {
        ok: false,
        status: 409,
        error: 'plan not locked',
        details: { currentStatus: planRow.status },
      };
    }
    let plan: Plan;
    try {
      plan = parsePlan(planRow.dagJson);
    } catch (err) {
      return {
        ok: false,
        status: 400,
        error: 'plan dag is invalid',
        details: { message: (err as Error).message },
      };
    }

    const runId = randomUUID();
    const startedAt = new Date();
    const budgetMinutes = args.budgetMinutes ?? DEFAULT_BUDGET_MIN;
    const budgetTurns = args.budgetTurns ?? DEFAULT_BUDGET_TURNS;
    const maxParallel = args.maxParallel ?? DEFAULT_MAX_PARALLEL;

    await this.db
      .insert(runs)
      .values({
        id: runId,
        planId: args.planId,
        status: 'running',
        startedAt,
        budgetMinutes,
        budgetTurns,
        maxParallel,
      })
      .run();

    // Seed tasks.
    for (const node of plan.nodes) {
      await this.db
        .insert(tasks)
        .values({
          id: node.id,
          planId: args.planId,
          role: node.role as TaskRole,
          title: node.id,
          deps: node.deps,
          status: 'pending',
        })
        .onConflictDoNothing()
        .run();
    }

    const walkerDeps = this.makeWalkerDeps(runId, args.planId, maxParallel);
    const walker = this.buildWalker({ walkerDeps, runId });
    this.registerResidentWalker(runId, walker);

    // Fire-and-forget the walker. On any error or completion, clean up.
    void walker
      .start({
        runId,
        plan,
        repoPath: await this.resolveRepoPath(args.planId),
        budget: { budgetMinutes, budgetTurns, maxParallel },
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // Persist a failure outcome and emit a synthetic run.completed if the walker
        // never reached its own finalize().
        this.persistEvent(runId, { type: 'run.completed', payload: { runId, outcome: 'failure' } });
        try {
          this.ws.publishToRun(runId, {
            type: 'run.completed',
            payload: { runId, outcome: 'failure' },
          });
        } catch {
          // ignore
        }
        void this.persistRunPatch(runId, {
          status: 'failed',
          outcome: 'failure',
          endedAt: new Date(),
        });
        console.error(`[runtime] run ${runId} crashed: ${message}`);
      })
      .finally(() => {
        const resident = this.walkers.get(runId);
        if (resident?.snapshotTimer) clearInterval(resident.snapshotTimer);
        // Keep the entry around briefly so the route layer can read final state.
        // Remove after a short grace period.
        setTimeout(() => {
          this.walkers.delete(runId);
        }, 1000).unref?.();
      });

    return { ok: true, runId };
  }

  async pauseRun(runId: string): Promise<{ ok: true } | { ok: false; status: 404; error: string }> {
    const run = await this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) return { ok: false, status: 404, error: 'run not found' };
    const resident = this.walkers.get(runId);
    if (resident) {
      await resident.walker.pause('user');
      return { ok: true };
    }
    // Fallback: walker not in memory (e.g. server restart) — DB-only pause.
    await this.db
      .update(runs)
      .set({ status: 'paused', pausedReason: 'user', resumeAt: null })
      .where(eq(runs.id, runId))
      .run();
    return { ok: true };
  }

  async resumeRun(
    runId: string,
  ): Promise<
    | { ok: true; rebuilt?: boolean }
    | { ok: false; status: 404 | 409 | 422; error: string; hint?: string; details?: unknown }
  > {
    const run = await this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) return { ok: false, status: 404, error: 'run not found' };

    // Hot-path: walker still in memory.
    const resident = this.walkers.get(runId);
    if (resident) {
      await resident.walker.resume();
      return { ok: true };
    }

    // Cold-path: rebuild walker from DB state (E2).
    if (run.status !== 'paused') {
      return {
        ok: false,
        status: 409,
        error: 'run not paused',
        details: { currentStatus: run.status },
      };
    }

    // Load plan + project.
    const planRow = await this.db.select().from(plans).where(eq(plans.id, run.planId)).get();
    if (!planRow) {
      return { ok: false, status: 422, error: 'plan missing for resume' };
    }
    const projectRow = await this.db
      .select()
      .from(projects)
      .where(eq(projects.id, planRow.projectId))
      .get();
    if (!projectRow) {
      return { ok: false, status: 422, error: 'project missing for resume' };
    }
    let plan: Plan;
    try {
      plan = parsePlan(planRow.dagJson);
    } catch (err) {
      return {
        ok: false,
        status: 422,
        error: 'plan dag is invalid',
        details: { message: (err as Error).message },
      };
    }

    // Build initialState from current task rows.
    //
    // Limitation: a task that was running mid-shutdown but never got far enough
    // to surface a sessionId via task.session-id (e.g. crashed before the first
    // stream-json line) is restarted from scratch — its prior partial work in
    // the worktree is preserved on disk but no `--resume <sessionId>` is
    // passed. We log this case so the user sees it in the boot log.
    const taskRows = await this.db.select().from(tasks).where(eq(tasks.planId, planRow.id)).all();
    const initialState: InitialWalkerState = {
      completedTaskIds: [],
      failedTaskIds: [],
      resumableTasks: [],
    };
    for (const t of taskRows) {
      if (t.status === 'done') {
        initialState.completedTaskIds.push(t.id);
      } else if (t.status === 'failed') {
        initialState.failedTaskIds.push(t.id);
      } else if (t.sessionId) {
        // pending/ready/running with a known sessionId → re-launch with --resume.
        initialState.resumableTasks.push({ taskId: t.id, sessionId: t.sessionId });
      } else if (t.worktreeBranch) {
        // Task had a worktree (started running) but never received a sessionId
        // before the pause. We restart from scratch — previous work in the
        // worktree is preserved on disk but the conversation context is lost.
        console.log(
          JSON.stringify({
            event: 'resume-no-session',
            runId,
            taskId: t.id,
            taskStatus: t.status,
            worktreeBranch: t.worktreeBranch,
          }),
        );
      }
      // Else: plain pending — fresh dispatch.
    }

    const walkerDeps = this.makeWalkerDeps(runId, planRow.id, run.maxParallel);
    const walker = this.buildWalker({ walkerDeps, runId });
    this.registerResidentWalker(runId, walker);

    // Mark run running again before kicking off the walker.
    await this.db
      .update(runs)
      .set({ status: 'running', pausedReason: null, resumeAt: null })
      .where(eq(runs.id, runId))
      .run();
    const resumedEvent: HarnessEvent = { type: 'run.resumed', payload: { runId } };
    this.persistEvent(runId, resumedEvent);
    try {
      this.ws.publishToRun(runId, resumedEvent);
    } catch {
      // ignore
    }

    void walker
      .start({
        runId,
        plan,
        repoPath: projectRow.repoPath,
        budget: {
          budgetMinutes: run.budgetMinutes,
          budgetTurns: run.budgetTurns,
          maxParallel: run.maxParallel,
        },
        initialState,
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.persistEvent(runId, { type: 'run.completed', payload: { runId, outcome: 'failure' } });
        try {
          this.ws.publishToRun(runId, {
            type: 'run.completed',
            payload: { runId, outcome: 'failure' },
          });
        } catch {
          // ignore
        }
        void this.persistRunPatch(runId, {
          status: 'failed',
          outcome: 'failure',
          endedAt: new Date(),
        });
        console.error(`[runtime] resumed run ${runId} crashed: ${message}`);
      })
      .finally(() => {
        const r = this.walkers.get(runId);
        if (r?.snapshotTimer) clearInterval(r.snapshotTimer);
        setTimeout(() => {
          this.walkers.delete(runId);
        }, 1000).unref?.();
      });

    return { ok: true, rebuilt: true };
  }

  /**
   * E2 — graceful shutdown. Pauses every resident walker, awaits their drain,
   * and clears their snapshot timers. Returns once all walkers settle so the
   * caller can sequence with Fastify.close().
   */
  async pauseAllForShutdown(): Promise<void> {
    const ids = Array.from(this.walkers.keys());
    const settles = ids.map(async (id) => {
      const resident = this.walkers.get(id);
      if (!resident) return;
      try {
        await resident.walker.pauseForShutdown();
      } catch (err) {
        console.error(`[runtime] pauseForShutdown(${id}) failed: ${String(err)}`);
      }
      if (resident.snapshotTimer) clearInterval(resident.snapshotTimer);
    });
    await Promise.allSettled(settles);
  }

  async cancelRun(
    runId: string,
  ): Promise<{ ok: true } | { ok: false; status: 404; error: string }> {
    const run = await this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) return { ok: false, status: 404, error: 'run not found' };
    const resident = this.walkers.get(runId);
    if (resident) {
      await resident.walker.cancel();
      return { ok: true };
    }
    await this.db
      .update(runs)
      .set({ status: 'cancelled', outcome: 'cancelled', endedAt: new Date() })
      .where(eq(runs.id, runId))
      .run();
    return { ok: true };
  }

  // ---------- internals ----------

  private async resolveRepoPath(planId: string): Promise<string> {
    const planRow = await this.db.select().from(plans).where(eq(plans.id, planId)).get();
    if (!planRow) throw new Error(`plan ${planId} vanished`);
    const projectRow = await this.db
      .select()
      .from(projects)
      .where(eq(projects.id, planRow.projectId))
      .get();
    if (!projectRow) throw new Error(`project ${planRow.projectId} not found`);
    return projectRow.repoPath;
  }

  private persistEvent(runId: string, event: HarnessEvent): void {
    try {
      const taskId = 'taskId' in event.payload ? (event.payload.taskId as string | null) : null;
      this.db
        .insert(eventsTable)
        .values({
          id: randomUUID(),
          runId,
          taskId: taskId ?? null,
          type: event.type,
          payload: event.payload as unknown,
        })
        .run();
    } catch {
      // best-effort
    }
  }

  private async persistTaskPatch(planId: string, taskId: string, patch: TaskState): Promise<void> {
    const update: Record<string, unknown> = {};
    if (patch.status !== undefined) {
      update.status = TASK_STATUS_MAP[patch.status];
    }
    if (patch.worktreeBranch !== undefined) update.worktreeBranch = patch.worktreeBranch;
    if (patch.sessionId !== undefined) update.sessionId = patch.sessionId;
    if (patch.tokensIn !== undefined) update.tokensIn = patch.tokensIn;
    if (patch.tokensOut !== undefined) update.tokensOut = patch.tokensOut;
    if (patch.turnsUsed !== undefined) update.turnsUsed = patch.turnsUsed;
    if (patch.durationMs !== undefined) update.durationMs = patch.durationMs;
    if (Object.keys(update).length === 0) return;
    try {
      await this.db
        .update(tasks)
        .set(update)
        .where(and(eq(tasks.planId, planId), eq(tasks.id, taskId)))
        .run();
    } catch {
      // ignore
    }
  }

  private async persistRunPatch(runId: string, patch: RunState): Promise<void> {
    const update: Record<string, unknown> = {};
    if (patch.status !== undefined) update.status = RUN_STATUS_MAP[patch.status];
    if (patch.startedAt !== undefined) update.startedAt = patch.startedAt;
    if (patch.endedAt !== undefined) update.endedAt = patch.endedAt;
    if (patch.outcome !== undefined) update.outcome = patch.outcome;
    if (patch.pausedReason !== undefined) update.pausedReason = patch.pausedReason;
    if (patch.resumeAt !== undefined) update.resumeAt = patch.resumeAt;
    if (patch.tokensInTotal !== undefined) update.tokensInTotal = patch.tokensInTotal;
    if (patch.tokensOutTotal !== undefined) update.tokensOutTotal = patch.tokensOutTotal;
    if (patch.turnsTotal !== undefined) update.turnsTotal = patch.turnsTotal;
    if (Object.keys(update).length === 0) return;
    try {
      await this.db.update(runs).set(update).where(eq(runs.id, runId)).run();
    } catch {
      // ignore
    }
  }

  private async writeSnapshot(runId: string): Promise<string> {
    const dir = path.join(this.snapshotsDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    const ts = Date.now();
    const file = path.join(dir, `${ts}.json`);
    const run = await this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) return file;
    const taskRows = await this.db.select().from(tasks).where(eq(tasks.planId, run.planId)).all();
    const snapshot = { runId, ts, run, tasks: taskRows };
    try {
      fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
      await this.db
        .insert(checkpoints)
        .values({ id: randomUUID(), runId, snapshotPath: file })
        .run();
    } catch {
      // best-effort
    }
    return file;
  }
}
