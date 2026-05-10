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
import { fileURLToPath } from 'node:url';
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
import { env } from '../env.js';
import { getLastAuthProbe } from '../auth-status.js';
import { writeMemoryMcpConfig } from './mcp-config.js';
import { replanOnQAFailure } from './replan.js';
import { storeTrajectory } from '../reasoningbank/store.js';

function resolveMemoryMcpEntrypoint(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // From dist/orchestrator/runtime.js -> ../../../../ is the repo root.
  return path.resolve(here, '..', '..', '..', '..', 'packages', 'memory-mcp', 'dist', 'server.js');
}

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

const DEFAULT_BUDGET_MIN = 120;
const DEFAULT_BUDGET_TURNS = 500;
const DEFAULT_MAX_PARALLEL = 2;
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
  // Plan ids currently being launched into a run. Held only between the
  // `plans.status === 'locked'` check and the `runs` insert so that two
  // concurrent POST /api/runs for the same planId can't both pass the
  // status read and produce two walkers writing to the same git worktree.
  private readonly launchingPlans: Set<string> = new Set();
  // Run ids currently in cold-path resume. Hot-path resumes (resident walker)
  // are already idempotent inside Walker.resume(); the cold-path rebuilds a
  // walker from DB state and must not race with itself.
  private readonly resumingRuns: Set<string> = new Set();
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
    const mcpConfigPath = env.HARNESS_MOCK_CLI
      ? undefined
      : (() => {
          const dataDir = process.env.HARNESS_DATA_DIR ?? '.';
          return writeMemoryMcpConfig({
            runId,
            dataDir,
            memoryMcpEntrypoint: resolveMemoryMcpEntrypoint(),
          }).path;
        })();
    const pool = new SubprocessPool({
      maxParallel,
      runner: this.runner,
      defaultMcpConfigPath: mcpConfigPath,
    });
    return {
      pool,
      worktree: { add: addWorktree, remove: removeWorktree },
      verify: runVerification,
      emit: (ev) => {
        // task.tool-use was filtered out under M5 because the parser at the
        // time only matched legacy flat frames (which never fired on the
        // modern CLI), so the events were always-empty noise. PR #22 fixed
        // the parser to read `assistant.message.content[type=tool_use]` —
        // tool-use events now carry real signal (Write, Edit, memory.set,
        // ...), so persist + broadcast them like every other event. The
        // /harness-diagnose skill and any future per-task timeline UI both
        // consume them.
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
      interTaskPacingMs: env.HARNESS_INTER_TASK_PACING_MS,
      autoResumeRateLimit: env.HARNESS_AUTO_RESUME_RATE_LIMIT,
      // M5 — parentPlanId is captured here as the original plan id from
      // startRun/resumeRun. Walker's MAX_REPLANS_PER_RUN = 1, so the chain
      // depth is at most root → child; both children of distinct runs
      // pointing at the same root is the expected shape (verified in r6).
      // If the cap is ever raised above 1, this closure will need to track
      // the live "current plan id" for proper grandchild → child → root
      // linkage instead of grandchild → root.
      replanOnQAFailure: env.HARNESS_MOCK_CLI
        ? undefined
        : async ({ failedPlan, failedTaskId, qaError }) => {
            const result = await replanOnQAFailure({
              parentPlanId: planId,
              failedPlan,
              failedTaskId,
              qaError,
              runner: this.runner,
            });
            return result;
          },
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
    | { ok: false; status: 404 | 409 | 400 | 503; error: string; details?: unknown }
  > {
    if (this.launchingPlans.has(args.planId)) {
      return {
        ok: false,
        status: 409,
        error: 'run already starting for this plan',
      };
    }
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

    if (env.HARNESS_AUTH_MODE === 'subscription' && !env.HARNESS_MOCK_CLI) {
      const last = getLastAuthProbe();
      if (last && !last.ok) {
        return {
          ok: false,
          status: 503,
          error: 'auth-failed',
          details: { hint: last.hint },
        };
      }
    }

    // Acquire the launch guard once all validation/early-return checks have
    // passed. From here on every code path must release it before the method
    // returns, including thrown errors.
    this.launchingPlans.add(args.planId);
    const runId = randomUUID();
    const startedAt = new Date();
    const budgetMinutes = args.budgetMinutes ?? DEFAULT_BUDGET_MIN;
    const budgetTurns = args.budgetTurns ?? DEFAULT_BUDGET_TURNS;
    const maxParallel = args.maxParallel ?? DEFAULT_MAX_PARALLEL;
    let walker: Walker;
    let repoPath: string;
    try {
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

      // Resolve repo path BEFORE registering the resident walker. If
      // resolveRepoPath throws (project row vanished mid-flight), we don't
      // want a snapshot setInterval + walkers-map entry leaked behind
      // because nothing else will clean them up — the void walker.start
      // chain that owns the .finally cleanup never starts in that case.
      repoPath = await this.resolveRepoPath(args.planId);
      const walkerDeps = this.makeWalkerDeps(runId, args.planId, maxParallel);
      walker = this.buildWalker({ walkerDeps, runId });
      this.registerResidentWalker(runId, walker);
    } finally {
      // Release whether the launch succeeded or threw — a leaked entry would
      // block all future startRun calls for this plan until server restart.
      this.launchingPlans.delete(args.planId);
    }

    // Fire-and-forget the walker. On any error or completion, clean up.
    void walker
      .start({
        runId,
        plan,
        repoPath,
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

    // The status check applies to BOTH paths: a resident walker may still exist
    // briefly after the run reached 'completed'/'failed' (1-second grace timer
    // before walkers.delete fires). Resuming a finished run would re-emit
    // ghost events and the walker behavior is undefined.
    if (run.status !== 'paused' && run.status !== 'running') {
      return {
        ok: false,
        status: 409,
        error: 'run not paused',
        details: { currentStatus: run.status },
      };
    }

    // Hot-path: walker still in memory and run actively paused.
    const resident = this.walkers.get(runId);
    if (resident) {
      await resident.walker.resume();
      return { ok: true };
    }

    // Cold-path: rebuild walker from DB state (E2).
    // Accept both 'paused' and 'running': the autopilot tick atomically flips
    // paused → running via tryCheckoutRun BEFORE calling resumeRun, so by the
    // time we get here the row is already 'running'. The top-level status
    // gate above already rejected anything other than paused/running.
    if (this.resumingRuns.has(runId)) {
      return { ok: false, status: 409, error: 'run already resuming' };
    }
    this.resumingRuns.add(runId);

    // Load plan + project. Any throw or early-return below MUST release the
    // resumingRuns guard, otherwise this run is permanently stuck.
    const planRow = await this.db.select().from(plans).where(eq(plans.id, run.planId)).get();
    if (!planRow) {
      this.resumingRuns.delete(runId);
      return { ok: false, status: 422, error: 'plan missing for resume' };
    }
    const projectRow = await this.db
      .select()
      .from(projects)
      .where(eq(projects.id, planRow.projectId))
      .get();
    if (!projectRow) {
      this.resumingRuns.delete(runId);
      return { ok: false, status: 422, error: 'project missing for resume' };
    }
    let plan: Plan;
    try {
      plan = parsePlan(planRow.dagJson);
    } catch (err) {
      this.resumingRuns.delete(runId);
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
    let taskRows: (typeof tasks.$inferSelect)[];
    try {
      taskRows = await this.db.select().from(tasks).where(eq(tasks.planId, planRow.id)).all();
    } catch (err) {
      this.resumingRuns.delete(runId);
      throw err;
    }
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

    let walker: Walker;
    try {
      const walkerDeps = this.makeWalkerDeps(runId, planRow.id, run.maxParallel);
      walker = this.buildWalker({ walkerDeps, runId });
      this.registerResidentWalker(runId, walker);
    } catch (err) {
      this.resumingRuns.delete(runId);
      throw err;
    }
    this.resumingRuns.delete(runId);

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
    } catch (err) {
      // Failures here mean the events table can't accept the row (constraint
      // violation, disk full, schema drift). Surface them to the server log so
      // a divergence between in-memory walker state and persisted events is
      // visible during postmortem instead of looking like a healthy run.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[runtime] persistEvent failed for run ${runId} (${event.type}): ${message}`);
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[runtime] persistTaskPatch failed for plan ${planId} task ${taskId}: ${message}`,
      );
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
    } catch (err) {
      // A swallowed failure here is the worst kind: the run row can be stuck
      // at status='running' forever even after the walker terminates, which
      // looks like an infinite hang in the UI. Log so it's diagnosable.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[runtime] persistRunPatch failed for run ${runId}: ${message}`);
    }

    // Fire-and-forget: store a trajectory when the run reaches a terminal outcome.
    if (patch.outcome !== undefined) {
      void (async () => {
        try {
          const run = await this.db.select().from(runs).where(eq(runs.id, runId)).get();
          if (!run) return;
          const plan = await this.db.select().from(plans).where(eq(plans.id, run.planId)).get();
          const project = plan
            ? await this.db.select().from(projects).where(eq(projects.id, plan.projectId)).get()
            : null;
          if (!project || !plan) return;
          await storeTrajectory({
            projectId: project.id,
            prompt: project.goal,
            planJson: plan.dagJson,
            outcome: patch.outcome!,
            tokensTotal: (run.tokensInTotal ?? 0) + (run.tokensOutTotal ?? 0),
          });
        } catch (err) {
          console.error('[reasoningbank] store failed', err);
        }
      })();
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
