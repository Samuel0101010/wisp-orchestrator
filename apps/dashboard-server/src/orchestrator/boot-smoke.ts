/**
 * Layer 2 of the v1.8 verification stack: does the app actually start?
 *
 * Static checks (build, typecheck, unit tests) prove the code compiles.
 * Boot-smoke proves the code _runs_. We spawn the project's dev command,
 * poll the configured probe URL for an HTTP 200 (or any non-5xx response,
 * since some apps redirect on `/`), and report PASS as soon as we get one
 * within the timeout. On timeout we report FAIL with the captured stdout +
 * stderr so the agent has something to read.
 *
 * The process is killed cleanly when we're done. On Windows we have to
 * walk the process tree because `child.kill()` on a `pnpm dev` only kills
 * pnpm, not the underlying vite/next/node worker. We use `taskkill /T`
 * for that. On POSIX a plain SIGTERM on the detached group does it.
 *
 * Important callers:
 *   - runtime-verifier agent (will be added in Phase B): runs this before
 *     attempting Playwright tests. Failed boot ⇒ no point launching browsers.
 *   - the dashboard's "preview" button (future): same code path, but the
 *     verifier keeps the process running and proxies the URL to the user.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export interface BootSmokeArgs {
  /** Absolute path to the repo (where `package.json` lives). */
  repoPath: string;
  /** Shell command to start the app — e.g. `pnpm dev`. */
  devCommand: string;
  /** URL to poll for readiness, e.g. `http://127.0.0.1:5173/`. */
  probeUrl: string;
  /** Optional PORT to inject as env var so the dev server uses a known port. */
  port?: number;
  /** How long to wait for the first non-5xx response before giving up. */
  readyTimeoutMs?: number;
  /** Poll interval. */
  pollIntervalMs?: number;
  /** Hook for tests to override `fetch`. */
  fetchImpl?: (input: string) => Promise<{ ok: boolean; status: number }>;
  /** Hook for tests to override spawn (so we can stub child processes). */
  spawnImpl?: typeof spawn;
}

export type BootSmokeResult =
  | { ok: true; readyMs: number; sampledStatus: number; stdoutTail: string; stderrTail: string }
  | {
      ok: false;
      reason: 'timeout' | 'spawn-failed' | 'crashed';
      detail: string;
      stdoutTail: string;
      stderrTail: string;
    };

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const STDIO_TAIL_BYTES = 4096;

function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    } else {
      // Negative PID = process group; relies on `detached: true` in spawn.
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  } catch {
    /* best-effort */
  }
}

function tailString(buf: string): string {
  if (buf.length <= STDIO_TAIL_BYTES) return buf;
  return `…${buf.slice(buf.length - STDIO_TAIL_BYTES)}`;
}

/**
 * Spawn the dev command, poll the probe URL, return when it answers (or time out).
 * Always kills the child before returning.
 */
export async function runBootSmoke(args: BootSmokeArgs): Promise<BootSmokeResult> {
  const readyTimeoutMs = args.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollIntervalMs = args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const doFetch =
    args.fetchImpl ??
    (async (url: string) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return { ok: res.ok, status: res.status };
    });
  const doSpawn = args.spawnImpl ?? spawn;

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (args.port) env.PORT = String(args.port);

  // Split off the command vs. args. The dev command is short ("pnpm dev",
  // "npm run dev") so a naive whitespace split is fine.
  const parts = args.devCommand.trim().split(/\s+/);
  const cmd = parts[0]!;
  const cmdArgs = parts.slice(1);

  let child: ChildProcess;
  let stdout = '';
  let stderr = '';
  let crashDetail: string | null = null;

  try {
    child = doSpawn(cmd, cmdArgs, {
      cwd: args.repoPath,
      env,
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: 'spawn-failed',
      detail: msg,
      stdoutTail: '',
      stderrTail: '',
    };
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const earlyExit = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      crashDetail = `dev process exited early (code=${code}, signal=${signal ?? 'none'})`;
      resolve();
    });
  });

  const start = Date.now();
  let lastErr = 'no response yet';
  try {
    while (Date.now() - start < readyTimeoutMs) {
      if (crashDetail) {
        return {
          ok: false,
          reason: 'crashed',
          detail: crashDetail,
          stdoutTail: tailString(stdout),
          stderrTail: tailString(stderr),
        };
      }
      try {
        const r = await doFetch(args.probeUrl);
        // Anything < 500 counts as "the server answered" — many frontends
        // 302-redirect on `/`, and a 404 still proves the server is running.
        if (r.status < 500) {
          return {
            ok: true,
            readyMs: Date.now() - start,
            sampledStatus: r.status,
            stdoutTail: tailString(stdout),
            stderrTail: tailString(stderr),
          };
        }
        lastErr = `status ${r.status}`;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
      await Promise.race([sleep(pollIntervalMs), earlyExit]);
    }
    return {
      ok: false,
      reason: 'timeout',
      detail: `dev server did not answer ${args.probeUrl} within ${readyTimeoutMs}ms (last error: ${lastErr})`,
      stdoutTail: tailString(stdout),
      stderrTail: tailString(stderr),
    };
  } finally {
    killTree(child);
  }
}
