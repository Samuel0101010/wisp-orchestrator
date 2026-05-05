/**
 * Subscription-auth probe.
 *
 * Runs a minimal `claude -p --max-turns 1` and classifies the failure mode so
 * the harness can surface an actionable hint. Times out in 30s.
 */

import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import process from 'node:process';
import { detectRateLimit } from './rate-limit.js';

const PROBE_TIMEOUT_MS = 30_000;
const AUTH_MARKERS = [
  /credentials?/i,
  /unauthori[sz]ed/i,
  /\bauth(?:entication|orization)?\b/i,
  /not logged in/i,
  /please run.*claude\s+login/i,
];

export type AuthProbeResult =
  | { ok: true; durationMs: number }
  | { ok: false; error: string; hint: string };

export interface ProbeOpts {
  __mockBin?: string;
  __mockEnv?: Record<string, string>;
  /** Override the timeout (test-only). */
  __timeoutMs?: number;
}

function resolveBin(opts: ProbeOpts): { cmd: string; argPrefix: string[] } {
  if (opts.__mockBin) {
    const ext = extname(opts.__mockBin).toLowerCase();
    if (ext === '.mjs' || ext === '.js' || ext === '.cjs') {
      return { cmd: process.execPath, argPrefix: [opts.__mockBin] };
    }
    return { cmd: opts.__mockBin, argPrefix: [] };
  }
  return { cmd: 'claude', argPrefix: [] };
}

export async function probeSubscriptionAuth(opts: ProbeOpts = {}): Promise<AuthProbeResult> {
  const { cmd, argPrefix } = resolveBin(opts);
  const args = [
    ...argPrefix,
    '-p',
    '--max-turns',
    '1',
    '--output-format',
    'stream-json',
    // Required by `claude -p` when --output-format is stream-json.
    '--verbose',
  ];

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  env.CI = env.CI ?? '1';
  if (opts.__mockEnv) {
    for (const [k, v] of Object.entries(opts.__mockEnv)) {
      env[k] = v;
    }
  }

  const timeoutMs = opts.__timeoutMs ?? PROBE_TIMEOUT_MS;
  const start = Date.now();

  return new Promise<AuthProbeResult>((resolve) => {
    const child = spawn(cmd, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: AuthProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGTERM');
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: `auth probe timed out after ${timeoutMs}ms`,
        hint: 'See `claude --help` for diagnostics.',
      });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.stdin.end('say hi');

    child.once('error', (err) => {
      finish({
        ok: false,
        error: `failed to spawn claude: ${err.message}`,
        hint: 'Ensure the `claude` CLI is installed and on PATH.',
      });
    });

    child.once('close', (code) => {
      if (code === 0) {
        finish({ ok: true, durationMs: Date.now() - start });
        return;
      }
      const combined = `${stdout}\n${stderr}`;
      if (detectRateLimit(combined)) {
        finish({
          ok: false,
          error: combined.trim().slice(-512) || `exit code ${code}`,
          hint: 'Subscription quota exhausted; try again after the reset window.',
        });
        return;
      }
      if (AUTH_MARKERS.some((re) => re.test(combined))) {
        finish({
          ok: false,
          error: combined.trim().slice(-512) || `exit code ${code}`,
          hint: 'Run `claude login` to refresh credentials.',
        });
        return;
      }
      finish({
        ok: false,
        error: combined.trim().slice(-512) || `exit code ${code}`,
        hint: 'See `claude --help` for diagnostics.',
      });
    });
  });
}
