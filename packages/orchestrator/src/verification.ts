/**
 * Verification gates (E1).
 *
 * Runs a {@link SuccessCriteria} command set in a working tree and reports
 * pass/fail. Each non-empty command runs sequentially with combined
 * stdout/stderr capture and a per-command timeout. All non-empty commands
 * must succeed for `pass=true`.
 *
 * **Timeout escalation:** when a command exceeds `timeoutMs`, execa first
 * sends `SIGTERM`. If the child still hasn't exited 5 seconds later, execa
 * escalates to `SIGKILL` (its default `forceKillAfterTimeout=5000`). This
 * means a well-behaved child cleans up on SIGTERM, while a hung child is
 * forcibly reaped — verifyResult reports `exitCode: 124` either way.
 */

import { execa } from 'execa';

export interface SuccessCriteria {
  preflight?: string;
  build?: string;
  test?: string;
  lint?: string;
  custom?: string;
}

export type VerificationKind = 'preflight' | 'build' | 'test' | 'lint' | 'custom';

export interface VerificationFailure {
  kind: VerificationKind;
  cmd: string;
  /** Exit code; 124 indicates a timeout. */
  exitCode: number;
  /** Tail of combined stdout+stderr (last ~2 KB). */
  tail: string;
}

export interface VerificationResult {
  pass: boolean;
  output: string;
  failures: VerificationFailure[];
}

export interface RunVerificationOpts {
  /** Per-command timeout in ms; defaults to 5 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Test seam: lets unit tests stub out execa. */
  __exec?: ExecFn;
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

type ExecFn = (
  cmd: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<ExecResult>;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const TAIL_BYTES = 2048;
const ORDER: VerificationKind[] = ['build', 'test', 'lint', 'custom'];

function tail(s: string): string {
  if (s.length <= TAIL_BYTES) return s;
  return s.slice(-TAIL_BYTES);
}

const defaultExec: ExecFn = async (cmd, { cwd, timeoutMs, signal }) => {
  try {
    const result = await execa(cmd, {
      cwd,
      shell: true,
      reject: false,
      all: true,
      timeout: timeoutMs,
      // execa v9 renamed `signal` to `cancelSignal`.
      cancelSignal: signal,
      stripFinalNewline: false,
    });
    return {
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timedOut: result.timedOut === true,
    };
  } catch (err) {
    // execa throws when reject=false is overridden by certain failure modes
    // (e.g. spawn error). Treat as exit 127.
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 127, stdout: '', stderr: message, timedOut: false };
  }
};

export async function runVerification(
  cwd: string,
  criteria: SuccessCriteria,
  opts: RunVerificationOpts = {},
): Promise<VerificationResult> {
  const exec = opts.__exec ?? defaultExec;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Preflight runs once before the rest. On failure, short-circuit.
  const preflightCmd = criteria.preflight?.trim() ?? '';
  if (preflightCmd.length > 0) {
    if (opts.signal?.aborted) {
      return {
        pass: false,
        output: `[preflight] ${preflightCmd}\nABORTED`,
        failures: [{ kind: 'preflight', cmd: preflightCmd, exitCode: 130, tail: 'aborted' }],
      };
    }
    const t0 = Date.now();
    const res = await exec(preflightCmd, { cwd, timeoutMs, signal: opts.signal });
    const ms = Date.now() - t0;
    const combined = `${res.stdout}\n${res.stderr}`;
    if (res.timedOut || res.exitCode !== 0) {
      const transcript = `[preflight] ${preflightCmd} (${ms}ms, exit=${res.timedOut ? 124 : res.exitCode})\n${tail(combined)}`;
      return {
        pass: false,
        output: transcript,
        failures: [{
          kind: 'preflight',
          cmd: preflightCmd,
          exitCode: res.timedOut ? 124 : res.exitCode,
          tail: tail(combined),
        }],
      };
    }
  }

  const planned = ORDER.map((kind) => ({ kind, cmd: criteria[kind]?.trim() ?? '' })).filter(
    (e) => e.cmd.length > 0,
  );

  if (planned.length === 0) {
    return { pass: true, output: 'no criteria', failures: [] };
  }

  const failures: VerificationFailure[] = [];
  const transcript: string[] = [];

  for (const { kind, cmd } of planned) {
    if (opts.signal?.aborted) {
      failures.push({ kind, cmd, exitCode: 130, tail: 'aborted' });
      transcript.push(`[${kind}] ${cmd}\nABORTED`);
      continue;
    }
    const t0 = Date.now();
    const res = await exec(cmd, { cwd, timeoutMs, signal: opts.signal });
    const ms = Date.now() - t0;
    const combined = `${res.stdout}\n${res.stderr}`;
    transcript.push(`[${kind}] ${cmd} (${ms}ms, exit=${res.timedOut ? 124 : res.exitCode})`);
    if (combined.trim().length > 0) transcript.push(tail(combined));
    if (res.timedOut) {
      failures.push({ kind, cmd, exitCode: 124, tail: tail(combined) });
    } else if (res.exitCode !== 0) {
      failures.push({ kind, cmd, exitCode: res.exitCode, tail: tail(combined) });
    }
  }

  return {
    pass: failures.length === 0,
    output: transcript.join('\n'),
    failures,
  };
}
