import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const logLevelEnum = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

const booleanLike = z.union([z.string(), z.boolean(), z.undefined()]).transform((v) => {
  if (typeof v === 'boolean') return v;
  if (v === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
});

// Same parsing, but DEFAULTS TO TRUE when unset — for safety flags where the
// non-developer-friendly behaviour is "on" and the env var is an opt-OUT.
const booleanLikeDefaultTrue = z.union([z.string(), z.boolean(), z.undefined()]).transform((v) => {
  if (typeof v === 'boolean') return v;
  if (v === undefined) return true;
  return !['0', 'false', 'no', 'off'].includes(v.toLowerCase());
});

const isProd = process.env.NODE_ENV === 'production';
// Basename MUST match the launchers (scripts/launch-dashboard.{ps1,sh} both use
// 'agent-harness'). The launcher always passes WISP_DATA_DIR explicitly, but a
// bare `node dist/server.js` (dev snippet, doctor) falls back to this default —
// keeping the basename aligned prevents a split-brain where projects "vanish"
// between launch methods.
const defaultDataDir =
  process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'agent-harness')
    : path.join(os.homedir(), '.local', 'share', 'agent-harness');

const envSchema = z.object({
  WISP_PORT: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 4400 : Number.parseInt(v, 10)))
    .pipe(z.number().int().positive()),
  WISP_HOST: z.string().default('127.0.0.1'),
  WISP_DATA_DIR: isProd
    ? z.string({ required_error: 'WISP_DATA_DIR is required in production' }).min(1)
    : z.string().min(1).default(defaultDataDir),
  WISP_LOG_LEVEL: logLevelEnum.default('info'),
  WISP_CORS_ORIGIN: z.string().default('http://localhost:5173'),
  WISP_MOCK_CLI: booleanLike,
  WISP_SERVE_WEB: booleanLike,
  WISP_INTER_TASK_PACING_MS: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 5000 : Number.parseInt(v, 10)))
    .pipe(z.number().int().min(0).max(600_000)),
  // Default ON: an interrupted (rate-limited) run should continue itself rather
  // than dead-end until a human notices. Set WISP_AUTO_RESUME_RATE_LIMIT=0 to
  // opt out.
  WISP_AUTO_RESUME_RATE_LIMIT: booleanLikeDefaultTrue,
  WISP_AUTH_MODE: z.enum(['subscription', 'api']).default('subscription'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

export const env: Env = loadEnv();
