import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@wisp/schemas';
import type { RunClaudeOpts } from '../subprocess.js';
import { PoolTerminatedError, SubprocessPool } from '../pool.js';

/**
 * Make a runner that hangs forever (waits on a controllable promise) so the
 * pool fills its slots and queues additional callers in `waiters`. The test
 * later resolves or aborts to exercise specific code paths.
 */
function makeHangingRunner() {
  const released: Array<() => void> = [];
  const runner = async function* (opts: RunClaudeOpts): AsyncGenerator<HarnessEvent> {
    await new Promise<void>((resolve) => {
      released.push(resolve);
      opts.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    // After release/abort, emit a single completed event and exit.
    yield {
      type: 'task.completed',
      payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 },
    };
  };
  return { runner, released };
}

async function drain(iter: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('SubprocessPool — terminateAll', () => {
  it('aborts in-flight subprocesses', async () => {
    const { runner, released } = makeHangingRunner();
    const pool = new SubprocessPool({ maxParallel: 2, runner });
    const opts: RunClaudeOpts = {
      cwd: '/tmp',
      prompt: 'p',
      allowedTools: [],
      maxTurns: 5,
      taskId: 't1',
    };
    const a = drain(pool.run(opts));
    const b = drain(pool.run({ ...opts, taskId: 't2' }));
    // Wait for both to actually start (they're hanging in the runner).
    while (released.length < 2) {
      await new Promise((r) => setTimeout(r, 10));
    }
    pool.terminateAll();
    const [evsA, evsB] = await Promise.all([a, b]);
    // Both got the abort signal → emitted task.completed and exited.
    expect(evsA.length).toBeGreaterThan(0);
    expect(evsB.length).toBeGreaterThan(0);
    expect(pool.size).toBe(0);
  });

  it('drains queued waiters so they exit cleanly without spawning a subprocess', async () => {
    const { runner, released } = makeHangingRunner();
    const pool = new SubprocessPool({ maxParallel: 1, runner });
    const opts: RunClaudeOpts = {
      cwd: '/tmp',
      prompt: 'p',
      allowedTools: [],
      maxTurns: 5,
      taskId: 't1',
    };
    // Slot 1 is taken; t2 queues in waiters; t3 queues too.
    const a = drain(pool.run(opts));
    const b = drain(pool.run({ ...opts, taskId: 't2' }));
    const c = drain(pool.run({ ...opts, taskId: 't3' }));
    // Wait until the in-flight runner has started (slot acquired).
    while (released.length < 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    pool.terminateAll();
    // The queued runs should resolve as empty iterators (no events) — they
    // never reached the runner because acquire() threw PoolTerminatedError.
    // The in-flight one exits cleanly via abort.
    const [evsA, evsB, evsC] = await Promise.all([a, b, c]);
    expect(evsA.length).toBeGreaterThan(0); // in-flight completed via abort
    expect(evsB).toEqual([]); // never spawned
    expect(evsC).toEqual([]); // never spawned
    // Crucially: the runner was called exactly ONCE (slot 1 only). The
    // released list never grew beyond 1 because t2 and t3 never reached the
    // runner.
    expect(released.length).toBe(1);
    expect(pool.size).toBe(0);
  });

  it('rejects new run() calls after terminateAll with PoolTerminatedError-equivalent (silent empty iterator)', async () => {
    const { runner } = makeHangingRunner();
    const pool = new SubprocessPool({ maxParallel: 2, runner });
    pool.terminateAll();
    const evs = await drain(
      pool.run({
        cwd: '/tmp',
        prompt: 'p',
        allowedTools: [],
        maxTurns: 5,
        taskId: 't1',
      }),
    );
    expect(evs).toEqual([]);
    expect(pool.size).toBe(0);
  });
});

describe('SubprocessPool — PoolTerminatedError', () => {
  it('is exported and instanceof-checkable', () => {
    const err = new PoolTerminatedError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PoolTerminatedError);
    expect(err.name).toBe('PoolTerminatedError');
  });
});
