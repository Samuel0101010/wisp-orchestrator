/**
 * Pure helpers for resuming a run from its persisted task rows.
 *
 * The key decision lives here so it is unit-testable in isolation: a
 * previously-FAILED task is RE-RUN on resume — continuing the agent's
 * conversation via `--resume` when a sessionId was captured, otherwise a fresh
 * dispatch with its partial work preserved on disk in the task's worktree
 * branch. Before this, `resumeRun` seeded failed tasks as permanently
 * `failed`, so the max-turns auto-retry resumed a run that re-ran nothing and
 * the kanban card stayed stuck on FEHLGESCHLAGEN (findings #1/#4/#5).
 */
import type { InitialWalkerState } from '@wisp/orchestrator';

/** Minimal shape of a persisted task row needed to plan a resume. */
export interface ResumeTaskRow {
  id: string;
  status: string;
  sessionId: string | null;
  worktreeBranch: string | null;
}

export interface ResumePlan {
  initialState: InitialWalkerState;
  /** Tasks that were `failed` and are being re-attempted on this resume. */
  retriedTaskIds: string[];
  /** Tasks restarted from scratch (had a worktree but no captured sessionId). */
  restartedNoSessionTaskIds: string[];
}

/**
 * Build the walker seed state from the current task rows of a run being
 * resumed. `done` tasks are skipped (completed), `failed` tasks are
 * re-attempted, and interrupted in-flight tasks resume their conversation when
 * a sessionId is known.
 */
export function buildResumeWalkerState(rows: ResumeTaskRow[]): ResumePlan {
  const initialState: InitialWalkerState = {
    completedTaskIds: [],
    failedTaskIds: [],
    resumableTasks: [],
  };
  const retriedTaskIds: string[] = [];
  const restartedNoSessionTaskIds: string[] = [];

  for (const t of rows) {
    if (t.status === 'done') {
      initialState.completedTaskIds.push(t.id);
      continue;
    }
    if (t.status === 'failed') {
      // RE-RUN the failed task instead of leaving it terminally failed. This is
      // what makes a resume actually continue the work AND clears the stale
      // FEHLGESCHLAGEN card once the walker re-dispatches it (task.started).
      retriedTaskIds.push(t.id);
      if (t.sessionId) {
        initialState.resumableTasks.push({ taskId: t.id, sessionId: t.sessionId });
      } else if (t.worktreeBranch) {
        restartedNoSessionTaskIds.push(t.id);
      }
      // else: failed with no prior work → fresh dispatch (walker seeds pending).
      continue;
    }
    // Non-terminal rows (pending/ready/running) interrupted mid-run.
    if (t.sessionId) {
      initialState.resumableTasks.push({ taskId: t.id, sessionId: t.sessionId });
    } else if (t.worktreeBranch) {
      restartedNoSessionTaskIds.push(t.id);
    }
    // else: plain pending → fresh dispatch.
  }

  return { initialState, retriedTaskIds, restartedNoSessionTaskIds };
}

/** Per-attempt turn-budget escalation cap (the planner calibrates 5..100). */
export const RESUME_MAX_TURNS_CAP = 200;

/**
 * Give a re-attempted task more turn headroom each retry so an under-budgeted
 * task (the "max-turn exhausted" case) can actually converge instead of hitting
 * the same wall every time. attempt 1 → 1.5×, attempt 2 → 2×, capped.
 */
export function escalatedMaxTurns(base: number, attempt: number): number {
  if (!Number.isFinite(base) || base <= 0) return base;
  if (attempt <= 0) return base;
  const factor = 1 + 0.5 * attempt;
  return Math.min(RESUME_MAX_TURNS_CAP, Math.ceil(base * factor));
}
