/**
 * Subprocess pool.
 *
 * Limits the number of concurrent `claude -p` subprocesses via a simple
 * semaphore. Backpressure model: callers wait for a slot before the runner
 * starts producing events.
 *
 * Note: this is *only* slot-limiting. DAG walking, dependency resolution,
 * and run-level state belong in a later phase.
 */

import type { HarnessEvent } from '@wisp/schemas';
import { runClaude, type RunClaudeOpts } from './subprocess.js';

export type SubprocessRunner = (opts: RunClaudeOpts) => AsyncIterable<HarnessEvent>;

export interface SubprocessPoolOpts {
  maxParallel: number;
  /** Test seam: swap the underlying runner. Default: real `runClaude`. */
  runner?: SubprocessRunner;
  /**
   * Default MCP config path injected into every run that doesn't override
   * mcpConfigPath. Lets the runtime configure the memory-mcp once per run.
   */
  defaultMcpConfigPath?: string;
}

export class PoolTerminatedError extends Error {
  constructor() {
    super('subprocess pool terminated');
    this.name = 'PoolTerminatedError';
  }
}

export class SubprocessPool {
  readonly maxParallel: number;
  private active = 0;
  private waiters: Array<() => void> = [];
  private readonly aborters = new Set<AbortController>();
  private readonly runner: SubprocessRunner;
  private readonly defaultMcpConfigPath: string | undefined;
  // Terminal flag — once set, no new subprocesses may spawn. Both fast-path
  // and slow-path acquire() check it. terminateAll() also drains any
  // queued waiters so they unblock and re-check the flag instead of
  // sitting on a slot that release() would otherwise hand to them.
  private terminated = false;

  constructor(opts: SubprocessPoolOpts) {
    if (!Number.isInteger(opts.maxParallel) || opts.maxParallel < 1) {
      throw new Error('maxParallel must be a positive integer');
    }
    this.maxParallel = opts.maxParallel;
    this.runner = opts.runner ?? runClaude;
    this.defaultMcpConfigPath = opts.defaultMcpConfigPath;
  }

  get size(): number {
    return this.active;
  }

  run(opts: RunClaudeOpts): AsyncIterable<HarnessEvent> {
    return this.runIter(opts);
  }

  /**
   * Aborts every subprocess currently in-flight via an internal AbortController
   * AND prevents any further spawns. Tasks queued in `waiters` (blocked on a
   * slot) are unblocked so they observe the terminated flag and exit acquire()
   * with a PoolTerminatedError instead of silently slipping through after a
   * release() from a finishing in-flight task.
   *
   * Callers that pass their own `signal` keep that wired-in too — both can
   * trigger abort. Subsequent run() calls fail fast at acquire().
   */
  terminateAll(): void {
    this.terminated = true;
    // Wake every waiter so they re-enter acquire() and observe the flag.
    const drainees = this.waiters.splice(0);
    for (const resolve of drainees) {
      try {
        resolve();
      } catch {
        // ignore
      }
    }
    for (const a of this.aborters) {
      try {
        a.abort();
      } catch {
        // ignore
      }
    }
  }

  private async *runIter(opts: RunClaudeOpts): AsyncGenerator<HarnessEvent, void, void> {
    try {
      await this.acquire();
    } catch (err) {
      if (err instanceof PoolTerminatedError) return;
      throw err;
    }
    // Apply default mcpConfigPath when caller didn't set one.
    const effectiveOpts: RunClaudeOpts =
      opts.mcpConfigPath || !this.defaultMcpConfigPath
        ? opts
        : { ...opts, mcpConfigPath: this.defaultMcpConfigPath };
    const internal = new AbortController();
    this.aborters.add(internal);
    let externalCleanup: (() => void) | null = null;
    if (effectiveOpts.signal) {
      const onExternalAbort = (): void => internal.abort();
      if (effectiveOpts.signal.aborted) internal.abort();
      else effectiveOpts.signal.addEventListener('abort', onExternalAbort, { once: true });
      externalCleanup = (): void => {
        effectiveOpts.signal?.removeEventListener('abort', onExternalAbort);
      };
    }
    try {
      for await (const ev of this.runner({ ...effectiveOpts, signal: internal.signal })) {
        yield ev;
      }
    } finally {
      this.aborters.delete(internal);
      if (externalCleanup) externalCleanup();
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.terminated) throw new PoolTerminatedError();
    if (this.active < this.maxParallel) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    // After waking, re-check the flag — a concurrent terminateAll() may
    // have woken us specifically to bail out, not to take a slot.
    if (this.terminated) throw new PoolTerminatedError();
    this.active++;
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
