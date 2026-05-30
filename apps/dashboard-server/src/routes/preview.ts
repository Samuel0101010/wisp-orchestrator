/**
 * Preview routes (v1.11 Phase 3) — start/stop control + reverse-proxy.
 *
 *   POST  /api/projects/:projectId/preview/start
 *   POST  /api/projects/:projectId/preview/stop
 *   GET   /api/projects/:projectId/preview/status
 *   ALL   /preview/:projectId/*                — forwards to the live dev server
 *   WS    /preview/:projectId/*                — proxies vite's HMR upgrade
 *
 * The reverse-proxy intentionally bypasses Fastify's body parsing and re-uses
 * `request.raw` + `reply.raw` so we stream chunks back without buffering an
 * entire HTML payload. We strip `accept-encoding` from the upstream request
 * (so we never have to decode gzip / brotli) and drop the connection /
 * content-length headers the upstream sets (Node sets fresh ones).
 *
 * The WebSocket arm exists because `@vite/client` opens its HMR socket back to
 * the SAME `/preview/<id>/` origin the iframe loaded from (vite derives the
 * HMR URL from `--base`). Without proxying that upgrade the client spins on
 * "[vite] server connection lost. Polling for restart…" forever and live
 * module reload never works. We give the existing proxy route a `wsHandler`
 * (the @fastify/websocket v11 route-level API) so Fastify's own router
 * dispatches the upgrade here — `/ws/runs/:id` + `/ws/threads/:id` stay
 * untouched because they are separate registered routes.
 *
 * Loopback only — the spawned dev server listens on 127.0.0.1 and the proxy
 * forwards to it from the dashboard process itself. There is no exposed
 * surface for an external client to reach the dev server except through this
 * proxy, which inherits the dashboard's own auth (none today, but that's a
 * separate gate).
 */
import http, { type IncomingMessage } from 'node:http';
import type { FastifyPluginAsync, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { WebSocket as UpstreamWs } from 'ws';
import type { WebSocket as WsSocket, RawData } from 'ws';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { projects } from '@wisp/schemas';
import { db } from '../db/index.js';
import { wrap } from './wrap.js';
import { detectProjectType } from '../orchestrator/detect-project-type.js';
import {
  ensurePreviewWorktree,
  previewProcesses,
  type PreviewProcessRegistry,
} from '../orchestrator/preview-server.js';

export interface PreviewRouterDeps {
  /** Test seam — swap the registry. */
  registry?: PreviewProcessRegistry;
  /**
   * Test seam — swap the framework/dev-command detector. Defaults to the real
   * pure `detectProjectType` (reads the worktree's package.json), so production
   * behaviour is unchanged when this is omitted.
   */
  detectProjectType?: typeof detectProjectType;
  /**
   * Test seam — swap the worktree resolver. Defaults to the real
   * `ensurePreviewWorktree`, so production behaviour is unchanged when omitted.
   */
  ensurePreviewWorktree?: typeof ensurePreviewWorktree;
}

export function createPreviewRouter(deps: PreviewRouterDeps = {}): FastifyPluginAsync {
  const registry = deps.registry ?? previewProcesses;
  const detect = deps.detectProjectType ?? detectProjectType;
  const ensureWorktree = deps.ensurePreviewWorktree ?? ensurePreviewWorktree;

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

        // If a preview is already running for this project, return it as-is.
        // Re-resolving the worktree would `git reset --hard` a worktree whose
        // dev server is live — a Windows sharing-violation risk + needless HMR
        // churn. startPreview is idempotent, but the reset runs before it.
        const existing = registry.getPreviewStatus(projectId);
        if (existing.running) {
          return {
            status: 'running' as const,
            port: existing.port,
            pid: existing.pid,
            startedAt: existing.startedAt,
          };
        }

        // Spin up (or reuse + reset) the detached preview worktree checked
        // out to the project's post-run `main` HEAD. auto-merge advances
        // `refs/heads/main` via `git update-ref` WITHOUT touching the user's
        // working tree, so spawning the dev server from `project.repoPath`
        // would run against a stale tree with no node_modules. The worktree
        // is the authoritative, installable copy of the current main.
        let previewCwd: string;
        try {
          previewCwd = await ensureWorktree(project.repoPath, projectId);
        } catch (err) {
          reply.code(500);
          return { error: 'worktree_setup_failed', detail: String(err) };
        }

        let devCmd = project.runtimeVerifyDevCmd;
        let probeUrl = project.runtimeVerifyProbeUrl;
        // Always run detection so we know whether the framework respects
        // `--base`. The detection is pure (reads package.json) and cheap.
        // Read it from the WORKTREE (not project.repoPath) so a stale
        // repoPath package.json can't mismatch the content we actually spawn
        // against — the worktree was just `git reset --hard`'d to main.
        const detection = detect(previewCwd);
        if (!devCmd || !probeUrl) {
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

        // Only pass `--base` to frameworks whose CLI accepts it without
        // an unknown-flag error. vite + SvelteKit support `--base` out of
        // the box; next/nuxt require config-file changes and would crash
        // on an unknown flag — leave them as-is for now.
        const BASE_FLAG_FRAMEWORKS = new Set(['vite', '@sveltejs/kit']);
        const basePath =
          detection.framework && BASE_FLAG_FRAMEWORKS.has(detection.framework)
            ? `/preview/${projectId}/`
            : undefined;

        const result = await registry.startPreview({
          projectId,
          devCmd,
          probeUrl,
          cwd: previewCwd,
          ...(basePath ? { basePath } : {}),
        });
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

    // Reverse-proxy (HTTP). Fastify's `all` matches every HTTP verb. We bind
    // to the wildcarded suffix manually because the wildcard otherwise
    // collides with the more-specific /api/* routes when registered first.
    const httpHandler: RouteHandlerMethod = (req, reply) => {
      const projectId = (req.params as { projectId: string }).projectId;
      const status = registry.getPreviewStatus(projectId);
      if (!status.running || status.port == null) {
        reply.code(502).send({ error: 'preview_not_running' });
        return;
      }

      // Forward the FULL incoming path to the upstream. When the dev
      // server is launched with `--base /preview/<id>/` (vite / SvelteKit),
      // it serves both the index document AND every asset under that
      // prefix — so the request URL the browser sent is already the
      // correct upstream path. Stripping the prefix would break asset
      // resolution (vite would 404 on `/src/main.tsx` because it's
      // serving from `/preview/<id>/src/main.tsx`).
      //
      // For frameworks where we did NOT pass basePath (next/nuxt/others),
      // the dev server is still listening on `/` and we strip the
      // `/preview/<id>` prefix as before. We detect this by checking
      // whether the upstream framework would have received `--base`: if
      // we don't have that info here cheaply, fall back to forwarding
      // the full path — vite/sveltekit are the dominant case and a
      // wrong-prefix fetch will surface as a clean 404 in dev.
      const rawUrl = req.raw.url ?? '/';
      const suffix = rawUrl || '/';

      // Copy headers, then strip the ones that would confuse the upstream
      // or that node would set freshly anyway. The host header must be
      // rewritten so the upstream's vhost routing doesn't bounce on it.
      const headers: Record<string, string | string[] | undefined> = { ...req.headers };
      delete headers['accept-encoding'];
      delete headers['content-length'];
      delete headers['connection'];
      // Forward via `localhost` so the system resolver picks whichever
      // loopback family vite actually bound to — vite binds ::1 by default
      // on Windows while 127.0.0.1 would 502 with ECONNREFUSED.
      headers['host'] = `localhost:${status.port}`;

      const upstream = http.request(
        {
          hostname: 'localhost',
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
    };

    // Reverse-proxy (WebSocket). Dispatched by Fastify's router when the
    // matching `/preview/:projectId/*` request is an upgrade — this is the
    // @fastify/websocket v11 route-level `wsHandler`, signature `(socket,
    // request)` where `socket` is a `ws` WebSocket. We open a `ws` client to
    // the upstream dev server (forwarding vite's `vite-hmr` subprotocol so the
    // dev server accepts the connection) and pipe both directions.
    const wsHandler = (socket: WsSocket, req: FastifyRequest): void => {
      const projectId = (req.params as { projectId: string }).projectId;
      const status = registry.getPreviewStatus(projectId);
      if (!status.running || status.port == null) {
        try {
          socket.close(1011, 'preview_not_running');
        } catch {
          /* socket may already be closing */
        }
        return;
      }

      // vite negotiates the HMR socket with the `vite-hmr` subprotocol; the
      // upstream dev server will reject (or downgrade) a client that doesn't
      // request it. Forward whatever subprotocol(s) the browser asked for so
      // the upstream handshake matches.
      const subprotocolHeader = req.headers['sec-websocket-protocol'];
      const protocols =
        typeof subprotocolHeader === 'string' && subprotocolHeader.length > 0
          ? subprotocolHeader.split(',').map((p) => p.trim())
          : undefined;

      // Forward the FULL incoming path (same reasoning as the HTTP arm: vite
      // serves under `--base /preview/<id>/`, so the browser-sent path is the
      // correct upstream path). `localhost` lets the resolver pick whichever
      // loopback family vite bound to.
      const upstreamUrl = `ws://localhost:${status.port}${req.raw.url ?? '/'}`;
      const upstream = protocols
        ? new UpstreamWs(upstreamUrl, protocols)
        : new UpstreamWs(upstreamUrl);

      // Buffer client→upstream messages until the upstream handshake completes,
      // then flush in order. Without this, the first HMR frames the browser
      // sends before the upstream `open` fires would be dropped.
      const pending: Array<{ data: RawData; binary: boolean }> = [];
      let upstreamOpen = false;

      const safeSend = (target: WsSocket | UpstreamWs, data: RawData, binary: boolean): void => {
        if (target.readyState !== UpstreamWs.OPEN) return;
        try {
          target.send(data, { binary });
        } catch {
          /* peer vanished mid-send */
        }
      };

      const safeClose = (target: WsSocket | UpstreamWs, code?: number, reason?: string): void => {
        try {
          if (
            target.readyState === UpstreamWs.OPEN ||
            target.readyState === UpstreamWs.CONNECTING
          ) {
            target.close(code, reason);
          }
        } catch {
          /* already closing/closed */
        }
      };

      upstream.on('open', () => {
        upstreamOpen = true;
        for (const m of pending.splice(0)) safeSend(upstream, m.data, m.binary);
      });

      // client → upstream
      socket.on('message', (data: RawData, isBinary: boolean) => {
        if (upstreamOpen) {
          safeSend(upstream, data, isBinary);
        } else {
          pending.push({ data, binary: isBinary });
        }
      });

      // upstream → client
      upstream.on('message', (data: RawData, isBinary: boolean) => {
        safeSend(socket, data, isBinary);
      });

      // Propagate close in both directions.
      socket.on('close', (code, reason) => {
        safeClose(upstream, normalizeCloseCode(code), reason?.toString());
      });
      upstream.on('close', (code, reason) => {
        safeClose(socket, normalizeCloseCode(code), reason?.toString());
      });

      // Propagate errors by tearing down the other side. ws surfaces upstream
      // ECONNREFUSED / handshake failures here; we close the browser socket so
      // `@vite/client` retries instead of hanging on a half-open connection.
      socket.on('error', () => {
        safeClose(upstream);
      });
      upstream.on('error', () => {
        safeClose(socket, 1011, 'preview_upstream_error');
      });
    };

    // Register the proxy. @fastify/websocket only permits a `wsHandler` on a
    // GET-only route (its onRoute hook throws otherwise — an upgrade is always
    // GET), so we can't hang it on a multi-method `app.all`. We split: a GET
    // route carrying BOTH handlers (HTTP GET + WS upgrade), and a sibling route
    // for every other verb with just the HTTP handler. Both reuse `httpHandler`,
    // so HTTP behaviour is byte-identical to the previous `app.all`. HEAD is
    // excluded from the sibling because the GET route auto-exposes a HEAD route
    // (Fastify's `exposeHeadRoute` default) that already dispatches `httpHandler`.
    app.route({ method: 'GET', url: '/preview/:projectId/*', handler: httpHandler, wsHandler });
    app.route({
      method: app.supportedMethods.filter((m) => m !== 'GET' && m !== 'HEAD'),
      url: '/preview/:projectId/*',
      handler: httpHandler,
    });
  };

  return router;
}

/**
 * `ws` close codes must be either a valid WebSocket status code or omitted.
 * Codes in the 1xxx reserved-but-unusable range (1005 "no status", 1006
 * "abnormal closure") throw if passed to `.close()`. Map those to undefined so
 * the proxy doesn't crash forwarding a peer's abnormal close.
 */
export function normalizeCloseCode(code: number | undefined): number | undefined {
  if (code == null) return undefined;
  if (code === 1005 || code === 1006) return undefined;
  if (code < 1000 || code > 4999) return undefined;
  return code;
}

export const previewRoutes: FastifyPluginAsync = createPreviewRouter();
