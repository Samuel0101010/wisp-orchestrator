/**
 * `claude -p` subprocess runner.
 *
 * Spawns the CLI with subscription auth (inherits ~/.claude/, strips
 * ANTHROPIC_API_KEY), parses NDJSON stdout into HarnessEvents, and watches
 * stderr for rate-limit markers.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { extname } from 'node:path';
import process from 'node:process';
import type { HarnessEvent } from '@agent-harness/schemas';
import { detectRateLimit, type RateLimitHit } from './rate-limit.js';

export interface RunClaudeOpts {
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  allowedTools: string[];
  model?: string;
  maxTurns: number;
  resumeSessionId?: string;
  taskId: string;
  /** Optional run id, used to fill `rate-limit.hit.payload.runId`. */
  runId?: string;
  signal?: AbortSignal;
  /**
   * Optional MCP config JSON file path. When set, the subprocess is invoked
   * with `--mcp-config <path> --strict-mcp-config`, exposing the configured
   * MCP servers (e.g. agent-harness-memory) as tools to the agent.
   */
  mcpConfigPath?: string;
  /** Override the executable. If it ends in .js/.mjs, spawned via node. */
  __mockBin?: string;
  /** Extra env vars (test only). */
  __mockEnv?: Record<string, string>;
}

const STDERR_TAIL_BYTES = 4096;

export function buildArgs(opts: RunClaudeOpts): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(opts.maxTurns),
  ];
  if (opts.allowedTools.length > 0) {
    args.push('--allowed-tools', opts.allowedTools.join(','));
  }
  if (opts.model) {
    args.push('--model', opts.model);
  }
  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }
  if (opts.systemPrompt) {
    args.push('--system-prompt', opts.systemPrompt);
  }
  if (opts.mcpConfigPath) {
    args.push('--mcp-config', opts.mcpConfigPath, '--strict-mcp-config');
  }
  return args;
}

function resolveBin(opts: RunClaudeOpts): { cmd: string; argPrefix: string[] } {
  if (opts.__mockBin) {
    const ext = extname(opts.__mockBin).toLowerCase();
    if (ext === '.mjs' || ext === '.js' || ext === '.cjs') {
      return { cmd: process.execPath, argPrefix: [opts.__mockBin] };
    }
    return { cmd: opts.__mockBin, argPrefix: [] };
  }
  return { cmd: 'claude', argPrefix: [] };
}

function buildEnv(opts: RunClaudeOpts): NodeJS.ProcessEnv {
  // Copy parent env, then strip API key to force subscription auth.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  env.CLAUDE_PROJECT_DIR = opts.cwd;
  env.CI = env.CI ?? '1';
  if (opts.__mockEnv) {
    for (const [k, v] of Object.entries(opts.__mockEnv)) {
      env[k] = v;
    }
  }
  return env;
}

interface ParsedLine {
  type?: unknown;
  [k: string]: unknown;
}

function tryParseJson(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return obj as ParsedLine;
    }
    return null;
  } catch {
    return null;
  }
}

function mapCliEvent(parsed: ParsedLine, taskId: string): HarnessEvent[] {
  const t = parsed.type;
  if (typeof t !== 'string') return [];

  switch (t) {
    case 'text-delta': {
      // Legacy shape (also produced by the mock fixture).
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      return [{ type: 'task.text-delta', payload: { taskId, text } }];
    }
    case 'tool-use': {
      // Legacy shape (also produced by the mock fixture).
      const tool = typeof parsed.tool === 'string' ? parsed.tool : 'unknown';
      return [{ type: 'task.tool-use', payload: { taskId, tool, input: parsed.input } }];
    }
    case 'assistant': {
      // Modern `claude -p --output-format stream-json` shape: a single
      // `assistant` frame wraps a `message.content[]` array whose items are
      // `{type:'text', text}` or `{type:'tool_use', name, input}` (and
      // sometimes `{type:'thinking'}` which we skip). One frame yields N
      // events. Without this case the dashboard's text-delta + tool-use
      // streams stay empty during real runs even though the agents
      // obviously produced both.
      const message = parsed.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
      const out: HarnessEvent[] = [];
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const it = item as Record<string, unknown>;
        if (it.type === 'text') {
          const text = typeof it.text === 'string' ? it.text : '';
          if (text) out.push({ type: 'task.text-delta', payload: { taskId, text } });
        } else if (it.type === 'tool_use') {
          const tool = typeof it.name === 'string' ? it.name : 'unknown';
          out.push({ type: 'task.tool-use', payload: { taskId, tool, input: it.input } });
        }
      }
      return out;
    }
    case 'result': {
      const usage = (parsed as Record<string, unknown>).usage as
        | Record<string, unknown>
        | undefined;
      if (!usage) return [];
      const inputTokens = Number((usage as Record<string, number | undefined>).input_tokens ?? 0);
      const cacheCreate = Number(
        (usage as Record<string, number | undefined>).cache_creation_input_tokens ?? 0,
      );
      const outputTokens = Number((usage as Record<string, number | undefined>).output_tokens ?? 0);
      const numTurns = Number((parsed as Record<string, unknown>).num_turns ?? 0);
      const tokensIn =
        (Number.isFinite(inputTokens) ? inputTokens : 0) +
        (Number.isFinite(cacheCreate) ? cacheCreate : 0);
      return [
        {
          type: 'task.usage',
          payload: {
            taskId,
            tokensIn: Math.max(0, Math.trunc(tokensIn)),
            tokensOut: Math.max(0, Math.trunc(Number.isFinite(outputTokens) ? outputTokens : 0)),
            turns: Math.max(0, Math.trunc(Number.isFinite(numTurns) ? numTurns : 0)),
          },
        },
      ];
    }
    case 'completion':
      // Internal CLI marker; consumer cares about exit-code-driven completed event.
      return [];
    default:
      return [];
  }
}

/**
 * Class form: gives callers explicit control over the lifecycle (kill, pid).
 */
export class ClaudeSubprocess {
  private readonly opts: RunClaudeOpts;
  private child: ChildProcessWithoutNullStreams | null = null;
  private started = false;

  constructor(opts: RunClaudeOpts) {
    this.opts = opts;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): AsyncIterable<HarnessEvent> {
    if (this.started) {
      throw new Error('ClaudeSubprocess already started');
    }
    this.started = true;
    return this.iterate();
  }

  async kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.kill(signal);
  }

  private async *iterate(): AsyncGenerator<HarnessEvent, void, void> {
    const opts = this.opts;
    const { cmd, argPrefix } = resolveBin(opts);
    const args = [...argPrefix, ...buildArgs(opts)];
    const env = buildEnv(opts);

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    // Pipe the prompt via stdin and close.
    child.stdin.end(opts.prompt);

    // Wire abort signal to terminate the process. The kill is wrapped in
    // try/catch because on Windows the `exitCode === null` guard is not
    // reliable: exitCode is set asynchronously when the 'exit' event fires,
    // so a SIGTERM-then-abort sequence can race with the OS reaping the
    // process and produce EPERM. We swallow because the only contract is
    // "make a best-effort attempt to terminate".
    const onAbort = (): void => {
      if (child.exitCode !== null) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // Already exited / handle invalid — nothing to do.
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Buffered queue with backpressure-free producer/consumer.
    const queue: HarnessEvent[] = [];
    let resolveWaiter: (() => void) | null = null;
    let done = false;
    const wake = (): void => {
      const r = resolveWaiter;
      resolveWaiter = null;
      if (r) r();
    };
    const push = (ev: HarnessEvent): void => {
      queue.push(ev);
      wake();
    };

    let stderrTail = '';
    let rateLimitDetected: RateLimitHit | null = null;

    const handleText = (text: string, isStderr: boolean): void => {
      // Record stderr tail for failure reporting.
      if (isStderr) {
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
      }
      // Try rate-limit detection on the chunk.
      if (!rateLimitDetected) {
        const hit = detectRateLimit(text);
        if (hit) {
          rateLimitDetected = hit;
          push({
            type: 'rate-limit.hit',
            payload: {
              runId: opts.runId ?? '',
              taskId: opts.taskId,
              resetAt: hit.resetAt,
              source: hit.source,
            },
          });
          // Abort the subprocess; the walker will react to the event.
          // try/catch matches the onAbort handler above — on Windows the
          // exitCode guard is not race-free, so a kill against an already-
          // reaped process can throw EPERM. Best-effort.
          if (child.exitCode === null) {
            try {
              child.kill('SIGTERM');
            } catch {
              // ignore
            }
          }
        }
      }
    };

    // NDJSON line buffering for stdout.
    let stdoutBuf = '';
    // Track sessionId emit-once. The real `claude -p --output-format
    // stream-json` surfaces the session id in a leading frame (typically
    // `system`/`init` or as a `session_id` field on later frames). Without
    // capturing it, tasks.session_id stays NULL and cold-resume after a
    // server restart can't pass `--resume <id>`, silently restarting from
    // scratch. We watch every parsed frame and emit once on first sight.
    let sessionIdEmitted = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      handleText(chunk, false);
      stdoutBuf += chunk;
      let nlIdx: number;
      while ((nlIdx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nlIdx);
        stdoutBuf = stdoutBuf.slice(nlIdx + 1);
        const parsed = tryParseJson(line);
        if (!parsed) {
          // Non-JSON line: skip silently. Real implementation would log debug.
          continue;
        }
        if (!sessionIdEmitted) {
          const sid = (parsed as Record<string, unknown>).session_id;
          if (typeof sid === 'string' && sid.length > 0) {
            sessionIdEmitted = true;
            push({
              type: 'task.session-id',
              payload: { taskId: opts.taskId, sessionId: sid },
            });
          }
        }
        for (const ev of mapCliEvent(parsed, opts.taskId)) push(ev);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      handleText(chunk, true);
    });

    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } = {
      code: null,
      signal: null,
    };
    const spawnErrorRef: { value: Error | null } = { value: null };

    child.once('error', (err: Error) => {
      spawnErrorRef.value = err;
      done = true;
      wake();
    });
    child.once('close', (code, signal) => {
      // Flush any remaining stdout buffer.
      if (stdoutBuf.length > 0) {
        const parsed = tryParseJson(stdoutBuf);
        if (parsed) {
          for (const ev of mapCliEvent(parsed, opts.taskId)) push(ev);
        }
        stdoutBuf = '';
      }
      exitInfo = { code, signal };
      done = true;
      wake();
    });

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) break;
        await new Promise<void>((resolve) => {
          resolveWaiter = resolve;
        });
      }

      if (spawnErrorRef.value) {
        yield {
          type: 'task.failed',
          payload: {
            taskId: opts.taskId,
            error: `spawn error: ${spawnErrorRef.value.message}`,
          },
        };
        return;
      }

      const code = exitInfo.code;
      if (rateLimitDetected) {
        yield {
          type: 'task.failed',
          payload: { taskId: opts.taskId, error: 'rate-limited' },
        };
        return;
      }

      if (code === 0) {
        yield {
          type: 'task.completed',
          payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 },
        };
        return;
      }

      const tail = stderrTail.trim() || `exit code ${code ?? 'null'}`;
      yield {
        type: 'task.failed',
        payload: { taskId: opts.taskId, error: tail },
      };
    } finally {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }
  }
}

export function runClaude(opts: RunClaudeOpts): AsyncIterable<HarnessEvent> {
  return new ClaudeSubprocess(opts).start();
}
