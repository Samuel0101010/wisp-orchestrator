import { describe, expect, it } from 'vitest';
import {
  buildResumeWalkerState,
  escalatedMaxTurns,
  RESUME_MAX_TURNS_CAP,
} from '../orchestrator/resume-state.js';

describe('buildResumeWalkerState', () => {
  it('re-attempts a failed task with a sessionId via resumableTasks, never failedTaskIds', () => {
    const { initialState, retriedTaskIds } = buildResumeWalkerState([
      { id: 'a', status: 'done', sessionId: null, worktreeBranch: 'wisp/r/a' },
      { id: 'b', status: 'failed', sessionId: 'sess-b', worktreeBranch: 'wisp/r/b' },
    ]);
    expect(initialState.completedTaskIds).toEqual(['a']);
    // The crux of findings #4/#5: a failed task is NEVER seeded as terminally
    // failed on resume — otherwise the walker re-runs nothing and the kanban
    // card stays stuck on FEHLGESCHLAGEN.
    expect(initialState.failedTaskIds).toEqual([]);
    expect(initialState.resumableTasks).toEqual([{ taskId: 'b', sessionId: 'sess-b' }]);
    expect(retriedTaskIds).toEqual(['b']);
  });

  it('re-attempts a failed task without a sessionId as a fresh pending dispatch', () => {
    const { initialState, retriedTaskIds, restartedNoSessionTaskIds } = buildResumeWalkerState([
      { id: 'b', status: 'failed', sessionId: null, worktreeBranch: 'wisp/r/b' },
      { id: 'c', status: 'failed', sessionId: null, worktreeBranch: null },
    ]);
    // 'b' had a worktree → restart-from-scratch (logged); 'c' is plain pending.
    expect(initialState.failedTaskIds).toEqual([]);
    expect(initialState.resumableTasks).toEqual([]);
    expect(retriedTaskIds).toEqual(['b', 'c']);
    expect(restartedNoSessionTaskIds).toEqual(['b']);
  });

  it('resumes an interrupted in-flight task by sessionId and leaves plain pending alone', () => {
    const { initialState, retriedTaskIds } = buildResumeWalkerState([
      { id: 'd', status: 'running', sessionId: 'sess-d', worktreeBranch: 'wisp/r/d' },
      { id: 'e', status: 'pending', sessionId: null, worktreeBranch: null },
    ]);
    expect(initialState.resumableTasks).toEqual([{ taskId: 'd', sessionId: 'sess-d' }]);
    expect(retriedTaskIds).toEqual([]); // only 'failed' rows count as re-attempted
  });
});

describe('escalatedMaxTurns', () => {
  it('escalates 1.5x on attempt 1 and 2x on attempt 2', () => {
    expect(escalatedMaxTurns(20, 1)).toBe(30);
    expect(escalatedMaxTurns(20, 2)).toBe(40);
  });

  it('returns the base unchanged for attempt 0 or non-positive budgets', () => {
    expect(escalatedMaxTurns(20, 0)).toBe(20);
    expect(escalatedMaxTurns(0, 3)).toBe(0);
    expect(escalatedMaxTurns(Number.NaN, 3)).toBeNaN();
  });

  it('caps the escalated budget', () => {
    expect(escalatedMaxTurns(100, 4)).toBe(RESUME_MAX_TURNS_CAP);
  });
});
