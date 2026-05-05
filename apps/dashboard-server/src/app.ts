import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import websocket from '@fastify/websocket';
import { env } from './env.js';
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
  const isProd = process.env.NODE_ENV === 'production';

  const app = Fastify({
    logger: isProd
      ? { level: env.HARNESS_LOG_LEVEL }
      : {
          level: env.HARNESS_LOG_LEVEL,
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        },
  });

  await app.register(cors, { origin: env.HARNESS_CORS_ORIGIN });
  await app.register(websocket);

  await app.register(registerRoutes);
  registerWebsocket(app);

  // Optional: serve the built dashboard-web app at `/` so a single port hosts
  // both UI + API + WS. Used by the F1 e2e harness mode.
  if (env.HARNESS_SERVE_WEB) {
    const webDist = resolveWebDistPath();
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
