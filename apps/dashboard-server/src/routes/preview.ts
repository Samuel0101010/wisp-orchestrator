/**
 * Preview routes (v1.11 Phase 3) — start/stop control + reverse-proxy.
 *
 *   POST  /api/projects/:projectId/preview/start
 *   POST  /api/projects/:projectId/preview/stop
 *   GET   /api/projects/:projectId/preview/status
 *   ALL   /preview/:projectId/*                — forwards to the live dev server
 *
 * The reverse-proxy intentionally bypasses Fastify's body parsing and re-uses
 * `request.raw` + `reply.raw` so we stream chunks back without buffering an
 * entire HTML payload. We strip `accept-encoding` from the upstream request
 * (so we never have to decode gzip / brotli) and drop the connection /
 * content-length headers the upstream sets (Node sets fresh ones).
 *
 * Loopback only — the spawned dev server listens on 127.0.0.1 and the proxy
 * forwards to it from the dashboard process itself. There is no exposed
 * surface for an external client to reach the dev server except through this
 * proxy, which inherits the dashboard's own auth (none today, but that's a
 * separate gate).
 */
import http, { type IncomingMessage } from 'node:http';
import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { projects } from '@wisp/schemas';
import { db } from '../db/index.js';
import { wrap } from './wrap.js';
import { detectProjectType } from '../orchestrator/detect-project-type.js';
import { previewProcesses, type PreviewProcessRegistry } from '../orchestrator/preview-server.js';

export interface PreviewRouterDeps {
  /** Test seam — swap the registry. */
  registry?: PreviewProcessRegistry;
}

export function createPreviewRouter(deps: PreviewRouterDeps = {}): FastifyPluginAsync {
  const registry = deps.registry ?? previewProcesses;

  const router: FastifyPluginAsync = async (app) => {
    app.post(
      '/api/projects/:projectId/preview/start',
      wrap(async (req, reply) => {
        const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);
        const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!project) {
          reply.code(404);
          return { error: 'project not found' };
        }

        let devCmd = project.runtimeVerifyDevCmd;
        let probeUrl = project.runtimeVerifyProbeUrl;
        if (!devCmd || !probeUrl) {
          const detection = detectProjectType(project.repoPath);
          devCmd = devCmd ?? detection.devCommand;
          probeUrl = probeUrl ?? detection.probeUrl;
        }
        if (!devCmd || !probeUrl) {
          reply.code(400);
          return {
            error: 'no_dev_cmd',
            hint: 'configure runtimeVerifyDevCmd + runtimeVerifyProbeUrl on the project, or add a recognised framework to package.json',
          };
        }

        const result = await registry.startPreview({ projectId, devCmd, probeUrl });
        return result;
      }),
    );

    app.post(
      '/api/projects/:projectId/preview/stop',
      wrap(async (req) => {
        const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);
        return registry.stopPreview(projectId);
      }),
    );

    app.get(
      '/api/projects/:projectId/preview/status',
      wrap(async (req) => {
        const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);
        return registry.getPreviewStatus(projectId);
      }),
    );

    // Reverse-proxy. Fastify's `all` matches every HTTP verb. We bind to the
    // wildcarded suffix manually because the wildcard otherwise collides with
    // the more-specific /api/* routes when registered first.
    app.all('/preview/:projectId/*', (req, reply) => {
      const projectId = (req.params as { projectId: string }).projectId;
      const status = registry.getPreviewStatus(projectId);
      if (!status.running || status.port == null) {
        reply.code(502).send({ error: 'preview_not_running' });
        return;
      }

      const rawUrl = req.raw.url ?? '/';
      const prefix = `/preview/${projectId}`;
      let suffix = rawUrl.startsWith(prefix) ? rawUrl.slice(prefix.length) : rawUrl;
      if (!suffix.startsWith('/')) suffix = '/' + suffix;

      // Copy headers, then strip the ones that would confuse the upstream
      // or that node would set freshly anyway. The host header must be
      // rewritten so the upstream's vhost routing doesn't bounce on it.
      const headers: Record<string, string | string[] | undefined> = { ...req.headers };
      delete headers['accept-encoding'];
      delete headers['content-length'];
      delete headers['connection'];
      headers['host'] = `127.0.0.1:${status.port}`;

      const upstream = http.request(
        {
          hostname: '127.0.0.1',
          port: status.port,
          method: req.raw.method ?? 'GET',
          path: suffix,
          headers: headers as http.OutgoingHttpHeaders,
        },
        (res: IncomingMessage) => {
          reply.raw.statusCode = res.statusCode ?? 502;
          for (const [k, v] of Object.entries(res.headers)) {
            if (v == null) continue;
            try {
              reply.raw.setHeader(k, v);
            } catch {
              /* ignore unsettable headers */
            }
          }
          res.pipe(reply.raw);
        },
      );

      upstream.on('error', (err) => {
        if (!reply.raw.headersSent) {
          reply.code(502).send({ error: 'preview_upstream_error', detail: err.message });
        } else {
          reply.raw.end();
        }
      });

      // Stream the request body through. For methods without a body
      // (GET/HEAD) the raw stream emits 'end' immediately.
      req.raw.pipe(upstream);
    });
  };

  return router;
}

export const previewRoutes: FastifyPluginAsync = createPreviewRouter();
