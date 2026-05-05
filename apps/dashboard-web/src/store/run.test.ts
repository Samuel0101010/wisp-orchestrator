import { describe, it, expect, beforeEach } from 'vitest';
import type { HarnessEvent, Run, Task } from '@agent-harness/schemas';
import { columnFor, computeAggregates, useRunStore } from './run';

function makeRun(over: Partial<Run> = {}): Run {
  const startedAt = new Date(Date.now() - 60_000); // 1 min ago
  return {
    id: 'r1',
    planId: 'p1',
    status: 'running',
    startedAt,
    endedAt: null,
    outcome: null,
    budgetMinutes: 10, // 10 minutes -> 600_000 ms
    budgetTurns: 100,
    maxParallel: 3,
    tokensInTotal: 0,
    tokensOutTotal: 0,
    turnsTotal: 0,
    pausedReason: null,
    resumeAt: null,
    ...over,
  };
}

function makeTask(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    planId: 'p1',
    role: 'developer',
    title: id,
    deps: [],
    status: 'pending',
    worktreeBranch: null,
    sessionId: null,
    tokensIn: 0,
    tokensOut: 0,
    turnsUsed: 0,
    durationMs: 0,
    ...over,
  };
}

describe('useRunStore', () => {
  beforeEach(() => {
    useRunStore.getState().reset(null);
  });

  it('hydrate seeds run + tasks and orders task ids', () => {
    const run = makeRun();
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    useRunStore.getState().hydrate({ run, tasks });
    const s = useRunStore.getState();
    expect(s.run?.id).toBe('r1');
    expect(s.taskOrder).toEqual(['a', 'b', 'c']);
    expect(Object.keys(s.tasks).sort()).toEqual(['a', 'b', 'c']);
  });

  it('task.started flips liveRunning and column moves to running', () => {
    useRunStore.getState().hydrate({ run: makeRun(), tasks: [makeTask('a')] });
    useRunStore.getState().applyEvent({
      type: 'task.started',
      payload: { taskId: 'a' },
    });
    const t = useRunStore.getState().tasks.a!;
    expect(t.liveRunning).toBe(true);
    expect(columnFor(t)).toBe('running');
  });

  it('task.usage treats incoming counters as cumulative (Math.max)', () => {
    useRunStore.getState().hydrate({ run: makeRun(), tasks: [makeTask('a')] });
    const send = (e: HarnessEvent): void => useRunStore.getState().applyEvent(e);
    send({
      type: 'task.usage',
      payload: { taskId: 'a', tokensIn: 100, tokensOut: 30, turns: 1 },
    });
    // Second event reports a higher cumulative value — store should bump to it,
    // NOT add (50+100=150).
    send({
      type: 'task.usage',
      payload: { taskId: 'a', tokensIn: 250, tokensOut: 80, turns: 2 },
    });
    const t = useRunStore.getState().tasks.a!;
    expect(t.tokensIn).toBe(250);
    expect(t.tokensOut).toBe(80);
    expect(t.turnsUsed).toBe(2);

    // A late, smaller cumulative reading must NOT shrink the totals.
    send({
      type: 'task.usage',
      payload: { taskId: 'a', tokensIn: 100, tokensOut: 50, turns: 1 },
    });
    const t2 = useRunStore.getState().tasks.a!;
    expect(t2.tokensIn).toBe(250);
    expect(t2.tokensOut).toBe(80);
    expect(t2.turnsUsed).toBe(2);
  });

  it('task.text-delta caps deltas at 200 entries (FIFO)', () => {
    useRunStore.getState().hydrate({ run: makeRun(), tasks: [makeTask('a')] });
    for (let i = 0; i < 250; i += 1) {
      useRunStore.getState().applyEvent({
        type: 'task.text-delta',
        payload: { taskId: 'a', text: `chunk-${i}` },
      });
    }
    const t = useRunStore.getState().tasks.a!;
    expect(t.deltas.length).toBe(200);
    // FIFO: oldest dropped, newest kept.
    expect(t.deltas[0]).toBe('chunk-50');
    expect(t.deltas.at(-1)).toBe('chunk-249');
    expect(t.lastDelta).toBe('chunk-249');
  });

  it('task.completed (always outcome=pass in M1) marks the task done', () => {
    useRunStore
      .getState()
      .hydrate({ run: makeRun(), tasks: [makeTask('a', { status: 'running' })] });
    useRunStore.getState().applyEvent({
      type: 'task.started',
      payload: { taskId: 'a' },
    });
    useRunStore.getState().applyEvent({
      type: 'task.completed',
      payload: { taskId: 'a', outcome: 'pass', exitCode: 0 },
    });
    const t = useRunStore.getState().tasks.a!;
    expect(t.liveRunning).toBe(false);
    expect(t.status).toBe('done');
    expect(columnFor(t)).toBe('done');
  });

  it('task.failed records the error message', () => {
    useRunStore.getState().hydrate({ run: makeRun(), tasks: [makeTask('a')] });
    useRunStore.getState().applyEvent({
      type: 'task.failed',
      payload: { taskId: 'a', error: 'boom' },
    });
    const t = useRunStore.getState().tasks.a!;
    expect(t.error).toBe('boom');
    expect(t.status).toBe('failed');
  });

  it('run.paused stamps pausedReason and resumeAt onto run header', () => {
    useRunStore.getState().hydrate({ run: makeRun(), tasks: [] });
    const future = Date.now() + 60_000;
    useRunStore.getState().applyEvent({
      type: 'run.paused',
      payload: { runId: 'r1', pausedReason: 'rate-limit', resumeAt: future },
    });
    const run = useRunStore.getState().run!;
    expect(run.status).toBe('paused');
    expect(run.pausedReason).toBe('rate-limit');
    expect(run.resumeAt).toBe(future);
  });

  it('run.resumed clears pausedReason and goes back to running', () => {
    useRunStore.getState().hydrate({ run: makeRun(), tasks: [] });
    useRunStore.getState().applyEvent({
      type: 'run.paused',
      payload: { runId: 'r1', pausedReason: 'user', resumeAt: null },
    });
    useRunStore.getState().applyEvent({
      type: 'run.resumed',
      payload: { runId: 'r1' },
    });
    const run = useRunStore.getState().run!;
    expect(run.status).toBe('running');
    expect(run.pausedReason).toBeNull();
  });

  it('computeAggregates sums tokens/turns and computes percent budgets', () => {
    const run = makeRun({ budgetMinutes: 10, budgetTurns: 100, maxParallel: 4 });
    useRunStore.getState().hydrate({ run, tasks: [makeTask('a'), makeTask('b')] });
    useRunStore.getState().applyEvent({
      type: 'task.started',
      payload: { taskId: 'a' },
    });
    useRunStore.getState().applyEvent({
      type: 'task.usage',
      payload: { taskId: 'a', tokensIn: 200, tokensOut: 50, turns: 10 },
    });
    useRunStore.getState().applyEvent({
      type: 'task.usage',
      payload: { taskId: 'b', tokensIn: 100, tokensOut: 25, turns: 5 },
    });

    const s = useRunStore.getState();
    const agg = computeAggregates({ tasks: s.tasks, run: s.run, nowMs: s.nowMs });
    expect(agg.tokensInTotal).toBe(300);
    expect(agg.tokensOutTotal).toBe(75);
    expect(agg.turnsTotal).toBe(15);
    expect(agg.runningCount).toBe(1);
    // Budget 100 turns; 15 used -> 15%.
    expect(Math.round(agg.percentTurns)).toBe(15);
    // 1 of 4 parallel.
    expect(agg.poolUtilization).toBeCloseTo(0.25, 2);
    // Time elapsed against 10-minute budget.
    expect(agg.percentTime).toBeGreaterThan(0);
  });

  it('reset wipes the slice', () => {
    useRunStore.getState().hydrate({ run: makeRun(), tasks: [makeTask('a')] });
    useRunStore.getState().reset(null);
    const s = useRunStore.getState();
    expect(s.run).toBeNull();
    expect(s.taskOrder).toEqual([]);
    expect(Object.keys(s.tasks)).toEqual([]);
  });
});
