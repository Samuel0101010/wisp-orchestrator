/**
 * Preview-server registry (v1.11 Phase 3).
 *
 * Owns the lifecycle of a per-project dev server that the dashboard hosts
 * inside an iframe at `/preview/:projectId/`. One running child process per
 * project — `startPreview` is idempotent and returns the existing entry when
 * already running, `stopPreview` is safe to call when nothing is running.
 *
 * The actual reverse-proxy is in `src/routes/preview.ts`; this module only
 * spawns / polls / kills the underlying `pnpm dev` (or whatever was
 * configured) and exposes the live port.
 *
 * Windows-tree-kill semantics mirror `boot-smoke.ts` — `child.kill()` only
 * reaps `pnpm` itself; `taskkill /T /F` is required to bring down the
 * downstream vite/node worker. POSIX uses the detached process group.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export type PreviewStatus = 'starting' | 'running' | 'error' | 'stopped';

export interface PreviewEntry {
  child: ChildProcess | null;
  port: number;
  pid: number | null;
  startedAt: number;
  status: PreviewStatus;
  errorReason?: string;
}

export interface StartPreviewArgs {
  projectId: string;
  devCmd: string;
  probeUrl: string;
  /** Optional override — defaults to 30s. */
  readyTimeoutMs?: number;
  /** Test seam — supplied fetch impl. */
  fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number }>;
  /** Test seam — supplied spawn impl. */
  spawnImpl?: typeof spawn;
  /** Test seam — supplied port-free probe impl. */
  isPortFreeImpl?: (port: number) => Promise<boolean>;
}

export interface StartPreviewResult {
  status: 'running' | 'error';
  port: number;
  pid: number | null;
  startedAt: number;
  error?: string;
}

export interface PreviewStatusResult {
  running: boolean;
  port?: number;
  pid?: number;
  startedAt?: number;
  status?: PreviewStatus;
  error?: string;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const PORT_PROBE_RANGE = 10;

function parsePort(probeUrl: string): number {
  const u = new URL(probeUrl);
  if (u.port) return Number(u.port);
  return u.protocol === 'https:' ? 443 : 80;
}

/**
 * Probe whether `127.0.0.1:port` is free by opening a fresh listener and
 * closing it immediately. EADDRINUSE → false, any other error → false too
 * (we can't bind it, so we treat it as occupied for safety).
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        /* best-effort */
      }
      resolve(ok);
    };
    server.once('error', () => finish(false));
    server.once('listening', () => {
      server.close(() => finish(true));
    });
    try {
      server.listen(port, '127.0.0.1');
    } catch {
      finish(false);
    }
  });
}

/**
 * Liveness check for a previously-registered dev-server pid. Signal 0 is
 * the POSIX/Node convention for "probe-only": throws ESRCH if the pid is
 * gone but does NOT signal the process. We mirror the pattern from
 * `packages/orchestrator/src/liveness.ts` — for a local dev server the
 * existence check alone is enough (no LLM "thinking" pauses to worry
 * about).
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM / unknown — assume alive to avoid mis-reporting a healthy proc.
    return true;
  }
}

function killTree(child: ChildProcess | null): void {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    } else {
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

export class PreviewProcessRegistry {
  private entries = new Map<string, PreviewEntry>();

  /**
   * Start (or re-attach to) a preview for the given project. Idempotent —
   * a second call for a project that is already in `running` or `starting`
   * state returns the existing entry without spawning a duplicate.
   */
  async startPreview(args: StartPreviewArgs): Promise<StartPreviewResult> {
    const { projectId, devCmd, probeUrl } = args;
    const existing = this.entries.get(projectId);
    if (existing && (existing.status === 'running' || existing.status === 'starting')) {
      return {
        status: existing.status === 'running' ? 'running' : 'error',
        port: existing.port,
        pid: existing.pid,
        startedAt: existing.startedAt,
        ...(existing.errorReason ? { error: existing.errorReason } : {}),
      };
    }

    const requestedPort = parsePort(probeUrl);
    const readyTimeoutMs = args.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const doFetch =
      args.fetchImpl ??
      (async (url: string) => {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        return { ok: res.ok, status: res.status };
      });
    const doSpawn = args.spawnImpl ?? spawn;
    const doIsPortFree = args.isPortFreeImpl ?? isPortFree;

    // Find a free port in [requestedPort, requestedPort+PORT_PROBE_RANGE].
    // If everything in the window is held by stale processes we surface
    // `port_occupied` without spawning so the user sees an immediate
    // actionable error instead of a 30s timeout.
    let port = requestedPort;
    let foundFree = false;
    for (let p = requestedPort; p <= requestedPort + PORT_PROBE_RANGE; p++) {
      if (await doIsPortFree(p)) {
        port = p;
        foundFree = true;
        break;
      }
    }
    if (!foundFree) {
      const entry: PreviewEntry = {
        child: null,
        port: requestedPort,
        pid: null,
        startedAt: Date.now(),
        status: 'error',
        errorReason: 'port-occupied',
      };
      this.entries.set(projectId, entry);
      return {
        status: 'error',
        port: requestedPort,
        pid: null,
        startedAt: entry.startedAt,
        error: 'port_occupied',
      };
    }

    // Rewrite probeUrl to use the chosen free port so polling targets the
    // same port we just told the child to bind to.
    const effectiveProbeUrl =
      port === requestedPort ? probeUrl : probeUrl.replace(/:\d+/, ':' + String(port));

    const parts = devCmd.trim().split(/\s+/);
    const cmd = parts[0]!;
    const cmdArgs = parts.slice(1);

    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };

    let child: ChildProcess;
    try {
      child = doSpawn(cmd, cmdArgs, {
        cwd: process.cwd(),
        env,
        shell: process.platform === 'win32',
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const entry: PreviewEntry = {
        child: null,
        port,
        pid: null,
        startedAt: Date.now(),
        status: 'error',
        errorReason: `spawn-failed: ${msg}`,
      };
      this.entries.set(projectId, entry);
      return {
        status: 'error',
        port,
        pid: null,
        startedAt: entry.startedAt,
        error: entry.errorReason!,
      };
    }

    const entry: PreviewEntry = {
      child,
      port,
      pid: child.pid ?? null,
      startedAt: Date.now(),
      status: 'starting',
    };
    this.entries.set(projectId, entry);

    // Best-effort logging drains so the child doesn't deadlock on a full
    // stdout buffer. We do not surface the tail anywhere in Phase 3 — that's
    // intentional (console streaming is explicitly out of scope).
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});

    let earlyExit: string | null = null;
    child.once('exit', (code, signal) => {
      earlyExit = `process exited (code=${code}, signal=${signal ?? 'none'})`;
    });

    const start = Date.now();
    while (Date.now() - start < readyTimeoutMs) {
      if (earlyExit) {
        entry.status = 'error';
        entry.errorReason = earlyExit;
        return {
          status: 'error',
          port,
          pid: entry.pid,
          startedAt: entry.startedAt,
          error: earlyExit,
        };
      }
      try {
        const r = await doFetch(effectiveProbeUrl);
        if (r.status < 500) {
          entry.status = 'running';
          return {
            status: 'running',
            port,
            pid: entry.pid,
            startedAt: entry.startedAt,
          };
        }
      } catch {
        /* keep polling */
      }
      await sleep(POLL_INTERVAL_MS);
    }

    entry.status = 'error';
    entry.errorReason = `timeout waiting for ${effectiveProbeUrl} (${readyTimeoutMs}ms)`;
    killTree(child);
    return {
      status: 'error',
      port,
      pid: entry.pid,
      startedAt: entry.startedAt,
      error: entry.errorReason,
    };
  }

  /**
   * Stop the preview if any. Safe to call when nothing is running — the
   * second call from the dashboard's idle "Stop" button must not throw.
   */
  stopPreview(projectId: string): { stopped: boolean } {
    const entry = this.entries.get(projectId);
    if (!entry) return { stopped: false };
    killTree(entry.child);
    this.entries.delete(projectId);
    return { stopped: true };
  }

  getPreviewStatus(
    projectId: string,
    opts: { pidAliveImpl?: (pid: number) => boolean } = {},
  ): PreviewStatusResult {
    const entry = this.entries.get(projectId);
    if (!entry) return { running: false };
    // If we believed the child was running but the OS pid is gone, flip
    // the cached entry to error so the dashboard stops showing a stale
    // "Running" badge for a dead dev server. We only probe when status
    // claims `running` and we actually have a pid to probe.
    if (entry.status === 'running' && entry.pid != null) {
      const aliveImpl = opts.pidAliveImpl ?? pidAlive;
      if (!aliveImpl(entry.pid)) {
        entry.status = 'error';
        entry.errorReason = 'process-died';
      }
    }
    return {
      running: entry.status === 'running',
      port: entry.port,
      ...(entry.pid != null ? { pid: entry.pid } : {}),
      startedAt: entry.startedAt,
      status: entry.status,
      ...(entry.errorReason ? { error: entry.errorReason } : {}),
    };
  }

  /**
   * Test seam — directly inject a pre-running entry so the reverse-proxy
   * tests don't need to spawn a real dev server. Do NOT use in production.
   */
  __test_register(input: { projectId: string; port: number; pid?: number | null }): void {
    this.entries.set(input.projectId, {
      child: null,
      port: input.port,
      pid: input.pid ?? null,
      startedAt: Date.now(),
      status: 'running',
    });
  }

  /**
   * Test seam — purge all entries (used by `afterEach` in test suites).
   */
  __test_reset(): void {
    for (const entry of this.entries.values()) killTree(entry.child);
    this.entries.clear();
  }
}

export const previewProcesses = new PreviewProcessRegistry();
