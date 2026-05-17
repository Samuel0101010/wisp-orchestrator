import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { probeSubscriptionAuth, type AuthProbeResult } from '@wisp/orchestrator';
import { buildApp } from './app.js';
import { env } from './env.js';
import { setLastAuthProbe } from './auth-status.js';
import { db, sqlite } from './db/index.js';
// db is used by bootstrap helpers (fixUpAbruptCrashes); sqlite is used by the
// startup banner and the WAL-checkpoint shutdown step.
import { runMigrations } from './db/migrate.js';
import { backfillAgents } from './db/agents-backfill.js';
import { seedAgents } from './db/agents-seed.js';
import { fixUpAbruptCrashes } from './orchestrator/recovery.js';
import { getDefaultRuntime } from './routes/runs.js';
import { workerDaemon } from './routes/index.js';
import {
  appendCrashRecord,
  flushLogStreams,
  getLogPaths,
  getLogger,
} from './logger.js';

const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Boot sequence (E2):
 *   1. Run migrations.
 *   2. Fix up orphaned `running` runs from a previous abrupt crash → mark
 *      them paused/shutdown so the UI can offer resume.
 *   3. Probe subscription auth so /api/health surfaces a hint when claude is
 *      not logged in. Auth probe NEVER fails bootstrap — the dashboard must
 *      always boot so the user can see the diagnostic.
 *   4. Build Fastify with all routes mounted.
 */
export async function bootstrap(): Promise<FastifyInstance> {
  runMigrations();
  // Chat v2: install the built-in dev team (Marcus + 9 specialists). Idempotent
  // — keyed on agents.seed_key UNIQUE.
  try {
    const seed = seedAgents();
    if (seed.installed > 0 || seed.refreshed > 0) {
      console.log(JSON.stringify({ event: 'agents-seed', ...seed }));
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'agents-seed',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  // Model B: ensure every team role has a corresponding agent in the registry
  // so the chat surface can target it. Idempotent.
  try {
    const stats = backfillAgents();
    if (stats.agentsCreated > 0 || stats.rolesLinked > 0) {
      console.log(JSON.stringify({ event: 'agents-backfill', ...stats }));
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'agents-backfill',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  await fixUpAbruptCrashes(db);
  await runBootAuthProbe();
  const app = await buildApp();
  if (process.env.NODE_ENV !== 'test') {
    workerDaemon.start();
  }
  return app;
}

async function runBootAuthProbe(): Promise<void> {
  if (env.WISP_MOCK_CLI) {
    console.log(JSON.stringify({ event: 'auth-probe', skipped: 'mock-cli' }));
    setLastAuthProbe(null);
    return;
  }
  try {
    const result: AuthProbeResult = await probeSubscriptionAuth();
    if (result.ok) {
      console.log(JSON.stringify({ event: 'auth-probe', ok: true, durationMs: result.durationMs }));
    } else {
      console.log(
        JSON.stringify({
          event: 'auth-probe',
          ok: false,
          hint: result.hint,
          error: result.error.slice(-256),
        }),
      );
    }
    setLastAuthProbe(result);
  } catch (err) {
    // Defensive — probe should never throw, but if it does, swallow.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({ event: 'auth-probe', ok: false, error: `probe threw: ${message}` }),
    );
    setLastAuthProbe({
      ok: false,
      error: `probe threw: ${message}`,
      hint: 'See `claude --help` for diagnostics.',
    });
  }
}

/**
 * Build the startup banner line right after the server starts listening.
 * Surfaces the resolved data dir + DB stats so an operator who restarted
 * with the wrong WISP_DATA_DIR sees that immediately instead of after 2
 * minutes of "where are my projects?"
 */
export function buildStartupBannerPayload(address: string): Record<string, unknown> {
  const dataDir = path.resolve(env.WISP_DATA_DIR);
  const dbPath = path.join(dataDir, 'harness.db');

  let dbSizeMb: number | null = null;
  try {
    const stat = fs.statSync(dbPath);
    dbSizeMb = Number((stat.size / (1024 * 1024)).toFixed(2));
  } catch {
    dbSizeMb = null;
  }

  let projectCount: number | null = null;
  let runsTotal: number | null = null;
  let runsToday: number | null = null;
  try {
    const pc = sqlite.prepare('SELECT COUNT(*) AS c FROM projects').get() as
      | { c: number }
      | undefined;
    projectCount = pc?.c ?? 0;
  } catch {
    projectCount = null;
  }
  try {
    const rt = sqlite.prepare('SELECT COUNT(*) AS c FROM runs').get() as
      | { c: number }
      | undefined;
    runsTotal = rt?.c ?? 0;
    // runs.started_at is a unix millis integer in the schema (SQLite); compare
    // against today's local midnight.
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const since = midnight.getTime();
    const today = sqlite
      .prepare('SELECT COUNT(*) AS c FROM runs WHERE started_at >= ?')
      .get(since) as { c: number } | undefined;
    runsToday = today?.c ?? 0;
  } catch {
    // Schema may not exist yet (first boot before migrations) or columns may
    // differ — never let banner stats kill the boot.
  }

  const { serverLog, crashLog } = getLogPaths();

  return {
    event: 'startup-banner',
    listening: address,
    dataDir,
    dbPath,
    dbSizeMb,
    projectCount,
    runsTotal,
    runsToday,
    serverLog,
    crashLog,
    pid: process.pid,
    nodeVersion: process.version,
  };
}

// Ensure the shutdown path runs at most once even if multiple signals fire
// (Ctrl+C twice, SIGTERM during SIGINT cleanup, etc.).
let shutdownInFlight = false;

/** Test-only — reset the single-shot latch between cases. */
export function __resetShutdownLatchForTesting(): void {
  shutdownInFlight = false;
}

/**
 * Graceful shutdown:
 *   - Pause every resident walker (persists checkpoint, marks DB
 *     `status='paused', pausedReason='shutdown'`).
 *   - Close Fastify (stops accepting connections).
 *   - Flush logs.
 *   - WAL-checkpoint(TRUNCATE) so the next boot sees a consistent DB even if
 *     the .wal file is deleted. Then close sqlite.
 *   - Exit with the supplied code.
 * Each step is wrapped — one failure MUST NOT skip the remaining steps.
 * Hard timeout: {@link SHUTDOWN_TIMEOUT_MS}. If anything hangs past it, log
 * and force-exit 1.
 */
export async function shutdown(
  app: FastifyInstance,
  signal: string,
  exitCode = 0,
): Promise<void> {
  if (shutdownInFlight) {
    app.log.warn({ signal }, 'shutdown already in flight, ignoring repeat');
    return;
  }
  shutdownInFlight = true;
  app.log.info({ signal }, 'shutting down');

  const work = (async () => {
    try {
      await getDefaultRuntime().pauseAllForShutdown();
    } catch (err) {
      app.log.error({ err }, 'pauseAllForShutdown failed');
    }
    try {
      await app.close();
    } catch (err) {
      app.log.error({ err }, 'error closing fastify');
    }
    // Drain log streams BEFORE closing the DB so any sqlite-related error
    // above lands on disk.
    try {
      flushLogStreams();
    } catch {
      // ignore
    }
    try {
      // Force a WAL checkpoint with TRUNCATE so the .wal file is shrunk to
      // zero. Without this, killing the process mid-write can leave a stale
      // .wal that, when the original .db is moved/renamed, makes projects
      // appear missing on the next boot (today's bug).
      sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (err) {
      app.log.error({ err }, 'wal_checkpoint failed');
    }
    try {
      sqlite.close();
    } catch (err) {
      app.log.error({ err }, 'error closing sqlite');
    }
    // Final flush so the wal_checkpoint / sqlite.close errors above (if any)
    // are also persisted.
    try {
      flushLogStreams();
    } catch {
      // ignore
    }
  })();

  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS);
  });

  const winner = await Promise.race([work.then(() => 'ok' as const), timeout]);
  if (timer) clearTimeout(timer);
  if (winner === 'timeout') {
    app.log.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'shutdown timed out — hard-exiting');
    try {
      flushLogStreams();
    } catch {
      // ignore
    }
    process.exit(1);
  }
  process.exit(exitCode);
}

/**
 * Register process-level handlers for SIGTERM, SIGINT, beforeExit,
 * uncaughtException, unhandledRejection.
 *
 * Exposed so tests can drive the signal handlers without spawning a real
 * child process — the SIGTERM test grabs the handler with
 * `process.listeners('SIGTERM')[0]` and invokes it directly against a mock
 * sqlite.
 */
export function registerShutdownHandlers(app: FastifyInstance): void {
  const onSignal = (signal: string) => () => {
    void shutdown(app, signal, 0);
  };
  process.on('SIGTERM', onSignal('SIGTERM'));
  process.on('SIGINT', onSignal('SIGINT'));
  // beforeExit fires when the event loop is empty and no work is queued —
  // e.g. all handles closed. Drives the same cleanup path so we never leak
  // a non-checkpointed .wal on a clean exit.
  process.on('beforeExit', () => {
    void shutdown(app, 'beforeExit', 0);
  });

  process.on('uncaughtException', (err) => {
    appendCrashRecord({ kind: 'uncaughtException', error: err });
    try {
      app.log.fatal({ err }, 'uncaughtException — triggering shutdown');
    } catch {
      // log stream might be broken; the crash file write above is the
      // authoritative record.
    }
    void shutdown(app, 'uncaughtException', 1);
  });

  process.on('unhandledRejection', (reason) => {
    appendCrashRecord({ kind: 'unhandledRejection', error: reason });
    try {
      app.log.fatal({ reason }, 'unhandledRejection — triggering shutdown');
    } catch {
      // ignore
    }
    void shutdown(app, 'unhandledRejection', 1);
  });
}

async function main(): Promise<void> {
  // Touch the logger early so the file destination is opened (and any error
  // on disk creation surfaces) before listen().
  getLogger();

  const app = await bootstrap();
  registerShutdownHandlers(app);

  const address = await app.listen({ host: env.WISP_HOST, port: env.WISP_PORT });
  app.log.info({ address }, 'dashboard-server listening');
  app.log.info(buildStartupBannerPayload(address), 'startup-banner');
}

// ESM entrypoint guard — only run main() when this file is the entry module.
const isEntry = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isEntry) {
  main().catch((err) => {
    console.error('fatal startup error', err);
    process.exit(1);
  });
}
