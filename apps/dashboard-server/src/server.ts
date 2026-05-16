import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { probeSubscriptionAuth, type AuthProbeResult } from '@wisp/orchestrator';
import { buildApp } from './app.js';
import { env } from './env.js';
import { setLastAuthProbe } from './auth-status.js';
import { db, sqlite } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { backfillAgents } from './db/agents-backfill.js';
import { seedAgents } from './db/agents-seed.js';
import { fixUpAbruptCrashes } from './orchestrator/recovery.js';
import { getDefaultRuntime } from './routes/runs.js';
import { workerDaemon } from './routes/index.js';

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
 * Graceful shutdown:
 *   - Pause every resident walker (persists checkpoint, marks DB
 *     `status='paused', pausedReason='shutdown'`).
 *   - Close Fastify (stops accepting connections).
 *   - Close sqlite.
 * Hard timeout: {@link SHUTDOWN_TIMEOUT_MS}. If anything hangs past it, log and
 * `process.exit(1)`.
 */
export async function shutdown(app: FastifyInstance, signal: string): Promise<void> {
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
    try {
      sqlite.close();
    } catch (err) {
      app.log.error({ err }, 'error closing sqlite');
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
    process.exit(1);
  }
  process.exit(0);
}

async function main(): Promise<void> {
  const app = await bootstrap();

  process.on('SIGTERM', () => {
    void shutdown(app, 'SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown(app, 'SIGINT');
  });

  const address = await app.listen({ host: env.WISP_HOST, port: env.WISP_PORT });
  app.log.info({ address }, 'dashboard-server listening');
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
