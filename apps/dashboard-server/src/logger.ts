import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger, type DestinationStream } from 'pino';
import { env } from './env.js';

/**
 * Crash-resilient logger.
 *
 * Today's outage exposed two problems with bare `console.log` + redirected
 * stdout:
 *   1. Node buffers stdout when it's piped to a file — hours of incoming
 *      requests vanish on a hard crash because the buffer never flushed.
 *   2. There was no canonical on-disk log location — investigating required
 *      grepping multiple `%TEMP%` folders.
 *
 * Fix: write to TWO streams in parallel —
 *   (a) `process.stdout`  — preserves the existing developer experience.
 *   (b) sync file stream  — `{WISP_DATA_DIR}/logs/server.log`, opened with
 *       `sync: true` so every log line is flushed before the call returns.
 *
 * In `test` mode (WISP_LOG_LEVEL=silent) we use a no-op logger so vitest
 * stays quiet.
 */

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const logsDir = path.join(env.WISP_DATA_DIR, 'logs');
const serverLogPath = path.join(logsDir, 'server.log');
const crashLogPath = path.join(logsDir, 'crash.log');

interface LoggerBundle {
  logger: Logger;
  /** Sync-flushable streams the shutdown hook should drain. */
  streams: DestinationStream[];
  serverLogPath: string;
  crashLogPath: string;
}

let bundle: LoggerBundle | null = null;

function buildLogger(): LoggerBundle {
  // Test mode: silent logger, no files written. The setup.ts test bootstrap
  // sets WISP_LOG_LEVEL='silent' so we don't even build streams.
  if (env.WISP_LOG_LEVEL === 'silent' || process.env.NODE_ENV === 'test') {
    const logger = pino({ level: 'silent' });
    return { logger, streams: [], serverLogPath, crashLogPath };
  }

  ensureDir(logsDir);

  // sync: true forces every write() to flush before returning — at the cost
  // of throughput. For a dashboard server doing low-100s of req/s this is
  // the right tradeoff: we'd rather block 0.1ms per log than lose the last
  // 4 KB on crash.
  const fileDest = pino.destination({
    dest: serverLogPath,
    sync: true,
    append: true,
    mkdir: true,
  });

  const stdoutDest = pino.destination({ dest: 1, sync: true });

  const streams: DestinationStream[] = [stdoutDest, fileDest];

  const logger = pino(
    { level: env.WISP_LOG_LEVEL },
    pino.multistream(streams.map((stream) => ({ stream }))),
  );

  return { logger, streams, serverLogPath, crashLogPath };
}

export function getLogger(): Logger {
  if (!bundle) bundle = buildLogger();
  return bundle.logger;
}

export function getLogStreams(): DestinationStream[] {
  if (!bundle) bundle = buildLogger();
  return bundle.streams;
}

export function getLogPaths(): { serverLog: string; crashLog: string } {
  if (!bundle) bundle = buildLogger();
  return { serverLog: bundle.serverLogPath, crashLog: bundle.crashLogPath };
}

/**
 * Best-effort flush of all configured streams. Called from shutdown +
 * uncaughtException paths. Each flush is wrapped — one stream's failure
 * MUST NOT prevent the others from flushing.
 */
export function flushLogStreams(): void {
  const streams = getLogStreams();
  for (const stream of streams) {
    try {
      const maybeFlush = (stream as { flushSync?: () => void }).flushSync;
      if (typeof maybeFlush === 'function') {
        maybeFlush.call(stream);
      }
    } catch {
      // Swallow — the next stream may still flush.
    }
  }
}

/**
 * Synchronously append a crash record to `{WISP_DATA_DIR}/logs/crash.log`.
 * Used by uncaughtException / unhandledRejection — fs.appendFileSync is the
 * only API guaranteed to land on disk before `process.exit()` runs.
 */
export function appendCrashRecord(record: {
  kind: 'uncaughtException' | 'unhandledRejection';
  error: unknown;
}): void {
  if (env.WISP_LOG_LEVEL === 'silent' || process.env.NODE_ENV === 'test') {
    return;
  }
  try {
    ensureDir(logsDir);
    const err = record.error;
    const message =
      err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
    const line = `${new Date().toISOString()} ${record.kind}\n${message}\n---\n`;
    fs.appendFileSync(crashLogPath, line, { encoding: 'utf8' });
  } catch {
    // Last-ditch — if we can't write to crash.log there's nowhere else to go.
  }
}
