import { create } from 'zustand';
import type {
  HarnessEvent,
  Run,
  RunPausedReason,
  RunStatus,
  Task,
  TaskRole,
  TaskStatus,
} from '@wisp/schemas';

const MAX_DELTAS_PER_TASK = 200;

export interface TaskCardModel {
  id: string;
  role: TaskRole;
  title: string;
  status: TaskStatus;
  /** True between task.started and task.completed/failed; used for the "Running" column. */
  liveRunning: boolean;
  tokensIn: number;
  tokensOut: number;
  turnsUsed: number;
  durationMs: number;
  startedAtMs: number | null;
  endedAtMs: number | null;
  lastDelta?: string;
  deltas: string[];
  error?: string;
  worktreePath?: string;
}

export interface RunHeader {
  id: string;
  planId: string;
  status: RunStatus;
  outcome: Run['outcome'];
  pausedReason: RunPausedReason | null;
  resumeAt: number | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  budgetMinutes: number;
  budgetTurns: number;
  maxParallel: number;
}

export interface RunAggregates {
  tokensInTotal: number;
  tokensOutTotal: number;
  turnsTotal: number;
  elapsedMs: number;
  percentTime: number;
  percentTurns: number;
  poolUtilization: number;
  runningCount: number;
}

interface RunStoreState {
  runId: string | null;
  run: RunHeader | null;
  tasks: Record<string, TaskCardModel>;
  taskOrder: string[];
  lastEvent: HarnessEvent | null;
  /** Best-known wall-clock time used to compute aggregates; updated by tickClock(). */
  nowMs: number;

  hydrate(args: { run: Run; tasks: Task[] }): void;
  applyEvent(event: HarnessEvent): void;
  tickClock(nowMs?: number): void;
  reset(runId: string | null): void;
}

function toMs(d: Date | string | number | null | undefined): number | null {
  if (d == null) return null;
  if (typeof d === 'number') return d;
  if (typeof d === 'string') {
    const t = Date.parse(d);
    return Number.isFinite(t) ? t : null;
  }
  return d.getTime();
}

function pushDelta(task: TaskCardModel, text: string): TaskCardModel {
  const next = task.deltas.length >= MAX_DELTAS_PER_TASK ? task.deltas.slice(1) : task.deltas;
  return { ...task, deltas: [...next, text], lastDelta: text };
}

function taskFromRow(row: Task): TaskCardModel {
  return {
    id: row.id,
    role: row.role,
    title: row.title,
    status: row.status,
    liveRunning: row.status === 'running',
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    turnsUsed: row.turnsUsed,
    durationMs: row.durationMs,
    startedAtMs: null,
    endedAtMs: null,
    deltas: [],
  };
}

function runFromRow(run: Run): RunHeader {
  return {
    id: run.id,
    planId: run.planId,
    status: run.status,
    outcome: run.outcome,
    pausedReason: run.pausedReason ?? null,
    resumeAt: toMs(run.resumeAt),
    startedAtMs: toMs(run.startedAt),
    endedAtMs: toMs(run.endedAt),
    budgetMinutes: run.budgetMinutes,
    budgetTurns: run.budgetTurns,
    maxParallel: run.maxParallel,
  };
}

function recompute(state: RunStoreState): RunStoreState {
  // Aggregates are computed on-demand via `computeAggregates()` (selector),
  // not cached on the store, to avoid the useSyncExternalStore "fresh object
  // every render" trap. recompute() is kept as a no-op pass-through so call
  // sites remain ergonomic; remove if/when they all become trivial spreads.
  return state;
}

export type RunStore = RunStoreState;

export const useRunStore = create<RunStore>()((set) => ({
  runId: null,
  run: null,
  tasks: {},
  taskOrder: [],
  lastEvent: null,
  nowMs: Date.now(),

  hydrate({ run, tasks }) {
    const map: Record<string, TaskCardModel> = {};
    const order: string[] = [];
    for (const t of tasks) {
      map[t.id] = taskFromRow(t);
      order.push(t.id);
    }
    set((state) => {
      const next: RunStoreState = {
        ...state,
        runId: run.id,
        run: runFromRow(run),
        tasks: map,
        taskOrder: order,
        nowMs: Date.now(),
      };
      return recompute(next);
    });
  },

  applyEvent(event) {
    set((state) => {
      const tasks = { ...state.tasks };
      let run = state.run;
      const now = Date.now();

      switch (event.type) {
        case 'task.started': {
          const id = event.payload.taskId;
          const existing = tasks[id];
          if (existing) {
            tasks[id] = {
              ...existing,
              liveRunning: true,
              status: 'running',
              startedAtMs: existing.startedAtMs ?? now,
            };
          }
          break;
        }
        case 'task.completed': {
          // M1: outcome is always 'pass'. Verification failure goes through
          // task.failed, not task.completed.
          const id = event.payload.taskId;
          const existing = tasks[id];
          if (existing) {
            const startedAt = existing.startedAtMs ?? now;
            tasks[id] = {
              ...existing,
              liveRunning: false,
              status: 'done',
              endedAtMs: now,
              durationMs: Math.max(existing.durationMs, now - startedAt),
            };
          }
          break;
        }
        case 'task.failed': {
          const id = event.payload.taskId;
          const existing = tasks[id];
          if (existing) {
            const startedAt = existing.startedAtMs ?? now;
            tasks[id] = {
              ...existing,
              liveRunning: false,
              status: 'failed',
              error: event.payload.error,
              endedAtMs: now,
              durationMs: Math.max(existing.durationMs, now - startedAt),
            };
          }
          break;
        }
        case 'task.text-delta': {
          const id = event.payload.taskId;
          const existing = tasks[id];
          if (existing) {
            tasks[id] = pushDelta(existing, event.payload.text);
          }
          break;
        }
        case 'task.usage': {
          const id = event.payload.taskId;
          const existing = tasks[id];
          if (existing) {
            // task.usage carries cumulative counters; use Math.max so duplicate
            // or out-of-order events never inflate per-task totals.
            tasks[id] = {
              ...existing,
              tokensIn: Math.max(existing.tokensIn, event.payload.tokensIn),
              tokensOut: Math.max(existing.tokensOut, event.payload.tokensOut),
              turnsUsed: Math.max(existing.turnsUsed, event.payload.turns),
            };
          }
          break;
        }
        case 'task.tool-use':
          // M5: server filters this event before broadcast/persist so the
          // store never sees it in production. Kept here as an exhaustive arm
          // (the discriminated union still includes the type) and for safety
          // when reading historical event streams via /replay.
          break;
        case 'run.started': {
          if (run) run = { ...run, status: 'running', startedAtMs: run.startedAtMs ?? now };
          break;
        }
        case 'run.paused': {
          if (run) {
            run = {
              ...run,
              status: 'paused',
              pausedReason: event.payload.pausedReason,
              resumeAt: event.payload.resumeAt,
            };
          }
          break;
        }
        case 'run.resumed': {
          if (run) run = { ...run, status: 'running', pausedReason: null, resumeAt: null };
          break;
        }
        case 'run.completed': {
          if (run) {
            run = {
              ...run,
              status: event.payload.outcome === 'cancelled' ? 'cancelled' : 'completed',
              outcome: event.payload.outcome,
              endedAtMs: now,
            };
          }
          // v1.7.13 — on user-cancel, retroactively reclassify any
          // not-yet-terminal task as 'cancelled' so the UI shows them in
          // the ABGEBROCHEN bucket rather than FEHLGESCHLAGEN. Tasks that
          // had already legitimately failed (status='failed' from a real
          // crash) keep their status — only pending/ready/running/paused
          // get flipped. Subprocess-abort can race a task.failed event
          // past this point; the eventual server snapshot reload remains
          // the source of truth and will fix any drift.
          if (event.payload.outcome === 'cancelled') {
            for (const id of Object.keys(tasks)) {
              const existing = tasks[id];
              if (!existing) continue;
              if (
                existing.status === 'pending' ||
                existing.status === 'ready' ||
                existing.status === 'running'
              ) {
                tasks[id] = {
                  ...existing,
                  liveRunning: false,
                  status: 'cancelled',
                  endedAtMs: existing.endedAtMs ?? now,
                };
              }
            }
          }
          break;
        }
        case 'resource.warning':
        case 'resource.exceeded':
        case 'rate-limit.hit':
          break;
      }

      return recompute({
        ...state,
        run,
        tasks,
        nowMs: now,
        lastEvent: event,
      });
    });
  },

  tickClock(nowMs) {
    set((state) => recompute({ ...state, nowMs: nowMs ?? Date.now() }));
  },

  reset(runId) {
    set({
      runId,
      run: null,
      tasks: {},
      taskOrder: [],
      lastEvent: null,
      nowMs: Date.now(),
    });
  },
}));

// ---------- selectors ----------

/**
 * Pure aggregate computation. Kept outside the Zustand selector pipeline so
 * components can `useMemo` over scalar dependencies and avoid the stale
 * useSyncExternalStore "fresh object every render" trap.
 */
export function computeAggregates(args: {
  tasks: Record<string, TaskCardModel>;
  run: RunHeader | null;
  nowMs: number;
}): RunAggregates {
  const tasks = Object.values(args.tasks);
  let tokensInTotal = 0;
  let tokensOutTotal = 0;
  let turnsTotal = 0;
  let runningCount = 0;
  for (const t of tasks) {
    tokensInTotal += t.tokensIn;
    tokensOutTotal += t.tokensOut;
    turnsTotal += t.turnsUsed;
    if (t.liveRunning) runningCount += 1;
  }
  const run = args.run;
  const startedAt = run?.startedAtMs ?? args.nowMs;
  const endedAt = run?.endedAtMs ?? args.nowMs;
  const elapsedMs = Math.max(0, endedAt - startedAt);
  const budgetMs = run ? run.budgetMinutes * 60_000 : 0;
  const percentTime = budgetMs > 0 ? Math.min(100, (elapsedMs / budgetMs) * 100) : 0;
  const budgetTurns = run?.budgetTurns ?? 0;
  const percentTurns = budgetTurns > 0 ? Math.min(100, (turnsTotal / budgetTurns) * 100) : 0;
  const maxParallel = run?.maxParallel ?? 0;
  const poolUtilization = maxParallel > 0 ? Math.min(1, runningCount / maxParallel) : 0;
  return {
    tokensInTotal,
    tokensOutTotal,
    turnsTotal,
    elapsedMs,
    percentTime,
    percentTurns,
    poolUtilization,
    runningCount,
  };
}

export type TaskColumn = 'pending' | 'running' | 'verifying' | 'done' | 'failed' | 'cancelled';

export function columnFor(task: TaskCardModel, retryScheduled = false): TaskColumn {
  if (task.liveRunning) return 'running';
  if (task.status === 'done') return 'done';
  // A failed task that the run has queued for a max-turns retry is NOT dead —
  // it will be re-attempted shortly. Route it to the active lane (with an amber
  // "wird wiederholt" treatment on the card) instead of the alarming
  // FEHLGESCHLAGEN column. See findings #4 (stale-failed) / #5 (max-turns).
  if (task.status === 'failed' && retryScheduled) return 'running';
  if (task.status === 'failed') return 'failed';
  // v1.7.13 — Tasks user-cancelled (from the run-cancel dialog) land here.
  // Distinct from 'failed' so the UI can tell crash failures apart from
  // intentional user cancels.
  if (task.status === 'cancelled') return 'cancelled';
  // Note: 'verifying' is reserved in TaskColumn for a future status step
  // — no live status value maps to it yet, so we route through 'pending'.
  return 'pending';
}
