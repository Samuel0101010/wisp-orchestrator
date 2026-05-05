import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const logLevelEnum = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

const booleanLike = z.union([z.string(), z.boolean(), z.undefined()]).transform((v) => {
  if (typeof v === 'boolean') return v;
  if (v === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
});

const isProd = process.env.NODE_ENV === 'production';
const defaultDataDir = path.join(os.tmpdir(), 'agent-harness');

const envSchema = z.object({
  HARNESS_PORT: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 4400 : Number.parseInt(v, 10)))
    .pipe(z.number().int().positive()),
  HARNESS_HOST: z.string().default('127.0.0.1'),
  HARNESS_DATA_DIR: isProd
    ? z.string({ required_error: 'HARNESS_DATA_DIR is required in production' }).min(1)
    : z.string().min(1).default(defaultDataDir),
  HARNESS_LOG_LEVEL: logLevelEnum.default('info'),
  HARNESS_CORS_ORIGIN: z.string().default('http://localhost:5173'),
  HARNESS_MOCK_CLI: booleanLike,
  HARNESS_SERVE_WEB: booleanLike,
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
