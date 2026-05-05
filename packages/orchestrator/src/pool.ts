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

import type { HarnessEvent } from '@agent-harness/schemas';
import { runClaude, type RunClaudeOpts } from './subprocess.js';

export type SubprocessRunner = (opts: RunClaudeOpts) => AsyncIterable<HarnessEvent>;

export interface SubprocessPoolOpts {
  maxParallel: number;
  /** Test seam: swap the underlying runner. Default: real `runClaude`. */
  runner?: SubprocessRunner;
}

export class SubprocessPool {
  readonly maxParallel: number;
  private active = 0;
  private waiters: Array<() => void> = [];
  private readonly aborters = new Set<AbortController>();
  private readonly runner: SubprocessRunner;

  constructor(opts: SubprocessPoolOpts) {
    if (!Number.isInteger(opts.maxParallel) || opts.maxParallel < 1) {
      throw new Error('maxParallel must be a positive integer');
    }
    this.maxParallel = opts.maxParallel;
    this.runner = opts.runner ?? runClaude;
  }

  get size(): number {
    return this.active;
  }

  run(opts: RunClaudeOpts): AsyncIterable<HarnessEvent> {
    return this.runIter(opts);
  }

  /**
   * Aborts every subprocess currently in-flight via an internal AbortController.
   * Callers that pass their own `signal` keep that wired-in too — both can
   * trigger abort.
   */
  terminateAll(): void {
    for (const a of this.aborters) {
      try {
        a.abort();
      } catch {
        // ignore
      }
    }
  }

  private async *runIter(opts: RunClaudeOpts): AsyncGenerator<HarnessEvent, void, void> {
    await this.acquire();
    const internal = new AbortController();
    this.aborters.add(internal);
    let externalCleanup: (() => void) | null = null;
    if (opts.signal) {
      const onExternalAbort = (): void => internal.abort();
      if (opts.signal.aborted) internal.abort();
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
      externalCleanup = (): void => {
        opts.signal?.removeEventListener('abort', onExternalAbort);
      };
    }
    try {
      for await (const ev of this.runner({ ...opts, signal: internal.signal })) {
        yield ev;
      }
    } finally {
      this.aborters.delete(internal);
      if (externalCleanup) externalCleanup();
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxParallel) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.active++;
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
