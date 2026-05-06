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
  /**
   * Default MCP config path injected into every run that doesn't override
   * mcpConfigPath. Lets the runtime configure the memory-mcp once per run.
   */
  defaultMcpConfigPath?: string;
}

export class SubprocessPool {
  readonly maxParallel: number;
  private active = 0;
  private waiters: Array<() => void> = [];
  private readonly aborters = new Set<AbortController>();
  private readonly runner: SubprocessRunner;
  private readonly defaultMcpConfigPath: string | undefined;

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
