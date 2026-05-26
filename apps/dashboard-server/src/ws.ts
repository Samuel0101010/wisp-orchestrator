import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { harnessEventSchema, runs, type HarnessEvent } from '@wisp/schemas';
import { db } from './db/index.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 35_000;

type Tracked = {
  socket: WebSocket;
  lastPongAt: number;
};

const registry = new Map<string, Set<Tracked>>();
let heartbeatTimer: NodeJS.Timeout | null = null;

function ensureHeartbeat(): void {
  if (heartbeatTimer !== null) return;
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [, sockets] of registry) {
      for (const tracked of sockets) {
        if (now - tracked.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
          try {
            tracked.socket.terminate();
          } catch {
            // ignore
          }
          continue;
        }
        try {
          tracked.socket.ping();
        } catch {
          // ignore
        }
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive solely for heartbeats.
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export function subscribeToRun(runId: string, socket: WebSocket): void {
  let set = registry.get(runId);
  if (!set) {
    set = new Set();
    registry.set(runId, set);
  }
  const tracked: Tracked = { socket, lastPongAt: Date.now() };
  set.add(tracked);

  socket.on('pong', () => {
    tracked.lastPongAt = Date.now();
  });

  const cleanup = (): void => {
    const current = registry.get(runId);
    if (current) {
      current.delete(tracked);
      if (current.size === 0) registry.delete(runId);
    }
    if (registry.size === 0) stopHeartbeat();
  };

  socket.on('close', cleanup);
  socket.on('error', cleanup);

  ensureHeartbeat();
}

export function publishToRun(runId: string, event: HarnessEvent): void {
  // Validate before broadcasting (throws on invalid).
  const parsed = harnessEventSchema.parse(event);
  const sockets = registry.get(runId);
  if (!sockets || sockets.size === 0) return;
  const payload = JSON.stringify(parsed);
  for (const tracked of sockets) {
    if (tracked.socket.readyState === tracked.socket.OPEN) {
      try {
        tracked.socket.send(payload);
      } catch {
        // ignore
      }
    }
  }
}

export function registerWebsocket(app: FastifyInstance): void {
  app.get<{ Params: { runId: string } }>(
    '/ws/runs/:runId',
    {
      websocket: true,
      // Reject upgrade with 404 before switching protocols when the run id is
      // unknown. Without this, bogus ids returned 101 + an immediately-closed
      // socket, which is a confusing contract for clients.
      preValidation: async (req, reply) => {
        const { runId } = req.params as { runId: string };
        const row = db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).get();
        if (!row) {
          // Return after send so the hook chain short-circuits — otherwise
          // the WebSocket upgrade would still try to switch protocols on the
          // already-replied socket.
          return reply.code(404).send({ error: 'run not found' });
        }
      },
    },
    (socket, req) => {
      const { runId } = req.params;
      subscribeToRun(runId, socket as unknown as WebSocket);
    },
  );
}

// Test helpers — not part of the public surface.
export function __getRegistry(): Map<string, Set<Tracked>> {
  return registry;
}

export function __resetWsState(): void {
  for (const [, sockets] of registry) {
    for (const t of sockets) {
      try {
        t.socket.terminate();
      } catch {
        // ignore
      }
    }
  }
  registry.clear();
  stopHeartbeat();
}
