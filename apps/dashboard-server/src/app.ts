import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import websocket from '@fastify/websocket';
import { env } from './env.js';
import { getLogger } from './logger.js';
import { registerRoutes } from './routes/index.js';
import { registerWebsocket } from './ws.js';

/**
 * Resolve the path to the built dashboard-web `dist/` directory.
 *
 * Layout (src and dist mirror each other):
 *   <repo>/apps/dashboard-server/{src,dist}/app.{ts,js}
 *   <repo>/apps/dashboard-web/dist/index.html
 */
function resolveWebDistPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'dashboard-web', 'dist');
}

export async function buildApp(): Promise<FastifyInstance> {
  // Hand Fastify our pre-built pino instance (stdout + sync file destination).
  // We can no longer use `transport: pino-pretty` here because pino-pretty is
  // a worker-thread transport and is incompatible with multistream. Tradeoff:
  // dev logs are JSON instead of pretty — but we get crash-resilient file
  // logging in exchange, which today's outage made non-negotiable.
  // The pino Logger satisfies FastifyBaseLogger at runtime; the explicit cast
  // narrows the structural mismatch on `msgPrefix` between pino 10's Logger
  // and Fastify 5's FastifyBaseLogger.
  const app = Fastify({ loggerInstance: getLogger() as unknown as FastifyBaseLogger });

  await app.register(cors, { origin: env.WISP_CORS_ORIGIN });
  await app.register(websocket);
  // Chat attachments: multipart/form-data uploads, capped at 10 MB × 10 files.
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 10 } });

  await app.register(registerRoutes);
  registerWebsocket(app);

  // Optional: serve the built dashboard-web app at `/` so a single port hosts
  // both UI + API + WS. Used by the F1 e2e harness mode.
  if (env.WISP_SERVE_WEB) {
    const webDist = resolveWebDistPath();
    // Fail fast at boot if the dist directory is missing — otherwise
    // @fastify/static accepts the registration silently and every browser
    // request 500s on first asset lookup. The most common cause is forgetting
    // `pnpm --filter @wisp/dashboard-web build` before starting.
    if (!fs.existsSync(webDist)) {
      throw new Error(
        `WISP_SERVE_WEB=1 but dashboard-web dist directory not found at ${webDist}. ` +
          `Build the web bundle first: pnpm --filter @wisp/dashboard-web build`,
      );
    }
    await app.register(staticPlugin, {
      root: webDist,
      prefix: '/',
      // SPA fallback: any non-asset GET that isn't /api or /ws should return
      // index.html so client-side routing works.
      wildcard: false,
    });
    app.setNotFoundHandler((req, reply) => {
      const url = req.raw.url ?? '/';
      if (
        req.method !== 'GET' ||
        url.startsWith('/api') ||
        url.startsWith('/ws') ||
        url.startsWith('/assets') ||
        /\.[a-zA-Z0-9]+$/.test(url)
      ) {
        reply.code(404);
        return { error: 'not found' };
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
