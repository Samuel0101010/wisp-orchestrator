import { describe, it, expect } from 'vitest';
import { harnessEventSchema, type HarnessEvent } from './events.js';

describe('HarnessEvent', () => {
  it('round-trips task.started', () => {
    const e: HarnessEvent = { type: 'task.started', payload: { taskId: 't1' } };
    expect(harnessEventSchema.parse(e)).toEqual(e);
  });

  it('round-trips task.completed', () => {
    const e: HarnessEvent = {
      type: 'task.completed',
      payload: { taskId: 't1', outcome: 'pass', exitCode: 0 },
    };
    expect(harnessEventSchema.parse(e)).toEqual(e);
  });

  it('round-trips run.paused', () => {
    const e: HarnessEvent = {
      type: 'run.paused',
      payload: { runId: 'r1', pausedReason: 'rate-limit', resumeAt: 1234 },
    };
    expect(harnessEventSchema.parse(e)).toEqual(e);
  });

  it('round-trips run.paused with shutdown reason', () => {
    const e: HarnessEvent = {
      type: 'run.paused',
      payload: { runId: 'r1', pausedReason: 'shutdown', resumeAt: null },
    };
    expect(harnessEventSchema.parse(e)).toEqual(e);
  });

  it('round-trips rate-limit.hit with nulls', () => {
    const e: HarnessEvent = {
      type: 'rate-limit.hit',
      payload: { runId: 'r1', taskId: null, resetAt: null, source: 'anthropic' },
    };
    expect(harnessEventSchema.parse(e)).toEqual(e);
  });

  it('rejects unknown type', () => {
    const bad = { type: 'totally.unknown', payload: {} };
    const res = harnessEventSchema.safeParse(bad);
    expect(res.success).toBe(false);
  });

  it('rejects mismatched payload shape', () => {
    const bad = { type: 'task.started', payload: {} };
    const res = harnessEventSchema.safeParse(bad);
    expect(res.success).toBe(false);
  });
});
