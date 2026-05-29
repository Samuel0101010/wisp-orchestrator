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
import { execa } from 'execa';
import { access, constants, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export type PreviewStatus = 'starting' | 'running' | 'error' | 'stopped';

export interface PreviewEntry {
  child: ChildProcess | null;
  port: number;
  pid: number | null;
  startedAt: number;
  status: PreviewStatus;
  errorReason?: string;
  /** Absolute path to the managed preview worktree — set after ensurePreviewWorktree. */
  worktreePath?: string;
  /** repoPath kept for cleanup inside stopPreview. */
  repoPath?: string;
  /** projectId kept for cleanup inside stopPreview. */
  projectId?: string;
}

export interface StartPreviewArgs {
  projectId: string;
  devCmd: string;
  probeUrl: string;
  /**
   * Working directory the dev-server is spawned in. MUST be the project's
   * repoPath — running `vite` from the dashboard-server cwd just crashes
   * with "no vite config found". Optional only for backwards compatibility
   * with old tests; production callers (preview route) always set this.
   */
  cwd?: string;
  /**
   * Optional URL base prefix (e.g. `/preview/<id>/`). When set, `--base
   * <basePath>` is appended to the dev-server CLI so vite / SvelteKit emit
   * asset URLs already prefixed with the reverse-proxy path. Caller must
   * gate this on a framework that respects `--base` (vite, @sveltejs/kit) —
   * passing it to next/nuxt would error.
   */
  basePath?: string;
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
  // Probe BOTH IPv4 (127.0.0.1) and IPv6 (::1). On Windows the loopback
  // families bind independently — a stale vite holding ::1:5173 leaves
  // 127.0.0.1:5173 looking free to a single-family probe, then the new
  // child spawns and fails for a different, undiagnosable reason. Both
  // families must be free for the port to count as free.
  const probeOne = (host: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
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
        server.listen(port, host);
      } catch {
        finish(false);
      }
    });
  return Promise.all([probeOne('127.0.0.1'), probeOne('::1')]).then(([v4, v6]) => v4 && v6);
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

/**
 * Stable sibling path for a project's preview worktree. Lives next to the repo
 * (not inside it) so git/pnpm tooling never sees a nested checkout, mirroring
 * `worktree.ts` `computeWorktreePath`. The name is keyed on projectId so the
 * worktree survives stop/start cycles and is reused rather than re-created.
 */
function previewWorktreePath(repoPath: string, projectId: string): string {
  const absRepo = resolve(repoPath);
  return join(dirname(absRepo), '.harness-worktrees', `preview-${projectId}`);
}

/**
 * Resolve the SHA the preview should check out. Prefers the project's `main`
 * branch (the ref auto-merge advances after a successful run). Falls back to
 * the current `HEAD` for repos that have no `main` (e.g. only `master`, or a
 * fresh detached checkout). Throws a clear error only when neither resolves.
 */
async function resolvePreviewSha(repoPath: string, run: typeof execa): Promise<string> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--verify', 'refs/heads/main'], {
      cwd: repoPath,
    });
    return stdout.trim();
  } catch {
    /* no main branch — fall through to HEAD */
  }
  try {
    const { stdout } = await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoPath });
    return stdout.trim();
  } catch (err) {
    throw new Error(
      `preview worktree: cannot resolve a checkout SHA (no refs/heads/main and no HEAD) in ${repoPath}: ${String(err)}`,
    );
  }
}

/**
 * In-flight de-dupe: two concurrent `ensurePreviewWorktree` calls for the same
 * projectId must not both run `git worktree add` (the second loses the create
 * race with "directory exists / not empty", which prune+retry does not fully
 * recover from). The second caller awaits the first's promise instead. The map
 * entry is cleared once the promise settles so a later call rebuilds cleanly.
 */
const inFlightWorktrees = new Map<string, Promise<string>>();

// Transient `git worktree add` failures (Windows .git/worktrees/<other>/commondir
// race when a walker run concurrently adds task worktrees) deserve a short
// backoff + retry, not a hard fail. Mirrors packages/orchestrator/src/worktree.ts.
const PREVIEW_WT_TRANSIENT_RE =
  /failed to read .git[\\/]worktrees[\\/].+[\\/]commondir|No such file or directory|Resource (?:temporarily|deadlock)|sharing violation|Access is denied|cannot create file|file in use/i;
const PREVIEW_WT_MAX_RETRIES = 3;

/**
 * Create or reuse the preview worktree checked out to the current `main` HEAD
 * (or `HEAD` fallback — see {@link resolvePreviewSha}). Never touches
 * repoPath's working tree — the worktree is always detached. Runs
 * `pnpm install --frozen-lockfile` only when node_modules is absent so
 * stop/start cycles after the first preview skip the install cost.
 *
 * Returns the absolute worktree path. Idempotent across concurrent calls for
 * the same projectId (see {@link inFlightWorktrees}).
 */
export async function ensurePreviewWorktree(
  repoPath: string,
  projectId: string,
  opts: { execaImpl?: typeof execa } = {},
): Promise<string> {
  const pending = inFlightWorktrees.get(projectId);
  if (pending) return pending;

  const promise = ensurePreviewWorktreeImpl(repoPath, projectId, opts).finally(() => {
    inFlightWorktrees.delete(projectId);
  });
  inFlightWorktrees.set(projectId, promise);
  return promise;
}

async function ensurePreviewWorktreeImpl(
  repoPath: string,
  projectId: string,
  opts: { execaImpl?: typeof execa },
): Promise<string> {
  const run = opts.execaImpl ?? execa;
  const wtPath = previewWorktreePath(repoPath, projectId);
  await mkdir(dirname(wtPath), { recursive: true });

  // Resolve the SHA now — this is the ref auto-merge already advanced.
  const sha = await resolvePreviewSha(repoPath, run);

  // Check if the worktree already exists (registered in git).
  const { stdout: wtList } = await run('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoPath,
  });
  const alreadyExists = wtList.includes(wtPath.replace(/\\/g, '/')) || wtList.includes(wtPath);

  if (alreadyExists) {
    // Reuse: reset hard to latest main so the preview shows post-run content.
    await run('git', ['reset', '--hard', sha], { cwd: wtPath });
  } else {
    // Create a detached worktree at the exact SHA, with a transient-retry loop
    // for the Windows commondir race (concurrent task-worktree adds during a
    // live run) and a prune+rm recovery for a leftover aborted-attempt dir.
    for (let attempt = 1; attempt <= PREVIEW_WT_MAX_RETRIES; attempt++) {
      try {
        await run('git', ['worktree', 'add', '--detach', wtPath, sha], { cwd: repoPath });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/already (exists|used)|not empty|already registered/i.test(msg)) {
          await run('git', ['worktree', 'prune'], { cwd: repoPath }).catch(() => undefined);
          await rm(wtPath, { recursive: true, force: true });
          await run('git', ['worktree', 'add', '--detach', wtPath, sha], { cwd: repoPath });
          break;
        }
        if (PREVIEW_WT_TRANSIENT_RE.test(msg) && attempt < PREVIEW_WT_MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
          await run('git', ['worktree', 'prune'], { cwd: repoPath }).catch(() => undefined);
          continue;
        }
        throw err;
      }
    }
  }

  // Install deps only when node_modules is absent (avoids re-running on every
  // stop/start cycle after the first preview).
  const nmPath = join(wtPath, 'node_modules');
  let needsInstall = true;
  try {
    await access(nmPath, constants.F_OK);
    needsInstall = false;
  } catch {
    /* absent — install below */
  }

  if (needsInstall) {
    const shell = process.platform === 'win32';
    try {
      await run('pnpm', ['install', '--frozen-lockfile'], { cwd: wtPath, shell });
    } catch {
      // Lockfile drift is common after a run that added deps — self-heal with a
      // mutable install rather than 500-ing the preview (mirrors runtime-verifier's
      // `pnpm ci || pnpm install`). The worktree is disposable, so mutating its
      // lockfile is harmless.
      await run('pnpm', ['install'], { cwd: wtPath, shell });
    }
  }

  return wtPath;
}

/**
 * Remove the preview worktree. Best-effort — the worktree may never have been
 * created (preview never started) or may already be gone. Never throws. Called
 * on project-delete (and fire-and-forget from stopPreview); NOT on a plain
 * stop, so a stop/start cycle reuses the worktree and skips re-install.
 */
export async function cleanupPreviewWorktree(repoPath: string, projectId: string): Promise<void> {
  const wtPath = previewWorktreePath(repoPath, projectId);
  try {
    await execa('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoPath });
  } catch {
    /* best-effort: worktree may never have been created */
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
    // same port we just told the child to bind to. Replace the hostname
    // with `localhost` so the system resolver picks whichever loopback
    // family vite actually bound to — on Windows vite binds ::1 by
    // default while many probeUrls (and detectProjectType output) use
    // 127.0.0.1, and they don't talk to each other. `localhost` resolves
    // to whichever family is alive.
    const portUrl =
      port === requestedPort ? probeUrl : probeUrl.replace(/:\d+/, ':' + String(port));
    const effectiveProbeUrl = portUrl.replace(
      /\/\/(127\.0\.0\.1|\[::1\])(?=[:/]|$)/,
      '//localhost',
    );

    // Append `--port <port>` so the spawned dev server actually binds the
    // port we picked. PORT env var alone is unreliable — vite ignores it,
    // next.js only reads it on `next start`. pnpm/npm/yarn forward extra
    // CLI args to the underlying script directly (without the `--`
    // separator — that separator gets passed literally to vite and
    // confuses its arg parser). So:
    //   pnpm dev   →  pnpm dev --port 5174   →  vite --port 5174
    //   vite       →  vite --port 5174
    const parts = devCmd.trim().split(/\s+/);
    const cmd = parts[0]!;
    const cmdArgs = [...parts.slice(1), '--port', String(port)];
    // When the caller specifies a basePath (vite / SvelteKit only — see
    // preview.ts whitelist), append `--base <basePath>` so the dev-server
    // emits HTML + asset URLs already prefixed with the reverse-proxy
    // path. Without this, vite serves `<script src="/src/main.tsx">`
    // which the iframe fetches from the dashboard's origin (not through
    // the proxy) and gets the dashboard SPA shell back — the preview
    // never hydrates.
    if (args.basePath) {
      cmdArgs.push('--base', args.basePath);
    }

    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };

    let child: ChildProcess;
    try {
      child = doSpawn(cmd, cmdArgs, {
        cwd: args.cwd ?? process.cwd(),
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
      // `cwd` is the preview worktree path (set by the preview route via
      // ensurePreviewWorktree). Recorded for cleanup on project-delete.
      ...(args.cwd ? { worktreePath: args.cwd } : {}),
      projectId,
    };
    this.entries.set(projectId, entry);

    // Drain stdout (avoid full-buffer deadlock) and capture the last 4 KB of
    // stderr so a failed start surfaces an actionable reason to the user
    // instead of just "timeout". A 4 KB ring is plenty for vite/next errors.
    child.stdout?.on('data', () => {});
    const stderrChunks: Buffer[] = [];
    let stderrTotal = 0;
    const STDERR_TAIL_BYTES = 4096;
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrTotal += chunk.length;
      while (stderrTotal > STDERR_TAIL_BYTES && stderrChunks.length > 1) {
        const removed = stderrChunks.shift()!;
        stderrTotal -= removed.length;
      }
    });
    const readStderrTail = (): string =>
      Buffer.concat(stderrChunks).toString('utf8').slice(-STDERR_TAIL_BYTES);

    let earlyExit: string | null = null;
    child.once('exit', (code, signal) => {
      earlyExit = `process exited (code=${code}, signal=${signal ?? 'none'})`;
    });

    const start = Date.now();
    while (Date.now() - start < readyTimeoutMs) {
      if (earlyExit) {
        const tail = readStderrTail().trim();
        entry.status = 'error';
        entry.errorReason = tail.length > 0 ? `${earlyExit}\nstderr: ${tail}` : earlyExit;
        return {
          status: 'error',
          port,
          pid: entry.pid,
          startedAt: entry.startedAt,
          error: entry.errorReason,
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

    const tail = readStderrTail().trim();
    const base = `timeout waiting for ${effectiveProbeUrl} (${readyTimeoutMs}ms)`;
    entry.status = 'error';
    entry.errorReason = tail.length > 0 ? `${base}\nstderr: ${tail}` : base;
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
