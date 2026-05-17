import './setup.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sqlite } from '../db/index.js';
import { shutdown, __resetShutdownLatchForTesting } from '../server.js';

/**
 * Regression test for the crash-resilient-shutdown work landed alongside
 * today's logging hardening.
 *
 * What today's outage taught us:
 *   - Hard-killing the server mid-write left a non-truncated .wal file. On
 *     the next boot, projects appeared missing — the .db on disk had not
 *     been merged with .wal yet.
 *
 * The fix is: the SIGTERM/SIGINT/beforeExit handlers MUST run
 * `PRAGMA wal_checkpoint(TRUNCATE)` and then `db.close()`, exactly once,
 * even when one of the other shutdown steps fails.
 *
 * This test exercises the `shutdown()` function with a fake Fastify
 * instance + spies on sqlite.exec / sqlite.close + a stubbed process.exit,
 * and verifies:
 *   - exec is called with the TRUNCATE checkpoint
 *   - close is called exactly once
 *   - the call order is exec → close (close-then-checkpoint would no-op)
 *   - a second shutdown() call is a no-op (single-shot guard)
 */
describe('shutdown handlers — WAL checkpoint + db.close', () => {
  let execSpy: ReturnType<typeof vi.spyOn>;
  let closeSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetShutdownLatchForTesting();
    execSpy = vi.spyOn(sqlite, 'exec').mockImplementation(() => sqlite);
    closeSpy = vi.spyOn(sqlite, 'close').mockImplementation(() => sqlite);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    execSpy.mockRestore();
    closeSpy.mockRestore();
    exitSpy.mockRestore();
  });

  function buildFakeApp(): FastifyInstance {
    const noop = () => undefined;
    return {
      log: { info: noop, warn: noop, error: noop, fatal: noop, debug: noop, trace: noop },
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as FastifyInstance;
  }

  it('SIGTERM path runs wal_checkpoint(TRUNCATE) then db.close exactly once', async () => {
    const app = buildFakeApp();

    await shutdown(app, 'SIGTERM', 0);

    // The TRUNCATE checkpoint MUST have been issued.
    const execCalls = execSpy.mock.calls.map((c) => String(c[0]));
    expect(execCalls.some((s) => /wal_checkpoint\s*\(\s*TRUNCATE\s*\)/i.test(s))).toBe(true);

    // sqlite.close() called exactly once.
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // Order: exec(checkpoint) BEFORE close(). If we close first, the
    // checkpoint is a no-op against a dead handle.
    const execOrder = execSpy.mock.invocationCallOrder[0]!;
    const closeOrder = closeSpy.mock.invocationCallOrder[0]!;
    expect(execOrder).toBeLessThan(closeOrder);

    // process.exit(0) was attempted.
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('second shutdown() invocation is a no-op (single-shot guard)', async () => {
    const app = buildFakeApp();

    await shutdown(app, 'SIGTERM', 0);
    const closeCallsAfterFirst = closeSpy.mock.calls.length;

    // Do NOT reset the latch — we're proving the latch holds within one
    // process lifetime.
    await shutdown(app, 'SIGINT', 0);

    expect(closeSpy.mock.calls.length).toBe(closeCallsAfterFirst);
  });
});
