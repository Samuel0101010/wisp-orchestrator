---
date: 2026-05-18
tags:
  [
    windows-max-path,
    sqlite-wal-shutdown,
    subprocess-tree-kill,
    pino-multistream,
    inactivity-watchdog,
  ]
files:
  - packages/orchestrator/src/subprocess.ts
  - packages/orchestrator/src/auto-commit.ts
  - packages/orchestrator/src/walker.ts
  - packages/orchestrator/src/liveness.ts
  - apps/dashboard-server/src/server.ts
  - apps/dashboard-server/src/logger.ts
  - apps/dashboard-server/src/orchestrator/release-gate.ts
related:
  - 2026-05-29-better-sqlite3-node24-prebuilt-gap.md
---

# WISP v2.0.2 — five reliability patterns from a real app-build outage

## Problem

A single multi-hour WISP session that built two complete React apps end-to-end (TaskFlow, FocusBoard) exposed five distinct outage classes, each previously invisible in the test suite:

1. A `vite` dev server spawned by a task days earlier was still bound to port 5173 — a stale dev server serving outdated source. User saw "boot:fail" (blank black screen) in a browser tab.
2. A `scaffold` task succeeded with exit 0, then crashed the post-task auto-commit with `git add -A` "could not open directory 'node_modules/.pnpm/@dnd-kit+core@…'" — Windows `MAX_PATH` overflow. Cascade-failed 6 downstream tasks.
3. The 10-min idle watchdog killed `n3-store` while the LLM was doing a long thinking pause with no token stream. Lost ~12 min + retry noise.
4. Run completed `ABGESCHLOSSEN (ERFOLG)` but the release-gate showed `Boot: FAIL` even though the `runtime-verifier` task had proven boot worked live (HTTP 200 within 3 s, `runtime-report.md: Boot: PASS`).
5. After a 3-hour run the dashboard server crashed; `%TEMP%/wisp-todo-v2-run/server.out.log` had exactly **one** line — Node's stdout buffer ate hundreds of request logs and the crash stack. Separately, hard-killing the server during restart left the SQLite WAL un-checkpointed and projects appeared missing on next boot.

## Root cause

Each is its own gotcha:

1. **child.kill() on Windows does not propagate to grandchildren.** WISP spawned `claude`, which spawned `pnpm preview` for boot-smoke, which spawned `vite`. `child.kill('SIGTERM')` only signals the immediate `claude` parent — the `pnpm`/`vite` grandchildren stay alive and keep their ports. On POSIX, `pnpm`/`vite` happen to propagate SIGTERM to their children most of the time, but a misbehaving subprocess can still detach.
2. **`pnpm install` produces paths past Windows `MAX_PATH` (260 chars).** `node_modules/.pnpm/<pkg>@<ver>_<hash>/node_modules/<pkg>/…` blows past 260 on any package with two peer deps. `git` walks `node_modules` for `git add -A` and aborts. The fix is `core.longpaths=true`, but that is a per-invocation `-c` flag — not on by default in user git config.
3. **The watchdog watched only subprocess stdout activity.** A long LLM thinking pause emits zero tokens to stdout for >10 min while the subprocess is alive and the work is real. The watchdog had no signal to distinguish "stuck" from "thinking".
4. **The release-gate ran its own boot probe** instead of trusting the `runtime-verifier` task's evidence in the same run. By the time the gate fired, the verifier's `pnpm preview` was already torn down — gate's fresh `pnpm preview` either raced or hit a port collision and reported FAIL.
5. **Two compounding Node defaults**: (a) `process.stdout` is fully-buffered when piped to a file (the `> server.out.log` pattern from `nohup`/`Start-Process`), so hours of log lines stay in-buffer until flush — lost on crash. (b) `better-sqlite3` with WAL mode requires an explicit `PRAGMA wal_checkpoint` or `db.close()` to merge WAL into the main `.db` file; `Stop-Process -Force` skips Node's exit hooks and leaves the WAL stranded.

## Solution

Five commits shipped as v2.0.2:

```
a808707 fix(orchestrator): kill the whole subprocess tree on task end
0b01994 fix(orchestrator): pass core.longpaths=true to auto-commit git calls
2b3a7bf fix(release-gate): trust runtime-verifier boot evidence instead of re-probing
9c92e0c fix(orchestrator): smart inactivity watchdog — pid + CPU advancing before kill
1fe24ef fix(dashboard-server): crash-resilient logging + WAL checkpoint on shutdown + startup banner
```

## Key snippets

**Pattern 1 — tree-kill** (`packages/orchestrator/src/subprocess.ts`):

```typescript
function killTree(child: ChildProcessWithoutNullStreams, signal = 'SIGTERM') {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, signal); // negative pid = process group
    } catch {
      child.kill(signal);
    }
  }
}
// Spawn must use `detached: process.platform !== 'win32'` so the negative-PID
// kill targets the spawned group, not the orchestrator itself.
```

**Pattern 2 — longpaths in auto-commit** (`packages/orchestrator/src/auto-commit.ts`):

```typescript
const GIT_OVERRIDES = [
  '-c',
  'user.email=wisp@wisp.local',
  '-c',
  'user.name=WISP',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'core.longpaths=true', // Windows MAX_PATH escape; pnpm .pnpm/<pkg>@<ver>_<hash>/ overflows easily
];
await execa('git', [...GIT_OVERRIDES, 'add', '-A'], { cwd: worktreePath });
```

**Pattern 3 — smart watchdog** (`packages/orchestrator/src/walker.ts` + `liveness.ts`):

```typescript
// Before declaring stall, check (a) pid alive, (b) CPU advancing.
const alive = await probePidLiveness(pid); // process.kill(pid, 0); ESRCH = dead
if (!alive) {
  killAndRetry('pid not found');
  return;
}
const cpuNow = await readCpuTimeSeconds(pid); // POSIX `ps -o time=`, Win `Get-Process`
if (cpuNow - cpuAtIdleStart >= 1) {
  extendGraceWindow(); // +5 min, cap 25 min
  return;
}
killAndRetry('alive but CPU stuck');
```

**Pattern 4 — release-gate trusts runtime-verifier** (`apps/dashboard-server/src/orchestrator/release-gate.ts`):

```typescript
// Only re-probe boot if there's NO runtime-verifier evidence for this run.
const bootEvidence = input.runtime?.boot;
if (bootEvidence != null) {
  summary.bootOk = bootEvidence.ok; // authoritative
} else if (input.probeBootFn) {
  summary.bootOk = (await input.probeBootFn()).ok; // legacy fallback
}
```

**Pattern 5 — crash-resilient pino + WAL checkpoint** (`apps/dashboard-server/src/logger.ts` + `server.ts`):

```typescript
// logger.ts — pino multistream over stdout + sync file destination.
const streams: DestinationStream[] = [
  { stream: process.stdout },
  pino.destination({ dest: serverLogPath, sync: true, mkdir: true }), // flush every line
];
const logger = pino({ level: env.WISP_LOG_LEVEL }, pino.multistream(streams));
// NOTE: pino-pretty transport is incompatible with multistream (worker-thread). Drop it.

// server.ts — single-shot graceful shutdown on every exit signal.
let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await app.close();
  } catch (e) {
    logger.error({ err: e }, 'app.close failed');
  }
  try {
    flushLogStreams();
  } catch {
    /* ignore */
  }
  try {
    sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    sqlite.close();
  } catch (e) {
    logger.error({ err: e }, 'wal checkpoint/close failed');
  }
  process.exit(code);
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => shutdown(0));
process.on('beforeExit', () => shutdown(0));
process.on('uncaughtException', (e) => {
  appendCrashRecord(e);
  shutdown(1);
});
process.on('unhandledRejection', (e) => {
  appendCrashRecord(e);
  shutdown(1);
});

// startup banner — visible misconfigured-datadir detection on boot.
logger.info(
  {
    event: 'startup-banner',
    listening: addr,
    dataDir: env.WISP_DATA_DIR,
    dbPath,
    dbSizeMb: ...,
    projectCount: ...,
    runsTotal: ...,
    runsToday: ...,
    serverLog: serverLogPath,
    crashLog: crashLogPath,
  },
  'startup-banner',
);
```

## Verification

- **All 7 local gates green** before push: `pnpm install --frozen-lockfile`, `pnpm -r --filter "./packages/**" run build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check`, `pnpm --filter @wisp/dashboard-web tokens:check`, `pnpm encoding:check`.
- **769 tests passing** across 5 workspaces (dashboard-server 441, orchestrator 119, dashboard-web 123, schemas 53, memory-mcp 33).
- **CI** `completed success` in 8m39s on the release commit (`gh run list --workflow ci.yml --branch main --limit 1`).
- **Live restart of the hardened dashboard** showed the new startup banner in the first log line (was invisible before) and `{WISP_DATA_DIR}/logs/server.log` filling with one JSON per request — the buffer-loss is gone.
- **Release published** at <https://github.com/Samuel0101010/wisp-orchestrator/releases/tag/v2.0.2>; README badge auto-bumped by `release-badge.yml` (10 s after the release event).

## Lessons

- **PowerShell `Start-Process -RedirectStandardOutput` does not always propagate parent env vars to the child.** Lost 30 min during the session because a restarted dashboard came up with the default `WISP_DATA_DIR` instead of the session's. Reliable fix: spin up via `[System.Diagnostics.ProcessStartInfo]` with explicit `EnvironmentVariables[…]` set after copying parent env in a foreach. Or just use Bash `nohup` with explicit `KEY=val …` prefixes — that works.
- **`pino-pretty` is a worker-thread transport and is incompatible with `pino.multistream`.** If you want JSON to a sync file + pretty to stdout, you have to write your own pretty formatter for the stdout branch, or accept JSON in both. The reliability-of-logs trade-off wins; we dropped pino-pretty in v2.0.2.
- **The release-gate vs runtime-verifier duplication is an anti-pattern** but easy to fall into: each component thinks it's the source of truth. The fix is to declare a single source per fact (here: runtime-verifier owns boot) and have the rest read its evidence rather than re-probing.
- **The 10-min inactivity watchdog used to assume "no stdout = stuck"**, which is wrong for LLM-driven subprocesses where the model itself can think silently for >10 min. Liveness is a 2-of-2 condition: pid alive AND CPU advancing. Either alone is misleading.
- **CLAUDE.md's 9-step release ritual works exactly as documented.** Don't skip step 5 (`gh run list --workflow ci.yml --branch main --limit 1` until `completed success`) — the release-badge workflow only fires on the `release: published` event from step 7, and you don't want to publish a release pointing at a red CI run.
- **The Claude-Code safety filter intercepts `git push origin main`** and demands explicit per-action authorization, even when the repo-owner is the operator and CLAUDE.md says direct push is allowed. Workflow: use `AskUserQuestion` for the consent, then push.
