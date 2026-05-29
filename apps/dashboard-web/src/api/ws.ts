import { useEffect, useRef, useState } from 'react';
import { safeParseHarnessEvent, type HarnessEvent } from '@wisp/schemas';

export type WsStatus = 'idle' | 'open' | 'closed' | 'error';

export interface UseRunEventsResult {
  events: HarnessEvent[];
  status: WsStatus;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
// Bound the retained event buffer so long autonomous runs don't grow the
// array (and React reconciliation cost) unboundedly. The Kanban + run-view
// only need the most recent activity; older events stay in the server DB
// and can be fetched on demand.
const MAX_EVENTS = 2000;

function buildWsUrl(runId: string): string {
  if (typeof window === 'undefined') return `/ws/runs/${runId}`;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/runs/${runId}`;
}

export function useRunEvents(runId: string | null): UseRunEventsResult {
  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [status, setStatus] = useState<WsStatus>('idle');
  const wsRef = useRef<WebSocket | null>(null);
  const cancelledRef = useRef(false);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    cancelledRef.current = false;
    backoffRef.current = INITIAL_BACKOFF_MS;
    setEvents([]);

    if (!runId) {
      setStatus('idle');
      return () => {
        cancelledRef.current = true;
      };
    }

    const connect = () => {
      if (cancelledRef.current) return;
      const url = buildWsUrl(runId);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        backoffRef.current = INITIAL_BACKOFF_MS;
        setStatus('open');
      };

      ws.onmessage = (ev: MessageEvent) => {
        let parsed: unknown;
        try {
          parsed = typeof ev.data === 'string' ? JSON.parse(ev.data) : JSON.parse(String(ev.data));
        } catch (err) {
          console.warn('[ws] non-JSON message dropped', err);
          return;
        }
        const result = safeParseHarnessEvent(parsed);
        if (!result.success) {
          console.warn('[ws] invalid HarnessEvent dropped', result.error.issues);
          return;
        }
        setEvents((prev) => {
          const next = [...prev, result.data];
          return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
        });
      };

      ws.onerror = () => {
        setStatus('error');
      };

      ws.onclose = () => {
        if (cancelledRef.current) {
          setStatus('closed');
          return;
        }
        setStatus('closed');
        const delay = Math.min(backoffRef.current, MAX_BACKOFF_MS);
        backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelledRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [runId]);

  return { events, status };
}

// ----- Chat token streaming (per-thread) -----

export interface UseThreadStreamResult {
  /** Text streamed so far for the in-flight turn (empty between turns). */
  streamingText: string;
  status: WsStatus;
}

function buildThreadWsUrl(threadId: string): string {
  if (typeof window === 'undefined') return `/ws/threads/${threadId}`;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/threads/${threadId}`;
}

/**
 * Subscribe to `/ws/threads/:id` and accumulate the assistant reply's tokens
 * as they stream. `streamingText` resets at each turn's start (first delta
 * after a completion) and clears on `chat.turn-complete`. The REST message
 * poll remains the source of truth — this only provides a live preview while
 * a turn is in flight. Safe no-op when threadId is null.
 *
 * `onActionUpdate` fires when the server emits a `chat.action-update` event
 * (e.g. an async generate_plan job finishing). The Chat route uses it to
 * refetch the thread so the pending ActionCard re-renders to ok/failed. The
 * callback is held in a ref so changing its identity does not reconnect the WS.
 */
export function useThreadStream(
  threadId: string | null,
  onActionUpdate?: () => void,
): UseThreadStreamResult {
  const [streamingText, setStreamingText] = useState('');
  const [status, setStatus] = useState<WsStatus>('idle');
  const turnActiveRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const cancelledRef = useRef(false);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onActionUpdateRef = useRef(onActionUpdate);
  onActionUpdateRef.current = onActionUpdate;

  useEffect(() => {
    cancelledRef.current = false;
    backoffRef.current = INITIAL_BACKOFF_MS;
    turnActiveRef.current = false;
    setStreamingText('');

    if (!threadId) {
      setStatus('idle');
      return () => {
        cancelledRef.current = true;
      };
    }

    const connect = () => {
      if (cancelledRef.current) return;
      const ws = new WebSocket(buildThreadWsUrl(threadId));
      wsRef.current = ws;

      ws.onopen = () => {
        backoffRef.current = INITIAL_BACKOFF_MS;
        setStatus('open');
        // Re-sync on every (re)connect: a chat.action-update published while the
        // socket was down/reconnecting (or before this thread was selected) is
        // lost, so reconcile the thread's canonical action statuses from REST.
        onActionUpdateRef.current?.();
      };

      ws.onmessage = (ev: MessageEvent) => {
        let parsed: unknown;
        try {
          parsed = typeof ev.data === 'string' ? JSON.parse(ev.data) : JSON.parse(String(ev.data));
        } catch {
          return;
        }
        const e = parsed as { type?: string; chunk?: string };
        if (e.type === 'chat.text-delta' && typeof e.chunk === 'string') {
          const chunk = e.chunk;
          setStreamingText((prev) => {
            if (!turnActiveRef.current) {
              turnActiveRef.current = true;
              return chunk; // fresh turn — drop any stale text
            }
            return prev + chunk;
          });
        } else if (e.type === 'chat.turn-complete') {
          turnActiveRef.current = false;
          setStreamingText('');
        } else if (e.type === 'chat.action-update') {
          // An async directive (e.g. generate_plan) finished — let the route
          // refetch the thread so the pending ActionCard flips to ok/failed.
          onActionUpdateRef.current?.();
        }
      };

      ws.onerror = () => setStatus('error');

      ws.onclose = () => {
        setStatus('closed');
        if (cancelledRef.current) return;
        const delay = Math.min(backoffRef.current, MAX_BACKOFF_MS);
        backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelledRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [threadId]);

  return { streamingText, status };
}
